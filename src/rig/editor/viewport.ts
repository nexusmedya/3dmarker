/**
 * The rig editor in the 3D view (browser only): bone display, picking, the
 * TransformControls gizmo, IK handles and the weight brush.
 *
 *  - Edit mode: the mesh is in its rest pose; joints (heads) and bone ends
 *    (tails of leaf / selected bones) are markers; the gizmo translates the
 *    selected one. On release the move is reported in the root frame,
 *    optionally snapped to the mesh interior (midpoint of the entry / exit
 *    hits of the view ray through it). "Add bone" arms a click on the mesh:
 *    the interior point under the cursor becomes the new bone's tail.
 *  - Pose mode: the gizmo rotates the selected bone (the root may also be
 *    translated); with symmetry the mirror bone gets the mirrored rotation.
 *    Limbs (roles leg / arm, index 1–3) get an IK target (cube) at the
 *    hand / foot and a pole (sphere): dragging them solves two-bone IK.
 *  - Paint mode: strokes on the mesh (three-mesh-bvh ray casts against the
 *    rest surface) paint the selected bone's weights (./weightPaint.ts),
 *    written straight into the skinned meshes; the heat map shows them.
 *
 * Every committed change goes to the callbacks (the panel records undo and
 * applies spec changes through the RigHandle); the viewport never changes
 * the skeleton spec itself.
 */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, Object3D,
  Quaternion, Ray, Raycaster, RingGeometry, SphereGeometry, Vector2, Vector3,
} from 'three';
import type { Camera, SkinnedMesh } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { RigHandle } from '../rig';
import { findMirrorBone, leftAxis, mirrorPoint, specSize, vec } from '../spec';
import type { BoneSpec, SkeletonSpec, Vec3 } from '../types';
import { HeatOverlay } from './heatmap';
import { applyWorldDelta, defaultPole, twoBoneIKRotations } from './ik';
import { mirrorQuat, samplePose, type ClipDoc, type PoseSnapshot, type Q4 } from './keyframes';
import type { JointEnd } from './ops';
import { heat, WeightPainter, type BrushMode, type Falloff, type WeightDiff } from './weightPaint';

export type EditorMode = 'edit' | 'pose' | 'paint';

export interface EditorViewportHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  setOrbitEnabled(enabled: boolean): void;
  addOverlay(obj: Object3D): void;
  removeOverlay(obj: Object3D): void;
  invalidate(): void;
}

export interface ViewportCallbacks {
  onSelect(bone: string | null, end: JointEnd): void;
  /** A joint was dragged (rest pose, root frame; snapped when snapping is on). */
  onJointMoved(bone: string, end: JointEnd, pos: Vec3): void;
  /** A pose drag (rotate / IK / root move) ended. */
  onPoseEdited(before: PoseSnapshot, after: PoseSnapshot, label: string): void;
  /** "Add bone" click on the mesh: the interior point (root frame). */
  onAddAt(pos: Vec3): void;
  /** A weight stroke ended (its diff; the painter already holds the result). */
  onStroke(diff: WeightDiff): void;
}

export interface BrushSettings {
  mode: BrushMode;
  /** Fraction of the skeleton size. */
  radius: number;
  strength: number;
  falloff: Falloff;
  value: number;
}

export interface IkChain {
  key: string;
  upper: string;
  lower: string;
  end: string;
  /** Preferred bend direction when the limb is straight (root frame). */
  fallback: Vector3;
}

/** IK-capable limbs of a skeleton (roles leg / arm with indices 1, 2, 3 chained). */
export function ikChains(spec: SkeletonSpec): IkChain[] {
  const f = vec(spec.frame.forward).normalize();
  const groups = new Map<string, Map<number, BoneSpec>>();
  for (const b of spec.bones) {
    const r = b.role;
    if (!r || (r.part !== 'leg' && r.part !== 'arm') || r.index === undefined || !r.side) continue;
    const key = `${r.part}-${r.limb ?? ''}-${r.side}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key)!.set(r.index, b);
  }
  const out: IkChain[] = [];
  for (const [key, g] of groups) {
    const u = g.get(1), l = g.get(2), e = g.get(3);
    if (!u || !l || !e || l.parent !== u.name || e.parent !== l.name) continue;
    const backwards = key.startsWith('arm') || key.includes('-front-');
    out.push({ key, upper: u.name, lower: l.name, end: e.name, fallback: backwards ? f.clone().negate() : f.clone() });
  }
  return out;
}

type Pick =
  | { kind: 'joint'; bone: string; end: JointEnd }
  | { kind: 'ik'; chain: string; what: 'target' | 'pole' };

const COLORS = { bone: 0x7c5cff, selected: 0xfbbf24, tail: 0x38bdf8, ik: 0x22c55e, pole: 0xf472b6, line: 0xc4b5fd };

export class RigEditorViewport {
  private readonly group = new Group();
  private readonly markers = new Map<string, Mesh>();
  private readonly ikMarkers = new Map<string, Mesh>();
  private readonly lines: LineSegments;
  private readonly sphere: SphereGeometry;
  private readonly cube: BoxGeometry;
  private readonly ring: Mesh;
  private readonly mats = {
    joint: new MeshBasicMaterial({ color: COLORS.bone, depthTest: false, transparent: true, opacity: 0.95 }),
    tail: new MeshBasicMaterial({ color: COLORS.tail, depthTest: false, transparent: true, opacity: 0.9 }),
    selected: new MeshBasicMaterial({ color: COLORS.selected, depthTest: false }),
    ik: new MeshBasicMaterial({ color: COLORS.ik, depthTest: false }),
    pole: new MeshBasicMaterial({ color: COLORS.pole, depthTest: false }),
    line: new LineBasicMaterial({ color: COLORS.line, depthTest: false, transparent: true, opacity: 0.9 }),
    ring: new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8, side: DoubleSide }),
  };
  private readonly proxy = new Object3D();
  private tc: TransformControls | null = null;
  private readonly raycaster = new Raycaster();
  private bvh: MeshBVH | null = null;
  private painterObj: WeightPainter | null = null;
  private readonly heatOverlay: HeatOverlay;
  private readonly poles = new Map<string, Vector3>();
  private sel: Pick | null = null;
  private modeValue: EditorMode = 'edit';
  private addArmed = false;
  private dragBefore: PoseSnapshot | null = null;
  private stroke: { pointerId: number; last: Vector3 | null } | null = null;
  private disposed = false;
  private markerSize = 0.01;
  /** The canvas' touch-action before the gizmo took it over (restored on dispose). */
  private readonly touchAction: string;
  symmetry = true;
  snap = true;
  heatVisible = true;
  brush: BrushSettings = { mode: 'add', radius: 0.06, strength: 0.4, falloff: 'smooth', value: 1 };
  /** Rotate / translate for the pose gizmo ('translate' only moves the root). */
  poseGizmo: 'rotate' | 'translate' = 'rotate';

  constructor(
    private readonly host: EditorViewportHost,
    private readonly handle: RigHandle,
    private readonly cb: ViewportCallbacks,
  ) {
    this.group.name = 'rig-editor';
    this.group.renderOrder = 999;
    this.sphere = new SphereGeometry(1, 12, 8);
    this.cube = new BoxGeometry(1.6, 1.6, 1.6);
    this.lines = new LineSegments(new BufferGeometry(), this.mats.line);
    this.lines.renderOrder = 998;
    this.lines.frustumCulled = false;
    this.ring = new Mesh(new RingGeometry(0.92, 1, 48), this.mats.ring);
    this.ring.visible = false;
    this.ring.renderOrder = 1000;
    this.group.add(this.lines, this.ring, this.proxy);
    this.heatOverlay = new HeatOverlay(handle.meshes as SkinnedMesh[]);
    host.addOverlay(this.group);
    // The gizmo disables touch scrolling on the canvas while editing (and would reset it to '' afterwards).
    this.touchAction = host.canvas.style.touchAction;
    try {
      const tc = new TransformControls(host.camera, host.canvas);
      tc.setSize(0.8);
      tc.addEventListener('dragging-changed', (e) => {
        const dragging = (e as unknown as { value: boolean }).value;
        host.setOrbitEnabled(!dragging);
        if (dragging) this.dragStart();
        else this.dragEnd();
      });
      tc.addEventListener('objectChange', () => this.gizmoChanged());
      tc.addEventListener('change', () => host.invalidate());
      const helper = tc.getHelper();
      helper.name = 'rig-editor-gizmo';
      this.group.add(helper);
      this.tc = tc;
    } catch (e) {
      console.warn('[rig editor] transform gizmo unavailable', e);
    }
    const c = host.canvas;
    c.addEventListener('pointerdown', this.onDown, { capture: true });
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    this.refresh();
  }

  // ---- state ------------------------------------------------------------------

  get mode(): EditorMode {
    return this.modeValue;
  }

  get selection(): Pick | null {
    return this.sel;
  }

  get selectedBone(): string | null {
    return this.sel?.kind === 'joint' ? this.sel.bone : null;
  }

  get painter(): WeightPainter {
    if (!this.painterObj) {
      const spec = this.handle.spec;
      this.painterObj = new WeightPainter(this.handle.surface.positions, this.handle.surface.index, this.handle.weights, this.parentIndices(spec));
    }
    return this.painterObj;
  }

  private parentIndices(spec: SkeletonSpec): Int32Array {
    const idx = new Map(spec.bones.map((b, i) => [b.name, i]));
    return Int32Array.from(spec.bones.map((b) => (b.parent !== null ? idx.get(b.parent) ?? -1 : -1)));
  }

  setMode(m: EditorMode): void {
    if (this.disposed) return;
    const prev = this.modeValue;
    this.modeValue = m;
    this.addArmed = false;
    if (m !== 'pose') this.handle.restPose();
    if (m === 'pose' && prev !== 'pose') this.poles.clear();
    if (m === 'paint') this.showHeat();
    else this.heatOverlay.hide();
    this.ring.visible = false;
    if (this.sel?.kind === 'ik' && m !== 'pose') this.sel = null;
    this.rebuildMarkers();
    this.attachGizmo();
  }

  select(bone: string | null, end: JointEnd = 'head'): void {
    this.sel = bone ? { kind: 'joint', bone, end } : null;
    this.colorMarkers();
    this.attachGizmo();
    if (this.modeValue === 'paint') this.showHeat();
    this.cb.onSelect(bone, end);
  }

  armAddBone(on: boolean): void {
    this.addArmed = on;
    this.host.canvas.style.cursor = on ? 'crosshair' : '';
  }

  get addBoneArmed(): boolean {
    return this.addArmed;
  }

  /** After the skeleton or the weights changed (spec edit, re-weight, undo). */
  refresh(): void {
    if (this.disposed) return;
    const spec = this.handle.spec;
    if (this.sel?.kind === 'joint' && !spec.bones.some((b) => b.name === (this.sel as { bone: string }).bone)) this.sel = null;
    if (this.painterObj) {
      this.painterObj.load(this.handle.weights);
      this.painterObj.parents = this.parentIndices(spec);
    }
    this.rebuildMarkers();
    this.attachGizmo();
    if (this.modeValue === 'paint') this.showHeat();
  }

  // ---- display ------------------------------------------------------------------

  private rootMatrix(): Matrix4 {
    this.handle.root.updateWorldMatrix(true, false);
    return this.handle.root.matrixWorld;
  }

  /** World position of a bone's head / tail in the current pose. */
  jointWorld(bone: string, end: JointEnd, out = new Vector3()): Vector3 {
    const b = this.handle.bones.get(bone);
    const s = this.handle.spec.bones.find((x) => x.name === bone);
    if (!b || !s) return out.set(0, 0, 0);
    b.updateWorldMatrix(true, false);
    if (end === 'head') return out.setFromMatrixPosition(b.matrixWorld);
    return out.set(s.tail.x - s.head.x, s.tail.y - s.head.y, s.tail.z - s.head.z).applyMatrix4(b.matrixWorld);
  }

  private toLocal(world: Vector3): Vec3 {
    const p = world.clone().applyMatrix4(this.rootMatrix().clone().invert());
    return { x: p.x, y: p.y, z: p.z };
  }

  private toWorld(local: Vec3): Vector3 {
    return vec(local).applyMatrix4(this.rootMatrix());
  }

  private rebuildMarkers(): void {
    for (const m of [...this.markers.values(), ...this.ikMarkers.values()]) this.group.remove(m);
    this.markers.clear();
    this.ikMarkers.clear();
    const spec = this.handle.spec;
    const size = specSize(spec) * this.rootMatrix().getMaxScaleOnAxis();
    this.markerSize = 0.011 * size;
    const kids = new Set(spec.bones.map((b) => b.parent));
    for (const b of spec.bones) {
      const m = new Mesh(this.sphere, this.mats.joint);
      m.renderOrder = 999;
      m.scale.setScalar(this.markerSize);
      m.userData.pick = { kind: 'joint', bone: b.name, end: 'head' } satisfies Pick;
      this.markers.set(`${b.name}|head`, m);
      this.group.add(m);
      // Tails of leaves (edit mode) can be grabbed too.
      if (this.modeValue === 'edit' && !kids.has(b.name)) {
        const t = new Mesh(this.sphere, this.mats.tail);
        t.renderOrder = 999;
        t.scale.setScalar(this.markerSize * 0.7);
        t.userData.pick = { kind: 'joint', bone: b.name, end: 'tail' } satisfies Pick;
        this.markers.set(`${b.name}|tail`, t);
        this.group.add(t);
      }
    }
    if (this.modeValue === 'pose') {
      for (const ch of ikChains(spec)) {
        const t = new Mesh(this.cube, this.mats.ik);
        t.renderOrder = 1000;
        t.scale.setScalar(this.markerSize);
        t.userData.pick = { kind: 'ik', chain: ch.key, what: 'target' } satisfies Pick;
        this.ikMarkers.set(`${ch.key}|target`, t);
        const p = new Mesh(this.sphere, this.mats.pole);
        p.renderOrder = 1000;
        p.scale.setScalar(this.markerSize * 0.8);
        p.userData.pick = { kind: 'ik', chain: ch.key, what: 'pole' } satisfies Pick;
        this.ikMarkers.set(`${ch.key}|pole`, p);
        this.group.add(t, p);
      }
    }
    this.sync();
    this.colorMarkers();
  }

  private colorMarkers(): void {
    for (const [k, m] of this.markers) {
      const [bone, end] = k.split('|');
      const on = this.sel?.kind === 'joint' && this.sel.bone === bone && (this.sel.end === end || end === 'head');
      m.material = on ? this.mats.selected : end === 'tail' ? this.mats.tail : this.mats.joint;
    }
    for (const [k, m] of this.ikMarkers) {
      const [chain, what] = k.split('|');
      const on = this.sel?.kind === 'ik' && this.sel.chain === chain && this.sel.what === what;
      m.material = on ? this.mats.selected : what === 'pole' ? this.mats.pole : this.mats.ik;
    }
    this.host.invalidate();
  }

  /** Move markers / bone lines / IK handles to the current pose. */
  sync(): void {
    const spec = this.handle.spec;
    const pos = new Float32Array(spec.bones.length * 6);
    const h = new Vector3(), t = new Vector3();
    spec.bones.forEach((b, i) => {
      this.jointWorld(b.name, 'head', h);
      this.jointWorld(b.name, 'tail', t);
      h.toArray(pos, i * 6);
      t.toArray(pos, i * 6 + 3);
      this.markers.get(`${b.name}|head`)?.position.copy(h);
      this.markers.get(`${b.name}|tail`)?.position.copy(t);
    });
    const prev = this.lines.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (prev && prev.array.length === pos.length) {
      (prev.array as Float32Array).set(pos);
      prev.needsUpdate = true;
    } else {
      // A new size (bones added / deleted): a fresh geometry, so the old GPU buffer is freed.
      const old = this.lines.geometry;
      this.lines.geometry = new BufferGeometry();
      this.lines.geometry.setAttribute('position', new BufferAttribute(pos, 3));
      old.dispose();
    }
    if (this.modeValue === 'pose') {
      for (const ch of ikChains(spec)) {
        const target = this.ikMarkers.get(`${ch.key}|target`);
        const dragging = this.tc?.dragging && this.sel?.kind === 'ik' && this.sel.chain === ch.key;
        if (target && !(dragging && this.sel?.kind === 'ik' && this.sel.what === 'target')) this.jointWorld(ch.end, 'head', target.position);
        const pole = this.ikMarkers.get(`${ch.key}|pole`);
        if (pole) pole.position.copy(this.poleOf(ch));
      }
    }
    this.host.invalidate();
  }

  private poleOf(ch: IkChain): Vector3 {
    let p = this.poles.get(ch.key);
    if (!p) {
      const a = this.jointWorld(ch.upper, 'head'), b = this.jointWorld(ch.lower, 'head'), c = this.jointWorld(ch.end, 'head');
      const fb = ch.fallback.clone().transformDirection(this.rootMatrix());
      p = defaultPole(a, b, c, fb);
      this.poles.set(ch.key, p);
    }
    return p;
  }

  // ---- gizmo ----------------------------------------------------------------------

  private attachGizmo(): void {
    const tc = this.tc;
    if (!tc) return;
    const s = this.sel;
    if (!s || this.modeValue === 'paint' || (this.modeValue === 'edit' && s.kind !== 'joint')) {
      tc.detach();
      this.host.invalidate();
      return;
    }
    if (s.kind === 'ik') {
      const m = this.ikMarkers.get(`${s.chain}|${s.what}`);
      if (!m) return void tc.detach();
      this.proxy.position.copy(m.position);
      this.proxy.quaternion.identity();
      tc.setMode('translate');
      tc.setSpace('world');
    } else if (this.modeValue === 'edit') {
      this.jointWorld(s.bone, s.end, this.proxy.position);
      this.proxy.quaternion.identity();
      tc.setMode('translate');
      tc.setSpace('world');
    } else {
      const b = this.handle.bones.get(s.bone);
      if (!b) return void tc.detach();
      this.jointWorld(s.bone, 'head', this.proxy.position);
      b.getWorldQuaternion(this.proxy.quaternion);
      const isRoot = this.handle.spec.bones.find((x) => x.name === s.bone)?.parent === null;
      tc.setMode(this.poseGizmo === 'translate' && isRoot ? 'translate' : 'rotate');
      tc.setSpace(this.poseGizmo === 'translate' ? 'world' : 'local');
    }
    this.proxy.updateMatrixWorld(true);
    tc.attach(this.proxy);
    this.host.invalidate();
  }

  private dragStart(): void {
    if (this.modeValue === 'pose') this.dragBefore = this.capturePose();
  }

  private gizmoChanged(): void {
    const s = this.sel;
    if (!s) return;
    const spec = this.handle.spec;
    if (this.modeValue === 'edit' && s.kind === 'joint') {
      this.markers.get(`${s.bone}|${s.end}`)?.position.copy(this.proxy.position);
      if (this.symmetry) {
        const twin = findMirrorBone(spec, s.bone);
        const m = twin && this.markers.get(`${twin}|${s.end}`);
        if (m) m.position.copy(this.toWorld(mirrorPoint(spec, this.toLocal(this.proxy.position))));
      }
      this.host.invalidate();
      return;
    }
    if (this.modeValue !== 'pose') return;
    if (s.kind === 'ik') {
      const ch = ikChains(spec).find((c) => c.key === s.chain);
      if (!ch) return;
      if (s.what === 'pole') this.poles.set(ch.key, this.proxy.position.clone());
      const target = s.what === 'target' ? this.proxy.position.clone() : this.jointWorld(ch.end, 'head');
      this.solveIk(ch, target);
      if (this.symmetry) {
        const twin = ikChains(spec).find((c) => c.upper === findMirrorBone(spec, ch.upper));
        if (twin && twin !== ch) {
          const mt = this.toWorld(mirrorPoint(spec, this.toLocal(target)));
          if (s.what === 'pole') this.poles.set(twin.key, this.toWorld(mirrorPoint(spec, this.toLocal(this.proxy.position))));
          this.solveIk(twin, mt);
        }
      }
      this.sync();
      return;
    }
    const b = this.handle.bones.get(s.bone);
    if (!b) return;
    if (this.tc?.mode === 'translate') {
      const parent = b.parent!;
      parent.updateWorldMatrix(true, false);
      b.position.copy(parent.worldToLocal(this.proxy.position.clone()));
    } else {
      const pw = new Quaternion();
      b.parent?.getWorldQuaternion(pw);
      b.quaternion.copy(pw.invert().multiply(this.proxy.quaternion)).normalize();
      if (this.symmetry) {
        const twin = findMirrorBone(spec, s.bone);
        const tb = twin ? this.handle.bones.get(twin) : null;
        if (tb) tb.quaternion.fromArray(mirrorQuat(b.quaternion.toArray() as Q4, leftAxis(spec)));
      }
    }
    this.handle.root.updateMatrixWorld(true);
    this.sync();
  }

  private dragEnd(): void {
    const s = this.sel;
    if (!s) return;
    if (this.modeValue === 'edit' && s.kind === 'joint') {
      let p = this.toLocal(this.proxy.position);
      if (this.snap) p = this.snapInterior(p) ?? p;
      this.cb.onJointMoved(s.bone, s.end, p);
      return;
    }
    if (this.modeValue === 'pose' && this.dragBefore) {
      const before = this.dragBefore;
      this.dragBefore = null;
      const label = s.kind === 'ik' ? `IK ${s.chain}` : s.bone;
      this.cb.onPoseEdited(before, this.capturePose(), label);
    }
  }

  /** Solve a limb so its end reaches `target` (world), bending towards its pole. */
  solveIk(ch: IkChain, target: Vector3): void {
    const up = this.handle.bones.get(ch.upper), lo = this.handle.bones.get(ch.lower);
    if (!up || !lo) return;
    this.handle.root.updateMatrixWorld(true);
    const a = this.jointWorld(ch.upper, 'head'), b = this.jointWorld(ch.lower, 'head'), c = this.jointWorld(ch.end, 'head');
    const r = twoBoneIKRotations(a, b, c, target, this.poleOf(ch));
    const P1 = new Quaternion(), W1 = new Quaternion(), W2 = new Quaternion();
    up.parent?.getWorldQuaternion(P1);
    up.getWorldQuaternion(W1);
    lo.getWorldQuaternion(W2);
    up.quaternion.copy(applyWorldDelta(P1, up.quaternion, r.upper));
    const W1n = r.upper.clone().multiply(W1);
    lo.quaternion.copy(W1n.invert().multiply(r.lower.clone().multiply(W2)).normalize());
    this.handle.root.updateMatrixWorld(true);
  }

  // ---- ray casts ----------------------------------------------------------------------

  private get meshBvh(): MeshBVH {
    if (!this.bvh) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(this.handle.surface.positions, 3));
      g.setIndex(new BufferAttribute(this.handle.surface.index, 1));
      this.bvh = new MeshBVH(g);
    }
    return this.bvh;
  }

  /** The ray under a pointer event in the root frame (normalised direction). */
  private localRay(e: { clientX: number; clientY: number }): Ray {
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.host.camera);
    const ray = this.raycaster.ray.clone().applyMatrix4(this.rootMatrix().clone().invert());
    ray.direction.normalize();
    return ray;
  }

  /** Distances of every hit of a (root-frame) ray on the rest surface, ascending. */
  private hits(ray: Ray): number[] {
    const hs = this.meshBvh.raycast(ray, DoubleSide);
    return hs.map((h) => h.distance).sort((a, b) => a - b);
  }

  /**
   * The mesh-interior point nearest `p` on the view ray through it: the
   * midpoint of the entry / exit hit pair closest to p (null without two hits).
   */
  snapInterior(p: Vec3): Vec3 | null {
    const cam = this.host.camera.getWorldPosition(new Vector3());
    const origin = new Vector3(cam.x, cam.y, cam.z).applyMatrix4(this.rootMatrix().clone().invert());
    const dir = vec(p).sub(origin);
    const tp = dir.length();
    if (tp < 1e-9) return null;
    dir.normalize();
    const ts = this.hits(new Ray(origin, dir));
    let best: number | null = null;
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const mid = (ts[k] + ts[k + 1]) / 2;
      if (best === null || Math.abs(mid - tp) < Math.abs(best - tp)) best = mid;
    }
    if (best === null) return null;
    return { x: origin.x + dir.x * best, y: origin.y + dir.y * best, z: origin.z + dir.z * best };
  }

  // ---- pointer --------------------------------------------------------------------------

  private screenPos(world: Vector3): { x: number; y: number; z: number } {
    const rect = this.host.canvas.getBoundingClientRect();
    const v = world.clone().project(this.host.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, z: v.z };
  }

  /** The marker under (x, y) within `radius` px (IK handles first, then the nearest joint). */
  pickAt(x: number, y: number, radius = 14): Pick | null {
    let best: Pick | null = null, bestD = radius;
    const consider = (m: Mesh, bias: number) => {
      if (!m.visible) return;
      const s = this.screenPos(m.position);
      if (s.z < -1 || s.z > 1) return;
      const d = Math.hypot(s.x - x, s.y - y) - bias;
      if (d < bestD) (bestD = d), (best = m.userData.pick as Pick);
    };
    for (const m of this.ikMarkers.values()) consider(m, 3);
    for (const m of this.markers.values()) consider(m, 0);
    return best;
  }

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.disposed) return;
    if (this.tc?.dragging) return;
    if (this.modeValue === 'paint') {
      const bone = this.selectedBone;
      const ray = this.localRay(e);
      const hit = this.meshBvh.raycastFirst(ray, DoubleSide);
      if (!hit || !bone) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      this.host.setOrbitEnabled(false);
      try {
        this.host.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      this.painter.beginStroke();
      this.stroke = { pointerId: e.pointerId, last: null };
      this.dabAt(hit.point);
      return;
    }
    if (this.addArmed) {
      const ray = this.localRay(e);
      const ts = this.hits(ray);
      if (!ts.length) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const t = ts.length >= 2 ? (ts[0] + ts[1]) / 2 : ts[0];
      this.armAddBone(false);
      this.cb.onAddAt({ x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t, z: ray.origin.z + ray.direction.z * t });
      return;
    }
    const pick = this.pickAt(e.clientX, e.clientY);
    if (!pick) return;
    const same = JSON.stringify(pick) === JSON.stringify(this.sel);
    // Pressing the selected marker leaves the press to the gizmo (free move of its centre).
    if (same && this.tc?.object) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (pick.kind === 'joint') this.select(pick.bone, pick.end);
    else {
      this.sel = pick;
      this.colorMarkers();
      this.attachGizmo();
      this.cb.onSelect(null, 'head');
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    if (this.modeValue === 'paint') {
      const ray = this.localRay(e);
      const hit = this.meshBvh.raycastFirst(ray, DoubleSide);
      this.showRing(hit ? hit.point : null, hit?.face?.normal ?? null);
      if (this.stroke && e.pointerId === this.stroke.pointerId && hit) this.dabAt(hit.point);
      return;
    }
    if (e.buttons === 0 && !this.addArmed) this.host.canvas.style.cursor = this.pickAt(e.clientX, e.clientY) ? 'pointer' : '';
  };

  private readonly onUp = (e: PointerEvent) => {
    const s = this.stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    this.stroke = null;
    this.host.setOrbitEnabled(true);
    try {
      this.host.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const diff = this.painter.endStroke();
    if (diff) this.cb.onStroke(diff);
  };

  private showRing(p: Vector3 | null, n: Vector3 | null): void {
    if (!p) {
      if (this.ring.visible) (this.ring.visible = false), this.host.invalidate();
      return;
    }
    const r = this.brush.radius * specSize(this.handle.spec);
    this.ring.position.copy(p.clone().applyMatrix4(this.rootMatrix()));
    const normal = (n ?? new Vector3(0, 0, 1)).clone().transformDirection(this.rootMatrix());
    this.ring.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    this.ring.scale.setScalar(r * this.rootMatrix().getMaxScaleOnAxis());
    this.ring.visible = true;
    this.host.invalidate();
  }

  /** One dab (root frame), mirrored with symmetry; spaced along the stroke. */
  dabAt(p: Vec3): void {
    const bone = this.selectedBone;
    if (!bone) return;
    const spec = this.handle.spec;
    const size = specSize(spec);
    const radius = this.brush.radius * size;
    const s = this.stroke;
    const pv = vec(p);
    if (s?.last && s.last.distanceTo(pv) < 0.25 * radius) return;
    if (s) s.last = pv;
    const idx = spec.bones.findIndex((b) => b.name === bone);
    const changed: number[] = [];
    const opts = { mode: this.brush.mode, radius, strength: this.brush.strength, falloff: this.brush.falloff, value: this.brush.value, bone: idx };
    this.painter.dab(p, opts, changed);
    if (this.symmetry) {
      const twin = findMirrorBone(spec, bone);
      const mp = mirrorPoint(spec, p);
      if (vec(mp).distanceTo(pv) > 0.5 * radius || twin) {
        const ti = twin ? spec.bones.findIndex((b) => b.name === twin) : idx;
        this.painter.dab(mp, { ...opts, bone: ti }, changed);
      }
    }
    this.writeVertices(changed);
  }

  /** Copy painted weights of welded vertices into the skinned meshes (and the heat map). */
  writeVertices(welded: Iterable<number>): void {
    const painter = this.painter;
    const meshes = this.handle.meshes as SkinnedMesh[];
    const starts = this.heatOverlay.starts;
    const bone = this.handle.spec.bones.findIndex((b) => b.name === this.selectedBone);
    const inputs: number[] = [];
    const colors = this.heatOverlay.visible ? new Float32Array(painter.weld.length * 3) : null;
    const dirty = new Set<number>();
    for (const v of welded) {
      for (const i of painter.inputsOf(v)) {
        let k = starts.length - 1;
        while (k > 0 && starts[k] > i) k--;
        const g = meshes[k].geometry;
        const l = i - starts[k];
        ((g.getAttribute('skinIndex') as BufferAttribute).array as Uint16Array).set(painter.idx.subarray(v * 4, v * 4 + 4), l * 4);
        ((g.getAttribute('skinWeight') as BufferAttribute).array as Float32Array).set(painter.w.subarray(v * 4, v * 4 + 4), l * 4);
        dirty.add(k);
        if (colors) {
          const [r, gg, b] = heat(bone >= 0 ? painter.weightOf(v, bone) : 0);
          colors[i * 3] = r;
          colors[i * 3 + 1] = gg;
          colors[i * 3 + 2] = b;
          inputs.push(i);
        }
      }
    }
    for (const k of dirty) {
      (meshes[k].geometry.getAttribute('skinIndex') as BufferAttribute).needsUpdate = true;
      (meshes[k].geometry.getAttribute('skinWeight') as BufferAttribute).needsUpdate = true;
    }
    if (colors) this.heatOverlay.update(inputs, colors);
    this.host.invalidate();
  }

  /** Show the heat map of the selected bone (paint mode). */
  showHeat(): void {
    if (!this.heatVisible || this.modeValue !== 'paint') {
      this.heatOverlay.hide();
      this.host.invalidate();
      return;
    }
    const bone = this.handle.spec.bones.findIndex((b) => b.name === this.selectedBone);
    const colors = bone >= 0 ? this.painter.heatColors(bone) : new Float32Array(this.handle.surface.positions.length).fill(0.2);
    this.heatOverlay.show(colors);
    this.host.invalidate();
  }

  // ---- poses ----------------------------------------------------------------------------

  /** Local rotations of every bone (and the root's position). */
  capturePose(): PoseSnapshot {
    const out: PoseSnapshot = { rot: {}, pos: {} };
    for (const b of this.handle.spec.bones) {
      const bone = this.handle.bones.get(b.name);
      if (!bone) continue;
      out.rot[b.name] = bone.quaternion.toArray() as Q4;
      if (b.parent === null) out.pos[b.name] = bone.position.toArray() as [number, number, number];
    }
    return out;
  }

  /** Put the bones into a pose (bones missing from it go back to rest when `reset`). */
  applyPose(p: PoseSnapshot, reset = true): void {
    if (reset) this.handle.restPose();
    for (const [n, q] of Object.entries(p.rot)) this.handle.bones.get(n)?.quaternion.fromArray(q);
    for (const [n, v] of Object.entries(p.pos)) this.handle.bones.get(n)?.position.fromArray(v);
    this.handle.root.updateMatrixWorld(true);
    this.sync();
    this.attachGizmo();
  }

  /** Show a document's pose at time t (timeline scrub / preview). */
  showDocPose(doc: ClipDoc, t: number): void {
    const s = samplePose(doc, t);
    this.handle.restPose();
    for (const [n, q] of s.rot) this.handle.bones.get(n)?.quaternion.copy(q);
    for (const [n, v] of s.pos) this.handle.bones.get(n)?.position.copy(v);
    this.handle.root.updateMatrixWorld(true);
    this.sync();
    if (!this.tc?.dragging) this.attachGizmo();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.host.canvas;
    c.removeEventListener('pointerdown', this.onDown, { capture: true });
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.style.cursor = '';
    this.host.setOrbitEnabled(true);
    if (this.tc) {
      this.tc.detach();
      this.tc.dispose();
    }
    c.style.touchAction = this.touchAction;
    this.heatOverlay.dispose();
    this.host.removeOverlay(this.group);
    this.sphere.dispose();
    this.cube.dispose();
    this.ring.geometry.dispose();
    this.lines.geometry.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
    this.bvh = null;
    this.painterObj = null;
    this.handle.restPose();
  }
}

export type { Pick as EditorPick, WeightDiff };
