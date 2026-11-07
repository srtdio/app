import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LIST_CARD_BODY,
  LIST_CARD_LINE1,
  LIST_CARD_LINE3,
  LIST_CARD_PICTURE,
  LIST_CARD_PREVIEW,
  LIST_CARD_STACK,
  LIST_CARD_UNREAD_DOT,
  ListCard,
  ListCardBox,
  listCardFrame,
  type ListCardProps,
} from '@/components/ui/ListCard';
import { ActionMenu, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { tagClass } from '@/components/ui/Tag';
import { IconBriefs } from '@/components/ui/icons';
import { MOVE_CLASS } from '@/lib/motion';
import { TRAILING_PULL } from '@/components/ui/layout';
import tailwindConfig from '../../../tailwind.config';

const menu = (
  <ActionMenu
    title="Card"
    items={[{ id: 'x', label: 'Hide', icon: IconBriefs, onSelect: () => {} }]}
    trigger={<ActionMenuTrigger type="button" label="Actions for Card" />}
  />
);

function render(over: Partial<ListCardProps> = {}): string {
  return renderToStaticMarkup(
    <ListCard
      picture={{ kind: 'icon', icon: IconBriefs }}
      title="Spring launch"
      preview="Tease the drop"
      time="10:27 AM"
      tag="Open"
      menu={menu}
      onPress={() => {}}
      press={{ 'aria-label': 'Open Spring launch' }}
      {...over}
    />,
  );
}

/** The class list of the element carrying `attr`. */
function classOf(html: string, attr: string): string[] {
  const m = new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`).exec(html);
  return (m?.[1] ?? '').split(' ');
}

const spacing = tailwindConfig.theme?.spacing as Record<string, string>;
const radius = tailwindConfig.theme?.borderRadius as Record<string, string>;
const px = (rem: string): number => parseFloat(rem) * 16;

describe('ListCard frame', () => {
  it('bordered card: the border token, radius 12, panel fill, lit-card, press on the whole card', () => {
    const root = classOf(render(), 'data-list-card=""');
    for (const cls of ['rounded-xl', 'border', 'bg-panel', 'lit-card', MOVE_CLASS.press]) {
      expect(root).toContain(cls);
    }
    expect(radius.xl).toBe('12px');
    // The same border token the Briefs cards (ui/Card cardSurface) used: the plain `border` edge.
    expect(listCardFrame().split(' ')).toContain('border');
    expect(listCardFrame()).not.toMatch(/\bborder-/);
  });

  it('padding 16, picture then text 12 apart, top-aligned', () => {
    const body = classOf(render(), 'data-list-card-body=""');
    expect(body).toEqual(expect.arrayContaining(['p-4', 'gap-3', 'items-start']));
    expect(px(spacing['4'] ?? '')).toBe(16);
    expect(px(spacing['3'] ?? '')).toBe(12);
    expect(LIST_CARD_BODY).toContain('p-4');
  });

  it('cards stack 12 apart', () => {
    expect(LIST_CARD_STACK.split(' ')).toContain('gap-3');
  });

  it('the whole card is one button; the ⋮ is a sibling, never nested', () => {
    const html = render();
    expect(html.match(/<button/g)?.length).toBe(2);
    const tap = html.indexOf('data-list-card-press');
    expect(html.slice(tap, html.indexOf('Actions for Card'))).toContain('</button>');
    // The content lets taps through to the card button; the ⋮ takes them back.
    expect(classOf(html, 'data-list-card-body=""')).toContain('pointer-events-none');
    expect(classOf(html, 'data-list-card-more=""')).toContain('pointer-events-auto');
  });

  it('selected is lit-selected; muted is lit-card-muted; no tap means no press motion', () => {
    expect(classOf(render({ selected: true }), 'data-list-card=""')).toContain('lit-selected');
    expect(classOf(render({ muted: true }), 'data-list-card=""')).toContain('lit-card-muted');
    const still = renderToStaticMarkup(
      <ListCard picture={{ kind: 'icon', icon: IconBriefs }} title="Still" />,
    );
    expect(classOf(still, 'data-list-card=""')).not.toContain(MOVE_CLASS.press);
    expect(still).not.toContain('data-list-card-press');
  });
});

describe('ListCard picture: 72 on the left', () => {
  it('the slot is 72x72 (h-18 w-18) and never shrinks', () => {
    expect(px(spacing['18'] ?? '')).toBe(72);
    expect(LIST_CARD_PICTURE.split(' ')).toEqual(
      expect.arrayContaining(['h-18', 'w-18', 'shrink-0']),
    );
    const html = render();
    // The picture comes first in the body (left).
    const body = html.indexOf('data-list-card-body');
    expect(html.indexOf('data-list-card-picture', body)).toBeLessThan(
      html.indexOf('data-list-card-title'),
    );
  });

  it('person: a circle photo through ui/Avatar at 72 (initials when none)', () => {
    const html = render({ picture: { kind: 'person', name: 'Priya Shah' } });
    expect(html).toContain('data-list-card-picture="person"');
    expect(html).toContain('data-avatar-role="profile"');
    expect(html).toContain('width:72px;height:72px');
    expect(html).toContain('rounded-full');
    expect(html).toContain('>PS<');
  });

  it('image, icon and placeholder sit in the radius 8 box', () => {
    for (const picture of [
      { kind: 'image' as const, node: <img src="https://cdn/x.png" alt="" /> },
      { kind: 'icon' as const, icon: IconBriefs },
      { kind: 'placeholder' as const, placeholder: 'video' as const },
    ]) {
      const html = render({ picture });
      expect(classOf(html, 'data-list-card-picture=')).toEqual(
        expect.arrayContaining(['rounded-lg', 'overflow-hidden', 'h-18', 'w-18']),
      );
    }
    expect(radius.lg).toBe('8px');
    const icon = render({ picture: { kind: 'icon', icon: IconBriefs } });
    expect(icon).toMatch(/bg-panel-2 text-fg-2"><svg[^>]*width="24"/);
    const video = render({ picture: { kind: 'placeholder', placeholder: 'video' } });
    expect(video).toContain('data-post-placeholder="video"');
  });
});

describe('ListCard lines: three roles plus the tag', () => {
  it('line 1: the heading title (one line, truncate) and nothing else when read', () => {
    const html = render();
    expect(classOf(html, 'data-list-card-title=""')).toEqual(
      expect.arrayContaining(['text-lg', 'font-semibold', 'truncate']),
    );
    expect(LIST_CARD_LINE1.split(' ')).toContain('h-5');
    expect(html).not.toContain('data-list-card-unread');
  });

  it('line 1: the 8px fg unread dot only when unread', () => {
    const html = render({ unread: true });
    expect(html).toMatch(/data-list-card-unread="" role="img" aria-label="Unread"/);
    expect(LIST_CARD_UNREAD_DOT.split(' ')).toEqual(
      expect.arrayContaining(['h-2', 'w-2', 'rounded-full', 'bg-fg']),
    );
  });

  it('line 2: secondary, line-clamp-2 and min-h-9 ALWAYS (even empty)', () => {
    for (const preview of ['Tease the drop', '', undefined]) {
      const html = render(preview === undefined ? { preview: undefined } : { preview });
      const cls = classOf(html, 'data-list-card-preview=""');
      expect(cls).toEqual(
        expect.arrayContaining(['text-md', 'text-fg-2', 'line-clamp-2', 'min-h-9']),
      );
      expect(cls).not.toContain('truncate');
    }
    expect(px(spacing['9'] ?? '')).toBe(36);
    expect(LIST_CARD_PREVIEW).toContain('min-h-9');
  });

  it('line 3: meta time, ONE grey Tag, then the ⋮ with the trailing pull', () => {
    const html = render();
    expect(classOf(html, 'data-list-card-time=""')).toEqual(
      expect.arrayContaining(['font-mono', 'tabular-nums', 'text-fg-3']),
    );
    expect(html.match(/data-list-card-tag=""/g)).toHaveLength(1);
    expect(html).toContain(tagClass('neutral'));
    expect(html).toMatch(new RegExp(`aria-label="Actions for Card"[^>]*${TRAILING_PULL}`));
    expect(classOf(html, 'data-list-card-more=""')).toContain('-my-3');
    expect(LIST_CARD_LINE3.split(' ')).toContain('h-5');
    // Order: time, tag, then the ⋮.
    expect(html.indexOf('10:27 AM')).toBeLessThan(html.indexOf('>Open<'));
    expect(html.indexOf('>Open<')).toBeLessThan(html.indexOf('Actions for Card'));
  });

  it('at most three text roles (heading, secondary, meta) besides the tag', () => {
    const html = render({ unread: true });
    expect(html).toContain('text-lg font-semibold');
    expect(html).toContain('text-md font-normal text-fg-2');
    expect(html).toContain('font-mono text-sm');
    expect(html).not.toMatch(/text-3xl|text-base font-medium|uppercase/);
  });

  it('a select check takes the ⋮ slot (same footprint)', () => {
    const html = render({ check: <span data-check="" /> });
    expect(html).toMatch(/data-list-card-more=""[^>]*><span data-check=""/);
    expect(html).not.toContain('Actions for Card');
  });

  it('every card variant has the identical height structure', () => {
    const variants = [
      render(),
      render({ unread: true, tag: undefined, time: undefined }),
      render({ preview: 'x'.repeat(400), menu: undefined }),
      render({ picture: { kind: 'person', name: 'A' }, preview: '' }),
      render({ check: <span /> }),
    ];
    const shape = (h: string): string[][] =>
      [
        'data-list-card-body=""',
        'data-list-card-picture=',
        'data-list-card-line="1"',
        'data-list-card-preview=""',
        'data-list-card-line="3"',
      ].map((attr) => classOf(h, attr).filter((c) => /^(h|w|min-h|p|gap|line-clamp)-/.test(c)));
    for (const h of variants) expect(shape(h)).toEqual(shape(variants[0] ?? ''));
  });
});

describe('ListCardBox', () => {
  it('the loading box keeps the card frame, the 72 picture and the 2-line preview height', () => {
    const html = renderToStaticMarkup(<ListCardBox />);
    expect(html).toContain('data-list-card-box=""');
    expect(html).toContain('rounded-xl border bg-panel');
    expect(html).toContain('h-18 w-18');
    expect(html).toContain('min-h-9');
  });
});

describe('ListCard tap target', () => {
  it('the cover button is named by the title, unread dot and preview (no copied text)', () => {
    const html = render({ onPress: () => {}, unread: true });
    const button = /<button[^>]*data-list-card-press=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).not.toContain('aria-label=');
    const ids = /aria-labelledby="([^"]+)"/.exec(button)?.[1]?.split(' ') ?? [];
    expect(ids).toHaveLength(3);
    expect(html).toContain(`id="${ids[0]}" data-list-card-title=""`);
    expect(html).toContain(`id="${ids[1]}" data-list-card-unread=""`);
    expect(html).toContain(`id="${ids[2]}" data-list-card-preview=""`);
  });

  it("a caller's own aria-label wins over the visible text", () => {
    const html = render({ onPress: () => {}, press: { 'aria-label': 'Open Spring launch' } });
    const button = /<button[^>]*data-list-card-press=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('aria-label="Open Spring launch"');
    expect(button).not.toContain('aria-labelledby');
  });

  it('the title is a real hit target on a tappable card (it hands the click to the card)', () => {
    const tappable = render({ onPress: () => {} });
    expect(tappable).toMatch(
      /<span[^>]*data-list-card-title=""[^>]*class="[^"]*pointer-events-auto/,
    );
    const still = render({});
    expect(still).not.toMatch(/data-list-card-title=""[^>]*pointer-events-auto/);
  });
});
