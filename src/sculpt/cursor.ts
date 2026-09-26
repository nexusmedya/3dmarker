/**
 * Brush cursor overlay: a ring lying on the surface (aligned to the brush
 * normal) with a short normal tick, plus a fainter mirrored ring when X
 * symmetry is on. Drawn on top of the model (no depth test).
 */
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineLoop, Quaternion, Vector3 } from 'three';

const SEGMENTS = 64;
const Z = new Vector3(0, 0, 1);
const _q = new Quaternion();

export const CURSOR_COLORS = { normal: 0xffffff, invert: 0x60a5fa, smooth: 0x34d399, grab: 0xfbbf24 } as const;
export type CursorTone = keyof typeof CURSOR_COLORS;

function ringGeometry(): BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0);
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
}

function tickGeometry(): BufferGeometry {
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0.35], 3));
}

class Ring {
  readonly group = new Group();
  readonly material: LineBasicMaterial;

  constructor(ring: BufferGeometry, tick: BufferGeometry, opacity: number) {
    this.material = new LineBasicMaterial({ color: CURSOR_COLORS.normal, transparent: true, opacity, depthTest: false, depthWrite: false });
    const loop = new LineLoop(ring, this.material);
    const line = new Line(tick, this.material);
    for (const o of [loop, line]) {
      o.renderOrder = 999;
      o.frustumCulled = false;
      o.raycast = () => {}; // never pickable
      this.group.add(o);
    }
    this.group.visible = false;
  }

  place(point: Vector3, normal: Vector3, radius: number): void {
    this.group.position.copy(point).addScaledVector(normal, radius * 0.01);
    this.group.quaternion.copy(_q.setFromUnitVectors(Z, normal));
    this.group.scale.setScalar(radius);
    this.group.visible = true;
  }
}

export class BrushCursor {
  readonly object = new Group();
  private readonly ringGeo = ringGeometry();
  private readonly tickGeo = tickGeometry();
  private readonly main = new Ring(this.ringGeo, this.tickGeo, 0.9);
  private readonly mirror = new Ring(this.ringGeo, this.tickGeo, 0.35);

  constructor() {
    this.object.name = 'sculpt-cursor';
    this.object.add(this.main.group, this.mirror.group);
  }

  get visible(): boolean {
    return this.main.group.visible;
  }

  /** Show at a world point / unit normal with a world radius; `mirror` places the symmetric ring. */
  show(point: Vector3, normal: Vector3, radius: number, mirror: { point: Vector3; normal: Vector3 } | null): void {
    this.main.place(point, normal, radius);
    if (mirror) this.mirror.place(mirror.point, mirror.normal, radius);
    else this.mirror.group.visible = false;
  }

  hide(): void {
    this.main.group.visible = false;
    this.mirror.group.visible = false;
  }

  setTone(tone: CursorTone): void {
    this.main.material.color.setHex(CURSOR_COLORS[tone]);
    this.mirror.material.color.setHex(CURSOR_COLORS[tone]);
  }

  dispose(): void {
    this.ringGeo.dispose();
    this.tickGeo.dispose();
    this.main.material.dispose();
    this.mirror.material.dispose();
    this.object.clear();
  }
}
