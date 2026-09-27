/**
 * Sculpt session on the viewer's model: finds the editable meshes (skinned /
 * instanced ones are skipped: sculpting is off for rigged models), prepares
 * a SculptMesh per geometry (coarse ones are subdivided first, in place:
 * brushes can only move existing vertices), and turns pointer input on the viewer canvas
 * into brush dabs (spacing, pen pressure, Ctrl/Cmd = invert, Shift = smooth,
 * X symmetry in the model's local frame). Strokes only start on the mesh:
 * drags in empty space still orbit. Undo / redo per stroke, a surface-aligned
 * cursor ring, keyboard shortcuts while active.
 *
 * The stroke logic is reachable without DOM events (beginStroke / strokeTo /
 * grabTo / endStroke / applyStrokeAt / raycast), which the tests use.
 * dispose() removes every listener and overlay and keeps the edited geometry.
 */
import { Box3, DoubleSide, Matrix3, Matrix4, Plane, Ray, Raycaster, Sphere, Triangle, Vector2, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { ViewerCore } from '../app/viewer';
import { BRUSH_IDS, DEFAULT_BRUSH, type BrushId, type BrushSettings, type SculptState } from './types';
import { SculptMesh, isSculptable } from './sculptMesh';
import { DabScratch, applyDab, applyGrab, captureGrab, type GrabCapture } from './brushes';
import { SculptHistory } from './history';
import { edgeLengths, refineGeometry } from './refine';
import { BrushCursor, type CursorTone } from './cursor';
import { sanitizeBrushSettings, stepRadius, stepStrength } from './settings';

/** The part of ViewerCore the session uses (tests pass a fake). `refresh` re-fits the ground after an edit. */
export type SculptHost = Pick<ViewerCore, 'canvas' | 'camera' | 'invalidate' | 'setOrbitEnabled' | 'addOverlay' | 'removeOverlay'> &
  Partial<Pick<ViewerCore, 'refresh'>>;

export interface SculptSessionOptions {
  settings?: Partial<BrushSettings>;
  /** Undo depth in strokes (default 64). */
  maxHistory?: number;
  /** Undo memory cap in bytes (default 192 MB). */
  maxHistoryBytes?: number;
  /** Distance between dabs as a fraction of the brush radius (default 0.25). */
  spacing?: number;
  /** Ignore vertices facing away from the brush (thin shells). Default true. */
  frontOnly?: boolean;
  /** Split the edges of coarse meshes at session start so brushes have vertices to move (default true). */
  refine?: boolean;
  /** Where keyboard shortcuts are listened for while active (default: window). */
  keyTarget?: EventTarget | null;
}

export type SculptEvent =
  | { type: 'state'; state: SculptState }
  | { type: 'settings'; settings: BrushSettings }
  /** The geometry changed (stroke end, undo, redo, reset). */
  | { type: 'edit'; state: SculptState }
  /** A stroke ended without the brush reaching any vertex (mesh too coarse for the brush). */
  | { type: 'empty-stroke' };

export interface SculptHit {
  /** World-space hit point. */
  point: Vector3;
  /** World-space surface normal (interpolated vertex normals), flipped to face the ray origin. */
  normal: Vector3;
  /** True when the ray hit the back of the surface (its normals point away from the viewer). */
  backFacing: boolean;
  distance: number;
}

export interface StrokeModifiers {
  /** Ctrl / Cmd: invert the brush direction. */
  invert?: boolean;
  /** Shift: smooth instead of the current brush. */
  smooth?: boolean;
  /** 0..1 (pen pressure); default 1. */
  pressure?: number;
  /** The stroke starts on a back face (see SculptHit.backFacing). */
  backFacing?: boolean;
}

interface Target {
  mesh: Mesh;
  data: SculptMesh;
  mw: Matrix4;
  inv: Matrix4;
  /** Transpose of the world 3×3 (world → local for normals). */
  nT: Matrix3;
  /** Local → world for normals. */
  nW: Matrix3;
  scale: number;
  sphere: Sphere;
}

interface GrabPart {
  target: Target;
  cap: GrabCapture;
  mirrored: boolean;
}

interface Stroke {
  brush: BrushId;
  invert: boolean;
  pressure: number;
  sideSign: 1 | -1;
  last: Vector3;
  lastNormal: Vector3;
  /** Distance travelled since the last dab. */
  carry: number;
  /** The pointer left the surface: restart spacing at the next hit. */
  gap: boolean;
  grab: GrabPart[] | null;
  /** Grab: plane the pointer drags on (through the start point, facing the camera). */
  grabPlane: Plane | null;
  pointerId: number | null;
  /** DOM strokes: the pointer that drives it (touch strokes can be cancelled by a second finger). */
  pointer: StrokePointer | null;
  dabs: number;
  /** Vertices (welded) inside the brush over the whole stroke; grab: captured ones. */
  touched: number;
}

interface StrokePointer {
  type: string;
  /** performance.now() at pointerdown. */
  t0: number;
  x0: number;
  y0: number;
  /** Latest client position. */
  x: number;
  y: number;
  /** Largest distance from the start (px). */
  travel: number;
}

/**
 * A second finger landing this soon after the first one, or before the first
 * one moved this far, is a pinch / two-finger orbit, not a stroke: the dab is
 * reverted instead of committed.
 */
const TOUCH_CANCEL_MS = 300;
const TOUCH_CANCEL_PX = 12;

/**
 * Coarse meshes are refined to edges of at most REFINE_EDGE × the model's
 * bounding radius (half the default brush radius) when their longest edge
 * exceeds REFINE_TRIGGER × that.
 */
const REFINE_EDGE = DEFAULT_BRUSH.radius / 2;
const REFINE_TRIGGER = 1.5;

/** Hard cap on dabs per pointer sample (a jump across the model with a tiny brush). */
const MAX_DABS_PER_SAMPLE = 256;

const _v = new Vector3();
const _w = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _ray = new Ray();
const _m = new Matrix4();
const _ndc = new Vector2();
const _tri = new Triangle();
const _bary = new Vector3();
const _na = new Vector3();
const _nb = new Vector3();
const _nc = new Vector3();
const _box = new Box3();

/** True when `el` is a text field / select / editable, or inside a modal dialog. */
export function isEditableTarget(el: EventTarget | null): boolean {
  const e = el as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!e || typeof e !== 'object' || !('tagName' in e)) return false;
  const tag = String(e.tagName).toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable) return true;
  return typeof e.closest === 'function' && !!e.closest('[role="dialog"], dialog, [aria-modal="true"]');
}

function isVisible(obj: Object3D, root: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === root) break;
  }
  return true;
}

export class SculptSession {
  private readonly targets: Target[] = [];
  private readonly datas: SculptMesh[] = [];
  private readonly history: SculptHistory;
  private readonly scratch = new DabScratch();
  private readonly listeners = new Set<(e: SculptEvent) => void>();
  private readonly cursor = new BrushCursor();
  private readonly raycaster = new Raycaster();
  private readonly spacing: number;
  private readonly frontOnly: boolean;
  private readonly keyTarget: EventTarget | null;
  private readonly rootMatrix = new Matrix4();
  private readonly mirror = new Matrix4();
  private readonly mirrorN = new Matrix3();
  private modelRadius = 1;
  private medianEdge = 0;
  private refinedInfo: { before: number; after: number } | null = null;
  private readonly refine: boolean;
  private brush: BrushSettings;
  private stroke: Stroke | null = null;
  private count = 0;
  private active = false;
  private disposed = false;
  private hover: { x: number; y: number } | null = null;
  private hoverFrame = 0;
  private lastCursor: { point: Vector3; normal: Vector3 } | null = null;
  private savedCursorStyle: string | null = null;
  private listenEl: EventTarget | null = null;
  /** Re-dispatching a pointerdown for the viewer (ignored by our own listener). */
  private replaying = false;

  constructor(
    private readonly core: SculptHost,
    readonly root: Object3D,
    opts: SculptSessionOptions = {},
  ) {
    this.brush = sanitizeBrushSettings(opts.settings ?? {}, DEFAULT_BRUSH);
    this.history = new SculptHistory(opts.maxHistory, opts.maxHistoryBytes);
    this.spacing = Math.max(0.02, opts.spacing ?? 0.25);
    this.frontOnly = opts.frontOnly !== false;
    this.refine = opts.refine !== false;
    this.keyTarget = opts.keyTarget !== undefined ? opts.keyTarget : typeof window !== 'undefined' ? window : null;
    this.build();
  }

  // ---------------------------------------------------------------- setup

  private build(): void {
    const byGeometry = new Map<BufferGeometry, SculptMesh>();
    for (const d of this.datas) byGeometry.set(d.geometry, d);
    const kept = new Set<SculptMesh>();
    this.targets.length = 0;
    this.root.updateWorldMatrix(true, true);
    const meshes: Mesh[] = [];
    this.root.traverse((o) => {
      const m = o as Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean };
      if (!m.isMesh || m.isSkinnedMesh || m.isInstancedMesh || m.isBatchedMesh) return;
      if (!m.geometry || !isSculptable(m.geometry)) return;
      meshes.push(m);
    });
    // Size of the editable part (skinned / helper objects excluded). Refining
    // only adds points on the surface, so the bounds stay the same.
    const box = new Box3();
    for (const m of meshes) {
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      box.union(_box.copy(g.boundingBox!).applyMatrix4(m.matrixWorld));
    }
    this.modelRadius = box.isEmpty() ? 1 : Math.max(1e-6, box.getBoundingSphere(new Sphere()).radius);
    for (const m of meshes) {
      let data = byGeometry.get(m.geometry);
      if (!data) {
        if (this.refine) this.refineCoarse(m);
        data = new SculptMesh(m.geometry);
        byGeometry.set(m.geometry, data);
      }
      kept.add(data);
      this.targets.push({
        mesh: m,
        data,
        mw: new Matrix4(),
        inv: new Matrix4(),
        nT: new Matrix3(),
        nW: new Matrix3(),
        scale: 1,
        sphere: new Sphere(),
      });
    }
    for (const d of this.datas) if (!kept.has(d)) d.dispose();
    this.datas.length = 0;
    this.datas.push(...kept);
    this.updateTransforms();
    // Typical edge in world units (sampled per geometry, largest median wins).
    let median = 0;
    for (const t of this.targets) median = Math.max(median, edgeLengths(t.data.geometry, 6000).median * t.scale);
    this.medianEdge = median;
  }

  /**
   * Brushes only move existing vertices: split the edges of a coarse mesh
   * (an extrusion's flat caps, a low-poly GLB) so the default brush always
   * has points to move. Dense meshes are left as they are.
   */
  private refineCoarse(m: Mesh): void {
    const scale = Math.max(1e-12, m.matrixWorld.getMaxScaleOnAxis());
    const target = (REFINE_EDGE * this.modelRadius) / scale;
    if (edgeLengths(m.geometry).max <= REFINE_TRIGGER * target) return;
    const r = refineGeometry(m.geometry, { maxEdge: target });
    if (!r) return;
    const acc = this.refinedInfo ?? { before: 0, after: 0 };
    acc.before += r.trianglesBefore;
    acc.after += r.trianglesAfter;
    this.refinedInfo = acc;
  }

  /** Triangle counts before / after the coarse meshes were refined at session start (null: none was). */
  get refined(): { before: number; after: number } | null {
    return this.refinedInfo;
  }

  /** Median edge length of the edited meshes, world units (vs. worldRadius(): is the mesh too coarse for the brush?). */
  get medianEdgeLength(): number {
    return this.medianEdge;
  }

  /** Cache world transforms (the model does not move during a stroke). */
  private updateTransforms(): void {
    this.root.updateWorldMatrix(true, true);
    for (const t of this.targets) {
      t.mw.copy(t.mesh.matrixWorld);
      t.inv.copy(t.mw).invert();
      t.nT.setFromMatrix4(t.mw).transpose();
      t.nW.getNormalMatrix(t.mw);
      t.scale = Math.max(1e-12, t.mw.getMaxScaleOnAxis());
      const g = t.data.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      t.sphere.copy(g.boundingSphere!).applyMatrix4(t.mw);
    }
    // Reflection across the root's local x = 0 plane, in world space.
    this.rootMatrix.copy(this.root.matrixWorld);
    this.mirror
      .copy(this.rootMatrix)
      .multiply(_m.makeScale(-1, 1, 1))
      .multiply(_m.copy(this.rootMatrix).invert());
    this.mirrorN.setFromMatrix4(this.mirror).transpose(); // (M⁻¹)ᵀ = Mᵀ for an involution
  }

  /**
   * Rebuild after the geometry was swapped in place (e.g. the depth mesh was
   * re-meshed with new options): history no longer applies and is cleared.
   * Returns true when something changed.
   */
  syncGeometry(): boolean {
    const stale = this.targets.some((t) => t.mesh.geometry !== t.data.geometry);
    if (!stale) return false;
    this.endActiveStroke();
    this.build();
    this.history.clear();
    this.count = 0;
    this.emit({ type: 'edit', state: this.state });
    return true;
  }

  /** Number of editable meshes (0: nothing to sculpt, e.g. only skinned meshes). */
  get meshCount(): number {
    return this.targets.length;
  }

  /** The geometries being edited (one per shared geometry). */
  geometries(): BufferGeometry[] {
    return this.datas.map((d) => d.geometry);
  }

  /** Bounding-sphere radius of the model in world units (brush radius is a fraction of it). */
  get boundingRadius(): number {
    return this.modelRadius;
  }

  /** World radius of the brush. */
  worldRadius(): number {
    return this.brush.radius * this.modelRadius;
  }

  // ------------------------------------------------------------- settings

  get settings(): BrushSettings {
    return this.brush;
  }

  setSettings(patch: Partial<BrushSettings>): void {
    const next = sanitizeBrushSettings({ ...this.brush, ...patch }, this.brush);
    const k = Object.keys(next) as (keyof BrushSettings)[];
    if (k.every((key) => next[key] === this.brush[key])) return;
    this.brush = next;
    this.refreshCursor();
    this.emit({ type: 'settings', settings: next });
  }

  get state(): SculptState {
    return { active: this.active, canUndo: this.history.canUndo, canRedo: this.history.canRedo, strokes: this.count };
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  subscribe(fn: (e: SculptEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SculptEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  // -------------------------------------------------------------- picking

  /** Closest hit of a world ray on the editable meshes (BVH accelerated, both sides). */
  raycast(ray: Ray): SculptHit | null {
    if (this.disposed) return null;
    if (!this.stroke) this.syncGeometry();
    // Bounds are refreshed per stroke: leave room for growth during one.
    const margin = 0.1 * this.modelRadius + 2 * this.worldRadius();
    let best: SculptHit | null = null;
    for (const t of this.targets) {
      if (!isVisible(t.mesh, this.root)) continue;
      const reach = t.sphere.radius + margin;
      if (ray.distanceSqToPoint(t.sphere.center) > reach * reach) continue;
      _ray.copy(ray).applyMatrix4(t.inv);
      const hit = t.data.bvh.raycastFirst(_ray, DoubleSide);
      if (!hit || !hit.face) continue;
      const point = hit.point.clone().applyMatrix4(t.mw);
      const distance = point.distanceTo(ray.origin);
      if (best && distance >= best.distance) continue;
      // Interpolated vertex normal (robust to winding), in world space.
      const { a, b, c } = hit.face;
      const pos = t.data.pos, nrm = t.data.nrm;
      _tri.a.fromArray(pos, a * 3);
      _tri.b.fromArray(pos, b * 3);
      _tri.c.fromArray(pos, c * 3);
      const normal = new Vector3();
      if (_tri.getBarycoord(hit.point, _bary)) {
        _na.fromArray(nrm, a * 3).multiplyScalar(_bary.x);
        _nb.fromArray(nrm, b * 3).multiplyScalar(_bary.y);
        _nc.fromArray(nrm, c * 3).multiplyScalar(_bary.z);
        normal.copy(_na).add(_nb).add(_nc);
      }
      if (normal.lengthSq() < 1e-16) normal.copy(hit.face.normal);
      normal.applyMatrix3(t.nW).normalize();
      const backFacing = normal.dot(ray.direction) > 0;
      if (backFacing) normal.negate();
      best = { point, normal, backFacing, distance };
    }
    return best;
  }

  /** Hit under a client-space pointer position on the viewer canvas. */
  pickAt(clientX: number, clientY: number): SculptHit | null {
    const rect = this.core.canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    this.ndc(clientX, clientY, rect);
    this.raycaster.setFromCamera(_ndc, this.core.camera);
    return this.raycast(this.raycaster.ray);
  }

  private ndc(clientX: number, clientY: number, rect: DOMRect): Vector2 {
    return _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  // --------------------------------------------------------------- strokes

  /**
   * Start a stroke at a world point with the world surface normal facing
   * the viewer. The first dab is applied immediately (grab captures the
   * vertices under the brush instead). Returns false with nothing to edit.
   */
  beginStroke(point: Vector3, normal: Vector3, mods: StrokeModifiers = {}): boolean {
    if (this.disposed || this.targets.length === 0) return false;
    if (this.stroke) this.endStroke();
    this.syncGeometry();
    this.updateTransforms();
    const brush: BrushId = mods.smooth ? 'smooth' : this.brush.brush;
    const stroke: Stroke = {
      brush,
      invert: this.brush.invert !== !!mods.invert,
      pressure: clampPressure(mods.pressure),
      sideSign: mods.backFacing ? -1 : 1,
      last: point.clone(),
      lastNormal: normal.clone().normalize(),
      carry: 0,
      gap: false,
      grab: null,
      grabPlane: null,
      pointerId: null,
      pointer: null,
      dabs: 0,
      touched: 0,
    };
    this.stroke = stroke;
    this.lastDabMoved = 0;
    for (const d of this.datas) d.beginStroke();
    if (brush === 'grab') {
      stroke.grab = this.captureGrab(point, stroke.lastNormal, stroke.sideSign);
      for (const part of stroke.grab) stroke.touched += part.cap.groups.length;
      const toCamera = _v.copy(this.core.camera.position).sub(point);
      stroke.grabPlane = new Plane().setFromNormalAndCoplanarPoint(toCamera.lengthSq() > 0 ? toCamera.normalize() : stroke.lastNormal, point);
    } else {
      this.dab(point, stroke.lastNormal);
    }
    this.flush();
    return true;
  }

  /**
   * Continue the stroke to a new world sample: dabs every spacing × radius
   * along the path (grab: drags the captured vertices to `point`).
   * Returns the number of welded vertices moved.
   */
  strokeTo(point: Vector3, normal: Vector3, pressure?: number): number {
    const st = this.stroke;
    if (!st) return 0;
    if (pressure !== undefined) st.pressure = clampPressure(pressure);
    if (st.grab) return this.grabTo(point);
    const n = _n.copy(normal).normalize();
    let moved = 0;
    if (st.gap) {
      st.gap = false;
      st.carry = 0;
      moved += this.dab(point, n);
    } else {
      const step = Math.max(1e-9, this.worldRadius() * this.spacing);
      const total = st.last.distanceTo(point);
      let s = step - st.carry;
      let dabs = 0;
      let lastAt = -1;
      while (s <= total && dabs < MAX_DABS_PER_SAMPLE) {
        const f = total > 0 ? s / total : 1;
        _c.lerpVectors(st.last, point, f);
        _w.lerpVectors(st.lastNormal, n, f);
        if (_w.lengthSq() < 1e-12) _w.copy(n);
        moved += this.dab(_c, _w.normalize());
        lastAt = s;
        s += step;
        dabs++;
      }
      st.carry = dabs >= MAX_DABS_PER_SAMPLE ? 0 : lastAt >= 0 ? total - lastAt : st.carry + total;
    }
    st.last.copy(point);
    st.lastNormal.copy(n);
    this.flush();
    return moved;
  }

  /** The pointer left the surface: the next sample restarts spacing there (no dabs across the gap). */
  strokeGap(): void {
    if (this.stroke) this.stroke.gap = true;
  }

  /** Grab: move the captured vertices so the grab point follows `point` (world). */
  grabTo(point: Vector3): number {
    const st = this.stroke;
    if (!st?.grab) return 0;
    let moved = 0;
    for (const part of st.grab) {
      const from = _v.copy(st.last), to = _w.copy(point);
      if (part.mirrored) {
        from.applyMatrix4(this.mirror);
        to.applyMatrix4(this.mirror);
      }
      from.applyMatrix4(part.target.inv);
      to.applyMatrix4(part.target.inv);
      moved += applyGrab(part.cap, to.x - from.x, to.y - from.y, to.z - from.z);
    }
    st.last.copy(point);
    this.flush();
    return moved;
  }

  /** Finish the stroke: records it for undo. Returns true when the geometry changed. */
  endStroke(): boolean {
    const st = this.stroke;
    if (!st) return false;
    this.stroke = null;
    const deltas = [];
    for (const d of this.datas) {
      const delta = d.endStroke();
      if (delta) deltas.push(delta);
    }
    this.updateTransforms(); // bounding spheres grew / shrank
    this.core.invalidate();
    if (deltas.length === 0) {
      if ((st.dabs > 0 || st.grab) && st.touched === 0) this.emit({ type: 'empty-stroke' });
      return false;
    }
    this.core.refresh?.();
    this.history.push(SculptHistory.record(deltas, this.count, this.count + 1));
    this.count++;
    this.emit({ type: 'edit', state: this.state });
    return true;
  }

  /**
   * Abandon the stroke: its changes are reverted and nothing is recorded for
   * undo. Returns true when the geometry had changed.
   */
  cancelStroke(): boolean {
    const st = this.stroke;
    if (!st) return false;
    this.stroke = null;
    let changed = false;
    for (const d of this.datas) {
      const delta = d.endStroke();
      if (!delta) continue;
      d.applyDelta(delta, 'old');
      changed = true;
    }
    this.updateTransforms();
    if (changed) this.core.refresh?.();
    this.core.invalidate();
    return changed;
  }

  /** End a live stroke; a DOM stroke also releases its pointer and gives orbiting back. */
  private endActiveStroke(): void {
    if (!this.stroke) return;
    if (this.stroke.pointerId != null) this.finishPointerStroke();
    else this.endStroke();
  }

  /** A complete one-dab stroke at a world point (headless helper). Returns the vertices moved. */
  applyStrokeAt(point: Vector3, normal: Vector3, mods: StrokeModifiers = {}): number {
    if (!this.beginStroke(point, normal, mods)) return 0;
    const moved = this.lastDabMoved;
    this.endStroke();
    return moved;
  }

  private lastDabMoved = 0;

  /** One dab (plus its mirror) at a world point. */
  private dab(point: Vector3, normal: Vector3): number {
    const st = this.stroke!;
    let moved = this.dabAt(point, normal, st);
    if (this.brush.symmetryX) {
      const mp = _v.copy(point).applyMatrix4(this.mirror);
      if (mp.distanceToSquared(point) > (this.worldRadius() * 1e-3) ** 2) {
        const mn = new Vector3().copy(normal).applyMatrix3(this.mirrorN).normalize();
        moved += this.dabAt(mp.clone(), mn, st);
      }
    }
    st.dabs++;
    this.lastDabMoved = moved;
    return moved;
  }

  private dabAt(point: Vector3, normal: Vector3, st: Stroke): number {
    const b = this.brush;
    const rw = this.worldRadius();
    let moved = 0;
    for (const t of this.targets) {
      if (!isVisible(t.mesh, this.root)) continue;
      if (point.distanceTo(t.sphere.center) > t.sphere.radius + 2 * rw) continue;
      const center = new Vector3().copy(point).applyMatrix4(t.inv);
      const n = new Vector3().copy(normal).applyMatrix3(t.nT).normalize();
      moved += applyDab(
        t.data,
        {
          brush: st.brush as Exclude<BrushId, 'grab'>,
          center,
          normal: n,
          radius: rw / t.scale,
          strength: b.strength * st.pressure,
          invert: st.invert,
          falloff: b.falloff,
          lockBoundary: b.lockBoundary,
          frontOnly: this.frontOnly,
          sideSign: st.sideSign,
        },
        this.scratch,
      );
      st.touched += this.scratch.gathered.count;
    }
    return moved;
  }

  private captureGrab(point: Vector3, normal: Vector3, sideSign: 1 | -1): GrabPart[] {
    const b = this.brush;
    const rw = this.worldRadius();
    const strength = Math.min(1, Math.max(0.1, b.strength * 2));
    const parts: GrabPart[] = [];
    const run = (p: Vector3, n: Vector3, mirrored: boolean) => {
      for (const t of this.targets) {
        if (!isVisible(t.mesh, this.root)) continue;
        if (p.distanceTo(t.sphere.center) > t.sphere.radius + 2 * rw) continue;
        const exclude = mirrored ? (parts.find((q) => !q.mirrored && q.cap.mesh === t.data)?.cap ?? null) : null;
        const cap = captureGrab(t.data, {
          center: p.clone().applyMatrix4(t.inv),
          normal: n.clone().applyMatrix3(t.nT).normalize(),
          radius: rw / t.scale,
          falloff: b.falloff,
          lockBoundary: b.lockBoundary,
          strength,
          frontOnly: this.frontOnly,
          sideSign,
          exclude,
        });
        if (cap.groups.length > 0) parts.push({ target: t, cap, mirrored });
      }
    };
    run(point, normal, false);
    if (b.symmetryX) {
      const mp = point.clone().applyMatrix4(this.mirror);
      if (mp.distanceToSquared(point) > (rw * 1e-3) ** 2) run(mp, normal.clone().applyMatrix3(this.mirrorN).normalize(), true);
    }
    return parts;
  }

  private flush(): void {
    let changed = false;
    for (const d of this.datas) if (d.flush()) changed = true;
    if (changed) this.core.invalidate();
  }

  // ------------------------------------------------------------ history

  undo(): boolean {
    this.endActiveStroke();
    const rec = this.history.undo();
    if (!rec) return false;
    this.count = rec.countBefore;
    this.afterHistory();
    return true;
  }

  redo(): boolean {
    this.endActiveStroke();
    const rec = this.history.redo();
    if (!rec) return false;
    this.count = rec.countAfter;
    this.afterHistory();
    return true;
  }

  /** Back to the geometry at session start (undoable). Returns false when already there. */
  reset(): boolean {
    this.endActiveStroke();
    const deltas = [];
    for (const d of this.datas) {
      const delta = d.diffToOriginal();
      if (!delta) continue;
      d.applyDelta(delta, 'new');
      deltas.push(delta);
    }
    if (deltas.length === 0) return false;
    this.history.push(SculptHistory.record(deltas, this.count, 0));
    this.count = 0;
    this.afterHistory();
    return true;
  }

  private afterHistory(): void {
    this.updateTransforms();
    this.core.refresh?.();
    this.core.invalidate();
    this.emit({ type: 'edit', state: this.state });
  }

  // ------------------------------------------------------------ DOM input

  /** Attach / detach pointer + keyboard handling and the cursor (sculpt mode on / off). */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    const canvas = this.core.canvas;
    if (active) {
      // Capture phase on the canvas' parent: runs before OrbitControls'
      // pointerdown on the canvas, so a stroke can keep it from orbiting.
      this.listenEl = canvas.parentElement ?? canvas;
      this.listenEl.addEventListener('pointerdown', this.onPointerDown as EventListener, { capture: true });
      canvas.addEventListener('pointermove', this.onPointerMove);
      canvas.addEventListener('pointerup', this.onPointerUp);
      canvas.addEventListener('pointercancel', this.onPointerUp);
      canvas.addEventListener('lostpointercapture', this.onLostCapture);
      canvas.addEventListener('pointerleave', this.onPointerLeave);
      this.keyTarget?.addEventListener('keydown', this.onKeyDown as EventListener);
      this.keyTarget?.addEventListener('blur', this.onBlur);
      this.core.addOverlay(this.cursor.object);
      this.savedCursorStyle = canvas.style.cursor;
    } else {
      if (this.stroke) this.finishPointerStroke();
      this.listenEl?.removeEventListener('pointerdown', this.onPointerDown as EventListener, { capture: true });
      this.listenEl = null;
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointercancel', this.onPointerUp);
      canvas.removeEventListener('lostpointercapture', this.onLostCapture);
      canvas.removeEventListener('pointerleave', this.onPointerLeave);
      this.keyTarget?.removeEventListener('keydown', this.onKeyDown as EventListener);
      this.keyTarget?.removeEventListener('blur', this.onBlur);
      this.cancelHover();
      this.cursor.hide();
      this.lastCursor = null;
      this.core.removeOverlay(this.cursor.object);
      if (this.savedCursorStyle !== null) canvas.style.cursor = this.savedCursorStyle;
      this.savedCursorStyle = null;
      this.core.setOrbitEnabled(true);
      this.core.invalidate();
    }
    this.emit({ type: 'state', state: this.state });
  }

  get isActive(): boolean {
    return this.active;
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.active || this.replaying) return;
    const st = this.stroke;
    if (st) {
      if (e.pointerId === st.pointerId) return;
      // A second finger / pointer: let the viewer handle the gesture. A
      // touch stroke that has barely started was the first finger of a
      // pinch: revert it and hand that finger to the viewer as well.
      const p = st.pointer;
      const id = st.pointerId;
      if (p && id !== null && p.type === 'touch' && e.pointerType === 'touch' && (now() - p.t0 < TOUCH_CANCEL_MS || p.travel < TOUCH_CANCEL_PX)) {
        this.finishPointerStroke(true);
        this.replayPointerDown(id, p);
      } else this.finishPointerStroke();
      return;
    }
    if (e.button !== 0 || !e.isPrimary) return;
    const hit = this.pickAt(e.clientX, e.clientY);
    if (!hit) return; // empty space: orbit
    e.preventDefault();
    e.stopPropagation();
    const canvas = this.core.canvas;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events / detached canvas
    }
    this.core.setOrbitEnabled(false);
    this.cancelHover();
    // A pen touching down with no pressure reading starts light (the next sample sets it).
    const pressure = pressureOf(e) ?? MIN_PRESSURE;
    if (!this.beginStroke(hit.point, hit.normal, { invert: e.ctrlKey || e.metaKey, smooth: e.shiftKey, pressure, backFacing: hit.backFacing })) {
      this.core.setOrbitEnabled(true);
      return;
    }
    this.stroke!.pointerId = e.pointerId;
    this.stroke!.pointer = { type: e.pointerType, t0: now(), x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, travel: 0 };
    this.showCursor(hit.point, hit.normal);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.active) return;
    const st = this.stroke;
    if (!st) {
      this.scheduleHover(e.clientX, e.clientY);
      return;
    }
    if (e.pointerId !== st.pointerId) return;
    const p = st.pointer;
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
      p.travel = Math.max(p.travel, Math.hypot(e.clientX - p.x0, e.clientY - p.y0));
    }
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = samples.length > 0 ? samples.slice(-8) : [e];
    const rect = this.core.canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    for (const ev of list) {
      if (st.grab) {
        this.ndc(ev.clientX, ev.clientY, rect);
        this.raycaster.setFromCamera(_ndc, this.core.camera);
        const p = this.raycaster.ray.intersectPlane(st.grabPlane!, new Vector3());
        if (p) {
          this.grabTo(p);
          this.showCursor(p, st.lastNormal);
        }
        continue;
      }
      const hit = this.pickAt(ev.clientX, ev.clientY);
      if (!hit) {
        this.strokeGap();
        this.cursor.hide();
        continue;
      }
      this.strokeTo(hit.point, hit.normal, pressureOf(ev));
      this.showCursor(hit.point, hit.normal);
    }
    this.core.invalidate();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      this.finishPointerStroke();
      this.scheduleHover(e.clientX, e.clientY);
    }
  };

  private readonly onLostCapture = (e: PointerEvent) => {
    if (this.stroke && e.pointerId === this.stroke.pointerId) this.finishPointerStroke();
  };

  private readonly onPointerLeave = () => {
    if (this.stroke) return;
    this.cancelHover();
    this.hideCursor();
  };

  private readonly onBlur = () => {
    if (this.stroke) this.finishPointerStroke();
  };

  /** End (or with `cancel`, revert) the pointer's stroke, release the pointer and give orbiting back. */
  private finishPointerStroke(cancel = false): void {
    const id = this.stroke?.pointerId;
    if (cancel) this.cancelStroke();
    else this.endStroke();
    if (id !== null && id !== undefined) {
      try {
        if (this.core.canvas.hasPointerCapture?.(id)) this.core.canvas.releasePointerCapture(id);
      } catch {
        // already released
      }
    }
    this.core.setOrbitEnabled(true);
  }

  /**
   * Re-send the first finger's pointerdown to the canvas (the viewer's
   * controls never saw it), so a pinch / two-finger orbit gets both fingers.
   */
  private replayPointerDown(pointerId: number, p: StrokePointer): void {
    if (typeof PointerEvent !== 'function') return;
    const ev = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: p.type,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: p.x,
      clientY: p.y,
    });
    this.replaying = true;
    try {
      this.core.canvas.dispatchEvent(ev);
    } finally {
      this.replaying = false;
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.active || e.defaultPrevented || e.altKey || isEditableTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const code = e.code;
    if (mod) {
      if (key === 'z' || key === 'Z' || code === 'KeyZ') {
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if ((key === 'y' || key === 'Y' || code === 'KeyY') && !e.shiftKey) this.redo();
      else return;
      e.preventDefault();
      return;
    }
    const digit = /^[1-8]$/.test(key) ? Number(key) : /^Digit[1-8]$/.test(code) && !e.shiftKey ? Number(code.slice(5)) : 0;
    if (digit > 0) this.setSettings({ brush: BRUSH_IDS[digit - 1] });
    else if (key === '[' || key === '{' || code === 'BracketLeft') {
      if (e.shiftKey) this.setSettings({ strength: stepStrength(this.brush.strength, -1) });
      else this.setSettings({ radius: stepRadius(this.brush.radius, -1) });
    } else if (key === ']' || key === '}' || code === 'BracketRight') {
      if (e.shiftKey) this.setSettings({ strength: stepStrength(this.brush.strength, 1) });
      else this.setSettings({ radius: stepRadius(this.brush.radius, 1) });
    } else if (key === 'x' || key === 'X' || code === 'KeyX') this.setSettings({ symmetryX: !this.brush.symmetryX });
    else return;
    e.preventDefault();
  };

  // --------------------------------------------------------------- cursor

  private scheduleHover(x: number, y: number): void {
    this.hover = { x, y };
    if (this.hoverFrame) return;
    const run = () => {
      this.hoverFrame = 0;
      const h = this.hover;
      this.hover = null;
      if (!h || !this.active || this.stroke) return;
      const hit = this.pickAt(h.x, h.y);
      if (hit) this.showCursor(hit.point, hit.normal);
      else this.hideCursor();
    };
    if (typeof requestAnimationFrame === 'function') this.hoverFrame = requestAnimationFrame(run);
    else run();
  }

  private cancelHover(): void {
    if (this.hoverFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hover = null;
  }

  private tone(): CursorTone {
    const brush = this.stroke?.brush ?? this.brush.brush;
    if (brush === 'smooth') return 'smooth';
    if (brush === 'grab') return 'grab';
    return (this.stroke?.invert ?? this.brush.invert) ? 'invert' : 'normal';
  }

  private showCursor(point: Vector3, normal: Vector3): void {
    if (!this.active) return;
    this.lastCursor = { point: point.clone(), normal: normal.clone() };
    this.refreshCursor();
    this.core.canvas.style.cursor = 'crosshair';
  }

  private hideCursor(): void {
    this.lastCursor = null;
    if (this.cursor.visible) {
      this.cursor.hide();
      this.core.invalidate();
    }
    if (this.savedCursorStyle !== null) this.core.canvas.style.cursor = this.savedCursorStyle;
  }

  private refreshCursor(): void {
    const c = this.lastCursor;
    if (!this.active || !c) return;
    this.cursor.setTone(this.tone());
    const mirror = this.brush.symmetryX
      ? { point: c.point.clone().applyMatrix4(this.mirror), normal: c.normal.clone().applyMatrix3(this.mirrorN).normalize() }
      : null;
    this.cursor.show(c.point, c.normal, this.worldRadius(), mirror);
    this.core.invalidate();
  }

  // -------------------------------------------------------------- dispose

  /** Remove listeners and overlays, release the BVHs; the edited geometry stays. */
  dispose(): void {
    if (this.disposed) return;
    this.setActive(false);
    if (this.stroke) this.endStroke();
    this.disposed = true;
    this.cursor.dispose();
    for (const d of this.datas) d.dispose();
    this.datas.length = 0;
    this.targets.length = 0;
    this.history.clear();
    this.listeners.clear();
  }

  /** The viewer the session is bound to. */
  get host(): SculptHost {
    return this.core;
  }

  /** False once an edited mesh left the model (e.g. swapped for a rigged one): the session must be rebuilt. */
  get attached(): boolean {
    if (this.disposed) return false;
    return this.targets.every((t) => {
      for (let o: Object3D | null = t.mesh; o; o = o.parent) if (o === this.root) return true;
      return false;
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

const MIN_PRESSURE = 0.05;

function clampPressure(p: number | undefined): number {
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(MIN_PRESSURE, p)) : 1;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Pen pressure when the device reports it; mice (0.5 while pressed) and most
 * touch screens count as full. A pen sample reporting 0 (a driver quirk at
 * contact start / end or a very light touch) gives undefined: keep the
 * stroke's current pressure rather than jumping to full strength.
 */
export function pressureOf(e: Pick<PointerEvent, 'pointerType' | 'pressure'>): number | undefined {
  if (e.pointerType !== 'pen') return 1;
  return e.pressure > 0 ? e.pressure : undefined;
}
