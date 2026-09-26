/** Small shared types of the AI UI (the shell holds the state, these components only render it). */
import type { Mask, RGBAImage, ViewAlign, ViewId } from '../../core/types';

export type AiJobStatus = 'idle' | 'running' | 'error';

/** An extra view shown in the views grid. */
export interface ViewSlotInfo {
  image: RGBAImage;
  origin: 'upload' | 'ai';
  /** File name (uploads) or a generated name (AI). */
  name: string;
  /** Foreground mask for the alignment overlay (null / absent = alpha, else the whole image). */
  mask?: Mask | null;
  /** Alignment / trust request (absent = auto, full trust). */
  align?: ViewAlign;
}

/** The views besides the front (the front is always the source image). */
export type OtherViewId = Exclude<ViewId, 'front'>;

export const OTHER_VIEW_IDS: OtherViewId[] = ['back', 'left', 'right', 'top', 'bottom'];

/** Views without an image yet, in display order. */
export function missingViews(views: Partial<Record<OtherViewId, unknown>>): OtherViewId[] {
  return OTHER_VIEW_IDS.filter((v) => !views[v]);
}
