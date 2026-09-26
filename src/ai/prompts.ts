/**
 * Prompt composition for the AI preparation step (restyle / T-pose / body
 * completion of the front image) and for rendering the other views. Pure
 * and deterministic: the same options always give the same text.
 *
 * View conventions follow src/core/types.ts (ViewId): back = seen from
 * behind with the subject's left on the image's left; left = camera at the
 * subject's left, the subject facing image-left; right = the mirror of
 * that; top = from above with the front at the image bottom; bottom = from
 * below with the front at the image top.
 */
import type { ViewId } from '../core/types';
import type { PrepOptions, SubjectKind } from './types';
import { getStyle } from './styles';

export const T_POSE_PROMPT =
  'Re-pose the subject into a symmetric T-pose, arms straight out horizontally at shoulder height, palms down, legs straight and slightly apart, facing the camera, full body head to toe visible, orthographic-like neutral camera.';

export const COMPLETE_BODY_PROMPT =
  'If only part of the body is visible (for example just the head or the upper body), complete the whole full-length body from head to feet consistent with the visible parts: same identity, same face, same clothing style, colours and materials, with plausible anatomy and proportions.';

export const COMPLETE_OBJECT_PROMPT =
  'If the subject is cropped or partly hidden, complete the missing parts plausibly so the whole subject is visible.';

export const REMOVE_BACKGROUND_PROMPT =
  'Isolate the subject on a plain transparent background (pure white if transparency is not possible), with no shadows, no floor, no scenery and no props.';

export const PLAIN_BACKGROUND_PROMPT = 'Keep the background simple and uncluttered.';

export const READINESS_PROMPT =
  'Use even, soft, diffuse studio lighting without harsh shadows or strong highlights; keep the whole subject in frame, centered with a small margin and not cropped; sharp focus; no text, watermark, border or extra objects.';

export const HUMAN_DETAIL_PROMPT =
  'Keep the face, eyes, nose, lips, ears, hands and fingers clearly defined and anatomically correct, with natural relief.';

export const KEEP_LOOK_PROMPT = 'Keep the original look: the same art style, colours, materials and details.';

export const COMPLETE_VIEW_PROMPT = 'Complete unseen areas plausibly and consistently with the visible ones';

const SUBJECT: Record<SubjectKind, string> = {
  auto: '',
  human: 'The subject is a person.',
  character: 'The subject is a humanoid character.',
  animal: 'The subject is an animal.',
  object: 'The subject is an object.',
};

type OtherView = Exclude<ViewId, 'front'>;

export const VIEW_DESCRIPTIONS: Record<OtherView, string> = {
  back: 'the BACK view: seen from directly behind, the camera rotated 180° around the vertical axis. The subject’s back faces the camera; the subject’s left side appears on the LEFT of the image and its right side on the RIGHT.',
  left: 'the LEFT side view: an exact profile from the subject’s left, the camera placed at the subject’s left side, 90° from the front view and looking at the subject. The subject faces toward the LEFT edge of the image.',
  right: 'the RIGHT side view: an exact profile from the subject’s right, the camera placed at the subject’s right side, 90° from the front view and looking at the subject. The subject faces toward the RIGHT edge of the image.',
  top: 'the TOP view: seen from directly above, the camera looking straight down. The subject’s front points toward the BOTTOM edge of the image.',
  bottom: 'the BOTTOM view: seen from directly below, the camera looking straight up. The subject’s front points toward the TOP edge of the image.',
};

const VIEW_NAMES: Record<ViewId, string> = { front: 'front', back: 'back', left: 'left side', right: 'right side', top: 'top', bottom: 'bottom' };

const UNSEEN_EXAMPLES: Record<OtherView, string> = {
  back: 'the back of the head and hair, the back of the clothing and any straps or seams',
  left: 'the side of the face, the ear, the arm and the leg in profile',
  right: 'the side of the face, the ear, the arm and the leg in profile',
  top: 'the top of the head or of the object, the shoulders and upper surfaces',
  bottom: 'the soles of the feet or the underside and base of the object',
};

/** Humanoid prompts (T-pose, body completion, face / hand detail) apply. */
export function isHumanoid(o: Pick<PrepOptions, 'subject'>, ctx: { isHuman: boolean }): boolean {
  if (o.subject === 'human' || o.subject === 'character') return true;
  if (o.subject === 'auto') return ctx.isHuman;
  return false;
}

function extra(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 1000);
  return t ? `Additional instructions: ${t}` : '';
}

const join = (parts: string[]) => parts.filter(Boolean).join(' ');

/** Whether the options ask for an AI edit of the front image at all (background removal alone runs locally). */
export function prepNeeded(o: PrepOptions): boolean {
  return (
    getStyle(o.styleId) !== null ||
    o.completeBody ||
    (o.tPose && o.subject !== 'animal' && o.subject !== 'object') ||
    o.extraPrompt.trim() !== ''
  );
}

/** Instruction for editing the front image. */
export function buildPrepPrompt(o: PrepOptions, ctx: { isHuman: boolean }): string {
  const humanoid = isHumanoid(o, ctx);
  const style = getStyle(o.styleId);
  return join([
    'Edit the reference image to prepare the subject for 3D reconstruction.',
    SUBJECT[o.subject],
    style ? style.prompt : KEEP_LOOK_PROMPT,
    o.completeBody ? (humanoid ? COMPLETE_BODY_PROMPT : COMPLETE_OBJECT_PROMPT) : '',
    o.tPose && humanoid ? T_POSE_PROMPT : '',
    humanoid ? HUMAN_DETAIL_PROMPT : '',
    o.removeBackground ? REMOVE_BACKGROUND_PROMPT : PLAIN_BACKGROUND_PROMPT,
    READINESS_PROMPT,
    extra(o.extraPrompt),
  ]);
}

/**
 * Instruction for rendering one of the other views. `refViews` lists the
 * reference images in the order they are attached (the first one is the
 * front view).
 */
export function buildViewPrompt(view: OtherView, o: PrepOptions, ctx: { isHuman: boolean; refViews: ViewId[] }): string {
  const humanoid = isHumanoid(o, ctx);
  const refs = ctx.refViews.length ? ctx.refViews : (['front'] as ViewId[]);
  const refText =
    refs.length === 1
      ? `The reference image shows the ${VIEW_NAMES[refs[0]]} view of the subject.`
      : `The reference images show the same subject: ${refs.map((r, i) => `image ${i + 1} is the ${VIEW_NAMES[r]} view`).join(', ')}.`;
  const sideOrBack = view === 'back' || view === 'left' || view === 'right';
  return join([
    refText,
    SUBJECT[o.subject],
    `Render ${VIEW_DESCRIPTIONS[view]}`,
    sideOrBack
      ? 'Use an orthographic-like, neutral camera without perspective distortion and with the SAME scale, framing and height as the front view: the subject has the same size in the frame, with its top and bottom at the same image heights.'
      : 'Use an orthographic-like, neutral camera without perspective distortion and with the SAME scale as the front view.',
    `Keep exactly the same subject, identity, art style, colours, materials, pose and lighting as the reference${o.tPose && humanoid ? ', in the same symmetric T-pose' : ''}.`,
    `${COMPLETE_VIEW_PROMPT}, such as ${UNSEEN_EXAMPLES[view]}.`,
    humanoid ? HUMAN_DETAIL_PROMPT : '',
    o.removeBackground ? REMOVE_BACKGROUND_PROMPT : PLAIN_BACKGROUND_PROMPT,
    READINESS_PROMPT,
    extra(o.extraPrompt),
  ]);
}
