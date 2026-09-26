/**
 * Joint editor on top of the viewer: a marker per joint (always on top), a
 * pointer pick in screen space (nearest projected joint within a few
 * pixels) and a drag in the plane through the joint facing the camera. The
 * orbit controls are paused while dragging; the move is committed on release
 * (the rig then re-binds and re-weights, which is too slow per pointer move).
 * With `mirror`, the opposite side's joint follows, mirrored about the hips'
 * X. Browser-only (DOM pointer events); the picking math is pure.
 */
import { Group, Mesh, MeshBasicMaterial, Plane, Raycaster, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { isFingerBone, mirrorBone } from './bones';
import type { HumanoidBone, JointLayout, Vec3 } from './types';

export interface JointEditorHost {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  setOrbitEnabled(enabled: boolean): void;
  addOverlay(obj: Object3D): void;
  removeOverlay(obj: Object3D): void;
  invalidate(): void;
}

export interface JointEditorOptions {
  /** The model root (joints are in its local frame). */
  root: Object3D;
  layout: JointLayout;
  mirror: () => boolean;
  onSelect: (bone: HumanoidBone | null) => void;
  /** A drag finished: the moved joint(s), in the root's frame. */
  onCommit: (patch: JointLayout) => void;
}

export interface ScreenJoint {
  bone: HumanoidBone;
  x: number;
  y: number;
  /** NDC depth (smaller = nearer). */
  depth: number;
}

/** The joint under (px, py): nearest within `radius` pixels, the nearer one to the camera on ties. */
export function pickJoint(joints: ScreenJoint[], px: number, py: number, radius: number): HumanoidBone | null {
  let best: ScreenJoint | null = null, bestD = Infinity;
  for (const j of joints) {
    const d = Math.hypot(j.x - px, j.y - py);
    if (d > radius) continue;
    if (d < bestD - 2 || (Math.abs(d - bestD) <= 2 && best && j.depth < best.depth)) {
      best = j;
      bestD = d;
    }
  }
  return best?.bone ?? null;
}

/** Mirror a joint position about the X = `centerX` plane. */
export function mirrorPosition(p: Vec3, centerX: number): Vec3 {
  return { x: 2 * centerX - p.x, y: p.y, z: p.z };
}

const COLORS = { joint: 0x7c5cff, finger: 0xa78bfa, selected: 0xfbbf24 };

export class JointEditor {
  private readonly group = new Group();
  private readonly markers = new Map<HumanoidBone, Mesh>();
  private readonly geometry: SphereGeometry;
  private readonly materials = {
    joint: new MeshBasicMaterial({ color: COLORS.joint, depthTest: false, transparent: true, opacity: 0.95 }),
    finger: new MeshBasicMaterial({ color: COLORS.finger, depthTest: false, transparent: true, opacity: 0.9 }),
    selected: new MeshBasicMaterial({ color: COLORS.selected, depthTest: false }),
  };
  private layout: JointLayout;
  private selected: HumanoidBone | null = null;
  private drag: { bone: HumanoidBone; pointerId: number; plane: Plane; moved: boolean } | null = null;
  private readonly raycaster = new Raycaster();
  private disposed = false;

  constructor(
    private readonly host: JointEditorHost,
    private readonly opts: JointEditorOptions,
  ) {
    this.layout = { ...opts.layout };
    // Marker size from the skeleton's height in world units (the root may be scaled).
    opts.root.updateWorldMatrix(true, false);
    const ys = Object.values(this.layout).map((p) => new Vector3(p!.x, p!.y, p!.z).applyMatrix4(opts.root.matrixWorld).y);
    const height = Math.max(1e-3, Math.max(...ys) - Math.min(...ys));
    this.geometry = new SphereGeometry(0.012 * height, 12, 8);
    this.group.name = 'joint-editor';
    this.group.renderOrder = 999;
    for (const bone of Object.keys(this.layout) as HumanoidBone[]) {
      const m = new Mesh(this.geometry, isFingerBone(bone) ? this.materials.finger : this.materials.joint);
      m.name = bone;
      m.renderOrder = 999;
      if (isFingerBone(bone)) m.scale.setScalar(0.6);
      this.markers.set(bone, m);
      this.group.add(m);
    }
    this.place();
    host.addOverlay(this.group);
    const c = host.canvas;
    c.addEventListener('pointerdown', this.onDown, { capture: true });
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
  }

  get selection(): HumanoidBone | null {
    return this.selected;
  }

  /** New rest layout (after a commit / external change). */
  setLayout(layout: JointLayout): void {
    this.layout = { ...layout };
    this.place();
  }

  select(bone: HumanoidBone | null): void {
    if (this.selected) this.markers.get(this.selected)!.material = isFingerBone(this.selected) ? this.materials.finger : this.materials.joint;
    this.selected = bone && this.markers.has(bone) ? bone : null;
    if (this.selected) this.markers.get(this.selected)!.material = this.materials.selected;
    this.host.invalidate();
    this.opts.onSelect(this.selected);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.host.canvas;
    c.removeEventListener('pointerdown', this.onDown, { capture: true });
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    if (this.drag) this.host.setOrbitEnabled(true);
    c.style.cursor = '';
    this.host.removeOverlay(this.group);
    this.geometry.dispose();
    Object.values(this.materials).forEach((m) => m.dispose());
  }

  private place(): void {
    const root = this.opts.root;
    root.updateWorldMatrix(true, false);
    for (const [bone, m] of this.markers) {
      const p = this.layout[bone];
      if (!p) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(p.x, p.y, p.z).applyMatrix4(root.matrixWorld);
    }
    this.host.invalidate();
  }

  private screenJoints(): ScreenJoint[] {
    const rect = this.host.canvas.getBoundingClientRect();
    const out: ScreenJoint[] = [];
    const v = new Vector3();
    for (const [bone, m] of this.markers) {
      if (!m.visible) continue;
      v.copy(m.position).project(this.host.camera);
      if (v.z < -1 || v.z > 1) continue;
      out.push({ bone, x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, depth: v.z });
    }
    return out;
  }

  private ray(e: PointerEvent): Raycaster {
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.host.camera);
    return this.raycaster;
  }

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.drag) return;
    const bone = pickJoint(this.screenJoints(), e.clientX, e.clientY, 14);
    if (!bone) return;
    // Ours: keep the orbit controls (registered earlier, bubbling) from starting a rotation.
    e.stopImmediatePropagation();
    e.preventDefault();
    this.select(bone);
    const normal = new Vector3();
    this.host.camera.getWorldDirection(normal);
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, this.markers.get(bone)!.position);
    this.drag = { bone, pointerId: e.pointerId, plane, moved: false };
    this.host.setOrbitEnabled(false);
    try {
      this.host.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events in tests */
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    if (!this.drag) {
      if (e.buttons === 0) this.host.canvas.style.cursor = pickJoint(this.screenJoints(), e.clientX, e.clientY, 14) ? 'pointer' : '';
      return;
    }
    if (e.pointerId !== this.drag.pointerId) return;
    const hit = this.ray(e).ray.intersectPlane(this.drag.plane, new Vector3());
    if (!hit) return;
    this.drag.moved = true;
    const { bone } = this.drag;
    this.markers.get(bone)!.position.copy(hit);
    const twin = mirrorBone(bone);
    if (this.opts.mirror() && twin !== bone && this.markers.has(twin)) {
      const local = this.toLocal(hit);
      const hips = this.layout.Hips ?? { x: 0, y: 0, z: 0 };
      const m = mirrorPosition(local, hips.x);
      this.markers.get(twin)!.position.set(m.x, m.y, m.z).applyMatrix4(this.opts.root.matrixWorld);
    }
    this.host.invalidate();
  };

  private readonly onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    this.host.setOrbitEnabled(true);
    try {
      this.host.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d.moved) return;
    const patch: JointLayout = { [d.bone]: this.toLocal(this.markers.get(d.bone)!.position) };
    const twin = mirrorBone(d.bone);
    if (this.opts.mirror() && twin !== d.bone && this.markers.has(twin)) patch[twin] = this.toLocal(this.markers.get(twin)!.position);
    this.opts.onCommit(patch);
  };

  private toLocal(world: Vector3): Vec3 {
    const p = this.opts.root.worldToLocal(world.clone());
    return { x: p.x, y: p.y, z: p.z };
  }
}
