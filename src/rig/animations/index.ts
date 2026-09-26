/** Built-in animation library: definitions + per-rig clip building. */
import type { RigDescriptor } from '../skeleton';
import type { RigClip } from '../types';
import { buildClip, canonicalAlignment } from './build';
import { CLIP_DEFS } from './library';

export { CLIP_DEFS } from './library';
export { buildClip, canonicalAlignment, CLIP_FPS } from './build';
export * from './dsl';

/** Every built-in clip, built for `rig` (≈ 50 ms). */
export function buildLibrary(rig: RigDescriptor): RigClip[] {
  const align = canonicalAlignment(rig);
  return CLIP_DEFS.map((def) => buildClip(def, rig, align));
}
