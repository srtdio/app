// The one fixed shape of a shared post card in chat. Every card (loading,
// loaded, text only, no cover, not visible, couldn't load) paints this exact
// box on its first frame: a media box in the workspace platform's frame (one
// workspace = one platform, so the shape is known before any post read), a
// title area two lines tall, a fixed meta row and the 44px footer. Nothing in
// the box is sized by its content, so a card fills in place and never moves a
// row. Pure: no reads, no layout reads.

import { FORMATS_BY_PLATFORM, isPostPlatform } from '@srtdio/posts';
import { frameFor, type Frame } from '@/lib/platform-specs';
import type { ChatLayout } from '@/components/chat/chat-type';

/** The card's outer width; its 1px border sits inside it (border-box). */
export const CARD_WIDTH_PX = 240;
const CARD_BORDER_PX = 1;
/** The media box's height cap (a tall frame narrows to keep its ratio). */
export const CARD_MEDIA_MAX_PX = 320;
/** The body's vertical padding (py-2.5) and the title-to-meta gap (gap-1.5). */
const BODY_PAD_Y_PX = 10;
const BODY_GAP_PX = 6;
/** The meta row (h-5): the stage Tag's own height. */
export const CARD_META_ROW_PX = 20;
/** The footer row (h-[44px]): the touch target. */
export const CARD_FOOTER_PX = 44;
/** The title's line height per layout (POST_CARD_TITLE_TYPE's leading). */
const TITLE_LINE_PX: Readonly<Record<ChatLayout, number>> = { touch: 20, laptop: 19 };
/** The title area is always two lines tall (2-line clamp). */
const TITLE_LINES = 2;
/** The text-only post's text inside the media box: base (20px lines), p-3. */
const TEXT_LINE_PX = 20;
const TEXT_PAD_PX = 12;

/** A square frame for a platform the client does not know (never in practice). */
const FALLBACK_FRAME: Frame = { ratio: 1, source: 'default', fit: 'cover', bands: 'none' };

/**
 * The media box frame of every chat card in a workspace: the platform's single
 * image default where it offers one, else its first format's (9:16 for TikTok
 * and YouTube Shorts), through the shared frame rule (frameFor). The post's own
 * media is fit into it (cover, or contain with bands where the platform never
 * cuts). Null or an unknown platform: a square. Pure.
 */
export function chatCardFrame(platform: string | null): Frame {
  if (platform === null || !isPostPlatform(platform)) return FALLBACK_FRAME;
  const formats: readonly string[] = FORMATS_BY_PLATFORM[platform];
  const format = formats.includes('single_image') ? 'single_image' : (formats[0] ?? '');
  return frameFor(platform, format, null) ?? FALLBACK_FRAME;
}

/** The media box's whole-px height: the frame at the card's inner width, capped. Pure. */
export function cardMediaHeight(frame: Frame): number {
  const inner = CARD_WIDTH_PX - 2 * CARD_BORDER_PX;
  return Math.min(CARD_MEDIA_MAX_PX, Math.round(inner / frame.ratio));
}

/** The title area's height in a layout: two title lines. Pure. */
export function cardTitleHeight(layout: ChatLayout): number {
  return TITLE_LINES * TITLE_LINE_PX[layout];
}

/** How many lines of a text-only post fit inside the media box. Pure. */
export function cardTextLines(frame: Frame): number {
  return Math.max(1, Math.floor((cardMediaHeight(frame) - 2 * TEXT_PAD_PX) / TEXT_LINE_PX));
}

/** The card's outer height (border-box) in a layout. Every card state uses it. Pure. */
export function postCardHeight(frame: Frame, layout: ChatLayout): number {
  return (
    2 * CARD_BORDER_PX +
    cardMediaHeight(frame) +
    2 * BODY_PAD_Y_PX +
    cardTitleHeight(layout) +
    BODY_GAP_PX +
    CARD_META_ROW_PX +
    CARD_FOOTER_PX
  );
}
