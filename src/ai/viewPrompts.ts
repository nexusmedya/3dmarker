/**
 * "Copy prompt": an English instruction the user pastes into their own image
 * tool together with the front image to draw one of the other views with the
 * front's exact framing (scale, height, margins, output size, arm height for a
 * T-pose). Pure and deterministic; reuses the wording of ./prompts so the
 * hand-made views match what the in-app generation asks for.
 */
import type { Mask, RGBAImage, ViewId } from '../core/types';
import { hasTransparency, maskFromAlpha } from '../core/image/ops';
import { maskBBox, type PixelBox } from '../core/fusion/frame';
import { HUMAN_VIEW_DETAIL, SAME_POSE_PROMPT, SINGLE_VIEW_PROMPT, VIEW_DESCRIPTIONS, WHITE_BACKGROUND_PROMPT } from './prompts';

type OtherViewId = Exclude<ViewId, 'front'>;

export interface FrontFraming {
  width: number;
  height: number;
  /** Silhouette bbox of the front (pixel edges), or null when the framing is unknown (no mask, no alpha). */
  bbox: PixelBox | null;
  /** Rows of the widest contiguous band (T-pose arms) as fractions of the figure height from the top, or null. */
  armBand: [number, number] | null;
}

/** Fill / margin used when the front's silhouette is unknown. */
const DEFAULT_FILL = 80;
const DEFAULT_MARGIN = 8;

/**
 * Measures the front's framing: bbox from the mask, else from the alpha
 * channel (an opaque image without a mask has no measurable framing). The arm
 * band is the contiguous rows at ≥ 75 % of the widest row when that band is at
 * least 1.5× as wide as the median row (outstretched arms).
 */
export function measureFrontFraming(image: RGBAImage, mask: Mask | null): FrontFraming {
  const { width, height } = image;
  const m = mask ?? (hasTransparency(image) ? maskFromAlpha(image) : null);
  const bbox = m ? maskBBox(m) : null;
  return { width, height, bbox, armBand: m && bbox ? armBandOf(m, bbox) : null };
}

function armBandOf(mask: Mask, b: PixelBox): [number, number] | null {
  const w = mask.width;
  const rows = b.y1 - b.y0;
  if (rows < 4) return null;
  // Per-row span (x extent) inside the bbox.
  const span = new Float64Array(rows);
  let max = 0, at = 0;
  for (let y = b.y0; y < b.y1; y++) {
    let x0 = -1, x1 = -1;
    const row = y * w;
    for (let x = b.x0; x < b.x1; x++) {
      if (!mask.data[row + x]) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    const s = x0 < 0 ? 0 : x1 + 1 - x0;
    span[y - b.y0] = s;
    if (s > max) {
      max = s;
      at = y - b.y0;
    }
  }
  if (max <= 0) return null;
  const sorted = Array.from(span).filter((s) => s > 0).sort((a, c) => a - c);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (max < 1.5 * median) return null;
  const limit = 0.75 * max;
  let r0 = at, r1 = at;
  while (r0 > 0 && span[r0 - 1] >= limit) r0--;
  while (r1 < rows - 1 && span[r1 + 1] >= limit) r1++;
  return [r0 / rows, (r1 + 1) / rows];
}

const pct = (v: number) => Math.round(100 * v);

/** Camera line per view (the caps are not "eye level"). */
function camera(view: OtherViewId): string {
  switch (view) {
    case 'back':
      return 'Camera: orthographic, no perspective, eye level with the subject, the camera exactly 180° around the vertical axis.';
    case 'left':
    case 'right':
      return 'Camera: orthographic, no perspective, eye level with the subject, the camera exactly 90° around the vertical axis.';
    case 'top':
      return 'Camera: orthographic, no perspective, looking straight down at the subject from directly above, exactly 90° from the front view.';
    case 'bottom':
      return 'Camera: orthographic, no perspective, looking straight up at the subject from directly below, exactly 90° from the front view.';
  }
}

/**
 * The prompt for one view. `front` gives the measured framing (fill %, margin
 * %, size); `isHuman` adds the face / hand detail that view can show; `tPose`
 * spells the pose out and pins the arm height.
 */
export function buildUserViewPrompt(view: OtherViewId, ctx: { front: FrontFraming; isHuman: boolean; tPose: boolean }): string {
  const { front, isHuman, tPose } = ctx;
  const { width, height, bbox } = front;
  const fill = bbox ? pct((bbox.y1 - bbox.y0) / height) : DEFAULT_FILL;
  const margin = bbox ? pct(Math.max(0, Math.min(bbox.x0, bbox.y0, width - bbox.x1, height - bbox.y1)) / Math.max(width, height)) : DEFAULT_MARGIN;
  const tops = isHuman ? 'the top of the head and the soles' : 'the top and the bottom of the subject';
  const lines = [
    `Attached is the FRONT view of my subject. Render ${VIEW_DESCRIPTIONS[view]}`,
    camera(view),
    `Framing: identical scale and height to the attached image — ${tops} at the SAME image heights; the figure spans ${fill} % of the image height, centred, with at least ${margin} % empty margin on every side; nothing cut off (feet, hands, hair fully inside the frame). Output size ${width} × ${height} px (same as the attached image).`,
  ];
  if (front.armBand) {
    const [a0, a1] = front.armBand;
    lines.push(`The widest part (the outstretched arms) is at ${pct(a0)}–${pct(a1)} % of the figure height from the top; keep it at that height.`);
  }
  lines.push(
    `Pose: exactly the same pose as the attached image${tPose ? ', a strict T-pose: both arms straight out horizontally at shoulder height, palms down, legs straight and slightly apart' : ''}. ${SAME_POSE_PROMPT}`,
  );
  lines.push(`Appearance: same subject, identity, art style, colours, materials and lighting.${isHuman ? ` ${HUMAN_VIEW_DETAIL[view]}` : ''}`);
  lines.push(`Background: ${WHITE_BACKGROUND_PROMPT} ${SINGLE_VIEW_PROMPT}`);
  return lines.join('\n');
}
