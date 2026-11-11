import { expect, test, type Locator, type Page } from '@playwright/test';
import { NEW_CHIP_HEIGHT, PAIR_BOX_HEIGHT, PAIR_PILL_HEIGHT } from '../../src/components/ui/layout';
import {
  alignmentViolations,
  listScreenAxisExpected,
  listScreenAxisReport,
  listScreenAxisViolations,
  type ListScreenAxis,
  boxText,
  clipBox,
  distinctRoles,
  edgeViolations,
  formatViolations,
  isLiftedLayer,
  layoutMode,
  movedSideways,
  lineHeightPx,
  chipViolations,
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
  uploadBarViolations,
  wrapsPastOneLine,
  writingBoxViolations,
  threadHeaderViolations,
  type ThreadHeaderGeom,
  commentThreadEndViolations,
  type CommentThreadEndGeom,
  threadFillViolations,
  type ThreadFillGeom,
  type AlignFamily,
  type Box,
  type ChipGeom,
  type EdgeItem,
  type LayoutViolation,
  type ListCardGeom,
  type TapTarget,
  type TopbarGeom,
  type TopbarSlotsAt,
  type TabFrameAt,
  tabFrameViolations,
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
//     is the same height (within 1px) and ROW_HEIGHT (72) on every screen, so
//     all seven lists match; each picture is the 48 square (ROW_PICTURE), left,
//     16 inside the bled row (x) and ROW_INSET (12) from its top (y), 12 to the
//     text (flat look 7 Nov; one size 10 Nov 2026);
//   7 post screens (after the shot, so the baseline never moves): the pinned
//     exit bar keeps its top after the page scrolls (assertPinnedBarOnScroll)
//     and the comment composer's "+" tray opens with exactly Photos, File and
//     Assets (assertCommentTray); the checkpoint progress row is gone (11 Nov
//     2026, comments as a chat);
//   8 the top bar (decision A, every screen that shows its slots): search |
//     sort | "+" | avatar, left to right, the sort and "+" slots fixed 44x44,
//     the sort right before the "+" and the "+" last before the avatar; across
//     the six list screens the two slots hold one x (assertTopbarSlotsStill);
//   9 chip rows with a pinned Select (decision E): the Select ends on the
//     row's content edge, the chips scroll in a box that ends before it, its
//     tap box is 44 tall and it sits on the chips' line; every ui/Chip face is
//     CHIP_FACE (36) visible in a 44 tap box (the chip rule above);
//  10 upload screens (decision F, assertNoUploadBar): no visible progress bar
//     and no % figure, only ui/UploadRing (its progressbar is sr-only) or Retry;
//  11 writing box screens (ui/WritingBox, assertWritingBox): every row key and
//     the send are 44 tall hits and the send ends inside the box; an open +
//     tray is the top of its box (inside the frame, in flow, no fill, edge or
//     shadow of its own, one outline around both); a comment / reply box takes
//     its full column width and no clipping ancestor cuts its sides;
//  12 retired (11 Nov 2026): comments have no action bar; the post screen's
//     alignment (one text column, one right edge, text off the comments
//     hairline) is check 14's 'post-screen' scope;
//  13 catch-up screens (assertCatchUpLayout, 9 Nov 2026): every control a 44
//     hit (the bar's keys 48), each checkpoint circle on its text's first
//     line and the point text on the message text column, no card row over a
//     sibling, the card on a surface of its own over the page tone.
// LAYOUT_CHECKS=strict (the default) fails the screen (soft: every check
// and the screenshot still run, so one run reports every failure); LAYOUT_CHECKS=report
// records every finding as a test annotation and in the log, and passes.
// The geometry is pure and unit tested: layout-checks-core.ts.

const MODE = layoutMode(process.env.LAYOUT_CHECKS);

/**
 * Strict: fail with every finding, as a soft failure, so the screen's other
 * checks and its screenshot still run and one run reports every failure.
 * Report: annotate and log, then go on.
 */
function settleFindings(screen: string, violations: readonly LayoutViolation[]): void {
  if (violations.length === 0) return;
  const text = formatViolations(screen, violations);
  if (MODE === 'strict') {
    expect.soft(violations, `layout checks failed (LAYOUT_CHECKS=strict):\n${text}`).toEqual([]);
    return;
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
  lines: RawLine[];
  targets: RawTarget[];
  edges: EdgeItem[];
  parts: RawPart[];
  listCards: ListCardGeom[];
  chips: ChipGeom[];
  topbar: TopbarGeom;
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
        lines2: card.getAttribute('data-list-card-lines') === '2',
        unfolded: card.querySelector('[data-activity-preview-toggle="less"]') !== null,
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
            viewportWidth: vw,
            cockpit: boxOf(header.querySelector('[data-cockpit-dot]')),
            // The avatar's visible photo: the first child box inside the button.
            avatarFace: firstShown(
              Array.from(
                header.querySelectorAll('button[aria-label="Account menu"] > *:first-child'),
              ),
            ),
            plus: (() => {
              const face = Array.from(
                header.querySelectorAll('[data-topbar-slot="primary"] [data-topbar-plus-face]'),
              ).find((el) => shown(el));
              if (face === undefined) return null;
              const style = getComputedStyle(face);
              // The page's accent fill, read off a throwaway bg-accent box.
              const probe = document.createElement('span');
              probe.className = 'bg-accent';
              document.body.appendChild(probe);
              const accent = getComputedStyle(probe).backgroundColor;
              probe.className = 'bg-fg-3';
              const blockedFill = getComputedStyle(probe).backgroundColor;
              probe.remove();
              const blocked = face.closest('[data-topbar-plus-blocked]') !== null;
              return {
                face: face.getAttribute('data-topbar-plus-face') === 'phone' ? 'phone' : 'laptop',
                box: toBox(face.getBoundingClientRect()),
                borderWidth: parseFloat(style.borderTopWidth) || 0,
                radius: parseFloat(style.borderTopLeftRadius) || 0,
                background: style.backgroundColor,
                accent,
                blocked: blocked ? { fill: blockedFill } : null,
                glyph: boxOf(face.querySelector('svg')),
              } as const;
            })(),
          };

    return {
      viewportWidth: vw,
      lines,
      targets,
      edges,
      parts,
      listCards,
      chips,
      topbar,
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

  // List rows (ROW_HEIGHT 72) and chips (CHIP_FACE 36): one size.
  for (const message of listCardViolations(raw.listCards)) {
    violations.push({ check: 'list-card', message });
  }

  for (const message of chipViolations(raw.chips)) {
    violations.push({ check: 'chip', message });
  }

  for (const message of topbarViolations(raw.topbar)) {
    violations.push({ check: 'topbar', message });
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
 * Check 7c: the comment composer's "+" (chat's Composer in
 * [data-comments-composer]) opens the tray with exactly Photos, File and
 * Assets, then closes it again with Escape.
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
 * Thread polish 1: the open comment thread (phone and laptop) landed at its
 * end before anything scrolled it, the last row 12 above the reply box.
 */
export async function assertCommentThreadEnd(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate((): CommentThreadEndGeom => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-thread-view] [data-comment-thread]',
    );
    const last = scroller?.querySelector('ul')?.lastElementChild ?? null;
    const box = document.querySelector('[data-comment-thread-composer]');
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
      lastRowBottom: last !== null ? last.getBoundingClientRect().bottom : null,
      replyBoxTop: box !== null ? box.getBoundingClientRect().top : null,
    };
  });
  settleFindings(
    screenName,
    commentThreadEndViolations(geom).map((message) => ({ check: 'thread-end' as const, message })),
  );
}

/** The post column's right edge on the post page (its head block), or null. */
export async function readPostColumnRight(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const side = document.querySelector('[data-post-side]');
    const head = side?.parentElement?.firstElementChild ?? null;
    return head !== null ? head.getBoundingClientRect().right : null;
  });
}

/**
 * Thread polish 1, laptop: the comment thread panel fills beside the post
 * (post right + 24 to the window edge, min 380).
 */
export async function assertThreadFillsBeside(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate((): ThreadFillGeom | null => {
    const panel = document.querySelector('[data-side-panel]');
    const side = document.querySelector('[data-post-side]');
    const head = side?.parentElement?.firstElementChild ?? null;
    if (panel === null || head === null) return null;
    const p = panel.getBoundingClientRect();
    return {
      windowWidth: document.documentElement.clientWidth,
      postRight: head.getBoundingClientRect().right,
      panelLeft: p.left,
      panelRight: p.right,
    };
  });
  settleFindings(
    screenName,
    (geom === null ? ['no thread panel beside the post'] : threadFillViolations(geom)).map(
      (message) => ({ check: 'thread-fill' as const, message }),
    ),
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

/** The catch-up bar's round keys ("<" and Undo): 48 x 48. */
const CATCH_UP_BAR_KEY_PX = 48;
/** Every other catch-up control's hit box. */
const CATCH_UP_HIT_PX = 44;
/** The writing box row keys' hit width (36 circle on a 44 tall hit, CLAUDE.md "Composer rows"). */
const CATCH_UP_ROW_KEY_WIDTH_PX = 36;

/**
 * Check 13: a catch-up screen ([data-catch-up], 9 Nov 2026). Throws (strict)
 * with every finding:
 *   a every visible control (button, a, [role=button]) inside [data-catch-up]
 *     has a hit box of at least 44 x 44 (its box, grown by an absolute
 *     ::before / ::after hit layer); the bar's keys ([data-catch-up-bar])
 *     48 x 48; the writing box's row keys ([data-composer-key],
 *     [data-row-send], keys in [data-writing-row]) 36 wide x 44 tall. Inline
 *     text runs (a link inside a sentence: display inline) and the message
 *     text that opens its thread ([data-catch-up-open-thread], the text block
 *     itself) are text targets, not controls, and are left out (WCAG 2.5.8's
 *     inline exception);
 *   b each feedback point's checkpoint circle ([data-catch-up-point-circle],
 *     the 44 box) is centred within 1px of its text's first line centre (text
 *     top + its padding-top 12 + half its 20 line, i.e. 22px down), and the
 *     point text ([data-catch-up-point-text]) starts within 1px of the
 *     message text column (a [data-catch-up-message] / [data-catch-up-points]
 *     row's text column, after the 32 photo column and the 12 gap);
 *   c no row of a card's list ([data-catch-up-rows], the thread's
 *     [data-catch-up-thread-replies]) and no part of a card (its in-flow
 *     children: name row, strip, body, reply) overlaps a sibling by more
 *     than 1px;
 *   d the card ([data-catch-up-card]) paints a background of its own that
 *     differs from the page tone it sits on ([data-catch-up-box]).
 * The end screen (no card) runs (a) only.
 */
export async function assertCatchUpLayout(page: Page, screenName: string): Promise<void> {
  const messages = await page.evaluate(
    (px: { bar: number; hit: number; rowKey: number }): string[] => {
      const out: string[] = [];
      const root = document.querySelector('[data-catch-up]');
      if (root === null) return ['no [data-catch-up] on a catch-up screen'];
      const shown = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.pointerEvents === 'none') {
          return false;
        }
        return el.closest('[aria-hidden="true"], [inert]') === null;
      };
      const label = (el: Element): string => {
        const hook = Array.from(el.attributes).find(
          (a) => a.name.startsWith('data-') && a.name !== 'data-state',
        );
        const aria = el.getAttribute('aria-label');
        const text = (el.textContent ?? '').trim().slice(0, 24);
        return `${el.tagName.toLowerCase()}${hook !== undefined ? `[${hook.name}]` : ''}${
          aria !== null ? `[aria-label="${aria}"]` : text !== '' ? ` "${text}"` : ''
        }`;
      };
      const px2 = (value: string): number | null =>
        value.endsWith('px') ? parseFloat(value) : null;
      // The control's hit box: its own box, grown by an absolute pseudo hit layer.
      const hitBox = (el: Element): { width: number; height: number } => {
        const r = el.getBoundingClientRect();
        let left = r.left;
        let right = r.right;
        let top = r.top;
        let bottom = r.bottom;
        for (const pseudo of ['::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          if (s.content === 'none' || s.content === 'normal' || s.position !== 'absolute') continue;
          const l = px2(s.left);
          const rt = px2(s.right);
          const t = px2(s.top);
          const b = px2(s.bottom);
          if (l !== null) left = Math.min(left, r.left + l);
          if (rt !== null) right = Math.max(right, r.right - rt);
          if (t !== null) top = Math.min(top, r.top + t);
          if (b !== null) bottom = Math.max(bottom, r.bottom - b);
        }
        return { width: right - left, height: bottom - top };
      };

      // (a) hit boxes.
      for (const el of Array.from(root.querySelectorAll('button, a[href], [role="button"]'))) {
        if (!shown(el)) continue;
        if (getComputedStyle(el).display === 'inline') continue;
        if (el.closest('[data-catch-up-open-thread]') === el) continue;
        const { width, height } = hitBox(el);
        const inBar = el.closest('[data-catch-up-bar]') !== null;
        const rowKey =
          // The compact + (ComposerTray, data-plus) is a row key too (CLAUDE.md "Composer rows").
          el.matches('[data-composer-key], [data-row-send], [data-plus]') ||
          el.closest('[data-writing-row]') !== null;
        const minW = inBar ? px.bar : rowKey ? px.rowKey : px.hit;
        const minH = inBar ? px.bar : px.hit;
        if (width < minW - 0.5 || height < minH - 0.5) {
          out.push(
            `${label(el)} hit box ${Math.round(width)}x${Math.round(height)} under ${minW}x${minH}`,
          );
        }
      }

      // (b) feedback points: the circle on the first text line, the text on the message column.
      const column = (() => {
        const row = root.querySelector('[data-catch-up-message], [data-catch-up-points]');
        const text = row?.children[1] ?? null;
        return text !== null && shown(text) ? text.getBoundingClientRect().left : null;
      })();
      for (const point of Array.from(root.querySelectorAll('[data-catch-up-point]'))) {
        if (!shown(point)) continue;
        const id = point.getAttribute('data-catch-up-point') ?? '';
        const circle = point.querySelector('[data-catch-up-point-circle]');
        const text = point.querySelector('[data-catch-up-point-text]');
        if (circle === null || text === null) {
          out.push(`point ${id}: no circle or text`);
          continue;
        }
        const c = circle.getBoundingClientRect();
        const t = text.getBoundingClientRect();
        const ts = getComputedStyle(text);
        const lineHeight = px2(ts.lineHeight) ?? 20;
        const firstLine = t.top + (px2(ts.paddingTop) ?? 0) + lineHeight / 2;
        const centre = c.top + c.height / 2;
        if (Math.abs(centre - firstLine) > 1) {
          const at = `${centre.toFixed(1)} vs ${firstLine.toFixed(1)}`;
          out.push(`point ${id}: the circle is not centred on the first text line (${at})`);
        }
        if (column !== null && Math.abs(t.left - column) > 1) {
          const at = `${t.left.toFixed(1)} vs ${column.toFixed(1)}`;
          out.push(`point ${id}: the text is not on the message text column (${at})`);
        }
      }

      // (c) siblings never overlap.
      const inFlow = (el: Element): boolean => {
        const p = getComputedStyle(el).position;
        return p !== 'absolute' && p !== 'fixed';
      };
      const groups: Array<{ name: string; parent: Element }> = [];
      // A held swipe leans the card (rotate): its boxes overlap by design, so
      // the overlap check runs only on a card at rest (no swipe tint).
      const leaning = root.querySelector('[data-catch-up-tint]') !== null;
      for (const card of Array.from(root.querySelectorAll('[data-catch-up-card]'))) {
        if (leaning) break;
        const key = card.getAttribute('data-catch-up-card') ?? '';
        groups.push({ name: `card ${key}`, parent: card });
      }
      for (const list of Array.from(
        leaning
          ? []
          : root.querySelectorAll('[data-catch-up-rows], [data-catch-up-thread-replies]'),
      )) {
        groups.push({ name: 'rows', parent: list });
      }
      for (const group of groups) {
        if (!shown(group.parent)) continue;
        const kids = Array.from(group.parent.children).filter((el) => shown(el) && inFlow(el));
        for (let i = 0; i < kids.length; i += 1) {
          for (let j = i + 1; j < kids.length; j += 1) {
            const a = kids[i];
            const b = kids[j];
            if (a === undefined || b === undefined) continue;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (w > 1 && h > 1) {
              out.push(`${group.name}: ${label(a)} overlaps ${label(b)} by ${Math.round(h)}px`);
            }
          }
        }
      }

      // (d) the card's own surface on the page tone.
      const box = root.querySelector('[data-catch-up-box]');
      const card = root.querySelector('[data-catch-up-card]');
      if (box !== null && card !== null && shown(card)) {
        const cardBg = getComputedStyle(card).backgroundColor;
        const boxBg = getComputedStyle(box).backgroundColor;
        const clear = cardBg === 'transparent' || cardBg === 'rgba(0, 0, 0, 0)';
        if (clear || cardBg === boxBg) {
          out.push(`the card's background (${cardBg}) does not differ from the page's (${boxBg})`);
        }
      }
      return out;
    },
    { bar: CATCH_UP_BAR_KEY_PX, hit: CATCH_UP_HIT_PX, rowKey: CATCH_UP_ROW_KEY_WIDTH_PX },
  );
  settleFindings(
    screenName,
    messages.map((message) => ({ check: 'catch-up' as const, message })),
  );
}

/** Which family the alignment check measures on a screen. */
export type AlignScope =
  | 'chat-thread'
  | 'catch-up-thread'
  | 'chat-replies-row'
  | 'threads-list'
  | 'post-screen'
  | 'brief-screen';

/**
 * Check 14 (9 Nov 2026, CLAUDE.md "Alignment"): measures rules 1, 2, 3 and 5
 * on the screen as shot and fails on a breach (a screenshot alone is not
 * proof).
 * - chat-thread / catch-up-thread (9 Nov 2026, EXACT +-1): the root's 40
 *   photo and its text at x16 (the written rule 1 exception: root text and
 *   strip label on the 16 gutter), its last line 12 over the strip's top
 *   hairline, the replies strip's label at x16 with no icon, the last key's
 *   glyph 16 in from the strip's right (374 on a phone), the first reply's
 *   name 8 under the strip, every reply's name and text at x60, 16 from a
 *   reply's last line to the next reply's name.
 * - threads-list (10 Nov 2026, Activity's Threads list, EXACT +-1): in every
 *   block the header's two lines, every message's name and text, "N more
 *   replies" and the first action's left edge (Mark as read on an unread
 *   block, 8 before Reply; else Reply) at x60 from the block; the
 *   header and every message end on one right edge (16 in); 12+ from the
 *   band hairline above the header and below Reply to the next band.
 * - chat-replies-row: every replies row in the main chat: no reply text node,
 *   the last reply's time shown, 8 between photos, count, time and dot, the
 *   row's target at least 44 tall.
 * - post-screen (11 Nov 2026, comments as a chat, EXACT +-1): one text column:
 *   every comment row's name and text ([data-comments-list] > li: chat's
 *   [data-sender-line] and [data-msg-body]) and the caption header's
 *   workspace name start on one x (absolute when the caption and the comments
 *   share a column, as on a phone; each from its own column's left when the
 *   laptop puts the comments in their own column); one right edge: the
 *   caption's Edit (its painted end) and the tip's "Got it" text end on the
 *   caption block's right edge, the version key's text ([data-gallery-versions])
 *   on the gallery tools row's right edge; text off the hairline: the last
 *   text above the comments section's top hairline (#post-comments border-t,
 *   in its column, fixed and sticky layers aside) and the first text under it
 *   are each 12+ from it. A screen with no comment row fails.
 * - brief-screen (11 Nov 2026): one text column: every comment row's name and
 *   text on one x; the section's "Comments" label starts on the rows' photo
 *   edge (the photos hang left of the text column). A screen with no comment
 *   row fails.
 */
export async function assertAlignment(
  page: Page,
  screenName: string,
  scope: AlignScope,
): Promise<void> {
  const families: AlignFamily[] = await page.evaluate(
    ({ which }): AlignFamily[] => {
      const shown = (el: Element | null): el is Element => {
        if (el === null) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        return getComputedStyle(el).visibility !== 'hidden';
      };
      /** The painted text's box inside el (its text nodes' rects), or null. */
      const textBox = (
        el: Element,
      ): { left: number; right: number; top: number; bottom: number } | null => {
        let left = Infinity;
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          if ((n.textContent ?? '').trim() === '') continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width === 0 || rect.height === 0) continue;
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
            top = Math.min(top, rect.top);
            bottom = Math.max(bottom, rect.bottom);
          }
        }
        return Number.isFinite(left) ? { left, right, top, bottom } : null;
      };
      const out: AlignFamily[] = [];
      if (which === 'post-screen' || which === 'brief-screen') {
        const post = which === 'post-screen';
        const missing = (label: string): AlignFamily[] => [
          { label: which, textLefts: [], rightEdges: [], gaps: [{ label, gap: -1, min: 0 }] },
        ];
        const section = post
          ? document.querySelector('#post-comments')
          : (document.querySelector('[data-comments][data-entity="brief"]')?.closest('section') ??
            null);
        if (!shown(section)) return missing('no comments section shown');
        const sec = section.getBoundingClientRect();
        const rows = Array.from(
          section.querySelectorAll('[data-comments-list] > li[data-msg-id]'),
        ).filter(shown);
        if (rows.length === 0) return missing('no comment row shown');
        // Rule 1: the caption header's name shares the rows' column (phone),
        // or sits at the same offset in its own column (laptop's side column).
        const caption = post ? document.querySelector('[data-caption-block]') : null;
        const shared =
          caption === null || Math.abs(caption.getBoundingClientRect().left - sec.left) <= 1;
        const fromSection = (x: number): number => (shared ? x : x - sec.left);
        const column: AlignFamily = {
          label: `${which} text column${shared ? '' : ' (from each column left)'}`,
          textLefts: [],
          rightEdges: [],
          gaps: [],
        };
        rows.forEach((row, i) => {
          const name = row.querySelector('[data-sender-line]');
          const n = shown(name) ? textBox(name) : null;
          if (n !== null)
            column.textLefts.push({ label: `comment ${i + 1} name`, x: fromSection(n.left) });
          const body = row.querySelector('[data-msg-body]');
          const t = shown(body) ? textBox(body) : null;
          if (t !== null)
            column.textLefts.push({ label: `comment ${i + 1} text`, x: fromSection(t.left) });
        });
        if (caption !== null) {
          const head = caption.querySelector(':scope > div:first-child > .min-w-0');
          const h = shown(head) ? textBox(head) : null;
          const c = caption.getBoundingClientRect();
          if (h === null) column.gaps.push({ label: 'no caption header name', gap: -1, min: 0 });
          else {
            column.textLefts.push({
              label: 'caption header name',
              x: shared ? h.left : h.left - c.left,
            });
          }
        }
        out.push(column);
        if (!post) {
          // The "Comments" label on the photo edge: the photos hang left of the text.
          const label = section.querySelector(':scope > div:first-child');
          const l = shown(label) ? textBox(label) : null;
          const photo = rows[0]?.querySelector('[data-avatar-role]') ?? null;
          const edge: AlignFamily = {
            label: 'brief-screen photo edge',
            textLefts: [],
            rightEdges: [],
            gaps: [],
          };
          if (l !== null) edge.textLefts.push({ label: '"Comments" label', x: l.left });
          if (shown(photo)) {
            edge.textLefts.push({
              label: 'comment 1 photo',
              x: photo.getBoundingClientRect().left,
            });
          }
          out.push(edge);
          return out;
        }
        // Rule 3: one right edge per column (the caption block's, the gallery tools row's).
        const paintedRight = (el: Element): number | null => {
          const t = textBox(el);
          let right = t?.right ?? -Infinity;
          for (const svg of Array.from(el.querySelectorAll('svg')).filter(shown)) {
            right = Math.max(right, svg.getBoundingClientRect().right);
          }
          return Number.isFinite(right) ? right : null;
        };
        if (caption !== null) {
          const edge: AlignFamily = {
            label: 'post-screen caption right edge',
            textLefts: [],
            rightEdges: [
              { label: 'caption block right', x: caption.getBoundingClientRect().right },
            ],
            gaps: [],
          };
          const edit = caption.querySelector('[data-caption-edit]');
          const e = shown(edit) ? paintedRight(edit) : null;
          if (e !== null) edge.rightEdges.push({ label: 'caption Edit', x: e });
          const gotIt = caption.querySelector('[data-caption-tip] button');
          const g = shown(gotIt) ? textBox(gotIt) : null;
          if (g !== null) edge.rightEdges.push({ label: '"Got it" text', x: g.right });
          out.push(edge);
        }
        const tools = document.querySelector('[data-gallery-tools]');
        const versions = tools?.querySelector('[data-gallery-versions]') ?? null;
        if (shown(tools) && shown(versions)) {
          const v = textBox(versions);
          out.push({
            label: 'post-screen gallery right edge',
            textLefts: [],
            rightEdges: [
              { label: 'gallery tools row right', x: tools.getBoundingClientRect().right },
              ...(v !== null ? [{ label: 'version key text', x: v.right }] : []),
            ],
            gaps: [],
          });
        }
        // Rule 5: text off the comments section's top hairline, above and under it.
        const layered = new Map<Element, boolean>();
        const inLayer = (el: Element | null): boolean => {
          if (el === null || el === document.body) return false;
          const known = layered.get(el);
          if (known !== undefined) return known;
          const pos = getComputedStyle(el).position;
          const v = pos === 'fixed' || pos === 'sticky' || inLayer(el.parentElement);
          layered.set(el, v);
          return v;
        };
        let above = -Infinity;
        let under = Infinity;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          if ((n.textContent ?? '').trim() === '') continue;
          const host = n.parentElement;
          if (host === null || host.closest('[aria-hidden="true"]') !== null) continue;
          if (getComputedStyle(host).visibility === 'hidden') continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const rect of Array.from(range.getClientRects())) {
            // Painted text only: an sr-only label is a 1px box.
            if (rect.width <= 1 || rect.height <= 1) continue;
            if (rect.right <= sec.left || rect.left >= sec.right) continue;
            if (section.contains(n)) {
              if (rect.top >= sec.top - 0.5) under = Math.min(under, rect.top);
            } else if (rect.top < sec.top && !inLayer(host)) {
              above = Math.max(above, rect.bottom);
            }
          }
        }
        const hairline: AlignFamily = {
          label: 'post-screen comments hairline',
          textLefts: [],
          rightEdges: [],
          gaps: [],
        };
        if (Number.isFinite(above)) {
          hairline.gaps.push({
            label: 'last text above to the comments hairline',
            gap: sec.top - above,
            min: 12,
          });
        }
        if (Number.isFinite(under)) {
          hairline.gaps.push({
            label: 'the comments hairline to the first text under it',
            gap: under - sec.top,
            min: 12,
          });
        }
        out.push(hairline);
        return out;
      }
      if (which === 'chat-replies-row') {
        // The main chat's replies rows: photos, count, time, dot; no reply text.
        const rowsHere = Array.from(document.querySelectorAll('[data-replies-row]')).filter(shown);
        if (rowsHere.length === 0) {
          return [
            {
              label: 'chat replies row',
              textLefts: [],
              rightEdges: [],
              gaps: [{ label: 'no replies row shown', gap: -1, min: 0 }],
            },
          ];
        }
        rowsHere.forEach((row, n) => {
          const f: AlignFamily = {
            label: `replies row ${n + 1}`,
            textLefts: [],
            rightEdges: [],
            gaps: [],
          };
          const button = row.querySelector('button') ?? row;
          f.gaps.push({
            label: 'row height (44 target)',
            gap: button.getBoundingClientRect().height,
            min: 44,
          });
          const latest = row.querySelector('[data-replies-latest]');
          if (latest !== null) {
            f.gaps.push({ label: 'a reply text node shows (none allowed)', gap: -1, min: 0 });
          }
          const photos = row.querySelector('[data-replies-photos]');
          const count = row.querySelector('[data-replies-count]');
          const time = row.querySelector('[data-replies-time]');
          const dot = row.querySelector('[data-replies-dot]');
          if (!shown(time) || (time.textContent ?? '').trim() === '') {
            f.gaps.push({ label: 'the last reply time is missing', gap: -1, min: 0 });
          }
          const chain = [photos, count, time, dot].filter(shown);
          for (let i = 1; i < chain.length; i += 1) {
            const a = chain[i - 1] as Element;
            const b = chain[i] as Element;
            const name = (el: Element): string =>
              el === photos ? 'photos' : el === count ? 'count' : el === time ? 'time' : 'dot';
            f.gaps.push({
              label: `${name(a)} to ${name(b)}`,
              gap: b.getBoundingClientRect().left - a.getBoundingClientRect().right,
              equals: 8,
            });
          }
          out.push(f);
        });
        return out;
      }
      if (which === 'threads-list') {
        const blocks = Array.from(document.querySelectorAll('[data-threads-block]')).filter(shown);
        if (blocks.length === 0) {
          return [
            {
              label: 'threads list',
              textLefts: [],
              rightEdges: [],
              gaps: [{ label: 'no thread block shown', gap: -1, min: 0 }],
            },
          ];
        }
        blocks.forEach((block, n) => {
          const b = block.getBoundingClientRect();
          const f: AlignFamily = {
            label: `threads block ${n + 1}`,
            textLefts: [],
            rightEdges: [],
            gaps: [],
          };
          const at = (label: string, x: number | null): void => {
            if (x === null) f.gaps.push({ label: `no ${label}`, gap: -1, min: 0 });
            else f.gaps.push({ label: `${label} x`, gap: x - b.left, equals: 60 });
          };
          const header = block.querySelector('[data-threads-header]');
          for (const line of Array.from(header?.children ?? []).filter(shown)) {
            at('header line', textBox(line)?.left ?? null);
          }
          if (shown(header)) {
            f.gaps.push({
              label: 'header right edge',
              gap: b.right - header.getBoundingClientRect().right,
              equals: 16,
            });
          }
          Array.from(block.querySelectorAll('li[data-msg-id]'))
            .filter(shown)
            .forEach((row, i) => {
              const name = row.querySelector('[data-sender-line]');
              if (shown(name)) at(`message ${i + 1} name`, textBox(name)?.left ?? null);
              const body = row.querySelector('[data-msg-body]');
              if (shown(body)) at(`message ${i + 1} text`, textBox(body)?.left ?? null);
              const padRight = parseFloat(getComputedStyle(row).paddingRight) || 0;
              f.gaps.push({
                label: `message ${i + 1} right edge`,
                gap: b.right - (row.getBoundingClientRect().right - padRight),
                equals: 16,
              });
            });
          const more = block.querySelector('[data-threads-more]');
          if (shown(more)) at('more replies', textBox(more)?.left ?? null);
          const reply = block.querySelector('[data-threads-reply]');
          const markRead = block.querySelector('[data-threads-mark-read]');
          if (shown(markRead)) {
            at('Mark as read button', markRead.getBoundingClientRect().left);
            if (shown(reply)) {
              f.gaps.push({
                label: 'Mark as read to Reply',
                gap: reply.getBoundingClientRect().left - markRead.getBoundingClientRect().right,
                equals: 8,
              });
            }
          } else if (shown(reply)) {
            at('Reply button', reply.getBoundingClientRect().left);
          }
          if (!shown(reply)) f.gaps.push({ label: 'no Reply button', gap: -1, min: 0 });
          if (block.hasAttribute('data-unread') !== shown(markRead)) {
            f.gaps.push({ label: 'Mark as read shows on unread blocks only', gap: -1, min: 0 });
          }
          const prev = block.previousElementSibling;
          const band = (el: Element | null): el is Element =>
            el !== null && el.hasAttribute('data-threads-band');
          if (band(prev) && shown(header)) {
            const t = textBox(header);
            if (t !== null) {
              f.gaps.push({
                label: 'band hairline to header text',
                gap: t.top - prev.getBoundingClientRect().bottom,
                min: 12,
              });
            }
          }
          const next = block.nextElementSibling;
          if (band(next) && shown(reply)) {
            f.gaps.push({
              label: 'Reply to the next band hairline',
              gap: next.getBoundingClientRect().top - reply.getBoundingClientRect().bottom,
              min: 12,
            });
          }
          out.push(f);
        });
        return out;
      }
      // A thread view (9 Nov 2026, EXACT): the root (40 photo at x16, its text
      // full width at x16), 12 from its last line to the strip, the strip
      // label at x16, 8 to the first reply's name, replies' text at x60, 16
      // between replies, the last key's glyph on the content edge (374 phone).
      const catchUp = which === 'catch-up-thread';
      const strip = document.querySelector(
        catchUp
          ? '[data-catch-up-thread] [data-thread-strip]'
          : '[data-thread-view] [data-thread-strip]',
      );
      if (!shown(strip)) {
        return [
          {
            label: `${which} strip`,
            textLefts: [],
            rightEdges: [],
            gaps: [{ label: 'no thread strip shown', gap: -1, min: 0 }],
          },
        ];
      }
      const s = strip.getBoundingClientRect();
      // The thread's left edge: the strip is a full width band.
      const x0 = s.left;
      const rowSel = catchUp ? '[data-catch-up-message]' : 'li[data-msg-id]';
      const host =
        strip.closest(catchUp ? '[data-catch-up-thread]' : '[data-thread-view]') ?? document;
      const rows = Array.from(host.querySelectorAll(rowSel)).filter(shown);
      const above = rows.filter((r) => r.getBoundingClientRect().bottom <= s.top + 0.5);
      const below = rows.filter((r) => r.getBoundingClientRect().top >= s.bottom - 0.5);
      const root = above.pop();
      const f: AlignFamily = { label: `${which}`, textLefts: [], rightEdges: [], gaps: [] };
      const at = (label: string, x: number, want: number): void => {
        f.gaps.push({ label: `${label} x`, gap: x - x0, equals: want });
      };
      /** A row's text: chat's body; catch up's last paragraph. */
      const textOf = (row: Element): Element | null =>
        catchUp
          ? (Array.from(row.querySelectorAll('p')).filter(shown).pop() ?? null)
          : row.querySelector('[data-msg-body]');
      /** A row's last content line: chat's bubble, catch up's last paragraph. */
      const lastOf = (row: Element): Element | null =>
        catchUp ? textOf(row) : row.querySelector('[data-bubble]');
      const nameOf = (row: Element): Element | null =>
        row.querySelector(catchUp ? '[data-catch-up-name]' : '[data-sender-line]');
      if (root === undefined) {
        f.gaps.push({ label: 'no root above the strip', gap: -1, min: 0 });
      } else {
        const photo = root.querySelector('[data-avatar-role]');
        if (shown(photo)) {
          const p = photo.getBoundingClientRect();
          at('root photo', p.left, 16);
          f.gaps.push({ label: 'root photo size', gap: p.width, equals: 40 });
        } else f.gaps.push({ label: 'no root photo', gap: -1, min: 0 });
        const text = textOf(root);
        const t = text !== null && shown(text) ? textBox(text) : null;
        if (t !== null) at('root text', t.left, 16);
        else f.gaps.push({ label: 'no root text', gap: -1, min: 0 });
        const last = lastOf(root);
        if (shown(last)) {
          f.gaps.push({
            label: 'root last line to strip hairline',
            gap: s.top - last.getBoundingClientRect().bottom,
            equals: 12,
          });
        }
      }
      const label = strip.querySelector('[data-thread-strip-label]');
      if (strip.getAttribute('data-thread-strip') === 'replies' && shown(label)) {
        const t = textBox(label);
        if (t !== null) at('strip label', t.left, 16);
        if (strip.querySelector('[data-thread-strip-icon]') !== null) {
          f.gaps.push({ label: 'an icon on the replies strip', gap: -1, min: 0 });
        }
      }
      // The trailing key's glyph on the strip's content edge (16 in).
      const keys = Array.from(strip.querySelectorAll('[data-thread-root-action]')).filter(shown);
      const glyph = keys.pop()?.querySelector('svg') ?? null;
      if (shown(glyph)) {
        f.gaps.push({
          label: 'last key glyph to the strip edge',
          gap: s.right - glyph.getBoundingClientRect().right,
          equals: 16,
        });
      }
      const firstReply = below[0];
      if (firstReply !== undefined) {
        const name = nameOf(firstReply);
        if (shown(name)) {
          f.gaps.push({
            label: 'strip to first reply name',
            gap: name.getBoundingClientRect().top - s.bottom,
            equals: 8,
          });
        }
      }
      below.slice(0, 4).forEach((r, i) => {
        const text = textOf(r);
        const t = text !== null && shown(text) ? textBox(text) : null;
        if (t !== null) at(`reply ${i + 1} text`, t.left, 60);
        const name = nameOf(r);
        if (shown(name)) {
          const n = textBox(name);
          if (n !== null) at(`reply ${i + 1} name`, n.left, 60);
        }
        const next = below[i + 1];
        const nextName = next !== undefined ? nameOf(next) : null;
        const last = lastOf(r);
        if (i < 3 && shown(nextName) && shown(last)) {
          f.gaps.push({
            label: `reply ${i + 1} to reply ${i + 2}`,
            gap: nextName.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
            equals: 16,
          });
        }
      });
      out.push(f);
      return out;
    },
    { which: scope },
  );
  settleFindings(
    screenName,
    alignmentViolations(families).map((message) => ({ check: 'alignment' as const, message })),
  );
}

/**
 * Check 16 (9 Nov 2026, emoji reactions): on the screen as shot, every
 * reaction chip row ([data-reaction-chips]) is measured (EXACT +-1):
 * - each pill ([data-reaction-chip], the smiley [data-reaction-add]) is 32
 *   tall and its tap box (the pill grown by its ::before) at least 44 tall;
 * - the row's left edge is its row's text column: a chat, post / brief
 *   comment (chat's row since 11 Nov 2026), plan comment or thread reply
 *   message's body text ([data-msg-body]); a catch-up row's text (its last
 *   paragraph);
 * - in a thread view the root's row sits at x16 and replies' at x60 from the
 *   strip's left, the root's chip row ends 12 over the strip's top hairline,
 *   and the first reply's name sits 8 under the strip;
 * - no [data-reaction-badge] anywhere, and at least `minRows` rows show.
 */
export async function assertReactionChips(
  page: Page,
  screenName: string,
  opts: { minRows?: number } = {},
): Promise<void> {
  const messages = await page.evaluate((minRows: number): string[] => {
    const out: string[] = [];
    const shown = (el: Element | null): el is Element => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const textLeft = (el: Element): number | null => {
      let left = Infinity;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) left = Math.min(left, rect.left);
        }
      }
      return Number.isFinite(left) ? left : null;
    };
    const px = (v: string): number | null => (v.endsWith('px') ? parseFloat(v) : null);
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
    if (document.querySelector('[data-reaction-badge]') !== null) {
      out.push('a [data-reaction-badge] shows (chips only, 9 Nov 2026)');
    }
    const rows = Array.from(document.querySelectorAll('[data-reaction-chips]')).filter(shown);
    if (rows.length < minRows) out.push(`${rows.length} reaction chip rows, want ${minRows}+`);
    rows.forEach((row, i) => {
      const at = `chip row ${i + 1}`;
      const box = row.getBoundingClientRect();
      for (const pill of Array.from(
        row.querySelectorAll('[data-reaction-chip], [data-reaction-add]'),
      ).filter(shown)) {
        const r = pill.getBoundingClientRect();
        const name = pill.getAttribute('aria-label') ?? 'pill';
        if (!near(r.height, 32)) out.push(`${at}: ${name} is ${r1(r.height)} tall, want 32`);
        const before = getComputedStyle(pill, '::before');
        const grow =
          before.position === 'absolute'
            ? Math.max(0, -(px(before.top) ?? 0)) + Math.max(0, -(px(before.bottom) ?? 0))
            : 0;
        if (r.height + grow < 43.5) {
          out.push(`${at}: ${name} tap box ${r1(r.height + grow)} tall, want 44+`);
        }
      }
      const catchUp = row.closest('[data-catch-up-message]');
      const message = row.closest('li[data-msg-id]');
      const view = row.closest('[data-thread-view], [data-catch-up-thread]');
      const strip = view?.querySelector('[data-thread-strip]') ?? null;
      if (shown(strip)) {
        const s = strip.getBoundingClientRect();
        const isRoot = box.bottom <= s.top + 0.5;
        const want = isRoot ? 16 : 60;
        if (!near(box.left - s.left, want)) {
          out.push(`${at}: x ${r1(box.left - s.left)} in the thread, want ${want}`);
        }
        if (isRoot) {
          if (!near(s.top - box.bottom, 12)) {
            out.push(`${at}: root chips to strip ${r1(s.top - box.bottom)}, want 12`);
          }
          const reply = Array.from(
            view?.querySelectorAll('[data-catch-up-message], li[data-msg-id]') ?? [],
          )
            .filter(shown)
            .find((el) => el.getBoundingClientRect().top >= s.bottom - 0.5);
          const name = reply?.querySelector('[data-catch-up-name], [data-sender-line]') ?? null;
          if (shown(name) && !near(name.getBoundingClientRect().top - s.bottom, 8)) {
            out.push(
              `${at}: strip to first reply name ${r1(name.getBoundingClientRect().top - s.bottom)}, want 8`,
            );
          }
        }
        return;
      }
      const text = catchUp
        ? (Array.from(catchUp.querySelectorAll('p')).filter(shown).pop() ?? null)
        : (message?.querySelector('[data-msg-body]') ?? null);
      const left = text !== null && shown(text) ? textLeft(text) : null;
      if (left === null) out.push(`${at}: no text to align to`);
      else if (!near(box.left, left)) {
        out.push(`${at}: left ${r1(box.left)}, text column ${r1(left)}`);
      }
    });
    return out;
  }, opts.minRows ?? 1);
  settleFindings(
    screenName,
    messages.map((message) => ({ check: 'alignment' as const, message: `reactions: ${message}` })),
  );
}

/** Check 16: Activity never shows reactions (no chip row, no badge). */
export async function assertNoReactionsHere(page: Page, screenName: string): Promise<void> {
  const count = await page
    .locator('[data-reaction-chips], [data-reaction-badge], [data-reaction-add]')
    .count();
  settleFindings(
    screenName,
    count > 0
      ? [{ check: 'alignment' as const, message: `reactions: ${count} reaction parts on Activity` }]
      : [],
  );
}

// Check 15 (10 Nov 2026, Activity twins Plan): Activity's list measured
// against the Plan tab's, both read on the page as painted.

/** A list as painted: its chips, sections, headings, first row and chips. */
export interface ListTwinGeom {
  /** The first filter chip's bottom edge. */
  chipBottom: number | null;
  /** The list's own gap between sections (computed row-gap). */
  listGap: number;
  headings: Array<{ text: string; top: number; bottom: number; style: string }>;
  sections: Array<{ headingBottom: number; firstRowTop: number; lastRowBottom: number }>;
  row: {
    height: number;
    pictureLeft: number;
    pictureRight: number;
    titleLeft: number;
    timeRight: number;
  } | null;
  rowHeights: number[];
  /** Activity's "N new" chips: box, the name's right edge, colours and the row. */
  chips: Array<{
    text: string;
    height: number;
    left: number;
    nameRight: number;
    rowHeight: number;
    bg: string;
    fg: string;
    border: string;
  }>;
  /** The primary Button's fill and text (bg-accent / text-accent-fg) as computed here. */
  ink: { bg: string; fg: string };
  /** Retired Activity hooks still in the DOM (lines, bucket heads, the catch-up bar). */
  oldHooks: number;
}

/** Read the Plan tab's or Activity's list geometry (check 15). */
export async function readListTwin(page: Page, kind: 'plan' | 'activity'): Promise<ListTwinGeom> {
  return page.evaluate((which): ListTwinGeom => {
    const sel =
      which === 'plan'
        ? {
            list: '[data-plan-tab-list]',
            section: '[data-plan-tab-section]',
            chip: '[data-plan-tab-when]',
          }
        : {
            list: '[data-activity-list]',
            section: '[data-activity-section]',
            chip: '[data-activity-chips] > :first-child',
          };
    const shown = (el: Element | null): el is Element => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const rect = (el: Element): DOMRect => el.getBoundingClientRect();
    const list = document.querySelector(sel.list);
    const chip = document.querySelector(sel.chip);
    const sections = Array.from(document.querySelectorAll(sel.section)).filter(shown);
    const headings: ListTwinGeom['headings'] = [];
    const parts: ListTwinGeom['sections'] = [];
    for (const section of sections) {
      const h = section.querySelector(':scope > h2');
      const rows = Array.from(section.querySelectorAll('[data-list-card]')).filter(shown);
      if (!shown(h) || rows.length === 0) continue;
      const cs = getComputedStyle(h);
      headings.push({
        text: (h.textContent ?? '').trim(),
        top: rect(h).top,
        bottom: rect(h).bottom,
        style: [
          cs.fontSize,
          cs.fontWeight,
          cs.textTransform,
          cs.letterSpacing,
          cs.lineHeight,
          cs.color,
        ].join(' '),
      });
      parts.push({
        headingBottom: rect(h).bottom,
        firstRowTop: Math.min(...rows.map((r) => rect(r).top)),
        lastRowBottom: Math.max(...rows.map((r) => rect(r).bottom)),
      });
    }
    const rowsAll = Array.from(document.querySelectorAll(`${sel.list} [data-list-card]`)).filter(
      shown,
    );
    const first = rowsAll[0];
    const part = (q: string): Element | null => first?.querySelector(q) ?? null;
    const picture = part('[data-list-card-picture]');
    const title = part('[data-list-card-title]');
    const time = part('[data-list-card-time]');
    const probe = document.createElement('span');
    probe.className = 'bg-accent text-accent-fg';
    document.body.appendChild(probe);
    const ink = { bg: getComputedStyle(probe).backgroundColor, fg: getComputedStyle(probe).color };
    probe.remove();
    const chips = Array.from(document.querySelectorAll('[data-activity-new-chip]'))
      .filter(shown)
      .map((c) => {
        const cs = getComputedStyle(c);
        const name = c.parentElement?.querySelector('[data-activity-name]') ?? null;
        const row = c.closest('[data-list-card]');
        return {
          text: (c.textContent ?? '').trim(),
          height: rect(c).height,
          left: rect(c).left,
          nameRight: name !== null ? rect(name).right : Number.NaN,
          rowHeight: row !== null ? rect(row).height : Number.NaN,
          bg: cs.backgroundColor,
          fg: cs.color,
          border: cs.borderTopStyle === 'none' ? '0' : cs.borderTopWidth,
        };
      });
    return {
      chipBottom: shown(chip) ? rect(chip).bottom : null,
      listGap: list !== null ? Number.parseFloat(getComputedStyle(list).rowGap) || 0 : 0,
      headings,
      sections: parts,
      row:
        first !== undefined && shown(picture) && shown(title) && shown(time)
          ? {
              height: rect(first).height,
              pictureLeft: rect(picture).left,
              pictureRight: rect(picture).right,
              titleLeft: rect(title).left,
              timeRight: rect(time).right,
            }
          : null,
      rowHeights: rowsAll.map((r) => rect(r).height),
      chips,
      ink,
      oldHooks: document.querySelectorAll(
        '[data-activity-line], [data-activity-bucket-head], [data-activity-catch-up-bar]',
      ).length,
    };
  }, kind);
}

/** Activity's loading boxes as painted: the heading bone's line and the first box. */
export async function readActivityBoxes(
  page: Page,
): Promise<{ headingTop: number; firstRowTop: number } | null> {
  return page.evaluate(() => {
    const heading = document.querySelector('[data-activity-boxes] [data-activity-heading-box]');
    const row = document.querySelector('[data-activity-boxes] [data-activity-box]');
    if (heading === null || row === null) return null;
    return {
      headingTop: heading.getBoundingClientRect().top,
      firstRowTop: row.getBoundingClientRect().top,
    };
  });
}

/** Check 15's rules over the two lists (and Activity's boxes). Pure. */
export function activityTwinViolations(
  plan: ListTwinGeom,
  activity: ListTwinGeom,
  boxes: { headingTop: number; firstRowTop: number } | null,
): string[] {
  const out: string[] = [];
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const eq = (label: string, a: number, b: number): void => {
    if (!same(a, b)) out.push(`${label}: Activity ${r1(a)} vs Plan ${r1(b)}`);
  };
  if (plan.row === null) out.push('Plan shows no row to measure');
  if (activity.row === null) out.push('Activity shows no row to measure');
  if (plan.row !== null && activity.row !== null) {
    // An Activity row with a 2-line preview is one 20 line taller (Part 6).
    const rowH = activity.row.height;
    if (!same(rowH, plan.row.height) && !same(rowH, plan.row.height + 20)) {
      eq('row height', rowH, plan.row.height);
    }
    eq('picture left', activity.row.pictureLeft, plan.row.pictureLeft);
    eq('picture right', activity.row.pictureRight, plan.row.pictureRight);
    eq('title x', activity.row.titleLeft, plan.row.titleLeft);
    eq('time right edge', activity.row.timeRight, plan.row.timeRight);
  }
  for (const h of activity.rowHeights) {
    const base = plan.row?.height ?? activity.row?.height ?? h;
    if (!same(h, base) && !same(h, base + 20)) {
      out.push(`an Activity row is ${r1(h)} tall, not ${r1(base)} or ${r1(base + 20)}`);
    }
  }
  const pHead = plan.headings[0];
  const aHead = activity.headings[0];
  if (pHead === undefined) out.push('Plan shows no section heading');
  if (aHead === undefined) out.push('Activity shows no section heading');
  if (pHead !== undefined && aHead !== undefined) {
    if (aHead.style !== pHead.style) {
      out.push(`heading style: Activity "${aHead.style}" vs Plan "${pHead.style}"`);
    }
    if (plan.chipBottom !== null && activity.chipBottom !== null) {
      eq(
        'chips to the first heading',
        aHead.top - activity.chipBottom,
        pHead.top - plan.chipBottom,
      );
    }
  }
  const pSec = plan.sections[0];
  const aSec = activity.sections[0];
  if (pSec !== undefined && aSec !== undefined) {
    eq(
      'heading to its first row',
      aSec.firstRowTop - aSec.headingBottom,
      pSec.firstRowTop - pSec.headingBottom,
    );
  }
  // A section's last row to the next heading: Plan's measured gap, else its list gap.
  const planNext = plan.headings[1];
  const planGap =
    pSec !== undefined && planNext !== undefined ? planNext.top - pSec.lastRowBottom : plan.listGap;
  activity.sections.forEach((sec, i) => {
    const next = activity.headings[i + 1];
    if (next !== undefined)
      eq(`section ${i + 1} last row to the next heading`, next.top - sec.lastRowBottom, planGap);
  });
  if (activity.headings.length < 2) out.push('Activity shows fewer than 2 sections to space');
  const want = NEW_CHIP_HEIGHT;
  if (activity.chips.length === 0) out.push('Activity shows no "N new" chip');
  for (const c of activity.chips) {
    if (!same(c.height, want)) out.push(`"${c.text}" is ${r1(c.height)} tall, not ${want}`);
    if (!same(c.left - c.nameRight, 8))
      out.push(`"${c.text}" sits ${r1(c.left - c.nameRight)} after the name, not 8`);
    if (activity.row !== null && !same(c.rowHeight, activity.row.height)) {
      out.push(
        `the row with "${c.text}" is ${r1(c.rowHeight)} tall, not ${r1(activity.row.height)}`,
      );
    }
    if (c.bg !== activity.ink.bg || c.fg !== activity.ink.fg) {
      out.push(
        `"${c.text}" is ${c.bg} / ${c.fg}, not the primary Button's ${activity.ink.bg} / ${activity.ink.fg}`,
      );
    }
    if (c.border !== '0' && c.border !== '0px') out.push(`"${c.text}" has a ${c.border} border`);
  }
  if (activity.oldHooks > 0) out.push(`${activity.oldHooks} retired Activity hooks still render`);
  if (boxes === null) out.push('Activity painted no loading boxes');
  if (boxes !== null && aHead !== undefined && aSec !== undefined) {
    const headDelta = aHead.top - boxes.headingTop;
    const rowDelta = aSec.firstRowTop - boxes.firstRowTop;
    if (!same(headDelta, 0))
      out.push(`loading to landed: the first heading moves ${r1(headDelta)}px`);
    if (!same(rowDelta, 0)) out.push(`loading to landed: the first row moves ${r1(rowDelta)}px`);
  }
  return out;
}

/** Check 15: settle Activity's twin findings (strict fails, report annotates). */
export function assertActivityTwinsPlan(
  label: string,
  plan: ListTwinGeom,
  activity: ListTwinGeom,
  boxes: { headingTop: number; firstRowTop: number } | null,
): void {
  settleFindings(
    label,
    activityTwinViolations(plan, activity, boxes).map((message) => ({
      check: 'alignment' as const,
      message,
    })),
  );
}

// Check 15, the lead row (Activity, 10 Nov 2026): Threads and Catch up sit in
// ListScreen's lead slot under the filter pills, two equal boxes filling the
// row 8 apart (Threads first, from the gutter to the content's right edge), in
// words: the face 28 tall (PAIR_BOX_HEIGHT) and the text 12 (500), padding-x 8,
// radius 8, a 44 tall hit (::before); the count pill 16 (PAIR_PILL_HEIGHT), its
// text 10; each filled (accent) with its pill when its count is > 0, outlined
// with no pill at 0. Nothing of them in the top bar. Laptop: no Activity in
// the top bar; the Sidebar's last item is Activity, after Chat, filled on
// /notifications, with the count when there is one.
export const ACTIVITY_PAIR_HIT_PX = 44;
export const ACTIVITY_PAIR_GAP_PX = 8;
/** Face height, text size and pill height (ui/layout named sizes). */
export const ACTIVITY_PAIR = {
  face: PAIR_BOX_HEIGHT,
  text: 12,
  pill: PAIR_PILL_HEIGHT,
  pillText: 10,
} as const;

export async function assertActivityLeadRow(page: Page, screenName: string): Promise<void> {
  const got = await page.evaluate(() => {
    const read = (sel: string) => {
      const el = document.querySelector(`[data-shell="lead"] ${sel}`);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const hit = getComputedStyle(el, '::before');
      const pill = el.querySelector('[data-count-badge]');
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        radius: s.borderTopLeftRadius,
        padding: `${s.paddingLeft} ${s.paddingRight}`,
        border: s.borderTopWidth,
        fontSize: parseFloat(s.fontSize),
        weight: s.fontWeight,
        background: s.backgroundColor,
        hit: parseFloat(hit.height) || 0,
        text: (el.textContent ?? '').trim(),
        icon: el.querySelector('svg') !== null,
        count: el.getAttribute('data-count'),
        pill: pill === null ? null : pill.getBoundingClientRect().height,
        pillFont: pill === null ? null : parseFloat(getComputedStyle(pill).fontSize),
        pillOff: (() => {
          if (pill === null) return null;
          const box = pill.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(pill);
          const text = range.getBoundingClientRect();
          return text.height > 0 ? text.top + text.height / 2 - (box.top + box.height / 2) : 0;
        })(),
      };
    };
    const probe = document.createElement('span');
    probe.className = 'bg-accent';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const lead = document.querySelector('[data-shell="lead"]');
    const leadBox = lead?.getBoundingClientRect() ?? null;
    const leadPad = lead === null ? 0 : parseFloat(getComputedStyle(lead).paddingLeft);
    const nav = document.querySelector('nav[aria-label="Primary"]');
    const items = nav === null ? [] : Array.from(nav.children);
    const side = document.querySelector('[data-sidebar-activity]');
    const sideShown = side !== null && side.getBoundingClientRect().width > 0;
    const last = items[items.length - 1] ?? null;
    const before = items[items.length - 2] ?? null;
    return {
      threads: read('[data-topbar-threads]'),
      catchUp: read('[data-topbar-catch-up]'),
      accent,
      inTopbar: document.querySelectorAll(
        'header :is([data-topbar-threads], [data-topbar-catch-up])',
      ).length,
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      row:
        leadBox === null ? null : { left: leadBox.left + leadPad, right: leadBox.right - leadPad },
      topbarActivity: document.querySelectorAll('[data-topbar-activity]').length,
      side: sideShown
        ? {
            last: last === side,
            afterChat: before?.getAttribute('href')?.startsWith('/chat') === true,
            active: side.getAttribute('data-selected') === 'true',
            background: getComputedStyle(side).backgroundColor,
            badge: side.querySelector('[data-count-badge]') !== null,
          }
        : null,
    };
  });
  const out: string[] = [];
  const want = ACTIVITY_PAIR;
  const { threads, catchUp } = got;
  if (threads === null || catchUp === null) {
    out.push('no Threads | Catch up in the lead row ([data-shell="lead"])');
  } else {
    const label = `Threads (${threads.count}) / Catch up (${catchUp.count})`;
    if (threads.width !== catchUp.width || threads.height !== catchUp.height) {
      out.push(
        `${label}: boxes ${threads.width}x${threads.height} vs ${catchUp.width}x${catchUp.height}, not one size`,
      );
    }
    for (const [name, b, word] of [
      ['Threads', threads, 'Threads'],
      ['Catch up', catchUp, 'Catch up'],
    ] as const) {
      if (Math.abs(b.height - want.face) > 0.5) {
        out.push(`${name}'s face is ${b.height} tall, not ${want.face}`);
      }
      if (Math.abs(b.fontSize - want.text) > 0.1 || b.weight !== '500') {
        out.push(`${name} text is ${b.fontSize}/${b.weight}, not ${want.text}/500`);
      }
      if (Math.abs(b.hit - ACTIVITY_PAIR_HIT_PX) > 0.5) {
        out.push(`${name}'s hit is ${b.hit} tall, not 44`);
      }
      if (b.padding !== '8px 8px') out.push(`${name} padding-x ${b.padding}, not 8px`);
      if (b.radius !== '8px') out.push(`${name} radius ${b.radius}, not 8px`);
      if (b.icon || !b.text.startsWith(word)) {
        out.push(`${name} shows "${b.text}"${b.icon ? ' with an icon' : ''}, not the word`);
      }
      const on = b.count !== null && b.count !== '0';
      if (on && b.background !== got.accent) out.push(`${name} has ${b.count} but is not filled`);
      if (!on && b.background === got.accent) out.push(`${name} is filled at 0`);
      if (on && (b.pill === null || Math.abs(b.pill - want.pill) > 0.5)) {
        out.push(`${name}'s pill is ${b.pill ?? 'missing'} tall, not ${want.pill}`);
      }
      if (!on && b.pill !== null) out.push(`${name} shows a pill at 0`);
      if (on && b.pillFont !== null && Math.abs(b.pillFont - want.pillText) > 0.1) {
        out.push(`${name}'s pill text is ${b.pillFont}, not ${want.pillText}`);
      }
      if (on && b.pillOff !== null && Math.abs(b.pillOff) > 1) {
        out.push(`${name}'s pill text is ${b.pillOff}px off its centre`);
      }
      if (b.x + b.width > got.viewport + 0.5) out.push(`${name} ends past the viewport`);
    }
    for (const key of ['radius', 'padding', 'border', 'fontSize', 'weight'] as const) {
      if (threads[key] !== catchUp[key]) {
        out.push(`${label}: ${key} ${threads[key]} vs ${catchUp[key]}, not the same box`);
      }
    }
    const gap = catchUp.x - (threads.x + threads.width);
    if (Math.abs(gap - ACTIVITY_PAIR_GAP_PX) > 0.5) {
      out.push(`Threads to Catch up is ${gap}px, not ${ACTIVITY_PAIR_GAP_PX} (Threads first)`);
    }
    if (got.row !== null) {
      if (Math.abs(threads.x - got.row.left) > 1) {
        out.push(`Threads starts at ${threads.x}, not the row's left ${got.row.left}`);
      }
      const end = catchUp.x + catchUp.width;
      if (Math.abs(end - got.row.right) > 1) {
        out.push(`Catch up ends at ${end}, not the row's right ${got.row.right}`);
      }
    }
  }
  if (got.inTopbar !== 0) out.push('Threads or Catch up in the top bar (one top bar on every tab)');
  if (got.scrollWidth > got.viewport) {
    out.push(`the page scrolls sideways (${got.scrollWidth} > ${got.viewport})`);
  }
  if (got.viewport >= 768) {
    if (got.topbarActivity !== 0) out.push('an Activity button in the laptop top bar');
    const side = got.side;
    if (side === null) out.push('no Activity in the Sidebar');
    else {
      if (!side.last || !side.afterChat)
        out.push('Sidebar Activity is not the last item after Chat');
      if (!side.active || side.background !== got.accent) {
        out.push('Sidebar Activity is not filled on /notifications');
      }
      const unread = catchUp !== null && catchUp.count !== null && catchUp.count !== '0';
      if (unread && !side.badge) out.push('Sidebar Activity shows no count');
    }
  }
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}

/**
 * Check 15, narrow phones: at 390 and 375 wide, Activity's lead row fits:
 * Threads and Catch up in words, inside the viewport; nothing scrolls
 * sideways. Restores the viewport it found.
 */
export async function assertActivityLeadRowNarrow(page: Page, screenName: string): Promise<void> {
  const before = page.viewportSize();
  const out: string[] = [];
  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: before?.height ?? 844 });
    await page.waitForTimeout(100);
    const got = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(`[data-shell="lead"] ${sel}`);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, text: (el.textContent ?? '').trim() };
      };
      return {
        threads: read('[data-topbar-threads]'),
        catchUp: read('[data-topbar-catch-up]'),
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    const at = `${width} wide`;
    for (const [name, b] of [
      ['Threads', got.threads],
      ['Catch up', got.catchUp],
    ] as const) {
      if (b === null || b.left < 0 || b.right > got.viewport) {
        out.push(`${at}: ${name} is missing or past the viewport`);
      } else if (!b.text.startsWith(name)) out.push(`${at}: ${name} shows "${b.text}"`);
    }
    if (got.scrollWidth > got.viewport) out.push(`${at}: the page scrolls sideways`);
  }
  if (before !== null) await page.setViewportSize(before);
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}

/**
 * Activity's Load more (10 Nov 2026): depth in item rows, never entries. When
 * more exists, the button's bottom sits between the fold + 0.35 and the fold +
 * 0.65 viewports (page top, before any scroll). Read before the steps
 * scroll. Also the "N new" chip: flat (no shadow, no background image), 18
 * tall (NEW_CHIP_HEIGHT), padding-x 7.
 */
export async function assertActivityLoadMoreBand(page: Page, screenName: string): Promise<void> {
  const got = await page.evaluate(() => {
    const btn = document.querySelector('[data-activity-load-more]');
    let y = 0;
    for (let el = btn?.parentElement ?? null; el !== null; el = el.parentElement) {
      y += el.scrollTop;
    }
    const chip = document.querySelector('[data-activity-new-chip]');
    const cs = chip === null ? null : getComputedStyle(chip);
    return {
      bottom: btn === null ? null : btn.getBoundingClientRect().bottom + y + window.scrollY,
      vh: window.innerHeight,
      chip:
        chip === null || cs === null
          ? null
          : {
              height: chip.getBoundingClientRect().height,
              padding: parseFloat(cs.paddingLeft),
              shadow: cs.boxShadow,
              image: cs.backgroundImage,
            },
    };
  });
  const out: string[] = [];
  if (got.bottom === null) out.push('no Load more under a list with more');
  else {
    const lo = got.vh * 1.35;
    const hi = got.vh * 1.65;
    if (got.bottom < lo || got.bottom > hi) {
      out.push(
        `Load more ends at ${Math.round(got.bottom)}, not between the fold + 0.35 (${Math.round(lo)}) and + 0.65 (${Math.round(hi)}) viewports`,
      );
    }
  }
  const want = { h: NEW_CHIP_HEIGHT, px: 7 };
  if (got.chip !== null) {
    if (got.chip.shadow !== 'none') out.push(`the "N new" chip has a shadow (${got.chip.shadow})`);
    if (got.chip.image !== 'none') out.push('the "N new" chip has a background image');
    if (Math.abs(got.chip.height - want.h) > 0.5) {
      out.push(`the "N new" chip is ${got.chip.height} tall, not ${want.h}`);
    }
    if (Math.abs(got.chip.padding - want.px) > 0.1) {
      out.push(`the "N new" chip padding-x is ${got.chip.padding}, not ${want.px}`);
    }
  }
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}

/**
 * Part 6 (locked 9 Nov 2026): Activity previews. The long row's preview is
 * exactly 2 lines ending "… more" on a whole word of its full text (the row
 * link's name holds the full text); the short row's preview is 1 line with
 * no marker. "more" unfolds without leaving the page and becomes "less";
 * "less" folds it back. Leaves the page as it found it (folded).
 */
export async function assertActivityPreviews(
  page: Page,
  screenName: string,
  marks: { long: string; short: string },
): Promise<void> {
  const out: string[] = [];
  const read = (needle: string) =>
    page.evaluate((text) => {
      const row = Array.from(
        document.querySelectorAll('[data-activity-list] [data-list-card]'),
      ).find((el) =>
        (el.querySelector('[data-activity-preview]')?.textContent ?? '').includes(text),
      );
      if (row === undefined) return null;
      const preview = row.querySelector('[data-activity-preview]');
      const rects = preview === null ? [] : Array.from(preview.getClientRects());
      // Lines = distinct tops of the text's own boxes (4px apart or more).
      const tops: number[] = [];
      if (preview !== null) {
        const walk = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 4)) tops.push(r.top);
          }
        }
      }
      return {
        height: row.getBoundingClientRect().height,
        // The row's own content height: its body plus its padding (what the
        // height must settle on once an unfold is done).
        natural: (() => {
          const body = row.querySelector('[data-list-card-body]');
          const cs = getComputedStyle(row);
          return (
            (body?.getBoundingClientRect().height ?? 0) +
            (parseFloat(cs.paddingTop) || 0) +
            (parseFloat(cs.paddingBottom) || 0)
          );
        })(),
        animating: row.getAnimations().length > 0,
        lines: tops.length,
        text: (preview?.textContent ?? '').trim(),
        name: row.querySelector('[data-activity-lead]')?.getAttribute('aria-label') ?? '',
        toggle:
          row
            .querySelector('[data-activity-preview-toggle]')
            ?.getAttribute('data-activity-preview-toggle') ?? null,
        rects: rects.length,
      };
    }, needle);
  const long = await read(marks.long);
  const short = await read(marks.short);
  if (long === null) out.push('no long preview row');
  else {
    if (long.lines !== 2) out.push(`the long preview takes ${long.lines} lines, not 2`);
    if (!long.text.endsWith('… more'))
      out.push(`the long preview ends "${long.text.slice(-12)}", not "… more"`);
    const kept = long.text.slice(0, -'… more'.length);
    if (!long.name.includes(`${kept} `)) out.push('the long preview is not cut at a whole word');
    if (long.toggle !== 'more') out.push('the long row has no "more" toggle');
  }
  if (short === null) out.push('no short preview row');
  else {
    if (short.lines !== 1) out.push(`the short preview takes ${short.lines} lines, not 1`);
    if (short.toggle !== null) out.push('the short preview shows a marker');
  }
  if (long !== null) {
    const url = page.url();
    const toggle = page
      .locator('[data-activity-list] [data-list-card]', { hasText: marks.long })
      .locator('[data-activity-preview-toggle]');
    await toggle.click();
    await expect(toggle)
      .toHaveAttribute('data-activity-preview-toggle', 'less', { timeout: 5_000 })
      .catch(() => undefined);
    await settleRows(page);
    const open = await read(marks.long);
    if (page.url() !== url) out.push('"more" navigated away');
    if (open?.toggle !== 'less') out.push('"more" did not turn into "less"');
    if (open !== null && open.height <= long.height) out.push('"more" did not unfold the row');
    // Once the unfold settles the row is its full content height (+-1).
    if (open !== null && (open.animating || Math.abs(open.height - open.natural) > 1)) {
      out.push(`the unfolded row settled at ${open.height}, not its full height ${open.natural}`);
    }
    if (open?.toggle === 'less') {
      await toggle.click();
      await expect(toggle)
        .toHaveAttribute('data-activity-preview-toggle', 'more', { timeout: 5_000 })
        .catch(() => undefined);
      await settleRows(page);
    }
    const folded = await read(marks.long);
    if (folded?.toggle !== 'more' || Math.abs((folded?.height ?? 0) - long.height) > 1) {
      out.push('"less" did not fold the row back');
    }
  }
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'list-card' as const, message })),
  );
}

/**
 * Part 6 D: one unread count. The Unread chip, Catch up and the Activity tab
 * badge (phone tab bar / laptop Sidebar) show the same server count.
 */
export async function assertActivityCounts(page: Page, screenName: string): Promise<void> {
  const got = await page.evaluate(() => {
    const num = (s: string | null | undefined): number | null => {
      const m = /(\d+)/.exec(s ?? '');
      return m === null ? null : Number(m[1]);
    };
    const chip = Array.from(document.querySelectorAll('button')).find((b) =>
      /^Unread\s*\d/.test((b.textContent ?? '').trim()),
    );
    const shownBadge = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).find((el) => el.getBoundingClientRect().width > 0);
    const badge = shownBadge('[data-activity-tab] [data-count-badge]');
    const side = shownBadge('[data-sidebar-activity] [data-count-badge]');
    return {
      chip: num(chip?.textContent),
      catchUp: num(
        document
          .querySelector('[data-shell="lead"] [data-topbar-catch-up]')
          ?.getAttribute('data-count'),
      ),
      badge: num((badge ?? side)?.textContent),
      side: side === undefined ? null : num(side.textContent),
    };
  });
  const out: string[] = [];
  if (got.chip === null || got.catchUp === null || got.badge === null) {
    out.push(`a count is missing (chip ${got.chip}, Catch up ${got.catchUp}, badge ${got.badge})`);
  } else if (
    got.chip !== got.catchUp ||
    got.catchUp !== got.badge ||
    (got.side !== null && got.side !== got.badge)
  ) {
    out.push(
      `the counts differ: Unread chip ${got.chip}, Catch up ${got.catchUp}, tab badge ${got.badge}`,
    );
  }
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}

/**
 * Every Activity row has finished its unfold (no running animation on any
 * row) and the rows hold still across two animation frames. No fixed sleep.
 */
async function settleRows(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-activity-list] [data-list-card]'),
        );
        const read = (): string => rows.map((row) => row.offsetHeight).join(',');
        const before = read();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(rows.every((row) => row.getAnimations().length === 0) && read() === before),
          ),
        );
      }),
  );
}

/**
 * The list-screen axis (shell/ListScreen, 10 Nov 2026): the six positions a
 * list tab's shell owns, read on the page as it stands. (a) top bar bottom to
 * the chip row, (b) the chip row's left to the first chip, (c) the block above
 * the content (the chip row, or the lead strip when one shows) to the first
 * content (a row, or the section heading that opens the list), (c2) the first
 * REAL ROW's top from what sits right above it (its section heading, else the
 * lead strip, else the chip row): rows are measured, never the content
 * wrapper, (d) the chip row's left to the first row's text, (e) the first
 * line's right-most row content edge to the chip row's right. The chip row
 * spans its column (the page, or the chat list's pane beside a thread on
 * laptop). NaN where the tab has none.
 */
export async function readListScreenAxis(page: Page, screen: string): Promise<ListScreenAxis> {
  const at = await page.evaluate(() => {
    const shown = (el: Element | null | undefined): el is Element =>
      el !== null && el !== undefined && el.getBoundingClientRect().height > 0;
    const main = document.querySelector('main');
    const frame = main?.getBoundingClientRect();
    const left = frame?.x ?? 0;
    const right = frame !== undefined && main !== null ? frame.x + main.clientWidth : innerWidth;
    const bar = Array.from(document.querySelectorAll('header')).find(
      (h) => h.closest('main') === null && shown(h),
    );
    const barBottom = bar?.getBoundingClientRect().bottom ?? frame?.y ?? 0;
    const row = Array.from(
      document.querySelectorAll('main [data-chip-row], main [data-activity-chips]'),
    ).find(shown);
    const chips = row?.getBoundingClientRect();
    // The column the shell lays out: the chip row spans it.
    const colLeft = chips?.x ?? left;
    const colRight = chips?.right ?? right;
    const chip =
      row === undefined
        ? undefined
        : Array.from(row.querySelectorAll('[data-chip-face]')).find(shown);
    // The shell's lead strip (a count line, Activity's Threads | Catch up) sits
    // between the chips and the content: the content's 16 is measured from it.
    const lead = Array.from(document.querySelectorAll('main [data-shell="lead"]')).find(
      (el) =>
        shown(el) && (chips === undefined || el.getBoundingClientRect().y >= chips.bottom - 1),
    );
    const aboveBottom = lead?.getBoundingClientRect().bottom ?? chips?.bottom;
    const below = (el: Element): boolean =>
      shown(el) && (aboveBottom === undefined || el.getBoundingClientRect().y >= aboveBottom - 1);
    const cards = Array.from(document.querySelectorAll('main [data-list-card]')).filter(below);
    const first = cards[0];
    const firstTop = first?.getBoundingClientRect().y;
    const lineRights = cards
      .filter(
        (c) => firstTop !== undefined && Math.abs(c.getBoundingClientRect().y - firstTop) <= 1,
      )
      .map((c) => c.querySelector('[data-list-card-body]')?.getBoundingClientRect().right)
      .filter((n): n is number => n !== undefined);
    const title = first?.querySelector('[data-list-card-title]')?.getBoundingClientRect();
    // The first content: the top-most row or section heading in the shell's
    // content (Plan and Activity open on a heading); else the first row.
    const headings = Array.from(
      document.querySelectorAll('main [data-shell="content"] h2, main [data-shell="content"] h3'),
    ).filter(below);
    const contentTops = [...cards, ...headings].map((el) => el.getBoundingClientRect().y);
    const contentY = contentTops.length > 0 ? Math.min(...contentTops) : firstTop;
    // The first real row's own step: from the heading right above it (the
    // last one that ends at or above it), else from the lead or the chips.
    const headAbove = headings
      .map((h) => h.getBoundingClientRect().bottom)
      .filter((b) => firstTop !== undefined && b <= firstTop + 1);
    const rowFrom = headAbove.length > 0 ? Math.max(...headAbove) : aboveBottom;
    return {
      chipsTop: chips === undefined ? Number.NaN : chips.y - barBottom,
      chipX: chip === undefined ? Number.NaN : chip.getBoundingClientRect().x - colLeft,
      contentTop:
        aboveBottom === undefined || contentY === undefined ? Number.NaN : contentY - aboveBottom,
      rowTop: rowFrom === undefined || firstTop === undefined ? Number.NaN : firstTop - rowFrom,
      textX: title === undefined ? Number.NaN : title.x - colLeft,
      rightInset: lineRights.length === 0 ? Number.NaN : colRight - Math.max(...lineRights),
    };
  });
  return { screen, ...at };
}

/** A list tab on the shell: the six positions equal the SCREEN_* constants, +-1. */
export function assertListScreenAxis(axis: ListScreenAxis, laptop: boolean): void {
  settleFindings(
    `list-screen axis ${axis.screen}`,
    listScreenAxisViolations(axis, listScreenAxisExpected(laptop)).map((message) => ({
      check: 'list-screen' as const,
      message,
    })),
  );
}

/**
 * The report beside the asserts: log each tab's six numbers and the delta
 * from Pipeline under "list-screen axis" in the Visual CI log, and annotate
 * the test. Never fails (assertListScreenAxis does).
 */
export function reportListScreenAxis(project: string, rows: readonly ListScreenAxis[]): void {
  const base = rows[0];
  if (base === undefined) return;
  const text = `list-screen axis (${project}, delta from ${base.screen}):\n${listScreenAxisReport(rows, base)}`;
  test.info().annotations.push({ type: 'list-screen axis', description: text });
  console.log(text);
}

/**
 * Nothing moves when you switch tabs (10 Nov 2026): the top bar's name,
 * search and avatar x, the phone bottom bar's tab and Chat centres and its
 * width, and the filter row's non-chip controls, read on the tab as it stands
 * (at the top, dock at rest). For assertTabFrameStill across the six tabs.
 */
export async function readTabFrame(page: Page, screen: string): Promise<TabFrameAt> {
  const at = await page.evaluate(() => {
    const shown = (el: Element | null): DOMRect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const x = (el: Element | null): number | null => shown(el)?.x ?? null;
    const centre = (el: Element | null): number | null => {
      const r = shown(el);
      return r === null ? null : r.x + r.width / 2;
    };
    const header = document.querySelector('header');
    const search =
      [...(header?.querySelectorAll('button') ?? [])].find(
        (b) =>
          shown(b) !== null &&
          (b.getAttribute('aria-label') === 'Search' ||
            (b.getAttribute('aria-label') === null && /^\s*Search/.test(b.textContent ?? ''))),
      ) ?? null;
    const nav = document.querySelector('nav[aria-label="Primary"]');
    const tabs = [...document.querySelectorAll('nav[aria-label="Primary"] [data-tab-pill] > a')]
      .map((a) => centre(a))
      .filter((c): c is number => c !== null);
    const nonChips = [
      ...document.querySelectorAll(
        '[data-shell="chips"] :is(button, a, input, select, [role="button"])',
      ),
    ]
      .filter((el) => shown(el) !== null)
      .filter((el) => el.querySelector('[data-chip-face]') === null)
      .filter((el) => !el.hasAttribute('data-chip-clear'))
      .map((el) => {
        const text = (el.textContent ?? '').trim();
        return el.getAttribute('aria-label') ?? (text !== '' ? text : el.tagName.toLowerCase());
      });
    return {
      nameX: x(header?.querySelector('[data-topbar-workspace-name]') ?? null),
      searchX: x(search),
      avatarX: x(header?.querySelector('[aria-label="Account menu"]') ?? null),
      tabCentres: tabs,
      chatCentre: centre(document.querySelector('nav[aria-label="Primary"] [data-chat-tab]')),
      barWidth: shown(nav)?.width ?? null,
      nonChips,
    };
  });
  return { screen, ...at };
}

/** Nothing moves when you switch tabs: each tab's frame against the first (+-1). */
export function assertTabFrameStill(name: string, rows: readonly TabFrameAt[]): void {
  settleFindings(
    name,
    tabFrameViolations(rows).map((message) => ({ check: 'topbar' as const, message })),
  );
}
