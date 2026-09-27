/**
 * Import animations from BVH (BVHLoader), FBX (FBXLoader — e.g. Mixamo
 * "without skin" downloads) and GLB / GLTF (GLTFLoader) files and retarget
 * them onto our humanoid skeleton.
 *
 *  1. Bone names are mapped to ours (mapSkeleton): namespaces and prefixes
 *     ("mixamorig:", "mixamorig1_", "Bip01 ", "Character1_"…) are stripped,
 *     the side is read from prefixes / suffixes (Left…, L…, …_l, ….L) and the
 *     part from an alias table (Mixamo, CMU / SecondLife / MotionBuilder BVH,
 *     Unity / VRM, Unreal, Rigify). Context rules: "Shoulder" means the upper
 *     arm when the skeleton also has "Collar" bones (classic BVH); the spine
 *     chain (Spine / Chest / Abdomen / LowerBack…) is spread over our
 *     Spine, Spine1, Spine2 by hierarchy order.
 *  2. The clip is sampled once (30 fps) on the source skeleton: per mapped
 *     bone its world rotation relative to its rest pose, expressed in the
 *     canonical frame (+X subject's left, +Y up, +Z forward). The source's
 *     frame is detected from its rest skeleton (left = left − right hip /
 *     shoulder, up = hips → neck), so Z-up files or characters facing -Z
 *     retarget correctly. Units do not matter (see 4).
 *  3. retargetAnimation() transfers the rotations with the rest-pose-aware
 *     solver (./retarget.ts: an A-pose file drives a T-pose rig correctly).
 *  4. Hips translation: scaled by the ratio of leg lengths; the vertical is
 *     measured from the lowest foot joint over the clip (the source's floor)
 *     so a BVH whose rest skeleton stands at the origin still lands on the
 *     ground; horizontal motion is relative to the rest (or to the first
 *     frame when the take starts far away) and, `inPlace` (default), has its
 *     start → end drift removed so loops stay in place.
 *
 * SkeletonUtils.retargetClip (three/examples) was the starting point but it
 * copies world rotations as-is (no rest-pose delta, the target's bones must
 * be children of an identity-transformed SkinnedMesh) and uses absolute hip
 * positions, which breaks on our skeleton (bones under a scaled model root)
 * and on BVH / Mixamo rest poses; the sampling approach here is the same.
 */
import { AnimationClip, AnimationMixer, LoopOnce, Matrix4, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { KeyframeTrack, Object3D } from 'three';
import { LocalizedError } from '../core/errors';
import type { I18nText } from '../core/types';
import { END_BONES, fingerBone, type FingerName, type Side } from './bones';
import { computeAlignment, makeContinuous, solveFrame } from './retarget';
import type { RigDescriptor } from './skeleton';
import type { AnimationCategory, AnimationInfo, CoreBone, HumanoidBone, RigClip } from './types';

export type AnimationFormat = 'bvh' | 'fbx' | 'gltf';

export const IMPORT_TEXT = {
  unsupported: { tr: 'Desteklenmeyen dosya türü. BVH, FBX veya GLB / GLTF seçin.', en: 'Unsupported file type. Choose a BVH, FBX or GLB / GLTF file.' },
  tooLarge: { tr: 'Dosya çok büyük (en fazla {mb} MB).', en: 'The file is too large (max {mb} MB).' },
  empty: { tr: 'Dosya boş.', en: 'The file is empty.' },
  parse: {
    tr: 'Animasyon dosyası okunamadı: dosya bozuk ya da geçerli bir BVH / FBX / GLB animasyonu değil.',
    en: 'Could not read the animation file: it is damaged or not a valid BVH / FBX / GLB animation.',
  },
  noAnimation: { tr: 'Dosyada animasyon bulunamadı.', en: 'The file contains no animation.' },
  noBones: {
    tr: 'Dosyadaki kemik adları tanınmadı (ör. Hips, Spine, LeftArm, LeftUpLeg bekleniyor).',
    en: 'The bone names in the file were not recognised (expected e.g. Hips, Spine, LeftArm, LeftUpLeg).',
  },
} satisfies Record<string, I18nText>;

export const MAX_IMPORT_MB = 100;
const FPS = 30;
const MAX_FRAMES = FPS * 180;

// ---------------------------------------------------------------------------
// Bone name mapping

export interface SourceNode {
  name: string;
  /** Distance from the skeleton root (hierarchy order). */
  depth: number;
}

const PREFIX_RE = /^(?:mixamorig\d*|mixamo|bip0*1|biped|def|org|mch|character\d*|armature|skeleton|rig|jnt|bn|b|j)/i;

/** One rig prefix off `n` (followed by a separator, or a camel-case boundary for multi-letter prefixes), or null. */
function stripPrefix(n: string): string | null {
  const m = PREFIX_RE.exec(n);
  if (!m) return null;
  const rest = n.slice(m[0].length);
  const sep = /^[\s:_.\-|]+/.exec(rest);
  if (sep) return rest.length > sep[0].length ? rest.slice(sep[0].length) : null;
  // "mixamorigHips" (FBX / glTF loaders sanitise "mixamorig:Hips"), but not "RightArm" or "Back".
  return m[0].length > 1 && /^[A-Z]/.test(rest) ? rest : null;
}

/** Name without namespaces, paths and rig prefixes. */
export function stripBoneName(raw: string): string {
  let n = raw.trim();
  n = n.slice(Math.max(n.lastIndexOf(':'), n.lastIndexOf('|')) + 1);
  for (let i = 0; i < 3; i++) {
    const next = stripPrefix(n);
    if (!next) break;
    n = next;
  }
  return n;
}

export function splitSide(name: string): { side: Side | null; rest: string } {
  let m = /^(left|right)[\s_.\-]*/i.exec(name);
  if (m && m[0].length < name.length) return { side: m[1].toLowerCase() === 'left' ? 'Left' : 'Right', rest: name.slice(m[0].length) };
  m = /[\s_.\-]*(left|right)$/i.exec(name);
  if (m && m.index > 0) return { side: m[1].toLowerCase() === 'left' ? 'Left' : 'Right', rest: name.slice(0, m.index) };
  m = /^([lr])(?:[\s_.\-]+|(?=[A-Z]))/.exec(name) ?? /^([LR])(?:[\s_.\-]+|(?=[A-Z]))/.exec(name);
  if (m && m[0].length < name.length) return { side: m[1].toLowerCase() === 'l' ? 'Left' : 'Right', rest: name.slice(m[0].length) };
  m = /[\s_.\-]([lr])$/i.exec(name);
  if (m) return { side: m[1].toLowerCase() === 'l' ? 'Left' : 'Right', rest: name.slice(0, m.index) };
  m = /[\s_.\-]([lr])[\s_.\-]/i.exec(name);
  if (m) return { side: m[1].toLowerCase() === 'l' ? 'Left' : 'Right', rest: name.slice(0, m.index) + name.slice(m.index + m[0].length - 1) };
  return { side: null, rest: name };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

type LimbPart = 'Shoulder' | 'Arm' | 'ForeArm' | 'Hand' | 'UpLeg' | 'Leg' | 'Foot' | 'ToeBase';

const SIDED_PARTS: Record<string, LimbPart | 'shoulder?'> = {
  collar: 'Shoulder', clavicle: 'Shoulder', clav: 'Shoulder', collarbone: 'Shoulder',
  shoulder: 'shoulder?',
  arm: 'Arm', uparm: 'Arm', upperarm: 'Arm', shldr: 'Arm', humerus: 'Arm', armupper: 'Arm', bicep: 'Arm',
  forearm: 'ForeArm', lowarm: 'ForeArm', lowerarm: 'ForeArm', elbow: 'ForeArm', armlower: 'ForeArm', radius: 'ForeArm',
  hand: 'Hand', wrist: 'Hand',
  upleg: 'UpLeg', thigh: 'UpLeg', upperleg: 'UpLeg', femur: 'UpLeg', hip: 'UpLeg', legupper: 'UpLeg',
  leg: 'Leg', lowleg: 'Leg', lowerleg: 'Leg', knee: 'Leg', calf: 'Leg', shin: 'Leg', crus: 'Leg', tibia: 'Leg', leglower: 'Leg',
  foot: 'Foot', ankle: 'Foot',
  toebase: 'ToeBase', toe: 'ToeBase', toes: 'ToeBase', ball: 'ToeBase', toe0: 'ToeBase', toe01: 'ToeBase',
};

const FINGER_RE = /^(?:hand)?(thumb|index|middle|mid|ring|pinky|pinkie|little)(?:finger)?(proximal|intermediate|distal)?(\d+)?$/;
const FINGER_ALIAS: Record<string, FingerName> = {
  thumb: 'Thumb', index: 'Index', middle: 'Middle', mid: 'Middle', ring: 'Ring', pinky: 'Pinky', pinkie: 'Pinky', little: 'Pinky',
};
const SPINE_RE = /^(?:spine|chest|upperchest|abdomen|torso|back|lowerback|upperback|waist|ribs)\d*$/;

type Classified =
  | { kind: 'hips' | 'spine' | 'neck' | 'head' | 'headtop' }
  | { kind: 'limb'; side: Side; part: LimbPart | 'shoulder?' }
  | { kind: 'finger'; side: Side; finger: FingerName; n: 1 | 2 | 3 };

export function classifyBoneName(raw: string): Classified | null {
  const stripped = stripBoneName(raw);
  const { side, rest } = splitSide(stripped);
  const p = norm(rest);
  if (!p) return null;
  if (!side) {
    if (/^(?:hips?|pelvis)$/.test(p)) return { kind: 'hips' };
    if (SPINE_RE.test(p)) return { kind: 'spine' };
    if (/^neck\d*$/.test(p)) return { kind: 'neck' };
    if (p === 'head') return { kind: 'head' };
    if (/^head(?:top)?(?:end|nub|top)$/.test(p) || p === 'headtop') return { kind: 'headtop' };
    return null;
  }
  const f = FINGER_RE.exec(p);
  if (f) {
    const n = f[2] ? ({ proximal: 1, intermediate: 2, distal: 3 } as const)[f[2] as 'proximal'] : f[3] ? parseInt(f[3], 10) : 1;
    if (n < 1 || n > 3) return null;
    return { kind: 'finger', side, finger: FINGER_ALIAS[f[1]], n: n as 1 | 2 | 3 };
  }
  const part = SIDED_PARTS[p];
  return part ? { kind: 'limb', side, part } : null;
}

/**
 * Map source bone names to humanoid bones (see the module comment). When
 * several nodes claim a bone, the one closest to the root wins.
 */
export function mapSkeleton(nodes: SourceNode[]): Map<HumanoidBone, string> {
  const sorted = [...nodes].sort((a, b) => a.depth - b.depth);
  const classified = sorted.map((n) => ({ node: n, c: classifyBoneName(n.name) }));
  const hasCollar = classified.some(({ node, c }) => c?.kind === 'limb' && /coll|clav/i.test(node.name));
  const out = new Map<HumanoidBone, string>();
  const claim = (bone: HumanoidBone, name: string) => {
    if (!out.has(bone)) out.set(bone, name);
  };
  const spine: string[] = [];
  for (const { node, c } of classified) {
    if (!c) continue;
    switch (c.kind) {
      case 'hips': claim('Hips', node.name); break;
      case 'spine': spine.push(node.name); break;
      case 'neck': claim('Neck', node.name); break;
      case 'head': claim('Head', node.name); break;
      case 'headtop': claim('HeadTop_End', node.name); break;
      case 'finger': claim(fingerBone(c.side, c.finger, c.n), node.name); break;
      case 'limb': {
        const part: LimbPart = c.part === 'shoulder?' ? (hasCollar ? 'Arm' : 'Shoulder') : c.part;
        claim(`${c.side}${part}` as CoreBone, node.name);
        break;
      }
    }
  }
  const k = spine.length;
  if (k === 1) claim('Spine', spine[0]);
  else if (k === 2) {
    claim('Spine', spine[0]);
    claim('Spine2', spine[1]);
  } else if (k >= 3) {
    claim('Spine', spine[0]);
    claim('Spine1', spine[Math.round((k - 1) / 2)]);
    claim('Spine2', spine[k - 1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing & sampling

/** A parsed animation, sampled on its own skeleton (independent of our rig). */
export interface AnimationSource {
  name: string;
  format: AnimationFormat;
  duration: number;
  times: Float32Array;
  /** Per mapped bone: world rotation relative to rest, canonical frame, 4 values per frame. */
  deltas: Map<HumanoidBone, Float32Array>;
  /** Rest joint positions (canonical frame, source units) of the mapped bones. */
  rest: Map<HumanoidBone, Vector3>;
  /** Hips world positions per frame (canonical frame, source units), or null without a hips bone. */
  hips: Float32Array | null;
  /** Lowest foot / toe joint height over the clip (canonical, source units), or null. */
  floor: number | null;
  /** Source bone name per mapped bone (for display / debugging). */
  mapping: Map<HumanoidBone, string>;
}

export function detectFormat(name: string, head: Uint8Array): AnimationFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'bvh') return 'bvh';
  if (ext === 'fbx') return 'fbx';
  if (ext === 'glb' || ext === 'gltf') return 'gltf';
  const text = new TextDecoder().decode(head.subarray(0, 64));
  if (/^\s*HIERARCHY/.test(text)) return 'bvh';
  if (text.startsWith('Kaydara FBX Binary') || /^\s*; FBX/.test(text)) return 'fbx';
  if (text.startsWith('glTF') || /^\s*\{/.test(text)) return 'gltf';
  return null;
}

interface Loaded {
  root: Object3D;
  clips: AnimationClip[];
  nodes: Object3D[];
}

/** Loader exceptions are technical ("Cannot read properties of undefined…"): console only, a fixed message for the user. */
function fail(detail: unknown): never {
  console.warn('[rig/import] animation parse failed', detail);
  throw new LocalizedError(IMPORT_TEXT.parse);
}

async function load(format: AnimationFormat, buffer: ArrayBuffer): Promise<Loaded> {
  try {
    if (format === 'bvh') {
      const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js');
      const res = new BVHLoader().parse(new TextDecoder().decode(buffer));
      const bones = res.skeleton.bones.filter((b) => b.name !== 'ENDSITE');
      const root = res.skeleton.bones[0];
      return { root, clips: [res.clip], nodes: bones };
    }
    if (format === 'fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const group = new FBXLoader().parse(buffer, '');
      return { root: group, clips: group.animations ?? [], nodes: animatedNodes(group, group.animations ?? []) };
    }
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    return { root: gltf.scene, clips: gltf.animations ?? [], nodes: animatedNodes(gltf.scene, gltf.animations ?? []) };
  } catch (e) {
    if (e instanceof LocalizedError) throw e;
    fail(e);
  }
}

/** Bones under root, or (no bones) the nodes the clips animate. */
function animatedNodes(root: Object3D, clips: AnimationClip[]): Object3D[] {
  const bones: Object3D[] = [];
  root.traverse((o) => {
    if ((o as { isBone?: boolean }).isBone) bones.push(o);
  });
  if (bones.length) return bones;
  const names = new Set(clips.flatMap((c) => c.tracks.map((t) => t.name.slice(0, t.name.lastIndexOf('.')))));
  const out: Object3D[] = [];
  root.traverse((o) => {
    if (names.has(o.name)) out.push(o);
  });
  return out;
}

function depthOf(o: Object3D, root: Object3D): number {
  let d = 0;
  for (let p = o.parent; p && o !== root; p = p.parent) {
    d++;
    if (p === root) break;
  }
  return d;
}

/** Rotation taking the source's rest frame to the canonical one (identity when undetectable). */
function canonicalFrame(rest: Map<HumanoidBone, Vector3>): Quaternion {
  const pick = (a: HumanoidBone, b: HumanoidBone) => (rest.has(a) && rest.has(b) ? rest.get(a)!.clone().sub(rest.get(b)!) : null);
  const left = pick('LeftUpLeg', 'RightUpLeg') ?? pick('LeftArm', 'RightArm') ?? pick('LeftShoulder', 'RightShoulder') ?? pick('LeftFoot', 'RightFoot');
  const top = (['Neck', 'Head', 'Spine2', 'Spine1', 'Spine'] as HumanoidBone[]).find((b) => rest.has(b));
  const up = top && rest.has('Hips') ? rest.get(top)!.clone().sub(rest.get('Hips')!) : null;
  if (!left || !up || left.lengthSq() < 1e-12 || up.lengthSq() < 1e-12) return new Quaternion();
  const u = up.normalize();
  const l = left.addScaledVector(u, -left.dot(u));
  if (l.lengthSq() < 1e-12) return new Quaternion();
  l.normalize();
  const f = new Vector3().crossVectors(l, u);
  // Columns (l, u, f) map canonical → source; the inverse maps source → canonical.
  const m = new Matrix4().makeBasis(l, u, f);
  return new Quaternion().setFromRotationMatrix(m).invert();
}

function sample(loaded: Loaded, clip: AnimationClip, mapping: Map<HumanoidBone, string>, format: AnimationFormat, snapshot: () => void): AnimationSource {
  const { root } = loaded;
  const nodes = new Map<HumanoidBone, Object3D>();
  for (const [bone, name] of mapping) {
    const node = loaded.nodes.find((n) => n.name === name);
    if (node) nodes.set(bone, node);
  }
  snapshot();
  root.updateMatrixWorld(true);
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  const restPos = new Map<HumanoidBone, Vector3>(), restRot = new Map<HumanoidBone, Quaternion>();
  for (const [bone, node] of nodes) {
    node.matrixWorld.decompose(p, q, s);
    restPos.set(bone, p.clone());
    restRot.set(bone, q.clone());
  }
  const C = canonicalFrame(restPos);
  const Ci = C.clone().invert();
  const rest = new Map<HumanoidBone, Vector3>();
  for (const [b, v] of restPos) rest.set(b, v.clone().applyQuaternion(C));

  const duration = clip.duration > 0 ? clip.duration : Math.max(0, ...clip.tracks.map((t) => t.times[t.times.length - 1] ?? 0));
  const frames = Math.min(MAX_FRAMES, Math.max(2, Math.round(duration * FPS) + 1));
  const times = new Float32Array(frames);
  const deltas = new Map<HumanoidBone, Float32Array>();
  for (const b of nodes.keys()) deltas.set(b, new Float32Array(frames * 4));
  const hipsNode = nodes.get('Hips');
  const hips = hipsNode ? new Float32Array(frames * 3) : null;
  const feet = (['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] as HumanoidBone[]).map((b) => nodes.get(b)).filter(Boolean) as Object3D[];
  let floor = feet.length ? Infinity : null;

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const tmp = new Quaternion(), restInv = new Quaternion();
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * duration;
    times[f] = t;
    mixer.setTime(Math.min(t, Math.max(0, duration - 1e-5)));
    root.updateMatrixWorld(true);
    for (const [bone, node] of nodes) {
      node.matrixWorld.decompose(p, q, s);
      // S = C · Q(t) · Q_rest⁻¹ · C⁻¹
      restInv.copy(restRot.get(bone)!).invert();
      tmp.copy(C).multiply(q).multiply(restInv).multiply(Ci).normalize();
      tmp.toArray(deltas.get(bone)!, f * 4);
      if (node === hipsNode) p.applyQuaternion(C).toArray(hips!, f * 3);
    }
    if (floor !== null) {
      for (const n of feet) {
        n.matrixWorld.decompose(p, q, s);
        floor = Math.min(floor, p.applyQuaternion(C).y);
      }
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  snapshot();
  return { name: clip.name, format, duration, times, deltas, rest, hips, floor, mapping };
}

export interface ParseOptions {
  /** Size limit in MB (default MAX_IMPORT_MB). */
  maxMB?: number;
}

/** Parse an animation file into sources (one per clip). Throws LocalizedError with a bilingual message. */
export async function parseAnimationFile(file: Blob, name: string, opts: ParseOptions = {}): Promise<AnimationSource[]> {
  const maxMB = opts.maxMB ?? MAX_IMPORT_MB;
  if (file.size === 0) throw new LocalizedError(IMPORT_TEXT.empty);
  if (file.size > maxMB * 1024 * 1024) {
    throw new LocalizedError({ tr: IMPORT_TEXT.tooLarge.tr.replace('{mb}', String(maxMB)), en: IMPORT_TEXT.tooLarge.en.replace('{mb}', String(maxMB)) });
  }
  const buffer = await file.arrayBuffer();
  const format = detectFormat(name, new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)));
  if (!format) throw new LocalizedError(IMPORT_TEXT.unsupported);
  const loaded = await load(format, buffer);
  const clips = loaded.clips.filter((c) => c.tracks.length > 0);
  if (!clips.length) throw new LocalizedError(IMPORT_TEXT.noAnimation);
  const mapping = mapSkeleton(loaded.nodes.map((n) => ({ name: n.name, depth: depthOf(n, loaded.root) })));
  const core = [...mapping.keys()].filter((b) => !/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b));
  if (core.length < 4 || !(mapping.has('Hips') || mapping.has('Spine') || mapping.has('LeftArm') || mapping.has('LeftUpLeg'))) {
    throw new LocalizedError(IMPORT_TEXT.noBones);
  }
  // Rest transforms of every node, restored before / after each clip is sampled.
  const saved: [Object3D, Vector3, Quaternion, Vector3][] = [];
  loaded.root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const snapshot = () => {
    for (const [o, p, q, s] of saved) {
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(s);
    }
  };
  const base = name.replace(/\.[^.]+$/, '');
  return clips.map((clip, i) => {
    const src = sample(loaded, clip, mapping, format, snapshot);
    const clipName = clips.length > 1 ? `${base} – ${clip.name || i + 1}` : clip.name && !/^(animation|mixamo\.com|take ?\d*|clip_?\d*)$/i.test(clip.name) ? clip.name : base;
    return { ...src, name: clipName };
  });
}

// ---------------------------------------------------------------------------
// Retargeting

export interface RetargetOptions {
  /** Remove the start → end horizontal drift of the hips (default true). */
  inPlace?: boolean;
  id?: string;
}

function legLengthOf(rest: Map<HumanoidBone, Vector3>): number | null {
  const lens: number[] = [];
  for (const s of ['Left', 'Right'] as const) {
    const a = rest.get(`${s}UpLeg`), b = rest.get(`${s}Leg`), c = rest.get(`${s}Foot`);
    if (a && b && c) lens.push(a.distanceTo(b) + b.distanceTo(c));
  }
  return lens.length ? lens.reduce((x, y) => x + y) / lens.length : null;
}

function guessCategory(name: string): AnimationCategory {
  const n = name.toLowerCase();
  if (/walk|run|jog|sneak|swim|crawl|strafe|sprint|locomot/.test(n)) return 'locomotion';
  if (/danc|samba|salsa|hip ?hop|twerk|breakdance|robot/.test(n)) return 'dance';
  if (/idle|breath|stand|wait/.test(n)) return 'idle';
  if (/wave|clap|point|salute|bow|nod|shake|talk|gesture/.test(n)) return 'gesture';
  if (/cheer|victory|laugh|cry|angry|sad|happy|shrug|emote/.test(n)) return 'emote';
  if (/pose/.test(n)) return 'pose';
  return 'action';
}

export function retargetAnimation(src: AnimationSource, rig: RigDescriptor, opts: RetargetOptions = {}): RigClip {
  const inPlace = opts.inPlace ?? true;
  const align = computeAlignment(rig, (bone, child) => {
    const a = src.rest.get(bone), b = src.rest.get(child);
    return a && b ? b.clone().sub(a) : null;
  });
  const frames = src.times.length;
  const animated = rig.bones.filter((b) => !END_BONES.has(b));
  const values = new Map<HumanoidBone, Float32Array>();
  for (const b of animated) values.set(b, new Float32Array(frames * 4));
  const local = new Map<HumanoidBone, Quaternion>();
  const qs = new Map<HumanoidBone, Quaternion>();
  for (const b of src.deltas.keys()) qs.set(b, new Quaternion());
  for (let f = 0; f < frames; f++) {
    for (const [b, arr] of src.deltas) qs.get(b)!.fromArray(arr, f * 4);
    solveFrame(rig, (b) => qs.get(b) ?? null, align, local);
    for (const b of animated) local.get(b)!.toArray(values.get(b)!, f * 4);
  }
  const tracks: KeyframeTrack[] = [];
  for (const b of animated) {
    const v = values.get(b)!;
    makeContinuous(v);
    let moving = src.deltas.has(b);
    for (let i = 0; i < v.length && !moving; i += 4) moving = Math.abs(v[i + 3]) < 1 - 1e-7;
    if (moving) tracks.push(new QuaternionKeyframeTrack(`${b}.quaternion`, src.times, v));
  }

  const restHips = rig.layout.Hips!;
  if (src.hips) {
    const scale = (() => {
      const s = legLengthOf(src.rest);
      if (s && s > 1e-9) return rig.legLength / s;
      const sn = src.rest.get('Neck'), sh = src.rest.get('Hips'), tn = rig.layout.Neck!;
      if (sn && sh && sn.distanceTo(sh) > 1e-9) return Math.hypot(tn.x - restHips.x, tn.y - restHips.y, tn.z - restHips.z) / sn.distanceTo(sh);
      return 1;
    })();
    const h = src.hips;
    const out = new Float32Array(frames * 3);
    const srcRest = src.rest.get('Hips')!;
    const FEET: HumanoidBone[] = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
    const lowest = (get: (b: HumanoidBone) => { y: number } | undefined) => Math.min(...FEET.map((b) => get(b)?.y ?? Infinity));
    // Same joints on both sides: a toe-less source (CMU, SecondLife) is floored at the ankle, so is the target.
    const srcFeet = FEET.filter((b) => src.rest.has(b));
    const tgtFeet = lowest((b) => (srcFeet.includes(b) ? rig.layout[b] : undefined));
    const srcFloor = src.floor ?? lowest((b) => src.rest.get(b));
    const legRef = legLengthOf(src.rest) ?? 1;
    // Horizontal reference: the rest, unless the take starts far away from it (mocap walking in from the side).
    const far = Math.hypot(h[0] - srcRest.x, h[2] - srcRest.z) > 0.5 * legRef;
    const rx = far ? h[0] : srcRest.x, rz = far ? h[2] : srcRest.z;
    const dx = inPlace ? h[(frames - 1) * 3] - h[0] : 0, dz = inPlace ? h[(frames - 1) * 3 + 2] - h[2] : 0;
    // Without feet (no floor): vertical motion relative to the rest, or to the first frame when the
    // take starts far from it (a rest skeleton at the origin whose frames carry the standing height).
    const ry = Math.abs(h[1] - srcRest.y) > 0.5 * legRef ? h[1] : srcRest.y;
    for (let f = 0; f < frames; f++) {
      const u = frames > 1 ? f / (frames - 1) : 0;
      out[f * 3] = restHips.x + (h[f * 3] - rx - dx * u) * scale;
      out[f * 3 + 1] = Number.isFinite(srcFloor) && Number.isFinite(tgtFeet)
        ? tgtFeet + (h[f * 3 + 1] - srcFloor) * scale
        : restHips.y + (h[f * 3 + 1] - ry) * scale;
      out[f * 3 + 2] = restHips.z + (h[f * 3 + 2] - rz - dz * u) * scale;
    }
    tracks.push(new VectorKeyframeTrack('Hips.position', src.times, out));
  }
  if (!tracks.length) tracks.push(new QuaternionKeyframeTrack('Hips.quaternion', [0, src.duration], [0, 0, 0, 1, 0, 0, 0, 1]));

  const id = opts.id ?? `import-${src.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clip'}`;
  // Named after the take (the GLB animation name); `info.id` identifies it in the UI.
  const clip = new AnimationClip(src.name || id, src.duration, tracks);
  const info: AnimationInfo = {
    id,
    name: { tr: src.name, en: src.name },
    category: guessCategory(src.name),
    loop: looksLooped(tracks, 0.1 * rig.legLength),
    source: 'imported',
    duration: src.duration,
  };
  clip.userData = { ...clip.userData, info };
  return { clip, info };
}

/** First and last frames within ~8° on every rotation track (and close hips positions). */
function looksLooped(tracks: KeyframeTrack[], posTolerance: number): boolean {
  for (const t of tracks) {
    const n = t.times.length, s = t.getValueSize(), v = t.values;
    if (s === 4) {
      const dot = Math.abs(v[0] * v[(n - 1) * 4] + v[1] * v[(n - 1) * 4 + 1] + v[2] * v[(n - 1) * 4 + 2] + v[3] * v[(n - 1) * 4 + 3]);
      if (dot < Math.cos((8 * Math.PI) / 180 / 2)) return false;
    } else if (s === 3) {
      if (Math.hypot(v[0] - v[(n - 1) * 3], v[1] - v[(n - 1) * 3 + 1], v[2] - v[(n - 1) * 3 + 2]) > posTolerance) return false;
    }
  }
  return true;
}

export interface ImportedClip extends RigClip {
  source: AnimationSource;
}

/**
 * Parse `file` and retarget every clip in it onto `rig`. The returned
 * `source` can be retargeted again after the rig changes (joint edits).
 */
export async function importAnimationFile(file: Blob, name: string, rig: RigDescriptor, opts: ParseOptions & RetargetOptions = {}): Promise<ImportedClip[]> {
  const sources = await parseAnimationFile(file, name, opts);
  return sources.map((source) => ({ ...retargetAnimation(source, rig, { inPlace: opts.inPlace }), source }));
}
