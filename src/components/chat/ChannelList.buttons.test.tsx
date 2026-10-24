import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { rowMoreClass, searchChips } from '@/components/chat/ChannelList';

const noop = (): void => undefined;

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

describe('ChannelList buttons (design system)', () => {
  it('search chips are the shared 44px, 8px-radius button', () => {
    const tags = buttonTags(renderToStaticMarkup(searchChips({ kind: 'photo', onChange: noop })));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('h-11');
      expect(tag).toContain('rounded-lg');
      expect(tag).not.toContain('rounded-full');
      expect(tag).not.toMatch(/\bh-8\b|\bh-9\b|\bh-12\b|rounded-md|font-semibold/);
    }
    const on = tags.find((t) => t.includes('data-search-chip="photo"')) ?? '';
    expect(on).toContain('bg-accent-soft');
    expect(on).toContain('aria-pressed="true"');
  });

  it('the row menu button is 44x44 with the 8px radius', () => {
    for (const kind of ['wide', 'square'] as const) {
      const cls = rowMoreClass(kind);
      expect(cls).toContain('h-11 w-11');
      expect(cls).toContain('rounded-lg');
      expect(cls).not.toContain('rounded-md');
    }
  });
});
