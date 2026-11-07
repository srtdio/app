import { test, type Locator, type Page } from '@playwright/test';
import {
  boxText,
  clipBox,
  distinctRoles,
  edgeViolations,
  formatViolations,
  layoutMode,
  lineHeightPx,
  listCardViolations,
  MAX_ROLES_PER_PART,
  overlappingPairs,
  roleSignature,
  sameWidth,
  tooManyRoles,
  wrapsPastOneLine,
  type Box,
  type EdgeItem,
  type LayoutViolation,
  type ListCardGeom,
  type TapTarget,
} from './layout-checks-core';

// Automatic layout checks on every visual screen (screens.spec.ts capture()
// runs checkLayout right before toHaveScreenshot):
//   1 one-line parts (.truncate, [data-lines="1"]) never wrap onto a 2nd line;
//   2 no two visible tap targets (button, a, [role=button], input) overlap by
//     more than 1px, each cut to its overflow clip; ancestors and
//     descendants, targets in different fixed/sticky layers, absolute
//     layering by design (a control whose containing block holds the other)
//     and pointer-events:none / aria-hidden / inert targets aside;
//   3 nothing painted (text runs, icons, fields) within 12px of a side edge,
//     measured on what shows through its overflow clip, except full-bleed
//     media (img, video, [data-full-bleed]), full-width bars, content that
//     scrolls under the edge (a horizontal scroller) and aria-hidden /
//     inert decoration;
//   4 no part ([data-part]) holds more than 3 distinct text roles (computed
//     font size + weight + family);
//   5 busy-state screens: a control keeps its width from idle to busy
//     (assertSameWidth);
//   6 list cards (ui/ListCard, [data-list-card]: Pipeline, Briefs, Assets, the
//     Chat list, Activity, the Plan tab and its Bank): every card on the screen
//     is the same height (within 1px) and 118 tall on every screen, so all six
//     lists match; each picture is 72x72, left, 16 inside the card edge, 12 to
//     the text.
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
  layer: number | null;
  layeredWith: number[];
  clip: Box;
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
  listCards: ListCardGeom[];
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

    /**
     * The rect an element shows through: the viewport cut by every ancestor
     * (itself included) that clips overflow. A fixed element escapes the
     * clips above it.
     */
    const clipOf = (el: Element): Box => {
      let left = 0;
      let top = 0;
      let right = vw;
      let bottom = vh;
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const s = getComputedStyle(at);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const r = at.getBoundingClientRect();
          if (at !== document.documentElement && at !== document.body) {
            left = Math.max(left, r.left);
            top = Math.max(top, r.top);
            right = Math.min(right, r.right);
            bottom = Math.min(bottom, r.bottom);
          }
        }
        if (s.position === 'fixed') break;
      }
      return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    };

    /** The nearest position:fixed or sticky element at or above el, or null. */
    const layerRootOf = (el: Element): Element | null => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const pos = getComputedStyle(at).position;
        if (pos === 'fixed' || pos === 'sticky') return at;
      }
      return null;
    };
    const layerIds = new Map<Element, number>();
    const layerOf = (el: Element): number | null => {
      const root = layerRootOf(el);
      if (root === null) return null;
      const known = layerIds.get(root);
      if (known !== undefined) return known;
      const id = layerIds.size;
      layerIds.set(root, id);
      return id;
    };

    /**
     * The position:absolute wrapper at or above el (below any fixed/sticky
     * layer) and its containing block, or null when el is in flow.
     */
    const absoluteOf = (el: Element): { wrapper: Element; block: Element } | null => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const pos = getComputedStyle(at).position;
        if (pos === 'fixed' || pos === 'sticky') return null;
        if (pos !== 'absolute') continue;
        return { wrapper: at, block: (at as HTMLElement).offsetParent ?? document.body };
      }
      return null;
    };

    /**
     * Whether a target is absolutely layered on other by design: its
     * absolute wrapper does not hold other, and that wrapper's containing
     * block is or holds other.
     */
    const layeredOn = (abs: { wrapper: Element; block: Element } | null, other: Element): boolean =>
      abs !== null &&
      !abs.wrapper.contains(other) &&
      (abs.block === other || abs.block.contains(other));

    /** Inside an aria-hidden or inert subtree. */
    const hiddenFromUse = (el: Element): boolean =>
      el.closest('[inert], [aria-hidden="true"]') !== null;

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
      if (hiddenFromUse(el)) return false;
      if (getComputedStyle(el).pointerEvents === 'none') return false;
      if (!shown(el)) return false;
      return onTop(el, el.getBoundingClientRect());
    });
    const absolutes = tapEls.map(absoluteOf);
    const targets: RawTarget[] = tapEls.map((el, i) => ({
      label: nameOf(el),
      box: toBox(el.getBoundingClientRect()),
      related: tapEls.flatMap((other, j) =>
        j !== i && (el.contains(other) || other.contains(el)) ? [j] : [],
      ),
      layer: layerOf(el),
      layeredWith: tapEls.flatMap((other, j) =>
        j !== i && (layeredOn(absolutes[i] ?? null, other) || layeredOn(absolutes[j] ?? null, el))
          ? [j]
          : [],
      ),
      clip: clipOf(el),
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
      edges.push({
        label: nameOf(parent),
        box: toBox(r),
        fullBleed: bleeds(parent),
        decorative: hiddenFromUse(parent),
        clip: clipOf(parent),
      });
    }
    for (const el of Array.from(document.querySelectorAll('svg, input, textarea, select'))) {
      // The outermost svg only (an icon's parts are not separate things).
      const inSvg = (el.parentElement?.closest('svg') ?? null) !== null;
      if (el.tagName.toLowerCase() === 'svg' && inSvg) continue;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (!onTop(el, r)) continue;
      edges.push({
        label: nameOf(el),
        box: toBox(r),
        fullBleed: bleeds(el),
        decorative: hiddenFromUse(el),
        clip: clipOf(el),
      });
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

    // 6 List cards: every shown ui/ListCard (never its loading box).
    const listCards: ListCardGeom[] = [];
    for (const card of Array.from(document.querySelectorAll('[data-list-card]'))) {
      if (!shown(card)) continue;
      const style = getComputedStyle(card);
      const picture = card.querySelector('[data-list-card-picture]');
      const text = picture?.nextElementSibling ?? null;
      listCards.push({
        label: nameOf(card),
        card: toBox(card.getBoundingClientRect()),
        borderLeft: parseFloat(style.borderLeftWidth) || 0,
        borderTop: parseFloat(style.borderTopWidth) || 0,
        picture: picture !== null ? toBox(picture.getBoundingClientRect()) : null,
        text: text !== null ? toBox(text.getBoundingClientRect()) : null,
      });
    }

    return { viewportWidth: vw, lines, targets, edges, parts, listCards };
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
    const shownBox = clipBox(item.box, item.clip) ?? item.box;
    violations.push({
      check: 'edge',
      message: `${item.label} within 12px of the ${side} edge (${boxText(shownBox)})`,
    });
  }

  for (const part of raw.parts) {
    const signatures = part.styles.map(roleSignature);
    if (tooManyRoles(signatures)) {
      const roles = distinctRoles(signatures);
      violations.push({
        check: 'part-roles',
        message:
          `${part.label} holds ${roles.length} text roles ` +
          `(max ${MAX_ROLES_PER_PART}): ${roles.join(', ')}`,
      });
    }
  }

  for (const message of listCardViolations(raw.listCards)) {
    violations.push({ check: 'list-card', message });
  }

  settleFindings(screenName, violations);
}

/**
 * Check 6 wiring: a screen that shows a list of ListCards must render at
 * least one, so the list-card rule runs on it (a list that slips back to a
 * hand-built row fails here, not silently).
 */
export async function assertListCards(page: Page, screenName: string): Promise<void> {
  const count = await page.locator('[data-list-card]:visible').count();
  if (count > 0) return;
  settleFindings(screenName, [
    { check: 'list-card', message: 'no [data-list-card] on a list-card screen' },
  ]);
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
  const before = await boxWhenVisible(locator, 'at idle');
  await action();
  const after = await boxWhenVisible(locator, 'when busy');
  if (sameWidth(before.width, after.width)) return;
  settleFindings(test.info().title, [
    {
      check: 'busy-width',
      message: `${String(locator)} is ${before.width}px idle and ${after.width}px busy`,
    },
  ]);
}

/** How long assertSameWidth waits for its control to show before it fails. */
const SAME_WIDTH_WAIT_MS = 10_000;

/**
 * The locator's box once it shows, waiting at most SAME_WIDTH_WAIT_MS; fails
 * with the locator and the state named (never the test's whole timeout).
 */
async function boxWhenVisible(locator: Locator, state: string): Promise<Box> {
  try {
    await locator.waitFor({ state: 'visible', timeout: SAME_WIDTH_WAIT_MS });
  } catch (error) {
    const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(
      `assertSameWidth: ${String(locator)} did not show ${state} within ` +
        `${SAME_WIDTH_WAIT_MS}ms (${why})`,
    );
  }
  const box = await locator.boundingBox({ timeout: SAME_WIDTH_WAIT_MS });
  if (box === null) throw new Error(`assertSameWidth: ${String(locator)} has no box ${state}`);
  return box;
}
