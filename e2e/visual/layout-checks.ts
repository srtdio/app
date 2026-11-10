import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  alignmentViolations,
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
  type AlignFamily,
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
//     ends on the row's end and covers no time, name or title;
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
            viewportWidth: vw,
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
export type AlignScope = 'chat-thread' | 'catch-up-thread' | 'chat-replies-row';

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
 * - chat-replies-row: every replies row in the main chat: no reply text node,
 *   the last reply's time shown, 8 between photos, count, time and dot, the
 *   row's target at least 44 tall.
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
      const textBox = (el: Element): { left: number; top: number; bottom: number } | null => {
        let left = Infinity;
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
            top = Math.min(top, rect.top);
            bottom = Math.max(bottom, rect.bottom);
          }
        }
        return Number.isFinite(left) ? { left, top, bottom } : null;
      };
      const out: AlignFamily[] = [];
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
 * - the row's left edge is its row's text column: a comment's head
 *   ([data-comment-header]); a chat, plan comment or thread reply message's
 *   body text ([data-msg-body]); a catch-up row's text (its last paragraph);
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
      const comment = row.closest('[data-comment-row]');
      const catchUp = row.closest('[data-catch-up-message]');
      const message = row.closest('li[data-msg-id]');
      const view = row.closest('[data-thread-view], [data-catch-up-thread]');
      const strip = view?.querySelector('[data-thread-strip]') ?? null;
      if (comment !== null) {
        const head = comment.querySelector('[data-comment-header]');
        if (shown(head) && !near(box.left, head.getBoundingClientRect().left)) {
          out.push(
            `${at}: left ${r1(box.left)}, comment column ${r1(head.getBoundingClientRect().left)}`,
          );
        }
        return;
      }
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
  density: string;
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
      density: document.documentElement.dataset.density ?? 'cozy',
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

/** The "N new" chip's height per density (Compact 16 / Cozy 18 / Calm 20). */
const NEW_CHIP_HEIGHT_PX: Readonly<Record<string, number>> = { compact: 16, cozy: 18, calm: 20 };

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
    eq('row height', activity.row.height, plan.row.height);
    eq('picture left', activity.row.pictureLeft, plan.row.pictureLeft);
    eq('picture right', activity.row.pictureRight, plan.row.pictureRight);
    eq('title x', activity.row.titleLeft, plan.row.titleLeft);
    eq('time right edge', activity.row.timeRight, plan.row.timeRight);
  }
  for (const h of activity.rowHeights) {
    if (activity.row !== null && !same(h, activity.row.height)) {
      out.push(`an Activity row is ${r1(h)} tall, not ${r1(activity.row.height)}`);
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
  const want = NEW_CHIP_HEIGHT_PX[activity.density] ?? NEW_CHIP_HEIGHT_PX.cozy ?? 18;
  if (activity.chips.length === 0) out.push('Activity shows no "N new" chip');
  for (const c of activity.chips) {
    if (!same(c.height, want))
      out.push(`"${c.text}" is ${r1(c.height)} tall, not ${want} (${activity.density})`);
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

// Check 15, the top bar part (Activity, 10 Nov 2026): Threads and Catch up are
// ONE box. Same width and height (exactly), radius, padding, border and type,
// in the 0 (outline) and > 0 (filled) states alike; the fixed 112 x 44 box;
// Threads first, 8 to Catch up; no 44 slots beside them; nothing past the
// viewport (the workspace name truncates first).
export const ACTIVITY_PAIR_W_PX = 112;
export const ACTIVITY_PAIR_H_PX = 44;
/** Below sm the pair goes icon + count: one fixed 56 x 44 box each (10 Nov 2026). */
export const ACTIVITY_PAIR_COMPACT_W_PX = 56;
export const ACTIVITY_PAIR_COMPACT_BELOW_PX = 640;
/** The workspace name beside the pair keeps at least this many characters. */
export const ACTIVITY_NAME_MIN_CHARS = 8;
export const ACTIVITY_PAIR_GAP_PX = 8;

interface PairBox {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: string;
  padding: string;
  border: string;
  type: string;
  count: string | null;
}

export async function assertActivityTopbarPair(page: Page, screenName: string): Promise<void> {
  const got = await page.evaluate(() => {
    const read = (sel: string): PairBoxRaw | null => {
      const el = document.querySelector(`header [data-topbar-pair] ${sel}`);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        radius: s.borderTopLeftRadius,
        padding: `${s.paddingLeft} ${s.paddingRight}`,
        border: s.borderTopWidth,
        type: `${s.fontSize} ${s.fontWeight}`,
        count: el.getAttribute('data-count'),
      };
    };
    type PairBoxRaw = {
      x: number;
      y: number;
      width: number;
      height: number;
      radius: string;
      padding: string;
      border: string;
      type: string;
      count: string | null;
    };
    return {
      threads: read('[data-topbar-threads]'),
      catchUp: read('[data-topbar-catch-up]'),
      slots: document.querySelectorAll('header [data-topbar-slot]').length,
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  const out: string[] = [];
  const { threads, catchUp } = got as { threads: PairBox | null; catchUp: PairBox | null };
  if (threads === null || catchUp === null) {
    out.push('no Threads | Catch up pair in the top bar ([data-topbar-pair])');
  } else {
    const label = `Threads (${threads.count}) / Catch up (${catchUp.count})`;
    if (threads.width !== catchUp.width || threads.height !== catchUp.height) {
      out.push(
        `${label}: boxes ${threads.width}x${threads.height} vs ${catchUp.width}x${catchUp.height}, not one size`,
      );
    }
    for (const [name, b] of [
      ['Threads', threads],
      ['Catch up', catchUp],
    ] as const) {
      const wantW =
        got.viewport < ACTIVITY_PAIR_COMPACT_BELOW_PX
          ? ACTIVITY_PAIR_COMPACT_W_PX
          : ACTIVITY_PAIR_W_PX;
      if (Math.abs(b.width - wantW) > 0.01 || Math.abs(b.height - ACTIVITY_PAIR_H_PX) > 0.01) {
        out.push(`${name} is ${b.width}x${b.height}, not the fixed ${wantW}x${ACTIVITY_PAIR_H_PX}`);
      }
      if (b.radius !== '8px') out.push(`${name} radius ${b.radius}, not 8px`);
      if (b.x + b.width > got.viewport + 0.5) out.push(`${name} ends past the viewport`);
    }
    for (const key of ['radius', 'padding', 'border', 'type'] as const) {
      if (threads[key] !== catchUp[key]) {
        out.push(`${label}: ${key} ${threads[key]} vs ${catchUp[key]}, not the same box`);
      }
    }
    const gap = catchUp.x - (threads.x + threads.width);
    if (Math.abs(gap - ACTIVITY_PAIR_GAP_PX) > 0.5) {
      out.push(`Threads to Catch up is ${gap}px, not ${ACTIVITY_PAIR_GAP_PX} (Threads first)`);
    }
    if (threads.y !== catchUp.y) out.push(`${label}: tops ${threads.y} vs ${catchUp.y}`);
  }
  if (got.slots !== 0)
    out.push(`${got.slots} sort / "+" slots beside the pair (Activity has none)`);
  if (got.scrollWidth > got.viewport) {
    out.push(`the page scrolls sideways (${got.scrollWidth} > ${got.viewport})`);
  }
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}

/**
 * Check 15, narrow phones (10 Nov 2026): at 390 and 375 wide, Activity's top
 * bar fits. The workspace name shows at least its first 8 characters (then
 * the ellipsis), Threads and Catch up are the icon + count boxes (56 x 44,
 * one size), nothing overlaps and nothing scrolls sideways. Restores the
 * viewport it found.
 */
export async function assertActivityTopbarNarrow(page: Page, screenName: string): Promise<void> {
  const before = page.viewportSize();
  const out: string[] = [];
  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: before?.height ?? 844 });
    await page.waitForTimeout(100);
    const got = await page.evaluate((minChars) => {
      const name = document.querySelector('header [data-topbar-workspace-name]');
      const boxes = ['[data-topbar-threads]', '[data-topbar-catch-up]'].map((sel) => {
        const el = document.querySelector(`header ${sel}`);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      });
      let shownChars = 0;
      let nameRight = 0;
      if (name !== null && name.firstChild !== null) {
        const box = name.getBoundingClientRect();
        nameRight = box.right;
        const text = name.firstChild;
        const total = (text.textContent ?? '').length;
        const range = document.createRange();
        for (let i = 1; i <= total; i += 1) {
          range.setStart(text, 0);
          range.setEnd(text, i);
          if (range.getBoundingClientRect().right <= box.right + 0.5) shownChars = i;
          else break;
        }
        if (total < minChars) shownChars = Math.max(shownChars, minChars);
      }
      return {
        hasName: name !== null,
        shownChars,
        nameRight,
        boxes,
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    }, ACTIVITY_NAME_MIN_CHARS);
    const at = `${width} wide`;
    if (!got.hasName) out.push(`${at}: no workspace name ([data-topbar-workspace-name])`);
    else if (got.shownChars < ACTIVITY_NAME_MIN_CHARS) {
      out.push(
        `${at}: the workspace name shows ${got.shownChars} characters, under ${ACTIVITY_NAME_MIN_CHARS}`,
      );
    }
    const [threads, catchUp] = got.boxes;
    if (threads == null || catchUp == null) out.push(`${at}: no Threads | Catch up pair`);
    else {
      for (const b of [threads, catchUp]) {
        if (
          Math.abs(b.width - ACTIVITY_PAIR_COMPACT_W_PX) > 0.01 ||
          Math.abs(b.height - ACTIVITY_PAIR_H_PX) > 0.01
        ) {
          out.push(
            `${at}: a pair box is ${b.width}x${b.height}, not ${ACTIVITY_PAIR_COMPACT_W_PX}x${ACTIVITY_PAIR_H_PX}`,
          );
        }
      }
      if (got.nameRight > threads.left + 0.5) out.push(`${at}: the name runs under Threads`);
    }
    if (got.scrollWidth > got.viewport) out.push(`${at}: the page scrolls sideways`);
  }
  if (before !== null) await page.setViewportSize(before);
  settleFindings(
    screenName,
    out.map((message) => ({ check: 'topbar' as const, message })),
  );
}
