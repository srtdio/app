import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LIST_CARD_BODY,
  LIST_CARD_COVER,
  LIST_CARD_GRID,
  LIST_CARD_LINE1,
  LIST_CARD_LINE2,
  LIST_CARD_PICTURE,
  LIST_CARD_PREVIEW,
  LIST_CARD_SOLID,
  LIST_CARD_SOLID_GROUP,
  LIST_CARD_SOLID_TILE,
  LIST_CARD_STACK,
  LIST_CARD_TEXT,
  LIST_CARD_UNREAD_DOT,
  ListCard,
  ListCardBox,
  listCardFrame,
  listCardTickClass,
  type ListCardProps,
  type ListCardSelect,
} from '@/components/ui/ListCard';
import { tagClass } from '@/components/ui/Tag';
import { IconBriefs } from '@/components/ui/icons';
import { MOVE_CLASS } from '@/lib/motion';
import { ROW_HEIGHT, ROW_INSET, ROW_PICTURE } from '@/components/ui/layout';
import tailwindConfig from '../../../tailwind.config';

function render(over: Partial<ListCardProps> = {}): string {
  return renderToStaticMarkup(
    <ListCard
      picture={{ kind: 'icon', icon: IconBriefs }}
      title="Spring launch"
      preview="Tease the drop"
      time="5m"
      tag="Open"
      onPress={() => {}}
      press={{ 'aria-label': 'Open Spring launch' }}
      {...over}
    />,
  );
}

const noop = (): void => {};
const select = (over: Partial<ListCardSelect> = {}): ListCardSelect => ({
  active: false,
  chosen: false,
  onEnter: noop,
  onToggle: noop,
  ...over,
});

/** The class list of the element carrying `attr`. */
function classOf(html: string, attr: string): string[] {
  const m = new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`).exec(html);
  return (m?.[1] ?? '').split(' ');
}

const spacing = tailwindConfig.theme?.spacing as Record<string, string>;
const extendPadding = tailwindConfig.theme?.extend?.padding as Record<string, string>;
const radius = tailwindConfig.theme?.borderRadius as Record<string, string>;
const px = (rem: string): number => parseFloat(rem) * 16;
const stepPx = (cls: string, prefix: string): number =>
  px(spacing[cls.replace(prefix, '')] ?? extendPadding[cls.replace(prefix, '')] ?? 'NaN');

const find = (tokens: string[], re: RegExp): string => tokens.find((c) => re.test(c)) ?? '';

describe('ListCard frame', () => {
  it('flat row: no border, no radius, no fill, no lit height; bleeds -mx-4 / px-4; press on the whole row', () => {
    const root = classOf(render(), 'data-list-card=""');
    for (const cls of [
      'relative',
      'flex',
      'h-18',
      'min-w-0',
      '-mx-4',
      'px-4',
      'py-3',
      MOVE_CLASS.press,
    ]) {
      expect(root).toContain(cls);
    }
    expect(listCardFrame()).toBe('relative -mx-4 flex h-18 min-w-0 px-4 py-3');
    for (const cls of listCardFrame().split(' ')) {
      expect(cls).not.toMatch(/^(border|rounded|overflow-hidden|bg-|lit-)/);
    }
    expect(root.filter((c) => /^(border|rounded|bg-|lit-)/.test(c))).toEqual([]);
  });

  it('picture then text 12 apart, vertically centred; the frame carries the 16 sides, the body no padding', () => {
    const body = classOf(render(), 'data-list-card-body=""');
    expect(body).toEqual(expect.arrayContaining(['gap-3', 'items-center']));
    expect(body.filter((c) => /^p[xy]?-/.test(c))).toEqual([]);
    expect(px(spacing['3'] ?? '')).toBe(12);
    expect(px(spacing['4'] ?? '')).toBe(16);
  });

  it('rows touch (stack and grid): no gap between rows, 32 between laptop columns', () => {
    expect(LIST_CARD_STACK.split(' ').filter((c) => c.startsWith('gap'))).toEqual([]);
    expect(LIST_CARD_GRID.split(' ').filter((c) => /gap/.test(c))).toEqual(['md:gap-x-8']);
    expect(px(spacing['6'] ?? '')).toBe(24);
  });

  it('the whole card is one button; there is no ⋮ and no other button', () => {
    const html = render();
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).not.toContain('data-list-card-more');
    expect(html).not.toContain('aria-haspopup');
    expect(classOf(html, 'data-list-card-body=""')).toContain('pointer-events-none');
  });

  it('selected is the panel-2 fill; muted greys the title to fg-3; no tap means no press motion', () => {
    expect(classOf(render({ selected: true }), 'data-list-card=""')).toContain('bg-panel-2');
    expect(classOf(render(), 'data-list-card=""')).not.toContain('bg-panel-2');
    expect(listCardFrame(true).split(' ')).toContain('bg-panel-2');
    const muted = render({ muted: true });
    expect(classOf(muted, 'data-list-card=""')).not.toContain('bg-panel-2');
    expect(classOf(muted, 'data-list-card-title=""')).toContain('text-fg-3');
    expect(classOf(render(), 'data-list-card-title=""')).not.toContain('text-fg-3');
    const still = renderToStaticMarkup(
      <ListCard picture={{ kind: 'icon', icon: IconBriefs }} title="Still" />,
    );
    expect(classOf(still, 'data-list-card=""')).not.toContain(MOVE_CLASS.press);
    expect(still).not.toContain('data-list-card-press');
  });
});

describe('ListCard height: one size, 72 (ROW_HEIGHT)', () => {
  it('the classes make inset 12 + picture 48 + inset 12 = 72', () => {
    const frame = listCardFrame().split(' ');
    expect(stepPx(find(frame, /^h-\d/), 'h-')).toBe(ROW_HEIGHT);
    expect(stepPx(find(frame, /^py-/), 'py-')).toBe(ROW_INSET);
    const picture = LIST_CARD_PICTURE.split(' ');
    expect(stepPx(find(picture, /^h-\d/), 'h-')).toBe(ROW_PICTURE);
    expect(stepPx(find(picture, /^w-\d/), 'w-')).toBe(ROW_PICTURE);
    expect(ROW_INSET + ROW_PICTURE + ROW_INSET).toBe(ROW_HEIGHT);
    expect(listCardFrame()).not.toMatch(/(^|\s)(compact|calm):/);
  });

  it('the text column is 20 + 4 + 20 = 44, inside the picture row (it never sets the height)', () => {
    const line = (cls: string): number =>
      stepPx(cls.split(' ').find((c) => /^h-\d/.test(c)) ?? '', 'h-');
    const gap = stepPx(LIST_CARD_TEXT.split(' ').find((c) => /^gap-/.test(c)) ?? '', 'gap-');
    expect(LIST_CARD_TEXT.split(' ')).toContain('gap-1');
    const text = line(LIST_CARD_LINE1) + gap + line(LIST_CARD_LINE2);
    expect(text).toBe(44);
    expect(text).toBeLessThanOrEqual(ROW_HEIGHT);
  });

  it('every variant has the identical height structure (no line 3, line 2 always there)', () => {
    const variants = [
      render(),
      render({ unread: true, tag: undefined, time: undefined }),
      render({ preview: 'x'.repeat(400) }),
      render({ preview: '', tag: undefined }),
      render({ picture: { kind: 'person', name: 'A' }, preview: '' }),
      render({ select: select({ active: true, chosen: true }) }),
    ];
    const shape = (h: string): string[][] =>
      [
        'data-list-card-body=""',
        'data-list-card-picture=',
        'data-list-card-line="1"',
        'data-list-card-line="2"',
      ].map((attr) => classOf(h, attr).filter((c) => /^(h|w|min-h|p|gap)-/.test(c)));
    for (const h of variants) {
      expect(shape(h)).toEqual(shape(variants[0] ?? ''));
      expect(h).toContain('data-list-card-line="2"');
      expect(h).not.toContain('data-list-card-line="3"');
    }
  });
});

describe('ListCard picture: 48 on the left, centred', () => {
  it('the slot is 48x48 (h-12 w-12) and never shrinks; it comes first', () => {
    expect(px(spacing['12'] ?? '')).toBe(48);
    expect(LIST_CARD_PICTURE.split(' ')).toEqual(
      expect.arrayContaining(['h-12', 'w-12', 'shrink-0']),
    );
    expect(LIST_CARD_PICTURE).not.toMatch(/(compact|calm):/);
    const html = render();
    const body = html.indexOf('data-list-card-body');
    expect(html.indexOf('data-list-card-picture', body)).toBeLessThan(
      html.indexOf('data-list-card-title'),
    );
  });

  it('person: a rounded-square photo through ui/Avatar card (48; initials when none)', () => {
    const html = render({ picture: { kind: 'person', name: 'Priya Shah' } });
    expect(html).toContain('data-list-card-picture="person"');
    expect(html).toContain('data-avatar-role="card"');
    expect(html).toContain('h-12 w-12');
    expect(html).not.toContain('width:40px;height:40px');
    expect(html).toContain('rounded-lg');
    expect(html).not.toContain('rounded-full');
    expect(html).toContain('>PS<');
  });

  it('image, icon and placeholder sit in the flat rounded-picture (10) squircle', () => {
    for (const picture of [
      { kind: 'image' as const, node: <img src="https://cdn/x.png" alt="" /> },
      { kind: 'icon' as const, icon: IconBriefs },
      { kind: 'placeholder' as const, placeholder: 'video' as const },
    ]) {
      const html = render({ picture });
      const box = classOf(html, 'data-list-card-picture-box=""');
      expect(box).toEqual(expect.arrayContaining(['rounded-picture', 'overflow-hidden']));
      expect(box).not.toContain('lit-media');
      expect(box).not.toContain('rounded-lg');
    }
    expect(radius.picture).toBe('10px');
    const icon = render({ picture: { kind: 'icon', icon: IconBriefs } });
    expect(icon).toMatch(/bg-panel-2 text-fg-2"><svg[^>]*width="20"/);
    const video = render({ picture: { kind: 'placeholder', placeholder: 'video' } });
    expect(video).toContain('data-post-placeholder="video"');
  });
});

describe('ListCard line 1: title, then the time on the right', () => {
  it('the heading title (one line, truncate), then the meta time (mono, no wrap)', () => {
    const html = render();
    // Read: the heading size at regular weight; unread: the heading's bold.
    const read = classOf(html, 'data-list-card-title=""');
    expect(read).toEqual(expect.arrayContaining(['text-lg', 'font-normal', 'truncate', 'flex-1']));
    expect(read).not.toContain('font-semibold');
    const unread = classOf(render({ unread: true }), 'data-list-card-title=""');
    expect(unread).toEqual(expect.arrayContaining(['text-lg', 'font-semibold']));
    expect(unread).not.toContain('font-normal');
    expect(classOf(html, 'data-list-card-time=""')).toEqual(
      expect.arrayContaining(['font-mono', 'tabular-nums', 'text-fg-3', 'whitespace-nowrap']),
    );
    const line1 = html.slice(
      html.indexOf('data-list-card-line="1"'),
      html.indexOf('data-list-card-line="2"'),
    );
    expect(line1.indexOf('data-list-card-title')).toBeLessThan(
      line1.indexOf('data-list-card-time'),
    );
    expect(LIST_CARD_LINE1.split(' ')).toContain('h-5');
  });

  it('timeBad paints the time in the bad token and marks it; height unchanged', () => {
    const bad = render({ time: '2d late', timeBad: true });
    const time = classOf(bad, 'data-list-card-time=""');
    expect(time).toContain('text-bad');
    expect(time).not.toContain('text-fg-3');
    expect(bad).toContain('data-list-card-time-bad=""');
    expect(bad).toMatch(/data-list-card-time=""[^>]*>2d late</);
    const plain = render({ time: 'Fri' });
    expect(classOf(plain, 'data-list-card-time=""')).not.toContain('text-bad');
    expect(classOf(bad, 'data-list-card-line="1"')).toEqual(
      classOf(plain, 'data-list-card-line="1"'),
    );
  });

  it('no time: the title alone', () => {
    for (const time of [undefined, '']) {
      expect(render({ time })).not.toContain('data-list-card-time');
    }
  });
});

describe('ListCard line 2: preview, tag, unread dot', () => {
  /** Line 2's slots in document order, by their data hooks. */
  function line2Order(html: string): string[] {
    const line = html.slice(html.indexOf('data-list-card-line="2"'));
    return [...line.matchAll(/data-list-card-(preview|spacer|tag|unread)=""/g)].map(
      (m) => m[1] ?? '',
    );
  }

  it('order: preview (one line, truncate), ONE grey tag, then the unread dot', () => {
    const html = render({ unread: true });
    expect(line2Order(html)).toEqual(['preview', 'tag', 'unread']);
    expect(classOf(html, 'data-list-card-preview=""')).toEqual(
      expect.arrayContaining(['text-md', 'text-fg-2', 'truncate']),
    );
    expect(LIST_CARD_PREVIEW).not.toContain('line-clamp');
    expect(html.match(/data-list-card-tag=""/g)).toHaveLength(1);
    expect(html).toContain(tagClass('neutral'));
    expect(LIST_CARD_LINE2.split(' ')).toContain('h-5');
  });

  it('the unread dot: 8px fg, only when unread', () => {
    expect(render()).not.toContain('data-list-card-unread');
    expect(render({ unread: true })).toMatch(
      /data-list-card-unread="" role="img" aria-label="Unread"/,
    );
    expect(LIST_CARD_UNREAD_DOT.split(' ')).toEqual(
      expect.arrayContaining(['h-2', 'w-2', 'rounded-full', 'bg-fg']),
    );
  });

  it('unreadDotHidden: the dot is spoken (sr-only), the title still bolds; off by default', () => {
    const quiet = render({ unread: true, unreadDotHidden: true, tag: 'Post' });
    expect(quiet).toMatch(
      /data-list-card-unread="" role="img" aria-label="Unread" class="sr-only"/,
    );
    expect(quiet).not.toMatch(/data-list-card-title=""[^>]*font-normal/);
    // Every other list keeps the drawn dot.
    expect(render({ unread: true })).toContain(`class="${LIST_CARD_UNREAD_DOT}"`);
  });

  it('with a preview: no spacer, the tag follows the preview', () => {
    expect(line2Order(render({ unread: true }))).toEqual(['preview', 'tag', 'unread']);
  });

  it('no preview: the spacer leads, so the tag sits on the right end under the time', () => {
    for (const preview of [undefined, '']) {
      const html = render({ preview, unread: true });
      expect(line2Order(html)).toEqual(['spacer', 'tag', 'unread']);
      expect(classOf(html, 'data-list-card-spacer=""')).toContain('flex-1');
      // The tag keeps its own width while it fits (never stretched), so it hugs the right end.
      expect(classOf(html, 'data-list-card-tag=""')).toContain('shrink');
      expect(classOf(html, 'data-list-card-tag=""')).not.toContain('flex-1');
    }
    expect(line2Order(render({ preview: '' }))).toEqual(['spacer', 'tag']);
  });

  it('no tag and no preview: line 2 stays (empty)', () => {
    const html = render({ preview: '', tag: undefined });
    expect(html).toContain('data-list-card-line="2"');
    expect(line2Order(html)).toEqual(['spacer']);
  });

  it('the stage dot rides on the tag when given', () => {
    const html = render({ tag: 'Review', tagDot: 'review' });
    expect(html).toMatch(/data-list-card-tag=""[^>]*><span class="[^"]*lit-pill[^"]*">/);
    expect(html).toContain('bg-stage-review');
  });

  it('at most three text roles (heading, secondary, meta) besides the tag', () => {
    const html = render({ unread: true });
    expect(html).toContain('text-lg font-semibold');
    expect(html).toContain('text-md font-normal text-fg-2');
    expect(html).toContain('font-mono text-sm');
    expect(html).not.toMatch(/text-3xl|text-base font-medium|uppercase/);
  });
});

describe('ListCard select mode (long-press / right-click)', () => {
  it('without select: no tick, no callout guard', () => {
    const html = render();
    expect(html).not.toContain('data-list-card-tick');
    expect(classOf(html, 'data-list-card=""')).not.toContain('select-none');
  });

  it('a selectable card never selects text or shows the iOS callout', () => {
    const root = classOf(render({ select: select() }), 'data-list-card=""');
    expect(root).toEqual(expect.arrayContaining(['select-none', '[-webkit-touch-callout:none]']));
  });

  it('the tick is SelectCheck at 20 on the picture corner, hidden (scale 0) outside select mode', () => {
    const html = render({ select: select() });
    expect(html).toContain('data-list-card-tick="hidden"');
    const tick = classOf(html, 'data-list-card-tick=');
    expect(tick).toEqual(
      expect.arrayContaining(['absolute', '-bottom-1', '-right-1', 'h-5', 'w-5', 'rounded-full']),
    );
    expect(tick).toContain('scale-0');
    // Inside the picture slot.
    const pic = html.indexOf('data-list-card-picture=');
    expect(html.indexOf('data-list-card-tick')).toBeGreaterThan(pic);
    expect(html.indexOf('data-list-card-tick')).toBeLessThan(html.indexOf('data-list-card-title'));
  });

  it('chosen: the SelectCheck fill with a check, the panel-2 row fill, aria-pressed; not chosen: the empty SelectCheck ring', () => {
    const on = render({ select: select({ active: true, chosen: true }) });
    expect(on).toContain('data-list-card-tick="on"');
    expect(classOf(on, 'data-list-card-tick=')).toEqual(
      expect.arrayContaining(['bg-accent', 'text-accent-fg', 'scale-100']),
    );
    expect(on).toMatch(/data-list-card-tick="on"[^>]*><svg/);
    expect(classOf(on, 'data-list-card=""')).toContain('bg-panel-2');
    expect(on).toMatch(/<button[^>]*aria-pressed="true"/);
    const off = render({ select: select({ active: true, chosen: false }) });
    expect(off).toContain('data-list-card-tick="off"');
    expect(classOf(off, 'data-list-card-tick=')).toEqual(
      expect.arrayContaining(['border-border-strong', 'bg-panel', 'scale-100']),
    );
    expect(off).not.toMatch(/data-list-card-tick="off"[^>]*><svg/);
    expect(classOf(off, 'data-list-card=""')).not.toContain('bg-panel-2');
    expect(off).toMatch(/<button[^>]*aria-pressed="false"/);
  });

  it('the tick scales in only (mv-slide on transform): no fade, no rotate, no X', () => {
    for (const a of [true, false]) {
      const cls = listCardTickClass(a);
      expect(cls).toContain(MOVE_CLASS.slide);
      expect(cls).not.toMatch(/opacity|rotate|translate-x/);
    }
  });

  it('the footprint never changes in select mode', () => {
    const plain = render({ select: select() });
    const on = render({ select: select({ active: true, chosen: true }) });
    for (const attr of ['data-list-card-body=""', 'data-list-card-picture=']) {
      expect(classOf(on, attr)).toEqual(classOf(plain, attr));
    }
  });
});

describe('LIST_CARD_GRID: the page list', () => {
  it('one column on phone, the named auto-fill columns on laptop; rows touch, 32 between columns', () => {
    expect(LIST_CARD_GRID).toBe('grid grid-cols-1 md:grid-cols-list-cards md:gap-x-8');
    expect(LIST_CARD_GRID.split(' ')).not.toContain('gap-2');
    expect(LIST_CARD_GRID).not.toContain('[');
  });

  it('the laptop columns fill the width, each at least 360 wide', () => {
    const columns = tailwindConfig.theme?.extend?.gridTemplateColumns as
      | Record<string, string>
      | undefined;
    expect(columns?.['list-cards']).toBe('repeat(auto-fill, minmax(360px, 1fr))');
  });

  it('the chat pane keeps the one-column stack, rows touching', () => {
    expect(LIST_CARD_STACK).toBe('flex flex-col');
    expect(LIST_CARD_STACK).not.toContain('grid');
  });
});

describe('ListCardBox: the 72 skeleton', () => {
  it('keeps the flat row frame, the 48 picture and the two 20 lines', () => {
    const html = renderToStaticMarkup(<ListCardBox />);
    expect(html).toContain('data-list-card-box=""');
    expect(html).toContain(`class="${listCardFrame()}"`);
    expect(html).not.toContain('rounded-xl border bg-panel');
    expect(html).toContain('h-12 w-12');
    expect(html).toContain(LIST_CARD_BODY);
    expect(html).toContain(LIST_CARD_LINE1);
    expect(html).toContain(LIST_CARD_LINE2);
    expect(html).not.toContain('min-h-9');
  });
});

describe('ListCard tap target', () => {
  it('the cover button is named by the title, preview and unread dot (no copied text)', () => {
    const html = render({ onPress: () => {}, unread: true, press: {} });
    const button = /<button[^>]*data-list-card-press=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).not.toContain('aria-label=');
    const ids = /aria-labelledby="([^"]+)"/.exec(button)?.[1]?.split(' ') ?? [];
    expect(ids).toHaveLength(3);
    expect(html).toContain(`id="${ids[0]}" data-list-card-title=""`);
    expect(html).toContain(`id="${ids[1]}" data-list-card-preview=""`);
    expect(html).toContain(`id="${ids[2]}" data-list-card-unread=""`);
  });

  it("a caller's own aria-label wins over the visible text", () => {
    const html = render({ onPress: () => {}, press: { 'aria-label': 'Open Spring launch' } });
    const button = /<button[^>]*data-list-card-press=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('aria-label="Open Spring launch"');
    expect(button).not.toContain('aria-labelledby');
  });

  it('the title is a real hit target on a tappable card only', () => {
    const titleTag = (html: string): string =>
      /<span[^>]*data-list-card-title=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(titleTag(render({ onPress: () => {} }))).toContain('pointer-events-auto');
    const still = titleTag(
      renderToStaticMarkup(<ListCard picture={{ kind: 'icon', icon: IconBriefs }} title="S" />),
    );
    expect(still).not.toContain('pointer-events-auto');
  });
});

describe('ListCard lighting: flat rows', () => {
  it('a person picture is ui/Avatar with lit-avatar (the box is not lit-media)', () => {
    const html = render({ picture: { kind: 'person', name: 'Priya Shah' } });
    expect(classOf(html, 'data-list-card-picture-box=""')).not.toContain('lit-media');
    expect(html).toMatch(/data-avatar-role="card"[^>]*class="[^"]*\blit-avatar\b/);
  });

  it('the cover is lit-hover with the inset focus line, edge to edge (no radius)', () => {
    expect(LIST_CARD_COVER.split(' ')).toEqual(
      expect.arrayContaining(['lit-hover', 'focus-visible:lit-focus-inset']),
    );
    expect(LIST_CARD_COVER).not.toMatch(/\brounded/);
  });

  it('the frame carries no lit height in any state; selected and chosen are the panel-2 fill', () => {
    const root = (html: string): string[] => classOf(html, 'data-list-card=""');
    const lits = (html: string): string[] => root(html).filter((c) => c.startsWith('lit-'));
    const fills = (html: string): string[] => root(html).filter((c) => c.startsWith('bg-'));
    for (const html of [
      render(),
      render({ muted: true }),
      render({ selected: true }),
      render({ selected: true, muted: true }),
      render({ muted: true, select: select({ active: true, chosen: true }) }),
    ]) {
      expect(lits(html)).toEqual([]);
    }
    expect(fills(render())).toEqual([]);
    expect(fills(render({ muted: true }))).toEqual([]);
    expect(fills(render({ selected: true }))).toEqual(['bg-panel-2']);
    expect(fills(render({ selected: true, muted: true }))).toEqual(['bg-panel-2']);
    expect(fills(render({ muted: true, select: select({ active: true, chosen: true }) }))).toEqual([
      'bg-panel-2',
    ]);
  });

  it('the tag keeps lit-pill; no shadow, drop-shadow, blur or dark: anywhere', () => {
    const html = render({ unread: true, select: select({ active: true, chosen: true }) });
    expect(html).toContain('lit-pill');
    expect(html).not.toMatch(/shadow-|drop-shadow|backdrop-blur|dark:/);
  });
});

describe('ListCard tag holds the row (11 Nov 2026)', () => {
  it('a long tag cuts with an ellipsis inside the row; the time and the unread dot keep their places', () => {
    const html = render({ tag: 'A very long tag that would run off the row', unread: true });
    const tagPlace = classOf(html, 'data-list-card-tag=""');
    expect(tagPlace).toEqual(expect.arrayContaining(['min-w-0', 'shrink']));
    expect(tagPlace).not.toContain('shrink-0');
    expect(html).toMatch(/text-ellipsis[^"]*">A very long tag that would run off the row<\/span>/);
    expect(classOf(html, 'data-list-card-unread=""')).toContain('shrink-0');
    expect(classOf(html, 'data-list-card-time=""')).toContain('shrink-0');
  });
});

describe('ListCard solid + count (11 Nov 2026)', () => {
  const solid = (over: Partial<ListCardProps> = {}): string =>
    render({ solid: true, count: 7, time: undefined, tag: undefined, ...over });

  it('both default off: a plain row carries no solid class, hook or count slot', () => {
    const html = render({ unread: true });
    expect(html).not.toContain('data-list-card-solid');
    expect(html).not.toContain('data-list-card-count');
    expect(html).not.toMatch(/bg-accent|text-accent-fg|before:|data-count-badge/);
    expect(html).toBe(render({ unread: true, solid: false }));
  });

  it('solid: the ink fill, accent-fg text, the laptop hover, same 72 frame and bleed', () => {
    const html = solid();
    const root = classOf(html, 'data-list-card=""');
    for (const c of LIST_CARD_SOLID.split(' ')) expect(root).toContain(c);
    expect(root).toEqual(
      expect.arrayContaining(['bg-accent', 'text-accent-fg', 'hover:bg-accent-hover']),
    );
    for (const c of listCardFrame().split(' ')) expect(root).toContain(c);
    expect(root).toEqual(expect.arrayContaining(['select-none', MOVE_CLASS.press]));
    expect(classOf(html, 'data-list-card-title=""')).toContain('text-accent-fg');
    expect(classOf(html, 'data-list-card-preview=""')).toContain('text-accent-fg');
    expect(classOf(html, 'data-list-card-preview=""')).not.toContain('text-fg-2');
    expect(html).toContain('data-list-card-solid=""');
  });

  it('solid picture tile: bg-panel with an fg icon in the rounded-picture box', () => {
    const html = solid();
    for (const c of LIST_CARD_SOLID_TILE.split(' ')) expect(html).toContain(c);
    expect(html).toMatch(/aria-hidden="true" class="[^"]*bg-panel text-fg"/);
    expect(html).not.toContain('bg-panel-2');
    expect(classOf(html, 'data-list-card-picture-box=""')).toContain('rounded-picture');
  });

  it('tokens only: no hex, no dark:, no shadow, no fade or slide on a solid row', () => {
    const html = solid();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:|shadow-|drop-shadow|backdrop-blur/);
    expect(html).not.toMatch(/mv-(fade|slide|rise)/);
  });

  it('the seam is a border token in the page background, never a pixel value', () => {
    expect(LIST_CARD_SOLID.split(' ')).toEqual(
      expect.arrayContaining(['before:border-l', 'before:border-t', 'before:border-bg']),
    );
    expect(`${LIST_CARD_SOLID} ${LIST_CARD_SOLID_GROUP}`).not.toMatch(/\[\d+px\]/);
  });

  it('count: the on-fill pill at the right edge of the body, in place of time, tag and dot', () => {
    const html = solid({ time: '5m', tag: 'Open', unread: true });
    expect(html).not.toContain('data-list-card-time');
    expect(html).not.toContain('data-list-card-tag');
    expect(html).not.toContain('data-list-card-unread');
    expect(html).toMatch(
      /data-list-card-count="" aria-hidden="true" class="flex shrink-0 items-center"><span data-count-badge="on-fill"[^>]*>7<\/span><\/span><\/div><\/div>$/,
    );
    expect(solid({ count: 150 })).toContain('>99+</span>');
  });

  it('count 0 or absent: no count slot; a count without solid is the unread pill', () => {
    expect(solid({ count: 0 })).not.toContain('data-list-card-count');
    expect(render({ solid: true })).not.toContain('data-list-card-count');
    const plain = render({ count: 3 });
    expect(plain).toContain('data-count-badge=""');
    expect(plain).not.toContain('data-count-badge="on-fill"');
  });

  it('never selectable: no tick, no time, tag or dot on a solid counted row', () => {
    const html = solid();
    expect(html).not.toContain('data-list-card-tick');
    expect(html).not.toContain('data-list-card-selecting');
  });

  it('the solid group: the list grid, bleeding and clipped, outer corners at md+', () => {
    const group = LIST_CARD_SOLID_GROUP.split(' ');
    for (const c of LIST_CARD_GRID.split(' ')) expect(group).toContain(c);
    expect(group).toEqual(
      expect.arrayContaining(['-mx-4', 'px-4', 'overflow-hidden', 'md:rounded-lg']),
    );
    expect(LIST_CARD_SOLID.split(' ')).toContain('md:only:rounded-lg');
  });
});
