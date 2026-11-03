import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_SCROLL_QUERY, TOUCH_TABLET_QUERY } from '@/lib/scroll-mode';

// One device rule for CSS and JS: index.css carries the exact query strings
// exported by src/lib/scroll-mode.ts, so the stylesheet's page-mode rules and
// pageScrollActive() can never drift apart.
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
const sidebar = readFileSync(
  fileURLToPath(new URL('../components/shell/Sidebar.tsx', import.meta.url)),
  'utf8',
);
const sidePanel = readFileSync(
  fileURLToPath(new URL('../components/ui/SidePanel.tsx', import.meta.url)),
  'utf8',
);

/** The body of the first @media block whose query is exactly `query`. */
function mediaBlock(query: string): string {
  const head = `@media ${query} {`;
  const start = css.indexOf(head);
  expect(start, `index.css has "${head}"`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + head.length - 1; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

describe('index.css page mode uses the scroll-mode.ts query verbatim', () => {
  it('page-mode root, safe-area vars and the modal lock sit under PAGE_SCROLL_QUERY', () => {
    const block = mediaBlock(PAGE_SCROLL_QUERY);
    expect(block).toContain('html.scroll-page #root');
    expect(block).toContain('min-height: 100svh;');
    expect(block).toContain('--shell-safe-top: env(safe-area-inset-top, 0px);');
    expect(block).toContain('--shell-sticky-top: calc(3.5rem + env(safe-area-inset-top, 0px));');
    expect(block).toContain("html.scroll-page:has([aria-modal='true'])");
  });

  it('no page-mode rule is left behind on the old phone-only query', () => {
    expect(css).not.toContain('@media (max-width: 767.98px) {\n    html.scroll-page');
  });

  it('on a touch tablet the detail header inside <main> does not pad the status strip twice', () => {
    const block = mediaBlock(TOUCH_TABLET_QUERY);
    expect(block).toMatch(/html\.scroll-page main \{\s*--shell-safe-top: 0px;\s*\}/);
  });
});

describe('Sidebar and SidePanel positioning (no look change)', () => {
  it('Sidebar pins one viewport tall while the document scrolls, safe top on the same surface', () => {
    expect(sidebar).toContain(
      'md:sticky md:top-0 md:h-[100svh] md:self-start pt-[var(--shell-safe-top,0px)]',
    );
    // Same surface classes as before.
    expect(sidebar).toContain('w-[244px] shrink-0 border-r bg-panel lit-side');
  });

  it('SidePanel stays fixed under the top bar (3.5rem when the var is unset)', () => {
    expect(sidePanel).toContain('fixed bottom-0 right-0 top-[var(--shell-sticky-top,3.5rem)]');
  });
});
