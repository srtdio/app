// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_TABS, type AssetTab } from '@/lib/assets';
import { AssetTabs, nextTab } from './AssetTabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZERO: Record<AssetTab, number> = { all: 0, media: 0, docs: 0, links: 0 };

describe('AssetTabs', () => {
  it('a real tablist: All, Media, Docs, Links, in order, always shown, counts only above 0', () => {
    const html = renderToStaticMarkup(
      <AssetTabs value="all" counts={{ ...ZERO, all: 3, media: 3 }} onChange={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    expect([...html.matchAll(/data-asset-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      ...ASSET_TABS,
    ]);
    expect(ASSET_TABS).toEqual(['all', 'media', 'docs', 'links']);
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    const slot = '<span data-asset-tab-count="" class="min-w-[2ch] tabular-nums">';
    expect(html).toContain(`>All</span> ${slot}3</span>`);
    expect(html).toContain(`>Media</span> ${slot}3</span>`);
    // Zero: the slot is reserved (no shift when counts land) but empty.
    for (const label of ['Docs', 'Links']) {
      expect(html).toContain(`>${label}</span>${slot}</span></span></button>`);
    }
    expect(html).not.toContain(`${slot}0</span>`);
    expect(html.match(/data-asset-tab-count=""/g)).toHaveLength(4);
    // The old PDF and Sheets chips are gone.
    expect(html).not.toMatch(/>PDF<|>Sheets<|data-asset-tab="(pdf|sheets)"/);
    // The 44 tap box around the 32 visible chip (12 side padding).
    expect(html).toContain('min-h-11');
    expect(html).toContain('min-h-9 px-4');
    // The shared Chip selected style on the selected tab's visible chip (ink outline).
    expect(html).toMatch(
      /aria-selected="true"[^>]*><span data-chip-face="" class="[^"]*border-fg text-fg\b/,
    );
    expect(html).not.toContain('lit-pill');
    // Tokens only, no hex, no dark: literals: light and dark are the same markup.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:/);
  });

  it('only the selected tab is in the tab order', () => {
    const html = renderToStaticMarkup(<AssetTabs value="docs" counts={ZERO} onChange={() => {}} />);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*data-asset-tab="docs"/);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
  });

  it('arrow keys wrap, Home and End jump', () => {
    expect(nextTab('all', 'ArrowRight')).toBe('media');
    expect(nextTab('links', 'ArrowRight')).toBe('all');
    expect(nextTab('all', 'ArrowLeft')).toBe('links');
    expect(nextTab('media', 'ArrowRight')).toBe('docs');
    expect(nextTab('docs', 'ArrowRight')).toBe('links');
    expect(nextTab('docs', 'Home')).toBe('all');
    expect(nextTab('docs', 'End')).toBe('links');
    expect(nextTab('docs', 'a')).toBeNull();
  });

  it('a key press selects and focuses the next tab', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    await act(async () => {
      root.render(<AssetTabs value="all" counts={ZERO} onChange={onChange} />);
    });
    const all = host.querySelector<HTMLButtonElement>('[data-asset-tab="all"]');
    all?.focus();
    await act(async () => {
      all?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('media');
    expect(document.activeElement?.getAttribute('data-asset-tab')).toBe('media');
    act(() => root.unmount());
    host.remove();
  });
});
