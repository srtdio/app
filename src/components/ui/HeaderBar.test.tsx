// ui/HeaderBar `pinned` / `below`: the exit bar of a screen that opens over the
// app stays pinned while the page scrolls (phone page mode included), with the
// rows that pin with it (the post's checkpoint progress row) in one block.
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { PINNED_BAR_TOP_CLASS, SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';

function html(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

/** The class attribute of the first element carrying `attr`. */
function classOf(out: string, attr: string): string {
  const match = new RegExp(`${attr}=""[^>]*class="([^"]*)"`).exec(out);
  return match?.[1] ?? '';
}

describe('HeaderBar pinned', () => {
  it('unpinned (sheets, panels, root screens): no sticky, the bar keeps its own lit-header', () => {
    const out = html(<HeaderBar title="Group info" onBack={() => {}} />);
    const bar = classOf(out, 'data-header-bar');
    expect(bar).not.toContain('sticky');
    expect(bar).toContain('border-b');
    expect(bar).toContain('lit-header');
    expect(out).not.toContain('data-header-pin=');
  });

  it('pinned alone: the bar itself is sticky at the pinned top, safe area and lit-header kept', () => {
    const out = html(
      <HeaderBar title="Brief" onBack={() => {}} pinned compact className={SAFE_TOP_BAR_CLASS} />,
    );
    const bar = classOf(out, 'data-header-bar');
    expect(bar).toContain('sticky');
    expect(bar).toContain('z-sticky');
    for (const cls of PINNED_BAR_TOP_CLASS.split(' ')) expect(bar).toContain(cls);
    expect(bar).toContain('lit-header');
    expect(bar).toContain('pt-[var(--shell-safe-top,0px)]');
    expect(out).toContain('aria-label="Back"');
  });

  it('pinned with rows below: one sticky block (lit-header on the block), the bar drops its own shade', () => {
    const out = html(
      <HeaderBar
        title="Post"
        onBack={() => {}}
        pinned
        compact
        className={SAFE_TOP_BAR_CLASS}
        below={<div data-pinned-row="">row</div>}
      />,
    );
    const block = classOf(out, 'data-header-pin');
    expect(block).toContain('sticky');
    expect(block).toContain('lit-header');
    expect(block).toContain('bg-panel');
    for (const cls of PINNED_BAR_TOP_CLASS.split(' ')) expect(block).toContain(cls);
    const bar = classOf(out, 'data-header-bar');
    expect(bar).not.toContain('sticky');
    expect(bar).not.toContain('lit-header');
    expect(bar).not.toContain('border-b');
    // The row sits inside the block, after the bar.
    expect(out.indexOf('data-header-bar')).toBeLessThan(out.indexOf('data-pinned-row'));
    expect(out.indexOf('data-pinned-row')).toBeLessThan(out.lastIndexOf('</div>'));
  });

  it('below without pinned is ignored (only a pinned bar has a block)', () => {
    const out = html(<HeaderBar title="x" onBack={() => {}} below={<span data-row="" />} />);
    expect(out).not.toContain('data-row');
    expect(out).not.toContain('data-header-pin=');
  });
});
