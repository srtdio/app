import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as SectionHeaderModule from '@/components/shell/SectionHeader';
import { SectionHeader } from '@/components/shell/SectionHeader';

const SRC = readFileSync(fileURLToPath(new URL('./SectionHeader.tsx', import.meta.url)), 'utf8');

describe('SectionHeader: the chip row (decisions B, E)', () => {
  it('has no search field, no sort and no "+" (they live in the top bar)', () => {
    expect(SRC).not.toContain('tone="search"');
    expect(SRC).not.toContain('SortMenu');
    expect(SRC).not.toContain('IconPlus');
    expect(SRC).not.toMatch(/search\?:/);
  });

  it('renders nothing without chips', () => {
    expect(SectionHeader({})).toBeNull();
  });

  it('chips scroll in their own box; the row holds only chips (no Select key)', () => {
    const html = renderToStaticMarkup(
      <SectionHeader>
        <span>chip</span>
      </SectionHeader>,
    );
    expect(html).toMatch(/data-chip-scroll=""[^>]*overflow-x-auto/);
    expect(html).not.toContain('data-chip-row-select');
    expect(html).toContain('px-4 md:px-6');
  });

  it('stickyChildren pins the row under the top bar with a solid lit-header surface', () => {
    const html = renderToStaticMarkup(
      <SectionHeader stickyChildren>
        <span>chip</span>
      </SectionHeader>,
    );
    expect(html).toContain('sticky');
    expect(html).toContain('bg-bg');
    expect(html).toContain('lit-header');
  });
});

describe('no Select key (10 Nov 2026)', () => {
  it('SectionSelect and the select slot are gone: long-press or right-click selects', () => {
    expect('SectionSelect' in SectionHeaderModule).toBe(false);
    expect(SRC).not.toMatch(/\bselect\?:/);
    expect(SRC).not.toContain('data-section-select');
  });
});
