/**
 * Options for turning a depth map into a mesh. Shared by every driver that
 * returns `kind: 'depth'`; rendered in the UI from MESH_PARAMS.
 */
import type { ParamSpec, ParamValues } from '../types';

export type MeshMode = 'relief' | 'solid' | 'double';

export interface MeshOptions {
  /** Grid vertices along the longest image side (e.g. 64..512). */
  resolution: number;
  /** Max displacement as a fraction of the longest side (0..1). */
  depthScale: number;
  /**
   * relief: open height-field surface (front only).
   * solid:  front surface + side walls + flat back → watertight, 3D-printable.
   * double: front surface mirrored to the back (pillow-like closed body).
   */
  mode: MeshMode;
  /** Depth smoothing radius in grid cells (0 = off). */
  smoothing: number;
  /** Drop triangles outside the foreground mask (transparent PNG areas). */
  useMask: boolean;
  /** Drop triangles spanning a depth jump larger than `discontinuity` (0..1); 0 disables. Relief mode only. */
  discontinuity: number;
  /** Flip near/far. */
  invert: boolean;
  /**
   * Fraction of the longest side. solid: flat base under the surface;
   * double: rim band between front and mirrored back. Unused in relief mode.
   */
  baseThickness: number;
  /** Gamma applied to depth (d^gamma) to exaggerate / flatten relief. */
  gamma: number;
}

/**
 * An image area with fine relief (a face with its ears, a hand), in pixels of
 * the depth map. The mesh builder keeps its detail: smoothing is faded out
 * there and the grid is refined inside it.
 */
export interface DetailRegion {
  kind: 'face' | 'hand';
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A depth map that carries its detail regions (set by the human-detail
 * refinement; an extra property, so plain DepthMap consumers ignore it and
 * spreads / the depth editor's copies keep or drop it harmlessly).
 */
export interface DetailedDepth {
  detail?: DetailRegion[];
}

export const DEFAULT_MESH_OPTIONS: MeshOptions = {
  resolution: 256,
  depthScale: 0.25,
  mode: 'relief',
  smoothing: 1,
  useMask: true,
  discontinuity: 0,
  invert: false,
  baseThickness: 0.02,
  gamma: 1,
};

export const MESH_PARAMS: ParamSpec[] = [
  {
    kind: 'select',
    key: 'mode',
    label: { tr: 'Mesh tipi', en: 'Mesh type' },
    default: DEFAULT_MESH_OPTIONS.mode,
    options: [
      { value: 'relief', label: { tr: 'Rölyef (açık yüzey)', en: 'Relief (open surface)' } },
      { value: 'solid', label: { tr: 'Katı (düz taban, 3D baskı)', en: 'Solid (flat back, printable)' } },
      { value: 'double', label: { tr: 'Çift yüz (aynalı arka)', en: 'Double-sided (mirrored back)' } },
    ],
  },
  {
    kind: 'number',
    key: 'resolution',
    label: { tr: 'Çözünürlük', en: 'Resolution' },
    hint: { tr: 'Uzun kenardaki vertex sayısı', en: 'Vertices along the longest side' },
    min: 32, max: 512, step: 16, default: DEFAULT_MESH_OPTIONS.resolution,
  },
  {
    kind: 'number',
    key: 'depthScale',
    label: { tr: 'Derinlik', en: 'Depth' },
    min: 0, max: 1, step: 0.01, default: DEFAULT_MESH_OPTIONS.depthScale,
  },
  {
    kind: 'number',
    key: 'gamma',
    label: { tr: 'Derinlik eğrisi (gamma)', en: 'Depth curve (gamma)' },
    min: 0.3, max: 3, step: 0.05, default: DEFAULT_MESH_OPTIONS.gamma,
  },
  {
    kind: 'number',
    key: 'smoothing',
    label: { tr: 'Yumuşatma', en: 'Smoothing' },
    min: 0, max: 8, step: 1, default: DEFAULT_MESH_OPTIONS.smoothing,
  },
  {
    kind: 'boolean',
    key: 'useMask',
    label: { tr: 'Saydam alanları kes', en: 'Cut transparent areas' },
    default: DEFAULT_MESH_OPTIONS.useMask,
  },
  {
    kind: 'number',
    key: 'discontinuity',
    label: { tr: 'Kenar kopma eşiği', en: 'Edge tear threshold' },
    hint: {
      tr: 'Derinlik sıçramalarında üçgenleri kaldırır (0 = kapalı, yalnızca rölyef)',
      en: 'Removes triangles across depth jumps (0 = off, relief only)',
    },
    min: 0, max: 0.5, step: 0.01, default: DEFAULT_MESH_OPTIONS.discontinuity,
  },
  {
    kind: 'number',
    key: 'baseThickness',
    label: { tr: 'Taban kalınlığı', en: 'Base thickness' },
    hint: {
      tr: 'Katı modda taban, çift yüz modunda kenar kalınlığı',
      en: 'Solid: base under the surface; double-sided: rim thickness',
    },
    min: 0, max: 0.2, step: 0.005, default: DEFAULT_MESH_OPTIONS.baseThickness,
  },
  {
    kind: 'boolean',
    key: 'invert',
    label: { tr: 'Derinliği ters çevir', en: 'Invert depth' },
    default: DEFAULT_MESH_OPTIONS.invert,
  },
];

export function meshOptionsFromParams(p: ParamValues): MeshOptions {
  const d = DEFAULT_MESH_OPTIONS;
  const num = (k: keyof MeshOptions, def: number) => (typeof p[k] === 'number' ? (p[k] as number) : def);
  const bool = (k: keyof MeshOptions, def: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : def);
  const mode = p.mode === 'solid' || p.mode === 'double' || p.mode === 'relief' ? p.mode : d.mode;
  return {
    resolution: num('resolution', d.resolution),
    depthScale: num('depthScale', d.depthScale),
    mode,
    smoothing: num('smoothing', d.smoothing),
    useMask: bool('useMask', d.useMask),
    discontinuity: num('discontinuity', d.discontinuity),
    invert: bool('invert', d.invert),
    baseThickness: num('baseThickness', d.baseThickness),
    gamma: num('gamma', d.gamma),
  };
}
