// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIST_CARD_SUB_INSET,
  LIST_CARD_TAG_TOGGLE,
  ListCard,
  type ListCardProps,
} from '@/components/ui/ListCard';
import { IconBriefs } from '@/components/ui/icons';
import { MOVE_CLASS } from '@/lib/motion';

// ListCard's shared tagToggle: the one grey tag as a fold toggle with a
// chevron, a 44 hit box above the cover, its own tap only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(over: Partial<ListCardProps> = {}): ReactElement {
  return (
    <ListCard
      picture={{ kind: 'icon', icon: IconBriefs }}
      title="Q3 Launch"
      preview="+2 more"
      time="5m"
      tag="3 updates"
      onPress={() => {}}
      {...over}
    />
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ListCard tagToggle', () => {
  it('without tagToggle the tag stays the plain Tag (no button, no chevron)', () => {
    const html = renderToStaticMarkup(card());
    expect(html).not.toContain('data-list-card-tag-toggle');
    expect(html).not.toContain('data-list-card-tag-chevron');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('renders the tag as a button with aria-expanded, a name and the turning chevron', () => {
    const html = renderToStaticMarkup(
      card({ tagToggle: { open: false, onToggle: () => {}, hooks: { 'data-x-toggle': '' } } }),
    );
    expect(html).toMatch(/data-list-card-tag=""[^>]*><button/);
    expect(html).toContain('data-x-toggle=""');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show 3 updates"');
    expect(html).toContain(MOVE_CLASS.turn);
    expect(html).not.toContain('rotate-180');
    const open = renderToStaticMarkup(
      card({ tagToggle: { open: true, onToggle: () => {}, label: 'Hide them' } }),
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-label="Hide them"');
    expect(open).toContain('rotate-180');
  });

  it('the hit box is 44, live above the cover, and keeps line 2 and the row height', () => {
    for (const cls of ['min-h-11', 'min-w-11', '-my-3', 'pointer-events-auto', 'z-raised']) {
      expect(LIST_CARD_TAG_TOGGLE.split(' ')).toContain(cls);
    }
    expect(LIST_CARD_TAG_TOGGLE).not.toMatch(/z-\[|\[\d+px\]/);
    const html = renderToStaticMarkup(card({ tagToggle: { open: false, onToggle: () => {} } }));
    expect(html).toMatch(/data-list-card=""[^>]*class="[^"]*\bh-18\b/);
  });

  it('a tap runs onToggle only, never the card tap', () => {
    const onPress = vi.fn();
    const onToggle = vi.fn();
    act(() => root?.render(card({ onPress, tagToggle: { open: false, onToggle } })));
    act(() => host?.querySelector<HTMLElement>('[data-list-card-tag-toggle]')?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('LIST_CARD_SUB_INSET puts unfolded rows on the text column per density', () => {
    // 48 picture + 12 gap = 60 (pl-15) Cozy and Calm; 40 + 12 = 52 (pl-13) Compact.
    expect(LIST_CARD_SUB_INSET.split(' ')).toEqual(['pl-15', 'compact:pl-13']);
  });
});
