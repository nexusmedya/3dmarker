/**
 * Fine human detail (finger ridges, ear bumps) must survive meshing at the
 * default mesh options. Synthetic depth: a smooth body dome with four finger
 * ridges (half cylinders, radius 4 px, 2 px gaps) inside a hand box and two
 * ear bumps (Gaussian, σ 2.5 px) inside a face box, on a 768 × 1024 image
 * (4 px per grid cell at the default resolution 256).
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { DepthMap, Mask } from '../types';
import { buildGeometryFromDepth, DETAIL_TRIANGLE_BUDGET, detailRegionsOf } from './buildFromDepth';
import { computeMeshStats } from './stats';
import { DEFAULT_MESH_OPTIONS, type DetailedDepth, type DetailRegion, type MeshOptions } from './options';

const W = 768, H = 1024, L = Math.max(W, H);
/** Relief in px → depth units at the default depth scale (as enhance.ts does). */
const toDepth = (px: number) => px / (L * DEFAULT_MESH_OPTIONS.depthScale);

const HAND = { x: 301, y: 603, width: 70, height: 90 };
const FINGER_R = 4, FINGER_STEP = 10;
const FINGERS = [0, 1, 2, 3].map((k) => HAND.x + 20 + k * FINGER_STEP + 0.37);
const FINGER_Y0 = HAND.y + 15, FINGER_Y1 = HAND.y + 60;
const FACE = { x: 330, y: 150, width: 110, height: 140 };
const EARS = [{ x: 337.3, y: 221.6 }, { x: 432.7, y: 218.4 }];
const EAR_SIGMA = 2.5, EAR_H = 5;

function base(x: number, y: number): number {
  const dx = (x - W / 2) / (W * 0.45), dy = (y - H / 2) / (H * 0.48);
  return 0.35 + 0.3 * Math.max(0, 1 - dx * dx - dy * dy);
}

function fingerRelief(x: number, y: number): number {
  if (y < FINGER_Y0 || y > FINGER_Y1) return 0;
  let r = 0;
  for (const c of FINGERS) {
    const t = Math.abs(x - c) / FINGER_R;
    if (t < 1) r = Math.max(r, FINGER_R * Math.sqrt(1 - t * t));
  }
  return r;
}

function earRelief(x: number, y: number): number {
  let r = 0;
  for (const e of EARS) r = Math.max(r, EAR_H * Math.exp(-((x - e.x) ** 2 + (y - e.y) ** 2) / (2 * EAR_SIGMA ** 2)));
  return r;
}

const truth = (x: number, y: number) => base(x, y) + toDepth(fingerRelief(x, y) + earRelief(x, y));

function fixture(): { depth: DepthMap; mask: Mask; regions: DetailRegion[] } {
  const data = new Float32Array(W * H);
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      data[y * W + x] = truth(x + 0.5, y + 0.5);
      const dx = (x + 0.5 - W / 2) / (W * 0.46), dy = (y + 0.5 - H / 2) / (H * 0.49);
      m[y * W + x] = dx * dx + dy * dy <= 1 ? 1 : 0;
    }
  }
  const regions: DetailRegion[] = [
    { kind: 'hand', ...HAND },
    { kind: 'face', ...FACE },
  ];
  return { depth: { width: W, height: H, data }, mask: { width: W, height: H, data: m }, regions };
}

/** Front-surface height at image pixel (px, py): barycentric lookup in group 0. */
function surfaceZ(g: BufferGeometry, px: number, py: number): number {
  const pos = g.getAttribute('position').array as Float32Array;
  const idx = g.getIndex()!.array;
  const hw = W / L, hh = H / L;
  const x = -hw + (2 * hw * px) / W, y = hh - (2 * hh * py) / H;
  const end = g.groups[0].count;
  for (let t = 0; t < end; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], bx = pos[b], by = pos[b + 1], cx = pos[c], cy = pos[c + 1];
    if (x < Math.min(ax, bx, cx) - 1e-9 || x > Math.max(ax, bx, cx) + 1e-9 || y < Math.min(ay, by, cy) - 1e-9 || y > Math.max(ay, by, cy) + 1e-9) continue;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-15) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
    return l1 * pos[a + 2] + l2 * pos[b + 2] + l3 * pos[c + 2];
  }
  return NaN;
}

/** Mesh relief ÷ true relief for the finger ridges (crest vs gap) and the ear bumps (peak vs ring). */
export function detailPreservation(g: BufferGeometry, S: number): { fingers: number; ears: number } {
  const ratios: number[] = [];
  for (let k = 0; k < FINGERS.length; k++) {
    for (const py of [FINGER_Y0 + 10.3, FINGER_Y0 + 21.7, FINGER_Y0 + 33.1]) {
      const c = FINGERS[k];
      const gapL = c - FINGER_STEP / 2, gapR = c + FINGER_STEP / 2;
      const mesh = surfaceZ(g, c, py) - (surfaceZ(g, gapL, py) + surfaceZ(g, gapR, py)) / 2;
      const real = (truth(c, py) - (truth(gapL, py) + truth(gapR, py)) / 2) * S;
      ratios.push(mesh / real);
    }
  }
  const ears: number[] = [];
  for (const e of EARS) {
    const ring = 3 * EAR_SIGMA;
    const around = [0, 1, 2, 3, 4, 5, 6, 7].map((a) => [e.x + ring * Math.cos((a * Math.PI) / 4), e.y + ring * Math.sin((a * Math.PI) / 4)]);
    const meshRing = around.reduce((s, [x, y]) => s + surfaceZ(g, x, y), 0) / around.length;
    const realRing = around.reduce((s, [x, y]) => s + truth(x, y), 0) / around.length;
    ears.push((surfaceZ(g, e.x, e.y) - meshRing) / ((truth(e.x, e.y) - realRing) * S));
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  return { fingers: mean(ratios), ears: mean(ears) };
}

const now = () => performance.now();

describe('human detail survives meshing', () => {
  const { depth, mask, regions } = fixture();
  const detailed: DepthMap & DetailedDepth = { ...depth, detail: regions };
  const S = DEFAULT_MESH_OPTIONS.depthScale * 2;
  const opts = (o: Partial<MeshOptions> = {}): MeshOptions => ({ ...DEFAULT_MESH_OPTIONS, ...o });

  it('without regions the default smoothing / grid flatten fingers and ears (the problem)', () => {
    const r = detailPreservation(buildGeometryFromDepth(depth, mask, opts()), S);
    expect(r.fingers).toBeLessThan(0.2);
    expect(r.ears).toBeLessThan(0.2);
  });

  for (const mode of ['relief', 'solid', 'double'] as const) {
    it(`${mode}: ≥ 80 % of the ridge / bump height survives at the default options, in < 1 s`, () => {
      buildGeometryFromDepth(detailed, mask, opts({ mode })); // warm-up (JIT)
      const t0 = now();
      const g = buildGeometryFromDepth(detailed, mask, opts({ mode }));
      const ms = now() - t0;
      const r = detailPreservation(g, S);
      expect(r.fingers).toBeGreaterThanOrEqual(0.8);
      expect(r.ears).toBeGreaterThanOrEqual(0.8);
      expect(r.fingers).toBeLessThan(1.1); // no overshoot
      expect(ms).toBeLessThan(1000);
      if (mode !== 'relief') expect(computeMeshStats(g).watertight).toBe(true);
      // Only the regions are refined: far fewer triangles than a globally finer grid.
      const plain = buildGeometryFromDepth(depth, mask, opts({ mode }));
      expect(tris(g)).toBeLessThan(2 * tris(plain));
      expectClean(g);
    });
  }

  it('outside the regions the surface is unchanged', () => {
    const plain = buildGeometryFromDepth(depth, mask, opts());
    const g = buildGeometryFromDepth(detailed, mask, opts());
    for (const [px, py] of [[120.3, 500.2], [600.1, 800.7], [384, 900]]) expect(surfaceZ(g, px, py)).toBeCloseTo(surfaceZ(plain, px, py), 6);
  });

  it('a region across the silhouette keeps closed meshes watertight and outward-facing', () => {
    // Box straddling the ellipse outline on the left, plus one fully outside the mask.
    const edge: DepthMap & DetailedDepth = { ...depth, detail: [{ kind: 'hand', x: 0, y: 450, width: 80, height: 120 }, { kind: 'face', x: 0, y: 0, width: 30, height: 30 }] };
    for (const mode of ['solid', 'double'] as const) {
      const g = buildGeometryFromDepth(edge, mask, opts({ mode }));
      expect(computeMeshStats(g).watertight).toBe(true);
      expect(signedVolume(g)).toBeGreaterThan(0);
      expectClean(g);
    }
  });

  it('relief with a tear threshold, invert and gamma still refines cleanly', () => {
    const g = buildGeometryFromDepth(detailed, mask, opts({ discontinuity: 0.05, invert: true, gamma: 1.3 }));
    expectClean(g);
    expect(tris(g)).toBeGreaterThan(tris(buildGeometryFromDepth(depth, mask, opts({ discontinuity: 0.05, invert: true, gamma: 1.3 }))));
  });

  it('the triangle budget caps huge regions; invalid regions are ignored', () => {
    const plain = buildGeometryFromDepth(depth, mask, opts());
    const huge: DepthMap & DetailedDepth = { ...depth, detail: [{ kind: 'face', x: 0, y: 0, width: W, height: H }] };
    const g = buildGeometryFromDepth(huge, mask, opts());
    expect(tris(g) - tris(plain)).toBeLessThanOrEqual(DETAIL_TRIANGLE_BUDGET);
    const bad = { ...depth, detail: [{ kind: 'hand', x: NaN, y: 0, width: 10, height: 10 }, { kind: 'hand', x: -50, y: -50, width: 20, height: 20 }, null] } as unknown as DepthMap;
    expect(tris(buildGeometryFromDepth(bad, mask, opts()))).toBe(tris(plain));
    expect(detailRegionsOf(bad)).toEqual([]);
  });
});

const tris = (g: BufferGeometry) => g.getIndex()!.count / 3;

function signedVolume(g: BufferGeometry): number {
  const p = g.getAttribute('position').array as Float32Array, idx = g.getIndex()!.array;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function expectClean(g: BufferGeometry): void {
  for (const name of ['position', 'normal', 'uv']) expect((g.getAttribute(name).array as Float32Array).every(Number.isFinite)).toBe(true);
  const used = new Uint8Array(g.getAttribute('position').count);
  for (const i of g.getIndex()!.array) used[i] = 1;
  expect(used.every((u) => u === 1)).toBe(true);
  const uv = g.getAttribute('uv').array as Float32Array;
  expect(uv.every((v) => v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
}
