// The one fixed shape of a shared post card in chat (ui/ChatCard). Every card
// (loading, loaded, text only, no cover, not visible, couldn't load) paints
// these rows on its first frame: the title line, a fixed meta row, a media box
// in the workspace platform's frame (one workspace = one platform, so the
// shape is known before any post read) and the 44px action row. Nothing in the
// box is sized by its content, so a card fills in place and never moves a
// row. Pure: no reads, no layout reads.

import { FORMATS_BY_PLATFORM, isPostPlatform } from '@srtdio/posts';
import { frameFor, type Frame } from '@/lib/platform-specs';
import type { ChatLayout } from '@/components/chat/chat-type';

/** The card's outer width: ui/ChatCard's CHAT_CARD_WIDTH (w-72). */
export const CARD_WIDTH_PX = 288;
/** ChatCard's inset (p-3): the media box sits inside it. */
const CARD_PAD_PX = 12;
/** The media box's height cap (a tall frame narrows to keep its ratio). */
export const CARD_MEDIA_MAX_PX = 320;
/** ChatCard's row gaps: title to meta (gap-1), rows (gap-2). */
const HEAD_GAP_PX = 4;
const ROW_GAP_PX = 8;
/** The meta row (h-5): the stage Tag's own height. */
export const CARD_META_ROW_PX = 20;
/** The action row (min-h-11): the touch target. */
export const CARD_FOOTER_PX = 44;
/** The title line: the heading role (15/20), one line, the same on both layouts. */
const TITLE_LINE_PX: Readonly<Record<ChatLayout, number>> = { touch: 20, laptop: 20 };
/** The time and tick row inside the last card of a card-only message (11/15). */
export const CARD_META_LINE_PX = 15;
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
  const inner = CARD_WIDTH_PX - 2 * CARD_PAD_PX;
  return Math.min(CARD_MEDIA_MAX_PX, Math.round(inner / frame.ratio));
}

/** The title's height: one heading line, the same on both layouts. Pure. */
export function cardTitleHeight(layout: ChatLayout): number {
  return TITLE_LINE_PX[layout];
}

/** How many lines of a text-only post fit inside the media box. Pure. */
export function cardTextLines(frame: Frame): number {
  return Math.max(1, Math.floor((cardMediaHeight(frame) - 2 * TEXT_PAD_PX) / TEXT_LINE_PX));
}

/**
 * The card's outer height in a layout: ChatCard's inset, the title and meta
 * lines, the media box, the action row and, on the last card of a card-only
 * message, the time row. Every card state renders these rows. Pure.
 */
export function postCardHeight(frame: Frame, layout: ChatLayout, withMeta = false): number {
  return (
    2 * CARD_PAD_PX +
    cardTitleHeight(layout) +
    HEAD_GAP_PX +
    CARD_META_ROW_PX +
    ROW_GAP_PX +
    cardMediaHeight(frame) +
    ROW_GAP_PX +
    CARD_FOOTER_PX +
    (withMeta ? ROW_GAP_PX + CARD_META_LINE_PX : 0)
  );
}
