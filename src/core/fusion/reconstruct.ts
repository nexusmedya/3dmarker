/**
 * Multi-view reconstruction: front + any of back / left / right / top /
 * bottom → closed, vertex-coloured mesh in the shared frame.
 *
 *  1. Normalise: per-view silhouette + bbox (./frame.ts), registration of
 *     every extra view to the front by its silhouette profiles (./align.ts:
 *     scale / offset, cut edges, per-view trust), object box W × H × D.
 *  2. Soft visual hull on a voxel grid (./volume.ts; the back silhouette is
 *     not intersected — it mirrors the front's), then the thin-part guard
 *     (./guard.ts) floors the parts the front shows as thin.
 *  3. Optional depth refinement: each view's monocular depth carves in front
 *     of its estimated surface (./depthCarve.ts, anchored calibration, never
 *     below the guard); falls back to the hull (with a warning) when the
 *     depth model is unavailable, rounding the thin parts no profile view
 *     measures (GuardField.capHidden: T-pose arms seen end-on by the sides).
 *  4. Gaussian-smoothed occupancy → marching cubes (./marchingCubes.ts) →
 *     Taubin smoothing → normals (./meshOps.ts); the voxel step grows when the
 *     triangle cap would be exceeded.
 *  5. Vertex colours from the views (./color.ts): visibility from depth buffers
 *     of the smoothed mesh itself, colours eroded away from silhouette and
 *     occlusion edges, per-view exposure matched to the front, samples the
 *     better-supported views contradict dropped (photo-consistency), seams
 *     feathered; on thin parts the front / back colour wins where a side / cap
 *     view sees behind.
 *  6. Rescale: longest side 2, centred. `info.report` (also
 *     geometry.userData.fusion) tells per view how it was placed and trusted.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { I18nText, Mask, Progress, RGBAImage, ViewId, ViewTrust } from '../types';
import { throwIfAborted } from '../types';
import { LocalizedError } from '../errors';
import { yieldToPaint } from '../yield';
import { alignNote, registerViewsSteps } from './align';
import {
  constrainsDepth,
  estimateObjectBox,
  prepareView,
  viewProjection,
  type PixelBox,
  type PreparedView,
} from './frame';
import { applyCarve, carveTargets, silhouetteDepth, type ViewDepth } from './depthCarve';
import { colorSourceSteps, colorVerticesSteps } from './color';
import { buildGuardSteps, GUARD_FILL, type GuardField } from './guard';
import { marchingCubesSteps, type IsoMesh } from './marchingCubes';
import { buildAdjacency, fitToFrame, taubinSmoothSteps, vertexNormals } from './meshOps';
import { drain, macrotask, runSliced, type Steps } from './steps';
import { buildHullPlanesSteps, countSurfaceCellsSteps, createGrid, dilationRadius, downsampleSteps, gaussianBlur3DSteps, type Grid } from './volume';
import {
  DEFAULT_FUSION_OPTIONS,
  type AlignNote,
  type DepthSource,
  type FusionContext,
  type FusionInfo,
  type FusionOptions,
  type FusionResult,
  type FusionViewInput,
  type ViewAlignment,
  type ViewReport,
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
  guard: { tr: 'İnce parçalar korunuyor…', en: 'Protecting thin parts…' },
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
  depthOffline: {
    tr: 'Derinlik modeli indirilemedi (bağlantı yok); model yalnız siluetlerden oluşturuldu. Bağlantı gelince yeniden oluşturarak derinlikle iyileştirebilirsiniz.',
    en: 'The depth model could not be downloaded (no connection); the model was built from the silhouettes only. Rebuild once you are online to refine it with depth.',
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
  // Per-view registration warnings; {view} = FUSION_VIEW_NAMES[id] (see viewWarning).
  viewCropped: {
    tr: '{view} görünümünde figür kenarda kesik; eksik kısım diğer görünümlerden tamamlanıyor',
    en: 'The subject is cut off at the edge of the {view} view; the missing part is filled from the other views',
  },
  viewStretched: {
    tr: '{view} görünümü kenarda kesik ve ölçeği bulunamadı; hizalama yaklaşık',
    en: 'The {view} view is cut off at the edge and its scale could not be found; alignment is approximate',
  },
  viewColorOnly: { tr: '{view} görünümü yalnızca renk için kullanıldı', en: 'The {view} view was used for colour only' },
  viewWeak: {
    tr: '{view} görünümü ön görünümle otomatik hizalanamadı; çerçevesi olduğu gibi kullanıldı',
    en: 'The {view} view could not be aligned to the front automatically; its frame was used as is',
  },
  viewInconsistent: {
    tr: '{view} görünümü ön görünümle tam örtüşmüyor; ince parçalar korundu',
    en: 'The {view} view does not quite match the front; thin parts were protected',
  },
  viewMirrored: { tr: '{view} görünümü aynalanmış görünüyor', en: 'The {view} view looks mirrored' },
  viewWrongSlot: {
    tr: '{view} görünümü bir ön/arka görsel gibi görünüyor; yanlış yuvaya yüklenmiş olabilir. Yalnız renk için kullanıldı',
    en: 'The {view} view looks like a front/back image; it may be in the wrong slot. It was used for colour only',
  },
  viewFacing: {
    tr: '{view} görünümü ters yöne bakıyor olabilir; "Yatay aynala"yı deneyin',
    en: 'The {view} view may face the wrong way; try "Flip horizontally"',
  },
  viewDuplicate: {
    tr: '{view} görünümü ön görselle aynı görünüyor; yüz ve ön renkler arkaya geçmiş olabilir',
    en: 'The {view} view looks identical to the front; the face and front colours may appear on the back',
  },
  viewSameImage: {
    tr: '{view} görünümü başka bir yuvadaki görselle aynı; görsel yanlışlıkla bu yuvaya yüklenmiş olabilir. Bu yönden çekilmiş görseli yükleyin ya da güveni "Yalnız renk"/"Kapalı" yapın',
    en: 'The {view} view is the same image as another slot\'s; it may have been uploaded here by mistake. Upload the image taken from this side or set its trust to "Colour only"/"Off"',
  },
  viewExtent: {
    tr: '{view} görünümünün boyutları bu yuvaya ya da diğer görünümlere uymuyor (üst/alt görsel yan yuvada ya da tersi olabilir); yalnız renk için kullanıldı. Doğru yuvaya yükleyin ya da güveni "Kapalı" yapın',
    en: 'The proportions of the {view} view do not fit its slot or the other views (a top/bottom image in a side slot, or the other way round?); it was used for colour only. Upload it into the right slot or set its trust to "Off"',
  },
  viewFeatureless: {
    tr: '{view} görünümünde ayırt edici ayrıntı yok (düz bir leke ya da siluet); ön görünümle eşleştirilemez. Doğru görseli yükleyin ya da güveni "Yalnız renk"/"Kapalı" yapın',
    en: 'The {view} view has no distinguishing detail (a plain blob or silhouette); it cannot be matched to the front. Upload the right image or set its trust to "Colour only"/"Off"',
  },
  viewPoor: {
    tr: '{view} görünümü ön görünümle uyuşmuyor (%{score}); yanlış yuvaya yüklenmiş olabilir. Hizala panelinden düzeltin ya da güveni "Yalnız renk"/"Kapalı" yapın',
    en: 'The {view} view does not match the front ({score} %); it may be in the wrong slot. Fix it in the Align panel or set its trust to "Colour only"/"Off"',
  },
} satisfies Record<string, I18nText>;

/** A per-view warning with the view's name (and any other {key}) filled in. */
export function viewWarning(text: I18nText, id: ViewId, vars: Record<string, string> = {}): I18nText {
  const name = FUSION_VIEW_NAMES[id];
  const sub = (t: string, view: string, lang: string) => {
    const out = t.replace(/\{(\w+)\}/g, (m, k: string) => (k === 'view' ? view : vars[k] ?? m));
    // A sentence may start with the (lower-case) view name.
    return out.charAt(0).toLocaleUpperCase(lang) + out.slice(1);
  };
  return { tr: sub(text.tr, name.tr, 'tr'), en: sub(text.en, name.en, 'en') };
}

/**
 * The depth model could not be downloaded (a network failure): the fusion
 * says so in its own words (the drivers' generic advice to switch to an
 * offline driver would throw the views away). Thrown by depth estimators.
 */
export class DepthOfflineError extends LocalizedError {
  constructor() {
    super(FUSION_TEXT.depthOffline);
    this.name = 'DepthOfflineError';
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Share of a view's carve held by the thin-part guard from which the view counts as inconsistent with the front. */
export const INCONSISTENT_SHARE = 0.25;

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
    hullBack: o.hullBack === 'intersect' ? 'intersect' : o.hullBack === 'exclude' ? 'exclude' : d.hullBack,
    calibration: o.calibration === 'envelope' ? 'envelope' : o.calibration === 'anchored' ? 'anchored' : d.calibration,
    guard: clamp(num(o.guard, d.guard), 0, 0.15),
    align: o.align === 'bbox' ? 'bbox' : o.align === 'auto' ? 'auto' : d.align,
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

/**
 * Stage 1 without the yields: the prepared views (front first, duplicates
 * and trust 'off' dropped, empty silhouettes skipped), registered to the
 * front. Throws noFront. Deterministic, so tests can reproduce the fusion's
 * views (see testing.ts reconstructWithField).
 */
export function prepareFusionViews(inputs: FusionViewInput[], o: Pick<FusionOptions, 'align'>): { views: PreparedView[]; alignments: ViewAlignment[] } {
  return drain(prepareFusionViewsSteps(inputs, o));
}

/** prepareFusionViews as cooperative steps (a yield after every view's preparation and registration). */
export function* prepareFusionViewsSteps(inputs: FusionViewInput[], o: Pick<FusionOptions, 'align'>): Steps<{ views: PreparedView[]; alignments: ViewAlignment[] }> {
  const front = inputs.find((v) => v.id === 'front');
  const frontView = front ? prepareView(front) : null;
  if (!frontView) throw new LocalizedError(FUSION_TEXT.noFront);
  yield;
  const views: PreparedView[] = [frontView];
  const seen = new Set<ViewId>(['front']);
  for (const input of inputs) {
    if (seen.has(input.id) || input.align?.trust === 'off') continue;
    seen.add(input.id);
    const v = prepareView(input);
    if (v) views.push(v);
    yield;
  }
  const alignments = yield* registerViewsSteps(views, { mode: o.align });
  return { views, alignments };
}

/** Slot notes that explain a poor score themselves (each has its own warning). */
const EXPLAINED: readonly AlignNote['code'][] = ['wrongSlot', 'sameImage', 'extent', 'featureless'];

/** A view that scores poor for no reason another warning already names (see registrationWarnings). */
function unexplainedPoor(a: ViewAlignment): boolean {
  return a.level === 'poor' && a.status !== 'weak' && a.trust !== 'color' && !a.notes.some((n) => EXPLAINED.includes(n.code));
}

/** Registration warnings of a view, in note order (one per code). */
function registrationWarnings(a: ViewAlignment): I18nText[] {
  const out: I18nText[] = [];
  const codes = new Set(a.notes.map((n) => n.code));
  if (codes.has('sameImage')) out.push(viewWarning(FUSION_TEXT.viewSameImage, a.id));
  if (codes.has('wrongSlot')) out.push(viewWarning(FUSION_TEXT.viewWrongSlot, a.id));
  if (codes.has('extent')) out.push(viewWarning(FUSION_TEXT.viewExtent, a.id));
  if (codes.has('featureless')) out.push(viewWarning(FUSION_TEXT.viewFeatureless, a.id));
  if (codes.has('facing')) out.push(viewWarning(FUSION_TEXT.viewFacing, a.id));
  if (codes.has('duplicate')) out.push(viewWarning(FUSION_TEXT.viewDuplicate, a.id));
  if (unexplainedPoor(a)) out.push(viewWarning(FUSION_TEXT.viewPoor, a.id, { score: String(a.score) }));
  if (codes.has('cropped')) out.push(viewWarning(FUSION_TEXT.viewCropped, a.id));
  if (a.status === 'stretched') out.push(viewWarning(FUSION_TEXT.viewStretched, a.id));
  if (a.status === 'weak') out.push(viewWarning(FUSION_TEXT.viewWeak, a.id));
  if (codes.has('mirrored')) out.push(viewWarning(FUSION_TEXT.viewMirrored, a.id));
  // A wrong-slot / same-image / extent view says why it is colour-only itself.
  if (a.trust === 'color' && !codes.has('wrongSlot') && !codes.has('sameImage') && !codes.has('extent')) out.push(viewWarning(FUSION_TEXT.viewColorOnly, a.id));
  return out;
}

export async function reconstructFromViews(
  inputs: FusionViewInput[],
  options: Partial<FusionOptions>,
  ctx: FusionContext,
): Promise<FusionResult> {
  const o = sanitizeFusionOptions(options);
  const { signal } = ctx;
  const pause = ctx.yieldControl ?? yieldToPaint;
  // Warnings reach the user through the report (info.report) after the run; progress labels stay plain
  // (a warning appended to every stage label pushed the stage itself out of sight).
  const warnings: I18nText[] = [];
  const stage = async (l: I18nText, ratio: number) => {
    throwIfAborted(signal);
    ctx.onProgress({ label: l, ratio });
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

  // 1. Normalisation and registration.
  await stage(FUSION_TEXT.prepare, 0.02);
  const { views, alignments } = await sliced(prepareFusionViewsSteps(inputs, o));
  await between();
  if (views.length < 2) throw new LocalizedError(FUSION_TEXT.needViews);
  const shapeViews = views.filter((v) => v.trust === 'full');
  const colorViews = views.filter((v) => v.trust !== 'off');
  for (const a of alignments) warnings.push(...registrationWarnings(a));
  const box = estimateObjectBox(shapeViews, o.defaultDepth);
  // Empty margin for the blur (the hull itself is clipped to the box).
  const pad = Math.ceil(3 * o.smoothness) + 3;
  const grid = createGrid(box.size, o.resolution, pad);

  // 2. Visual hull and the thin-part guard.
  await stage(FUSION_TEXT.hull, 0.06);
  const { field, planes } = await sliced(buildHullPlanesSteps(shapeViews, box, grid, { hull: o.hull, tolerance: o.tolerance, hullBack: o.hullBack }));
  ctx.inspect?.('hull', field, grid);
  let guard: GuardField | null = null;
  if (o.guard > 0) {
    await stage(FUSION_TEXT.guard, 0.08);
    guard = await sliced(buildGuardSteps(planes, box, grid, { delta: o.guard, rho: GUARD_FILL }));
    guard.applyFloor(field);
    ctx.inspect?.('guard', field, grid);
  }

  // 3. Depth refinement.
  const depthFrom: Partial<Record<ViewId, DepthSource>> = {};
  const depths = new Map<ViewId, ViewDepth>();
  if (ctx.estimateDepth && o.depthStrength > 0) {
    const candidates = shapeViews.filter((v) => v.maskSource !== 'none');
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
              label: joinLabel(head, p.label),
              ratio: r0 + (0.5 / candidates.length) * (p.ratio ?? 0),
            }),
          },
        );
        throwIfAborted(signal);
        depths.set(view.id, { depth, rect: crop.rect });
        depthFrom[view.id] = 'model';
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        // Download / backend failures repeat for every view: stop asking. Offline: one line of our own.
        // Other failures: the reason when it is localised (a missing model file, no Web Worker); a raw
        // error is for the console only.
        if (e instanceof DepthOfflineError) warnings.unshift(FUSION_TEXT.depthOffline);
        else {
          warnings.unshift(FUSION_TEXT.depthUnavailable);
          if (e instanceof LocalizedError) warnings.splice(1, 0, e.i18n);
          else console.warn('fusion: depth estimation failed', e);
        }
        ctx.onProgress({ label: joinLabel(head, warnings[0], ' — '), ratio: r0 });
        break;
      }
    }
  }
  // Nothing measures the depth of a front/back-only set: round it like a balloon.
  if (!constrainsDepth(shapeViews)) {
    for (const view of shapeViews) {
      if (depths.has(view.id)) continue;
      const crop = cropView(view, 0);
      depths.set(view.id, { depth: silhouetteDepth(crop.mask), rect: crop.rect });
      depthFrom[view.id] = 'silhouette';
    }
  }
  for (const v of views) depthFrom[v.id] ??= 'none';
  // No depth map at all (refinement off, or the model could not be loaded): round the thin parts whose
  // depth the profile views read off a bigger part behind them (T-pose arms would keep the chest's depth).
  if (depths.size === 0 && guard) guard.capHidden(field);

  const consistency: Partial<Record<ViewId, number>> = {};
  const inconsistent = new Set<ViewId>();
  if (depths.size > 0 && o.depthStrength > 0) {
    await stage(FUSION_TEXT.carve, 0.62);
    // Model depth has no scale: measure it against a hull that constrains depth. The silhouette
    // balloon (and any depth of a front/back-only set) keeps the assumed near-half range.
    const hullHasDepth = constrainsDepth(shapeViews);
    let hullVoxels = 0;
    for (let p = 0; p < field.length; p++) if (field[p] > 0.5) hullVoxels++;
    // Every target is computed from the uncarved hull before any carving (order-independent, no copy),
    // and so is every view's consistency: a dry run counts what the view alone would carve and what
    // the guard would hold (voxels a later view finds already carved would otherwise drop out of its
    // share and inflate the ratio of the last views). Only carves reaching half a voxel into a tube
    // count as blocked: grazing the rim is discretisation, not disagreement.
    const plans: { id: ViewId; proj: ReturnType<typeof viewProjection>; targets: Float32Array; consistency: number }[] = [];
    for (const v of shapeViews) {
      if (!depths.has(v.id)) continue;
      const proj = viewProjection(v, box.size);
      const targets = carveTargets(field, grid, proj, v.mask, depths.get(v.id)!, {
        strength: o.depthStrength,
        fit: o.depthFit,
        halfExtent: box.size[proj.wa] / 2,
        calibrate: hullHasDepth && depthFrom[v.id] === 'model',
        hullSlack: hullSlack(shapeViews, box.size, proj.wa, o),
        calibration: o.calibration,
      });
      const { carved, blocked, deep } = applyCarve(field, grid, proj, targets, guard, true);
      plans.push({ id: v.id, proj, targets, consistency: deep / Math.max(carved + blocked, 0.005 * hullVoxels) });
      await between();
    }
    for (const { id, proj, targets, consistency: c } of plans) {
      applyCarve(field, grid, proj, targets, guard);
      consistency[id] = c;
      if (c >= INCONSISTENT_SHARE) {
        inconsistent.add(id);
        warnings.push(viewWarning(FUSION_TEXT.viewInconsistent, id));
      }
      await between();
    }
    ctx.inspect?.('carve', field, grid);
  }

  // 4. Surface.
  await stage(FUSION_TEXT.smoothVolume, 0.68);
  await sliced(gaussianBlur3DSteps(field, grid.dims, o.smoothness));
  ctx.inspect?.('smooth', field, grid);
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
  for (const v of colorViews) {
    sources.push(await sliced(colorSourceSteps(v, viewProjection(v, box.size), null, ext.grid)));
    await between();
  }
  const colors = await sliced(colorVerticesSteps(positions, normals, adj, sources, ext.grid, {
    sharpness: o.colorSharpness,
    tolerance: 2.5 * ext.grid.spacing,
    // Visibility from the smoothed mesh's own depth buffers (not the voxel field it was extracted from).
    indices,
    // Thin parts take the front / back colour where the side / cap views see what lies behind them.
    thin: guard ? { support: (p, axis) => guard!.colorSupport(p, axis), gate: (p) => guard!.gateAt(p) } : undefined,
  }));

  // 6. Shared frame and the report.
  await stage(FUSION_TEXT.finish, 0.97);
  fitToFrame(positions, 2);
  const trust: Partial<Record<ViewId, ViewTrust>> = {};
  for (const v of views) trust[v.id] = v.trust;
  const reportViews: ViewReport[] = alignments.map((a) => {
    const notes: AlignNote[] = a.notes.slice();
    if (inconsistent.has(a.id)) notes.push({ code: 'inconsistent', text: { tr: 'Ön görünümle tam örtüşmüyor; ince parçalar korundu', en: 'Does not quite match the front; thin parts were protected' } });
    // The chip's explanation (its title) for a poor view: the first note.
    if (unexplainedPoor(a)) notes.unshift(alignNote('poor'));
    return {
      id: a.id,
      trust: a.trust,
      depth: depthFrom[a.id] ?? 'none',
      status: a.status,
      level: a.level,
      score: a.score,
      applied: a.applied,
      suggested: a.suggested,
      cut: a.cut,
      consistency: consistency[a.id] ?? null,
      notes,
    };
  });
  const info: FusionInfo = {
    views: views.map((v) => v.id),
    box: { width: box.size[0], height: box.size[1], depth: box.size[2], depthFrom: box.depthFrom },
    grid: [grid.dims[0], grid.dims[1], grid.dims[2]],
    step: ext.step,
    depth: depthFrom,
    warnings,
    triangles: indices.length / 3,
    alignment: alignments,
    trust,
    consistency,
    guardColumns: guard ? guard.columns : 0,
    report: { views: reportViews, warnings },
  };
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  geometry.userData.multiview = info;
  geometry.userData.fusion = info.report;
  return { geometry, info };
}
