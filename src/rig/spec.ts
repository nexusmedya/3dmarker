/**
 * Generic skeletons (SkeletonSpec, ./types.ts): naming, topology, mirroring,
 * the humanoid ↔ spec bridge, skin segments, bone hierarchy construction and
 * forward kinematics. Pure (three.js math only).
 *
 * The rest-pose convention is the humanoid one (./skeleton.ts): every bone's
 * local rotation is identity and its local position is the offset of its
 * head from its parent's head, so a bone's local axes are the model axes at
 * rest and procedural clips can rotate about body-frame axes directly.
 */
import { Bone, Quaternion, Skeleton, Vector3 } from 'three';
import { bonesOfLayout, CORE_BONES, END_BONES, isHumanoidBone, parentOf } from './bones';
import type { ContactSample } from './contact';
import { boneSegments, storeRest, type BoneSegment, type RigSkeleton } from './skeleton';
import type { SkinWeights } from './skinning';
import type { BoneRole, BoneSpec, HumanoidBone, JointLayout, SkeletonSpec, TemplateId, Vec3 } from './types';

export const vec = (p: Vec3) => new Vector3(p.x, p.y, p.z);
export const plain = (v: Vector3 | Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function cloneBone(b: BoneSpec): BoneSpec {
  return { ...b, head: { ...b.head }, tail: { ...b.tail }, role: b.role ? { ...b.role } : undefined };
}

export function cloneSpec(spec: SkeletonSpec): SkeletonSpec {
  return {
    template: spec.template,
    bones: spec.bones.map(cloneBone),
    frame: { forward: { ...spec.frame.forward }, up: { ...spec.frame.up } },
  };
}

// ---------------------------------------------------------------------------
// Names

/** A name animation tracks can bind to (three's PropertyBinding reserves `[]./:` and spaces). */
export function sanitizeBoneName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s || 'Bone';
}

/** `base` (sanitised), or with a numeric suffix when another bone already has it. */
export function uniqueBoneName(spec: SkeletonSpec, base: string, except?: string): string {
  const taken = new Set(spec.bones.map((b) => b.name).filter((n) => n !== except));
  const clean = sanitizeBoneName(base);
  if (!taken.has(clean)) return clean;
  const stem = clean.replace(/_\d+$/, '');
  for (let k = 1; ; k++) if (!taken.has(`${stem}_${k}`)) return `${stem}_${k}`;
}

const SIDE_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^Left(?=[A-Z0-9_]|$)/, () => 'Right'],
  [/^Right(?=[A-Z0-9_]|$)/, () => 'Left'],
  [/^left(?=[A-Z0-9_]|$)/, () => 'right'],
  [/^right(?=[A-Z0-9_]|$)/, () => 'left'],
  [/^L(?=[_-])/, () => 'R'],
  [/^R(?=[_-])/, () => 'L'],
  [/^l(?=[_-])/, () => 'r'],
  [/^r(?=[_-])/, () => 'l'],
];
const SUFFIX_PATTERNS: [RegExp, string][] = [
  [/([_-])L$/, 'R'],
  [/([_-])R$/, 'L'],
  [/([_-])l$/, 'r'],
  [/([_-])r$/, 'l'],
  [/([_-])Left$/, 'Right'],
  [/([_-])Right$/, 'Left'],
];

/** LeftArm ↔ RightArm, L_ear ↔ R_ear, wing_L ↔ wing_R …; null for unsided names. */
export function mirrorBoneName(name: string): string | null {
  for (const [re, rep] of SIDE_PATTERNS) {
    const m = re.exec(name);
    if (m) return rep(m) + name.slice(m[0].length);
  }
  for (const [re, rep] of SUFFIX_PATTERNS) {
    const m = re.exec(name);
    if (m) return name.slice(0, m.index) + m[1] + rep;
  }
  return null;
}

export function sideOfName(name: string): 'L' | 'R' | null {
  if (/^(Left|left)(?=[A-Z0-9_]|$)|^[Ll](?=[_-])|[_-][Ll]$|[_-]Left$/.test(name)) return 'L';
  if (/^(Right|right)(?=[A-Z0-9_]|$)|^[Rr](?=[_-])|[_-][Rr]$|[_-]Right$/.test(name)) return 'R';
  return null;
}

// ---------------------------------------------------------------------------
// Topology

export function boneMap(spec: SkeletonSpec): Map<string, BoneSpec> {
  return new Map(spec.bones.map((b) => [b.name, b]));
}

export function childrenOf(spec: SkeletonSpec, name: string): BoneSpec[] {
  return spec.bones.filter((b) => b.parent === name);
}

export function rootOf(spec: SkeletonSpec): BoneSpec {
  const r = spec.bones.find((b) => b.parent === null);
  if (!r) throw new Error('Skeleton has no root bone');
  return r;
}

/** `name` and every bone below it. */
export function subtree(spec: SkeletonSpec, name: string): Set<string> {
  const out = new Set<string>([name]);
  for (const b of spec.bones) if (b.parent && out.has(b.parent)) out.add(b.name);
  // Parents-first order makes one pass enough; be safe for unsorted input.
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of spec.bones) if (b.parent && out.has(b.parent) && !out.has(b.name)) (out.add(b.name), (grew = true));
  }
  return out;
}

export function depthOf(spec: SkeletonSpec, name: string): number {
  const m = boneMap(spec);
  let d = 0;
  for (let b = m.get(name); b?.parent; b = m.get(b.parent)) if (++d > spec.bones.length) break;
  return d;
}

/** Stable parents-first order (bones whose parent is missing are dropped with their subtree). */
export function sortParentsFirst(bones: BoneSpec[]): BoneSpec[] {
  const out: BoneSpec[] = [];
  const placed = new Set<string>();
  let rest = [...bones];
  for (;;) {
    const next: BoneSpec[] = [];
    for (const b of rest) {
      if (b.parent === null || placed.has(b.parent)) {
        out.push(b);
        placed.add(b.name);
      } else next.push(b);
    }
    if (next.length === rest.length || !next.length) break;
    rest = next;
  }
  return out;
}

/** Problems that make a spec unusable (empty = valid). */
export function validateSpec(spec: SkeletonSpec): string[] {
  const errs: string[] = [];
  if (!spec.bones.length) errs.push('no bones');
  const names = new Set<string>();
  const seen = new Set<string>();
  let roots = 0;
  for (const b of spec.bones) {
    if (names.has(b.name)) errs.push(`duplicate bone name ${b.name}`);
    names.add(b.name);
    if (sanitizeBoneName(b.name) !== b.name) errs.push(`invalid bone name ${b.name}`);
    if (b.parent === null) roots++;
    else if (!seen.has(b.parent)) errs.push(`${b.name}: parent ${b.parent} missing or not before it`);
    for (const p of [b.head, b.tail]) if (![p.x, p.y, p.z].every(Number.isFinite)) errs.push(`${b.name}: non-finite position`);
    seen.add(b.name);
  }
  if (spec.bones.length && roots !== 1) errs.push(`${roots} root bones (need exactly 1)`);
  return errs;
}

/** The subject's left in the model frame (up × forward). */
export function leftAxis(spec: SkeletonSpec): Vector3 {
  const l = new Vector3().crossVectors(vec(spec.frame.up), vec(spec.frame.forward));
  return l.lengthSq() > 1e-12 ? l.normalize() : new Vector3(1, 0, 0);
}

/** Bounding-box diagonal of the joints (a size scale for tolerances and marker sizes). */
export function specSize(spec: SkeletonSpec): number {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of spec.bones) {
    for (const p of [b.head, b.tail]) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); z0 = Math.min(z0, p.z);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); z1 = Math.max(z1, p.z);
    }
  }
  return Number.isFinite(x0) ? Math.max(Math.hypot(x1 - x0, y1 - y0, z1 - z0), 1e-3) : 1;
}

/** Mirror a point across the spec's symmetry plane (through the root head, normal = left). */
export function mirrorPoint(spec: SkeletonSpec, p: Vec3): Vec3 {
  const n = leftAxis(spec);
  const o = rootOf(spec).head;
  const d = (p.x - o.x) * n.x + (p.y - o.y) * n.y + (p.z - o.z) * n.z;
  return { x: p.x - 2 * d * n.x, y: p.y - 2 * d * n.y, z: p.z - 2 * d * n.z };
}

/**
 * The bone mirroring `name`: by naming convention first (Left ↔ Right, _L ↔ _R…),
 * else the bone whose head is nearest the mirrored head (within 3 % of the
 * skeleton size, not on the plane). Null when none (centre bones).
 */
export function findMirrorBone(spec: SkeletonSpec, name: string): string | null {
  const m = boneMap(spec);
  const b = m.get(name);
  if (!b) return null;
  const byName = mirrorBoneName(name);
  if (byName && m.has(byName)) return byName;
  const size = specSize(spec);
  const mp = mirrorPoint(spec, b.head);
  if (vec(mp).distanceTo(vec(b.head)) < 0.02 * size) return null; // on the plane
  let best: string | null = null, bestD = 0.03 * size;
  for (const o of spec.bones) {
    if (o.name === name) continue;
    const d = vec(o.head).distanceTo(vec(mp));
    if (d < bestD) (bestD = d), (best = o.name);
  }
  return best;
}

export function mirrorRole(r: BoneRole | undefined): BoneRole | undefined {
  if (!r) return r;
  return r.side ? { ...r, side: r.side === 'L' ? 'R' : 'L' } : { ...r };
}

// ---------------------------------------------------------------------------
// Humanoid bridge

export const HUMANOID_FRAME = { forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };

export function humanoidRole(b: HumanoidBone): BoneRole | undefined {
  const side = b.startsWith('Left') ? 'L' : b.startsWith('Right') ? 'R' : undefined;
  const part = side ? b.slice(side === 'L' ? 4 : 5) : b;
  switch (part) {
    case 'Hips': return { part: 'root' };
    case 'Spine': return { part: 'spine', index: 0 };
    case 'Spine1': return { part: 'spine', index: 1 };
    case 'Spine2': return { part: 'spine', index: 2 };
    case 'Neck': return { part: 'neck', index: 0 };
    case 'Head': return { part: 'head' };
    case 'HeadTop_End': return { part: 'end' };
    case 'Shoulder': return { part: 'arm', side, index: 0 };
    case 'Arm': return { part: 'arm', side, index: 1 };
    case 'ForeArm': return { part: 'arm', side, index: 2 };
    case 'Hand': return { part: 'arm', side, index: 3 };
    case 'UpLeg': return { part: 'leg', side, index: 1 };
    case 'Leg': return { part: 'leg', side, index: 2 };
    case 'Foot': return { part: 'leg', side, index: 3 };
    case 'ToeBase': return { part: 'leg', side, index: 4 };
    default: return undefined;
  }
}

/**
 * The spec of a humanoid layout: bones in skeleton order (bonesOfLayout),
 * heads = the joints, tails = the skinning segments' far ends (so weights
 * computed from the spec equal the humanoid ones). `extras` (free bones
 * added in the editor) are appended.
 */
export function humanoidSpecFromLayout(layout: JointLayout, extras: BoneSpec[] = []): SkeletonSpec {
  const names = bonesOfLayout(layout);
  const segs = new Map(boneSegments(names, layout).map((s) => [s.bone, s]));
  const bones: BoneSpec[] = names.map((n) => {
    const head = plain(layout[n]!);
    const seg = segs.get(n);
    const tail = seg ? plain(seg.tail) : { x: head.x, y: head.y + 0.02, z: head.z };
    return { name: n, parent: parentOf(n), head, tail, deform: !END_BONES.has(n), role: humanoidRole(n) };
  });
  const have = new Set(names as string[]);
  const kept = sortParentsFirst([...bones, ...extras.filter((e) => !have.has(e.name)).map(cloneBone)]);
  return { template: 'humanoid', bones: kept, frame: { forward: { ...HUMANOID_FRAME.forward }, up: { ...HUMANOID_FRAME.up } } };
}

/**
 * The humanoid layout of a spec when it still is a valid humanoid (every
 * core bone with its humanoid parent; complete finger chains), else null.
 * Extra bones are allowed (humanoid clips leave them at rest).
 */
export function humanoidLayoutOf(spec: SkeletonSpec): JointLayout | null {
  const m = boneMap(spec);
  for (const b of CORE_BONES) {
    const s = m.get(b);
    if (!s || s.parent !== parentOf(b)) return null;
  }
  const layout: JointLayout = {};
  for (const s of spec.bones) {
    if (!isHumanoidBone(s.name)) continue;
    if (s.parent !== parentOf(s.name)) continue; // a reparented finger: an extra bone
    layout[s.name] = { ...s.head };
  }
  // Keep only complete finger chains (bonesOfLayout drops the others).
  const keep = new Set(bonesOfLayout(layout));
  for (const k of Object.keys(layout) as HumanoidBone[]) if (!keep.has(k)) delete layout[k];
  return layout;
}

// ---------------------------------------------------------------------------
// Skeleton, segments, kinematics

/** Skinning segments of the deforming bones (head → tail); index = position in `spec.bones`. */
export function segmentsOfSpec(spec: SkeletonSpec): BoneSegment[] {
  const out: BoneSegment[] = [];
  spec.bones.forEach((b, index) => {
    if (!b.deform) return;
    const head = vec(b.head), tail = vec(b.tail);
    if (tail.distanceTo(head) < 1e-6) tail.y += 1e-4;
    out.push({ bone: b.name, index, head, tail });
  });
  if (!out.length && spec.bones.length) {
    const b = spec.bones[0];
    out.push({ bone: b.name, index: 0, head: vec(b.head), tail: vec(b.tail).add(new Vector3(0, 1e-4, 0)) });
  }
  return out;
}

/** Bone hierarchy in its rest pose (bone order = spec order = skin index). */
export function buildSkeletonFromSpec(spec: SkeletonSpec): RigSkeleton {
  const errs = validateSpec(spec);
  if (errs.length) throw new Error(`Invalid skeleton: ${errs.join('; ')}`);
  const byName = new Map<string, Bone>();
  const bones: Bone[] = [];
  const m = boneMap(spec);
  for (const s of spec.bones) {
    const bone = new Bone();
    bone.name = s.name;
    const pp = s.parent ? m.get(s.parent)!.head : { x: 0, y: 0, z: 0 };
    bone.position.set(s.head.x - pp.x, s.head.y - pp.y, s.head.z - pp.z);
    storeRest(bone);
    if (s.parent) byName.get(s.parent)!.add(bone);
    byName.set(s.name, bone);
    bones.push(bone);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  return { root, bones, names: spec.bones.map((b) => b.name), byName, skeleton: new Skeleton(bones) };
}

/** Move existing bones to the spec's rest heads (same names and hierarchy), resetting rotations. */
export function applySpecRest(rig: RigSkeleton, spec: SkeletonSpec): void {
  const m = boneMap(spec);
  for (const s of spec.bones) {
    const bone = rig.byName.get(s.name);
    if (!bone) continue;
    const pp = s.parent ? m.get(s.parent)!.head : { x: 0, y: 0, z: 0 };
    bone.position.set(s.head.x - pp.x, s.head.y - pp.y, s.head.z - pp.z);
    bone.quaternion.identity();
    bone.scale.set(1, 1, 1);
    storeRest(bone);
  }
}

/** Same bone names and parents in the same order (a rest-only change keeps the bone objects). */
export function sameTopology(a: SkeletonSpec, b: SkeletonSpec): boolean {
  if (a.bones.length !== b.bones.length) return false;
  return a.bones.every((x, i) => x.name === b.bones[i].name && x.parent === b.bones[i].parent);
}

export interface PoseFK {
  /** World (root-local frame) rotation per bone, spec order. */
  rot: Quaternion[];
  /** Head position per bone, spec order. */
  pos: Vector3[];
}

const IDENTITY = new Quaternion();

/**
 * Forward kinematics of a pose: local rotations (null / missing = rest) and
 * an offset of the root head from its rest position.
 */
export function poseFK(spec: SkeletonSpec, local: (name: string, index: number) => Quaternion | null | undefined, rootOffset?: Vec3): PoseFK {
  const idx = new Map(spec.bones.map((b, i) => [b.name, i]));
  const rot: Quaternion[] = [], pos: Vector3[] = [];
  spec.bones.forEach((b, i) => {
    const l = local(b.name, i) ?? IDENTITY;
    const pi = b.parent !== null ? idx.get(b.parent) : undefined;
    if (pi === undefined) {
      rot.push(l.clone());
      pos.push(vec(b.head).add(rootOffset ? vec(rootOffset) : new Vector3()));
      return;
    }
    const p = spec.bones[pi];
    rot.push(rot[pi].clone().multiply(l));
    pos.push(new Vector3(b.head.x - p.head.x, b.head.y - p.head.y, b.head.z - p.head.z).applyQuaternion(rot[pi]).add(pos[pi]));
  });
  return { rot, pos };
}

/** Where a bone's tail is in a pose (its rest tail carried by its own rotation). */
export function posedTail(spec: SkeletonSpec, fk: PoseFK, i: number): Vector3 {
  const b = spec.bones[i];
  return new Vector3(b.tail.x - b.head.x, b.tail.y - b.head.y, b.tail.z - b.head.z).applyQuaternion(fk.rot[i]).add(fk.pos[i]);
}

/** Template of a spec after a structural edit: a humanoid that lost its humanoid structure becomes custom. */
export function effectiveTemplate(spec: SkeletonSpec): TemplateId {
  if (spec.template === 'humanoid' && !humanoidLayoutOf(spec)) return 'custom';
  return spec.template;
}

// ---------------------------------------------------------------------------
// Descriptors and weight remapping

/** What the generic (animal / custom) clip builder needs about a bound rig. */
export interface SpecDescriptor {
  spec: SkeletonSpec;
  /** Skinned-surface sample (skin indices = positions in `spec.bones`); joints only without it. */
  contact?: ContactSample;
}

/**
 * Carry skin weights over a structural edit: every influence keeps its bone
 * (by name, through `renamed` old → new), a bone that is gone gives its
 * weight to its nearest surviving ancestor in the OLD hierarchy (deleting a
 * bone hands its vertices to its parent); duplicates merge, top 4 renormalised.
 */
export function remapWeights(weights: SkinWeights, oldSpec: SkeletonSpec, newSpec: SkeletonSpec, renamed: Record<string, string> = {}): SkinWeights {
  const newIdx = new Map(newSpec.bones.map((b, i) => [b.name, i]));
  const oldMap = boneMap(oldSpec);
  const target = oldSpec.bones.map((b) => {
    for (let cur: BoneSpec | undefined = b; cur; cur = cur.parent ? oldMap.get(cur.parent) : undefined) {
      const n = renamed[cur.name] ?? cur.name;
      const i = newIdx.get(n);
      if (i !== undefined) return i;
    }
    return 0;
  });
  const n = weights.skinIndex.length / 4;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const idx = [0, 0, 0, 0], w = [0, 0, 0, 0];
  for (let v = 0; v < n; v++) {
    let k = 0;
    for (let s = 0; s < 4; s++) {
      const wt = weights.skinWeight[v * 4 + s];
      if (wt <= 0) continue;
      const t = target[weights.skinIndex[v * 4 + s]] ?? 0;
      let j = 0;
      while (j < k && idx[j] !== t) j++;
      if (j === k) (idx[k] = t), (w[k++] = wt);
      else w[j] += wt;
    }
    let sum = 0;
    for (let s = 0; s < k; s++) sum += w[s];
    if (sum <= 0) {
      skinWeight[v * 4] = 1;
      continue;
    }
    for (let s = 0; s < k; s++) {
      skinIndex[v * 4 + s] = idx[s];
      skinWeight[v * 4 + s] = w[s] / sum;
    }
  }
  return { skinIndex, skinWeight };
}

/** Re-index a contact sample from `spec` order to `names` (bones missing there → nearest listed ancestor). */
export function remapContact(contact: ContactSample, spec: SkeletonSpec, names: readonly string[]): ContactSample {
  const idx = new Map(names.map((n, i) => [n, i]));
  const m = boneMap(spec);
  const target = spec.bones.map((b) => {
    for (let cur: BoneSpec | undefined = b; cur; cur = cur.parent ? m.get(cur.parent) : undefined) {
      const i = idx.get(cur.name);
      if (i !== undefined) return i;
    }
    return 0;
  });
  const skinIndex = new Uint16Array(contact.skinIndex.length);
  for (let i = 0; i < skinIndex.length; i++) skinIndex[i] = target[contact.skinIndex[i]] ?? 0;
  return { positions: contact.positions, skinIndex, skinWeight: contact.skinWeight };
}
