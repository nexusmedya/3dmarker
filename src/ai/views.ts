/** Names of the six views (re-exported by ./generate as VIEW_LABELS). */
import type { I18nText, ViewId } from '../core/types';

export const VIEW_LABELS: Record<ViewId, I18nText> = {
  front: { tr: 'Ön', en: 'Front' },
  back: { tr: 'Arka', en: 'Back' },
  left: { tr: 'Sol', en: 'Left' },
  right: { tr: 'Sağ', en: 'Right' },
  top: { tr: 'Üst', en: 'Top' },
  bottom: { tr: 'Alt', en: 'Bottom' },
};
