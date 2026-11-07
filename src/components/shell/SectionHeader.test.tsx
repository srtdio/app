import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SectionHeader, SectionSelect } from '@/components/shell/SectionHeader';
import { Button } from '@/components/ui/Button';

const SRC = readFileSync(fileURLToPath(new URL('./SectionHeader.tsx', import.meta.url)), 'utf8');

describe('SectionHeader: the chip row (decisions B, E)', () => {
  it('has no search field, no sort and no "+" (they live in the top bar)', () => {
    expect(SRC).not.toContain('tone="search"');
    expect(SRC).not.toContain('SortMenu');
    expect(SRC).not.toContain('IconPlus');
    expect(SRC).not.toMatch(/search\?:/);
  });

  it('renders nothing without chips or select', () => {
    expect(SectionHeader({})).toBeNull();
  });

  it('chips scroll in their own box; Select is pinned at the row end', () => {
    const html = renderToStaticMarkup(
      <SectionHeader select={<SectionSelect active={false} onToggle={() => {}} />}>
        <span>chip</span>
      </SectionHeader>,
    );
    expect(html).toMatch(/data-chip-scroll=""[^>]*overflow-x-auto/);
    expect(html.indexOf('data-chip-row-select')).toBeGreaterThan(html.indexOf('chip</span>'));
    expect(html).toMatch(/data-chip-row-select=""[^>]*class="shrink-0"/);
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

describe('SectionSelect', () => {
  it('a 44-tall ghost Button: IconCheckCircle + "Select", pressed in select mode', () => {
    const onToggle = vi.fn();
    const el = SectionSelect({ active: true, onToggle });
    expect(el.type).toBe(Button);
    const props = el.props as { variant: string; 'aria-pressed': boolean; onClick: () => void };
    expect(props.variant).toBe('ghost');
    expect(props['aria-pressed']).toBe(true);
    props.onClick();
    expect(onToggle).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(<SectionSelect active={false} onToggle={() => {}} />);
    expect(html).toContain('Select');
    expect(html).toContain('h-11');
    expect(html).toContain('data-section-select="off"');
  });
});
