// The pure geometry behind the visual suite's layout checks (layout-checks.ts).
// No Playwright, no DOM: plain boxes and numbers in, violations out, so the
// rules are unit tested in src/__tests__/layout-checks-core.test.ts.

/** A box in CSS px, viewport coordinates (getBoundingClientRect). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a check runs: strict fails the screen, report only records what it found. */
export type LayoutMode = 'strict' | 'report';

/** LAYOUT_CHECKS=strict|report; anything else (or unset) is strict. */
export function layoutMode(value: string | undefined): LayoutMode {
  return value === 'report' ? 'report' : 'strict';
}

/** Nothing but full-bleed media and full-width bars comes nearer the side edges than this. */
export const EDGE_MIN_PX = 12;
/** Two tap targets may share an edge; an overlap deeper than this on both axes is a fault. */
export const OVERLAP_TOLERANCE_PX = 1;
/** The most distinct text roles one part may hold. */
export const MAX_ROLES_PER_PART = 3;
/** Widths within this many px are the same width (sub-pixel layout rounding). */
export const WIDTH_TOLERANCE_PX = 0.5;
/** A text run this many line-heights tall or more has wrapped. */
const WRAP_THRESHOLD = 1.5;

/**
 * Lines a text run takes: its painted height over its line height, rounded.
 * A run is never less than one line.
 */
export function lineCount(textHeight: number, lineHeight: number): number {
  if (!(lineHeight > 0) || !(textHeight > 0)) return 1;
  return Math.max(1, Math.round(textHeight / lineHeight));
}

/** Whether a one-line part's text runs onto a second line. */
export function wrapsPastOneLine(textHeight: number, lineHeight: number): boolean {
  if (!(lineHeight > 0)) return false;
  return textHeight / lineHeight >= WRAP_THRESHOLD;
}

/**
 * The used line height in px: the computed value, or about 1.2x the font
 * size for `normal` (what browsers use for the system and Inter faces).
 */
export function lineHeightPx(computed: string, fontSizePx: number): number {
  const px = Number.parseFloat(computed);
  if (computed.endsWith('px') && Number.isFinite(px)) return px;
  // A unitless computed value multiplies the font size.
  if (/^[\d.]+$/.test(computed) && Number.isFinite(px)) return px * fontSizePx;
  return fontSizePx * 1.2;
}

/** The overlap of two boxes on each axis (0 when they do not meet). */
export function intersection(a: Box, b: Box): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** Whether two boxes overlap by more than the tolerance on both axes. */
export function overlaps(a: Box, b: Box, tolerance = OVERLAP_TOLERANCE_PX): boolean {
  const over = intersection(a, b);
  return over.width > tolerance && over.height > tolerance;
}

/**
 * A box cut to a clip rect (the viewport and every overflow-clipping
 * ancestor), or null when nothing of it is left.
 */
export function clipBox(box: Box, clip: Box | null | undefined): Box | null {
  if (clip === null || clip === undefined) return box;
  const x = Math.max(box.x, clip.x);
  const y = Math.max(box.y, clip.y);
  const right = Math.min(box.x + box.width, clip.x + clip.width);
  const bottom = Math.min(box.y + box.height, clip.y + clip.height);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** One visible tap target as the page reported it. */
export interface TapTarget {
  /** A selector or text that names it in a failure message. */
  label: string;
  box: Box;
  /**
   * Indexes (into the same list) of the targets this one sits inside or
   * holds: an ancestor or descendant never counts as an overlap.
   */
  related: readonly number[];
  /**
   * The position:fixed or position:sticky layer it sits in (an id shared by
   * every target in that layer), or null for the scrolling page. Targets in
   * different layers float over each other by design (nav pill, decision
   * bar, composer tray, sheet over its backdrop) and are never paired.
   */
  layer?: number | null;
  /**
   * Indexes of targets it is layered on by design: it (or an absolute
   * wrapper of it) is position:absolute and its containing block is, or
   * holds, the other target (a ⋮ over a card's press surface, a clear X in
   * a search field, a back button over a header image).
   */
  layeredWith?: readonly number[];
  /**
   * The innermost scroll container (overflow auto or scroll) it scrolls in,
   * as an id shared by every target in it; null or absent = none.
   */
  scroller?: number | null;
  /**
   * The scroll containers it floats over by design: it sits in a lifted
   * layer (a positioned element with its own z-index: a bar over a list, an
   * in-page popover) that neither holds that scroller nor is held by it.
   * Content scrolling in such a scroller passes under it, as it passes under
   * a sticky head, and is never paired with it.
   */
  liftedOver?: readonly number[];
  /** pointer-events:none, or inside an aria-hidden / inert subtree: never a target. */
  passive?: boolean;
  /** The rect it shows through (viewport and overflow-clipping ancestors); null = no clip. */
  clip?: Box | null;
}

/**
 * Whether `top` floats over `under` by design: `under` scrolls in a scroll
 * container that `top`'s lifted layer sits outside of (the chat thread's
 * status bar over its message list, a composer popover over the thread).
 */
export function floatsOver(top: TapTarget, under: TapTarget): boolean {
  const scroller = under.scroller ?? null;
  return scroller !== null && top.liftedOver?.includes(scroller) === true;
}

/** Whether a computed style starts a lifted layer: positioned, with a z-index of its own. */
export function isLiftedLayer(style: { position: string; zIndex: string }): boolean {
  return style.position !== 'static' && style.zIndex !== 'auto' && style.zIndex !== '';
}

/** Every pair of unrelated tap targets that overlap: [i, j] with i < j. */
export function overlappingPairs(targets: readonly TapTarget[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < targets.length; i += 1) {
    const a = targets[i];
    if (a === undefined || a.passive === true) continue;
    const aBox = clipBox(a.box, a.clip);
    if (aBox === null) continue;
    for (let j = i + 1; j < targets.length; j += 1) {
      const b = targets[j];
      if (b === undefined || b.passive === true) continue;
      if (a.related.includes(j) || b.related.includes(i)) continue;
      if ((a.layer ?? null) !== (b.layer ?? null)) continue;
      if (a.layeredWith?.includes(j) === true || b.layeredWith?.includes(i) === true) continue;
      if (floatsOver(a, b) || floatsOver(b, a)) continue;
      const bBox = clipBox(b.box, b.clip);
      if (bBox === null) continue;
      if (overlaps(aBox, bBox)) out.push([i, j]);
    }
  }
  return out;
}

/** One painted thing (a text run, an icon, a field) the edge check looks at. */
export interface EdgeItem {
  label: string;
  box: Box;
  /** img, video or inside [data-full-bleed]: allowed to the edge. */
  fullBleed: boolean;
  /** Inside an aria-hidden or inert subtree (a decorative backdrop): never checked. */
  decorative?: boolean;
  /** The rect it shows through (viewport and overflow-clipping ancestors); null = no clip. */
  clip?: Box | null;
}

/**
 * Whether a computed transform moves its element sideways (a row mid-swipe,
 * a pane sliding in): `matrix(a, b, c, d, tx, ty)` or `matrix3d(..., tx, ty,
 * tz, w)` with tx off zero. What it carries is moving content, like content
 * scrolling under the edge, and is not held to the side edges.
 */
export function movedSideways(transform: string): boolean {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (m === null) return false;
  const values = (m[2] ?? '').split(',').map((v) => Number.parseFloat(v));
  const tx = m[1] === '3d' ? values[12] : values[4];
  return tx !== undefined && Number.isFinite(tx) && Math.abs(tx) >= 0.5;
}

/** Whether a box spans the viewport's full width (a bar: header, nav, dock). */
export function spansFullWidth(box: Box, viewportWidth: number, tolerance = 1): boolean {
  return box.x <= tolerance && box.x + box.width >= viewportWidth - tolerance;
}

/**
 * Which side edge a box comes within `min` px of, or null. Boxes wholly off
 * screen, empty boxes and full-width bars are not checked.
 */
export function edgeHit(
  box: Box,
  viewportWidth: number,
  min = EDGE_MIN_PX,
): 'left' | 'right' | null {
  if (box.width <= 0 || box.height <= 0) return null;
  if (box.x + box.width <= 0 || box.x >= viewportWidth) return null;
  if (spansFullWidth(box, viewportWidth)) return null;
  // Sub-pixel slack: a run that starts at 11.9 after rounding is on the 12 line.
  if (box.x < min - 0.5) return 'left';
  if (box.x + box.width > viewportWidth - min + 0.5) return 'right';
  return null;
}

/** The items that sit nearer a side edge than EDGE_MIN_PX, with the side. */
export function edgeViolations(
  items: readonly EdgeItem[],
  viewportWidth: number,
  min = EDGE_MIN_PX,
): Array<{ item: EdgeItem; side: 'left' | 'right' }> {
  const out: Array<{ item: EdgeItem; side: 'left' | 'right' }> = [];
  for (const item of items) {
    if (item.fullBleed || item.decorative === true) continue;
    const shown = clipBox(item.box, item.clip);
    if (shown === null) continue;
    const side = edgeHit(shown, viewportWidth, min);
    if (side !== null) out.push({ item, side });
  }
  return out;
}

/** A text role's signature: computed font size, weight and family. */
export function roleSignature(style: {
  fontSize: string;
  fontWeight: string;
  fontFamily: string;
}): string {
  const family =
    style.fontFamily
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? '';
  return `${style.fontSize}/${style.fontWeight}/${family}`;
}

/** The distinct roles among a part's text runs, in first-seen order. */
export function distinctRoles(signatures: readonly string[]): string[] {
  return [...new Set(signatures)];
}

/** Whether a part holds more text roles than MAX_ROLES_PER_PART. */
export function tooManyRoles(signatures: readonly string[], max = MAX_ROLES_PER_PART): boolean {
  return distinctRoles(signatures).length > max;
}

/** Whether a control kept its width between idle and busy. */
export function sameWidth(before: number, after: number, tolerance = WIDTH_TOLERANCE_PX): boolean {
  return Math.abs(before - after) <= tolerance;
}

/** One check's finding, named by screen and element. */
export interface LayoutViolation {
  check:
    | 'one-line'
    | 'tap-overlap'
    | 'edge'
    | 'part-roles'
    | 'busy-width'
    | 'list-card'
    | 'pinned-bar'
    | 'under-bar'
    | 'tray-tiles';
  message: string;
}

/** The failure text: one line per violation, each naming the screen. */
export function formatViolations(screen: string, violations: readonly LayoutViolation[]): string {
  return violations.map((v) => `[${screen}] ${v.check}: ${v.message}`).join('\n');
}

/** A box as "x,y wxh" for messages. */
export function boxText(box: Box): string {
  const r = (n: number): number => Math.round(n * 10) / 10;
  return `${r(box.x)},${r(box.y)} ${r(box.width)}x${r(box.height)}`;
}

/** ui/ListCard's geometry (src/components/ui/ListCard.tsx). */
export const LIST_CARD_PICTURE_PX = 48;
/** The card's inner padding: the picture sits this far inside the border (left, and top: centred in 74). */
export const LIST_CARD_INSET_PX = 12;
/** Picture to text column. */
export const LIST_CARD_GAP_PX = 12;
/**
 * Every ui/ListCard in all seven lists (Pipeline, Briefs, Assets, the Chat list,
 * Activity, the Plan tab and its Bank) is this tall: 1 + 12 + 48 + 12 + 1
 * (border, padding, the 48 picture; the two 20 lines and the 4 between, 44,
 * centre inside it).
 */
export const LIST_CARD_HEIGHT_PX = 74;
/** Cards are the same height (on a screen, and LIST_CARD_HEIGHT_PX) within this many px. */
export const LIST_CARD_HEIGHT_TOLERANCE_PX = 1;
/** Sizes and offsets within this many px are equal (sub-pixel layout rounding). */
const LIST_CARD_PX_TOLERANCE = 0.5;

/** One ui/ListCard as measured: its box, its border, its picture and its text column. */
export interface ListCardGeom {
  label: string;
  card: Box;
  /** The card's left and top border widths (the box includes them). */
  borderLeft: number;
  borderTop: number;
  picture: Box | null;
  text: Box | null;
}

const near = (a: number, b: number, tolerance = LIST_CARD_PX_TOLERANCE): boolean =>
  Math.abs(a - b) <= tolerance;

/**
 * The list card rule: every card on a screen has the same height (within 1px),
 * and that height is LIST_CARD_HEIGHT_PX (74) on every screen, so the seven lists'
 * cards are one height across the app; each card's picture is 48x48, on the left, 12 inside the card's border
 * (left and top), with the text column 12 after it. Pure.
 */
export function listCardViolations(cards: readonly ListCardGeom[]): string[] {
  const out: string[] = [];
  const first = cards[0];
  for (const c of cards) {
    if (
      first !== undefined &&
      Math.abs(c.card.height - first.card.height) > LIST_CARD_HEIGHT_TOLERANCE_PX
    ) {
      out.push(
        `${c.label} is ${c.card.height}px tall, ${first.label} is ${first.card.height}px (cards differ)`,
      );
    }
    if (Math.abs(c.card.height - LIST_CARD_HEIGHT_PX) > LIST_CARD_HEIGHT_TOLERANCE_PX) {
      out.push(
        `${c.label} is ${c.card.height}px tall, not ${LIST_CARD_HEIGHT_PX} (every list card is one height)`,
      );
    }
    if (c.picture === null) {
      out.push(`${c.label} has no picture slot`);
      continue;
    }
    const p = c.picture;
    if (!near(p.width, LIST_CARD_PICTURE_PX) || !near(p.height, LIST_CARD_PICTURE_PX)) {
      out.push(`${c.label} picture is ${p.width}x${p.height}, not 48x48`);
    }
    const left = p.x - c.card.x - c.borderLeft;
    const top = p.y - c.card.y - c.borderTop;
    if (!near(left, LIST_CARD_INSET_PX) || !near(top, LIST_CARD_INSET_PX)) {
      out.push(`${c.label} picture sits ${left},${top} inside the card, not 12,12 (left, top)`);
    }
    if (c.text !== null) {
      const gap = c.text.x - (p.x + p.width);
      if (!near(gap, LIST_CARD_GAP_PX)) {
        out.push(`${c.label} text starts ${gap}px after the picture, not 12`);
      }
    }
  }
  return out;
}

/** A pinned bar holds its top within this many px while the page scrolls. */
export const PINNED_TOLERANCE_PX = 1;

/** The pinned exit bar measured at the top of the page and again after a scroll. */
export interface PinnedBarGeom {
  /** False when the screen has no pinned exit bar ([data-header-pin] / [data-header-pinned]). */
  found: boolean;
  /** The bar's top with the page at its top. */
  topAtRest: number;
  /** The bar's top after the scroll. */
  topScrolled: number;
  /** How far the scroller really moved (0: the page is too short to scroll). */
  scrolledBy: number;
}

/**
 * The exit bar of a screen that opens over the app stays pinned while the page
 * scrolls (ui/HeaderBar `pinned`): after the scroll its top is where it was at
 * rest. A page too short to scroll proves nothing and passes. Pure.
 */
export function pinnedBarViolations(geom: PinnedBarGeom): string[] {
  if (!geom.found) return ['no pinned exit bar ([data-header-pin] or [data-header-pinned])'];
  if (geom.scrolledBy <= 0) return [];
  if (Math.abs(geom.topScrolled - geom.topAtRest) > PINNED_TOLERANCE_PX) {
    return [
      `the exit bar moved from top ${geom.topAtRest} to ${geom.topScrolled} after a ` +
        `${geom.scrolledBy}px scroll (it must stay pinned)`,
    ];
  }
  return [];
}

/** The checkpoint progress row and the bar it pins under. */
export interface UnderBarGeom {
  /** The bar's box ([data-header-bar]); null when there is none. */
  bar: Box | null;
  /** The progress row's box ([data-checkpoint-progress-row]); null when there is none. */
  row: Box | null;
  /** The row sits inside the bar's pinned block ([data-header-pin]). */
  insidePin: boolean;
}

/**
 * The post's checkpoint progress row sits directly under the exit bar, in the
 * same pinned block: its top is the bar's bottom (within 1px). Pure.
 */
export function underBarViolations(geom: UnderBarGeom): string[] {
  if (geom.bar === null) return ['no exit bar ([data-header-bar])'];
  if (geom.row === null) return ['no checkpoint progress row ([data-checkpoint-progress-row])'];
  const out: string[] = [];
  if (!geom.insidePin) {
    out.push('the progress row is not inside the pinned block ([data-header-pin])');
  }
  const gap = geom.row.y - (geom.bar.y + geom.bar.height);
  if (Math.abs(gap) > PINNED_TOLERANCE_PX) {
    out.push(`the progress row starts ${Math.round(gap * 10) / 10}px from the bar's bottom, not 0`);
  }
  return out;
}

/** The comment composers' "+" tray: exactly these tiles, in this order. */
export const COMMENT_TRAY_TILE_IDS = ['photos', 'file', 'assets'] as const;

/** The open tray's tile ids ([data-tray-tile]) against the expected ones, in order. Pure. */
export function trayTileViolations(
  tiles: readonly string[],
  expected: readonly string[] = COMMENT_TRAY_TILE_IDS,
): string[] {
  if (tiles.length === expected.length && tiles.every((id, i) => id === expected[i])) return [];
  return [
    `the "+" tray shows ${tiles.length} tiles (${tiles.join(', ') || 'none'}), ` +
      `not ${expected.length} (${expected.join(', ')})`,
  ];
}
