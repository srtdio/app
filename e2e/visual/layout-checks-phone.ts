import { expect, test, type Page } from '@playwright/test';
import { layoutMode } from './layout-checks-core';
import {
  formatPhoneViolations,
  PHONE_MAX_WIDTH,
  PHONE_RULE_EXEMPTIONS,
  phoneViolations,
  type PhoneGeom,
  type PhoneItem,
  type PhoneKind,
  type PhoneLine,
  type PhoneRule,
  type PhoneSiblings,
  type PhoneStrip,
} from './layout-checks-phone-core';

// The phone rules (R1, R3, R5, R7 to R13) on every visual screen under 768
// wide: screens.spec.ts capture() and gallery.spec.ts call assertPhoneRules
// beside checkLayout, in the iphone-* projects (390) and in phone-360 and
// phone-320 (playwright.visual.config.ts), which run the checks and take no
// screenshot. One page.evaluate measures (readPhone, below); the judgement is
// pure (layout-checks-phone-core.ts, where each rule and its narrowing is
// written down) and unit tested in src/__tests__/layout-checks-phone.test.ts.
//
// What is measured is VISIBLE INK on the topmost layer:
//   - text: the Range client rects of an element's own text nodes, one box per
//     line, less the empty band over and under the letters (INK_INSET of the
//     line box each side, so the centre stays the line's), cut to every clip
//     above it, the element's own included;
//   - icons: the union of the shapes drawn inside the svg (each shape's
//     getBBox through getCTM, grown by half its stroke; shapes with no fill
//     and no stroke are skipped), placed by the svg's own box (getScreenCTM
//     when that lands outside the svg), never the key's 44 hit box;
//   - pictures (img, [data-list-card-picture], avatars) and controls (button,
//     role button / tab, chip and Clear faces): their box.
// An item counts only when it has a size, is not hidden (display, visibility,
// opacity, sr-only), shows inside the viewport, and the topmost painted
// element at its ink (document.elementsFromPoint, empty see-through hit
// covers such as ListCard's press cover skipped; text: both ends and the
// middle of each line) is the item itself, something inside it, or an
// ancestor: nothing behind a sheet, a dialog, a menu, a pinned bar or a card
// overlay is ever measured.
//
// LAYOUT_CHECKS=strict (the default) fails the screen softly, so the other
// checks still run; LAYOUT_CHECKS=report annotates and logs, as checkLayout.
// R14: the one way to silence a rule is PHONE_RULE_EXEMPTIONS (core file).

export {
  PHONE_RULE_EXEMPTIONS,
  PHONE_TOLERANCE,
  phoneViolations,
} from './layout-checks-phone-core';

const MODE = layoutMode(process.env.LAYOUT_CHECKS);

/** Buttons, tabs and the visible faces of chips, Clear and the top bar "+". */
const CONTROL =
  'button, a[role="button"], [role="button"], [role="tab"], [data-chip-face], [data-clear-face], [data-topbar-plus-face]';
/** R1: the box a text must stay inside (ui/Tag is the lit-pill span). */
const HOLDER = `${CONTROL}, .lit-pill, [data-count-badge]`;
/** R3 by hook: chip and tab labels, dates, times and counts. */
const STAMP =
  '[data-chip-label], [role="tab"], time, [data-list-card-time], [data-count-badge], [data-list-card-count]';
/** R10 / R11: the bars (ui/HeaderBar, the shell top bar, ui/Sheet's header, ui/SelectBar). */
const BAR =
  'header, [data-header-bar], [data-sheet-grab]:not([data-sheet-handle]), [data-select-bar]';
const PICTURE = 'img, video, [data-list-card-picture], [data-avatar-kind]';

interface MeasureArg {
  exemptions: Array<{ rule: PhoneRule; selector: string }>;
  control: string;
  holder: string;
  stamp: string;
  bar: string;
  picture: string;
}

/** One pass over the page: plain geometry out, no judgement. */
async function readPhone(page: Page): Promise<PhoneGeom> {
  const arg: MeasureArg = {
    exemptions: PHONE_RULE_EXEMPTIONS.map(({ rule, selector }) => ({ rule, selector })),
    control: CONTROL,
    holder: HOLDER,
    stamp: STAMP,
    bar: BAR,
    picture: PICTURE,
  };
  return page.evaluate((a: MeasureArg): PhoneGeom => {
    interface R {
      l: number;
      t: number;
      r: number;
      b: number;
    }
    interface Ctx {
      /** Every clip above (hidden, clip, auto, scroll). */
      clip: R;
      /** Only the clips that cut for good (hidden, clip): never a scroller. */
      cut: R;
      scrollsX: boolean;
      moved: boolean;
      framed: boolean;
      follows: boolean;
      inPicture: boolean;
      layer: number;
      scroller: number;
      control: number | null;
      controlEl: Element | null;
      holder: R | null;
      bar: number | null;
      strip: number | null;
    }
    /** The share of a text line box that is empty over, and under, the letters. */
    const INK_INSET = 0.1;
    /** A strip (bar or hairline row) is at most this tall. */
    const STRIP_MAX = 72;
    /** A sideways scroller that does not overflow yet is still a row this short. */
    const SCROLL_ROW_MAX = 96;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const VIEW: R = { l: 0, t: 0, r: vw, b: vh };
    const EVERY: R = { l: -1e6, t: -1e6, r: 1e6, b: 1e6 };
    const rectOf = (el: Element): R => {
      const q = el.getBoundingClientRect();
      return { l: q.left, t: q.top, r: q.right, b: q.bottom };
    };
    const meet = (x: R, y: R): R => ({
      l: Math.max(x.l, y.l),
      t: Math.max(x.t, y.t),
      r: Math.min(x.r, y.r),
      b: Math.min(x.b, y.b),
    });
    const wide = (q: R): number => q.r - q.l;
    const tall = (q: R): number => q.b - q.t;
    const toBox = (q: R): { x: number; y: number; width: number; height: number } => ({
      x: q.l,
      y: q.t,
      width: Math.max(0, wide(q)),
      height: Math.max(0, tall(q)),
    });
    const px = (v: string): number => parseFloat(v) || 0;
    const alpha = (color: string): number => {
      if (color === 'transparent' || color === 'none' || color === '') return 0;
      const m = /\(([^)]*)\)/.exec(color);
      if (m === null) return 1;
      const nums = (m[1] ?? '').split(/[\s,/]+/).filter((p) => /^[\d.+-]/.test(p));
      const value = nums[3];
      if (value === undefined) return 1;
      return value.endsWith('%') ? parseFloat(value) / 100 : parseFloat(value);
    };
    const line = (width: string, color: string): boolean => px(width) > 0 && alpha(color) > 0.05;
    const edges = (s: CSSStyleDeclaration): { t: boolean; r: boolean; b: boolean; l: boolean } => ({
      t: line(s.borderTopWidth, s.borderTopColor),
      r: line(s.borderRightWidth, s.borderRightColor),
      b: line(s.borderBottomWidth, s.borderBottomColor),
      l: line(s.borderLeftWidth, s.borderLeftColor),
    });
    const isFaced = (s: CSSStyleDeclaration): boolean => {
      const e = edges(s);
      return (e.t && e.r && e.b && e.l) || alpha(s.backgroundColor) > 0.05;
    };
    /** A transform that moves sideways, turns or scales (a row mid-swipe). */
    const movedBy = (transform: string): boolean => {
      if (transform === 'none' || transform === '') return false;
      const m = /^matrix\(([^)]+)\)$/.exec(transform);
      if (m === null) return true;
      const p = (m[1] ?? '').split(',').map(Number);
      return (
        Math.abs(p[4] ?? 0) > 0.5 ||
        Math.abs(p[1] ?? 0) > 0.001 ||
        Math.abs((p[0] ?? 1) - 1) > 0.001
      );
    };
    /** An empty, see-through hit cover (ListCard's press cover): it paints nothing. */
    const veils = new Map<Element, boolean>();
    const isVeil = (el: Element): boolean => {
      const known = veils.get(el);
      if (known !== undefined) return known;
      const s = getComputedStyle(el);
      const veil =
        el.childElementCount === 0 &&
        !/\S/.test(el.textContent ?? '') &&
        !/^(IMG|VIDEO|CANVAS|INPUT|TEXTAREA|SELECT|IFRAME)$/i.test(el.tagName) &&
        !(el instanceof SVGElement) &&
        alpha(s.backgroundColor) <= 0.05 &&
        s.backgroundImage === 'none';
      veils.set(el, veil);
      return veil;
    };
    /** Topmost painted thing at this point: the element, something in it, or an ancestor of it. */
    const onTop = (el: Element, x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
      for (const hit of document.elementsFromPoint(x, y)) {
        if (hit === el || el.contains(hit) || hit.contains(el)) return true;
        if (!isVeil(hit)) return false;
      }
      return false;
    };
    const ids = new Map<Element, number>();
    const idOf = (el: Element): number => {
      const known = ids.get(el);
      if (known !== undefined) return known;
      const next = ids.size + 1;
      ids.set(el, next);
      return next;
    };
    const words = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 36);
    const nameOf = (el: Element): string =>
      words(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '');
    const labelOf = (el: Element, text: string): string =>
      `<${el.tagName.toLowerCase()}> "${words(text)}"`;
    const exemptOf = (el: Element): PhoneRule[] => {
      const out: PhoneRule[] = [];
      for (const e of a.exemptions) {
        if (!out.includes(e.rule) && el.closest(e.selector) !== null) out.push(e.rule);
      }
      return out;
    };
    /**
     * How the layout places `box`, walking up from `container` to the first
     * ancestor as wide as the screen. Centred: some ancestor leaves it room
     * and centres it (equal gaps, a centred flex or grid group). Pinned left /
     * right: at every level that leaves room, it sits on that side's content
     * edge (a margin of 32 or less counts as part of it; a larger one is an
     * auto margin's push; a growing flex child keeps its pin), so its x is
     * the layout's and not the flow's.
     */
    const placeIn = (
      container: Element | null,
      box: R,
      self: Element | null,
    ): { centred: boolean; pinLeft: boolean; pinRight: boolean } => {
      let p = container;
      let inner = box;
      let child = self;
      let pinLeft = true;
      let pinRight = true;
      for (let depth = 0; depth < 12 && p !== null && p !== document.body; depth++) {
        const s = getComputedStyle(p);
        const pr = rectOf(p);
        const l = pr.l + px(s.paddingLeft) + px(s.borderLeftWidth);
        const r = pr.r - px(s.paddingRight) - px(s.borderRightWidth);
        if (r - l - wide(inner) > 3) {
          const before = inner.l - l;
          const after = r - inner.r;
          const own = child === null ? null : getComputedStyle(child);
          if (before > 1.5 && Math.abs(before - after) <= 1) {
            return { centred: true, pinLeft: false, pinRight: false };
          }
          const flex = s.display.includes('flex');
          const column = s.flexDirection.startsWith('column');
          if (
            (flex && !column && /center|space-around|space-evenly/.test(s.justifyContent)) ||
            (flex && column && (s.alignItems === 'center' || own?.alignSelf === 'center')) ||
            (s.display.includes('grid') &&
              (s.justifyItems.includes('center') || own?.justifySelf.includes('center') === true))
          ) {
            return { centred: true, pinLeft: false, pinRight: false };
          }
          const part = (margin: string | undefined): number => {
            const m = px(margin ?? '0');
            return m > 0 && m <= 32 ? m : 0;
          };
          // A growing flex child starts where its leading siblings end (the
          // text column beside a picture): still the layout's x.
          const grows = own !== null && px(own.flexGrow) > 0;
          if (before - part(own?.marginLeft) > 3 && !grows) pinLeft = false;
          if (after - part(own?.marginRight) > 3) pinRight = false;
        }
        if (wide(pr) >= vw - 1) return { centred: false, pinLeft, pinRight };
        inner = pr;
        child = p;
        p = p.parentElement;
      }
      return { centred: false, pinLeft, pinRight };
    };
    /** The nearest centring flex row above, and the row's child that holds `el`. */
    const flexRowOf = (el: Element): { row: Element; child: Element } | null => {
      let child = el;
      let p = el.parentElement;
      for (let depth = 0; depth < 4 && p !== null; depth++) {
        const s = getComputedStyle(p);
        if (s.display.includes('flex')) {
          return !s.flexDirection.startsWith('column') && s.alignItems === 'center'
            ? { row: p, child }
            : null;
        }
        child = p;
        p = p.parentElement;
      }
      return null;
    };

    const TEXT_ID = 1_000_000;
    const items: PhoneItem[] = [];
    /** Per item: its flex row's child, to tell which items stand alone in it. */
    const flexChild: Array<Element | null> = [];
    const strips: PhoneStrip[] = [];
    const siblings: PhoneSiblings[] = [];

    const push = (
      el: Element,
      kind: PhoneKind,
      ink: R,
      ctx: Ctx,
      extra: Partial<PhoneItem>,
      text: string,
      ownRow = false,
    ): void => {
      // Text set straight in a centring flex row is its own child of that row.
      const flex = ownRow ? { row: el, child: el } : flexRowOf(el);
      items.push({
        // A control and the text set straight in it are two items of one element.
        id: kind === 'text' ? TEXT_ID + idOf(el) : idOf(el),
        kind,
        label: labelOf(el, text),
        ink: toBox(ink),
        lines: [],
        control: ctx.control,
        holder: null,
        faced: false,
        labelCentred: false,
        name: '',
        framed: ctx.framed,
        centred: false,
        pinLeft: false,
        pinRight: false,
        follows: false,
        align: 'start',
        scrollsX: ctx.scrollsX,
        moved: ctx.moved,
        clipped: false,
        layer: ctx.layer,
        scroller: ctx.scroller,
        bar: ctx.bar,
        strip: ctx.strip,
        flexRow: flex === null ? null : idOf(flex.row),
        solo: false,
        stamp: false,
        cutX: 0,
        hiddenLines: 0,
        pastLeft: 0,
        pastRight: 0,
        exempt: exemptOf(el),
        ...extra,
      });
      flexChild.push(flex === null ? null : flex.child);
    };

    /** A box item (picture or control): whole, on screen and on top, else nothing. */
    const boxShown = (el: Element, rect: R, ctx: Ctx): { clipped: boolean } | null => {
      const shown = meet(meet(rect, ctx.clip), VIEW);
      if (wide(shown) < 1 || tall(shown) < 1) return null;
      if (!onTop(el, (shown.l + shown.r) / 2, (shown.t + shown.b) / 2)) return null;
      const seen = meet(rect, ctx.clip);
      return { clipped: wide(rect) - wide(seen) > 1 || tall(rect) - tall(seen) > 1 };
    };

    const grow = (into: R | null, q: R): R =>
      into === null
        ? q
        : {
            l: Math.min(into.l, q.l),
            t: Math.min(into.t, q.t),
            r: Math.max(into.r, q.r),
            b: Math.max(into.b, q.b),
          };
    /** A shape's stroked bounding box through a matrix, shifted by an origin. */
    const through = (bbox: DOMRect, m: DOMMatrix, stroke: number, ox: number, oy: number): R => {
      const half = (stroke / 2) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [x, y] of [
        [bbox.x, bbox.y],
        [bbox.x + bbox.width, bbox.y],
        [bbox.x, bbox.y + bbox.height],
        [bbox.x + bbox.width, bbox.y + bbox.height],
      ] as const) {
        xs.push(m.a * x + m.c * y + m.e);
        ys.push(m.b * x + m.d * y + m.f);
      }
      return {
        l: ox + Math.min(...xs) - half,
        t: oy + Math.min(...ys) - half,
        r: ox + Math.max(...xs) + half,
        b: oy + Math.max(...ys) + half,
      };
    };
    const within = (q: R | null, rect: R): q is R =>
      q !== null &&
      q.l >= rect.l - 2 &&
      q.t >= rect.t - 2 &&
      q.r <= rect.r + 2 &&
      q.b <= rect.b + 2;

    const measureIcon = (svg: SVGSVGElement, ctx: Ctx): void => {
      const rect = rectOf(svg);
      if (wide(rect) < 2 || tall(rect) < 2) return;
      // Two readings of the same shapes: getCTM answers in the svg's own box
      // (placed by the svg's rect, which carries any CSS shift on the svg, as
      // the ink pull does); getScreenCTM answers on screen. The first that
      // lands inside the svg is the ink; neither: the svg's box stands in.
      let local: R | null = null;
      let screen: R | null = null;
      const shapes = svg.querySelectorAll<SVGGraphicsElement>(
        'path, circle, rect, line, polyline, polygon, ellipse',
      );
      for (const shape of Array.from(shapes)) {
        const s = getComputedStyle(shape);
        if (s.display === 'none' || s.visibility !== 'visible') continue;
        const noFill = alpha(s.fill) === 0;
        const noStroke = alpha(s.stroke) === 0 || px(s.strokeWidth) === 0;
        if (noFill && noStroke) continue;
        const stroke = noStroke ? 0 : px(s.strokeWidth);
        try {
          const bbox = shape.getBBox();
          const own = shape.getCTM();
          const page = shape.getScreenCTM();
          if (own !== null) local = grow(local, through(bbox, own, stroke, rect.l, rect.t));
          if (page !== null) screen = grow(screen, through(bbox, page, stroke, 0, 0));
        } catch {
          continue;
        }
      }
      const drawn = within(local, rect) ? local : within(screen, rect) ? screen : rect;
      const shown = meet(meet(drawn, ctx.clip), VIEW);
      if (wide(shown) < 1 || tall(shown) < 1) return;
      if (wide(drawn) - wide(meet(drawn, ctx.clip)) > 1) return;
      if (!onTop(svg, (shown.l + shown.r) / 2, (shown.t + shown.b) / 2)) return;
      // A key's glyph is centred in its key by construction: what matters is
      // whether the key itself is centred.
      const key = ctx.controlEl;
      const place =
        key !== null
          ? placeIn(key.parentElement, rectOf(key), key)
          : placeIn(svg.parentElement, rect, svg);
      push(svg, 'icon', drawn, ctx, place, svg.getAttribute('aria-label') ?? 'icon');
    };

    const measureText = (el: Element, style: CSSStyleDeclaration, ctx: Ctx): void => {
      if (alpha(style.color) === 0) return;
      const raw: R[] = [];
      let text = '';
      const range = document.createRange();
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE || !/\S/.test(node.textContent ?? '')) continue;
        text += node.textContent ?? '';
        // Word by word: the space a line wraps at hangs past the box and
        // draws nothing, so it is never ink.
        for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          for (const q of Array.from(range.getClientRects())) {
            if (q.width > 0.5 && q.height > 0.5) {
              raw.push({ l: q.left, t: q.top, r: q.right, b: q.bottom });
            }
          }
        }
      }
      if (raw.length === 0) return;
      // One box per line: rects that share most of their height are one line.
      raw.sort((x, y) => x.t - y.t || x.l - y.l);
      const merged: R[] = [];
      for (const q of raw) {
        const last = merged[merged.length - 1];
        const shared = last === undefined ? 0 : Math.min(last.b, q.b) - Math.max(last.t, q.t);
        // Same line and touching (a word space at most): one box. A wider gap
        // is another element's text set inline between (a bold name in a
        // sentence), so the line splits there and never "overlaps" it.
        if (last !== undefined && shared > Math.min(tall(last), tall(q)) / 2 && q.l - last.r <= 8) {
          last.l = Math.min(last.l, q.l);
          last.r = Math.max(last.r, q.r);
          last.t = Math.min(last.t, q.t);
          last.b = Math.max(last.b, q.b);
        } else {
          merged.push({ ...q });
        }
      }
      const lines: PhoneLine[] = [];
      let cutX = 0;
      let hiddenLines = 0;
      let pastLeft = 0;
      let pastRight = 0;
      let clipped = false;
      for (const q of merged) {
        const h = tall(q);
        const ink: R = { l: q.l, r: q.r, t: q.t + h * INK_INSET, b: q.b - h * INK_INSET };
        const kept = meet(ink, ctx.cut);
        if (wide(kept) < 1 || tall(kept) <= tall(ink) * 0.2) {
          hiddenLines += 1;
          continue;
        }
        const shown = meet(ink, ctx.clip);
        if (wide(shown) < 1 || tall(shown) <= tall(ink) * 0.2) continue;
        const seen = meet(shown, VIEW);
        if (wide(seen) < 1 || tall(seen) < 1) continue;
        const y = (seen.t + seen.b) / 2;
        const span = wide(seen);
        const probes = [seen.l + span * 0.1, seen.l + span / 2, seen.r - span * 0.1];
        if (!probes.every((x) => onTop(el, x, y))) continue;
        // Part of the line is scrolled out of its scroller: not a whole item.
        if (wide(kept) - wide(shown) > 1 || tall(kept) - tall(shown) > 1) clipped = true;
        cutX = Math.max(cutX, ctx.cut.l - ink.l, ink.r - ctx.cut.r);
        // Past the screen edge: the ink runs on beyond it and nothing but the
        // screen (or a scroller as wide as it) stops what shows.
        if (shown.l <= 1) pastLeft = Math.max(pastLeft, -ink.l);
        if (shown.r >= vw - 1) pastRight = Math.max(pastRight, ink.r - vw);
        lines.push({
          box: toBox(shown),
          sliceTop: Math.max(0, ctx.cut.t - ink.t),
          sliceBottom: Math.max(0, ink.b - ctx.cut.b),
        });
      }
      if (lines.length === 0) return;
      const ink: R = {
        l: Math.min(...lines.map((l) => l.box.x)),
        t: Math.min(...lines.map((l) => l.box.y)),
        r: Math.max(...lines.map((l) => l.box.x + l.box.width)),
        b: Math.max(...lines.map((l) => l.box.y + l.box.height)),
      };
      const align =
        style.textAlign === 'center'
          ? 'center'
          : style.textAlign === 'right' || style.textAlign === 'end'
            ? 'end'
            : 'start';
      // Inline text after other text on its line (a mention, a link, "more").
      const prev = el.previousSibling;
      const follows =
        ctx.follows ||
        (style.display.startsWith('inline') &&
          prev !== null &&
          ((prev.nodeType === Node.TEXT_NODE && /\S/.test(prev.textContent ?? '')) ||
            (prev instanceof Element &&
              getComputedStyle(prev).display.startsWith('inline') &&
              /\S/.test(prev.textContent ?? ''))));
      push(
        el,
        'text',
        ink,
        ctx,
        {
          lines,
          holder: ctx.holder === null ? null : toBox(ctx.holder),
          ...placeIn(el, ink, null),
          follows,
          align,
          stamp: el.closest(a.stamp) !== null,
          cutX: Math.max(0, cutX),
          hiddenLines,
          pastLeft,
          pastRight,
          clipped,
        },
        text,
        style.display.includes('flex') &&
          !style.flexDirection.startsWith('column') &&
          style.alignItems === 'center',
      );
    };

    /** R13: runs of like siblings (tag, class list, margins) and the gaps between them. */
    const measureSiblings = (el: Element, style: CSSStyleDeclaration, ctx: Ctx): void => {
      if (ctx.moved || el.children.length < 3 || style.display.startsWith('inline')) return;
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? '')) return;
      }
      const kids: Array<{ el: Element; sign: string; rect: R }> = [];
      for (const child of Array.from(el.children)) {
        const s = getComputedStyle(child);
        if (s.display === 'none' || s.display === 'contents') continue;
        if (s.position === 'absolute' || s.position === 'fixed') continue;
        const rect = rectOf(child);
        if (wide(rect) < 1 || tall(rect) < 1) continue;
        const sign = s.display.startsWith('inline')
          ? `inline:${kids.length}`
          : [
              child.tagName,
              child.getAttribute('class') ?? '',
              s.marginTop,
              s.marginRight,
              s.marginBottom,
              s.marginLeft,
            ].join('|');
        kids.push({ el: child, sign, rect });
      }
      let start = 0;
      while (start < kids.length) {
        let end = start + 1;
        while (end < kids.length && kids[end]?.sign === kids[start]?.sign) end += 1;
        const run = kids.slice(start, end);
        start = end;
        const first = run[0];
        if (run.length < 3 || first === undefined) continue;
        const sameTop = run.every((k) => Math.abs(k.rect.t - first.rect.t) <= 1);
        const sameLeft = run.every((k) => Math.abs(k.rect.l - first.rect.l) <= 1);
        if (sameTop === sameLeft) continue;
        const shown = meet(meet(first.rect, ctx.clip), VIEW);
        if (wide(shown) < 1 || tall(shown) < 1) continue;
        if (!onTop(first.el, (shown.l + shown.r) / 2, (shown.t + shown.b) / 2)) continue;
        if (exemptOf(first.el).includes('R13')) continue;
        const gaps: number[] = [];
        for (let i = 0; i + 1 < run.length; i++) {
          const here = run[i];
          const next = run[i + 1];
          if (here === undefined || next === undefined) continue;
          gaps.push(sameTop ? next.rect.l - here.rect.r : next.rect.t - here.rect.b);
        }
        siblings.push({
          label: `${run.length} x ${labelOf(first.el, first.el.textContent ?? '')}`,
          axis: sameTop ? 'x' : 'y',
          gaps,
        });
      }
    };

    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SELECT', 'TEXTAREA', 'HEAD']);

    const walk = (el: Element, ctx: Ctx): void => {
      if (SKIP.has(el.tagName.toUpperCase())) return;
      const style = getComputedStyle(el);
      if (style.display === 'none' || parseFloat(style.opacity) < 0.05) return;
      const rect = rectOf(el);
      // sr-only: a 1px clipped box.
      if (
        (style.position === 'absolute' && style.clip !== 'auto') ||
        style.clipPath.includes('inset(50%)') ||
        (wide(rect) <= 1 && tall(rect) <= 1 && style.overflowX !== 'visible')
      ) {
        return;
      }
      const visible = style.visibility === 'visible';
      if (el instanceof SVGSVGElement) {
        if (visible) measureIcon(el, ctx);
        return;
      }

      // Its own box (a control, a picture) sits under the clips above it.
      const next: Ctx = { ...ctx };
      if (visible && el.matches(a.control)) {
        const shown = boxShown(el, rect, ctx);
        if (shown !== null) {
          push(
            el,
            'control',
            rect,
            ctx,
            {
              faced: isFaced(style),
              labelCentred:
                style.display.includes('flex') &&
                !style.flexDirection.startsWith('column') &&
                style.justifyContent.includes('center'),
              name: nameOf(el),
              clipped: shown.clipped,
              ...placeIn(el.parentElement, rect, el),
            },
            nameOf(el),
          );
        }
        next.control = idOf(el);
        next.controlEl = el;
      }
      if (visible && !ctx.inPicture && el.matches(a.picture)) {
        const shown = boxShown(el, rect, ctx);
        if (shown !== null) {
          push(
            el,
            'picture',
            rect,
            ctx,
            { clipped: shown.clipped, ...placeIn(el.parentElement, rect, el) },
            el.getAttribute('alt') ?? 'picture',
          );
        }
        next.inPicture = true;
        next.framed = true;
      }

      // What is inside it, its own text included, answers to the element.
      if (movedBy(style.transform)) next.moved = true;
      if (style.position === 'fixed' || style.position === 'sticky') next.layer = idOf(el);
      if (el.matches(a.holder)) next.holder = rect;
      if (isFaced(style) && wide(rect) < vw - 2) next.framed = true;
      const prev = el.previousSibling;
      if (
        style.display.startsWith('inline') &&
        prev !== null &&
        prev.nodeType === Node.TEXT_NODE &&
        /\S/.test(prev.textContent ?? '')
      ) {
        next.follows = true;
      }

      // Strips: a bar, or a row between two hairlines.
      const e = edges(style);
      const between: R = {
        l: rect.l,
        r: rect.r,
        t: rect.t + px(style.borderTopWidth),
        b: rect.b - px(style.borderBottomWidth),
      };
      if (tall(rect) <= STRIP_MAX && tall(rect) > 0) {
        if (el.matches(a.bar)) {
          strips.push({
            kind: 'bar',
            label: labelOf(el, el.textContent ?? ''),
            box: toBox(between),
            fullWidth: wide(rect) >= vw - 1,
          });
          next.bar = strips.length - 1;
          next.strip = strips.length - 1;
        } else if ((e.t || e.b) && !e.l && !e.r && wide(rect) >= 160) {
          const before = el.previousElementSibling;
          const after = el.nextElementSibling;
          const lineAbove = e.t || (before !== null && edges(getComputedStyle(before)).b);
          const lineBelow = e.b || (after !== null && edges(getComputedStyle(after)).t);
          if (lineAbove && lineBelow) {
            strips.push({
              kind: 'row',
              label: labelOf(el, el.textContent ?? ''),
              box: toBox(between),
              fullWidth: wide(rect) >= vw - 1,
            });
            next.strip = strips.length - 1;
          }
        }
      }

      // Its clips.
      const ox = style.overflowX;
      const oy = style.overflowY;
      if (ox !== 'visible') {
        next.clip = meet(next.clip, { ...EVERY, l: rect.l, r: rect.r });
        if (ox === 'hidden' || ox === 'clip') {
          next.cut = meet(next.cut, { ...EVERY, l: rect.l, r: rect.r });
        } else {
          // What a scroller hides is scrolled out, never cut: a clip outside
          // it (the box that holds the scroller) no longer counts as a cut.
          next.cut = { ...next.cut, l: EVERY.l, r: EVERY.r };
          // R4: a sideways scroller. overflow-y auto computes overflow-x auto
          // too, so the shape tells a chip row or a rail (short, or at most
          // half the screen and scrolling sideways only) from a page, whose
          // own overflow past the edge is R1's to report.
          if (
            tall(rect) <= SCROLL_ROW_MAX ||
            (tall(rect) <= vh / 2 &&
              el.scrollWidth > el.clientWidth + 1 &&
              el.scrollHeight <= el.clientHeight + 1)
          ) {
            next.scrollsX = true;
          }
        }
      }
      if (oy !== 'visible') {
        next.clip = meet(next.clip, { ...EVERY, t: rect.t, b: rect.b });
        if (oy === 'hidden' || oy === 'clip') {
          next.cut = meet(next.cut, { ...EVERY, t: rect.t, b: rect.b });
        } else {
          next.cut = { ...next.cut, t: EVERY.t, b: EVERY.b };
        }
      }
      if (ox === 'auto' || ox === 'scroll' || oy === 'auto' || oy === 'scroll') {
        next.scroller = idOf(el);
      }

      if (visible) measureText(el, style, next);
      measureSiblings(el, style, next);
      for (const child of Array.from(el.children)) walk(child, next);
    };

    walk(document.body, {
      clip: EVERY,
      cut: EVERY,
      scrollsX: false,
      moved: false,
      framed: false,
      follows: false,
      inPicture: false,
      layer: 0,
      scroller: 0,
      control: null,
      controlEl: null,
      holder: null,
      bar: null,
      strip: null,
    });

    // Alone in its child of the flex row: the only ink there (text: one line).
    const perChild = new Map<Element, number>();
    flexChild.forEach((child, i) => {
      if (child === null || items[i]?.kind === 'control') return;
      perChild.set(child, (perChild.get(child) ?? 0) + 1);
    });
    items.forEach((it, i) => {
      const child = flexChild[i];
      if (child === null || child === undefined) return;
      it.solo = perChild.get(child) === 1 && (it.kind !== 'text' || it.lines.length === 1);
    });

    return { viewport: { width: vw, height: vh }, items, strips, siblings };
  }, arg);
}

/** The rules a parts page runs (gallery.spec.ts): see assertPhoneRules. */
export const PHONE_PART_RULES: readonly PhoneRule[] = ['R1', 'R11', 'R12'];

/**
 * The phone rules (R1, R3, R5, R7 to R13) on the screen as it stands; a no-op
 * at 768 and wider. Collects every finding of the screen and fails once
 * (soft, so the screen's other checks still run), each line naming the
 * screen, its width, the rule, the item and the measured numbers.
 *
 * `rules` narrows the run to some rules for a surface that is not a screen:
 * the parts gallery passes PHONE_PART_RULES, because its cells are narrow
 * boxes that show awkward cases on purpose (a label cut by its cell, parts
 * off the page gutter), so the page rules (R3, R5, R7 to R10, R13) do not
 * apply there. Every app screen runs them all.
 */
export async function assertPhoneRules(
  page: Page,
  screenName: string,
  rules?: readonly PhoneRule[],
): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  if (width === 0 || width >= PHONE_MAX_WIDTH) return;
  const found = phoneViolations(await readPhone(page));
  const violations = rules === undefined ? found : found.filter((v) => rules.includes(v.rule));
  if (violations.length === 0) return;
  const text = formatPhoneViolations(screenName, width, violations);
  if (MODE === 'strict') {
    expect.soft(violations, `phone rules failed (LAYOUT_CHECKS=strict):\n${text}`).toEqual([]);
    return;
  }
  test.info().annotations.push({ type: 'phone-rules', description: text });
  console.warn(`phone rules (report):\n${text}`);
}
