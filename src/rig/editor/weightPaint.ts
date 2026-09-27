/**
 * Weight painting math (pure, no DOM): skin weights edited per welded
 * vertex (duplicated seam / rim vertices always get the same weights, so the
 * mesh never tears), four influences per vertex, always normalised.
 *
 * Brush modes on the selected bone b, per vertex with falloff f ∈ [0, 1] and
 * strength s: add (w + s·f), subtract (w − s·f), replace (towards `value`)
 * and smooth (towards the mean of the neighbours' weights of b). Changing b's
 * weight rescales the vertex's other bones to fill the rest; weight taken
 * from a vertex that only b influenced goes to b's parent. Every stroke
 * records a diff (the touched vertices before / after) for undo.
 */
import { Vector3 } from 'three';
import { prepareSkinning, type SkinWeights } from '../skinning';
import type { Vec3 } from '../types';

export type BrushMode = 'add' | 'subtract' | 'replace' | 'smooth';
export type Falloff = 'smooth' | 'linear' | 'constant';

export interface BrushOptions {
  mode: BrushMode;
  /** Model units. */
  radius: number;
  /** 0..1 */
  strength: number;
  falloff: Falloff;
  /** Target weight for 'replace' (default 1). */
  value?: number;
  /** Bone (skin index) being painted. */
  bone: number;
}

export function falloffWeight(d: number, r: number, type: Falloff): number {
  if (d >= r || r <= 0) return 0;
  const x = d / r;
  if (type === 'constant') return 1;
  if (type === 'linear') return 1 - x;
  const k = 1 - x * x;
  return k * k;
}

/** Diff of one stroke: touched welded vertices and their weights before / after. */
export interface WeightDiff {
  ids: Int32Array;
  beforeIdx: Uint16Array;
  beforeW: Float32Array;
  afterIdx: Uint16Array;
  afterW: Float32Array;
}

export class WeightPainter {
  /** Input vertex → welded vertex. */
  readonly weld: Int32Array;
  /** Welded positions. */
  readonly pos: Float32Array;
  readonly count: number;
  private readonly adjStart: Int32Array;
  private readonly adj: Int32Array;
  /** 4 influences per welded vertex. */
  readonly idx: Uint16Array;
  readonly w: Float32Array;
  private readonly grid: { cell: number; nx: number; ny: number; nz: number; x0: number; y0: number; z0: number; start: Int32Array; items: Int32Array };
  private stroke: Map<number, [Uint16Array, Float32Array]> | null = null;

  constructor(
    positions: Float32Array,
    index: Uint32Array,
    weights: SkinWeights,
    /** Parent skin index of every bone (-1 for the root); replaced when the skeleton changes. */
    public parents: Int32Array,
  ) {
    const prep = prepareSkinning(positions, index, false);
    this.weld = prep.weld;
    this.pos = prep.pos;
    this.count = prep.count;
    this.adjStart = prep.adjStart;
    this.adj = prep.adj;
    this.idx = new Uint16Array(this.count * 4);
    this.w = new Float32Array(this.count * 4);
    this.load(weights);
    this.grid = buildGrid(this.pos, this.count, prep.diag / 48);
  }

  /** Take new weights (input vertex order), e.g. after auto-weighting. */
  load(weights: SkinWeights): void {
    const seen = new Uint8Array(this.count);
    for (let i = 0; i < this.weld.length; i++) {
      const v = this.weld[i];
      if (seen[v]) continue;
      seen[v] = 1;
      for (let s = 0; s < 4; s++) {
        this.idx[v * 4 + s] = weights.skinIndex[i * 4 + s];
        this.w[v * 4 + s] = weights.skinWeight[i * 4 + s];
      }
    }
  }

  /** Current weights in input vertex order. */
  weights(): SkinWeights {
    const n = this.weld.length;
    const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = this.weld[i];
      skinIndex.set(this.idx.subarray(v * 4, v * 4 + 4), i * 4);
      skinWeight.set(this.w.subarray(v * 4, v * 4 + 4), i * 4);
    }
    return { skinIndex, skinWeight };
  }

  weightOf(v: number, bone: number): number {
    for (let s = 0; s < 4; s++) if (this.idx[v * 4 + s] === bone && this.w[v * 4 + s] > 0) return this.w[v * 4 + s];
    return 0;
  }

  /** Welded vertices within `r` of `p` with their distances. */
  query(p: Vec3, r: number, out: { ids: number[]; d: number[] } = { ids: [], d: [] }): { ids: number[]; d: number[] } {
    out.ids.length = 0;
    out.d.length = 0;
    const g = this.grid;
    const c = (x: number, o: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((x - o) / g.cell)));
    const i0 = c(p.x - r, g.x0, g.nx), i1 = c(p.x + r, g.x0, g.nx);
    const j0 = c(p.y - r, g.y0, g.ny), j1 = c(p.y + r, g.y0, g.ny);
    const k0 = c(p.z - r, g.z0, g.nz), k1 = c(p.z + r, g.z0, g.nz);
    const r2 = r * r;
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cellId = (k * g.ny + j) * g.nx + i;
          for (let q = g.start[cellId]; q < g.start[cellId + 1]; q++) {
            const v = g.items[q];
            const dx = this.pos[v * 3] - p.x, dy = this.pos[v * 3 + 1] - p.y, dz = this.pos[v * 3 + 2] - p.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) (out.ids.push(v), out.d.push(Math.sqrt(d2)));
          }
        }
      }
    }
    return out;
  }

  /** Nearest welded vertex to p within r, or -1. */
  nearest(p: Vec3, r: number): number {
    const q = this.query(p, r);
    let best = -1, bd = Infinity;
    q.ids.forEach((v, k) => {
      if (q.d[k] < bd) (bd = q.d[k]), (best = v);
    });
    return best;
  }

  beginStroke(): void {
    this.stroke = new Map();
  }

  private remember(v: number): void {
    if (!this.stroke || this.stroke.has(v)) return;
    this.stroke.set(v, [this.idx.slice(v * 4, v * 4 + 4), this.w.slice(v * 4, v * 4 + 4)]);
  }

  /** End the stroke: the diff for undo (null when nothing changed). */
  endStroke(): WeightDiff | null {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.size) return null;
    const ids = Int32Array.from(s.keys());
    const d: WeightDiff = {
      ids,
      beforeIdx: new Uint16Array(ids.length * 4), beforeW: new Float32Array(ids.length * 4),
      afterIdx: new Uint16Array(ids.length * 4), afterW: new Float32Array(ids.length * 4),
    };
    ids.forEach((v, k) => {
      const [bi, bw] = s.get(v)!;
      d.beforeIdx.set(bi, k * 4);
      d.beforeW.set(bw, k * 4);
      d.afterIdx.set(this.idx.subarray(v * 4, v * 4 + 4), k * 4);
      d.afterW.set(this.w.subarray(v * 4, v * 4 + 4), k * 4);
    });
    return d;
  }

  applyDiff(d: WeightDiff, which: 'before' | 'after'): void {
    const I = which === 'before' ? d.beforeIdx : d.afterIdx, W = which === 'before' ? d.beforeW : d.afterW;
    d.ids.forEach((v, k) => {
      this.idx.set(I.subarray(k * 4, k * 4 + 4), v * 4);
      this.w.set(W.subarray(k * 4, k * 4 + 4), v * 4);
    });
  }

  /**
   * Set bone b's weight at welded vertex v to `target` (clamped 0..1); the
   * other bones share the rest in their proportions (or b's parent takes it).
   */
  setWeight(v: number, bone: number, target: number): void {
    this.remember(v);
    const t = Math.min(1, Math.max(0, target));
    const base = v * 4;
    const list: [number, number][] = [];
    for (let s = 0; s < 4; s++) {
      const w = this.w[base + s];
      if (w > 0 && this.idx[base + s] !== bone) list.push([this.idx[base + s], w]);
    }
    const others = list.reduce((a, e) => a + e[1], 0);
    if (others > 1e-9) for (const e of list) e[1] *= (1 - t) / others;
    else if (t < 1) {
      const p = this.parents[bone];
      const fb = p >= 0 ? p : this.neighbourBone(v, bone);
      if (fb >= 0 && fb !== bone) list.push([fb, 1 - t]);
      else return this.write(v, [[bone, 1]]);
    }
    if (t > 0) list.push([bone, t]);
    this.write(v, list);
  }

  private write(v: number, list: [number, number][]): void {
    const top = list.filter((e) => e[1] > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((a, e) => a + e[1], 0);
    const base = v * 4;
    for (let s = 0; s < 4; s++) {
      this.idx[base + s] = s < top.length ? top[s][0] : 0;
      this.w[base + s] = s < top.length && sum > 0 ? top[s][1] / sum : 0;
    }
    if (!top.length || sum <= 0) this.w[base] = 1;
  }

  /** The strongest bone other than `bone` among v's neighbours (-1 when none). */
  private neighbourBone(v: number, bone: number): number {
    const acc = new Map<number, number>();
    for (let e = this.adjStart[v]; e < this.adjStart[v + 1]; e++) {
      const u = this.adj[e];
      for (let s = 0; s < 4; s++) {
        const b = this.idx[u * 4 + s], w = this.w[u * 4 + s];
        if (w > 0 && b !== bone) acc.set(b, (acc.get(b) ?? 0) + w);
      }
    }
    let best = -1, bw = 0;
    for (const [b, w] of acc) if (w > bw) (bw = w), (best = b);
    return best;
  }

  /** Mean weight of `bone` over v's neighbours (v itself when isolated). */
  neighbourMean(v: number, bone: number): number {
    const a0 = this.adjStart[v], a1 = this.adjStart[v + 1];
    if (a1 <= a0) return this.weightOf(v, bone);
    let sum = 0;
    for (let e = a0; e < a1; e++) sum += this.weightOf(this.adj[e], bone);
    return sum / (a1 - a0);
  }

  private inStart: Int32Array | null = null;
  private inList: Int32Array | null = null;

  /** Input vertices of welded vertex v (seam / rim duplicates). */
  inputsOf(v: number): Int32Array {
    if (!this.inStart || !this.inList) {
      const start = new Int32Array(this.count + 1);
      for (let i = 0; i < this.weld.length; i++) start[this.weld[i] + 1]++;
      for (let k = 0; k < this.count; k++) start[k + 1] += start[k];
      const fill = start.slice(0, this.count);
      const list = new Int32Array(this.weld.length);
      for (let i = 0; i < this.weld.length; i++) list[fill[this.weld[i]]++] = i;
      this.inStart = start;
      this.inList = list;
    }
    return this.inList.subarray(this.inStart[v], this.inStart[v + 1]);
  }

  /** One brush dab at `center` (root frame). Returns the number of vertices changed (their ids pushed to `changed`). */
  dab(center: Vec3, o: BrushOptions, changed?: number[]): number {
    const q = this.query(center, o.radius);
    const s = Math.min(1, Math.max(0, o.strength));
    // Smooth reads the neighbours before writing (order independent).
    const means = o.mode === 'smooth' ? q.ids.map((v) => this.neighbourMean(v, o.bone)) : null;
    let n = 0;
    q.ids.forEach((v, k) => {
      const f = falloffWeight(q.d[k], o.radius, o.falloff) * s;
      if (f <= 0) return;
      const cur = this.weightOf(v, o.bone);
      let next = cur;
      switch (o.mode) {
        case 'add': next = cur + f; break;
        case 'subtract': next = cur - f; break;
        case 'replace': next = cur + ((o.value ?? 1) - cur) * f; break;
        case 'smooth': next = cur + (means![k] - cur) * f; break;
      }
      next = Math.min(1, Math.max(0, next));
      if (Math.abs(next - cur) < 1e-6) return;
      this.setWeight(v, o.bone, next);
      changed?.push(v);
      n++;
    });
    return n;
  }

  /** Renormalise every vertex (sum 1, top 4). Returns the vertices that changed. */
  normalizeAll(): number {
    let n = 0;
    for (let v = 0; v < this.count; v++) {
      let sum = 0;
      for (let s = 0; s < 4; s++) sum += Math.max(0, this.w[v * 4 + s]);
      if (Math.abs(sum - 1) < 1e-5) continue;
      this.remember(v);
      const list: [number, number][] = [];
      for (let s = 0; s < 4; s++) if (this.w[v * 4 + s] > 0) list.push([this.idx[v * 4 + s], this.w[v * 4 + s]]);
      this.write(v, list);
      n++;
    }
    return n;
  }

  /** Smooth `bone`'s weights over the whole mesh (`iterations` passes). */
  smoothBone(bone: number, iterations = 1, strength = 0.5): number {
    let n = 0;
    for (let it = 0; it < iterations; it++) {
      const means = new Float32Array(this.count);
      const touch = new Uint8Array(this.count);
      for (let v = 0; v < this.count; v++) {
        means[v] = this.neighbourMean(v, bone);
        if (Math.abs(means[v] - this.weightOf(v, bone)) > 1e-6) touch[v] = 1;
      }
      for (let v = 0; v < this.count; v++) {
        if (!touch[v]) continue;
        const cur = this.weightOf(v, bone);
        this.setWeight(v, bone, cur + (means[v] - cur) * strength);
        n++;
      }
    }
    return n;
  }

  /**
   * Mirror weights across a plane (point `o`, unit normal `n`): vertices on
   * the negative side (`toNegative`, else positive) take the weights of their
   * mirror vertex (nearest within `tol`), bones mapped with `mirrorBone`.
   */
  mirror(o: Vec3, n: Vec3, mirrorBone: (b: number) => number, toNegative: boolean, tol: number): number {
    const nv = new Vector3(n.x, n.y, n.z).normalize();
    const src = { idx: this.idx.slice(), w: this.w.slice() };
    let changed = 0;
    for (let v = 0; v < this.count; v++) {
      const px = this.pos[v * 3], py = this.pos[v * 3 + 1], pz = this.pos[v * 3 + 2];
      const d = (px - o.x) * nv.x + (py - o.y) * nv.y + (pz - o.z) * nv.z;
      if (toNegative ? d >= -tol * 0.5 : d <= tol * 0.5) continue;
      const m = { x: px - 2 * d * nv.x, y: py - 2 * d * nv.y, z: pz - 2 * d * nv.z };
      const u = this.nearest(m, tol);
      if (u < 0) continue;
      this.remember(v);
      const list: [number, number][] = [];
      for (let s = 0; s < 4; s++) if (src.w[u * 4 + s] > 0) list.push([mirrorBone(src.idx[u * 4 + s]), src.w[u * 4 + s]]);
      const merged = new Map<number, number>();
      for (const [b, w] of list) merged.set(b, (merged.get(b) ?? 0) + w);
      this.write(v, [...merged.entries()]);
      changed++;
    }
    return changed;
  }

  /** Heat-map colours of `bone` (0 blue → green → yellow → 1 red) per INPUT vertex (rgb). */
  heatColors(bone: number, out = new Float32Array(this.weld.length * 3)): Float32Array {
    for (let i = 0; i < this.weld.length; i++) {
      const [r, g, b] = heat(this.weightOf(this.weld[i], bone));
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }
}

/** Weight → colour (dark blue at 0, cyan, green, yellow, red at 1). */
export function heat(w: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, w));
  if (t <= 0) return [0.05, 0.05, 0.35];
  const stops: [number, number, number, number][] = [
    [0, 0.05, 0.05, 0.35], [0.25, 0, 0.6, 0.9], [0.5, 0.1, 0.85, 0.2], [0.75, 1, 0.85, 0], [1, 0.95, 0.1, 0.05],
  ];
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const a = stops[k - 1], b = stops[k];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [0.95, 0.1, 0.05];
}

function buildGrid(pos: Float32Array, count: number, cellHint: number) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < count; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
  }
  if (!count) (x0 = y0 = z0 = 0), (x1 = y1 = z1 = 1);
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-6);
  const cell = Math.max(cellHint, ext / 96, 1e-6);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
  const cellOf = (v: number) => {
    const i = Math.min(nx - 1, Math.floor((pos[v * 3] - x0) / cell)), j = Math.min(ny - 1, Math.floor((pos[v * 3 + 1] - y0) / cell)), k = Math.min(nz - 1, Math.floor((pos[v * 3 + 2] - z0) / cell));
    return (k * ny + j) * nx + i;
  };
  const start = new Int32Array(nx * ny * nz + 1);
  for (let v = 0; v < count; v++) start[cellOf(v) + 1]++;
  for (let c = 0; c < nx * ny * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny * nz);
  const items = new Int32Array(count);
  for (let v = 0; v < count; v++) items[fill[cellOf(v)]++] = v;
  return { cell, nx, ny, nz, x0, y0, z0, start, items };
}
