/**
 * Keyframe animation authoring for the rig editor (pure).
 *
 * A ClipDoc holds, per bone, rotation keys (local quaternions — the bone's
 * rotation relative to its rest pose, which is identity) and, for the root,
 * position keys, each with the interpolation towards the next key: linear
 * (slerp / lerp), smooth (Catmull-Rom through the neighbouring keys, cyclic
 * for loops) or step (hold). Operations return new documents (undo keeps
 * them). `toAnimationClip` bakes the document at its fps into a three.js
 * clip whose tracks bind by bone name — it plays in the AnimationPlayer and
 * goes into the GLB export like any other clip.
 */
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { KeyframeTrack } from 'three';
import { makeContinuous } from '../retarget';
import { findMirrorBone, leftAxis, mirrorPoint } from '../spec';
import type { AnimationCategory, AnimationInfo, RigClip, SkeletonSpec } from '../types';

export type Interp = 'linear' | 'smooth' | 'step';
export type Q4 = [number, number, number, number];
export type P3 = [number, number, number];

export interface RotKey {
  t: number;
  q: Q4;
  interp: Interp;
}

export interface PosKey {
  t: number;
  p: P3;
  interp: Interp;
}

export interface ClipDoc {
  name: string;
  fps: number;
  /** Seconds. */
  duration: number;
  loop: boolean;
  category: AnimationCategory;
  rot: Record<string, RotKey[]>;
  pos: Record<string, PosKey[]>;
}

/** A pose snapshot: local rotations (and root positions) by bone name. */
export interface PoseSnapshot {
  rot: Record<string, Q4>;
  pos: Record<string, P3>;
}

export function newClipDoc(name = 'Custom', duration = 2, fps = 30, loop = true): ClipDoc {
  return { name, fps, duration, loop, category: 'action', rot: {}, pos: {} };
}

const cloneDoc = (d: ClipDoc): ClipDoc => ({
  ...d,
  rot: Object.fromEntries(Object.entries(d.rot).map(([b, ks]) => [b, ks.map((k) => ({ ...k, q: [...k.q] as Q4 }))])),
  pos: Object.fromEntries(Object.entries(d.pos).map(([b, ks]) => [b, ks.map((k) => ({ ...k, p: [...k.p] as P3 }))])),
});

/** Time snapped to the document's frame grid and clamped to [0, duration]. */
export function snapTime(doc: ClipDoc, t: number): number {
  const f = Math.round(Math.min(Math.max(t, 0), doc.duration) * doc.fps);
  return Math.min(f / doc.fps, doc.duration);
}

const near = (doc: ClipDoc, a: number, b: number) => Math.abs(a - b) < 0.5 / doc.fps;

function upsert<K extends { t: number }>(doc: ClipDoc, keys: K[] | undefined, key: K): K[] {
  const out = (keys ?? []).filter((k) => !near(doc, k.t, key.t));
  out.push(key);
  return out.sort((a, b) => a.t - b.t);
}

export function setRotKey(doc: ClipDoc, bone: string, t: number, q: Q4, interp: Interp = 'smooth'): ClipDoc {
  const d = cloneDoc(doc);
  const tt = snapTime(d, t);
  d.rot[bone] = upsert(d, d.rot[bone], { t: tt, q: normalizeQ(q), interp });
  return d;
}

export function setPosKey(doc: ClipDoc, bone: string, t: number, p: P3, interp: Interp = 'smooth'): ClipDoc {
  const d = cloneDoc(doc);
  const tt = snapTime(d, t);
  d.pos[bone] = upsert(d, d.pos[bone], { t: tt, p: [...p] as P3, interp });
  return d;
}

/** Key a whole pose at t (every bone in the snapshot). */
export function setPoseKeys(doc: ClipDoc, t: number, pose: PoseSnapshot, interp: Interp = 'smooth', bones?: ReadonlySet<string>): ClipDoc {
  let d = doc;
  for (const [b, q] of Object.entries(pose.rot)) if (!bones || bones.has(b)) d = setRotKey(d, b, t, q, interp);
  for (const [b, p] of Object.entries(pose.pos)) if (!bones || bones.has(b)) d = setPosKey(d, b, t, p, interp);
  return d;
}

/** Delete the keys at t (of `bone`, or of every bone). */
export function deleteKeys(doc: ClipDoc, t: number, bone?: string): ClipDoc {
  const d = cloneDoc(doc);
  for (const tracks of [d.rot, d.pos] as Record<string, { t: number }[]>[]) {
    for (const b of Object.keys(tracks)) {
      if (bone && b !== bone) continue;
      tracks[b] = tracks[b].filter((k) => !near(d, k.t, t));
      if (!tracks[b].length) delete tracks[b];
    }
  }
  return d;
}

/** Move the keys at `from` to `to` (of `bone`, or of every bone); keys already at `to` are replaced. */
export function moveKeys(doc: ClipDoc, from: number, to: number, bone?: string): ClipDoc {
  const d = cloneDoc(doc);
  const tt = snapTime(d, to);
  for (const tracks of [d.rot, d.pos] as Record<string, { t: number }[]>[]) {
    for (const b of Object.keys(tracks)) {
      if (bone && b !== bone) continue;
      const moving = tracks[b].filter((k) => near(d, k.t, from));
      if (!moving.length) continue;
      const rest = tracks[b].filter((k) => !near(d, k.t, from) && !near(d, k.t, tt));
      tracks[b] = [...rest, ...moving.map((k) => ({ ...k, t: tt }))].sort((a, c) => a.t - c.t);
    }
  }
  return d;
}

/** Set the interpolation of the keys at t (of `bone`, or of every bone). */
export function setInterp(doc: ClipDoc, t: number, interp: Interp, bone?: string): ClipDoc {
  const d = cloneDoc(doc);
  for (const tracks of [d.rot, d.pos] as Record<string, { t: number; interp: Interp }[]>[]) {
    for (const b of Object.keys(tracks)) {
      if (bone && b !== bone) continue;
      for (const k of tracks[b]) if (near(d, k.t, t)) k.interp = interp;
    }
  }
  return d;
}

/** Change the duration / fps / loop / name; keys beyond a shorter duration are dropped. */
export function setDocProps(doc: ClipDoc, p: Partial<Pick<ClipDoc, 'duration' | 'fps' | 'loop' | 'name' | 'category'>>): ClipDoc {
  const d = { ...cloneDoc(doc), ...p };
  d.duration = Math.max(1 / d.fps, Math.min(d.duration, 600));
  d.fps = Math.round(Math.min(Math.max(d.fps, 1), 120));
  for (const tracks of [d.rot, d.pos] as Record<string, { t: number }[]>[]) {
    for (const b of Object.keys(tracks)) {
      tracks[b] = tracks[b].filter((k) => k.t <= d.duration + 1e-9).map((k) => ({ ...k, t: snapTime(d, k.t) }));
      if (!tracks[b].length) delete tracks[b];
    }
  }
  return d;
}

/** Sorted distinct key times (of `bone`, or of every bone). */
export function keyTimes(doc: ClipDoc, bone?: string): number[] {
  const ts: number[] = [];
  for (const tracks of [doc.rot, doc.pos] as Record<string, { t: number }[]>[]) {
    for (const [b, ks] of Object.entries(tracks)) if (!bone || b === bone) for (const k of ks) ts.push(k.t);
  }
  ts.sort((a, b) => a - b);
  return ts.filter((t, i) => i === 0 || !near(doc, t, ts[i - 1]));
}

// ---------------------------------------------------------------------------
// Sampling

function normalizeQ(q: Q4): Q4 {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

interface Seg<K> {
  a: K;
  b: K;
  /** Keys before a and after b (Catmull-Rom). */
  p: K;
  n: K;
  /** 0..1 within the segment. */
  s: number;
}

/** The segment of a (sorted) track containing t; cyclic across the loop seam. */
function segment<K extends { t: number }>(keys: K[], t: number, duration: number, loop: boolean): Seg<K> | K {
  const n = keys.length;
  if (n === 1) return keys[0];
  if (!loop) {
    if (t <= keys[0].t) return keys[0];
    if (t >= keys[n - 1].t) return keys[n - 1];
  }
  let i = -1;
  for (let k = 0; k < n; k++) if (keys[k].t <= t + 1e-9) i = k;
  let a: K, b: K, ta: number, tb: number, ia: number;
  if (i < 0 || i === n - 1) {
    if (!loop) return keys[Math.max(i, 0)];
    // Across the seam: last key → first key one period later.
    if (i < 0) (a = keys[n - 1]), (ta = keys[n - 1].t - duration), (ia = n - 1);
    else (a = keys[n - 1]), (ta = keys[n - 1].t), (ia = n - 1);
    b = keys[0];
    tb = keys[0].t + (i < 0 ? 0 : duration);
  } else {
    a = keys[i];
    b = keys[i + 1];
    ta = a.t;
    tb = b.t;
    ia = i;
  }
  const at = (k: number) => keys[((k % n) + n) % n];
  const p = loop ? at(ia - 1) : keys[Math.max(0, ia - 1)];
  const nx = loop ? at(ia + 2) : keys[Math.min(n - 1, ia + 2)];
  const span = tb - ta;
  return { a, b, p, n: nx, s: span > 1e-9 ? Math.min(1, Math.max(0, (t - ta) / span)) : 0 };
}

const catmull = (p0: number, p1: number, p2: number, p3: number, s: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);

function sampleRot(keys: RotKey[], t: number, duration: number, loop: boolean, out: Quaternion): Quaternion {
  const seg = segment(keys, t, duration, loop);
  if (!('s' in seg)) return out.fromArray(seg.q);
  const { a, b, s } = seg;
  if (a.interp === 'step') return out.fromArray(a.q);
  const qa = new Quaternion().fromArray(a.q), qb = new Quaternion().fromArray(b.q);
  if (a.interp === 'linear') return out.copy(qa).slerp(qb, s);
  // Smooth: Catmull-Rom on hemisphere-aligned components, renormalised.
  const qp = new Quaternion().fromArray(seg.p.q), qn = new Quaternion().fromArray(seg.n.q);
  const align = (x: Quaternion, ref: Quaternion) => (x.dot(ref) < 0 ? x.set(-x.x, -x.y, -x.z, -x.w) : x);
  align(qb, qa);
  align(qp, qa);
  align(qn, qb);
  const c = (k: 'x' | 'y' | 'z' | 'w') => catmull(qp[k], qa[k], qb[k], qn[k], s);
  return out.set(c('x'), c('y'), c('z'), c('w')).normalize();
}

function samplePos(keys: PosKey[], t: number, duration: number, loop: boolean, out: Vector3): Vector3 {
  const seg = segment(keys, t, duration, loop);
  if (!('s' in seg)) return out.fromArray(seg.p);
  const { a, b, s } = seg;
  if (a.interp === 'step') return out.fromArray(a.p);
  if (a.interp === 'linear') return out.fromArray(a.p).lerp(new Vector3().fromArray(b.p), s);
  return out.set(catmull(seg.p.p[0], a.p[0], b.p[0], seg.n.p[0], s), catmull(seg.p.p[1], a.p[1], b.p[1], seg.n.p[1], s), catmull(seg.p.p[2], a.p[2], b.p[2], seg.n.p[2], s));
}

/** The pose of the document at time t (only keyed bones). */
export function samplePose(doc: ClipDoc, t: number): { rot: Map<string, Quaternion>; pos: Map<string, Vector3> } {
  const rot = new Map<string, Quaternion>(), pos = new Map<string, Vector3>();
  for (const [b, ks] of Object.entries(doc.rot)) if (ks.length) rot.set(b, sampleRot(ks, t, doc.duration, doc.loop, new Quaternion()));
  for (const [b, ks] of Object.entries(doc.pos)) if (ks.length) pos.set(b, samplePos(ks, t, doc.duration, doc.loop, new Vector3()));
  return { rot, pos };
}

/** Clip id of a custom clip name. */
export function customClipId(name: string): string {
  return `custom-${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clip'}`;
}

/** Bake the document into an AnimationClip (tracks per keyed bone at the document's fps). */
export function toAnimationClip(doc: ClipDoc, id = customClipId(doc.name)): RigClip {
  const frames = Math.max(2, Math.round(doc.duration * doc.fps) + 1);
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = Math.min((f / (frames - 1)) * doc.duration, doc.duration);
  const tracks: KeyframeTrack[] = [];
  const q = new Quaternion(), v = new Vector3();
  for (const [b, ks] of Object.entries(doc.rot)) {
    if (!ks.length) continue;
    const vals = new Float32Array(frames * 4);
    for (let f = 0; f < frames; f++) sampleRot(ks, doc.loop && f === frames - 1 ? 0 : times[f], doc.duration, doc.loop, q).toArray(vals, f * 4);
    makeContinuous(vals);
    tracks.push(new QuaternionKeyframeTrack(`${b}.quaternion`, times, vals));
  }
  for (const [b, ks] of Object.entries(doc.pos)) {
    if (!ks.length) continue;
    const vals = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) samplePos(ks, doc.loop && f === frames - 1 ? 0 : times[f], doc.duration, doc.loop, v).toArray(vals, f * 3);
    tracks.push(new VectorKeyframeTrack(`${b}.position`, times, vals));
  }
  const clip = new AnimationClip(doc.name || id, doc.duration, tracks);
  const info: AnimationInfo = { id, name: { tr: doc.name, en: doc.name }, category: doc.category, loop: doc.loop, source: 'custom', duration: doc.duration };
  clip.userData = { ...clip.userData, info, doc: cloneDoc(doc) };
  return { clip, info };
}

// ---------------------------------------------------------------------------
// Pose tools

/** Mirror a rotation across the plane with unit normal n: (v, w) → (2(v·n)n − v, w). */
export function mirrorQuat(q: Q4, n: Vector3): Q4 {
  const d = q[0] * n.x + q[1] * n.y + q[2] * n.z;
  return [2 * d * n.x - q[0], 2 * d * n.y - q[1], 2 * d * n.z - q[2], q[3]];
}

/** The pose mirrored left ↔ right: each bone takes its mirror bone's reflected rotation. */
export function mirrorPose(pose: PoseSnapshot, spec: SkeletonSpec): PoseSnapshot {
  const n = leftAxis(spec);
  const out: PoseSnapshot = { rot: {}, pos: {} };
  for (const [b, q] of Object.entries(pose.rot)) {
    const target = findMirrorBone(spec, b) ?? b;
    out.rot[target] = mirrorQuat(q, n);
  }
  for (const [b, p] of Object.entries(pose.pos)) {
    const target = findMirrorBone(spec, b) ?? b;
    const bone = spec.bones.find((x) => x.name === b);
    if (bone && bone.parent === null) {
      const m = mirrorPoint(spec, { x: p[0], y: p[1], z: p[2] });
      out.pos[target] = [m.x, m.y, m.z];
    } else out.pos[target] = [...p] as P3;
  }
  return out;
}

/** The document with its tracks renamed (bone renames in the editor: old → new). */
export function renameDocBones(doc: ClipDoc, renamed: Record<string, string>): ClipDoc {
  const d = cloneDoc(doc);
  const move = <K>(tracks: Record<string, K>) => {
    const out: Record<string, K> = {};
    for (const [b, ks] of Object.entries(tracks)) out[renamed[b] ?? b] = ks;
    return out;
  };
  return { ...d, rot: move(d.rot), pos: move(d.pos) };
}
