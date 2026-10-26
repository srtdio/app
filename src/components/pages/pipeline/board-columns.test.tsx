import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BoardColumns,
  columnsFor,
  splitIntoColumns,
} from '@/components/pages/pipeline/board-columns';

describe('columnsFor: N = max(1, floor((width + 16) / 236))', () => {
  it('fits as many 220px columns with 16px gaps as the width holds', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(-10)).toBe(1);
    expect(columnsFor(Number.NaN)).toBe(1);
    expect(columnsFor(219)).toBe(1);
    expect(columnsFor(220)).toBe(1);
    expect(columnsFor(455)).toBe(1);
    expect(columnsFor(456)).toBe(2);
    expect(columnsFor(692)).toBe(3);
    expect(columnsFor(928)).toBe(4);
    expect(columnsFor(1164)).toBe(5);
    expect(columnsFor(1163)).toBe(4);
  });
});

describe('splitIntoColumns: card i goes to column i % N', () => {
  it('deals in reading order, newest first left to right', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(splitIntoColumns(items, 3)).toEqual([
      ['a', 'd', 'g'],
      ['b', 'e'],
      ['c', 'f'],
    ]);
    expect(splitIntoColumns(items, 1)).toEqual([items]);
  });

  it('always returns N columns, empty ones when there are fewer cards', () => {
    expect(splitIntoColumns(['a'], 4)).toEqual([['a'], [], [], []]);
    expect(splitIntoColumns([], 2)).toEqual([[], []]);
  });

  it('clamps a bad N to one column', () => {
    expect(splitIntoColumns(['a', 'b'], 0)).toEqual([['a', 'b']]);
  });
});

describe('BoardColumns', () => {
  it('renders independent flex column stacks, no CSS grid, no h-full', () => {
    const html = renderToStaticMarkup(
      <BoardColumns data-board-grid="" className="px-4 py-4 md:px-6">
        <div key="1">one</div>
        <div key="2">two</div>
      </BoardColumns>,
    );
    expect(html).toContain('class="flex items-start gap-4 px-4 py-4 md:px-6"');
    expect(html).toContain('data-board-grid=""');
    expect(html).toContain('class="flex min-w-0 flex-1 flex-col gap-4"');
    expect(html).not.toContain('grid-cols');
    expect(html).not.toContain('h-full');
    expect(html.indexOf('one')).toBeLessThan(html.indexOf('two'));
  });
});
