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
}

/** Every pair of unrelated tap targets that overlap: [i, j] with i < j. */
export function overlappingPairs(targets: readonly TapTarget[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < targets.length; i += 1) {
    const a = targets[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < targets.length; j += 1) {
      const b = targets[j];
      if (b === undefined) continue;
      if (a.related.includes(j) || b.related.includes(i)) continue;
      if (overlaps(a.box, b.box)) out.push([i, j]);
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
    if (item.fullBleed) continue;
    const side = edgeHit(item.box, viewportWidth, min);
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
  check: 'one-line' | 'tap-overlap' | 'edge' | 'part-roles' | 'busy-width';
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
