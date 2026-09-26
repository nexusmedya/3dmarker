/**
 * Multi-view reconstruction: front + any of back / left / right / top /
 * bottom → closed, vertex-coloured mesh in the shared frame.
 *
 *  1. Normalise: per-view silhouette + bbox, object box W × H × D (./frame.ts).
 *  2. Soft visual hull on a voxel grid (./volume.ts).
 *  3. Optional depth refinement: each view's monocular depth carves in front
 *     of its estimated surface (./depthCarve.ts); falls back to the hull (with
 *     a warning) when the depth model is unavailable.
 *  4. Gaussian-smoothed occupancy → marching cubes (./marchingCubes.ts) →
 *     Taubin smoothing → normals (./meshOps.ts); the voxel step grows when the
 *     triangle cap would be exceeded.
 *  5. Vertex colours from the views, visibility-aware (./color.ts).
 *  6. Rescale: longest side 2, centred.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { I18nText, Mask, Progress, RGBAImage, ViewId } from '../types';
import { throwIfAborted } from '../types';
import { LocalizedError } from '../errors';
import { yieldToPaint } from '../yield';
import {
  constrainsDepth,
  estimateObjectBox,
  prepareView,
  viewProjection,
  type PixelBox,
  type PreparedView,
} from './frame';
import { applyCarve, carveTargets, silhouetteDepth, type ViewDepth } from './depthCarve';
import { colorSource, colorVerticesSteps } from './color';
import { marchingCubesSteps, type IsoMesh } from './marchingCubes';
import { buildAdjacency, fitToFrame, taubinSmoothSteps, vertexNormals } from './meshOps';
import { macrotask, runSliced, type Steps } from './steps';
import { buildHullSteps, countSurfaceCellsSteps, createGrid, dilationRadius, downsampleSteps, gaussianBlur3DSteps, type Grid } from './volume';
import {
  DEFAULT_FUSION_OPTIONS,
  type DepthSource,
  type FusionContext,
  type FusionInfo,
  type FusionOptions,
  type FusionResult,
  type FusionViewInput,
} from './types';

export const FUSION_VIEW_NAMES: Record<ViewId, I18nText> = {
  front: { tr: 'ön', en: 'front' },
  back: { tr: 'arka', en: 'back' },
  left: { tr: 'sol', en: 'left' },
  right: { tr: 'sağ', en: 'right' },
  top: { tr: 'üst', en: 'top' },
  bottom: { tr: 'alt', en: 'bottom' },
};

export const FUSION_TEXT = {
  prepare: { tr: 'Görünümler hizalanıyor…', en: 'Aligning the views…' },
  hull: { tr: 'Görsel kabuk oyuluyor…', en: 'Carving the visual hull…' },
  carve: { tr: 'Derinlikle oyuluyor…', en: 'Carving with depth…' },
  smoothVolume: { tr: 'Hacim yumuşatılıyor…', en: 'Smoothing the volume…' },
  surface: { tr: 'Yüzey çıkarılıyor (marching cubes)…', en: 'Extracting the surface (marching cubes)…' },
  smoothMesh: { tr: 'Mesh yumuşatılıyor…', en: 'Smoothing the mesh…' },
  color: { tr: 'Renkler görünümlerden aktarılıyor…', en: 'Projecting colours from the views…' },
  finish: { tr: 'Tamamlanıyor…', en: 'Finishing…' },
  depthUnavailable: {
    tr: 'Derinlik modeli kullanılamadı; yalnız siluetler kullanılıyor',
    en: 'Depth model unavailable; using the silhouettes only',
  },
  noFront: {
    tr: 'Ön görünümde nesne bulunamadı. Saydam arka planlı ya da düz renk arka planlı bir görsel kullanın.',
    en: 'No subject found in the front view. Use an image with a transparent or plain single-colour background.',
  },
  needViews: {
    tr: 'Çok görünümlü birleştirme için ön görünüme ek olarak en az bir görünüm (arka, sol, sağ, üst veya alt) gerekir.',
    en: 'Multi-view fusion needs at least one view besides the front (back, left, right, top or bottom).',
  },
  empty: {
    tr: 'Görünümler örtüşmüyor: birleştirilen hacim boş kaldı. Tüm görünümlerin aynı nesneyi aynı duruşta gösterdiğini kontrol edin ya da "Toleranslı" kabuk modunu deneyin.',
    en: 'The views do not overlap: the fused volume is empty. Check that every view shows the same subject in the same pose, or try the "Tolerant" hull mode.',
  },
} satisfies Record<string, I18nText>;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Options with every field defined and clamped to its documented range. */
export function sanitizeFusionOptions(o: Partial<FusionOptions>): FusionOptions {
  const d = DEFAULT_FUSION_OPTIONS;
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    resolution: Math.round(clamp(num(o.resolution, d.resolution), 16, 320)),
    hull: o.hull === 'strict' ? 'strict' : o.hull === 'tolerant' ? 'tolerant' : d.hull,
    tolerance: clamp(num(o.tolerance, d.tolerance), 0, 0.1),
    defaultDepth: clamp(num(o.defaultDepth, d.defaultDepth), 0.05, 3),
    depthStrength: clamp(num(o.depthStrength, d.depthStrength), 0, 1),
    depthFit: o.depthFit === 'ray' ? 'ray' : o.depthFit === 'object' ? 'object' : d.depthFit,
    smoothness: clamp(num(o.smoothness, d.smoothness), 0, 4),
    smoothIterations: Math.round(clamp(num(o.smoothIterations, d.smoothIterations), 0, 100)),
    colorSharpness: clamp(num(o.colorSharpness, d.colorSharpness), 0.5, 32),
    maxTriangles: Math.round(clamp(num(o.maxTriangles, d.maxTriangles), 1000, 5_000_000)),
  };
}

/** Crop of a view around its silhouette (margin included); pixels outside the mask are transparent. */
export function cropView(view: PreparedView, marginFraction = 0.06): { image: RGBAImage; mask: Mask; rect: PixelBox } {
  const { image, mask, bbox } = view;
  const m = Math.round(marginFraction * Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0)) + 2;
  const rect = {
    x0: Math.max(0, bbox.x0 - m),
    y0: Math.max(0, bbox.y0 - m),
    x1: Math.min(image.width, bbox.x1 + m),
    y1: Math.min(image.height, bbox.y1 + m),
  };
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const px = new Uint8ClampedArray(w * h * 4);
  const md = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y + rect.y0) * image.width + x + rect.x0, d = y * w + x;
      const on = mask.data[s];
      md[d] = on;
      px[d * 4] = image.data[s * 4];
      px[d * 4 + 1] = image.data[s * 4 + 1];
      px[d * 4 + 2] = image.data[s * 4 + 2];
      px[d * 4 + 3] = on ? image.data[s * 4 + 3] : 0;
    }
  return { image: { width: w, height: h, data: px }, mask: { width: w, height: h, data: md }, rect };
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

const joinLabel = (a: I18nText, b: I18nText, sep = ' · '): I18nText => ({ tr: `${a.tr}${sep}${b.tr}`, en: `${a.en}${sep}${b.en}` });

/**
 * Least dilation (world units) of the views whose silhouettes bound the hull
 * along `axis`: every silhouette-bounded hull entry lies at least that far in
 * front of the true one (0 in strict mode).
 */
function hullSlack(views: PreparedView[], size: readonly [number, number, number], axis: number, o: FusionOptions): number {
  let slack = Infinity;
  for (const u of views) {
    const p = viewProjection(u, size);
    const pxPerWorld = p.ua === axis ? Math.abs(p.su) : p.va === axis ? Math.abs(p.sv) : 0;
    if (!(pxPerWorld > 0)) continue;
    slack = Math.min(slack, dilationRadius(u, o) / pxPerWorld);
  }
  return Number.isFinite(slack) ? slack : 0;
}

/** Surface extraction under the triangle cap: the voxel step grows until the mesh fits. */
function* extractCapped(field: Float32Array, grid: Grid, maxTriangles: number): Steps<{ mesh: IsoMesh; field: Float32Array; grid: Grid; step: number }> {
  // ≈ 2 triangles per surface cell; a coarser step divides the count by step².
  const cells = yield* countSurfaceCellsSteps(field, grid.dims);
  let step = 1;
  while (step < 16 && (2 * cells) / (step * step) > maxTriangles) step++;
  for (;;) {
    const d = yield* downsampleSteps(field, grid, step);
    const mesh = yield* marchingCubesSteps(d.field, d.grid.dims, 0.5, d.grid.origin, d.grid.spacing);
    if (mesh.indices.length / 3 <= maxTriangles || step >= 16) return { mesh, field: d.field, grid: d.grid, step };
    step++;
  }
}

export async function reconstructFromViews(
  inputs: FusionViewInput[],
  options: Partial<FusionOptions>,
  ctx: FusionContext,
): Promise<FusionResult> {
  const o = sanitizeFusionOptions(options);
  const { signal } = ctx;
  const pause = ctx.yieldControl ?? yieldToPaint;
  const warnings: I18nText[] = [];
  // Once depth failed, every later label carries the warning (the progress line is the only channel).
  const label = (l: I18nText): I18nText => (warnings.length ? joinLabel(l, warnings[0], ' — ') : l);
  const stage = async (l: I18nText, ratio: number) => {
    throwIfAborted(signal);
    ctx.onProgress({ label: label(l), ratio });
    await pause();
    throwIfAborted(signal);
  };
  // Long stages run in slices: the event loop (Cancel / Esc) gets a turn at least every sliceMs.
  const tick = ctx.yieldControl ?? macrotask;
  const between = async () => {
    throwIfAborted(signal);
    await tick();
    throwIfAborted(signal);
  };
  const sliceMs = Math.max(0, ctx.sliceMs ?? 30);
  const sliced = <T>(steps: Steps<T>) => runSliced(steps, sliceMs, between);

  // 1. Normalisation.
  await stage(FUSION_TEXT.prepare, 0.02);
  const front = inputs.find((v) => v.id === 'front');
  const frontView = front ? prepareView(front) : null;
  if (!frontView) throw new LocalizedError(FUSION_TEXT.noFront);
  const views: PreparedView[] = [frontView];
  const seen = new Set<ViewId>(['front']);
  for (const input of inputs) {
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    await between();
    const v = prepareView(input);
    if (v) views.push(v);
  }
  if (views.length < 2) throw new LocalizedError(FUSION_TEXT.needViews);
  const box = estimateObjectBox(views, o.defaultDepth);
  // Empty margin for the blur (the hull itself is clipped to the box).
  const pad = Math.ceil(3 * o.smoothness) + 3;
  const grid = createGrid(box.size, o.resolution, pad);

  // 2. Visual hull.
  await stage(FUSION_TEXT.hull, 0.06);
  const field = await sliced(buildHullSteps(views, box, grid, o));

  // 3. Depth refinement.
  const depthFrom: Partial<Record<ViewId, DepthSource>> = {};
  const depths = new Map<ViewId, ViewDepth>();
  if (ctx.estimateDepth && o.depthStrength > 0) {
    const candidates = views.filter((v) => v.maskSource !== 'none');
    for (let i = 0; i < candidates.length; i++) {
      const view = candidates[i];
      const name = FUSION_VIEW_NAMES[view.id];
      const head: I18nText = { tr: `Derinlik: ${name.tr} (${i + 1}/${candidates.length})`, en: `Depth: ${name.en} (${i + 1}/${candidates.length})` };
      const r0 = 0.1 + (0.5 * i) / candidates.length;
      await stage(head, r0);
      const crop = cropView(view);
      try {
        const depth = await ctx.estimateDepth(
          { view: view.id, image: crop.image, mask: crop.mask, rect: crop.rect },
          {
            signal,
            onProgress: (p: Progress) => ctx.onProgress({
              label: label(joinLabel(head, p.label)),
              ratio: r0 + (0.5 / candidates.length) * (p.ratio ?? 0),
            }),
          },
        );
        throwIfAborted(signal);
        depths.set(view.id, { depth, rect: crop.rect });
        depthFrom[view.id] = 'model';
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        // Download / backend failures repeat for every view: stop asking.
        warnings.push(FUSION_TEXT.depthUnavailable);
        if (e instanceof LocalizedError) warnings.push(e.i18n);
        else if (e instanceof Error && e.message) warnings.push({ tr: e.message, en: e.message });
        ctx.onProgress({ label: label(head), ratio: r0 });
        break;
      }
    }
  }
  // Nothing measures the depth of a front/back-only set: round it like a balloon.
  if (!constrainsDepth(views)) {
    for (const view of views) {
      if (depths.has(view.id)) continue;
      const crop = cropView(view, 0);
      depths.set(view.id, { depth: silhouetteDepth(crop.mask), rect: crop.rect });
      depthFrom[view.id] = 'silhouette';
    }
  }
  for (const v of views) depthFrom[v.id] ??= 'none';

  if (depths.size > 0 && o.depthStrength > 0) {
    await stage(FUSION_TEXT.carve, 0.62);
    // Model depth has no scale: measure it against a hull that constrains depth. The silhouette
    // balloon (and any depth of a front/back-only set) keeps the assumed near-half range.
    const hullHasDepth = constrainsDepth(views);
    // Every target is computed from the uncarved hull before any carving (order-independent, no copy).
    const plans: { proj: ReturnType<typeof viewProjection>; targets: Float32Array }[] = [];
    for (const v of views) {
      if (!depths.has(v.id)) continue;
      const proj = viewProjection(v, box.size);
      const targets = carveTargets(field, grid, proj, v.mask, depths.get(v.id)!, {
        strength: o.depthStrength,
        fit: o.depthFit,
        halfExtent: box.size[proj.wa] / 2,
        calibrate: hullHasDepth && depthFrom[v.id] === 'model',
        hullSlack: hullSlack(views, box.size, proj.wa, o),
      });
      plans.push({ proj, targets });
      await between();
    }
    for (const { proj, targets } of plans) {
      applyCarve(field, grid, proj, targets);
      await between();
    }
  }

  // 4. Surface.
  await stage(FUSION_TEXT.smoothVolume, 0.68);
  await sliced(gaussianBlur3DSteps(field, grid.dims, o.smoothness));
  await stage(FUSION_TEXT.surface, 0.74);
  const ext = await sliced(extractCapped(field, grid, o.maxTriangles));
  const { positions, indices } = ext.mesh;
  if (indices.length === 0) throw new LocalizedError(FUSION_TEXT.empty);
  await stage(FUSION_TEXT.smoothMesh, 0.84);
  const adj = buildAdjacency(positions.length / 3, indices);
  await between();
  await sliced(taubinSmoothSteps(positions, adj, o.smoothIterations));
  const normals = vertexNormals(positions, indices);

  // 5. Colour.
  await stage(FUSION_TEXT.color, 0.9);
  const sources = [];
  for (const v of views) {
    sources.push(colorSource(v, viewProjection(v, box.size), ext.field, ext.grid));
    await between();
  }
  const colors = await sliced(colorVerticesSteps(positions, normals, adj, sources, ext.grid, {
    sharpness: o.colorSharpness,
    tolerance: 2.5 * ext.grid.spacing,
  }));

  // 6. Shared frame.
  await stage(FUSION_TEXT.finish, 0.97);
  fitToFrame(positions, 2);
  const info: FusionInfo = {
    views: views.map((v) => v.id),
    box: { width: box.size[0], height: box.size[1], depth: box.size[2], depthFrom: box.depthFrom },
    grid: [grid.dims[0], grid.dims[1], grid.dims[2]],
    step: ext.step,
    depth: depthFrom,
    warnings,
    triangles: indices.length / 3,
  };
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.userData.multiview = info;
  return { geometry, info };
}
