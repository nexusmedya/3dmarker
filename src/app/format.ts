/** Small formatting helpers: download names and error messages. */
import type { I18nText } from '../core/types';
import { exportFormatInfo, type ExportFormat } from '../core/export/exporters';

/** File name without its extension, sanitised for downloads. */
export function baseName(name: string): string {
  return name
    .replace(/\.[^./\\]*$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .trim();
}

/**
 * "<upload name>-<driver id>[-<suffix>].<ext>", e.g. "cat-depth-anything-v2-small.glb"
 * or "cat-depth-anything-v2-small-rigged.glb".
 */
export function modelFileName(sourceName: string, driverId: string, format: ExportFormat, suffix?: string): string {
  const base = baseName(sourceName) || '3dmarker';
  const tail = suffix ? `-${baseName(suffix)}` : '';
  return `${base}-${driverId}${tail}.${exportFormatInfo(format).ext}`;
}

/**
 * Bilingual text for any thrown value. Errors carrying an `i18n` {tr, en}
 * (the drivers' LocalizedError, ImageLoadError) keep both languages; other
 * errors show their message in both.
 */
export function errorToText(e: unknown): I18nText {
  if (e && typeof e === 'object') {
    const i18n = (e as { i18n?: unknown }).i18n as Partial<I18nText> | undefined;
    if (i18n && typeof i18n.tr === 'string' && typeof i18n.en === 'string') return { tr: i18n.tr, en: i18n.en };
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return { tr: msg, en: msg };
  }
  const s = typeof e === 'string' && e ? e : 'Unknown error';
  return { tr: s === 'Unknown error' ? 'Bilinmeyen hata' : s, en: s };
}

/** "1.2 s" / "850 ms" style duration. */
export function formatSeconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}
