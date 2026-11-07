import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { searchChips } from '@/components/chat/ChannelList';

const noop = (): void => undefined;

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

describe('ChannelList buttons (design system)', () => {
  it('search chips are ui/Chip: 44px, 8px radius, its selected style', () => {
    const tags = buttonTags(renderToStaticMarkup(searchChips({ kind: 'photo', onChange: noop })));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('min-h-11');
      expect(tag).toContain('rounded-lg');
      expect(tag).not.toContain('rounded-full');
      expect(tag).not.toMatch(/\bh-8\b|\bh-9\b|\bh-12\b|rounded-md|font-semibold/);
    }
    const on = tags.find((t) => t.includes('data-search-chip="photo"')) ?? '';
    expect(on).toContain('bg-accent text-accent-fg lit-pill');
    expect(on).toContain('aria-pressed="true"');
  });

  it('only the picked chip carries the X: "Clear <chip> filter", 44x44, the chip ink', () => {
    const html = renderToStaticMarkup(searchChips({ kind: 'photo', onChange: noop }));
    const clears = buttonTags(html).filter((t) => t.includes('data-chip-clear'));
    expect(clears).toHaveLength(1);
    expect(clears[0]).toContain('aria-label="Clear Photos filter"');
    expect(clears[0]).toContain('min-h-11 w-11');
    expect(clears[0]).toContain('text-accent-fg');
    expect(html).not.toMatch(/>All</);
    const none = renderToStaticMarkup(searchChips({ kind: null, onChange: noop }));
    expect(none).not.toContain('data-chip-clear');
  });

  it('the X and the picked chip body both clear the filter', () => {
    const onChange = vi.fn();
    const tree = searchChips({ kind: 'video', onChange });
    const chips = (tree.props as { children: ReactElement[] }).children;
    const video = chips.find((c) => (c.props as { label: string }).label === 'Videos');
    const props = video?.props as { onClear?: () => void; onClick: () => void };
    props.onClear?.();
    props.onClick();
    expect(onChange.mock.calls).toEqual([[null], [null]]);
    const idle = chips.find((c) => (c.props as { label: string }).label === 'Photos');
    expect((idle?.props as { onClear?: () => void }).onClear).toBeUndefined();
  });
});
