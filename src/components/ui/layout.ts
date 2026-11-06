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
