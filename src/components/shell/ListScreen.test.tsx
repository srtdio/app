import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ListScreen, SectionSelect, listScreenChipRow } from '@/components/shell/ListScreen';

const SOURCE = readFileSync(fileURLToPath(new URL('./ListScreen.tsx', import.meta.url)), 'utf8');

function html(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

describe('ListScreen: the one list-screen shell', () => {
  it('renders the sr-only h1, the chip row, and the content on the gutter, 16 under', () => {
    const out = html(
      <ListScreen
        title="Pipeline"
        chips={<button type="button">All</button>}
        select={<SectionSelect active={false} onToggle={() => {}} />}
      >
        <p>row</p>
      </ListScreen>,
    );
    expect(out).toContain('<h1 tabindex="-1" class="sr-only">Pipeline</h1>');
    expect(out).toMatch(/data-shell="chips"/);
    expect(out).toMatch(
      /data-chip-row="" class="flex items-center gap-2 pl-4 md:pl-6 pr-1 md:pr-3 mt-3"/,
    );
    expect(out).toContain('<div data-shell="content" class="pt-4 px-4 md:px-6"><p>row</p></div>');
    expect(out).not.toContain('data-shell="lead"');
    expect(out).not.toContain('data-shell="footer"');
  });

  it('with no Select the chip row ends on the gutter', () => {
    const out = html(listScreenChipRow({ chips: <span>chip</span> }));
    expect(out).toContain('pl-4 md:pl-6 pr-4 md:pr-6 mt-3');
  });

  it('a sticky row drops the top gap and pins under the top bar', () => {
    const out = html(listScreenChipRow({ chips: <span>chip</span>, stickyChips: true }));
    expect(out).toMatch(/sticky/);
    expect(out).not.toMatch(/\bmt-3\b/);
  });

  it('carries the chip row hook on its wrapper', () => {
    const out = html(
      listScreenChipRow({ chips: <span>chip</span>, chipsHook: { 'data-pipeline-toolbar': '' } }),
    );
    expect(out.startsWith('<div data-shell="chips" data-pipeline-toolbar="">')).toBe(true);
  });

  it('lead sits 12 under the chips on the gutter; footer on the gutter', () => {
    const out = html(
      <ListScreen title="T" lead={<span>2 of 3 posts</span>} footer={<span>more</span>}>
        <p>row</p>
      </ListScreen>,
    );
    expect(out).toContain(
      '<div data-shell="lead" class="pt-3 px-4 md:px-6"><span>2 of 3 posts</span></div>',
    );
    expect(out).toContain('<div data-shell="footer" class="px-4 md:px-6"><span>more</span></div>');
    expect(out.indexOf('data-shell="lead"')).toBeLessThan(out.indexOf('data-shell="content"'));
  });

  it('is pure render: no hook, no effect, no await', () => {
    expect(SOURCE).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(SOURCE).not.toMatch(/\bawait\b/);
  });
});
