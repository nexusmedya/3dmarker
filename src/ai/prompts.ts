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
import { getStyle, STYLE_KEEP_POSE } from './styles';

export const T_POSE_PROMPT =
  'Re-pose the subject into a symmetric T-pose, arms straight out horizontally at shoulder height, palms down, legs straight and slightly apart, facing the camera, full body head to toe visible, orthographic-like neutral camera.';

export const COMPLETE_BODY_PROMPT =
  'If only part of the body is visible (for example just the head or the upper body), complete the whole full-length body from head to feet consistent with the visible parts: same identity, same face, same clothing style, colours and materials, with plausible anatomy and proportions.';

export const COMPLETE_OBJECT_PROMPT =
  'If the subject is cropped or partly hidden, complete the missing parts plausibly so the whole subject is visible.';

/** Background instruction for models that really output alpha (OpenAI GPT image with background=transparent). */
export const ALPHA_BACKGROUND_PROMPT =
  'Isolate the subject on a transparent background, with no shadows, no floor, no scenery and no props.';

/**
 * Background instruction for every other model: asked for "transparent",
 * they tend to paint a fake checkerboard; a flat white background is keyed
 * out reliably afterwards.
 */
export const WHITE_BACKGROUND_PROMPT =
  'Isolate the subject on a plain, uniform, solid pure white (#FFFFFF) background with no checkerboard or transparency pattern, no gradient, no shadows, no floor, no scenery and no props.';

/** Put first when the pose or framing changes, so a style's "keep the pose" never wins. */
export const POSE_PRIORITY_PROMPT = 'The new pose and full-body framing take priority over the original pose and crop.';

/** Multi-image requests otherwise often come back as turnaround sheets or collages. */
export const SINGLE_VIEW_PROMPT =
  'Output exactly one image of this single view with one figure only: not a turnaround, character sheet, collage or multiple poses.';

export const PLAIN_BACKGROUND_PROMPT = 'Keep the background simple and uncluttered.';

export const READINESS_PROMPT =
  'Use even, soft, diffuse studio lighting without harsh shadows or strong highlights; keep the whole subject in frame, centered with a small margin and not cropped; sharp focus; no text, watermark, border or extra objects.';

export const HUMAN_DETAIL_PROMPT =
  'Keep the face, eyes, nose, lips, ears, hands and fingers clearly defined and anatomically correct, with natural relief.';

export const KEEP_LOOK_PROMPT = 'Keep the original look: the same art style, colours, materials and details.';

export const COMPLETE_VIEW_PROMPT = 'Complete unseen areas plausibly and consistently with the visible ones';

/** Pose instruction of every view: the reference carries the pose (whatever the prep options say now). */
export const SAME_POSE_PROMPT = 'Keep exactly the same pose as the reference; do not re-pose the subject.';

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

/** Face / hand detail per view: only what that view can actually show. */
export const HUMAN_VIEW_DETAIL: Record<OtherView, string> = {
  back: 'The face is NOT visible from behind: show the back of the head, the hair, the nape of the neck, the backs of the ears and the backs of the hands, with clearly defined fingers.',
  left: 'Show the face in exact profile, with a clearly defined nose, lips, eye and one ear, and anatomically correct hands and fingers.',
  right: 'Show the face in exact profile, with a clearly defined nose, lips, eye and one ear, and anatomically correct hands and fingers.',
  top: 'Show the top of the head, the hair, the shoulders and the tops of the hands; the face is mostly hidden.',
  bottom: 'Show the soles of the feet, the underside of the chin and the palms where visible.',
};

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

/** Prompt context: whether the model returns real alpha (see ALPHA_BACKGROUND_PROMPT). */
export interface PromptOutput {
  alphaOutput?: boolean;
}

function background(o: PrepOptions, out: PromptOutput): string {
  if (!o.removeBackground) return PLAIN_BACKGROUND_PROMPT;
  return out.alphaOutput ? ALPHA_BACKGROUND_PROMPT : WHITE_BACKGROUND_PROMPT;
}

/** Whether the options ask for an AI edit of the front image at all (background removal alone runs locally). */
export function prepNeeded(o: PrepOptions): boolean {
  return (
    getStyle(o.styleId) !== null ||
    o.completeBody ||
    (o.tPose && o.subject !== 'animal' && o.subject !== 'object') ||
    o.extraPrompt.trim() !== ''
  );
}

/**
 * Instruction for editing the front image. A re-pose (T-pose) or body
 * completion comes first with explicit priority; the style's "keep the pose
 * and composition" is only added when neither is asked for.
 */
export function buildPrepPrompt(o: PrepOptions, ctx: { isHuman: boolean } & PromptOutput): string {
  const humanoid = isHumanoid(o, ctx);
  const style = getStyle(o.styleId);
  const repose = o.tPose && humanoid;
  const reframe = o.completeBody;
  return join([
    'Edit the reference image to prepare the subject for 3D reconstruction.',
    SUBJECT[o.subject],
    reframe ? (humanoid ? COMPLETE_BODY_PROMPT : COMPLETE_OBJECT_PROMPT) : '',
    repose ? T_POSE_PROMPT : '',
    repose || reframe ? POSE_PRIORITY_PROMPT : '',
    style ? style.prompt : KEEP_LOOK_PROMPT,
    style && !repose && !reframe ? STYLE_KEEP_POSE : '',
    humanoid ? HUMAN_DETAIL_PROMPT : '',
    background(o, ctx),
    READINESS_PROMPT,
    extra(o.extraPrompt),
  ]);
}

/**
 * Instruction for rendering one of the other views. `refViews` lists the
 * reference images in the order they are attached (the first one is the
 * front view). The pose always comes from the reference; the extra
 * instructions only when `frontPrep` (the options that produced the current
 * front image) carried them — the live prep toggles may never have been
 * applied to it.
 */
export function buildViewPrompt(
  view: OtherView,
  o: PrepOptions,
  ctx: { isHuman: boolean; refViews: ViewId[]; frontPrep?: Pick<PrepOptions, 'extraPrompt'> | null } & PromptOutput,
): string {
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
    'Keep exactly the same subject, identity, art style, colours, materials and lighting as the reference.',
    SAME_POSE_PROMPT,
    `${COMPLETE_VIEW_PROMPT}, such as ${UNSEEN_EXAMPLES[view]}.`,
    humanoid ? HUMAN_VIEW_DETAIL[view] : '',
    SINGLE_VIEW_PROMPT,
    background(o, ctx),
    READINESS_PROMPT,
    extra(ctx.frontPrep?.extraPrompt ?? ''),
  ]);
}
