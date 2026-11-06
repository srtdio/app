// Layout constants the shared parts own (CLAUDE.md Layout rules). Call sites
// never place these by hand: they render the part that applies them.

/** The page edge: 16 phone, 24 laptop (L2). */
export const GUTTER = 'px-4 md:px-6';

/** The chat edge: 12 on both (the written exception to L2). */
export const CHAT_GUTTER = 'px-3';

/**
 * The trailing rule: a trailing 44 icon box (more, chevron, close X) is pulled
 * outward by 12 so its 20px glyph's visible edge sits on the content edge.
 * Applied by the parts (ActionMenuTrigger, HeaderBar, Row, Card, Sheet), never
 * at a call site (eslint designRules: no negative-margin IconButton).
 */
export const TRAILING_PULL = '-mr-3';

/** The leading mirror of the trailing rule (a back "<" or close X on the left edge). */
export const LEADING_PULL = '-ml-3';

/** A 44 control inside a shorter line keeps its box without growing the line. */
export const CONTROL_IN_LINE = '-my-3';

/*
 * Lanes: the thread's floating controls each own one lane, so they never sit
 * on each other, and the list keeps those lanes clear wherever it lands a row
 * (scroll padding), so a jump never parks a card's title or a time under one.
 *
 * - LANE_TOP: the unread pill ("2 unread"), centred, 8 under the header.
 *   44 tall, so the lane is 8 + 44 + 12 = 64 (LANE_TOP_CLEAR).
 * - LANE_BOTTOM: jump-to-latest, on the trailing edge (the chat edge, 12),
 *   12 above the composer. The lane is 12 + 44 + 8 = 64 (LANE_BOTTOM_CLEAR).
 * - LANE_STRIP: the tip strip sits in flow between the list and the composer,
 *   never over the list, so it has its own lane and can meet neither of the
 *   above (the list ends where it begins).
 *
 * Pure classes: no wait, no measure. The pill and the button stay overlays
 * (they never move the rows); the clear classes go on the scroll box.
 */
export const LANE_TOP = 'pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center';

/** The list's scroll padding under LANE_TOP: rows land below the pill's lane. */
export const LANE_TOP_CLEAR = 'scroll-pt-16';

export const LANE_BOTTOM = 'absolute bottom-3 right-3 z-10 flex';

/** The list's scroll padding over LANE_BOTTOM: rows land above the button's lane. */
export const LANE_BOTTOM_CLEAR = 'scroll-pb-16';

/** The tip strip's lane: in flow above the composer, on the chat edge (12). */
export const LANE_STRIP = 'mx-3 mb-2';
