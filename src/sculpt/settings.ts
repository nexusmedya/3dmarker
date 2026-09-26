/** Brush settings validation and the keyboard-step helpers shared by the session and the panel. */
import { BRUSH_IDS, DEFAULT_BRUSH, type BrushId, type BrushSettings } from './types';
import { isFalloff } from './falloff';

export const RADIUS_MIN = 0.01;
export const RADIUS_MAX = 0.6;
/** Multiplicative radius step for [ / ]. */
export const RADIUS_STEP = 1.15;
export const STRENGTH_STEP = 0.05;

export function isBrushId(v: unknown): v is BrushId {
  return typeof v === 'string' && (BRUSH_IDS as string[]).includes(v);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Defaults overlaid with every valid field of `v` (numbers clamped). */
export function sanitizeBrushSettings(v: unknown, base: BrushSettings = DEFAULT_BRUSH): BrushSettings {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const bool = (x: unknown): x is boolean => typeof x === 'boolean';
  return {
    brush: isBrushId(src.brush) ? src.brush : base.brush,
    radius: num(src.radius) ? clamp(src.radius, RADIUS_MIN, RADIUS_MAX) : base.radius,
    strength: num(src.strength) ? clamp(src.strength, 0, 1) : base.strength,
    falloff: isFalloff(src.falloff) ? src.falloff : base.falloff,
    invert: bool(src.invert) ? src.invert : base.invert,
    symmetryX: bool(src.symmetryX) ? src.symmetryX : base.symmetryX,
    lockBoundary: bool(src.lockBoundary) ? src.lockBoundary : base.lockBoundary,
  };
}

export function stepRadius(radius: number, dir: 1 | -1): number {
  return round3(clamp(dir > 0 ? radius * RADIUS_STEP : radius / RADIUS_STEP, RADIUS_MIN, RADIUS_MAX));
}

export function stepStrength(strength: number, dir: 1 | -1): number {
  return round3(clamp(strength + dir * STRENGTH_STEP, 0, 1));
}
