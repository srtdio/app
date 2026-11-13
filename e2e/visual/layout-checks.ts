import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  NEW_CHIP_HEIGHT,
  ROW_HEIGHT,
  ROW_HEIGHT_PHONE,
  ROW_INSET,
  ROW_PICTURE,
  ROW_PICTURE_PHONE,
} from '../../src/components/ui/layout';
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
  replyBoxRestViolations,
  type ReplyBoxRestGeom,
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
//     16 inside the bled row (x) and ROW_INSET (12) from its top (y); under 768
//     the row is ROW_HEIGHT_PHONE (60), the picture the 36 square 8 from the
//     row top (the title line's top), the text at screen x 64; 12 to the
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
//  19 reply boxes at rest (assertReplyBoxAtRest, 12 Nov 2026, every screen
//     after its shot): chat's Composer unfocused, its field's first line on
//     the writing frame's and the "+" key's centre; on a phone a docked box
//     16 from both screen edges with its text on the 64 column.
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
        solid: card.hasAttribute('data-list-card-solid'),
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

  // List rows (ROW_HEIGHT 72; ROW_HEIGHT_PHONE 60 under 768) and chips (CHIP_FACE 36): one size per width.
  for (const message of listCardViolations(raw.listCards, raw.viewportWidth < 768)) {
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
 * 13 Nov 2026: the open comment thread (phone and laptop) opens at its first
 * message; scrolled to the end, its last row clears the floating reply box by 12.
 */
export async function assertCommentThreadEnd(page: Page, screenName: string): Promise<void> {
  const geom = await page.evaluate((): CommentThreadEndGeom => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-thread-view] [data-comment-thread]',
    );
    const last = scroller?.querySelector('ul')?.lastElementChild ?? null;
    const box =
      document.querySelector('[data-comment-thread-composer] form') ??
      document.querySelector('[data-comment-thread-composer]');
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

/** What assertThreadSitsOnBox reads off the open thread view. */
export interface ThreadOnBoxGeom {
  /** The bottom-anchored scroller is there. */
  anchored: boolean;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollerTop: number;
  /** The scroller's and the list's own bottom / top padding plus the edge rows' margins. */
  wantBottomGap: number;
  /**
   * How far the scroll area runs past the list's own padding: a laptop row's
   * hover key (44 tall, out of flow) hangs under the last row, and the end the
   * thread pins to includes it. 0 on touch.
   */
  hangOverflow: number;
  wantTopGap: number;
  firstRowTop: number | null;
  lastRowBottom: number | null;
  /**
   * The scroller's bottom edge: what the list sits on. The reply box (or the
   * placeholders, then the box) starts there; the step between that edge and
   * the box's field is the box's own and is not this check's.
   */
  floorTop: number | null;
  /** The reply box is there, at or under the scroller's bottom edge. */
  boxTop: number | null;
  /** Placeholders: the last one's bottom edge to their block's bottom edge, and the gap the last reply keeps. */
  fillGap: number | null;
  fillWantGap: number | null;
  /** The reply box's input holds focus. */
  boxFocused: boolean;
}

/**
 * 13 Nov 2026 (Slack), pure: a thread opens at its first message. The scroller
 * is at the top, the first row starts its own top gap (+-1) under the
 * scroller's top, a short thread keeps its spare room under its last row (never
 * above the main message), the reply box never overlaps the thread, on touch
 * the reply box is not focused after open, and the last placeholder ends where
 * the last reply will.
 */
export function threadOnBoxViolations(geom: ThreadOnBoxGeom, touch: boolean): string[] {
  const out: string[] = [];
  if (!geom.anchored) return ['no top-opened thread scroller ([data-thread-open-top])'];
  if (geom.lastRowBottom === null || geom.firstRowTop === null || geom.floorTop === null) {
    return ['no thread rows or no reply box'];
  }
  if (geom.boxTop === null) out.push('no reply box under the thread');
  else if (geom.boxTop < geom.floorTop - 1) out.push('the reply box overlaps the thread');
  if (geom.scrollTop > 1) {
    out.push(`the thread opened ${Math.round(geom.scrollTop)}px down, not at its first message`);
  }
  const top = geom.firstRowTop - geom.scrollerTop - geom.wantTopGap;
  if (Math.abs(top) > 1) {
    out.push(`the main message starts ${Math.round(top)}px under the thread's top (want 0)`);
  }
  if (touch && geom.boxFocused) out.push('the reply box is focused after open on touch');
  if (geom.fillGap !== null && geom.fillWantGap !== null) {
    if (Math.abs(geom.fillGap - geom.fillWantGap) > 1) {
      out.push(
        `the last placeholder ends ${Math.round(geom.fillGap)}px above the reply box (the last reply ends ${Math.round(geom.fillWantGap)})`,
      );
    }
  }
  return out;
}

/**
 * 13 Nov 2026: the open thread view (chat and comment threads, phone and
 * laptop, light and dark) opens at its first message (threadOnBoxViolations).
 * Measured, never scrolled by the check.
 */
export async function assertThreadSitsOnBox(
  page: Page,
  screenName: string,
  touch: boolean,
): Promise<void> {
  const geom = await page.evaluate((): ThreadOnBoxGeom => {
    const view = document.querySelector('[data-thread-view]');
    const scroller = view?.querySelector<HTMLElement>('[data-thread-open-top]') ?? null;
    const list =
      scroller === null || scroller.matches('ul') ? scroller : scroller.querySelector('ul');
    const px = (value: string): number => Number.parseFloat(value) || 0;
    const rows = [...(list?.children ?? [])].filter((el) => el.getBoundingClientRect().height > 0);
    const first = rows[0] ?? null;
    const last = rows[rows.length - 1] ?? null;
    const pads = (edge: 'Top' | 'Bottom', row: Element | null): number => {
      if (scroller === null || list === null) return 0;
      const own = px(getComputedStyle(scroller)[`padding${edge}`]);
      const inner = list === scroller ? 0 : px(getComputedStyle(list)[`padding${edge}`]);
      const margin = row !== null ? px(getComputedStyle(row)[`margin${edge}`]) : 0;
      return own + inner + margin;
    };
    const box =
      view?.querySelector('[data-comment-thread-composer] form') ??
      view?.querySelector('form') ??
      null;
    const fill = view?.querySelector('[data-thread-fill]') ?? null;
    const fillRows = fill !== null ? [...fill.querySelectorAll('[data-thread-fill-row]')] : [];
    const lastFill = fillRows[fillRows.length - 1] ?? null;
    const boxTop = box !== null ? box.getBoundingClientRect().top : null;
    const ownBottomGap = pads('Bottom', last);
    // A descendant of the last row that hangs under it (the laptop hover key)
    // is part of the scroll area, so the end sits that far under the row.
    const lastBottom = last !== null ? last.getBoundingClientRect().bottom : 0;
    const hang =
      last !== null
        ? Math.max(
            0,
            ...[...last.querySelectorAll('*')].map(
              (el) => el.getBoundingClientRect().bottom - lastBottom,
            ),
          )
        : 0;
    const wantBottomGap = Math.max(ownBottomGap, hang);
    const active = document.activeElement;
    return {
      anchored: scroller !== null,
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
      scrollerTop: scroller?.getBoundingClientRect().top ?? 0,
      wantBottomGap,
      hangOverflow: wantBottomGap - ownBottomGap,
      wantTopGap: pads('Top', first),
      firstRowTop: first !== null ? first.getBoundingClientRect().top : null,
      lastRowBottom: last !== null ? last.getBoundingClientRect().bottom : null,
      floorTop: scroller !== null ? scroller.getBoundingClientRect().bottom : null,
      boxTop,
      fillGap:
        lastFill !== null && fill !== null
          ? fill.getBoundingClientRect().bottom - lastFill.getBoundingClientRect().bottom
          : null,
      fillWantGap: lastFill !== null && scroller !== null ? wantBottomGap : null,
      boxFocused: active !== null && box !== null && box.contains(active),
    };
  });
  settleFindings(
    screenName,
    threadOnBoxViolations(geom, touch).map((message) => ({
      check: 'thread-end' as const,
      message: `opens at top: ${message}`,
    })),
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

/** The message / comment menu's entries, top to bottom (MessageActionMenu, Thread polish 2). */
const MENU_ITEM_ORDER = [
  'reply',
  'forward',
  'add-task',
  'mark-unread',
  'edit',
  'copy-link',
  'copy',
  'select-text',
  'save-notes',
  'reply-privately',
  'transcribe',
  'remove-file',
  'delete',
] as const;

/**
 * Thread polish 2: the open message / comment menu (phone sheet, laptop
 * popover) is one page in the locked order. No "More actions" row or second
 * page; the entries follow MENU_ITEM_ORDER, Delete last; a divider
 * ([data-menu-divider]) never opens or ends the list, never doubles, and has
 * a tile row or a row on each side; every row's label starts on one x; the
 * menu and the box that holds it sit inside the window.
 */
export async function assertMenuOrder(page: Page, screenName: string): Promise<void> {
  const messages = await page.evaluate(
    (order: string[]): string[] => {
      const out: string[] = [];
      const shown = (el: Element | null): el is Element => {
        if (el === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const r1 = (n: number): number => Math.round(n * 10) / 10;
      const menu =
        Array.from(document.querySelectorAll('[role="menu"][aria-label="Message actions"]')).find(
          shown,
        ) ?? null;
      if (menu === null) return ['no message menu shown'];
      if (menu.querySelector('[data-menu-item="more-actions"]') !== null) {
        out.push('a "More actions" row shows (one page, no such row)');
      }
      if (document.querySelector('[data-menu-page]') !== null) {
        out.push('a second menu page shows ([data-menu-page])');
      }
      const list = menu.querySelector('[data-menu-list]');
      if (!shown(list)) return [...out, 'no [data-menu-list] in the menu'];
      // Order: the keys as drawn are a run of MENU_ITEM_ORDER; Delete is last.
      const keys = Array.from(list.querySelectorAll('[data-menu-item]'))
        .filter(shown)
        .map((el) => el.getAttribute('data-menu-item') ?? '');
      const at = keys.map((k) => order.indexOf(k));
      keys.forEach((k, i) => {
        if ((at[i] ?? -1) < 0) out.push(`unknown menu entry "${k}"`);
        else if (i > 0 && (at[i] ?? 0) <= (at[i - 1] ?? -1)) {
          out.push(`"${k}" sits after "${keys[i - 1] ?? ''}" (order: ${order.join(', ')})`);
        }
      });
      if (keys.includes('delete') && keys[keys.length - 1] !== 'delete') {
        out.push(`Delete is not the last entry (last: "${keys[keys.length - 1] ?? ''}")`);
      }
      // Dividers: only between two blocks (the tile row, or a row), never doubled.
      const kinds = Array.from(list.children)
        .filter(shown)
        .map((el) => (el.hasAttribute('data-menu-divider') ? 'divider' : 'block'));
      kinds.forEach((kind, i) => {
        if (kind !== 'divider') return;
        if (i === 0) out.push('a divider is the first thing in the list');
        else if (kinds[i - 1] === 'divider')
          out.push(`two dividers in a row (children ${i}, ${i + 1})`);
        if (i === kinds.length - 1) out.push('a divider is the last thing in the list');
      });
      // One text column: every row's label (the span after its icon) starts on one x.
      const lefts = Array.from(list.querySelectorAll('[data-menu-item]:not([data-menu-tile])'))
        .filter(shown)
        .flatMap((row) => {
          const label = row.querySelector('[data-menu-icon]')?.nextElementSibling ?? null;
          return shown(label)
            ? [
                {
                  key: row.getAttribute('data-menu-item') ?? '',
                  x: label.getBoundingClientRect().left,
                },
              ]
            : [];
        });
      const x0 = lefts[0]?.x;
      for (const l of lefts) {
        if (x0 !== undefined && Math.abs(l.x - x0) > 1) {
          out.push(`"${l.key}" label x ${r1(l.x)}, the first row's ${r1(x0)}`);
        }
      }
      // Inside the window: the menu and the box that holds it (popover or sheet body).
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const boxes: Array<[string, Element | null]> = [
        ['menu', menu],
        ['menu box', menu.parentElement],
      ];
      for (const [label, el] of boxes) {
        if (!shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
          out.push(
            `${label} runs outside the window: ${r1(r.left)},${r1(r.top)} to ${r1(r.right)},${r1(r.bottom)} in ${vw}x${vh}`,
          );
        }
      }
      return out;
    },
    [...MENU_ITEM_ORDER],
  );
  settleFindings(
    screenName,
    messages.map((message) => ({ check: 'alignment' as const, message: `menu: ${message}` })),
  );
}

/** Reads the laptop thread panel against the post page as painted (assertThreadPanelClear). */
async function threadPanelFindings(page: Page): Promise<string[]> {
  return page.evaluate(async (): Promise<string[]> => {
    // The panel re-measures on resize: read after the next two frames.
    await new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    });
    const out: string[] = [];
    const shown = (el: Element | null): el is Element => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const panel = document.querySelector('[data-side-panel][data-side-panel-fill]');
    if (!shown(panel)) return ['no filling thread panel shown ([data-side-panel-fill])'];
    const p = panel.getBoundingClientRect();
    // The panel's own "<" and title are on top at their centres (nothing covers them).
    const bar = panel.querySelector('[data-header-bar]');
    const parts: Array<[string, Element | null]> = [
      ['panel back "<"', bar?.querySelector('button') ?? null],
      ['panel title', bar?.querySelector('[data-thread-view-title]') ?? null],
    ];
    for (const [label, el] of parts) {
      if (!shown(el)) {
        out.push(`${label} is not shown`);
        continue;
      }
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const own = top !== null && (el.contains(top) || (top.contains(el) && panel.contains(top)));
      if (!own) {
        const what = top === null ? 'nothing' : `<${top.tagName.toLowerCase()}>`;
        out.push(`${label} is covered at its centre by ${what} outside the panel`);
      }
    }
    // The post's pinned bar ends on the panel's left edge.
    const postBar =
      Array.from(document.querySelectorAll('header[data-header-bar][data-header-pinned]')).find(
        (el) => !panel.contains(el) && shown(el),
      ) ?? null;
    if (postBar === null) out.push('no pinned post bar outside the panel');
    else {
      const right = postBar.getBoundingClientRect().right;
      if (Math.abs(right - p.left) > 1) {
        out.push(`post bar right ${r1(right)}, panel left ${r1(p.left)} (want equal)`);
      }
    }
    // The side column is hidden whole; only the panel shows through.
    const side = document.querySelector('[data-post-side]');
    if (side === null) out.push('no [data-post-side] column');
    else {
      if (getComputedStyle(side).visibility !== 'hidden') {
        out.push('[data-post-side] is visible under the thread panel');
      }
      const seen = Array.from(side.querySelectorAll('*')).filter(
        (el) => !panel.contains(el) && getComputedStyle(el).visibility !== 'hidden',
      );
      const first = seen[0];
      if (first !== undefined) {
        const hook = Array.from(first.attributes).find((a) => a.name.startsWith('data-'));
        out.push(
          `${seen.length} parts of the side column are visible beside the panel (first: <${first.tagName.toLowerCase()}${hook !== undefined ? ` ${hook.name}` : ''}>)`,
        );
      }
    }
    return out;
  });
}

/**
 * Thread polish 2, laptop: with a comment thread filling beside the post, the
 * panel's own "<" and title are the top element at their centres, the post's
 * pinned bar ends on the panel's left edge (+-1), and the side column under
 * the panel is hidden whole ([data-post-side] and everything in it outside
 * the panel). Measured at the suite's width and again at 1440 (the viewport
 * is put back). The post column's width open vs closed is the spec's
 * assertPostColumnStill, run after this (it closes the thread).
 */
export async function assertThreadPanelClear(page: Page, screenName: string): Promise<void> {
  const before = page.viewportSize();
  if (before === null || before.width < 768) return;
  const messages = (await threadPanelFindings(page)).map((m) => `${before.width}: ${m}`);
  await page.setViewportSize({ width: 1440, height: before.height });
  messages.push(...(await threadPanelFindings(page)).map((m) => `1440: ${m}`));
  await page.setViewportSize(before);
  settleFindings(
    screenName,
    messages.map((message) => ({ check: 'thread-fill' as const, message: `panel: ${message}` })),
  );
}

/**
 * Thread polish 2: in a thread view (chat's and a post / brief comment's) the
 * main message always carries the add-reaction key: exactly one shown
 * [data-reaction-add] on the root row; a reply's [data-reaction-chips] row
 * shows only with a reaction in it. Phone (EXACT +-1): the root's reaction
 * row (the key alone, or the chips with the key) starts 8 under the root's
 * message ([data-bubble]) and ends 12 over the replies bar
 * ([data-thread-separator]). Phone (12 Nov 2026, EXACT +-1): the root is a
 * normal head row, never the stacked head ([data-thread-root-head] is laptop
 * only): its photo 36 x 36 at x16, its name ([data-sender-name]), its text
 * and its reaction row on the family's 64 text column.
 */
export async function assertRootReactionKey(page: Page, screenName: string): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 0) < 768;
  const messages = await page.evaluate((measure: boolean): string[] => {
    const out: string[] = [];
    const shown = (el: Element | null): el is Element => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const view = Array.from(document.querySelectorAll('[data-thread-view]')).find(shown) ?? null;
    if (view === null) return ['no thread view shown'];
    const rows = Array.from(view.querySelectorAll('li[data-msg-id]')).filter(shown);
    // The root: li[data-thread-root]; a view without the hook leads with it.
    const root = rows.find((row) => row.hasAttribute('data-thread-root')) ?? rows[0];
    if (root === undefined) return ['no root row in the thread view ([data-thread-root])'];
    const keys = Array.from(root.querySelectorAll('[data-reaction-add]')).filter(shown);
    if (keys.length !== 1) out.push(`${keys.length} add-reaction keys on the root, want 1`);
    rows.forEach((row, i) => {
      if (row === root) return;
      const chips = row.querySelector('[data-reaction-chips]');
      if (shown(chips) && chips.querySelector('[data-reaction-chip]') === null) {
        out.push(`reply row ${i} shows a reaction row with no reaction in it`);
      }
    });
    if (!measure) return out;
    // Phone (13 Nov 2026, Slack): the stacked head (36 photo, name over time on
    // 64), the text and its reaction row full width on 16.
    const x0 = view.getBoundingClientRect().left;
    const textLeft = (el: Element | null): number | null => {
      if (!shown(el)) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lefts = Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => r.left);
      return lefts.length > 0 ? Math.min(...lefts) : null;
    };
    const col = (label: string, x: number | null, want: number): void => {
      if (x === null) out.push(`no root ${label} to measure`);
      else if (Math.abs(x - x0 - want) > 1) out.push(`root ${label} x ${r1(x - x0)}, want ${want}`);
    };
    if (root.querySelector('[data-thread-root-head]') === null) {
      out.push('the root does not draw the stacked head ([data-thread-root-head]) on a phone');
    }
    const photo = root.querySelector('[data-avatar-role]');
    if (!shown(photo)) out.push('no root photo');
    else {
      const p = photo.getBoundingClientRect();
      col('photo', p.left, 16);
      if (Math.abs(p.width - 36) > 1 || Math.abs(p.height - 36) > 1) {
        out.push(`root photo ${r1(p.width)}x${r1(p.height)}, want 36 square`);
      }
    }
    col('name', textLeft(root.querySelector('[data-sender-name]')), 64);
    const body = root.querySelector('[data-msg-body]');
    if ((body?.textContent ?? '').trim() !== '') col('text', textLeft(body), 16);
    const chips = root.querySelector('[data-reaction-chips]');
    const bubble = root.querySelector('[data-bubble]');
    const strip = view.querySelector('[data-thread-separator]');
    if (!shown(chips)) return [...out, 'no reaction row on the root'];
    const c = chips.getBoundingClientRect();
    // No reactions yet: the key is the row, so measure the key itself.
    const key = keys[0];
    const lone = chips.querySelector('[data-reaction-chip]') === null;
    const row = lone && key !== undefined ? key.getBoundingClientRect() : c;
    const top = row.top;
    const bottom = row.bottom;
    col('reaction row', row.left, 16);
    if (!shown(bubble)) out.push('no root message to measure from ([data-bubble])');
    else {
      const gap = top - bubble.getBoundingClientRect().bottom;
      if (Math.abs(gap - 8) > 1) out.push(`root message to its reaction row ${r1(gap)}, want 8`);
    }
    if (!shown(strip)) out.push('no replies bar ([data-thread-separator])');
    else {
      const gap = strip.getBoundingClientRect().top - bottom;
      if (Math.abs(gap - 12) > 1)
        out.push(`root reaction row to the replies bar ${r1(gap)}, want 12`);
    }
    return out;
  }, phone);
  settleFindings(
    screenName,
    messages.map((message) => ({
      check: 'alignment' as const,
      message: `thread root reactions: ${message}`,
    })),
  );
}

/**
 * Thread polish 2: a post / brief comment thread's replies bar carries three
 * keys on the root, in order: Add to Tasks, Forward, More
 * ([data-thread-root-action] tasks, forward, more).
 */
export async function assertThreadBarKeys(page: Page, screenName: string): Promise<void> {
  const keys = await page
    .locator('[data-thread-view] [data-thread-separator] [data-thread-root-action]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-thread-root-action') ?? ''));
  expect
    .soft(keys, `${screenName}: the replies bar's keys, in order`)
    .toEqual(['tasks', 'forward', 'more']);
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

/** How long check 19 waits for an unfocused box to settle from the card back to the pill. */
const REPLY_BOX_SETTLE_MS = 1_000;

/** What assertReplyBoxAtRest reads: the boxes at rest, and how many reply boxes show at all. */
interface ReplyBoxRead {
  boxes: ReplyBoxRestGeom[];
  shown: number;
}

/**
 * Check 19 (12 Nov 2026): every reply box on the screen (chat's Composer: a
 * form holding textarea[aria-label="Message"], in chat, chat threads, post
 * and brief comments and their threads, Plan item and Bank idea comments and
 * their threads), measured at rest: unfocused, the pill or the line (never the
 * open card, the phone editor, a recording or an open + tray), its field on
 * one line (replyBoxRestViolations). A box still settling from the card to
 * the pill after the blur is waited for (at most REPLY_BOX_SETTLE_MS).
 * Phone edges and the text column are judged on a docked box only: the post
 * and brief comment box ([data-comments-composer]) sits in the page column
 * under the 16 gutter, so it answers to (a) alone. `required`: the screen
 * must show a reply box (focused or not).
 */
export async function assertReplyBoxAtRest(
  page: Page,
  screenName: string,
  required: boolean,
): Promise<void> {
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('form textarea[aria-label="Message"]')).every(
          (field) => {
            const box = field.closest('[data-writing-box]');
            const form = field.closest('form');
            const active = document.activeElement;
            const focused = active !== null && form !== null && form.contains(active);
            return box === null || focused || box.getAttribute('data-shape') !== 'card';
          },
        ),
      undefined,
      { timeout: REPLY_BOX_SETTLE_MS },
    )
    .catch(() => undefined);
  const read = await page.evaluate((): ReplyBoxRead => {
    const toBox = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const px = (v: string): number => Number.parseFloat(v) || 0;
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const lineHeight = (s: CSSStyleDeclaration): number => {
      const size = px(s.fontSize);
      const n = Number.parseFloat(s.lineHeight);
      if (s.lineHeight.endsWith('px') && Number.isFinite(n)) return n;
      if (/^[\d.]+$/.test(s.lineHeight) && Number.isFinite(n)) return n * size;
      return size * 1.2;
    };
    const SURFACES = [
      '[data-comment-thread-composer]',
      '[data-plan-comments-composer]',
      '[data-comments-composer]',
      '[data-thread-view]',
    ];
    const out: ReplyBoxRead = { boxes: [], shown: 0 };
    const vw = window.innerWidth;
    const fields = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('form textarea[aria-label="Message"]'),
    );
    for (const field of fields) {
      const form = field.closest('form');
      const frame = field.closest('[data-writing-frame]');
      const box = field.closest('[data-writing-box]');
      if (form === null || frame === null || box === null) continue;
      if (!visible(frame) || !visible(field)) continue;
      out.shown += 1;
      // At rest only: the pill or the line, unfocused, nothing open over the field.
      const shape = box.getAttribute('data-shape');
      if (shape !== 'pill' && shape !== 'line') continue;
      if (box.hasAttribute('data-expanded')) continue;
      const active = document.activeElement;
      if (active !== null && active !== document.body && form.contains(active)) continue;
      if (Array.from(frame.querySelectorAll('[data-tray]')).some(visible)) continue;
      const s = getComputedStyle(field);
      const lh = lineHeight(s);
      const padTop = px(s.paddingTop);
      const lines = Math.round((field.scrollHeight - padTop - px(s.paddingBottom)) / lh);
      if (lines > 1) continue;
      const f = field.getBoundingClientRect();
      const wrap = field.closest('[data-writing-field]');
      const plus =
        Array.from(frame.querySelectorAll('[data-plus]')).find(visible) ??
        Array.from(frame.querySelectorAll('button')).find(
          (b) =>
            visible(b) &&
            wrap !== null &&
            !wrap.contains(b) &&
            (b.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        ) ??
        null;
      const surface = SURFACES.find((sel) => form.closest(sel) !== null) ?? 'chat';
      out.boxes.push({
        label: `reply box (${surface}, ${shape})`,
        viewportWidth: vw,
        frame: toBox(frame.getBoundingClientRect()),
        lineCentreY: f.top + px(s.borderTopWidth) + padTop + lh / 2,
        textStartX: f.left + px(s.borderLeftWidth) + px(s.paddingLeft),
        plus: plus !== null ? toBox(plus.getBoundingClientRect()) : null,
        docked: form.closest('[data-comments-composer]') === null,
      });
    }
    return out;
  });
  const violations: LayoutViolation[] = replyBoxRestViolations(read.boxes).map((message) => ({
    check: 'reply-box' as const,
    message,
  }));
  if (required && read.shown === 0) {
    violations.push({
      check: 'reply-box',
      message: 'no reply box (form textarea[aria-label="Message"]) on a reply box screen',
    });
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
 *     differs from the page tone it sits on ([data-catch-up-box]);
 *   e the tip ([data-catch-up-tip], 12 Nov 2026) is a plain row: a 1px top
 *     hairline only (no other border, no radius), its top on the scroll
 *     body's end ([data-catch-up-body], +-1), its words
 *     ([data-catch-up-tip-text]) on the row photos' x and 17px under 768,
 *     "Got it" ([data-catch-up-tip-dismiss]) at least 44 tall;
 *   f no card surface (.catch-up-card) carries a shadow, light or dark.
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

      // (e) the tip: a plain row under the list's end, its words on the photos' x.
      const r1 = (n: number): number => Math.round(n * 10) / 10;
      // (A held swipe leans the card: its boxes are measured at rest only.)
      const tips = leaning ? [] : Array.from(root.querySelectorAll('[data-catch-up-tip]'));
      for (const tip of tips.filter(shown)) {
        const s = getComputedStyle(tip);
        const t = tip.getBoundingClientRect();
        const edges = [
          s.borderTopWidth,
          s.borderRightWidth,
          s.borderBottomWidth,
          s.borderLeftWidth,
        ];
        if (edges.join(' ') !== '1px 0px 0px 0px') {
          out.push(`tip: border widths ${edges.join(' ')}, want a 1px top hairline only`);
        }
        const radii = [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ];
        if (radii.some((r) => parseFloat(r) !== 0))
          out.push(`tip: radius ${radii.join(' ')}, want 0`);
        const holder = tip.closest('[data-catch-up-card]') ?? root;
        const list = holder.querySelector('[data-catch-up-body]');
        if (list === null) out.push('tip: no scroll body ([data-catch-up-body]) over it');
        else if (Math.abs(t.top - list.getBoundingClientRect().bottom) > 1) {
          const end = r1(list.getBoundingClientRect().bottom);
          out.push(`tip: top ${r1(t.top)}, not on the list's end ${end}`);
        }
        const words = tip.querySelector('[data-catch-up-tip-text]');
        const photo = Array.from(holder.querySelectorAll('[data-catch-up-photo]')).find(shown);
        if (words === null) out.push('tip: no words ([data-catch-up-tip-text])');
        else {
          const range = document.createRange();
          range.selectNodeContents(words);
          const left = Math.min(...Array.from(range.getClientRects()).map((r) => r.left));
          const want = photo?.getBoundingClientRect().left;
          if (want === undefined) out.push('tip: no row photo ([data-catch-up-photo]) to align to');
          else if (Math.abs(left - want) > 1) {
            out.push(`tip: words x ${r1(left)}, not on the photos' x ${r1(want)}`);
          }
          const size = getComputedStyle(words).fontSize;
          if (window.innerWidth < 768 && size !== '17px') out.push(`tip: words ${size}, want 17px`);
        }
        const key = tip.querySelector('[data-catch-up-tip-dismiss]');
        const keyHeight = key !== null ? hitBox(key).height : 0;
        if (keyHeight < px.hit - 0.5) out.push(`tip: "Got it" ${r1(keyHeight)} tall, want 44+`);
      }

      // (f) the card surface carries no shadow (dark: it fell on the keys under the card).
      for (const surface of Array.from(root.querySelectorAll('.catch-up-card')).filter(shown)) {
        const shadow = getComputedStyle(surface).boxShadow;
        if (shadow !== 'none') out.push(`${label(surface)}: box-shadow ${shadow}, want none`);
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
 *   strip label on the 16 gutter; 12 Nov 2026: a chat-thread root under 768
 *   is a head row, its 36 photo at x16, its name and text at x64), its last
 *   line 12 over the strip's top
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
          else if (window.innerWidth >= 768) {
            column.textLefts.push({
              label: 'caption header name',
              x: shared ? h.left : h.left - c.left,
            });
          } else {
            // Under 768 the comments sit on the message family's column (16 +
            // 36 photo + 12 = 64, 11 Nov 2026); the caption header's name is
            // on it too: its 32 photo + 16 (48 from the block's left, 12 Nov 2026).
            column.gaps.push({ label: 'caption header name x', gap: h.left - c.left, equals: 48 });
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
          // Message family (11 Nov 2026): a reply's text column is 16 + photo
          // + 12: 64 under 768 (36 photo), 60 from 768 (32 photo). The block's
          // header, more and buttons sit on that same column (12 Nov 2026:
          // 64 under 768 too, ThreadsListScreen THREADS_TEXT_INSET).
          const msgCol = window.innerWidth >= 768 ? 60 : 64;
          const at = (label: string, x: number | null, want = msgCol): void => {
            if (x === null) f.gaps.push({ label: `no ${label}`, gap: -1, min: 0 });
            else f.gaps.push({ label: `${label} x`, gap: x - b.left, equals: want });
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
              if (shown(name)) at(`message ${i + 1} name`, textBox(name)?.left ?? null, msgCol);
              const body = row.querySelector('[data-msg-body]');
              if (shown(body)) at(`message ${i + 1} text`, textBox(body)?.left ?? null, msgCol);
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
      // label at x16, 8 to the first reply's name, replies' text at x64 phone / x60 laptop, 16
      // between replies, the last key's glyph on the content edge (374 phone).
      const catchUp = which === 'catch-up-thread';
      // Message family (11 Nov 2026): a reply's text column is 16 + photo + 12:
      // 64 under 768 (36 photo), 60 from 768 (32 photo).
      const replyCol = window.innerWidth >= 768 ? 60 : 64;
      // 12 Nov 2026: under 768 a chat thread's root is a normal head row.
      const headRoot = !catchUp && window.innerWidth < 768;
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
          // 13 Nov 2026: every thread's root photo, catch up's too: 36 phone, 40 laptop.
          f.gaps.push({
            label: 'root photo size',
            gap: p.width,
            equals: window.innerWidth < 768 ? 36 : 40,
          });
        } else f.gaps.push({ label: 'no root photo', gap: -1, min: 0 });
        const text = textOf(root);
        const t = text !== null && shown(text) ? textBox(text) : null;
        if (t !== null) at('root text', t.left, 16);
        else f.gaps.push({ label: 'no root text', gap: -1, min: 0 });
        const rootName = headRoot ? root.querySelector('[data-sender-name]') : null;
        const n = shown(rootName) ? textBox(rootName) : null;
        if (n !== null) at('root name', n.left, replyCol);
        else if (headRoot) f.gaps.push({ label: 'no root name', gap: -1, min: 0 });
        // Thread polish 2: a chat thread's root carries its reaction row (the
        // add key at least), so that row is the last line over the strip.
        const chips = catchUp ? null : root.querySelector('[data-reaction-chips]');
        const last = shown(chips) ? chips : lastOf(root);
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
      // Thread polish 2: the keys read Add to Tasks, Forward, More, in that order.
      const keyOrder = ['tasks', 'forward', 'more'];
      const keyNames = keys.map((k) => k.getAttribute('data-thread-root-action') ?? '');
      const keyAt = keyNames.map((k) => keyOrder.indexOf(k));
      if (keyAt.some((n, i) => n < 0 || (i > 0 && n <= (keyAt[i - 1] ?? -1)))) {
        f.gaps.push({
          label: `strip keys read ${keyNames.join(', ')}, want tasks, forward, more`,
          gap: -1,
          min: 0,
        });
      }
      const glyph = keys.pop()?.querySelector('svg') ?? null;
      if (shown(glyph)) {
        f.gaps.push({
          label: 'last key glyph to the strip edge',
          // Under 768 the pull slides the glyph by its ink inset (--ink-r), so
          // the ink, not the glyph box, is 16 from the edge.
          gap:
            s.right -
            glyph.getBoundingClientRect().right +
            (window.innerWidth < 768
              ? parseFloat(getComputedStyle(glyph).getPropertyValue('--ink-r')) || 0
              : 0),
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
        if (t !== null) at(`reply ${i + 1} text`, t.left, replyCol);
        const name = nameOf(r);
        if (shown(name)) {
          const n = textBox(name);
          if (n !== null) at(`reply ${i + 1} name`, n.left, replyCol);
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
 * - in a thread view the root's row sits at x16 (x64 on a chat thread's
 *   phone head row, 12 Nov 2026) and replies' at x60 from the strip's left,
 *   the root's chip row ends 12 over the strip's top hairline,
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
        // Replies sit on the family text column: 64 under 768, 60 from 768.
        const column = window.innerWidth >= 768 ? 60 : 64;
        // A chat thread's root is a head row under 768 (the catch-up thread's stays stacked).
        const headRoot = view?.matches('[data-thread-view]') === true && window.innerWidth < 768;
        const want = isRoot && !headRoot ? 16 : column;
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
  /** The first filter chip's bottom edge (Activity: plus its lead slot's height). */
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
  /** The page width the list was read at (window.innerWidth): under 768 a row is 60, else 72. */
  viewport?: number;
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
    // Activity's solid rows (the shell's lead slot) sit between the chips and
    // the content: the first heading's step is measured from under them.
    const lead = which === 'activity' ? document.querySelector('[data-shell="lead"]') : null;
    const leadHeight = shown(lead) ? rect(lead).height : 0;
    return {
      chipBottom: shown(chip) ? rect(chip).bottom + leadHeight : null,
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
      viewport: window.innerWidth,
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
  // The row height at this width: 60 under 768 (ROW_HEIGHT_PHONE), 72 from it.
  // Plan's row is that height, and a one-line Activity row equals Plan's (below).
  const width = plan.viewport ?? activity.viewport;
  if (width !== undefined) {
    const want = width < 768 ? ROW_HEIGHT_PHONE : ROW_HEIGHT;
    for (const [name, row] of [
      ['Plan', plan.row],
      ['Activity', activity.row],
    ] as const) {
      if (row !== null && !same(row.height, want) && !same(row.height, want + 20)) {
        out.push(`${name}'s first row is ${r1(row.height)} tall, not ${want} (or ${want + 20})`);
      }
    }
    if (plan.row !== null && !same(plan.row.height, want)) {
      out.push(`a Plan row is ${r1(plan.row.height)} tall, not ${want}`);
    }
  }
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

// Check 15, the solid rows (Activity, 11 Nov 2026): Catch up and Threads are
// solid list rows (ui/ListCard solid + count) in ListScreen's lead slot, 12
// under the filter chips: Catch up first, then Threads, each only while its
// count is above 0 (both at 0: no lead slot at all, the content 16 under the
// chips). A row is a list row: 72 tall, the 48 tile (under 768: 60 tall, the
// 36 tile, tile and count pill both on the row's centre), the title 12 after
// it on the list rows' text column, the count pill on the list rows' right
// edge, vertically centred; ink fill, accent-fg text. Phone: the rows run edge to
// edge, stacked and touching. md and up: each row is a cell of the list
// cards' grid (first column, then the second; stacked on a one-column
// tablet), side-by-side cells touching. The seam is each row's ::before: a
// 1px top and left border in the page background. Nothing of them in the top
// bar. Laptop: no Activity in the top bar; the Sidebar's last item is
// Activity, after Chat, filled on /activity, with the count when there is one.

/** Which solid rows a screen shows (a row at count 0 is not in the DOM). */
export interface ActivitySolidRowsWant {
  catchUp: boolean;
  threads: boolean;
}

interface SolidRowGeom {
  key: 'catch-up' | 'threads' | 'other';
  /** The cover button's data-count (NaN when missing). */
  count: number;
  name: string;
  title: string;
  preview: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  titleLeft: number | null;
  picture: { right: number; width: number; height: number; centre: number } | null;
  badge: { right: number; centre: number; tone: string; text: string } | null;
  /** A time, tag or unread dot in the row (a solid row has none). */
  extras: number;
  hover: boolean;
  fill: string;
  ink: string;
  previewInk: string | null;
  seam: { top: string; left: string; topColour: string; leftColour: string };
}

/** One column of the list cards under the rows, as painted. */
interface ListColumnGeom {
  left: number;
  width: number;
  titleLeft: number | null;
  /** A drawn unread dot's right edge, else the row body's. */
  edgeRight: number | null;
}

interface SolidRowsGeom {
  viewport: number;
  scrollWidth: number;
  leads: number;
  leadTop: number | null;
  leadBottom: number | null;
  chipsBottom: number | null;
  content: { top: number; pad: number } | null;
  firstContentTop: number | null;
  rows: SolidRowGeom[];
  /** Solid rows outside the lead slot. */
  stray: number;
  /** The retired pair's hooks still in the DOM. */
  retired: number;
  inTopbar: number;
  pageBg: string;
  accent: string;
  accentFg: string;
  columns: ListColumnGeom[];
  /** The list grid's column tracks and the step from one to the next. */
  tracks: number;
  step: number | null;
  topbarActivity: number;
  side: {
    last: boolean;
    afterChat: boolean;
    active: boolean;
    background: string;
    badge: boolean;
  } | null;
}

async function readActivitySolidRows(page: Page): Promise<SolidRowsGeom> {
  return page.evaluate((): SolidRowsGeom => {
    const shown = (el: Element | null | undefined): el is Element => {
      if (el === null || el === undefined) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const colourOf = (className: string, prop: 'backgroundColor' | 'color'): string => {
      const probe = document.createElement('span');
      probe.className = className;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe)[prop];
      probe.remove();
      return value;
    };
    const clear = (c: string): boolean => c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
    // The page background: the bg token, else what the page itself paints.
    const pageBg =
      [
        colourOf('bg-bg', 'backgroundColor'),
        getComputedStyle(document.body).backgroundColor,
        getComputedStyle(document.documentElement).backgroundColor,
      ].find((c) => !clear(c)) ?? '';
    const leads = Array.from(document.querySelectorAll('[data-shell="lead"]'));
    const lead = leads[0] ?? null;
    const chips = Array.from(
      document.querySelectorAll('main [data-chip-row], main [data-activity-chips]'),
    ).find(shown);
    const content = document.querySelector('main [data-shell="content"]');
    const contentTops = Array.from(
      content?.querySelectorAll('[data-list-card], [data-list-card-box], h2, h3') ?? [],
    )
      .filter(shown)
      .map((el) => el.getBoundingClientRect().top);
    const solid = Array.from(document.querySelectorAll('[data-list-card-solid]'));
    const rows = solid.filter(shown).map((row): SolidRowGeom => {
      const r = row.getBoundingClientRect();
      const press = row.querySelector('button[data-list-card-press]');
      const title = row.querySelector('[data-list-card-title]');
      const preview = row.querySelector('[data-list-card-preview]');
      const picture = row.querySelector('[data-list-card-picture]')?.getBoundingClientRect();
      const badge = row.querySelector('[data-list-card-count] [data-count-badge]');
      const badgeBox = badge?.getBoundingClientRect();
      const before = getComputedStyle(row, '::before');
      const width = (w: string, style: string): string => (style === 'none' ? '0px' : w);
      return {
        key:
          press?.hasAttribute('data-topbar-catch-up') === true
            ? 'catch-up'
            : press?.hasAttribute('data-topbar-threads') === true
              ? 'threads'
              : 'other',
        count: Number.parseInt(press?.getAttribute('data-count') ?? '', 10),
        name: press?.getAttribute('aria-label') ?? '',
        title: (title?.textContent ?? '').trim(),
        preview: (preview?.textContent ?? '').trim(),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        titleLeft: title?.getBoundingClientRect().left ?? null,
        picture:
          picture === undefined
            ? null
            : {
                right: picture.right,
                width: picture.width,
                height: picture.height,
                centre: picture.top + picture.height / 2,
              },
        badge:
          badge === null || badgeBox === undefined
            ? null
            : {
                right: badgeBox.right,
                centre: badgeBox.top + badgeBox.height / 2,
                tone: badge.getAttribute('data-count-badge') ?? '',
                text: (badge.textContent ?? '').trim(),
              },
        extras: row.querySelectorAll(
          '[data-list-card-time], [data-list-card-tag], [data-list-card-unread]',
        ).length,
        hover: row.matches(':hover'),
        fill: getComputedStyle(row).backgroundColor,
        ink: title === null ? '' : getComputedStyle(title).color,
        previewInk: preview === null ? null : getComputedStyle(preview).color,
        seam: {
          top: width(before.borderTopWidth, before.borderTopStyle),
          left: width(before.borderLeftWidth, before.borderLeftStyle),
          topColour: before.borderTopColor,
          leftColour: before.borderLeftColor,
        },
      };
    });
    // The list cards under the rows, one entry per grid column (by left edge).
    const cards = Array.from(content?.querySelectorAll('[data-list-card]') ?? []).filter(
      (c) => shown(c) && !c.hasAttribute('data-list-card-solid'),
    );
    const columns: ListColumnGeom[] = [];
    const dots: Array<{ left: number; right: number }> = [];
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      for (const dot of Array.from(card.querySelectorAll('[data-list-card-unread]'))) {
        const d = dot.getBoundingClientRect();
        // A drawn dot is 8 square; the sr-only one is a clipped 1px box.
        if (d.width >= 4 && d.height >= 4 && getComputedStyle(dot).position !== 'absolute') {
          dots.push({ left: box.left, right: d.right });
        }
      }
      if (columns.some((c) => Math.abs(c.left - box.left) <= 1)) continue;
      columns.push({
        left: box.left,
        width: box.width,
        titleLeft:
          card.querySelector('[data-list-card-title]')?.getBoundingClientRect().left ?? null,
        edgeRight:
          card.querySelector('[data-list-card-body]')?.getBoundingClientRect().right ?? null,
      });
    }
    for (const column of columns) {
      const dot = dots.find((d) => Math.abs(d.left - column.left) <= 1);
      if (dot !== undefined) column.edgeRight = dot.right;
    }
    columns.sort((a, b) => a.left - b.left);
    // The grid the list cards sit in (else the solid rows' own): its tracks.
    const gridOf = (el: Element | null): Element | null => {
      for (let at = el?.parentElement ?? null; at !== null; at = at.parentElement) {
        if (getComputedStyle(at).display === 'grid') return at;
        if (at.hasAttribute('data-shell')) return null;
      }
      return null;
    };
    const grid = gridOf(cards[0] ?? null) ?? gridOf(solid[0] ?? null);
    const gridStyle = grid === null ? null : getComputedStyle(grid);
    const trackWidths = (gridStyle?.gridTemplateColumns ?? '')
      .split(/\s+/)
      .map((t) => Number.parseFloat(t))
      .filter((n) => Number.isFinite(n));
    const firstTrack = trackWidths[0];
    const nav = document.querySelector('nav[aria-label="Primary"]');
    const items = nav === null ? [] : Array.from(nav.children);
    const side = document.querySelector('[data-sidebar-activity]');
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      leads: leads.length,
      leadTop: lead?.getBoundingClientRect().top ?? null,
      leadBottom: lead?.getBoundingClientRect().bottom ?? null,
      chipsBottom: chips?.getBoundingClientRect().bottom ?? null,
      content:
        content === null
          ? null
          : {
              top: content.getBoundingClientRect().top,
              pad: Number.parseFloat(getComputedStyle(content).paddingTop) || 0,
            },
      firstContentTop: contentTops.length > 0 ? Math.min(...contentTops) : null,
      rows,
      stray: solid.filter((row) => row.closest('[data-shell="lead"]') === null).length,
      retired: document.querySelectorAll(
        '[data-activity-lead-row], [data-topbar-pulse], [data-topbar-catch-up-wrap], [data-topbar-count]',
      ).length,
      inTopbar: document.querySelectorAll(
        'header :is([data-topbar-threads], [data-topbar-catch-up])',
      ).length,
      pageBg,
      accent: colourOf('bg-accent', 'backgroundColor'),
      accentFg: colourOf('text-accent-fg', 'color'),
      columns,
      tracks: Math.max(trackWidths.length, 1),
      step:
        firstTrack === undefined || gridStyle === null
          ? null
          : firstTrack + (Number.parseFloat(gridStyle.columnGap) || 0),
      topbarActivity: document.querySelectorAll('[data-topbar-activity]').length,
      side: shown(side)
        ? {
            last: items[items.length - 1] === side,
            afterChat: items[items.length - 2]?.getAttribute('href')?.startsWith('/chat') === true,
            active: side.getAttribute('data-selected') === 'true',
            background: getComputedStyle(side).backgroundColor,
            badge: side.querySelector('[data-count-badge]') !== null,
          }
        : null,
    };
  });
}

/** The solid rows' rules over one read. Pure. */
function activitySolidRowsFindings(got: SolidRowsGeom, want: ActivitySolidRowsWant): string[] {
  const out: string[] = [];
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const { rows } = got;
  const phone = got.viewport < 768;
  const NAMES = { 'catch-up': 'Catch up', threads: 'Threads', other: 'A solid row' } as const;
  // The row and its tile at this width: 60 / 36 under 768, 72 / 48 from it.
  const rowHeight = phone ? ROW_HEIGHT_PHONE : ROW_HEIGHT;
  const tile = phone ? ROW_PICTURE_PHONE : ROW_PICTURE;

  // Which rows show: exactly the ones the screen expects, Catch up first.
  for (const [key, expected] of [
    ['catch-up', want.catchUp],
    ['threads', want.threads],
  ] as const) {
    const n = rows.filter((r) => r.key === key).length;
    if (expected && n !== 1) out.push(`${NAMES[key]}: ${n} solid rows, not 1`);
    if (!expected && n !== 0) out.push(`${NAMES[key]} shows a solid row (expected none)`);
  }
  if (rows.some((r) => r.key === 'other')) out.push('a solid row is neither Catch up nor Threads');
  const order = rows.map((r) => r.key).join(' > ');
  if (order === 'threads > catch-up') out.push('Threads sits before Catch up (Catch up first)');
  if (got.stray > 0) out.push(`${got.stray} solid rows outside the lead slot`);
  if (got.retired > 0) out.push(`${got.retired} retired Threads | Catch up hooks still render`);
  if (got.inTopbar !== 0) out.push('Threads or Catch up in the top bar (one top bar on every tab)');
  if (got.scrollWidth > got.viewport) {
    out.push(`the page scrolls sideways (${got.scrollWidth} > ${got.viewport})`);
  }

  // The lead slot: only while a row shows, 12 under the chips; the content 16 under it.
  if (rows.length === 0) {
    if (got.leads !== 0) out.push('a lead slot ([data-shell="lead"]) with no solid row in it');
    if (
      got.chipsBottom !== null &&
      got.firstContentTop !== null &&
      !same(got.firstContentTop - got.chipsBottom, 16)
    ) {
      out.push(
        `the content starts ${r1(got.firstContentTop - got.chipsBottom)} under the chips, not 16`,
      );
    }
  } else {
    if (got.leads !== 1) out.push(`${got.leads} lead slots, not 1`);
    const top = Math.min(...rows.map((r) => r.top));
    const bottom = Math.max(...rows.map((r) => r.bottom));
    if (got.chipsBottom === null) out.push('no chip row above the solid rows');
    else {
      if (!same(top - got.chipsBottom, 12)) {
        out.push(`the solid rows start ${r1(top - got.chipsBottom)} under the chips, not 12`);
      }
      if (got.leadTop !== null && !same(got.leadTop, got.chipsBottom)) {
        out.push(
          `the lead slot starts ${r1(got.leadTop - got.chipsBottom)} under the chips, not 0`,
        );
      }
    }
    if (got.leadBottom !== null && !same(got.leadBottom, bottom)) {
      out.push(`the lead slot ends ${r1(got.leadBottom - bottom)} under its last row, not 0`);
    }
    if (got.content === null) out.push('no [data-shell="content"] under the solid rows');
    else if (!same(got.content.top + got.content.pad - bottom, 16)) {
      out.push(
        `the content starts ${r1(got.content.top + got.content.pad - bottom)} under the last solid row, not 16`,
      );
    }
    if (got.firstContentTop !== null && !same(got.firstContentTop - bottom, 16)) {
      out.push(
        `the first content sits ${r1(got.firstContentTop - bottom)} under the last solid row, not 16`,
      );
    }
  }

  // Each row against a list row of its own column.
  const base = got.columns[0];
  if (rows.length > 0 && base === undefined)
    out.push('no list row under the solid rows to measure');
  rows.forEach((row, i) => {
    const name = NAMES[row.key];
    const height = row.bottom - row.top;
    if (!same(height, rowHeight)) out.push(`${name} is ${r1(height)} tall, not ${rowHeight}`);
    if (!(row.count > 0)) out.push(`${name} shows at count ${row.count} (a row at 0 is absent)`);
    if (row.key !== 'other') {
      const line = row.key === 'catch-up' ? `${row.count} unread` : `${row.count} new`;
      if (row.title !== name) out.push(`${name}'s title reads "${row.title}"`);
      if (row.preview !== line)
        out.push(`${name}'s second line reads "${row.preview}", not "${line}"`);
      if (row.name !== `${name}, ${line}`) {
        out.push(`${name}'s button is named "${row.name}", not "${name}, ${line}"`);
      }
    }
    if (row.extras > 0) out.push(`${name} carries a time, tag or unread dot`);
    if (row.picture === null) out.push(`${name} has no picture tile`);
    else {
      if (!same(row.picture.width, tile) || !same(row.picture.height, tile)) {
        out.push(
          `${name}'s tile is ${r1(row.picture.width)}x${r1(row.picture.height)}, not ${tile}x${tile}`,
        );
      }
      // The tile sits on the row's centre at every width (a solid row never hangs it).
      const tileOff = row.picture.centre - (row.top + row.bottom) / 2;
      if (Math.abs(tileOff) > 1)
        out.push(`${name}'s tile is ${r1(tileOff)}px off the row's centre`);
      if (row.titleLeft !== null && !same(row.titleLeft - row.picture.right, ROW_INSET)) {
        out.push(
          `${name}'s title starts ${r1(row.titleLeft - row.picture.right)} after the tile, not ${ROW_INSET}`,
        );
      }
    }
    if (row.titleLeft === null) out.push(`${name} has no title`);
    if (row.badge === null) out.push(`${name} has no count pill`);
    else {
      if (row.badge.tone !== 'on-fill') out.push(`${name}'s count pill is not the on-fill tone`);
      const text = row.count > 99 ? '99+' : String(row.count);
      if (row.badge.text !== text)
        out.push(`${name}'s pill reads "${row.badge.text}", not "${text}"`);
      const off = row.badge.centre - (row.top + row.bottom) / 2;
      if (Math.abs(off) > 1) out.push(`${name}'s count pill is ${r1(off)}px off the row's centre`);
    }
    // Look: the ink fill (a hovered row is one step off it), accent-fg text.
    if (!row.hover && row.fill !== got.accent) {
      out.push(`${name}'s fill is ${row.fill}, not the accent ${got.accent}`);
    }
    if (row.ink !== got.accentFg || (row.previewInk !== null && row.previewInk !== got.accentFg)) {
      out.push(`${name}'s text is ${row.ink} / ${row.previewInk}, not accent-fg ${got.accentFg}`);
    }
    // The seam: a 1px top and left line in the page background (::before).
    if (row.seam.top !== '1px' || row.seam.left !== '1px') {
      out.push(`${name}'s seam is ${row.seam.top} top / ${row.seam.left} left, not 1px / 1px`);
    }
    if (row.seam.topColour !== got.pageBg || row.seam.leftColour !== got.pageBg) {
      out.push(
        `${name}'s seam is ${row.seam.topColour} / ${row.seam.leftColour}, not the page background ${got.pageBg}`,
      );
    }
    if (phone) {
      if (!same(row.left, 0) || !same(row.right, got.viewport)) {
        out.push(
          `${name} spans ${r1(row.left)}..${r1(row.right)}, not the viewport 0..${got.viewport}`,
        );
      }
    }
    if (base === undefined) return;
    // md and up: cell i sits in grid column i (a one-column grid stacks them).
    const index = phone || got.tracks < 2 ? 0 : i;
    const wantLeft = got.step !== null ? base.left + got.step * index : got.columns[index]?.left;
    if (wantLeft === undefined) {
      out.push(`${name}: no list column ${index + 1} to measure against`);
      return;
    }
    // A list row painted in that column, else the first column moved over by the grid's step.
    const column = got.columns.find((c) => same(c.left, wantLeft));
    const col = column ?? base;
    const shift = column === undefined ? wantLeft - base.left : 0;
    if (!phone && (!same(row.left, col.left + shift) || !same(row.right - row.left, col.width))) {
      out.push(
        `${name} sits at ${r1(row.left)} and is ${r1(row.right - row.left)} wide; list column ${index + 1} is at ${r1(col.left + shift)}, ${r1(col.width)} wide`,
      );
    }
    if (row.titleLeft !== null && col.titleLeft !== null) {
      if (!same(row.titleLeft, col.titleLeft + shift)) {
        out.push(
          `${name}'s title starts at ${r1(row.titleLeft)}, the list rows' at ${r1(col.titleLeft + shift)}`,
        );
      }
    }
    if (
      row.badge !== null &&
      col.edgeRight !== null &&
      !same(row.badge.right, col.edgeRight + shift)
    ) {
      out.push(
        `${name}'s count pill ends at ${r1(row.badge.right)}, the list rows' right edge is ${r1(col.edgeRight + shift)}`,
      );
    }
  });

  // Two rows: stacked and touching (phone, a one-column grid) or side by side and touching.
  const [a, b] = rows;
  if (a !== undefined && b !== undefined) {
    if (phone || got.tracks < 2) {
      const gap = b.top - a.bottom;
      if (Math.abs(gap) > 0.5) out.push(`the solid rows are ${r1(gap)}px apart, not touching`);
      if (!same(a.left, b.left)) out.push('the stacked solid rows do not share a left edge');
    } else {
      if (!same(b.left, a.right)) {
        out.push(`the two cells are ${r1(b.left - a.right)}px apart, not touching`);
      }
      if (!same(a.top, b.top)) out.push('the two cells are not on one line');
    }
  }
  return out;
}

/**
 * Check 15, the solid rows: measures Activity's Catch up and Threads rows on
 * the page as it stands (phone and laptop, light and dark) and fails on a
 * breach. `want` states which rows this screen shows: a row is asserted
 * present or absent exactly, and with neither there is no lead slot.
 * `narrow` (phones) measures again at 390 and 375 wide, then restores the
 * viewport it found.
 */
export async function assertActivitySolidRows(
  page: Page,
  screenName: string,
  want: ActivitySolidRowsWant,
  opts: { narrow?: boolean } = {},
): Promise<void> {
  const got = await readActivitySolidRows(page);
  const rows = activitySolidRowsFindings(got, want);
  const bar: string[] = [];
  if (got.viewport >= 768) {
    if (got.topbarActivity !== 0) bar.push('an Activity button in the laptop top bar');
    const side = got.side;
    if (side === null) bar.push('no Activity in the Sidebar');
    else {
      if (!side.last || !side.afterChat)
        bar.push('Sidebar Activity is not the last item after Chat');
      if (!side.active || side.background !== got.accent) {
        bar.push('Sidebar Activity is not filled on /activity');
      }
      if (want.catchUp && !side.badge) bar.push('Sidebar Activity shows no count');
    }
  }
  const before = page.viewportSize();
  if (opts.narrow === true && before !== null && before.width < 768) {
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: before.height });
      await page.waitForFunction((w) => window.innerWidth === w, width);
      const at = await readActivitySolidRows(page);
      rows.push(...activitySolidRowsFindings(at, want).map((m) => `${width} wide: ${m}`));
    }
    await page.setViewportSize(before);
    await page.waitForFunction((w) => window.innerWidth === w, before.width);
  }
  settleFindings(screenName, [
    ...rows.map((message) => ({ check: 'list-card' as const, message })),
    ...bar.map((message) => ({ check: 'topbar' as const, message })),
  ]);
}

// Check 15b, catch up per tab (13 Nov 2026): each list tab's catch-up rows
// (catch-up/TabCatchUp: ui/ListCard solid + count) sit ABOVE its chip row in
// ListScreen's catchUp strip ([data-shell="catch-up"]), one per kind, only
// while its count is above 0 (at 0: no row, no strip). Measured: the rows
// shown and their order; 12 under the top bar; 16 from the last row to the
// chips; 72 tall (60 under 768); "N unread" matching the count; the text
// column on the list rows' text column; the count pill on the row's 16 / 24
// content edge; phone edge to edge, laptop on the 24 gutter less the 16 bleed.
// Activity passes kinds [] (no row there, ever).

/** The rows a tab shows, in order (TabCatchUpKind values). */
export interface TabCatchUpRowsWant {
  kinds: readonly ('post' | 'brief' | 'plan-item' | 'idea' | 'chat')[];
}

interface TabCatchUpGeom {
  viewport: number;
  scrollWidth: number;
  strips: number;
  stripTop: number | null;
  barBottom: number | null;
  chipsTop: number | null;
  mainLeft: number;
  mainRight: number;
  solidOutside: number;
  rows: {
    kind: string;
    count: number;
    line: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    titleLeft: number | null;
    badgeRight: number | null;
  }[];
  listTitleLeft: number | null;
}

async function readTabCatchUpRows(page: Page): Promise<TabCatchUpGeom> {
  return page.evaluate((): TabCatchUpGeom => {
    const shown = (el: Element | null | undefined): el is Element => {
      if (el === null || el === undefined) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const main = document.querySelector('main') ?? document.body;
    const mainBox = main.getBoundingClientRect();
    const strips = Array.from(main.querySelectorAll('[data-shell="catch-up"]')).filter(shown);
    const strip = strips[0] ?? null;
    const bar = document.querySelector('header');
    const chips = Array.from(main.querySelectorAll('[data-shell="chips"] button')).find(shown);
    const rows = Array.from(main.querySelectorAll('[data-tab-catch-up]'))
      .filter(shown)
      .map((row) => {
        const r = row.getBoundingClientRect();
        const title = row.querySelector('[data-list-card-title]');
        const badge = row.querySelector('[data-list-card-count] [data-count-badge]');
        return {
          kind: row.getAttribute('data-tab-catch-up') ?? '',
          count: Number(row.getAttribute('data-count')),
          line: row.querySelector('[data-list-card-preview]')?.textContent?.trim() ?? '',
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          titleLeft: shown(title) ? title.getBoundingClientRect().left : null,
          badgeRight: shown(badge) ? badge.getBoundingClientRect().right : null,
        };
      });
    const listTitle = Array.from(
      main.querySelectorAll(
        '[data-shell="content"] [data-list-card]:not([data-list-card-solid]) [data-list-card-title]',
      ),
    ).find(shown);
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      strips: strips.length,
      stripTop: strip !== null ? strip.getBoundingClientRect().top : null,
      barBottom: shown(bar) ? bar.getBoundingClientRect().bottom : null,
      chipsTop: chips !== undefined ? chips.getBoundingClientRect().top : null,
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      solidOutside: Array.from(main.querySelectorAll('[data-list-card-solid]'))
        .filter(shown)
        .filter((el) => el.closest('[data-shell="catch-up"]') === null).length,
      rows,
      listTitleLeft: listTitle !== undefined ? listTitle.getBoundingClientRect().left : null,
    };
  });
}

/** The rules over one read. Pure. */
export function tabCatchUpFindings(got: TabCatchUpGeom, want: TabCatchUpRowsWant): string[] {
  const out: string[] = [];
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const phone = got.viewport < 768;
  const kinds = got.rows.map((r) => r.kind).join(' > ');
  if (kinds !== want.kinds.join(' > ')) {
    out.push(`catch-up rows "${kinds}", expected "${want.kinds.join(' > ')}"`);
  }
  if (got.solidOutside > 0) out.push(`${got.solidOutside} solid rows outside the catch-up strip`);
  if (got.scrollWidth > got.viewport) {
    out.push(`the page scrolls sideways (${got.scrollWidth} > ${got.viewport})`);
  }
  if (want.kinds.length === 0) {
    if (got.strips !== 0) out.push('a catch-up strip with no row (nothing is reserved at 0)');
    return out;
  }
  if (got.strips !== 1) out.push(`${got.strips} catch-up strips, not 1`);
  const top = Math.min(...got.rows.map((r) => r.top));
  const bottom = Math.max(...got.rows.map((r) => r.bottom));
  if (got.barBottom !== null && !same(top - got.barBottom, 12)) {
    out.push(`the first catch-up row starts ${r1(top - got.barBottom)} under the top bar, not 12`);
  }
  if (got.chipsTop === null) out.push('no chip row under the catch-up rows');
  else if (!same(got.chipsTop - bottom, 16)) {
    out.push(`the chips start ${r1(got.chipsTop - bottom)} under the last catch-up row, not 16`);
  }
  const height = phone ? ROW_HEIGHT_PHONE : ROW_HEIGHT;
  for (const row of got.rows) {
    const name = `the ${row.kind} catch-up row`;
    if (!(row.count > 0)) out.push(`${name} shows at count ${row.count}`);
    if (row.line !== `${row.count} unread`) out.push(`${name} reads "${row.line}", not "N unread"`);
    if (!same(row.bottom - row.top, height)) {
      out.push(`${name} is ${r1(row.bottom - row.top)} tall, not ${height}`);
    }
    if (row.badgeRight === null) out.push(`${name} has no count pill`);
    else if (!same(row.right - row.badgeRight, 16)) {
      out.push(
        `${name}: the count pill ends ${r1(row.right - row.badgeRight)} from the row edge, not 16`,
      );
    }
    if (
      got.listTitleLeft !== null &&
      row.titleLeft !== null &&
      !same(row.titleLeft, got.listTitleLeft)
    ) {
      if (row.left <= got.mainLeft + (phone ? 1 : 9)) {
        out.push(
          `${name}: text column at ${r1(row.titleLeft)}, the list rows' at ${r1(got.listTitleLeft)}`,
        );
      }
    }
    // Phone: edge to edge (the 16 gutter less the row's 16 bleed); laptop: 24 less 16.
    const inset = phone ? 0 : 8;
    if (row.left < got.mainLeft + inset - 1) {
      out.push(`${name} starts ${r1(row.left - got.mainLeft)} from the page edge, not ${inset}`);
    }
    if (phone && !same(row.right, got.mainRight)) {
      out.push(`${name} ends ${r1(got.mainRight - row.right)} short of the page edge on phone`);
    }
  }
  return out;
}

/**
 * Check 15b: measures a tab's catch-up rows on the page as it stands (phone
 * and laptop, light and dark) and fails on a breach. `want.kinds` lists the
 * rows this screen shows, in order; [] asserts none (Activity, a tab at 0).
 */
export async function assertTabCatchUpRows(
  page: Page,
  screenName: string,
  want: TabCatchUpRowsWant,
): Promise<void> {
  const got = await readTabCatchUpRows(page);
  settleFindings(
    screenName,
    tabCatchUpFindings(got, want).map((message) => ({ check: 'list-card' as const, message })),
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
 * exactly 2 lines ending "… Show more" on a whole word of its full text (the row
 * link's name holds the full text); the short row's preview is 1 line with
 * no marker. "more" unfolds without leaving the page and becomes "less";
 * "less" folds it back. Leaves the page as it found it (folded).
 * Heights (12 Nov 2026): the short row is the row height (60 under 768, 72
 * from it), the folded long row one 20 line more (80 / 92); every preview
 * line, "… more" included, ends inside its preview box and inside the row's
 * bottom inset, so the marker never hangs out of the row.
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
      let textBottom = Number.NEGATIVE_INFINITY;
      if (preview !== null) {
        const walk = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 4)) tops.push(r.top);
            if (r.width > 0) textBottom = Math.max(textBottom, r.bottom);
          }
        }
      }
      const rowBox = row.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        // How far the preview's last text line runs past its own box, and
        // past the row's bottom inset (0 or less: inside).
        spillBox:
          preview === null || !Number.isFinite(textBottom)
            ? 0
            : textBottom - preview.getBoundingClientRect().bottom,
        spillRow: Number.isFinite(textBottom)
          ? textBottom - (rowBox.bottom - (parseFloat(getComputedStyle(row).paddingBottom) || 0))
          : 0,
        height: rowBox.height,
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
  const rowPx = (viewport: number): number => (viewport < 768 ? ROW_HEIGHT_PHONE : ROW_HEIGHT);
  for (const [name, got, extra] of [
    ['long', long, 20],
    ['short', short, 0],
  ] as const) {
    if (got === null) continue;
    const want = rowPx(got.viewport) + extra;
    if (Math.abs(got.height - want) > 1) {
      out.push(`the ${name} preview row is ${got.height} tall, not ${want}`);
    }
    if (got.spillBox > 1) {
      out.push(`the ${name} preview's last line runs ${got.spillBox}px out of its preview box`);
    }
    if (got.spillRow > 1) {
      out.push(
        `the ${name} preview's last line runs ${got.spillRow}px into the row's bottom inset`,
      );
    }
  }
  if (long === null) out.push('no long preview row');
  else {
    if (long.lines !== 2) out.push(`the long preview takes ${long.lines} lines, not 2`);
    if (!long.text.endsWith('… Show more'))
      out.push(`the long preview ends "${long.text.slice(-12)}", not "… Show more"`);
    const kept = long.text.slice(0, -'… Show more'.length);
    // A whole word: the full text goes on after the kept part with a space or
    // the punctuation the cut strips ("shot," -> "shot… Show more").
    const at = long.name.indexOf(kept);
    const next = at < 0 ? '' : long.name.charAt(at + kept.length);
    if (at < 0 || /[\p{L}\p{N}]/u.test(next))
      out.push('the long preview is not cut at a whole word');
    if (long.toggle !== 'more') out.push('the long row has no "Show more" toggle');
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
    // The shell's lead strip (a count line, Activity's solid rows) sits
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
 * search and avatar x and the filter row's non-chip controls, read on the tab
 * as it stands (at the top, dock at rest), for assertTabFrameStill across the
 * six tabs. The phone bottom bar is measured here per tab (11 Nov 2026: the
 * open tab shows its name, so its width follows the tab).
 */
export async function readTabFrame(page: Page, screen: string): Promise<TabFrameAt> {
  const at = await page.evaluate(() => {
    const shown = (el: Element | null): DOMRect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const x = (el: Element | null): number | null => shown(el)?.x ?? null;
    const header = document.querySelector('header');
    const search =
      [...(header?.querySelectorAll('button') ?? [])].find(
        (b) =>
          shown(b) !== null &&
          (b.getAttribute('aria-label') === 'Search' ||
            (b.getAttribute('aria-label') === null && /^\s*Search/.test(b.textContent ?? ''))),
      ) ?? null;
    const nav = document.querySelector('nav[aria-label="Primary"]');
    // Phone nav (11 Nov 2026): the open tab shows its name, so tab centres and
    // the bar's width change with the tab and are no longer compared across
    // tabs. Measured on each tab instead: every icon on the bar's vertical
    // centre (+-1), the open tab's icon + name inside its fill with equal
    // sides (12 in the pill, 12 or more on Chat), the bar centred with 16 or
    // more on each side here and still inside a 360 wide screen.
    const navFindings: string[] = [];
    const bar = shown(nav);
    if (bar !== null) {
      const barCy = bar.y + bar.height / 2;
      const links = [
        ...document.querySelectorAll('nav[aria-label="Primary"] [data-tab-pill] > a'),
        ...document.querySelectorAll('nav[aria-label="Primary"] [data-chat-tab]'),
      ];
      for (const a of links) {
        const what = a.hasAttribute('data-chat-tab') ? 'Chat' : (a.getAttribute('href') ?? 'tab');
        const icon = shown(a.querySelector('svg'));
        if (icon === null) {
          navFindings.push(`phone nav ${what}: no icon`);
          continue;
        }
        const off = icon.y + icon.height / 2 - barCy;
        if (Math.abs(off) > 1) {
          navFindings.push(`phone nav ${what}: icon centre ${off.toFixed(1)} off the bar centre`);
        }
      }
      const names = [...document.querySelectorAll('nav[aria-label="Primary"] [data-tab-name]')];
      if (names.length !== 1) navFindings.push(`phone nav: ${names.length} names show, expected 1`);
      for (const el of names) {
        const a = el.closest('a');
        const fill = shown(a);
        const name = shown(el);
        const icon = shown(a?.querySelector('svg') ?? null);
        if (a === null || fill === null || name === null || icon === null) continue;
        const left = icon.x - fill.x;
        const right = fill.right - name.right;
        const chat = a.hasAttribute('data-chat-tab');
        const ok = chat
          ? left >= 12 && right >= 12 && Math.abs(left - right) <= 1
          : Math.abs(left - 12) <= 1 && Math.abs(right - 12) <= 1;
        if (!ok || name.x < icon.right) {
          navFindings.push(
            `phone nav name "${el.textContent ?? ''}": ${left.toFixed(1)} before the icon, ${right.toFixed(1)} after the name (12 each side)`,
          );
        }
      }
      const leftGap = bar.x;
      const rightGap = window.innerWidth - bar.right;
      if (leftGap < 16 || rightGap < 16 || Math.abs(leftGap - rightGap) > 1) {
        navFindings.push(
          `phone nav bar: ${leftGap.toFixed(1)} left, ${rightGap.toFixed(1)} right (centred, 16 or more each side)`,
        );
      }
      if (bar.width > 360) {
        navFindings.push(`phone nav bar: ${bar.width.toFixed(1)} wide, past a 360 wide screen`);
      }
    }
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
      tabCentres: [],
      chatCentre: null,
      barWidth: null,
      nonChips,
      navFindings,
    };
  });
  const { navFindings, ...frame } = at;
  settleFindings(
    `${screen} phone nav`,
    navFindings.map((message) => ({ check: 'alignment' as const, message })),
  );
  return { screen, ...frame };
}

/** Nothing moves when you switch tabs: each tab's frame against the first (+-1). */
export function assertTabFrameStill(name: string, rows: readonly TabFrameAt[]): void {
  settleFindings(
    name,
    tabFrameViolations(rows).map((message) => ({ check: 'topbar' as const, message })),
  );
}

/** What a message-family screen must show (assertMessageFamily). */
export interface MessageFamilyWant {
  /** At least this many date lines show (default 0). */
  dateLines?: number;
  /** A loading screen: at least one placeholder photo shows and is measured. */
  placeholders?: boolean;
  /** At least one message row's photo is measured (default true). */
  rows?: boolean;
  /** Under 768: a one line and a two line Catch up row both show (name to text on each). */
  oneAndTwoLine?: boolean;
  /** The DM's Seen line shows and is measured. */
  seen?: boolean;
}

/**
 * Check 17 (11 Nov 2026, CLAUDE.md "Work chat": the message family), MEASURED
 * on the screen as shot, +-1px, phone and laptop, light and dark. Under 768
 * the touch table (photo 36, 12 to the text, name 17 / 22 bold, text 17 / 20,
 * date words 17 bold); from 768 the laptop table (photo 32, 8 to the text,
 * name 13 / 18 600, text 14 / 20, date words 15 bold).
 * - every main-list message row (li[data-msg-id] outside a thread view) with a
 *   name: its photo is the family square, sits on the row's own left pad, and
 *   the name starts at photo right + gap; the text starts on the name's x;
 *   name and text carry the family's computed size and line; a follow-on
 *   row's spacer is the photo's width and its text sits one gap after it;
 * - every Catch up row ([data-catch-up-photo]): the column is the photo's
 *   width on the row's 16 inset and the name starts 12 after it; under 768
 *   (12 Nov 2026) the name ([data-catch-up-name]) and every text
 *   ([data-catch-up-text]) carry the family's type, and the name sits 4 over
 *   the first text on a one line and a two line row alike: a main chat head
 *   row's step ([data-sender-line] to [data-msg-body], measured on the main
 *   list's rows whose text leads); from 768 the rows' steps are equal;
 * - the Seen and Read by lines ([data-seen-words], [data-read-by-words]):
 *   under 768 the words start on the text column, 64 from the line's left;
 * - every date line ([data-date-line]): the words at the family size, bold,
 *   16 in from the line's left (the photo's x); the hairline spans the list;
 *   16 above the words (0 as the list's first row), 8 from the words to the
 *   hairline, 12 from the hairline to the line's end, and a message row
 *   right under it has no top padding;
 * - every placeholder photo (a placeholder row's leading Bone): the family square, with the
 *   next bar one gap after it (12 in a thread view and in Catch up, where the
 *   loaded rows sit 12 from the photo on both layouts), 16 in from a thread
 *   fill's left: the rect the loaded row's photo takes.
 */
export async function assertMessageFamily(
  page: Page,
  screenName: string,
  want: MessageFamilyWant = {},
): Promise<void> {
  const findings: string[] = await page.evaluate(
    (opts: {
      dateLines: number;
      placeholders: boolean;
      rows: boolean;
      oneAndTwoLine: boolean;
      seen: boolean;
    }): string[] => {
      const out: string[] = [];
      const laptop = window.innerWidth >= 768;
      const fam = laptop
        ? { photo: 32, gap: 8, name: 13, nameLine: 18, nameWeight: 600, text: 14, textLine: 20 }
        : { photo: 36, gap: 12, name: 17, nameLine: 22, nameWeight: 700, text: 17, textLine: 20 };
      const dateSize = laptop ? 15 : 17;
      const r1 = (n: number): number => Math.round(n * 10) / 10;
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
      const px = (v: string): number => parseFloat(v) || 0;
      const shown = (el: Element | null): el is Element => {
        if (el === null) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        return getComputedStyle(el).visibility !== 'hidden';
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
      const type = (el: Element, label: string, size: number, line: number): void => {
        const s = getComputedStyle(el);
        if (!near(px(s.fontSize), size) || !near(px(s.lineHeight), line)) {
          out.push(`${label}: type ${s.fontSize} / ${s.lineHeight}, want ${size}px / ${line}px`);
        }
      };

      /**
       * The inset the body's own wrappers add (a quote rail, a card's pad):
       * padding, border and margin on the left of every ancestor under `top`.
       */
      const insetUnder = (el: Element, top: Element): number => {
        let sum = 0;
        for (let at = el.parentElement; at !== null && at !== top; at = at.parentElement) {
          if (at.contains(top)) break;
          const cs = getComputedStyle(at);
          sum += px(cs.paddingLeft) + px(cs.borderLeftWidth) + px(cs.marginLeft);
        }
        return sum;
      };
      /** Name to text: the flex step between a head row's name line and its text. */
      const nameToText = 4;
      // 1. Message rows in a main list (a thread view's root and replies have their own measure).
      let measured = 0;
      const rows = Array.from(document.querySelectorAll('li[data-msg-id]')).filter(
        (row) =>
          shown(row) &&
          row.closest('[data-thread-view], [data-comment-thread], [data-threads-block]') === null,
      );
      rows.forEach((row, i) => {
        const at = `message row ${i + 1}`;
        const rowBox = row.getBoundingClientRect();
        const body = row.querySelector('[data-msg-body]');
        const bodyLeft = shown(body) ? textLeft(body) : null;
        const name = row.querySelector('[data-sender-name]');
        if (!shown(name)) {
          const spacer = row.querySelector('[data-photo-spacer]');
          if (!shown(spacer)) return;
          const s = spacer.getBoundingClientRect();
          if (!near(s.width, fam.photo)) {
            out.push(`${at}: spacer ${r1(s.width)} wide, want ${fam.photo}`);
          }
          const inset = shown(body) ? insetUnder(body, row) : 0;
          if (bodyLeft !== null && !near(bodyLeft - s.right, fam.gap + inset)) {
            out.push(
              `${at}: text ${r1(bodyLeft - s.right)} after the spacer, want ${fam.gap + inset}`,
            );
          }
          return;
        }
        const photo = row.querySelector(
          '[data-avatar-role="message"], [data-avatar-role="header"]',
        );
        if (!shown(photo)) return;
        measured += 1;
        const p = photo.getBoundingClientRect();
        if (!near(p.width, fam.photo) || !near(p.height, fam.photo)) {
          out.push(`${at}: photo ${r1(p.width)}x${r1(p.height)}, want ${fam.photo} square`);
        }
        const pad = px(getComputedStyle(row).paddingLeft);
        if (!near(p.left - rowBox.left, pad)) {
          out.push(`${at}: photo x ${r1(p.left - rowBox.left)}, want the row's left pad ${pad}`);
        }
        const nameLeft = textLeft(name);
        if (nameLeft !== null && !near(nameLeft - p.right, fam.gap)) {
          out.push(`${at}: name ${r1(nameLeft - p.right)} after the photo, want ${fam.gap}`);
        }
        // The text column: the name's x, plus what the body's own wrappers inset.
        const column = name.closest('[data-sender-line]')?.parentElement ?? row;
        const inset = shown(body) ? insetUnder(body, column) : 0;
        if (nameLeft !== null && bodyLeft !== null && !near(bodyLeft, nameLeft + inset)) {
          out.push(
            `${at}: text x ${r1(bodyLeft)}, not on the name's column ${r1(nameLeft + inset)}`,
          );
        }
        type(name, `${at} name`, fam.name, fam.nameLine);
        const weight = Number(getComputedStyle(name).fontWeight);
        if (weight !== fam.nameWeight) {
          out.push(`${at}: name weight ${weight}, want ${fam.nameWeight}`);
        }
        if (shown(body)) type(body, `${at} text`, fam.text, fam.textLine);
        // The head row's name to text step, where the text leads the message.
        const line = name.closest('[data-sender-line]');
        const bubble = row.querySelector('[data-bubble]');
        if (!laptop && shown(line) && shown(body) && shown(bubble)) {
          const top = body.getBoundingClientRect().top;
          const step = top - line.getBoundingClientRect().bottom;
          if (near(top, bubble.getBoundingClientRect().top) && !near(step, nameToText)) {
            out.push(`${at}: name to text ${r1(step)}, want ${nameToText}`);
          }
        }
      });

      // 2. Catch up rows draw their own photo column.
      const steps: Array<{ at: string; step: number; lines: number }> = [];
      Array.from(document.querySelectorAll('[data-catch-up-photo]'))
        .filter(shown)
        .forEach((col, i) => {
          measured += 1;
          const at = `catch-up row ${i + 1}`;
          const c = col.getBoundingClientRect();
          if (!near(c.width, fam.photo)) {
            out.push(`${at}: photo column ${r1(c.width)} wide, want ${fam.photo}`);
          }
          const name = col.parentElement?.querySelector('[data-catch-up-name]') ?? null;
          const nameLeft = shown(name) ? textLeft(name) : null;
          if (nameLeft !== null && !near(nameLeft - c.right, 12)) {
            out.push(`${at}: name ${r1(nameLeft - c.right)} after the photo column, want 12`);
          }
          const host = col.parentElement;
          if (host === null) return;
          const inset = c.left - host.getBoundingClientRect().left;
          if (!near(inset, 16)) out.push(`${at}: photo x ${r1(inset)}, want the row's 16 inset`);
          const texts = Array.from(host.querySelectorAll('[data-catch-up-text]')).filter(shown);
          if (!laptop) {
            if (shown(name)) {
              type(name, `${at} name`, fam.name, fam.nameLine);
              const weight = Number(getComputedStyle(name).fontWeight);
              if (weight !== fam.nameWeight) {
                out.push(`${at}: name weight ${weight}, want ${fam.nameWeight}`);
              }
            }
            for (const text of texts) type(text, `${at} text`, fam.text, fam.textLine);
          }
          // Name to text, on rows whose text follows the name (no grey line between).
          const first = texts[0];
          const between = host.querySelector('[data-catch-up-in-thread], [data-catch-up-earlier]');
          if (!shown(name) || first === undefined || shown(between)) return;
          const t = first.getBoundingClientRect();
          const lineHeight = px(getComputedStyle(first).lineHeight) || fam.textLine;
          steps.push({
            at,
            step: t.top - name.getBoundingClientRect().bottom,
            lines: Math.round(t.height / lineHeight),
          });
        });
      const wantStep = laptop ? (steps[0]?.step ?? nameToText) : nameToText;
      for (const s of steps) {
        if (!near(s.step, wantStep)) {
          out.push(`${s.at}: name to text ${r1(s.step)} (${s.lines} lines), want ${r1(wantStep)}`);
        }
      }
      if (opts.oneAndTwoLine && !laptop) {
        if (!steps.some((s) => s.lines === 1)) out.push('no one line catch-up row to measure');
        if (!steps.some((s) => s.lines >= 2)) out.push('no two line catch-up row to measure');
      }
      if (opts.rows && measured === 0) out.push('no message row photo shown to measure');

      // 2b. Seen and Read by: under 768 the words start on the text column (64).
      const seenLines = Array.from(document.querySelectorAll('[data-seen-line]')).filter(shown);
      if (opts.seen && seenLines.length === 0) out.push('no Seen line shown to measure');
      const readLines = Array.from(document.querySelectorAll('[data-read-by-line]')).filter(shown);
      for (const line of laptop ? [] : [...seenLines, ...readLines]) {
        const seen = line.hasAttribute('data-seen-line');
        const at = seen ? 'Seen line' : 'Read by line';
        const words = line.querySelector(seen ? '[data-seen-words]' : '[data-read-by-words]');
        const left = shown(words) ? textLeft(words) : null;
        if (left === null) out.push(`${at}: no words to measure`);
        else if (!near(left - line.getBoundingClientRect().left, 64)) {
          out.push(`${at}: words x ${r1(left - line.getBoundingClientRect().left)}, want 64`);
        }
      }

      // 3. Date lines.
      const lines = Array.from(document.querySelectorAll('[data-date-line]')).filter(shown);
      if (lines.length < opts.dateLines) {
        out.push(`${lines.length} date lines shown, want ${opts.dateLines} or more`);
      }
      lines.forEach((line, i) => {
        const at = `date line ${i + 1}`;
        const label = line.querySelector('[data-date-label]');
        const rule = line.querySelector('[data-date-rule]');
        const list = line.parentElement;
        if (!shown(label) || !shown(rule) || list === null) {
          out.push(`${at}: its words or hairline are missing`);
          return;
        }
        const l = line.getBoundingClientRect();
        const w = label.getBoundingClientRect();
        const h = rule.getBoundingClientRect();
        const ls = getComputedStyle(label);
        if (!near(px(ls.fontSize), dateSize) || Number(ls.fontWeight) !== 700) {
          out.push(`${at}: words ${ls.fontSize} weight ${ls.fontWeight}, want ${dateSize}px 700`);
        }
        if (line.getAttribute('role') !== 'separator') out.push(`${at}: not a separator`);
        const left = textLeft(label);
        if (left !== null && !near(left - l.left, 16)) {
          out.push(`${at}: words x ${r1(left - l.left)}, want 16 (the photo's x)`);
        }
        // The same x as a photo of the list's own rows (those on the 16 pad).
        const photo = Array.from(
          list.querySelectorAll('[data-avatar-role="message"], [data-avatar-role="header"]'),
        ).find((el) => {
          const row = el.closest('li[data-msg-id]');
          return shown(el) && row !== null && near(px(getComputedStyle(row).paddingLeft), 16);
        });
        if (left !== null && photo !== undefined) {
          const p = photo.getBoundingClientRect();
          if (!near(left, p.left)) {
            out.push(`${at}: words x ${r1(left)}, not on the photo's x ${r1(p.left)}`);
          }
        }
        const listBox = list.getBoundingClientRect();
        const line1 = px(getComputedStyle(rule).borderBottomWidth);
        if (!near(line1, 1)) out.push(`${at}: hairline ${line1} thick, want 1`);
        if (!near(h.left, listBox.left) || !near(h.right, listBox.left + list.clientWidth)) {
          out.push(
            `${at}: hairline ${r1(h.left)}..${r1(h.right)}, want the list ${r1(listBox.left)}..${r1(listBox.left + list.clientWidth)}`,
          );
        }
        const first = list.firstElementChild === line;
        if (!near(w.top - l.top, first ? 0 : 16)) {
          out.push(`${at}: ${r1(w.top - l.top)} above the words, want ${first ? 0 : 16}`);
        }
        if (!near(h.bottom - line1 - w.bottom, 8)) {
          out.push(`${at}: ${r1(h.bottom - line1 - w.bottom)} from words to hairline, want 8`);
        }
        if (!near(l.bottom - h.bottom, 12)) {
          out.push(`${at}: ${r1(l.bottom - h.bottom)} under the hairline, want 12`);
        }
        const next = line.nextElementSibling;
        if (next !== null && next.matches('li[data-msg-id]')) {
          const top = px(getComputedStyle(next).paddingTop);
          if (!near(top, 0)) out.push(`${at}: the row under it has ${top} top padding, want 0`);
        }
      });

      // 4. Placeholder photos: the rect the loaded row's photo takes.
      // The photo bone leads each placeholder row of a message surface.
      const bones = Array.from(
        document.querySelectorAll(
          [
            '[data-thread-fill]',
            '[data-comments-loading]',
            '[data-catch-up-bones]',
            '[data-list-skeleton]',
          ]
            .map((list) => `${list} li > [data-bone]:first-child`)
            .join(', '),
        ),
      ).filter(shown);
      if (opts.placeholders && bones.length === 0) out.push('no placeholder photo shown');
      bones.forEach((bone, i) => {
        const at = `placeholder ${i + 1}`;
        const b = bone.getBoundingClientRect();
        if (!near(b.width, fam.photo) || !near(b.height, fam.photo)) {
          out.push(`${at}: photo ${r1(b.width)}x${r1(b.height)}, want ${fam.photo} square`);
        }
        const fill = bone.closest('[data-thread-fill]');
        const twelve = fill !== null || bone.closest('[data-catch-up-bones]') !== null;
        const gap = twelve ? 12 : fam.gap;
        const bar = bone.nextElementSibling;
        if (shown(bar) && !near(bar.getBoundingClientRect().left - b.right, gap)) {
          out.push(
            `${at}: bar ${r1(bar.getBoundingClientRect().left - b.right)} after the photo, want ${gap}`,
          );
        }
        if (fill !== null && !near(b.left - fill.getBoundingClientRect().left, 16)) {
          out.push(
            `${at}: photo x ${r1(b.left - fill.getBoundingClientRect().left)} in the thread, want 16`,
          );
        }
      });
      return out;
    },
    {
      dateLines: want.dateLines ?? 0,
      placeholders: want.placeholders === true,
      rows: want.rows !== false,
      oneAndTwoLine: want.oneAndTwoLine === true,
      seen: want.seen === true,
    },
  );
  settleFindings(
    screenName,
    findings.map((message) => ({ check: 'alignment' as const, message })),
  );
}

/**
 * Check 18 (12 Nov 2026): a comment that carries a photo over its text
 * ([data-comments-list] li[data-msg-id] with a picture in its [data-bubble]
 * and a text body), MEASURED +-1, phone and laptop, light and dark: the photo
 * starts on the name's x and the text at most 8 inside it (the album block's
 * inset, still there); under 768 the name's x is the family's text column, 64
 * from the screen edge. A screen with no such comment fails.
 */
export async function assertPhotoCaptionColumn(page: Page, screenName: string): Promise<void> {
  const findings: string[] = await page.evaluate((): string[] => {
    const out: string[] = [];
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const shown = (el: Element | null): el is Element => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const textLeft = (el: Element | null): number | null => {
      if (!shown(el)) return null;
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
    const rows = Array.from(
      document.querySelectorAll('[data-comments-list] li[data-msg-id]'),
    ).filter((row) => shown(row) && shown(row.querySelector('[data-bubble] img')));
    if (rows.length === 0) return ['no comment with a photo shown'];
    rows.forEach((row, i) => {
      const at = `photo comment ${i + 1}`;
      const name = textLeft(row.querySelector('[data-sender-name]'));
      const text = textLeft(row.querySelector('[data-msg-body]'));
      if (name === null || text === null) {
        out.push(`${at}: no ${name === null ? 'name' : 'text'} to measure`);
        return;
      }
      // Read from the code (11 Nov 2026): the caption sits 8 inside the photo's edge (the
      // album block's own inset, MessageAttachments), so 72 on a phone, not 64.
      // The photo itself must be on the text column; the caption may sit up to
      // that 8 in until the inset is dropped (then tighten this to 0).
      const photo = row.querySelector('[data-bubble] img')?.getBoundingClientRect().left ?? null;
      if (photo !== null && Math.abs(photo - name) > 1) {
        out.push(`${at}: photo x ${r1(photo)}, not on the name's x ${r1(name)}`);
      }
      if (text < name - 1 || text > name + 9) {
        out.push(`${at}: text x ${r1(text)}, want the name's x ${r1(name)} (+8 at most)`);
      }
      if (window.innerWidth < 768 && Math.abs(name - 64) > 1) {
        out.push(`${at}: name x ${r1(name)} from the screen edge, want 64`);
      }
    });
    return out;
  });
  settleFindings(
    screenName,
    findings.map((message) => ({ check: 'alignment' as const, message })),
  );
}
