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
export const TRAILING_PULL = '-mr-3 max-md:[&>svg]:translate-x-[var(--ink-r,0px)]';

/** The leading mirror of the trailing rule (a back "<" or close X on the left edge). */
export const LEADING_PULL = '-ml-3 max-md:[&>svg]:-translate-x-[var(--ink-l,0px)]';

/*
 * Ink on the edge (12 Nov 2026, phone only). A glyph's drawn shapes sit inside
 * its box (a chevron's ink starts 6 in, three dots 8 in), so the pull alone
 * leaves the visible ink off the 16 edge. Every icon (ui/icons) carries its
 * ink inset as --ink-l / --ink-r; the pulls above slide the glyph by it, so
 * the visible ink sits on the content edge. The 44 hit box never moves or
 * shrinks. From 768 up nothing moves. INK_LEADING / INK_TRAILING are the same
 * slide for a part that pulls its key through a child selector.
 */
export const INK_LEADING = 'max-md:[&>svg]:-translate-x-[var(--ink-l,0px)]';
export const INK_TRAILING = 'max-md:[&>svg]:translate-x-[var(--ink-r,0px)]';
/** The trailing slide from a slot that pulls its child key (`[&>button]:-mr-3`: Row, Card). */
export const INK_TRAILING_CHILD = 'max-md:[&>button>svg]:translate-x-[var(--ink-r,0px)]';
/** The same for a slot that pulls only its last 44 key (HeaderBar actions, Toolbar icons). */
export const INK_TRAILING_LAST =
  'max-md:[&>button.w-11:last-child>svg]:translate-x-[var(--ink-r,0px)]';

/**
 * A bar title beside a pulled leading 44 key (back "<", close) on phone: 8
 * more, so the title starts on the 64 text column (16 - 12 + 44 + 8 + 8),
 * above the names and list text. Goes on the title column of a bar whose
 * items are 8 apart (gap-2). From 768 up: nothing.
 */
export const BAR_TITLE_AFTER_KEY = 'max-md:ml-2';

/** A 44 control inside a shorter line keeps its box without growing the line. */
export const CONTROL_IN_LINE = '-my-3';

/*
 * Lanes: the thread's floating controls each own one lane, so they never sit
 * on each other, and the list keeps those lanes clear wherever it lands a row
 * (scroll padding), so a jump never parks a card's title or a time under one.
 *
 * - LANE_TOP: the unread pill ("2 unread"), centred, 8 under the header.
 *   44 tall, so the lane is 8 + 44 + 12 = 64 (LANE_TOP_CLEAR).
 * - LANE_BOTTOM: jump-to-latest, on the trailing edge: 16 on phone (the page
 *   edge), 12 on md+ (the chat edge); 12 above the composer. The lane is 12 + 44 + 8 = 64 (LANE_BOTTOM_CLEAR).
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

export const LANE_BOTTOM = 'absolute bottom-3 right-3 z-raised flex max-md:right-4';

/** The list's scroll padding over LANE_BOTTOM: rows land above the button's lane. */
export const LANE_BOTTOM_CLEAR = 'scroll-pb-16';

/** The tip strip's lane: in flow above the composer, on the chat edge (12). */
export const LANE_STRIP = 'mx-3 mb-2 max-md:mx-4';

/*
 * Named sizes (10 Nov 2026: one list size, the former Cozy). px numbers the
 * parts draw with literal Tailwind classes (the compiler needs the literals);
 * src/__tests__/named-sizes.test.ts proves each part's class equals its constant.
 */

/** A list row (ui/ListCard) from 768 up: 12 + 48 + 12. */
export const ROW_HEIGHT = 72;
/** The list row picture box and Avatar 'card' from 768 up. */
export const ROW_PICTURE = 48;
/** The list row's top and bottom inset from 768 up. */
export const ROW_INSET = 12;
/** The row's text column x from 768 up: picture 48 + its 12 gap (Activity sub rows). */
export const ROW_TEXT_START = 60;
/** A list row under 768 (12 Nov 2026): 8 + 44 + 8, the thread's picture and column. */
export const ROW_HEIGHT_PHONE = 60;
/** The list row picture box and Avatar 'card' under 768: the message photo's 36. */
export const ROW_PICTURE_PHONE = 36;
/** The list row's top and bottom inset under 768; the picture's top is the title line's top. */
export const ROW_INSET_PHONE = 8;
/** The row's text column x under 768: picture 36 + its 12 gap (screen x 64, a message's column). */
export const ROW_TEXT_START_PHONE = 48;
/** A chip's visible face height (ui/Chip CHIP_FACE_SIZE). */
export const CHIP_FACE = 36;
/** A chip's tap height. */
export const CHIP_TAP = 44;
/** The gap between stacked Plan day items (PLAN_DAY_STACK). */
export const PLAN_STACK = 8;
/** A Plan day's top and bottom padding (PLAN_DAY_PAD). */
export const PLAN_PAD = 12;
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

/**
 * A chat-drawn list on a page (post and brief comments, plan threads): chat's
 * rows carry their own 16 inset, so the list bleeds 16 each side and every
 * photo lands on the page edge (GUTTER) on phone and laptop.
 */
export const PAGE_BLEED = '-mx-4';

/*
 * Phone-only paddings (12 Nov 2026), named so a page or chat file never writes
 * a new padding class for them. From 768 up they do nothing.
 */
/** A text button that must keep its whole label in a narrow row: 8 side padding. */
export const PHONE_PAD_TIGHT = 'max-md:px-2';
/** A row or bar that sits on the 16 page edge on phone. */
export const PHONE_PAD_EDGE = 'max-md:px-4';
/** The same, trailing side only. */
export const PHONE_PAD_EDGE_R = 'max-md:pr-4';
/** A row inside a 16 inset that must not add its own: flush on phone. */
export const PHONE_PAD_FLUSH = 'max-md:px-0';
/** Sub rows under a message photo: the 64 column on phone (36 + 12), 44 from 768. */
export const SUB_ROW_TEXT_INSET = 'pl-12 md:pl-11';

/**
 * A row of text tools on the page edge that may not fit a narrow phone (the
 * post gallery's Add / Replace / Reorder beside the version key): under 768
 * it scrolls sideways with every label whole (R3, R4). The box reaches 12
 * past the edge and pads it back, so a pulled first tool is not clipped.
 */
export const PHONE_TOOLS_SCROLL =
  'max-md:-ml-3 max-md:overflow-x-auto max-md:pl-3 max-md:[scrollbar-width:none] max-md:[&>*]:shrink-0';

/*
 * Phone columns (12 Nov 2026, "one right edge, one text column"). Under 768
 * everything lands on 16 from the left, 64 for text beside a 36 picture or
 * icon box, and 16 from the right. From 768 nothing moves.
 */
/** A trailing text key ("Got it", "Clear"; the link level forces !px-2): no right padding on phone, so its words end on the row edge (the box stays inside it). */
export const TEXT_KEY_PULL = 'max-md:!pr-0';
/** A list or composer band that runs edge to edge inside a 16 page gutter. */
export const PHONE_BLEED = 'max-md:-mx-4';
/** A sheet or menu row on phone: no inner padding, so its icon box starts on the sheet's 16 edge. */
export const SHEET_ROW_PHONE = 'max-md:px-0';
/** The row's leading icon box on phone: 36 wide (the message photo's box), so the label starts on 64. */
export const SHEET_ROW_ICON_PHONE = 'max-md:w-9 max-md:justify-center';

/** A Button drawn as words inside a line of text ("… Show more"): no padding, so the line keeps its 20 step. */
export const INLINE_TEXT_KEY = 'p-0';
