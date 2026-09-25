/** Image type detection from magic bytes (the client's declared type is never trusted). */
import type { TripoImageMime } from './providers/tripo';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** PNG, JPEG or WEBP from the first ≥ 12 bytes; null for anything else. */
export function sniffImageMime(head: Uint8Array): TripoImageMime | null {
  if (startsWith(head, PNG)) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF <size:4> WEBP
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}
