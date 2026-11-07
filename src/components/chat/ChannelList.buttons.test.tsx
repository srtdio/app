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
  it('search chips are ui/Chip: 44 tap box, 32 visible, full pill, its selected style', () => {
    const html = renderToStaticMarkup(searchChips({ kind: 'photo', onChange: noop }));
    const tags = buttonTags(html);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('min-h-11');
      // The chip's tap box is the full pill; the Clear ghost button beside it keeps its own radius.
      if (tag.includes('data-search-chip')) expect(tag).toContain('rounded-full');
      expect(tag).not.toMatch(/\bh-8\b|\bh-9\b|\bh-12\b|rounded-md|font-semibold/);
    }
    const faces = html.match(/<span data-chip-face=""[^>]*>/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toContain('min-h-8');
      expect(face).toContain('px-3');
      expect(face).toContain('rounded-full');
      expect(face).toContain('text-md');
    }
    const on =
      /<button[^>]*data-search-chip="photo"[^>]*><span data-chip-face=""[^>]*>/.exec(html)?.[0] ??
      '';
    // The pick is the flat ink outline, no fill.
    expect(on).toContain('border-fg text-fg');
    expect(on).not.toMatch(/bg-accent|lit-pill/);
    expect(on).toContain('aria-pressed="true"');
  });

  it('only the picked chip carries Clear: "Clear <chip> filter", 44 tall, ghost ink', () => {
    const html = renderToStaticMarkup(searchChips({ kind: 'photo', onChange: noop }));
    const clears = buttonTags(html).filter((t) => t.includes('data-chip-clear'));
    expect(clears).toHaveLength(1);
    expect(clears[0]).toContain('aria-label="Clear Photos filter"');
    expect(clears[0]).toContain('min-h-11');
    expect(clears[0]).toContain('min-w-11');
    expect(clears[0]).toContain('text-fg-2');
    expect(html).toContain('>Clear<');
    expect(html).not.toMatch(/>All</);
    const none = renderToStaticMarkup(searchChips({ kind: null, onChange: noop }));
    expect(none).not.toContain('data-chip-clear');
  });

  it('Clear and the picked chip body both clear the filter', () => {
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
