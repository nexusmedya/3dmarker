/**
 * Brush falloff curves: weight of a vertex at normalised distance t = d / r
 * from the brush centre (1 at the centre, 0 at and beyond the rim).
 */
import type { Falloff } from './types';

export const FALLOFFS: Falloff[] = ['smooth', 'sphere', 'linear', 'sharp', 'constant'];

export function falloffWeight(falloff: Falloff, t: number): number {
  if (!(t < 1)) return 0; // also NaN
  const u = t <= 0 ? 0 : t;
  switch (falloff) {
    case 'smooth': // 1 - smoothstep: flat centre, soft rim (Blender "Smooth")
      return 1 - u * u * (3 - 2 * u);
    case 'sphere':
      return Math.sqrt(1 - u * u);
    case 'linear':
      return 1 - u;
    case 'sharp':
      return (1 - u) * (1 - u);
    case 'constant':
      return 1;
  }
}

export function isFalloff(v: unknown): v is Falloff {
  return typeof v === 'string' && (FALLOFFS as string[]).includes(v);
}
