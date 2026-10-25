// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_TABS, type AssetTab } from '@/lib/assets';
import { AssetTabs, nextTab } from './AssetTabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZERO: Record<AssetTab, number> = { all: 0, media: 0, pdf: 0, docs: 0, sheets: 0, links: 0 };

describe('AssetTabs', () => {
  it('a real tablist: all six tabs, in order, always shown, counts only above 0', () => {
    const html = renderToStaticMarkup(
      <AssetTabs value="all" counts={{ ...ZERO, all: 3, media: 3 }} onChange={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    expect([...html.matchAll(/data-asset-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      ...ASSET_TABS,
    ]);
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html).toContain('>All <span class="tabular-nums">3</span>');
    expect(html).toContain('>Media <span class="tabular-nums">3</span>');
    for (const label of ['PDF', 'Docs', 'Sheets', 'Links']) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).not.toContain('<span class="tabular-nums">0</span>');
    expect(html).toContain('min-h-[44px]');
    // The shared Chip selected style on the selected tab.
    expect(html).toMatch(
      /aria-selected="true"[^>]*class="[^"]*bg-accent-soft text-accent border-accent-line/,
    );
    // Tokens only, no hex, no dark: literals: light and dark are the same markup.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:/);
  });

  it('only the selected tab is in the tab order', () => {
    const html = renderToStaticMarkup(<AssetTabs value="pdf" counts={ZERO} onChange={() => {}} />);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*data-asset-tab="pdf"/);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(5);
  });

  it('arrow keys wrap, Home and End jump', () => {
    expect(nextTab('all', 'ArrowRight')).toBe('media');
    expect(nextTab('links', 'ArrowRight')).toBe('all');
    expect(nextTab('all', 'ArrowLeft')).toBe('links');
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
