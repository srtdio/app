// The one source for every chat type size (WhatsApp parity). The size table is
// chosen by WIDTH, the app's one breakpoint (src/lib/use-is-laptop): under
// 768px takes the touch values, 768px and up (iPad portrait and landscape
// included) takes the laptop values. Pointer type never picks the table.
// Paired constants hold both; a single string is the same on both. Chat
// surfaces use only these; no other size literals. 12px / 16px is Tailwind's
// text-sm.

import { isLaptopNow, LAPTOP_MIN_WIDTH_PX, useIsLaptop } from '@/lib/use-is-laptop';

/** Which size table a chat surface renders with. */
export type ChatLayout = 'touch' | 'laptop';

/** A chat size with its touch (phone) and laptop (768px and up, iPad included) values. */
export interface ChatSize {
  touch: string;
  laptop: string;
}

/** The laptop table's minimum width (the app's one breakpoint). */
export { LAPTOP_MIN_WIDTH_PX };

/** The size table for a width: laptop at 768px and up (an iPad too), touch below. Pure. */
export function chatLayout(input: { widthPx: number }): ChatLayout {
  return input.widthPx >= LAPTOP_MIN_WIDTH_PX ? 'laptop' : 'touch';
}

/** The layout right now, read synchronously; touch where the width cannot be read. */
export function readChatLayout(): ChatLayout {
  return isLaptopNow() ? 'laptop' : 'touch';
}

/**
 * The chat layout, resolved on the first render (useIsLaptop reads the width
 * synchronously) so the first paint uses its final size table, then kept current.
 */
export function useChatLayout(): ChatLayout {
  return useIsLaptop() ? 'laptop' : 'touch';
}

/** The classes of a paired size for a layout. */
export function sized(size: ChatSize, layout: ChatLayout): string {
  return size[layout];
}

/** Message body in a bubble: 17/22 touch, 14/19 laptop, 400. */
export const BUBBLE_BODY_TYPE: ChatSize = {
  touch: 'text-[17px] leading-[22px] font-normal',
  laptop: 'text-[14px] leading-[19px] font-normal',
};

/** In-bubble meta (time, "edited"): 11/15, 400 on both. */
export const BUBBLE_META_TYPE = 'text-[11px] leading-[15px] font-normal tabular-nums';

/** The meta's tick (and clock) glyph box: 20x12, the double tick's box. */
export const TICK_ICON_BOX = 'h-3 w-5 shrink-0';

/** The sender name over a group run: 13/18/600 touch, 13/22/500 laptop. */
export const GROUP_SENDER_TYPE: ChatSize = {
  touch: 'text-[13px] leading-[18px] font-semibold',
  laptop: 'text-[13px] leading-[22px] font-medium',
};

/** A bubble's reply quote author: 13/18/600 touch, 13/20/500 laptop. */
export const QUOTE_AUTHOR_TYPE: ChatSize = {
  touch: 'text-[13px] leading-[18px] font-semibold',
  laptop: 'text-[13px] leading-[20px] font-medium',
};

/** A bubble's reply quote text: 14/18 touch, 13/20 laptop, 400. */
export const QUOTE_TEXT_TYPE: ChatSize = {
  touch: 'text-[14px] leading-[18px] font-normal',
  laptop: 'text-[13px] leading-[20px] font-normal',
};

/** Shared post card title: 15/20 touch, 14/19 laptop, 500. */
export const POST_CARD_TITLE_TYPE: ChatSize = {
  touch: 'text-[15px] leading-[20px] font-medium',
  laptop: 'text-[14px] leading-[19px] font-medium',
};

/** Shared post card meta: 12/16, 400 on both. */
export const POST_CARD_META_TYPE = 'text-sm font-normal';

/** Thread header name: 17/22/600 touch, 16/21/500 laptop. */
export const HEADER_NAME_TYPE: ChatSize = {
  touch: 'text-[17px] leading-[22px] font-semibold',
  laptop: 'text-[16px] leading-[21px] font-medium',
};

/** Thread header second line: 13/16 touch, 13/20 laptop, 400. */
export const HEADER_LINE_TYPE: ChatSize = {
  touch: 'text-[13px] leading-[16px] font-normal',
  laptop: 'text-[13px] leading-[20px] font-normal',
};

/**
 * Composer input and placeholder: 17/22 touch (never under 16px, so iOS never
 * zooms), 15/20 laptop, 400. Important, so it wins over the compact Textarea's
 * inline 16px default.
 */
export const COMPOSER_INPUT_TYPE: ChatSize = {
  touch: '!text-[17px] !leading-[22px] font-normal',
  laptop: '!text-[15px] !leading-[20px] font-normal',
};

/** Chat list name: 17/22/600 touch, 17/21/400 laptop. */
export const CHAT_LIST_NAME_TYPE: ChatSize = {
  touch: 'text-[17px] leading-[22px] font-semibold',
  laptop: 'text-[17px] leading-[21px] font-normal',
};

/** Chat list preview: 15/20 touch, 14/20 laptop, 400. */
export const CHAT_LIST_PREVIEW_TYPE: ChatSize = {
  touch: 'text-[15px] leading-[20px] font-normal',
  laptop: 'text-[14px] leading-[20px] font-normal',
};

/** Chat list time: 14/18 touch, 12/16 laptop, 400; sans with tabular figures. */
export const CHAT_LIST_TIME_TYPE: ChatSize = {
  touch: 'font-sans text-[14px] leading-[18px] font-normal tabular-nums',
  laptop: 'font-sans text-sm font-normal tabular-nums',
};

/** Thread header row padding: 8px touch, 16px laptop. */
export const HEADER_PAD: ChatSize = {
  touch: 'px-2',
  laptop: 'px-4',
};

/** Date separator pill: 12/16/500 touch, 12/16/400 uppercase laptop; sans, tabular. */
export const DATE_PILL_TYPE: ChatSize = {
  touch: 'font-mono text-sm font-medium tabular-nums',
  laptop: 'font-mono text-sm font-normal tabular-nums uppercase',
};

/** The typing row above the composer: 13/16, 400. */
export const TYPING_ROW_TYPE = 'text-[13px] leading-[16px] font-normal';

/** The emoji in a reaction badge: 14. */
export const REACTION_EMOJI_TYPE = 'text-[14px] leading-none';

/** The "Draft:" prefix in a chat list preview: weight 500 (the accent comes from a token). */
export const DRAFT_PREFIX_TYPE = 'font-medium';

/** An inline notice in a chat sheet (group info): 13/18, 400 on both. */
export const SHEET_NOTICE_TYPE = 'text-[13px] leading-[18px] font-normal';

/**
 * Bubble radius: 18px touch (the WhatsApp lock), 12px laptop (the card role).
 * The only arbitrary radii in the app live here.
 */
export const BUBBLE_SHAPE: ChatSize = {
  touch: 'rounded-[18px]',
  laptop: 'rounded-xl',
};

/** The touch bubble's 4px tail corner, bottom right on own, bottom left on peer. */
export const BUBBLE_TAIL = {
  mine: 'rounded-br-[4px]',
  theirs: 'rounded-bl-[4px]',
} as const;

/** Bubble padding: 8/12 touch, 6/7/8/9 laptop. */
export const BUBBLE_PAD: ChatSize = {
  touch: 'px-3 py-2',
  laptop: 'pb-[8px] pl-[9px] pr-[7px] pt-[6px]',
};

/** The bubble column's max width: 76% touch, 65% laptop. */
export const BUBBLE_MAX: ChatSize = {
  touch: 'max-w-[76%]',
  laptop: 'max-w-[65%]',
};

/** A glyph in the emoji picker grid and its group tabs: 24, no line box. */
export const EMOJI_GLYPH_TYPE = 'text-[24px] leading-none';

/** The emoji picker's search field: 17 touch (never under 16px, no iOS zoom), 14 laptop. */
export const EMOJI_SEARCH_TYPE: ChatSize = {
  touch: 'text-[17px] leading-[22px] font-normal',
  laptop: 'text-[14px] leading-[20px] font-normal',
};

/** The emoji picker's group heading: 12/16/500, both. */
export const EMOJI_GROUP_TYPE = 'text-sm font-medium';

/** The reason line under a disabled selection Delete: 13/18, 400 on both. */
export const SELECTION_REASON_TYPE = 'text-[13px] leading-[18px] font-normal';

/**
 * Never native text selection or the iOS callout on a long-press: the thread
 * list, every row and bubble, and chat list rows. Inputs (composer, search,
 * the edit field) never sit inside these, so they keep normal selection.
 */
export const NO_TOUCH_SELECT = 'select-none [-webkit-touch-callout:none]';
