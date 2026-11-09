import { test, type Locator, type Page } from '@playwright/test';
import {
  boxText,
  clipBox,
  distinctRoles,
  edgeViolations,
  formatViolations,
  isLiftedLayer,
  layoutDensity,
  layoutMode,
  movedSideways,
  lineHeightPx,
  chipRowViolations,
  chipViolations,
  commentBarViolations,
  listCardViolations,
  MAX_ROLES_PER_PART,
  overlappingPairs,
  pinnedBarViolations,
  roleSignature,
  sameWidth,
  tooManyRoles,
  topbarDriftViolations,
  topbarViolations,
  trayTileViolations,
  underBarViolations,
  uploadBarViolations,
  wrapsPastOneLine,
  writingBoxViolations,
  threadHeaderViolations,
  type ThreadHeaderGeom,
  type Box,
  type ChipGeom,
  type ChipRowGeom,
  type CommentBarGeom,
  type EdgeItem,
  type LayoutDensity,
  type LayoutViolation,
  type ListCardGeom,
  type TapTarget,
  type TopbarGeom,
  type TopbarSlotsAt,
  type UploadBarItem,
  type WritingBoxGeom,
} from './layout-checks-core';

// Automatic layout checks on every visual screen (screens.spec.ts capture()
// runs checkLayout right before toHaveScreenshot):
//   1 one-line parts (.truncate, [data-lines="1"]) never wrap onto a 2nd line;
//   2 no two visible tap targets (button, a, [role=button], input) overlap by
//     more than 1px, each cut to its overflow clip; ancestors and
//     descendants, targets in different fixed/sticky layers, absolute
//     layering by design (a control whose containing block holds the other),
//     a lifted layer (positioned, own z-index) over a scroller it sits
//     outside of (content scrolls under it, as under a sticky head) and
//     pointer-events:none / aria-hidden / inert targets aside;
//   3 nothing painted (text runs, icons, fields) within 12px of a side edge,
//     measured on what shows through its overflow clip, except full-bleed
//     media (img, video, [data-full-bleed]), full-width bars, content that
//     scrolls under the edge (a horizontal scroller) or is moved sideways by
//     a transform (a row mid-swipe) and aria-hidden / inert decoration;
//   4 no part ([data-part]) holds more than 3 distinct text roles (computed
//     font size + weight + family);
//   5 busy-state screens: a control keeps its width from idle to busy
//     (assertSameWidth);
//   6 list cards (ui/ListCard, [data-list-card]: Pipeline, Briefs, Assets, the
//     Chat list, Activity, the Plan tab and its Bank): every card on the screen
//     is the same height (within 1px) and the density height on every screen
//     (<html data-density>: Compact 60, Cozy 72 default, Calm 80), so all seven
//     lists match; each picture is the density square (40 Compact, else 48),
//     left, 16 inside the bled row (x) and the density inset (10 / 12 / 16)
//     from its top (y), 12 to the text (flat look 7 Nov, density 8 Nov 2026);
//   7 post screens (after the shot, so the baseline never moves): the pinned
//     exit bar keeps its top after the page scrolls (assertPinnedBarOnScroll),
//     the checkpoint progress row sits directly under the bar in the same
//     pinned block (assertProgressRowUnderBar), and the comment composer's "+"
//     tray opens with exactly Photos, File and Assets (assertCommentTray);
//   8 the top bar (decision A, every screen that shows its slots): search |
//     sort | "+" | avatar, left to right, the sort and "+" slots fixed 44x44,
//     the sort right before the "+" and the "+" last before the avatar; across
//     the six list screens the two slots hold one x (assertTopbarSlotsStill);
//   9 chip rows with a pinned Select (decision E): the Select ends on the
//     row's content edge, the chips scroll in a box that ends before it, its
//     tap box is 44 tall and it sits on the chips' line; every ui/Chip face is
//     the density height visible (32 Compact, 36 Cozy, 40 Calm) in a 44 tap
//     box (the chip rule above);
//  10 upload screens (decision F, assertNoUploadBar): no visible progress bar
//     and no % figure, only ui/UploadRing (its progressbar is sr-only) or Retry;
//  11 writing box screens (ui/WritingBox, assertWritingBox): every row key and
//     the send are 44 tall hits and the send ends inside the box; an open +
//     tray is the top of its box (inside the frame, in flow, no fill, edge or
//     shadow of its own, one outline around both); a comment / reply box takes
//     its full column width and no clipping ancestor cuts its sides;
//  12 post screens (assertCommentBars, 8 Nov 2026): every comment's action bar
//     is 44 hits, rides half above its row (its middle on the row's top edge),
//     ends on the row's end and covers no time, name or title.
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
  scroller: number | null;
  liftedOver: number[];
  clip: Box;
}

interface RawPart {
  label: string;
  styles: Array<{ fontSize: string; fontWeight: string; fontFamily: string; text: string }>;
}

interface RawPage {
  viewportWidth: number;
  /** <html data-density> as the page has it (undefined: Cozy). */
  density: string | undefined;
  lines: RawLine[];
  targets: RawTarget[];
  edges: EdgeItem[];
  parts: RawPart[];
  listCards: ListCardGeom[];
  chips: ChipGeom[];
  topbar: TopbarGeom;
  chipRows: ChipRowGeom[];
}

/** Reads every box the checks need in one pass over the page. */
async function readPage(page: Page): Promise<RawPage> {
  // isLiftedLayer and movedSideways are pure (layout-checks-core.ts, unit
  // tested); their source goes into the page so the browser side applies the
  // same rules.
  const rules = { lifted: isLiftedLayer.toString(), sideways: movedSideways.toString() };
  return page.evaluate((sources: { lifted: string; sideways: string }): RawPage => {
    const lifted = new Function(`return (${sources.lifted});`)() as (style: {
      position: string;
      zIndex: string;
    }) => boolean;
    const sideways = new Function(`return (${sources.sideways});`)() as (
      transform: string,
    ) => boolean;
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

    /** Scroll containers (overflow auto or scroll), each with an id. */
    const scrollsContent = (el: Element): boolean => {
      const s = getComputedStyle(el);
      return /^(auto|scroll)$/.test(s.overflowY) || /^(auto|scroll)$/.test(s.overflowX);
    };
    const scrollerEls = Array.from(document.querySelectorAll('*')).filter(
      (el) => el !== document.documentElement && el !== document.body && scrollsContent(el),
    );
    /** The innermost scroll container holding el, by index into scrollerEls; null = none. */
    const scrollerOf = (el: Element): number | null => {
      for (let at = el.parentElement; at !== null; at = at.parentElement) {
        const i = scrollerEls.indexOf(at);
        if (i !== -1) return i;
      }
      return null;
    };
    /**
     * The scrollers el floats over: its nearest lifted layer (positioned,
     * own z-index; never a fixed/sticky one, those are layers already) and
     * every scroller that layer neither holds nor sits in.
     */
    const liftedOverOf = (el: Element): number[] => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        const s = getComputedStyle(at);
        if (s.position === 'fixed' || s.position === 'sticky') return [];
        if (!lifted({ position: s.position, zIndex: s.zIndex })) continue;
        const layer = at;
        return scrollerEls.flatMap((sc, i) =>
          !layer.contains(sc) && !sc.contains(layer) ? [i] : [],
        );
      }
      return [];
    };

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
      scroller: scrollerOf(el),
      liftedOver: liftedOverOf(el),
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
    /** Inside something moved sideways by a transform (a row mid-swipe): moving content. */
    const slides = (el: Element): boolean => {
      for (let at: Element | null = el; at !== null; at = at.parentElement) {
        if (sideways(getComputedStyle(at).transform)) return true;
      }
      return false;
    };
    const bleeds = (el: Element): boolean =>
      el.closest('img, video, canvas, picture, [data-full-bleed]') !== null ||
      scrollsUnderEdge(el) ||
      slides(el);
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

    const boxOf = (el: Element | null): Box | null =>
      el !== null && shown(el) ? toBox(el.getBoundingClientRect()) : null;

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
        time: boxOf(card.querySelector('[data-list-card-time]')),
        tag: boxOf(card.querySelector('[data-list-card-tag]')),
        hasPreview: card.querySelector('[data-list-card-preview]') !== null,
        unread: card.querySelector('[data-list-card-unread]') !== null,
      });
    }

    // 7 Chips: every shown ui/Chip face and its tap box (the button around it).
    const chips: ChipGeom[] = [];
    for (const face of Array.from(document.querySelectorAll('[data-chip-face]'))) {
      const hit = face.parentElement;
      if (hit === null || !shown(hit)) continue;
      chips.push({
        label: nameOf(hit),
        hit: toBox(hit.getBoundingClientRect()),
        face: toBox(face.getBoundingClientRect()),
      });
    }

    // 8 The top bar: the visible Search, the two slots, the avatar.
    const header =
      Array.from(document.querySelectorAll('header')).find(
        (h) => h.querySelector('[data-topbar-slot]') !== null,
      ) ?? null;
    const firstShown = (els: Element[]): Box | null => {
      const el = els.find((e) => shown(e));
      return el !== undefined ? toBox(el.getBoundingClientRect()) : null;
    };
    const topbar: TopbarGeom =
      header === null
        ? { search: null, sort: null, primary: null, avatar: null }
        : {
            search: firstShown(
              Array.from(header.querySelectorAll('button')).filter(
                (b) =>
                  b.getAttribute('aria-label') === 'Search' ||
                  /^Search\b/.test((b.textContent ?? '').trim()),
              ),
            ),
            sort: boxOf(header.querySelector('[data-topbar-slot="sort"]')),
            primary: boxOf(header.querySelector('[data-topbar-slot="primary"]')),
            avatar: firstShown(
              Array.from(header.querySelectorAll('button[aria-label="Account menu"]')),
            ),
          };

    // 9 Chip rows with the pinned Select.
    const chipRows: ChipRowGeom[] = [];
    for (const row of Array.from(document.querySelectorAll('[data-chip-row]'))) {
      if (!shown(row)) continue;
      chipRows.push({
        label: nameOf(row).slice(0, 60),
        row: toBox(row.getBoundingClientRect()),
        paddingRight: parseFloat(getComputedStyle(row).paddingRight) || 0,
        scroll: boxOf(row.querySelector('[data-chip-scroll]')),
        select: boxOf(row.querySelector('[data-chip-row-select]')),
        button: boxOf(row.querySelector('[data-section-select]')),
      });
    }

    return {
      viewportWidth: vw,
      density: document.documentElement.dataset.density,
      lines,
      targets,
      edges,
      parts,
      listCards,
      chips,
      topbar,
      chipRows,
    };
  }, rules);
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

  // List rows and chips size by the density on <html> (60 / 72 / 80; 32 / 36 / 40).
  const density: LayoutDensity = layoutDensity(raw.density);
  for (const message of listCardViolations(raw.listCards, density)) {
    violations.push({ check: 'list-card', message });
  }

  for (const message of chipViolations(raw.chips, density)) {
    violations.push({ check: 'chip', message });
  }

  for (const message of topbarViolations(raw.topbar)) {
    violations.push({ check: 'topbar', message });
  }

  for (const message of chipRowViolations(raw.chipRows)) {
    violations.push({ check: 'chip-row', message });
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

/**
 * Check 7a: the exit bar of a screen that opens over the app stays pinned
 * while the page scrolls. Puts the page's scroller (the bar's nearest
 * scrolling ancestor: <main> on a laptop, else the document on a phone in page
 * mode) at its top, measures the bar, scrolls 600px, measures again, then puts
 * the scroll back where it was.
 */
export async function assertPinnedBarOnScroll(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate(async () => {
    const pin =
      document.querySelector('[data-header-pin]') ??
      document.querySelector('header[data-header-pinned]');
    if (!(pin instanceof HTMLElement)) {
      return { found: false, topAtRest: 0, topScrolled: 0, scrolledBy: 0 };
    }
    const scrolls = (el: Element): boolean =>
      /^(auto|scroll)$/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight + 1;
    let scroller: Element = document.scrollingElement ?? document.documentElement;
    for (let at = pin.parentElement; at !== null; at = at.parentElement) {
      if (at !== document.body && at !== document.documentElement && scrolls(at)) {
        scroller = at;
        break;
      }
    }
    const frames = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const start = scroller.scrollTop;
    scroller.scrollTop = 0;
    await frames();
    const topAtRest = pin.getBoundingClientRect().top;
    scroller.scrollTop = 600;
    await frames();
    const scrolledBy = scroller.scrollTop;
    const topScrolled = pin.getBoundingClientRect().top;
    scroller.scrollTop = start;
    await frames();
    return { found: true, topAtRest, topScrolled, scrolledBy };
  });
  settleFindings(
    screenName,
    pinnedBarViolations(geom).map((message) => ({ check: 'pinned-bar' as const, message })),
  );
}

/**
 * Check 7b: the post's checkpoint progress row is directly under the exit
 * bar, inside the bar's pinned block ([data-header-pin]).
 */
export async function assertProgressRowUnderBar(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate(() => {
    const toBox = (el: Element | null): Box | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const row = document.querySelector('[data-checkpoint-progress-row]');
    const pin = row?.closest('[data-header-pin]') ?? null;
    const bar =
      pin?.querySelector('[data-header-bar]') ??
      document.querySelector('header[data-header-pinned]') ??
      document.querySelector('[data-header-bar]');
    return { bar: toBox(bar), row: toBox(row), insidePin: pin !== null };
  });
  settleFindings(
    screenName,
    underBarViolations(geom).map((message) => ({ check: 'under-bar' as const, message })),
  );
}

/**
 * Check 7c: the comment composer's "+" opens the tray with exactly Photos,
 * File and Assets (CommentComposer / SlotComposer COMMENT_TRAY_TILES), then
 * closes it again with Escape.
 */
export async function assertCommentTray(page: Page, screenName: string): Promise<void> {
  const plus = page.locator('[data-comments-composer] [data-plus]');
  const trigger = (await plus.count()) > 0 ? plus.first() : page.locator('[data-plus]').first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const tray = page.locator('[data-tray]').first();
  await tray.waitFor({ state: 'visible', timeout: SAME_WIDTH_WAIT_MS });
  const tiles = await tray
    .locator('[data-tray-tile]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-tray-tile') ?? ''));
  await page.keyboard.press('Escape');
  settleFindings(
    screenName,
    trayTileViolations(tiles).map((message) => ({ check: 'tray-tiles' as const, message })),
  );
}

/**
 * Check 12: every comment action bar ([data-comment-bar]) on the screen, as
 * commentBarViolations reads it. Screens with no comments find none and pass.
 */
export async function assertCommentBars(page: Page, screenName: string): Promise<void> {
  const bars: CommentBarGeom[] = await page.evaluate(() => {
    const toBox = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const around = Array.from(
      document.querySelectorAll(
        '[data-comment-time], [data-comment-author], [data-group-meta], [data-comments-header] h3',
      ),
    ).filter(shown);
    return Array.from(document.querySelectorAll('[data-comment-bar]'))
      .filter(shown)
      .map((bar, i) => {
        const row = bar.closest('[data-comment-row]') ?? bar.parentElement ?? bar;
        const id = bar.closest('[id^="comment-"]')?.id ?? `bar ${i + 1}`;
        return {
          label: id,
          bar: toBox(bar),
          row: toBox(row),
          buttons: Array.from(bar.querySelectorAll('button')).filter(shown).map(toBox),
          around: around
            .filter((el) => !bar.contains(el))
            .map((el) => ({
              label: `${el.getAttribute('data-comment-time') !== null ? 'a time' : el.tagName === 'H3' ? 'the title' : 'a name'} (${el.textContent?.trim().slice(0, 24) ?? ''})`,
              box: toBox(el),
            })),
        };
      });
  });
  settleFindings(
    screenName,
    commentBarViolations(bars).map((message) => ({ check: 'comment-bar' as const, message })),
  );
}

/**
 * Check 8b: the top bar's sort and "+" slots, read on the screen as it stands
 * (their left x), for assertTopbarSlotsStill across screens.
 */
export async function readTopbarSlots(page: Page, screen: string): Promise<TopbarSlotsAt> {
  const at = await page.evaluate(() => {
    const x = (name: string): number => {
      const el = document.querySelector(`header [data-topbar-slot="${name}"]`);
      return el === null ? Number.NaN : el.getBoundingClientRect().x;
    };
    return { sortX: x('sort'), primaryX: x('primary') };
  });
  return { screen, ...at };
}

/** Check 8b: the slots hold one x on every screen read (each against the first). */
export function assertTopbarSlotsStill(name: string, rows: readonly TopbarSlotsAt[]): void {
  const missing = rows
    .filter((r) => !Number.isFinite(r.sortX) || !Number.isFinite(r.primaryX))
    .map((r) => ({ check: 'topbar' as const, message: `${r.screen}: no top bar slots` }));
  settleFindings(name, [
    ...missing,
    ...topbarDriftViolations(rows).map((message) => ({ check: 'topbar' as const, message })),
  ]);
}

/**
 * Check 10: an upload screen shows no visible progress bar ([role=progressbar]
 * or <progress> bigger than 1x1: UploadRing's own is sr-only; the guide's tour
 * bar and a plan card's progress are not uploads) and no % figure
 * in an upload's surroundings (the pending chip, tile, photo, row thumb's
 * card, the sending file or voice note, or near a ring).
 */
export async function assertNoUploadBar(page: Page, screenName: string): Promise<void> {
  const found = await page.evaluate((): { bars: UploadBarItem[]; texts: string[] } => {
    const toBox = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const visible = (el: Element): boolean => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const bars: UploadBarItem[] = [];
    for (const el of Array.from(document.querySelectorAll('[role="progressbar"], progress'))) {
      if (!visible(el)) continue;
      // Not uploads: the onboarding guide's tour progress and a plan card's OK progress.
      if (el.closest('[data-induction-bar], [data-plan-card]') !== null) continue;
      const hook = Array.from(el.attributes).find((a) => a.name.startsWith('data-'));
      bars.push({
        label: `${el.tagName.toLowerCase()}${hook !== undefined ? `[${hook.name}]` : ''}`,
        box: toBox(el.getBoundingClientRect()),
      });
    }
    const scopes = new Set<Element>(
      Array.from(
        document.querySelectorAll(
          '[data-pending-chip], [data-pending-tile], [data-pending-photo], [data-upload-thumb], [data-file-state="sending"], [data-testid="voice-uploading"]',
        ),
      ),
    );
    for (const ring of Array.from(document.querySelectorAll('[data-upload-ring]'))) {
      const near = ring.parentElement?.parentElement ?? ring.parentElement;
      if (near !== null && near !== undefined) scopes.add(near);
    }
    const texts: string[] = [];
    for (const scope of scopes) {
      const text = (scope.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') texts.push(text.slice(0, 80));
    }
    return { bars, texts };
  });
  settleFindings(
    screenName,
    uploadBarViolations(found.bars, found.texts).map((message) => ({
      check: 'upload-bar' as const,
      message,
    })),
  );
}

/**
 * The thread screen's header: every thread carries a one line title (its
 * root card's title, else "Thread") and the chat's name under it, both
 * inside the bar.
 */
export async function assertThreadHeader(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate((): ThreadHeaderGeom => {
    const toBox = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const read = (sel: string) => {
      const el = document.querySelector(`[data-thread-view] ${sel}`);
      if (el === null) return null;
      // A truncating line keeps one client rect; a wrap adds one per line.
      return {
        text: el.textContent ?? '',
        lines: el.getClientRects().length,
        box: toBox(el.getBoundingClientRect()),
      };
    };
    const bar = document.querySelector('[data-thread-view] [data-header-bar]');
    return {
      title: read('[data-thread-view-title]'),
      subtitle: read('[data-thread-view-subtitle]'),
      bar: bar !== null ? toBox(bar.getBoundingClientRect()) : null,
    };
  });
  settleFindings(
    screenName,
    threadHeaderViolations(geom).map((message) => ({ check: 'thread-header' as const, message })),
  );
}

/**
 * Check 11: the writing box screens (ui/WritingBox: chat, comment, field,
 * caption). Each shown box's row keys ([data-composer-key]) and send
 * ([data-row-send]) are 44 tall hits and the send ends inside the frame
 * ([data-writing-frame]).
 */
export async function assertWritingBox(page: Page, screenName: string): Promise<void> {
  const boxes = await page.evaluate((): WritingBoxGeom[] => {
    const toBox = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const boxes: WritingBoxGeom[] = [];
    for (const root of Array.from(document.querySelectorAll('[data-writing-box]'))) {
      const frame = root.querySelector('[data-writing-frame]');
      if (frame === null || !shown(frame)) continue;
      const label = `[data-writing-box][data-mode="${root.getAttribute('data-mode') ?? ''}"]`;
      const keys = Array.from(
        frame.querySelectorAll('[data-writing-row] [data-composer-key], [data-row-send]'),
      )
        .filter(shown)
        .map((el) => ({
          label: `[aria-label="${el.getAttribute('aria-label') ?? ''}"]`,
          box: toBox(el.getBoundingClientRect()),
        }));
      const send = frame.querySelector('[data-row-send]');
      boxes.push({
        label,
        frame: toBox(frame.getBoundingClientRect()),
        keys,
        send: send !== null && shown(send) ? toBox(send.getBoundingClientRect()) : null,
      });
    }
    return boxes;
  });
  const violations: LayoutViolation[] = writingBoxViolations(boxes).map((message) => ({
    check: 'writing-box' as const,
    message,
  }));
  if (boxes.length === 0) {
    violations.push({
      check: 'writing-box',
      message: 'no [data-writing-box] on a writing box screen',
    });
  }
  violations.push(...(await writingTrayViolations(page)), ...(await replyBoxWidthViolations(page)));
  settleFindings(screenName, violations);
}

/**
 * Check 11c: the catch-up reply at rest (CatchUpReply, ui/WritingBox
 * restPill). The pill ([data-catch-up-reply] [data-writing-frame]) holds its
 * field's placeholder on its vertical centre (the one-row textarea's centre
 * within 1px of the pill's), and its left edge sits on the card's photo
 * column (within 1px of the first [data-catch-up-message] photo's left edge).
 * Call on a catch-up screen with the reply at rest (not focused).
 */
export async function checkCatchUpComposer(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate(() => {
    const frame = document.querySelector('[data-catch-up-reply] [data-writing-frame]');
    const field = document.querySelector('[data-catch-up-reply] [data-catch-up-reply-input]');
    const photo =
      document.querySelector('[data-catch-up-message] [data-avatar-kind]') ??
      document.querySelector('[data-catch-up-message] img');
    const rect = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return { frame: rect(frame), field: rect(field), photo: rect(photo) };
  });
  const violations: LayoutViolation[] = [];
  const add = (message: string): void => {
    violations.push({ check: 'writing-box', message });
  };
  if (geom.frame === null || geom.field === null) {
    add('no catch-up reply pill ([data-catch-up-reply] [data-writing-frame]) or its field');
  } else {
    const pillMid = geom.frame.y + geom.frame.height / 2;
    const fieldMid = geom.field.y + geom.field.height / 2;
    if (Math.abs(pillMid - fieldMid) > 1) {
      add(
        `catch-up reply placeholder off centre: field centre ${fieldMid.toFixed(1)} vs pill centre ${pillMid.toFixed(1)}`,
      );
    }
    if (geom.photo === null) {
      add('no [data-catch-up-message] photo to line the catch-up reply up with');
    } else if (Math.abs(geom.frame.x - geom.photo.x) > 1) {
      add(
        `catch-up reply pill left ${geom.frame.x.toFixed(1)} is not on the photo column ${geom.photo.x.toFixed(1)}`,
      );
    }
  }
  settleFindings(screenName, violations);
}

/**
 * Check 11a: an open + tray is the top of its writing box (8 Nov 2026). The
 * tray ([data-tray]) sits inside the box's frame ([data-writing-frame]), at
 * its top and within its sides, in flow; it draws no fill, edge (bar its
 * bottom hairline) or shadow of its own, so the frame's one ink outline goes
 * around tray and text; and the frame's outline shows while the tray is open.
 */
export async function writingTrayViolations(page: Page): Promise<LayoutViolation[]> {
  const messages = await page.evaluate((): string[] => {
    const out: string[] = [];
    for (const tray of Array.from(document.querySelectorAll('[data-tray]'))) {
      const r = tray.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const box = tray.closest('[data-writing-box]');
      if (box === null) continue;
      const label = `[data-writing-box][data-mode="${box.getAttribute('data-mode') ?? ''}"]`;
      const frame = box.querySelector('[data-writing-frame]');
      if (frame === null || !frame.contains(tray)) {
        out.push(`${label}: the + tray is outside the box's frame (one outline around both)`);
        continue;
      }
      const f = frame.getBoundingClientRect();
      if (r.left < f.left - 1 || r.right > f.right + 1 || r.top < f.top - 1) {
        out.push(`${label}: the + tray spills out of the box's frame`);
      }
      const ts = getComputedStyle(tray);
      if (ts.position === 'absolute' || ts.position === 'fixed') {
        out.push(`${label}: the + tray floats (${ts.position}); it must sit in flow`);
      }
      if (ts.boxShadow !== 'none') out.push(`${label}: the + tray draws a shadow`);
      if (ts.backgroundColor !== 'rgba(0, 0, 0, 0)' && ts.backgroundColor !== 'transparent') {
        out.push(`${label}: the + tray paints its own fill (the box's fill shows through)`);
      }
      for (const side of ['Top', 'Left', 'Right'] as const) {
        if (parseFloat(ts.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0) {
          out.push(`${label}: the + tray draws its own ${side.toLowerCase()} edge`);
        }
      }
      const fs = getComputedStyle(frame);
      if (fs.outlineStyle === 'none' || parseFloat(fs.outlineWidth) <= 0) {
        out.push(`${label}: no ink outline around the open tray and the box`);
      }
    }
    return out;
  });
  return messages.map((message) => ({ check: 'writing-box' as const, message }));
}

/**
 * Check 11b: a comment / reply writing box takes its full content width and is
 * never clipped. Its frame spans its column (the box's parent content box,
 * within 1px), sits inside the viewport, and no ancestor that clips overflow
 * cuts its left or right edge (the inset focus line included).
 */
export async function replyBoxWidthViolations(page: Page): Promise<LayoutViolation[]> {
  const messages = await page.evaluate((): string[] => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const box of Array.from(document.querySelectorAll('[data-writing-box]'))) {
      const mode = box.getAttribute('data-mode') ?? '';
      if (mode !== 'comment' || box.getAttribute('data-expanded') === 'phone') continue;
      const frame = box.querySelector('[data-writing-frame]');
      if (frame === null) continue;
      const f = frame.getBoundingClientRect();
      if (f.width <= 1 || f.height <= 1) continue;
      const label = `[data-writing-box][data-mode="comment"]`;
      if (f.left < -0.5 || f.right > vw + 0.5) {
        const span = `${Math.round(f.left)}..${Math.round(f.right)} of ${vw}`;
        out.push(`${label}: the reply box runs off screen (${span})`);
      }
      // Its column: the nearest ancestor that is not a display: contents slot.
      let col = box.parentElement;
      while (col !== null && getComputedStyle(col).display === 'contents') col = col.parentElement;
      if (col !== null) {
        const cs = getComputedStyle(col);
        const c = col.getBoundingClientRect();
        const inner =
          c.width -
          parseFloat(cs.paddingLeft) -
          parseFloat(cs.paddingRight) -
          parseFloat(cs.borderLeftWidth) -
          parseFloat(cs.borderRightWidth);
        if (cs.display !== 'flex' || cs.flexDirection.startsWith('column')) {
          if (f.width < inner - 1) {
            const widths = `${Math.round(f.width)} < ${Math.round(inner)}`;
            out.push(`${label}: the reply box is narrower than its column (${widths})`);
          }
        }
      }
      for (let at = box.parentElement; at !== null; at = at.parentElement) {
        const s = getComputedStyle(at);
        if (s.overflowX === 'visible' && s.overflow === 'visible') continue;
        const a = at.getBoundingClientRect();
        if (f.left < a.left - 0.5 || f.right > a.right + 0.5) {
          out.push(`${label}: an ancestor that clips cuts the reply box's side`);
          break;
        }
      }
    }
    return out;
  });
  return messages.map((message) => ({ check: 'writing-box' as const, message }));
}
