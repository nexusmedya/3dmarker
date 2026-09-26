/**
 * Brush maths on a SculptMesh (local frame). One call = one dab: gather the
 * welded vertices inside the brush sphere, weight them (falloff × facing ×
 * boundary lock), move them, then update the touched normals and refit the
 * BVH along the gathered node paths.
 */
import { Vector3 } from 'three';
import type { BrushId, Falloff } from './types';
import { falloffWeight } from './falloff';
import { Gathered, type SculptMesh } from './sculptMesh';

/** Per-dab displacement scales (fractions of the brush radius at strength 1, weight 1). */
export const BRUSH_TUNING = {
  draw: 0.1,
  inflate: 0.08,
  /** Clay: the target plane sits this far above the area centre. */
  clay: 0.08,
  /** Clay: fraction of the distance to the plane covered per dab. */
  clayFill: 0.5,
  pinch: 0.3,
  creaseDepth: 0.08,
  creasePinch: 0.25,
  /** Vertices whose normal points away from the brush normal fade out over this dot range (0 = hard cut). */
  frontSoftness: 0.35,
};

export interface Dab {
  brush: Exclude<BrushId, 'grab'>;
  /** Brush centre, local frame. */
  center: Vector3;
  /** Surface normal at the centre, local frame, unit, facing the viewer. */
  normal: Vector3;
  /** Local radius. */
  radius: number;
  /** 0..1 (strength × pen pressure). */
  strength: number;
  invert: boolean;
  falloff: Falloff;
  lockBoundary: boolean;
  /** Ignore vertices facing away from the brush normal (the far side of thin shells). Default true. */
  frontOnly?: boolean;
  /**
   * -1 when the stroke started on a back face (open surfaces seen from
   * behind): vertex normals are read flipped, so every brush acts towards
   * the viewer just like on the front. Default 1.
   */
  sideSign?: 1 | -1;
}

/** Reusable per-session buffers (avoid allocations per dab). */
export class DabScratch {
  readonly gathered = new Gathered();
  w = new Float32Array(256);
  d = new Float32Array(768);
  moved = new Int32Array(256);

  ensure(n: number): void {
    if (this.w.length >= n) return;
    let cap = this.w.length;
    while (cap < n) cap *= 2;
    this.w = new Float32Array(cap);
    this.d = new Float32Array(cap * 3);
    this.moved = new Int32Array(cap);
  }
}

const _n = new Vector3();
const _p = new Vector3();
const _an = new Vector3();
const _ac = new Vector3();

/** Facing factor of a vertex normal against the brush normal. */
function facing(dot: number, frontOnly: boolean): number {
  if (!frontOnly || dot >= 0) return 1;
  const s = BRUSH_TUNING.frontSoftness;
  return s > 0 ? Math.max(0, 1 + dot / s) : 0;
}

/**
 * Weights of the gathered groups; returns the weighted area normal / centre
 * in `an` / `ac` (the brush normal / centre when nothing has weight).
 */
function weigh(mesh: SculptMesh, dab: Dab, s: DabScratch): number {
  const { gathered: gat } = s;
  s.ensure(gat.count);
  const boundary = mesh.topo.boundary;
  const frontOnly = dab.frontOnly !== false;
  const side = dab.sideSign ?? 1;
  let sw = 0;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < gat.count; i++) {
    const g = gat.groups[i];
    let w = falloffWeight(dab.falloff, gat.t[i]);
    if (w > 0 && dab.lockBoundary && boundary[g]) w = 0;
    if (w > 0) {
      mesh.groupNormal(g, _n).multiplyScalar(side);
      w *= facing(_n.dot(dab.normal), frontOnly);
    }
    s.w[i] = w;
    if (w <= 0) continue;
    mesh.groupPosition(g, _p);
    sw += w;
    nx += _n.x * w;
    ny += _n.y * w;
    nz += _n.z * w;
    cx += _p.x * w;
    cy += _p.y * w;
    cz += _p.z * w;
  }
  _an.set(nx, ny, nz);
  if (_an.lengthSq() < 1e-20 || _an.dot(dab.normal) <= 0) _an.copy(dab.normal);
  _an.normalize();
  if (sw > 0) _ac.set(cx / sw, cy / sw, cz / sw);
  else _ac.copy(dab.center);
  return sw;
}

/** Apply one dab; returns the number of welded vertices that moved. */
export function applyDab(mesh: SculptMesh, dab: Dab, scratch: DabScratch = new DabScratch()): number {
  const gat = scratch.gathered;
  mesh.gather(dab.center, dab.radius, gat);
  if (gat.count === 0) return 0;
  const sw = weigh(mesh, dab, scratch);
  if (sw <= 0) return 0;
  const { w, d } = scratch;
  const sign = dab.invert ? -1 : 1;
  const s = Math.max(0, Math.min(1, dab.strength));
  const r = dab.radius;
  const an = _an, ac = _ac;
  const pos = mesh.pos;
  const c = dab.center;
  const { adjStart, adj, boundary } = mesh.topo;

  for (let i = 0; i < gat.count; i++) {
    const wi = w[i];
    const o = i * 3;
    d[o] = d[o + 1] = d[o + 2] = 0;
    if (wi <= 0) continue;
    const g = gat.groups[i];
    const v = mesh.rep(g) * 3;
    const px = pos[v], py = pos[v + 1], pz = pos[v + 2];
    switch (dab.brush) {
      case 'draw': {
        const k = sign * BRUSH_TUNING.draw * r * s * wi;
        d[o] = an.x * k;
        d[o + 1] = an.y * k;
        d[o + 2] = an.z * k;
        break;
      }
      case 'inflate': {
        mesh.groupNormal(g, _n);
        const k = sign * (dab.sideSign ?? 1) * BRUSH_TUNING.inflate * r * s * wi;
        d[o] = _n.x * k;
        d[o + 1] = _n.y * k;
        d[o + 2] = _n.z * k;
        break;
      }
      case 'clay': {
        // Plane above (invert: below) the area centre; only vertices on the
        // wrong side move towards it, so cavities fill before peaks grow.
        const off = sign * BRUSH_TUNING.clay * r * s;
        const h = (px - ac.x) * an.x + (py - ac.y) * an.y + (pz - ac.z) * an.z - off;
        if (sign * h >= 0) break;
        const k = -h * Math.min(1, BRUSH_TUNING.clayFill * wi * (0.5 + s));
        d[o] = an.x * k;
        d[o + 1] = an.y * k;
        d[o + 2] = an.z * k;
        break;
      }
      case 'flatten': {
        const h = (px - ac.x) * an.x + (py - ac.y) * an.y + (pz - ac.z) * an.z;
        const k = -sign * h * Math.min(1, wi * s);
        d[o] = an.x * k;
        d[o + 1] = an.y * k;
        d[o + 2] = an.z * k;
        break;
      }
      case 'pinch':
      case 'crease': {
        // Towards the brush centre within the tangent plane.
        let vx = c.x - px, vy = c.y - py, vz = c.z - pz;
        const vn = vx * an.x + vy * an.y + vz * an.z;
        vx -= an.x * vn;
        vy -= an.y * vn;
        vz -= an.z * vn;
        if (dab.brush === 'pinch') {
          const k = sign * BRUSH_TUNING.pinch * s * wi;
          d[o] = vx * k;
          d[o + 1] = vy * k;
          d[o + 2] = vz * k;
        } else {
          const kp = BRUSH_TUNING.creasePinch * s * wi;
          const kd = -sign * BRUSH_TUNING.creaseDepth * r * s * wi * wi;
          d[o] = vx * kp + an.x * kd;
          d[o + 1] = vy * kp + an.y * kd;
          d[o + 2] = vz * kp + an.z * kd;
        }
        break;
      }
      case 'smooth': {
        // Laplacian (Jacobi: every target is computed before anything moves).
        // Boundary vertices only average their boundary neighbours, so an
        // open rim slides along itself instead of shrinking inwards.
        const onRim = boundary[g] === 1;
        let ax = 0, ay = 0, az = 0, m = 0;
        for (let k = adjStart[g], e = adjStart[g + 1]; k < e; k++) {
          const h = adj[k];
          if (onRim && !boundary[h]) continue;
          const q = mesh.rep(h) * 3;
          ax += pos[q];
          ay += pos[q + 1];
          az += pos[q + 2];
          m++;
        }
        if (m === 0 || (onRim && m < 2)) break;
        const k = Math.min(1, wi * s);
        d[o] = (ax / m - px) * k;
        d[o + 1] = (ay / m - py) * k;
        d[o + 2] = (az / m - pz) * k;
        break;
      }
    }
  }

  let moved = 0;
  for (let i = 0; i < gat.count; i++) {
    const o = i * 3;
    if (d[o] === 0 && d[o + 1] === 0 && d[o + 2] === 0) continue;
    const g = gat.groups[i];
    mesh.moveGroup(g, d[o], d[o + 1], d[o + 2]);
    scratch.moved[moved++] = g;
  }
  if (moved > 0) {
    mesh.updateNormals(scratch.moved, moved);
    mesh.refit(gat.nodes);
  }
  return moved;
}

/** Vertices captured by a grab stroke (fixed for the whole stroke). */
export interface GrabCapture {
  mesh: SculptMesh;
  groups: Int32Array;
  weights: Float32Array;
  nodes: Set<number>;
}

export interface GrabOptions {
  center: Vector3;
  normal: Vector3;
  radius: number;
  falloff: Falloff;
  lockBoundary: boolean;
  /** Scales how closely the vertices follow the pointer (0..1). */
  strength: number;
  frontOnly?: boolean;
  sideSign?: 1 | -1;
  /** Groups already captured (symmetry: the mirrored side must not grab them twice). */
  exclude?: GrabCapture | null;
}

export function captureGrab(mesh: SculptMesh, o: GrabOptions): GrabCapture {
  const gat = new Gathered();
  mesh.gather(o.center, o.radius, gat);
  const skip = o.exclude && o.exclude.mesh === mesh ? new Set(o.exclude.groups) : null;
  const groups: number[] = [];
  const weights: number[] = [];
  const frontOnly = o.frontOnly !== false;
  const k = Math.max(0, Math.min(1, o.strength));
  for (let i = 0; i < gat.count; i++) {
    const g = gat.groups[i];
    if (skip?.has(g)) continue;
    if (o.lockBoundary && mesh.topo.boundary[g]) continue;
    let w = falloffWeight(o.falloff, gat.t[i]);
    if (w > 0) w *= facing(mesh.groupNormal(g, _n).multiplyScalar(o.sideSign ?? 1).dot(o.normal), frontOnly);
    w *= k;
    if (w <= 0) continue;
    groups.push(g);
    weights.push(w);
  }
  return { mesh, groups: Int32Array.from(groups), weights: Float32Array.from(weights), nodes: new Set(gat.nodes) };
}

/** Move the captured vertices by delta (local frame) × their weight. */
export function applyGrab(cap: GrabCapture, dx: number, dy: number, dz: number): number {
  const { mesh, groups, weights } = cap;
  if (groups.length === 0 || (dx === 0 && dy === 0 && dz === 0)) return 0;
  for (let i = 0; i < groups.length; i++) {
    const w = weights[i];
    mesh.moveGroup(groups[i], dx * w, dy * w, dz * w);
  }
  mesh.updateNormals(groups);
  mesh.refit(cap.nodes);
  return groups.length;
}
