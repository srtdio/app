import { test, type Locator, type Page } from '@playwright/test';
import {
  boxText,
  distinctRoles,
  edgeViolations,
  formatViolations,
  layoutMode,
  lineHeightPx,
  MAX_ROLES_PER_PART,
  overlappingPairs,
  roleSignature,
  sameWidth,
  tooManyRoles,
  wrapsPastOneLine,
  type Box,
  type EdgeItem,
  type LayoutViolation,
  type TapTarget,
} from './layout-checks-core';

// Automatic layout checks on every visual screen (screens.spec.ts capture()
// runs checkLayout right before toHaveScreenshot):
//   1 one-line parts (.truncate, [data-lines="1"]) never wrap onto a 2nd line;
//   2 no two visible tap targets (button, a, [role=button], input) overlap by
//     more than 1px, ancestors and descendants aside;
//   3 nothing painted (text runs, icons, fields) within 12px of a side edge,
//     except full-bleed media (img, video, [data-full-bleed]), full-width bars
//     and content that scrolls under the edge (a horizontal scroller);
//   4 no part ([data-part]) holds more than 3 distinct text roles (computed
//     font size + weight + family);
//   5 busy-state screens: a control keeps its width from idle to busy
//     (assertSameWidth).
// LAYOUT_CHECKS=strict (the default) fails the screen; LAYOUT_CHECKS=report
// records every finding as a test annotation and in the log, and passes.
// The geometry is pure and unit tested: layout-checks-core.ts.

const MODE = layoutMode(process.env.LAYOUT_CHECKS);

/** Strict: fail with every finding. Report: annotate and log, then go on. */
function settleFindings(screen: string, violations: readonly LayoutViolation[]): void {
  if (violations.length === 0) return;
  const text = formatViolations(screen, violations);
  if (MODE === 'strict') {
    throw new Error(`layout checks failed (LAYOUT_CHECKS=strict):\n${text}`);
  }
  test.info().annotations.push({ type: 'layout-checks', description: text });
  console.warn(`layout checks (report):\n${text}`);
}

interface RawLine {
  label: string;
  textHeight: number;
  lineHeight: string;
  fontSize: number;
}

interface RawTarget {
  label: string;
  box: Box;
  related: number[];
}

interface RawPart {
  label: string;
  styles: Array<{ fontSize: string; fontWeight: string; fontFamily: string; text: string }>;
}

interface RawPage {
  viewportWidth: number;
  lines: RawLine[];
  targets: RawTarget[];
  edges: EdgeItem[];
  parts: RawPart[];
}

/** Reads every box the checks need in one pass over the page. */
async function readPage(page: Page): Promise<RawPage> {
  return page.evaluate((): RawPage => {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;

    const toBox = (r: DOMRect): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height });

    /** A short name for an element: tag, a data- hook or aria-label, and its text. */
    const nameOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const hook = Array.from(el.attributes).find(
        (a) => a.name.startsWith('data-') && a.name !== 'data-slot',
      );
      const aria = el.getAttribute('aria-label');
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const bits = [
        tag,
        hook !== undefined ? `[${hook.name}${hook.value !== '' ? `="${hook.value}"` : ''}]` : '',
        aria !== null ? `[aria-label="${aria}"]` : '',
      ].join('');
      return text !== '' ? `${bits} "${text}"` : bits;
    };

    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        if (getComputedStyle(at).opacity === '0') return false;
      }
      return true;
    };

    /** Whether a point inside the box lands on the element (nothing covers it). */
    const onTop = (el: Element, r: DOMRect): boolean => {
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
      const hit = document.elementFromPoint(cx, cy);
      return hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
    };

    const textNodesOf = (root: Element): Text[] => {
      const out: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim() !== '') out.push(n as Text);
      }
      return out;
    };

    // 1 One-line parts.
    const lines: RawLine[] = [];
    for (const el of Array.from(document.querySelectorAll('.truncate, [data-lines="1"]'))) {
      if (!shown(el)) continue;
      let top = Infinity;
      let bottom = -Infinity;
      for (const node of textNodesOf(el)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 || rect.height === 0) continue;
          top = Math.min(top, rect.top);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      if (!Number.isFinite(top)) continue;
      const style = getComputedStyle(el);
      lines.push({
        label: nameOf(el),
        textHeight: bottom - top,
        lineHeight: style.lineHeight,
        fontSize: Number.parseFloat(style.fontSize),
      });
    }

    // 2 Tap targets.
    const tapEls = Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], input:not([type="hidden"]):not([type="file"])',
      ),
    ).filter((el) => {
      if (el.closest('[inert], [aria-hidden="true"]') !== null) return false;
      if (!shown(el)) return false;
      return onTop(el, el.getBoundingClientRect());
    });
    const targets: RawTarget[] = tapEls.map((el, i) => ({
      label: nameOf(el),
      box: toBox(el.getBoundingClientRect()),
      related: tapEls.flatMap((other, j) =>
        j !== i && (el.contains(other) || other.contains(el)) ? [j] : [],
      ),
    }));

    // 3 Painted things near the side edges.
    const scrollsUnderEdge = (el: Element): boolean => {
      for (let at: Element | null = el.parentElement; at !== null; at = at.parentElement) {
        const ox = getComputedStyle(at).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && at.scrollWidth > at.clientWidth + 1) return true;
      }
      return false;
    };
    const bleeds = (el: Element): boolean =>
      el.closest('img, video, canvas, picture, [data-full-bleed]') !== null || scrollsUnderEdge(el);
    const edges: EdgeItem[] = [];
    for (const node of textNodesOf(document.body)) {
      const parent = node.parentElement;
      if (parent === null || !shown(parent)) continue;
      if (parent.closest('script, style, noscript') !== null) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (!onTop(parent, r)) continue;
      edges.push({ label: nameOf(parent), box: toBox(r), fullBleed: bleeds(parent) });
    }
    for (const el of Array.from(document.querySelectorAll('svg, input, textarea, select'))) {
      // The outermost svg only (an icon's parts are not separate things).
      if (el.tagName.toLowerCase() === 'svg' && (el.parentElement?.closest('svg') ?? null) !== null) continue;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (!onTop(el, r)) continue;
      edges.push({ label: nameOf(el), box: toBox(r), fullBleed: bleeds(el) });
    }

    // 4 Text roles per part.
    const parts: RawPart[] = [];
    for (const part of Array.from(document.querySelectorAll('[data-part]'))) {
      if (!shown(part)) continue;
      const styles: RawPart['styles'] = [];
      const seen = new Set<Element>();
      for (const node of textNodesOf(part)) {
        const el = node.parentElement;
        if (el === null || seen.has(el) || !shown(el)) continue;
        seen.add(el);
        const s = getComputedStyle(el);
        styles.push({
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          fontFamily: s.fontFamily,
          text: (node.textContent ?? '').trim().slice(0, 24),
        });
      }
      parts.push({ label: `[data-part="${part.getAttribute('data-part') ?? ''}"]`, styles });
    }

    return { viewportWidth: vw, lines, targets, edges, parts };
  });
}

/**
 * Runs checks 1 to 4 on the screen as it stands. Strict (the default) throws
 * with every finding, each naming the screen and the element.
 */
export async function checkLayout(page: Page, screenName: string): Promise<void> {
  const raw = await readPage(page);
  const violations: LayoutViolation[] = [];

  for (const line of raw.lines) {
    const lh = lineHeightPx(line.lineHeight, line.fontSize);
    if (wrapsPastOneLine(line.textHeight, lh)) {
      violations.push({
        check: 'one-line',
        message: `${line.label} wraps (${Math.round(line.textHeight)}px of text, line ${lh}px)`,
      });
    }
  }

  const targets: TapTarget[] = raw.targets;
  for (const [i, j] of overlappingPairs(targets)) {
    const a = targets[i];
    const b = targets[j];
    if (a === undefined || b === undefined) continue;
    violations.push({
      check: 'tap-overlap',
      message: `${a.label} (${boxText(a.box)}) overlaps ${b.label} (${boxText(b.box)})`,
    });
  }

  for (const { item, side } of edgeViolations(raw.edges, raw.viewportWidth)) {
    violations.push({
      check: 'edge',
      message: `${item.label} within 12px of the ${side} edge (${boxText(item.box)})`,
    });
  }

  for (const part of raw.parts) {
    const signatures = part.styles.map(roleSignature);
    if (tooManyRoles(signatures)) {
      const roles = distinctRoles(signatures);
      violations.push({
        check: 'part-roles',
        message: `${part.label} holds ${roles.length} text roles (max ${MAX_ROLES_PER_PART}): ${roles.join(', ')}`,
      });
    }
  }

  settleFindings(screenName, violations);
}

/**
 * Check 5: the control keeps its width from idle to busy. Measures the
 * locator, runs the action (which must leave the control busy), measures the
 * locator again. The locator is re-resolved after the action, so it may name
 * a slot whose button swaps (the composer's send slot).
 */
export async function assertSameWidth(
  locator: Locator,
  action: () => Promise<void>,
): Promise<void> {
  const before = await locator.boundingBox();
  if (before === null) throw new Error(`assertSameWidth: ${String(locator)} has no box at idle`);
  await action();
  const after = await locator.boundingBox();
  if (after === null) throw new Error(`assertSameWidth: ${String(locator)} has no box when busy`);
  if (sameWidth(before.width, after.width)) return;
  settleFindings(test.info().title, [
    {
      check: 'busy-width',
      message: `${String(locator)} is ${before.width}px idle and ${after.width}px busy`,
    },
  ]);
}
