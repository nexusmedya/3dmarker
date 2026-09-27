/**
 * Skeleton editing operations for the rig editor. Pure: every operation
 * takes a SkeletonSpec and returns a new one (plus renames for the weight
 * carry-over and the bone to select), never mutating its input, so undo /
 * redo can keep the specs themselves.
 *
 * Symmetry (`symmetric: true`): the same edit is applied to the mirror bone
 * (../spec.ts findMirrorBone: Left ↔ Right / _L ↔ _R names, else the bone at
 * the mirrored position), mirrored across the plane through the root's head
 * with the body's left as its normal.
 */
import { Vector3 } from 'three';
import {
  boneMap, cloneBone, cloneSpec, findMirrorBone, mirrorBoneName, mirrorPoint, mirrorRole, rootOf, sanitizeBoneName, sideOfName,
  sortParentsFirst, specSize, subtree, uniqueBoneName, vec,
} from '../spec';
import type { BoneRole, BoneSpec, SkeletonSpec, Vec3 } from '../types';

export interface OpResult {
  spec: SkeletonSpec;
  /** Old name → new name for renamed bones. */
  renamed?: Record<string, string>;
  /** Suggested selection after the edit (null = none). */
  select?: string | null;
  /** False when nothing changed (refused / no-op). */
  changed: boolean;
}

const same = (a: Vec3, b: Vec3, tol: number) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tol;
const tolOf = (spec: SkeletonSpec) => 1e-5 * specSize(spec);
const unchanged = (spec: SkeletonSpec): OpResult => ({ spec, changed: false });

/** Normalise a spec after an edit: parents first, the template demoted when a humanoid lost its shape (done by the rig). */
function finish(spec: SkeletonSpec, extra: Omit<OpResult, 'spec' | 'changed'> = {}): OpResult {
  return { spec: { ...spec, bones: sortParentsFirst(spec.bones) }, changed: true, ...extra };
}

function childRole(parent: BoneSpec | undefined): BoneRole | undefined {
  const r = parent?.role;
  if (!r) return undefined;
  if (r.part === 'tail' || r.part === 'chain' || r.part === 'neck' || r.part === 'spine' || r.part === 'wing') return { ...r, index: (r.index ?? 0) + 1 };
  return undefined;
}

export interface AddBoneOptions {
  name?: string;
  /** Default: the parent's tail. */
  head?: Vec3;
  /** Default: continuing the parent's direction, half its length. */
  tail?: Vec3;
  symmetric?: boolean;
  role?: BoneRole;
}

/** Add a child bone under `parent` (and its mirror under the mirror parent when symmetric). */
export function addBone(spec: SkeletonSpec, parent: string, o: AddBoneOptions = {}): OpResult {
  const m = boneMap(spec);
  const p = m.get(parent);
  if (!p) return unchanged(spec);
  const out = cloneSpec(spec);
  const head = o.head ?? { ...p.tail };
  let tail = o.tail;
  if (!tail) {
    const dir = vec(p.tail).sub(vec(p.head));
    const len = dir.length();
    if (len < 1e-9) dir.set(0, 1, 0);
    tail = { x: head.x + (dir.x / (len || 1)) * 0.5 * (len || 0.1), y: head.y + (dir.y / (len || 1)) * 0.5 * (len || 0.1), z: head.z + (dir.z / (len || 1)) * 0.5 * (len || 0.1) };
  }
  const side = sideOfName(parent) ?? pointSide(spec, head);
  const base = o.name ?? `${side === 'L' ? 'Left' : side === 'R' ? 'Right' : ''}Bone`;
  const name = uniqueBoneName(out, base);
  const role = o.role ?? childRole(p);
  out.bones.push({ name, parent, head: { ...head }, tail: { ...tail }, deform: true, role });
  if (o.symmetric) {
    const mp = findMirrorBone(spec, parent) ?? parent;
    const mHead = mirrorPoint(spec, head);
    if (!same(mHead, head, 0.01 * specSize(spec))) {
      const mName = uniqueBoneName(out, mirrorBoneName(name) ?? `${name}_mirror`);
      out.bones.push({ name: mName, parent: mp, head: mHead, tail: mirrorPoint(spec, tail), deform: true, role: mirrorRole(role) });
    }
  }
  return finish(out, { select: name });
}

/** Which side of the symmetry plane a point is on (null near the plane). */
function pointSide(spec: SkeletonSpec, p: Vec3): 'L' | 'R' | null {
  const o = rootOf(spec).head;
  const f = vec(spec.frame.forward), up = vec(spec.frame.up);
  const left = new Vector3().crossVectors(up, f).normalize();
  const d = (p.x - o.x) * left.x + (p.y - o.y) * left.y + (p.z - o.z) * left.z;
  if (Math.abs(d) < 0.02 * specSize(spec)) return null;
  return d > 0 ? 'L' : 'R';
}

/**
 * Delete bones; their children go to the deleted bone's parent. Deleting the
 * root promotes its first child (the other children move under it); the last
 * bone cannot be deleted.
 */
export function deleteBone(spec: SkeletonSpec, name: string, o: { symmetric?: boolean } = {}): OpResult {
  const names = new Set([name]);
  if (o.symmetric) {
    const mb = findMirrorBone(spec, name);
    if (mb) names.add(mb);
  }
  let out = cloneSpec(spec);
  let select: string | null = null;
  for (const n of names) {
    const m = boneMap(out);
    const b = m.get(n);
    if (!b || out.bones.length <= 1) continue;
    const kids = out.bones.filter((x) => x.parent === n);
    if (b.parent === null) {
      if (!kids.length) continue;
      const heir = kids[0];
      heir.parent = null;
      for (const k of kids.slice(1)) k.parent = heir.name;
      if (!heir.role) heir.role = { part: 'root' };
      select = heir.name;
    } else {
      for (const k of kids) k.parent = b.parent;
      select = b.parent;
    }
    out = { ...out, bones: out.bones.filter((x) => x.name !== n) };
  }
  if (out.bones.length === spec.bones.length) return unchanged(spec);
  return finish(out, { select });
}

/** Rename a bone (sanitised, made unique); with symmetry the mirror bone gets the mirrored name. */
export function renameBone(spec: SkeletonSpec, name: string, next: string, o: { symmetric?: boolean } = {}): OpResult {
  const out = cloneSpec(spec);
  const m = boneMap(out);
  const b = m.get(name);
  if (!b) return unchanged(spec);
  const renamed: Record<string, string> = {};
  const doRename = (from: string, to: string) => {
    const bone = boneMap(out).get(from);
    if (!bone) return;
    const clean = uniqueBoneName(out, sanitizeBoneName(to), from);
    if (clean === from) return;
    bone.name = clean;
    for (const x of out.bones) if (x.parent === from) x.parent = clean;
    renamed[from] = clean;
  };
  const mirror = o.symmetric ? findMirrorBone(spec, name) : null;
  doRename(name, next);
  const newName = renamed[name] ?? name;
  if (mirror && mirror !== name) {
    const mName = mirrorBoneName(newName);
    if (mName) doRename(mirror, mName);
  }
  if (!Object.keys(renamed).length) return unchanged(spec);
  return finish(out, { renamed, select: newName });
}

/** Move `name` under `parent` (refused for the root or when `parent` is below `name`). */
export function reparentBone(spec: SkeletonSpec, name: string, parent: string, o: { symmetric?: boolean } = {}): OpResult {
  const out = cloneSpec(spec);
  const apply = (n: string, p: string): boolean => {
    const m = boneMap(out);
    const b = m.get(n);
    if (!b || !m.has(p) || b.parent === null || n === p || b.parent === p) return false;
    if (subtree(out, n).has(p)) return false;
    b.parent = p;
    return true;
  };
  const ok = apply(name, parent);
  if (!ok) return unchanged(spec);
  if (o.symmetric) {
    const mn = findMirrorBone(spec, name), mp = findMirrorBone(spec, parent) ?? parent;
    if (mn && mn !== name) apply(mn, mp);
  }
  return finish(out, { select: name });
}

export type JointEnd = 'head' | 'tail';

/**
 * Move a bone's head or tail (rest pose, root frame). Connected joints move
 * along: the parent's tail when it sat on this head, the heads of children
 * that sat on this tail. Other children keep their positions.
 */
export function moveJoint(spec: SkeletonSpec, name: string, end: JointEnd, pos: Vec3, o: { symmetric?: boolean } = {}): OpResult {
  const out = cloneSpec(spec);
  const tol = tolOf(spec);
  const move = (n: string, p: Vec3) => {
    const m = boneMap(out);
    const b = m.get(n);
    if (!b) return;
    if (end === 'head') {
      const par = b.parent ? m.get(b.parent) : undefined;
      if (par && same(par.tail, b.head, tol)) par.tail = { ...p };
      // Siblings sharing the same head move too (a joint several bones start from).
      for (const s of out.bones) if (s !== b && s.parent === b.parent && s.parent !== null && same(s.head, b.head, tol)) s.head = { ...p };
      b.head = { ...p };
    } else {
      for (const c of out.bones) if (c.parent === n && same(c.head, b.tail, tol)) c.head = { ...p };
      b.tail = { ...p };
    }
  };
  if (!boneMap(out).has(name)) return unchanged(spec);
  move(name, pos);
  if (o.symmetric) {
    const mn = findMirrorBone(spec, name);
    if (mn && mn !== name) move(mn, mirrorPoint(spec, pos));
  }
  return finish(out, { select: name });
}

/**
 * Mirror one side onto the other: every bone on `from` ('L' / 'R', by name
 * or position) gets a mirror bone (created under the mirror parent when
 * missing, else moved) at the mirrored position.
 */
export function mirrorSide(spec: SkeletonSpec, from: 'L' | 'R'): OpResult {
  let out = cloneSpec(spec);
  let changed = false;
  for (const b of spec.bones) {
    const side = sideOfName(b.name) ?? pointSide(spec, b.head);
    if (side !== from) continue;
    const head = mirrorPoint(spec, b.head), tail = mirrorPoint(spec, b.tail);
    const existing = findMirrorBone(out, b.name);
    if (existing && existing !== b.name) {
      const t = boneMap(out).get(existing)!;
      if (!same(t.head, head, tolOf(spec)) || !same(t.tail, tail, tolOf(spec))) changed = true;
      t.head = head;
      t.tail = tail;
      continue;
    }
    const parent = b.parent ? findMirrorBone(out, b.parent) ?? b.parent : null;
    if (parent === null) continue;
    const name = uniqueBoneName(out, mirrorBoneName(b.name) ?? `${b.name}_mirror`);
    out = { ...out, bones: [...out.bones, { ...cloneBone(b), name, parent, head, tail, role: mirrorRole(b.role) }] };
    changed = true;
  }
  return changed ? finish(out) : unchanged(spec);
}

export function setBoneRole(spec: SkeletonSpec, name: string, role: BoneRole | undefined): OpResult {
  const out = cloneSpec(spec);
  const b = boneMap(out).get(name);
  if (!b) return unchanged(spec);
  b.role = role ? { ...role } : undefined;
  return finish(out, { select: name });
}

export function setBoneDeform(spec: SkeletonSpec, name: string, deform: boolean): OpResult {
  const out = cloneSpec(spec);
  const b = boneMap(out).get(name);
  if (!b || b.deform === deform) return unchanged(spec);
  b.deform = deform;
  return finish(out, { select: name });
}

/** Snap a point to the middle of the mesh along a ray: the midpoint between the first two hits (entry / exit). */
export function interiorMidpoint(hits: number[], origin: Vec3, dir: Vec3): Vec3 | null {
  const ts = hits.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const t = (ts[0] + ts[1]) / 2;
  return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
}
