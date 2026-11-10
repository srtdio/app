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
export const LANE_TOP = 'pointer-events-none absolute inset-x-0 top-2 z-raised flex justify-center';

/** The list's scroll padding under LANE_TOP: rows land below the pill's lane. */
export const LANE_TOP_CLEAR = 'scroll-pt-16';

export const LANE_BOTTOM = 'absolute bottom-3 right-3 z-raised flex';

/** The list's scroll padding over LANE_BOTTOM: rows land above the button's lane. */
export const LANE_BOTTOM_CLEAR = 'scroll-pb-16';

/** The tip strip's lane: in flow above the composer, on the chat edge (12). */
export const LANE_STRIP = 'mx-3 mb-2';

/*
 * Named sizes (10 Nov 2026: one list size, the former Cozy). px numbers the
 * parts draw with literal Tailwind classes (the compiler needs the literals);
 * src/__tests__/named-sizes.test.ts proves each part's class equals its constant.
 */

/** A list row (ui/ListCard): 12 + 48 + 12. */
export const ROW_HEIGHT = 72;
/** The list row picture box and Avatar 'card'. */
export const ROW_PICTURE = 48;
/** The list row's top and bottom inset. */
export const ROW_INSET = 12;
/** The row's text column x: picture 48 + its 12 gap (Activity sub rows). */
export const ROW_TEXT_START = 60;
/** A chip's visible face height (ui/Chip CHIP_FACE_SIZE). */
export const CHIP_FACE = 36;
/** A chip's tap height. */
export const CHIP_TAP = 44;
/** The gap between stacked Plan day items (PLAN_DAY_STACK). */
export const PLAN_STACK = 8;
/** A Plan day's top and bottom padding (PLAN_DAY_PAD). */
export const PLAN_PAD = 12;
/** The top bar Threads | Catch up box face height. */
export const PAIR_BOX_HEIGHT = 28;
/** The count pill inside a Threads | Catch up box. */
export const PAIR_PILL_HEIGHT = 16;
/** Activity's ink "N new" chip height. */
export const NEW_CHIP_HEIGHT = 18;

/*
 * The list-screen shell (shell/ListScreen): what sits under the top bar on a
 * list tab. ListScreen draws these with literal classes; named-sizes.test.ts
 * proves each class equals its constant, and assertListScreenAxis reads them.
 */
/** Top bar bottom to the chip row (mt-3). */
export const SCREEN_CHIPS_TOP = 12;
/** Chip row bottom to the first content row (pt-4). */
export const SCREEN_CONTENT_TOP = 16;
/** The list tab's side gutter on a phone (px-4, pl-4). */
export const SCREEN_GUTTER_PHONE = 16;
/** The list tab's side gutter on a laptop (md:px-6, md:pl-6). */
export const SCREEN_GUTTER_LAPTOP = 24;
