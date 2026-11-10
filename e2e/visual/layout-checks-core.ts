// The pure geometry behind the visual suite's layout checks (layout-checks.ts).
// No Playwright, no DOM: plain boxes and numbers in, violations out, so the
// rules are unit tested in src/__tests__/layout-checks-core.test.ts.

import {
  CHIP_FACE,
  CHIP_TAP,
  ROW_HEIGHT,
  ROW_INSET,
  ROW_PICTURE,
} from '../../src/components/ui/layout';

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
    | 'tray-tiles'
    | 'chip'
    | 'topbar'
    | 'chip-row'
    | 'upload-bar'
    | 'writing-box'
    | 'comment-bar'
    | 'thread-header'
    | 'catch-up'
    | 'alignment';
  message: string;
}

/** The thread screen's header as read: its title and second line, and the bar. */
export interface ThreadHeaderGeom {
  title: { text: string; lines: number; box: Box } | null;
  subtitle: { text: string; lines: number; box: Box } | null;
  bar: Box | null;
}

/**
 * The thread header rule: a title and the chat's name under it on every
 * thread, each one line (the title truncates), both inside the bar. Pure.
 */
export function threadHeaderViolations(geom: ThreadHeaderGeom): string[] {
  const out: string[] = [];
  if (geom.title === null || geom.title.text.trim() === '') out.push('the thread has no title');
  if (geom.subtitle === null || geom.subtitle.text.trim() === '') {
    out.push("the thread has no second line (the chat's name)");
  }
  for (const [name, part] of [
    ['title', geom.title],
    ['second line', geom.subtitle],
  ] as const) {
    if (part === null) continue;
    if (part.lines > 1) out.push(`the ${name} wraps to ${part.lines} lines`);
    if (geom.bar !== null) {
      const b = geom.bar;
      const p = part.box;
      if (p.x < b.x - 0.5 || p.x + p.width > b.x + b.width + 0.5) {
        out.push(`the ${name} runs past the bar (${boxText(p)} in ${boxText(b)})`);
      }
    }
  }
  return out;
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

/** ui/ListCard's picture (ROW_PICTURE 48, src/components/ui/layout.ts). */
export const LIST_CARD_PICTURE_PX = ROW_PICTURE;
/**
 * The picture's left inset inside the row box: the row bleeds -mx-4 past the
 * gutter and pads px-4 back, so the picture sits 16 inside the bled row (on
 * the page gutter). No border.
 */
export const LIST_CARD_INSET_X_PX = 16;
/** The picture's top inset (ROW_INSET): centred in the 72 row, 12 above and below the 48. */
export const LIST_CARD_INSET_Y_PX = ROW_INSET;
/** Picture to text column. */
export const LIST_CARD_GAP_PX = 12;
/*
 * Every ui/ListCard in all seven lists (Pipeline, Briefs, Assets, the Chat list,
 * Activity, the Plan tab and its Bank) is ROW_HEIGHT: the flat h-18 row, 12 +
 * the 48 picture + 12 (the two 20 lines and the 4 between, 44, centre inside
 * it). No border, no radius.
 */
/** Cards are the same height (on a screen, and ROW_HEIGHT) within this many px. */
export const LIST_CARD_HEIGHT_TOLERANCE_PX = 1;
/** Sizes and offsets within this many px are equal (sub-pixel layout rounding). */
const LIST_CARD_PX_TOLERANCE = 0.5;

/** One ui/ListCard as measured: its (bled) row box, its border (0 on the flat row), its picture and its text column. */
export interface ListCardGeom {
  label: string;
  card: Box;
  /** The row's left and top border widths (the box includes them; the flat row has none). */
  borderLeft: number;
  borderTop: number;
  picture: Box | null;
  text: Box | null;
  /** Line 1's time, when shown. */
  time?: Box | null;
  /** Line 2's tag, when shown. */
  tag?: Box | null;
  /** Line 2 shows a preview. */
  hasPreview?: boolean;
  /** Line 2 ends with the unread dot (after the tag). */
  unread?: boolean;
  /** Activity's 2-line preview row (ListCard previewLines 2, data-list-card-lines). */
  lines2?: boolean;
  /** That row unfolded ("less" shows): taller than the 2-line row. */
  unfolded?: boolean;
}

/** An Activity row with a 2-line preview is one 20 line taller (Part 6, 10 Nov 2026). */
export const LIST_CARD_PREVIEW_LINE_PX = 20;

const near = (a: number, b: number, tolerance = LIST_CARD_PX_TOLERANCE): boolean =>
  Math.abs(a - b) <= tolerance;

/**
 * The list card rule: every card on a screen has the same height (within 1px),
 * and that height is ROW_HEIGHT (72) on every screen, so the seven lists'
 * rows are one height across the app; each row's picture is the 48 square
 * (ROW_PICTURE), on the left, 16 inside the bled row (x) and ROW_INSET (12)
 * from its top (y), with the text column 12 after it. Pure.
 */
export function listCardViolations(cards: readonly ListCardGeom[]): string[] {
  const out: string[] = [];
  // Activity's 2-line rows (72 + 20; taller only unfolded) are checked on
  // their own; every other row is one height, ROW_HEIGHT.
  const first = cards.find((c) => c.lines2 !== true);
  const geom = { height: ROW_HEIGHT, picture: ROW_PICTURE, insetY: ROW_INSET };
  for (const c of cards) {
    const extra = c.lines2 === true ? c.card.height - geom.height : 0;
    if (c.lines2 === true) {
      const want = geom.height + LIST_CARD_PREVIEW_LINE_PX;
      const off =
        c.unfolded === true ? c.card.height < want - 1 : Math.abs(c.card.height - want) > 1;
      if (off) {
        out.push(
          `${c.label} is ${c.card.height}px tall, not ${want} (a 2-line preview row is 72 + 20)`,
        );
      }
    } else {
      if (
        first !== undefined &&
        Math.abs(c.card.height - first.card.height) > LIST_CARD_HEIGHT_TOLERANCE_PX
      ) {
        out.push(
          `${c.label} is ${c.card.height}px tall, ${first.label} is ${first.card.height}px (cards differ)`,
        );
      }
      if (Math.abs(c.card.height - geom.height) > LIST_CARD_HEIGHT_TOLERANCE_PX) {
        out.push(
          `${c.label} is ${c.card.height}px tall, not ${geom.height} (every list card is one height)`,
        );
      }
    }
    if (c.picture === null) {
      out.push(`${c.label} has no picture slot`);
      continue;
    }
    const p = c.picture;
    if (!near(p.width, geom.picture) || !near(p.height, geom.picture)) {
      out.push(`${c.label} picture is ${p.width}x${p.height}, not ${geom.picture}x${geom.picture}`);
    }
    const left = p.x - c.card.x - c.borderLeft;
    const top = p.y - c.card.y - c.borderTop;
    // A taller (2-line) row keeps its picture centred.
    const wantTop = geom.insetY + extra / 2;
    if (!near(left, LIST_CARD_INSET_X_PX) || Math.abs(top - wantTop) > 1) {
      out.push(
        `${c.label} picture sits ${left},${top} inside the row, not ${LIST_CARD_INSET_X_PX},${wantTop} (left, top)`,
      );
    }
    if (c.text !== null) {
      const gap = c.text.x - (p.x + p.width);
      if (!near(gap, LIST_CARD_GAP_PX)) {
        out.push(`${c.label} text starts ${gap}px after the picture, not 12`);
      }
    }
    // No preview: the tag sits on line 2's right end, right under the time
    // (an unread dot, when shown, follows it, so the rule reads unread-free cards).
    const tag = c.tag ?? null;
    const time = c.time ?? null;
    if (c.hasPreview === false && c.unread !== true && tag !== null && time !== null) {
      const tagRight = tag.x + tag.width;
      const timeRight = time.x + time.width;
      if (!near(tagRight, timeRight)) {
        out.push(
          `${c.label} tag ends at ${tagRight}, the time at ${timeRight} (no preview: tag under the time)`,
        );
      }
    }
  }
  return out;
}

/** ui/Chip: the visible face (CHIP_FACE 36) inside a tap box at least 44 (CHIP_TAP). */
export const CHIP_FACE_PX = CHIP_FACE;
export const CHIP_HIT_PX = CHIP_TAP;

/** One ui/Chip: its tap box (the button) and its visible face ([data-chip-face]). */
export interface ChipGeom {
  label: string;
  hit: Box;
  face: Box | null;
}

/**
 * The chip rule: the face is CHIP_FACE (36, 0.5px rounding), vertically
 * centred in a tap box at least 44 tall and 44 wide. Pure.
 */
export function chipViolations(chips: readonly ChipGeom[]): string[] {
  const out: string[] = [];
  const faceHeight = CHIP_FACE_PX;
  for (const c of chips) {
    if (c.hit.height < CHIP_HIT_PX - LIST_CARD_PX_TOLERANCE) {
      out.push(`${c.label} tap box is ${c.hit.height}px tall, not 44`);
    }
    if (c.hit.width < CHIP_HIT_PX - LIST_CARD_PX_TOLERANCE) {
      out.push(`${c.label} tap box is ${c.hit.width}px wide, under 44`);
    }
    if (c.face === null) {
      out.push(`${c.label} has no visible chip face`);
      continue;
    }
    if (!near(c.face.height, faceHeight)) {
      out.push(`${c.label} chip is ${c.face.height}px tall, not ${faceHeight}`);
    }
    const above = c.face.y - c.hit.y;
    const below = c.hit.y + c.hit.height - (c.face.y + c.face.height);
    if (!near(above, below)) {
      out.push(
        `${c.label} chip sits ${above}px from the top, ${below}px from the bottom (not centred)`,
      );
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

/** The top bar's sort slot from md (shell/Topbar TopbarSlots): a fixed 44 box. */
export const TOPBAR_SLOT_PX = 44;
/** The top bar's primary ("+") slot from md: the 112 wide Main face's slot, 44 tall. */
export const TOPBAR_PRIMARY_MD_PX = 112;
/** Below md (10 Nov 2026): every top bar key is a 36 wide x 44 tall strip, 36 apart. */
export const TOPBAR_KEY_PX = 36;
/** The top bar's laptop breakpoint (Tailwind md). */
export const TOPBAR_MD_PX = 768;
/** From md the top bar's controls sit gap-1 apart (4px), plus sub-pixel rounding. */
export const TOPBAR_GAP_MAX_PX = 4.5;
/** Phone: the 32 avatar photo's right edge stays 6 in from the 16 gutter (as on main). */
export const TOPBAR_AVATAR_RIGHT_INSET_PX = 22;
/** The phone "+" face: an outlined 22 square, 1.75 line, radius 7, no fill, a 14 glyph. */
export const TOPBAR_PLUS_PHONE = { face: 22, line: 1.75, radius: 7, glyph: 14 } as const;
/** The laptop "+" face: the 112 x 32 Main, radius 8, accent fill. */
export const TOPBAR_PLUS_LAPTOP = { width: 112, height: 32, radius: 8 } as const;
/** A slot holds one x across screens within this many px. */
const TOPBAR_DRIFT_PX = 0.5;
/** Centres and edges compare within 1px (CLAUDE.md alignment: +-1). */
const TOPBAR_ALIGN_PX = 1;

/** The top bar "+" face as measured (the shown [data-topbar-plus-face]). */
export interface TopbarPlusGeom {
  /** Which face shows: 'phone' below md, 'laptop' from md. */
  face: 'phone' | 'laptop';
  box: Box;
  borderWidth: number;
  radius: number;
  /** The face's computed background colour. */
  background: string;
  /** The computed colour of bg-accent on this page (the Main fill). */
  accent: string;
  /** Blocked (aria-disabled): the laptop face greys to bg-fg-3. Absent: live. */
  blocked?: { fill: string } | null | undefined;
  /** The face's IconPlus svg. */
  glyph: Box | null;
}

/** The top bar as measured: search, the sort slot, the primary ("+") slot, the avatar. */
export interface TopbarGeom {
  /** The visible Search control (the phone IconButton or the laptop field-button). */
  search: Box | null;
  /** [data-topbar-slot="sort"]. */
  sort: Box | null;
  /** [data-topbar-slot="primary"]. */
  primary: Box | null;
  /** The Account menu (avatar) button. */
  avatar: Box | null;
  /** The viewport width (below md the phone key rules apply). Absent: md rules only. */
  viewportWidth?: number | undefined;
  /** The avatar's visible photo inside the Account menu button. */
  avatarFace?: Box | null | undefined;
  /** The operator's Cockpit dot, when shown (a key between Search and sort). */
  cockpit?: Box | null | undefined;
  /** The "+" face, when the primary slot holds the TopbarPlus. */
  plus?: TopbarPlusGeom | null | undefined;
}

const right = (b: Box): number => b.x + b.width;
const centreX = (b: Box): number => b.x + b.width / 2;
const centreY = (b: Box): number => b.y + b.height / 2;

/**
 * Below md (10 Nov 2026): Search, sort, "+" and the avatar are 36 x 44 strips,
 * touching (gap 0), centres 36 apart; the avatar photo's right edge stays 22
 * in from the viewport edge. The "+" face is the outlined 22 square, centred
 * in its slot. Pure.
 */
function topbarPhoneViolations(g: TopbarGeom, vw: number): string[] {
  const out: string[] = [];
  const keys: Array<[string, Box | null]> = [
    ['Search', g.search],
    ...(g.cockpit !== null && g.cockpit !== undefined
      ? [['Cockpit dot', g.cockpit] as [string, Box | null]]
      : []),
    ['sort slot', g.sort],
    ['"+" slot', g.primary],
    ['avatar', g.avatar],
  ];
  for (const [name, box] of keys) {
    if (box === null) continue;
    if (!near(box.width, TOPBAR_KEY_PX) || !near(box.height, TOPBAR_SLOT_PX)) {
      out.push(`phone: the ${name} is ${box.width}x${box.height}, not a 36x44 key strip`);
    }
  }
  for (let i = 1; i < keys.length; i += 1) {
    const [prevName, prev] = keys[i - 1] ?? ['', null];
    const [name, box] = keys[i] ?? ['', null];
    if (prev === null || box === null) continue;
    const gap = box.x - right(prev);
    if (!near(gap, 0))
      out.push(`phone: the ${prevName} and the ${name} are ${gap}px apart, not touching`);
    const step = centreX(box) - centreX(prev);
    if (Math.abs(step - TOPBAR_KEY_PX) > TOPBAR_ALIGN_PX) {
      out.push(`phone: the ${prevName} and the ${name} centres are ${step}px apart, not 36`);
    }
  }
  if (g.avatarFace !== null && g.avatarFace !== undefined) {
    const want = vw - TOPBAR_AVATAR_RIGHT_INSET_PX;
    if (Math.abs(right(g.avatarFace) - want) > TOPBAR_ALIGN_PX) {
      out.push(`phone: the avatar photo ends at ${right(g.avatarFace)}, not ${want} (main's edge)`);
    }
  }
  const plus = g.plus;
  if (plus !== null && plus !== undefined) {
    const want = TOPBAR_PLUS_PHONE;
    if (plus.face !== 'phone') out.push('phone: the "+" shows its laptop face');
    if (!near(plus.box.width, want.face) || !near(plus.box.height, want.face)) {
      out.push(`phone: the "+" face is ${plus.box.width}x${plus.box.height}, not 22x22`);
    }
    if (Math.abs(plus.borderWidth - want.line) > 0.1) {
      out.push(`phone: the "+" line is ${plus.borderWidth}, not 1.75`);
    }
    if (!near(plus.radius, want.radius)) out.push(`phone: the "+" radius is ${plus.radius}, not 7`);
    if (!/^(transparent|rgba\(0, 0, 0, 0\))$/.test(plus.background)) {
      out.push(`phone: the "+" face is filled (${plus.background}), not transparent`);
    }
    if (plus.glyph === null || !near(plus.glyph.width, want.glyph)) {
      out.push(`phone: the "+" glyph is ${plus.glyph?.width ?? 'missing'}, not 14`);
    }
    if (g.primary !== null) {
      const dx = centreX(plus.box) - centreX(g.primary);
      const dy = centreY(plus.box) - centreY(g.primary);
      if (Math.abs(dx) > TOPBAR_ALIGN_PX || Math.abs(dy) > TOPBAR_ALIGN_PX) {
        out.push(`phone: the "+" face centre is ${dx},${dy} off its slot's centre`);
      }
    }
  }
  return out;
}

/** md and up: sort 44 x 44, the primary 112 x 44, the "+" the 112 x 32 accent Main. Pure. */
function topbarLaptopViolations(g: TopbarGeom): string[] {
  const out: string[] = [];
  const slots: Array<[string, Box | null, number]> = [
    ['sort', g.sort, TOPBAR_SLOT_PX],
    ['primary', g.primary, TOPBAR_PRIMARY_MD_PX],
  ];
  for (const [name, box, width] of slots) {
    if (box === null) continue;
    if (!near(box.width, width) || !near(box.height, TOPBAR_SLOT_PX)) {
      out.push(`${name} slot is ${box.width}x${box.height}, not ${width}x44 (a fixed slot)`);
    }
  }
  const { search, sort, primary, avatar } = g;
  if (search !== null && sort !== null && right(search) > sort.x + LIST_CARD_PX_TOLERANCE) {
    out.push(`Search ends at ${right(search)}, after the sort slot starts at ${sort.x}`);
  }
  if (sort !== null && primary !== null) {
    const gap = primary.x - right(sort);
    if (gap < -LIST_CARD_PX_TOLERANCE || gap > TOPBAR_GAP_MAX_PX) {
      out.push(`the sort slot and the "+" slot are ${gap}px apart (sort right before "+")`);
    }
  }
  if (primary !== null && avatar !== null) {
    const gap = avatar.x - right(primary);
    if (gap < -LIST_CARD_PX_TOLERANCE || gap > TOPBAR_GAP_MAX_PX) {
      out.push(`the "+" slot and the avatar are ${gap}px apart ("+" last before the avatar)`);
    }
  }
  const plus = g.plus;
  if (plus !== null && plus !== undefined) {
    const want = TOPBAR_PLUS_LAPTOP;
    if (plus.face !== 'laptop') out.push('laptop: the "+" shows its phone face');
    if (!near(plus.box.width, want.width) || !near(plus.box.height, want.height)) {
      out.push(`laptop: the "+" face is ${plus.box.width}x${plus.box.height}, not 112x32`);
    }
    if (!near(plus.radius, want.radius))
      out.push(`laptop: the "+" radius is ${plus.radius}, not 8`);
    const fill = plus.blocked?.fill ?? plus.accent;
    if (plus.background !== fill) {
      const what = plus.blocked ? 'the blocked fg-3' : 'the accent';
      out.push(`laptop: the "+" fill is ${plus.background}, not ${what} ${fill}`);
    }
    if (avatar !== null) {
      const dy = centreY(plus.box) - centreY(avatar);
      if (Math.abs(dy) > TOPBAR_ALIGN_PX) {
        out.push(`laptop: the "+" face's centre is ${dy}px off the avatar's`);
      }
    }
  }
  return out;
}

/**
 * Decision A: the top bar reads search | sort | "+" | avatar, left to right,
 * the "+" last before the avatar and the sort right before the "+" (empty
 * slots keep their box). Below md (10 Nov 2026) the keys are 36 x 44 strips
 * 36 apart; from md the sort is 44 x 44 and the "+" slot 112 x 44, gap-1. A
 * bar with no slots (no workspace yet, Activity's pair) is not checked. Pure.
 */
export function topbarViolations(g: TopbarGeom): string[] {
  if (g.sort === null && g.primary === null) return [];
  const out: string[] = [];
  if (g.sort === null) out.push('no sort slot ([data-topbar-slot="sort"])');
  if (g.primary === null) out.push('no primary slot ([data-topbar-slot="primary"])');
  if (g.search === null) out.push('no visible Search in the top bar');
  if (g.avatar === null) out.push('no Account menu (avatar) in the top bar');
  const vw = g.viewportWidth;
  if (vw !== undefined && vw < TOPBAR_MD_PX) return [...out, ...topbarPhoneViolations(g, vw)];
  return [...out, ...topbarLaptopViolations(g)];
}

/** One screen's slot positions, for the across-screens check. */
export interface TopbarSlotsAt {
  screen: string;
  sortX: number;
  primaryX: number;
}

/**
 * The sort and "+" slots sit at one x on every list screen (they never move
 * between tabs): each screen against the first. Pure.
 */
export function topbarDriftViolations(rows: readonly TopbarSlotsAt[]): string[] {
  const first = rows[0];
  if (first === undefined) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (Math.abs(r.sortX - first.sortX) > TOPBAR_DRIFT_PX) {
      out.push(`${r.screen}: sort slot at x ${r.sortX}, ${first.screen} at ${first.sortX}`);
    }
    if (Math.abs(r.primaryX - first.primaryX) > TOPBAR_DRIFT_PX) {
      out.push(`${r.screen}: "+" slot at x ${r.primaryX}, ${first.screen} at ${first.primaryX}`);
    }
  }
  return out;
}

/** One chip row ([data-chip-row]) with a pinned Select ([data-chip-row-select]). */
export interface ChipRowGeom {
  label: string;
  /** The row's box. */
  row: Box;
  /** The row's right padding (the Select's 44 box is pulled out toward the edge). */
  paddingRight: number;
  /** The chips' scroller ([data-chip-scroll]). */
  scroll: Box | null;
  /** The pinned Select's wrapper ([data-chip-row-select]). */
  select: Box | null;
  /** The Select button itself ([data-section-select]). */
  button: Box | null;
}

/**
 * Decision E: the visible Select is pinned at the chip row's end (its right
 * edge on the row's content edge), the chips scroll in their own box that
 * ends before it (never under it), the Select's tap box is at least 44 tall
 * and it sits on the chips' line (centred with them). Rows without a Select
 * are not checked. Pure.
 */
export function chipRowViolations(rows: readonly ChipRowGeom[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.select === null) continue;
    const contentRight = r.row.x + r.row.width - r.paddingRight;
    const selectRight = r.select.x + r.select.width;
    if (Math.abs(selectRight - contentRight) > 1) {
      out.push(
        `${r.label} Select ends at ${selectRight}, the row's content edge is ${contentRight} (not pinned at the end)`,
      );
    }
    if (r.scroll !== null && r.scroll.x + r.scroll.width > r.select.x + LIST_CARD_PX_TOLERANCE) {
      out.push(
        `${r.label} chips run to ${r.scroll.x + r.scroll.width}, under the Select at ${r.select.x}`,
      );
    }
    if (r.button === null) {
      out.push(`${r.label} has no Select button ([data-section-select])`);
      continue;
    }
    if (r.button.height < CHIP_HIT_PX - LIST_CARD_PX_TOLERANCE) {
      out.push(`${r.label} Select is ${r.button.height}px tall, under 44`);
    }
    if (r.scroll !== null && r.scroll.height > 0) {
      const mid = (b: Box): number => b.y + b.height / 2;
      if (Math.abs(mid(r.button) - mid(r.scroll)) > 1) {
        out.push(
          `${r.label} Select is off the chips' line (centre ${mid(r.button)} vs ${mid(r.scroll)})`,
        );
      }
    }
  }
  return out;
}

/** A visible progress bar ([role=progressbar] or <progress>) on an upload screen. */
export interface UploadBarItem {
  label: string;
  box: Box;
}

/**
 * Decision F: an upload shows ui/UploadRing (its role="progressbar" is
 * sr-only, a 1px box) or Retry, never a visible bar and never a % figure.
 * Any shown progress bar bigger than 1x1, and any "N%" text in an upload's
 * surroundings, is a fault. Pure.
 */
export function uploadBarViolations(
  bars: readonly UploadBarItem[],
  percentTexts: readonly string[],
): string[] {
  const out: string[] = [];
  for (const bar of bars) {
    if (bar.box.width > 1 && bar.box.height > 1) {
      out.push(
        `${bar.label} is a visible progress bar (${boxText(bar.box)}): uploads show the ring only`,
      );
    }
  }
  for (const text of percentTexts) {
    if (/\d\s?%/.test(text)) out.push(`"${text}" shows a % figure on an upload`);
  }
  return out;
}

/** The writing box row's hit height (RowKey and RowSend: h-11). */
export const WRITING_KEY_PX = 44;

/** One writing box as measured: its frame, its row keys and its send. */
export interface WritingBoxGeom {
  label: string;
  frame: Box;
  /** Every shown row key ([data-composer-key]) and the send ([data-row-send]). */
  keys: ReadonlyArray<{ label: string; box: Box }>;
  /** The send's box, when the box shows one. */
  send: Box | null;
}

/**
 * Check 11: a writing box's row keys and send are 44 tall hits, and the send
 * ends inside the box's frame (never past its right edge). Pure.
 */
export function writingBoxViolations(boxes: readonly WritingBoxGeom[]): string[] {
  const out: string[] = [];
  for (const box of boxes) {
    for (const key of box.keys) {
      if (Math.abs(key.box.height - WRITING_KEY_PX) > 0.5) {
        out.push(
          `${box.label} ${key.label} is ${Math.round(key.box.height * 10) / 10}px tall, ` +
            `not ${WRITING_KEY_PX}`,
        );
      }
    }
    if (box.send !== null) {
      const sendRight = box.send.x + box.send.width;
      const frameRight = box.frame.x + box.frame.width;
      if (sendRight > frameRight + 0.5) {
        out.push(
          `${box.label} send ends at ${Math.round(sendRight)}px, past the box (${Math.round(frameRight)}px)`,
        );
      }
    }
  }
  return out;
}

/**
 * A comment's action bar as measured (8 Nov 2026): the pill, the row it rides
 * on ([data-comment-row]), its buttons' hit boxes, and the times, names and
 * titles of everything around it (other rows, the section title).
 */
export interface CommentBarGeom {
  label: string;
  bar: Box;
  row: Box;
  buttons: Box[];
  around: Array<{ label: string; box: Box }>;
}

/** How far the bar's middle may sit from its row's top edge, and its end from the row's end. */
export const COMMENT_BAR_TOLERANCE_PX = 2;

/**
 * The comment bar rules: every button a 44 hit; the pill's middle on its
 * row's top edge (half above it); its trailing end on the row's end; and it
 * covers no time, name or title around it. Pure.
 */
export function commentBarViolations(bars: readonly CommentBarGeom[]): string[] {
  const out: string[] = [];
  for (const b of bars) {
    for (const button of b.buttons) {
      if (button.width < 44 - 0.5 || button.height < 44 - 0.5) {
        out.push(`${b.label}: a bar button is ${boxText(button)}, not a 44 hit`);
      }
    }
    const middle = b.bar.y + b.bar.height / 2;
    if (Math.abs(middle - b.row.y) > COMMENT_BAR_TOLERANCE_PX) {
      out.push(
        `${b.label}: the bar's middle is ${Math.round((middle - b.row.y) * 10) / 10}px from its row's top, not on it`,
      );
    }
    const end = b.bar.x + b.bar.width;
    const rowEnd = b.row.x + b.row.width;
    if (Math.abs(end - rowEnd) > COMMENT_BAR_TOLERANCE_PX) {
      out.push(
        `${b.label}: the bar ends ${Math.round((rowEnd - end) * 10) / 10}px before its row's end`,
      );
    }
    for (const near of b.around) {
      if (overlaps(b.bar, near.box)) out.push(`${b.label}: the bar covers ${near.label}`);
    }
  }
  return out;
}

// Alignment rules (9 Nov 2026, CLAUDE.md "Alignment"): measured, never eyeballed.
/** Two edges within this many px are the same edge (rules 1 to 3). */
export const ALIGN_TOLERANCE_PX = 1;
/** Rule 5: the least space between a text block and a hairline. */
export const TEXT_TO_HAIRLINE_MIN_PX = 12;
/** Rule 2: the photo-to-text gap of a hung photo. */
export const PHOTO_TEXT_GAP_PX = 12;

/**
 * Activity's spacing (9 Nov 2026), text box to text box, in px: the head card
 * to its first line, a line to the next (and the last line to "+N more"), the
 * day label to its first card, a day's last card to the next day label.
 */
export const ACTIVITY_GAPS = {
  headToLine: 8,
  lineToLine: 12,
  labelToCard: 12,
  dayToLabel: 24,
} as const;

/** A measured x (a left or right edge) and what it is. */
export interface EdgeAt {
  label: string;
  x: number;
}

/** A vertical gap that must equal a value (±1) or reach a minimum. */
export interface GapAt {
  label: string;
  gap: number;
  /** Exactly this (±1); absent: at least `min`. */
  equals?: number;
  min?: number;
}

/** One card or row family, as measured on a screen. */
export interface AlignFamily {
  label: string;
  /** Rule 1: every text line's left edge (the first is the column). */
  textLefts: EdgeAt[];
  /** Rule 3: times, tags, unread dots and trailing glyphs' right edges. */
  rightEdges: EdgeAt[];
  /** Rule 2: a hung photo's right edge vs its parent picture's, and its gap to the text. */
  hung?: Array<{ label: string; photoRight: number; pictureRight: number; textLeft: number }>;
  /** Rule 5: text to hairline (and the strip's spec gaps). */
  gaps: GapAt[];
  /** Same relationship, same gap: these gaps are all equal (±1). */
  sameGaps?: GapAt[];
  /** Lines whose last visual line holds only the time (a lone time; never allowed). */
  loneTimes?: string[];
}

const sameEdge = (a: number, b: number): boolean => Math.abs(a - b) <= ALIGN_TOLERANCE_PX;
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The alignment rules 1, 2, 3 and 5 over measured families. Pure. */
export function alignmentViolations(families: readonly AlignFamily[]): string[] {
  const out: string[] = [];
  for (const f of families) {
    const column = f.textLefts[0];
    if (column !== undefined) {
      for (const t of f.textLefts.slice(1)) {
        if (!sameEdge(t.x, column.x)) {
          out.push(
            `${f.label}: ${t.label} starts at x ${r1(t.x)}, not on the text column (${column.label} ${r1(column.x)})`,
          );
        }
      }
    }
    const edge = f.rightEdges[0];
    if (edge !== undefined) {
      for (const e of f.rightEdges.slice(1)) {
        if (!sameEdge(e.x, edge.x)) {
          out.push(
            `${f.label}: ${e.label} ends at x ${r1(e.x)}, not on the right edge (${edge.label} ${r1(edge.x)})`,
          );
        }
      }
    }
    for (const h of f.hung ?? []) {
      if (!sameEdge(h.photoRight, h.pictureRight)) {
        out.push(
          `${f.label}: ${h.label} photo ends at ${r1(h.photoRight)}, not on the picture's right edge ${r1(h.pictureRight)}`,
        );
      }
      if (!sameEdge(h.textLeft - h.photoRight, PHOTO_TEXT_GAP_PX)) {
        out.push(
          `${f.label}: ${h.label} photo to text is ${r1(h.textLeft - h.photoRight)}px, not ${PHOTO_TEXT_GAP_PX}`,
        );
      }
    }
    for (const g of f.gaps) {
      if (g.equals !== undefined && !sameEdge(g.gap, g.equals)) {
        out.push(`${f.label}: ${g.label} is ${r1(g.gap)}px, not ${g.equals}`);
      }
      const min = g.min ?? (g.equals === undefined ? TEXT_TO_HAIRLINE_MIN_PX : undefined);
      if (min !== undefined && g.gap < min - 0.5) {
        out.push(`${f.label}: ${g.label} is ${r1(g.gap)}px, under ${min}`);
      }
    }
    for (const label of f.loneTimes ?? []) {
      out.push(`${f.label}: ${label} ends with the time alone on its last line`);
    }
    const same = f.sameGaps ?? [];
    const first = same[0];
    if (first !== undefined) {
      for (const g of same.slice(1)) {
        if (!sameEdge(g.gap, first.gap)) {
          out.push(
            `${f.label}: ${g.label} is ${r1(g.gap)}px, not the same as ${first.label} (${r1(first.gap)})`,
          );
        }
      }
    }
  }
  return out;
}
