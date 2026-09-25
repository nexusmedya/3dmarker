/**
 * Errors shared by drivers and the UI. The UI shows `i18n` in the current
 * language (detected by shape, see src/app/format.ts errorToText).
 */
import type { I18nText } from './types';

/** Error with a bilingual message; `message` carries both languages for plain consumers. */
export class LocalizedError extends Error {
  constructor(readonly i18n: I18nText) {
    super(`${i18n.tr} / ${i18n.en}`);
    this.name = 'LocalizedError';
  }
}
