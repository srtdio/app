// The pure judgement behind the phone rules (layout-checks-phone.ts measures
// the page; this file decides). No Playwright, no DOM: plain geometry in,
// violations out, unit tested in src/__tests__/layout-checks-phone.test.ts.
//
// The rules (phone = under 768 wide; 390, 360 and 320 all run them):
//   R1  no text over other text; no text outside its button, chip, tab or tag;
//       no text past the screen edge; no line sliced top or bottom by its box;
//   R3  button, chip and tab labels, dates, times and counts are never cut;
//   R5  bordered or filled controls keep 16 from the screen edge and 8 side
//       padding around their label;
//   R7  the first visible thing in a row sits on 16;
//   R8  the last visible thing in a row sits 16 from the right;
//   R9  nothing sits 1.5 to 10 off a column (16, 64, or any x three or more
//       things share);
//   R10 a bar's title starts at 64 after a leading icon key, else at 16;
//   R11 everything in a bar, or in a row between two hairlines, sits on the
//       strip's vertical centre (two stacked lines centre as a pair);
//   R12 an icon and the text beside it share one centre line;
//   R13 like siblings in one row or list have equal gaps.
// R2, R4 and R6 allow things; they are the conditions the rules above skip.
//
// What keeps it honest without noise (each narrowing is deliberate):
//   - Only what the measurement saw on the topmost layer is judged.
//   - An alignment rule flags an item only when it is NEAR its line: more than
//     PHONE_TOLERANCE off, at most PHONE_NEAR off. Anything further away is not
//     an edge or column item at all (a centred title, a time mid-row).
//   - Centred things (text-align centre, centred in their parent, a centred
//     flex group), right-aligned text, inline text that follows other text,
//     anything in a sideways scroller (R4) or moved by a transform (a row
//     mid-swipe) are never edge or column items.
//   - A bordered or filled box narrower than the page (a card, a filled
//     control, a picture) is the aligned item; what sits inside it answers to
//     the box's own inset, so only R1, R3, R5, R11 and R12 look inside.
//   - R7 / R8 judge a glyph only when it is the icon of an icon-only key in a
//     bar, or of a key named back / close (R8: more, close, share, download,
//     sort, options, menu). A bare glyph's ink inset differs per icon, so
//     R9 is judged on pictures, bordered or filled controls and text only.
//   - R7 / R8 judge an item only when the layout pins it to that side: at
//     every level up to the page it sits on the content edge, so a chip that
//     merely ends near the right edge, or anything pushed, is not judged.
//     Equal gaps on both sides read as centred.
//   - R9 judges an item only when its x is set by the layout: first in its
//     row, or hung beside one leading picture or icon (the text column).
//   - R3 knows a label by its hook (chip and tab labels, <time>, list-card
//     times, counts) or by its control centring it in a row (ui/Button's
//     shape). A start-aligned control is a row and a column one a tile or
//     card, whose names and captions may end in an ellipsis (R2).
//   - R5's 8 side padding is judged on controls wider than tall (a round or
//     square key holds a glyph or a figure, not a padded label).
//   - R10 runs on bars as wide as the screen; R10 and R11 know a bar by its
//     hook (header, [data-header-bar], ui/Sheet's header, [data-select-bar])
//     and a hairline row by its borders, both at most 72 tall.
//   - R12 runs on flex rows that ask for centring (align-items: center), on an
//     icon and a one-line text that each stand alone in their child of the row.
//   - R13 calls siblings alike only when tag, class list and margins match.
// Nothing else silences a rule: by-design cases live in PHONE_RULE_EXEMPTIONS.

import type { Box } from './layout-checks-core';

/** Phone = under this width (Tailwind md). */
export const PHONE_MAX_WIDTH = 768;
/** One tolerance for every phone rule, CSS px. */
export const PHONE_TOLERANCE = 1.5;
/** The page gutter: the left column, and the distance kept from the right edge. */
export const PHONE_GUTTER = 16;
/** The text column beside a 36 picture on the gutter (ROW_TEXT_START_PHONE + 16). */
export const PHONE_TEXT_COLUMN = 64;
/** The columns every phone screen has, whatever it shows. */
export const PHONE_COLUMNS: readonly number[] = [PHONE_GUTTER, PHONE_TEXT_COLUMN];
/** An item more than this off a line is not an item of that line. */
export const PHONE_NEAR = 10;
/** Lefts this close are one column. */
export const PHONE_COLUMN_SNAP = 0.75;
/** A column is an x this many items share. */
export const PHONE_COLUMN_MIN = 3;
/** R5: side padding between a bordered or filled control's edge and its label. */
export const PHONE_CONTROL_PAD = 8;
/** R1: two inks overlap when they share more than this, both ways. */
export const PHONE_OVERLAP_MIN = { width: 1.5, height: 2 } as const;
/** At most this many findings per rule are listed (the count is always given). */
export const PHONE_MAX_LISTED = 12;

export type PhoneRule = 'R1' | 'R3' | 'R5' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13';

export interface PhoneExemption {
  rule: PhoneRule;
  /** The item, or any ancestor of it, matches (Element.closest). */
  selector: string;
  reason: string;
}

const CORNER_BADGES =
  '[data-count-badge], [data-presence], [data-select-check], [data-list-card-tick], [data-row-badge]';
const INLINE_FOLLOWERS = '[data-mention], [data-more], [data-activity-preview-fold], p a, span a';
const INSET_CARDS =
  '[data-chat-card], [data-catch-up-card], [data-link-card], [data-caption-quote], [data-quote-line], .fmt-quote';

/**
 * R14: the one list of by-design exceptions. Nothing else silences a rule.
 * A new entry needs a real hook and a one-line reason.
 */
export const PHONE_RULE_EXEMPTIONS: readonly PhoneExemption[] = [
  {
    rule: 'R1',
    selector: CORNER_BADGES,
    reason: 'a badge rides the corner of its icon or picture, outside the key box by design',
  },
  {
    rule: 'R11',
    selector: CORNER_BADGES,
    reason: 'a corner badge sits on its icon corner, not on the strip centre',
  },
  {
    rule: 'R12',
    selector: CORNER_BADGES,
    reason: 'a corner badge sits on its icon corner, not on the row centre line',
  },
  {
    rule: 'R7',
    selector: '[data-plan-day-weekday]',
    reason: 'Plan weekday labels are centred over their day column',
  },
  {
    rule: 'R9',
    selector: '[data-plan-day-weekday]',
    reason: 'Plan weekday labels are centred over their day column',
  },
  {
    rule: 'R7',
    selector: INLINE_FOLLOWERS,
    reason: 'inline text (a mention, a link, more / less) starts where the words before it end',
  },
  {
    rule: 'R9',
    selector: INLINE_FOLLOWERS,
    reason: 'inline text (a mention, a link, more / less) starts where the words before it end',
  },
  {
    rule: 'R7',
    selector: INSET_CARDS,
    reason: 'a card (chat card, catch-up card, link preview, quote) has its own inset',
  },
  {
    rule: 'R8',
    selector: INSET_CARDS,
    reason: 'a card (chat card, catch-up card, link preview, quote) has its own inset',
  },
  {
    rule: 'R9',
    selector: INSET_CARDS,
    reason: 'a card (chat card, catch-up card, link preview, quote) has its own inset',
  },
  {
    rule: 'R3',
    selector: '[data-topbar-workspace-name]',
    reason: 'the workspace name is a name (R2): it clamps to two lines and ends in "…"',
  },
  {
    rule: 'R8',
    selector: 'header:not([data-header-bar]) [data-avatar-kind]',
    reason: 'the top bar avatar photo ends 22 from the edge (TOPBAR_AVATAR_RIGHT_INSET_PX)',
  },
];

/** One visible line of a text item. */
export interface PhoneLine {
  /** The line's ink as it shows through its clips, viewport coordinates. */
  box: Box;
  /** Px of ink a clipping box (overflow hidden / clip) cuts off the top. */
  sliceTop: number;
  /** Px of ink a clipping box cuts off the bottom. */
  sliceBottom: number;
}

export type PhoneKind = 'text' | 'icon' | 'picture' | 'control';

/** One measured thing on the topmost layer. */
export interface PhoneItem {
  id: number;
  kind: PhoneKind;
  /** Names the item in a failure. */
  label: string;
  /** Visible ink: text = its lines' union, icon = its drawn shapes, picture / control = its box. */
  ink: Box;
  /** Text only: each visible line. */
  lines: PhoneLine[];
  /** The id of the nearest control (button, tab, chip face) this sits in. */
  control: number | null;
  /** Text only: the box of the nearest button, chip face, tab or tag it must stay inside. */
  holder: Box | null;
  /** Control only: a border on all four sides, or a fill. */
  faced: boolean;
  /** Control only: a flex row that centres its label (ui/Button's shape), not a row or a card. */
  labelCentred: boolean;
  /** Control only: its accessible name. */
  name: string;
  /** Inside a bordered or filled box narrower than the page, or inside a picture. */
  framed: boolean;
  /** Centred in its parent chain (auto margins, a centred flex or grid group). */
  centred: boolean;
  /** At every level that leaves it room it sits on the left content edge. */
  pinLeft: boolean;
  /** At every level that leaves it room it sits on the right content edge. */
  pinRight: boolean;
  /** Text only: inline text that follows other text on its line. */
  follows: boolean;
  /** Text only: its text-align. */
  align: 'start' | 'center' | 'end';
  /** Inside a sideways scroller (R4). */
  scrollsX: boolean;
  /** An ancestor's transform moves it sideways or turns it. */
  moved: boolean;
  /** A clip cuts it short of whole (a box, or a text line, scrolled part way out). */
  clipped: boolean;
  /** The nearest fixed / sticky ancestor's id (0 = the page). */
  layer: number;
  /** The nearest scroll container's id (0 = the page). */
  scroller: number;
  /** The index (PhoneGeom.strips) of the bar it sits in. */
  bar: number | null;
  /** The index of the innermost strip (bar or hairline row) it sits in. */
  strip: number | null;
  /** The id of the centring flex row it sits in. */
  flexRow: number | null;
  /** It is the only ink in its child of that flex row (text: on one line). */
  solo: boolean;
  /** Text only: a date, time, count, chip or tab label (R3 by its hook). */
  stamp: boolean;
  /** Text only: px of ink a clipping box cuts off sideways. */
  cutX: number;
  /** Text only: whole lines a clipping box hides (a line clamp). */
  hiddenLines: number;
  /** Text only: px of ink running past the left screen edge with nothing but the screen to stop it. */
  pastLeft: number;
  /** Text only: the same past the right screen edge. */
  pastRight: number;
  /** The rules PHONE_RULE_EXEMPTIONS lifts for it. */
  exempt: PhoneRule[];
}

/** A bar, or a row between two hairlines. */
export interface PhoneStrip {
  kind: 'bar' | 'row';
  label: string;
  /** Between its hairlines (the border box less its top and bottom borders). */
  box: Box;
  /** As wide as the screen. */
  fullWidth: boolean;
}

/** Like siblings (same tag, class list and margins) next to each other. */
export interface PhoneSiblings {
  label: string;
  axis: 'x' | 'y';
  /** The gap between each sibling and the next, in order. */
  gaps: number[];
}

export interface PhoneGeom {
  viewport: { width: number; height: number };
  items: PhoneItem[];
  strips: PhoneStrip[];
  siblings: PhoneSiblings[];
}

export interface PhoneViolation {
  rule: PhoneRule;
  message: string;
}

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;
const centreY = (b: Box): number => b.y + b.height / 2;
const round = (n: number): number => Math.round(n * 10) / 10;
const lifted = (item: PhoneItem, rule: PhoneRule): boolean => item.exempt.includes(rule);

/** More than the tolerance off, yet close enough to belong to the line. */
export function nearMiss(off: number): boolean {
  const d = Math.abs(off);
  return d > PHONE_TOLERANCE && d <= PHONE_NEAR;
}

function union(boxes: readonly Box[]): Box {
  let x = Infinity;
  let y = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const box of boxes) {
    x = Math.min(x, box.x);
    y = Math.min(y, box.y);
    r = Math.max(r, right(box));
    b = Math.max(b, bottom(box));
  }
  return { x, y, width: r - x, height: b - y };
}

// --- R1 ---------------------------------------------------------------------

/** R1: two different texts' lines share more than PHONE_OVERLAP_MIN. */
export function textOverlapViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const lines = items
    .filter((t) => t.kind === 'text' && !t.moved && !lifted(t, 'R1'))
    .flatMap((t) => t.lines.map((line) => ({ t, box: line.box })))
    .sort((a, b) => a.box.y - b.box.y);
  const seen = new Set<string>();
  const out: PhoneViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (b === undefined) continue;
      if (b.box.y >= bottom(a.box) - PHONE_OVERLAP_MIN.height) break;
      if (a.t.id === b.t.id || a.t.layer !== b.t.layer || a.t.scroller !== b.t.scroller) continue;
      const w = Math.min(right(a.box), right(b.box)) - Math.max(a.box.x, b.box.x);
      const h = Math.min(bottom(a.box), bottom(b.box)) - Math.max(a.box.y, b.box.y);
      if (w <= PHONE_OVERLAP_MIN.width || h <= PHONE_OVERLAP_MIN.height) continue;
      const key = `${Math.min(a.t.id, b.t.id)}:${Math.max(a.t.id, b.t.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        rule: 'R1',
        message: `${a.t.label} overlaps ${b.t.label} by ${round(w)}x${round(h)}`,
      });
    }
  }
  return out;
}

/** R1: a text's ink leaves the box of its button, chip, tab or tag. */
export function textSpillViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  for (const t of items) {
    if (t.kind !== 'text' || t.holder === null || t.clipped || lifted(t, 'R1')) continue;
    const ink = t.ink;
    const over = Math.max(
      t.holder.x - ink.x,
      right(ink) - right(t.holder),
      t.holder.y - ink.y,
      bottom(ink) - bottom(t.holder),
    );
    if (over <= PHONE_TOLERANCE) continue;
    out.push({
      rule: 'R1',
      message:
        `${t.label} spills ${round(over)} outside its box ` +
        `(ink ${round(ink.width)}x${round(ink.height)} in ${round(t.holder.width)}x${round(t.holder.height)})`,
    });
  }
  return out;
}

/** R1: text ink past a screen edge (sideways scrollers and moved rows aside, R4). */
export function textEdgeViolations(
  items: readonly PhoneItem[],
  viewportWidth: number,
): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  for (const t of items) {
    if (t.kind !== 'text' || t.scrollsX || t.moved || lifted(t, 'R1')) continue;
    if (t.pastLeft > PHONE_TOLERANCE) {
      out.push({ rule: 'R1', message: `${t.label} passes the left edge by ${round(t.pastLeft)}` });
    } else if (t.pastRight > PHONE_TOLERANCE) {
      out.push({
        rule: 'R1',
        message: `${t.label} passes the right edge by ${round(t.pastRight)} (screen ${viewportWidth} wide)`,
      });
    }
  }
  return out;
}

/** R1: a clipping box slices a line's ink top or bottom. */
export function slicedLineViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  for (const t of items) {
    if (t.kind !== 'text' || lifted(t, 'R1')) continue;
    const worst = t.lines.reduce((max, l) => Math.max(max, l.sliceTop, l.sliceBottom), 0);
    if (worst <= PHONE_TOLERANCE) continue;
    out.push({ rule: 'R1', message: `${t.label} has a line sliced by ${round(worst)}` });
  }
  return out;
}

// --- R3 ---------------------------------------------------------------------

/**
 * R3: a label that is never cut (a stamp by its hook, or text in a control
 * that centres its label, as every ui/Button does) loses ink sideways or
 * whole lines to a clip. A start-aligned control is a row and a column one a
 * tile or card: their names and captions may end in an ellipsis (R2).
 */
export function cutLabelViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const controls = controlsById(items);
  const out: PhoneViolation[] = [];
  for (const t of items) {
    if (t.kind !== 'text' || lifted(t, 'R3')) continue;
    const control = t.control === null ? undefined : controls.get(t.control);
    if (!t.stamp && control?.labelCentred !== true) continue;
    if (t.cutX > 1) {
      out.push({ rule: 'R3', message: `${t.label} is cut by ${round(t.cutX)}` });
    } else if (t.hiddenLines > 0) {
      out.push({ rule: 'R3', message: `${t.label} hides ${t.hiddenLines} of its lines` });
    }
  }
  return out;
}

// --- R5 ---------------------------------------------------------------------

/** R5: a bordered or filled control closer than 16 to a screen edge. */
export function controlEdgeViolations(
  items: readonly PhoneItem[],
  viewportWidth: number,
): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  for (const c of items) {
    if (c.kind !== 'control' || !c.faced || lifted(c, 'R5')) continue;
    if (c.scrollsX || c.moved || c.clipped || c.framed) continue;
    const left = c.ink.x;
    const rightGap = viewportWidth - right(c.ink);
    // Edge to edge is a full-bleed row, not a control near the edge.
    if (left <= 1 && rightGap <= 1) continue;
    if (left < PHONE_GUTTER - PHONE_TOLERANCE) {
      out.push({
        rule: 'R5',
        message: `${c.label} is ${round(left)} from the left edge (16 wanted)`,
      });
    }
    if (rightGap < PHONE_GUTTER - PHONE_TOLERANCE) {
      out.push({
        rule: 'R5',
        message: `${c.label} is ${round(rightGap)} from the right edge (16 wanted)`,
      });
    }
  }
  return out;
}

/** R5: a bordered or filled control with a text label keeps 8 side padding. */
export function controlPaddingViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const inside = new Map<number, PhoneItem[]>();
  for (const it of items) {
    if (it.control === null || it.kind === 'control') continue;
    inside.set(it.control, [...(inside.get(it.control) ?? []), it]);
  }
  const out: PhoneViolation[] = [];
  for (const c of items) {
    if (c.kind !== 'control' || !c.faced || c.clipped || lifted(c, 'R5')) continue;
    // A round or square key holds a glyph or a figure, not a padded label.
    if (c.ink.width <= c.ink.height + 1) continue;
    const content = inside.get(c.id) ?? [];
    if (!content.some((it) => it.kind === 'text')) continue;
    if (content.some((it) => lifted(it, 'R5'))) continue;
    const ink = union(content.map((it) => it.ink));
    const padLeft = ink.x - c.ink.x;
    const padRight = right(c.ink) - right(ink);
    const least = Math.min(padLeft, padRight);
    if (least >= PHONE_CONTROL_PAD - PHONE_TOLERANCE) continue;
    out.push({
      rule: 'R5',
      message: `${c.label} has ${round(padLeft)} / ${round(padRight)} side padding (8 wanted)`,
    });
  }
  return out;
}

// --- rows (R7, R8, R9) --------------------------------------------------------

/** What takes a place in a page row: bare ink and whole boxes, never a box's inside. */
function isRowMember(it: PhoneItem): boolean {
  return !it.framed && (it.kind !== 'control' || it.faced);
}

/**
 * The page's rows: members of one layer whose vertical centre falls inside
 * the row's tallest member (or the other way round). Each row is sorted by x.
 */
export function phoneRows(items: readonly PhoneItem[]): PhoneItem[][] {
  const byLayer = new Map<number, PhoneItem[]>();
  for (const it of items) {
    if (!isRowMember(it)) continue;
    byLayer.set(it.layer, [...(byLayer.get(it.layer) ?? []), it]);
  }
  const rows: PhoneItem[][] = [];
  for (const members of byLayer.values()) {
    const sorted = [...members].sort((a, b) => centreY(a.ink) - centreY(b.ink));
    let row: PhoneItem[] = [];
    let band: Box | null = null;
    for (const it of sorted) {
      const cy = centreY(it.ink);
      const joins =
        band !== null &&
        ((cy >= band.y && cy <= bottom(band)) ||
          (centreY(band) >= it.ink.y && centreY(band) <= bottom(it.ink)));
      if (band !== null && joins) {
        row.push(it);
        if (it.ink.height > band.height) band = it.ink;
      } else {
        if (row.length > 0) rows.push(row);
        row = [it];
        band = it.ink;
      }
    }
    if (row.length > 0) rows.push(row);
  }
  return rows.map((r) => [...r].sort((a, b) => a.ink.x - b.ink.x));
}

const LEADING_KEY = /^(back|close)\b/i;
const TRAILING_KEY = /\b(more|close|dismiss|share|download|sort|options|menu)\b/i;

function controlsById(items: readonly PhoneItem[]): Map<number, PhoneItem> {
  const out = new Map<number, PhoneItem>();
  for (const it of items) if (it.kind === 'control') out.set(it.id, it);
  return out;
}

/** The ids of controls that hold an icon and no text. */
function iconOnlyControls(items: readonly PhoneItem[]): Set<number> {
  const icons = new Set<number>();
  const texts = new Set<number>();
  for (const it of items) {
    if (it.control === null) continue;
    if (it.kind === 'icon') icons.add(it.control);
    if (it.kind === 'text') texts.add(it.control);
  }
  return new Set([...icons].filter((id) => !texts.has(id)));
}

function freeToAlign(it: PhoneItem): boolean {
  return !it.scrollsX && !it.moved && !it.clipped && !it.centred;
}

function isRowText(it: PhoneItem): boolean {
  return it.kind === 'text' && it.control === null && !it.follows && it.align === 'start';
}

/** R7 / R8: the first ink of a row on 16, the last 16 from the right. */
export function rowEdgeViolations(
  items: readonly PhoneItem[],
  viewportWidth: number,
): PhoneViolation[] {
  const controls = controlsById(items);
  const iconOnly = iconOnlyControls(items);
  const keyGlyph = (it: PhoneItem, names: RegExp): boolean => {
    if (it.kind !== 'icon' || it.control === null || !iconOnly.has(it.control)) return false;
    const key = controls.get(it.control);
    return key !== undefined && (it.bar !== null || names.test(key.name));
  };
  const out: PhoneViolation[] = [];
  for (const row of phoneRows(items)) {
    const first = row[0];
    if (first !== undefined && freeToAlign(first) && first.pinLeft && !lifted(first, 'R7')) {
      const judged =
        first.kind === 'picture' ||
        first.kind === 'control' ||
        isRowText(first) ||
        keyGlyph(first, LEADING_KEY);
      const off = first.ink.x - PHONE_GUTTER;
      if (judged && nearMiss(off)) {
        out.push({
          rule: 'R7',
          message: `${first.label} starts at ${round(first.ink.x)}, not 16 (off by ${round(off)})`,
        });
      }
    }
    const last = row.reduce<PhoneItem | undefined>(
      (max, it) => (max === undefined || right(it.ink) > right(max.ink) ? it : max),
      undefined,
    );
    if (last !== undefined && freeToAlign(last) && last.pinRight && !lifted(last, 'R8')) {
      const judged =
        last.kind === 'picture' || last.kind === 'control' || keyGlyph(last, TRAILING_KEY);
      const gap = viewportWidth - right(last.ink);
      const off = gap - PHONE_GUTTER;
      if (judged && nearMiss(off)) {
        out.push({
          rule: 'R8',
          message: `${last.label} ends ${round(gap)} from the right edge, not 16 (off by ${round(off)})`,
        });
      }
    }
  }
  return out;
}

/** The screen's columns: 16, 64 and every x three or more of the lefts share. */
export function phoneColumns(lefts: readonly number[]): number[] {
  const columns = [...PHONE_COLUMNS];
  const sorted = [...lefts].sort((a, b) => a - b);
  let group: number[] = [];
  const close = (): void => {
    if (group.length >= PHONE_COLUMN_MIN) {
      const x = group.reduce((sum, v) => sum + v, 0) / group.length;
      if (!columns.some((c) => Math.abs(c - x) <= PHONE_COLUMN_SNAP)) columns.push(x);
    }
    group = [];
  };
  for (const x of sorted) {
    const start = group[0];
    if (start !== undefined && x - start > PHONE_COLUMN_SNAP) close();
    group.push(x);
  }
  close();
  return columns;
}

/** R9: an item 1.5 to 10 off a column, and on no column itself. */
export function columnViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const judged: PhoneItem[] = [];
  for (const row of phoneRows(items)) {
    for (const it of row) {
      if (!freeToAlign(it) || lifted(it, 'R9')) continue;
      if (!(it.kind === 'picture' || it.kind === 'control' || isRowText(it))) continue;
      // Its x is the layout's only when it leads its row, or hangs beside
      // one leading picture or icon (the text column).
      const before = row.filter((other) => other.id !== it.id && right(other.ink) <= it.ink.x + 1);
      const lead = before[0];
      const hung =
        before.length === 1 &&
        lead !== undefined &&
        (lead.kind === 'picture' || lead.kind === 'icon');
      if (before.length === 0 ? it.pinLeft : hung) judged.push(it);
    }
  }
  const columns = phoneColumns(judged.map((it) => it.ink.x));
  const out: PhoneViolation[] = [];
  for (const it of judged) {
    const x = it.ink.x;
    if (columns.some((c) => Math.abs(x - c) <= PHONE_TOLERANCE)) continue;
    const column = columns.find((c) => nearMiss(x - c));
    if (column === undefined) continue;
    out.push({
      rule: 'R9',
      message: `${it.label} starts at ${round(x)}, ${round(x - column)} off the ${round(column)} column`,
    });
  }
  return out;
}

// --- R10 --------------------------------------------------------------------

/** R10: a full-width bar's title (and sub-line) at 64 after a leading icon key, else at 16. */
export function barTitleViolations(geom: PhoneGeom): PhoneViolation[] {
  const iconOnly = iconOnlyControls(geom.items);
  const out: PhoneViolation[] = [];
  geom.strips.forEach((strip, index) => {
    if (strip.kind !== 'bar' || !strip.fullWidth) return;
    const members = geom.items
      .filter((it) => it.bar === index && !it.moved && isRowMember(it))
      .sort((a, b) => a.ink.x - b.ink.x);
    const lead = members[0];
    if (lead === undefined) return;
    let want: number;
    if (lead.kind === 'icon' && lead.control !== null && iconOnly.has(lead.control)) {
      want = PHONE_TEXT_COLUMN;
    } else if (isRowText(lead)) {
      want = PHONE_GUTTER;
    } else {
      return;
    }
    for (const t of members) {
      if (!isRowText(t) || t.centred || t.scrollsX || lifted(t, 'R10')) continue;
      const x = t.ink.x - strip.box.x;
      if (!nearMiss(x - want)) continue;
      out.push({
        rule: 'R10',
        message: `${strip.label}: ${t.label} starts at ${round(x)}, not ${want} (off by ${round(x - want)})`,
      });
    }
  });
  return out;
}

// --- R11 --------------------------------------------------------------------

/** Items that overlap sideways stack: each stack is judged as one block. */
function stacks(members: readonly PhoneItem[]): PhoneItem[][] {
  const sorted = [...members].sort((a, b) => a.ink.x - b.ink.x);
  const out: PhoneItem[][] = [];
  let current: PhoneItem[] = [];
  let reach = -Infinity;
  for (const it of sorted) {
    if (current.length > 0 && it.ink.x < reach - 1) {
      current.push(it);
      reach = Math.max(reach, right(it.ink));
    } else {
      if (current.length > 0) out.push(current);
      current = [it];
      reach = right(it.ink);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** How many separate lines a stack holds (items that overlap vertically share one). */
function levels(stack: readonly PhoneItem[]): number {
  const sorted = [...stack].sort((a, b) => a.ink.y - b.ink.y);
  let count = 0;
  let reach = -Infinity;
  for (const it of sorted) {
    if (it.ink.y >= reach - 1) count += 1;
    reach = Math.max(reach, bottom(it.ink));
  }
  return count;
}

/** R11: every one-line item, or stacked pair, of a strip on the strip's vertical centre. */
export function stripCentreViolations(geom: PhoneGeom): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  geom.strips.forEach((strip, index) => {
    const members = geom.items.filter(
      (it) =>
        it.strip === index && !it.moved && !it.clipped && isRowMember(it) && !lifted(it, 'R11'),
    );
    const centre = centreY(strip.box);
    for (const stack of stacks(members)) {
      if (levels(stack) > 2) continue;
      const block = union(stack.map((it) => it.ink));
      const off = centreY(block) - centre;
      if (!nearMiss(off)) continue;
      const first = stack[0];
      if (first === undefined) continue;
      out.push({
        rule: 'R11',
        message:
          `${strip.label}: ${first.label}${stack.length > 1 ? ` (+${stack.length - 1})` : ''} ` +
          `sits ${round(Math.abs(off))} ${off > 0 ? 'below' : 'above'} the strip centre ` +
          `(${round(centreY(block))} vs ${round(centre)})`,
      });
    }
  });
  return out;
}

// --- R12 --------------------------------------------------------------------

/** R12: an icon and the one-line text beside it in a centring flex row share a centre line. */
export function rowCentreViolations(items: readonly PhoneItem[]): PhoneViolation[] {
  const rows = new Map<number, PhoneItem[]>();
  for (const it of items) {
    if (it.flexRow === null || !it.solo || it.moved || it.clipped || lifted(it, 'R12')) continue;
    if (it.kind !== 'icon' && it.kind !== 'text') continue;
    rows.set(it.flexRow, [...(rows.get(it.flexRow) ?? []), it]);
  }
  const out: PhoneViolation[] = [];
  for (const members of rows.values()) {
    const icons = members.filter((it) => it.kind === 'icon');
    const texts = members.filter((it) => it.kind === 'text' && it.lines.length === 1);
    let worst: { icon: PhoneItem; text: PhoneItem; off: number } | null = null;
    for (const icon of icons) {
      for (const text of texts) {
        const off = centreY(icon.ink) - centreY(text.ink);
        if (!nearMiss(off)) continue;
        if (worst === null || Math.abs(off) > Math.abs(worst.off)) worst = { icon, text, off };
      }
    }
    if (worst === null) continue;
    out.push({
      rule: 'R12',
      message:
        `${worst.icon.label} sits ${round(Math.abs(worst.off))} ${worst.off > 0 ? 'below' : 'above'} ` +
        `${worst.text.label} (centres ${round(centreY(worst.icon.ink))} vs ${round(centreY(worst.text.ink))})`,
    });
  }
  return out;
}

// --- R13 --------------------------------------------------------------------

/** R13: like siblings' gaps differ by more than the tolerance. */
export function gapViolations(groups: readonly PhoneSiblings[]): PhoneViolation[] {
  const out: PhoneViolation[] = [];
  for (const group of groups) {
    if (group.gaps.length < 2) continue;
    const least = Math.min(...group.gaps);
    const most = Math.max(...group.gaps);
    if (most - least <= PHONE_TOLERANCE) continue;
    out.push({
      rule: 'R13',
      message:
        `${group.label}: gaps differ along ${group.axis} ` +
        `(${group.gaps.map(round).join(', ')}; ${round(least)} to ${round(most)})`,
    });
  }
  return out;
}

// --- all --------------------------------------------------------------------

/** Every phone rule on one screen's geometry. Empty at 768 and wider. */
export function phoneViolations(geom: PhoneGeom): PhoneViolation[] {
  if (geom.viewport.width >= PHONE_MAX_WIDTH) return [];
  const vw = geom.viewport.width;
  return [
    ...textOverlapViolations(geom.items),
    ...textSpillViolations(geom.items),
    ...textEdgeViolations(geom.items, vw),
    ...slicedLineViolations(geom.items),
    ...cutLabelViolations(geom.items),
    ...controlEdgeViolations(geom.items, vw),
    ...controlPaddingViolations(geom.items),
    ...rowEdgeViolations(geom.items, vw),
    ...columnViolations(geom.items),
    ...barTitleViolations(geom),
    ...stripCentreViolations(geom),
    ...rowCentreViolations(geom.items),
    ...gapViolations(geom.siblings),
  ];
}

/**
 * The failure text: screen name, width, rule id, what, measured numbers. At
 * most PHONE_MAX_LISTED lines per rule; the rest are counted.
 */
export function formatPhoneViolations(
  screen: string,
  viewportWidth: number,
  violations: readonly PhoneViolation[],
): string {
  const byRule = new Map<PhoneRule, string[]>();
  for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v.message]);
  const lines: string[] = [];
  for (const [rule, messages] of byRule) {
    for (const message of messages.slice(0, PHONE_MAX_LISTED)) {
      lines.push(`[${screen} @${viewportWidth}] ${rule}: ${message}`);
    }
    if (messages.length > PHONE_MAX_LISTED) {
      lines.push(
        `[${screen} @${viewportWidth}] ${rule}: and ${messages.length - PHONE_MAX_LISTED} more`,
      );
    }
  }
  return lines.join('\n');
}
