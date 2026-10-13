// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ROW_HEIGHT,
  SheetViewer,
  capNote,
  columnLabel,
  rowWindow,
  sheetTitle,
} from '@/components/ui/viewers/SheetViewer';
import { handleOfficeRequest } from '@/lib/files/office/handle';
import { row, xlsx } from '@/lib/files/office/test-fixtures';
import type { SheetView, XlsxView } from '@/lib/files/office/types';

function sheet(over: Partial<SheetView> = {}): SheetView {
  return {
    name: 'Calendar',
    totalRows: 3,
    shownRows: 3,
    shownCols: 3,
    totalCols: 3,
    colWidths: [64, 120, 80],
    merges: [],
    cells: [],
    ...over,
  };
}

function markup(book: XlsxView): string {
  return renderToStaticMarkup(<SheetViewer book={book} scrollerRef={{ current: null }} />);
}

/** A real workbook through the Worker's handler. */
function parsed(bytes: Uint8Array): XlsxView {
  const res = handleOfficeRequest({
    op: 'view',
    bytes: bytes.slice().buffer as ArrayBuffer,
    mime: null,
  });
  if (!res.ok || res.op !== 'view' || res.result.kind !== 'xlsx') throw new Error('not xlsx');
  return res.result;
}

describe('pure helpers', () => {
  it('column letters, the title line and the cap note', () => {
    expect([0, 25, 26, 701, 702].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(sheetTitle(sheet({ totalRows: 31 }))).toBe('Calendar · 31 rows');
    expect(sheetTitle(sheet({ totalRows: 1 }))).toBe('Calendar · 1 row');
    expect(capNote(sheet())).toBeNull();
    expect(capNote(sheet({ totalRows: 5001, shownRows: 5000 }))).toBe(
      'Showing 5,000 of 5,001 rows. Download to see all.',
    );
  });

  it('virtualizes beyond 200 rows: a window near the viewport', () => {
    expect(rowWindow(0, 600, 150)).toEqual({ start: 0, end: 150 });
    const w = rowWindow(ROW_HEIGHT * 1000, 600, 5000);
    expect(w.start).toBeGreaterThan(900);
    expect(w.end - w.start).toBeLessThan(100);
  });
});

describe('the grid', () => {
  it('a hyperlink is text, never <a>; a formula without a value shows its text', () => {
    const book = parsed(
      xlsx([
        {
          name: 'Links',
          xml:
            '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>https://evil.example</t></is></c>' +
            '<c r="B1"><f>1+1</f></c></row></sheetData>' +
            '<hyperlinks><hyperlink ref="A1" r:id="rIdX" xmlns:r="r"/></hyperlinks>',
        },
      ]),
    );
    const html = markup(book);
    expect(html).toContain('https://evil.example');
    expect(html).toContain('=1+1');
    expect(html).not.toMatch(/<a\b|href=/);
  });

  it('merged cells span with colSpan and rowSpan; numbers right-aligned in mono', () => {
    const book = parsed(
      xlsx([
        {
          name: 'S',
          xml:
            `<sheetData>${row(1, ['A', 'Title'])}${row(2, ['A', 'n'], ['B', 1234])}${row(3, ['A', 'x'])}</sheetData>` +
            '<mergeCells><mergeCell ref="A1:B1"/><mergeCell ref="C1:C3"/></mergeCells>',
        },
      ]),
    );
    const html = markup(book);
    expect(html).toMatch(/<td colspan="2" data-merged=""[^>]*>Title<\/td>/i);
    expect(html).toMatch(/<td rowspan="3" data-merged=""/i);
    expect(html).toMatch(/<td class="[^"]*text-right font-mono tabular-nums[^"]*">1234<\/td>/);
  });

  it('5,001 rows: the cap note, and only a window of rows renders', () => {
    let rows = '';
    for (let r = 1; r <= 5001; r++) rows += row(r, ['A', r]);
    const html = markup(parsed(xlsx([{ name: 'Big', xml: `<sheetData>${rows}</sheetData>` }])));
    expect(html).toContain('Showing 5,000 of 5,001 rows. Download to see all.');
    expect(html).toContain('Big · 5,001 rows');
    expect((html.match(/data-row="/g) ?? []).length).toBeLessThan(200);
  });

  it('hidden sheets are not tabs; tabs are 44px and the active one is marked', () => {
    const book = parsed(
      xlsx([
        { name: 'One', xml: `<sheetData>${row(1, ['A', 'a'])}</sheetData>` },
        { name: 'Secret', state: 'hidden', xml: `<sheetData>${row(1, ['A', 's'])}</sheetData>` },
        { name: 'Two', xml: `<sheetData>${row(1, ['A', 'b'])}</sheetData>` },
      ]),
    );
    const html = markup(book);
    expect(html).not.toContain('Secret');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('min-h-[44px] min-w-[44px]');
    expect(html).toMatch(/aria-selected="true"[^>]*data-sheet-tab="One"/);
  });

  it('switching tabs shows the other sheet', async () => {
    const book = parsed(
      xlsx([
        { name: 'One', xml: `<sheetData>${row(1, ['A', 'first'])}</sheetData>` },
        { name: 'Two', xml: `<sheetData>${row(1, ['A', 'second'])}</sheetData>` },
      ]),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<SheetViewer book={book} scrollerRef={{ current: null }} />));
    expect(host.textContent).toContain('first');
    const tab = host.querySelector<HTMLButtonElement>('[data-sheet-tab="Two"]');
    await act(async () => tab?.click());
    expect(host.textContent).toContain('second');
    expect(host.querySelector('[data-sheet-title]')?.textContent).toBe('Two · 1 row');
    act(() => root.unmount());
    host.remove();
  });

  it('light and dark parity: theme tokens only, no hex, no dark: literals, no HTML injection', () => {
    const html = markup({
      kind: 'xlsx',
      sheets: [sheet({ cells: [{ r: 0, c: 0, text: '<b>x</b>', kind: 's' }] })],
    });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:|bg-white|bg-black/);
    const src = readFileSync(
      join(process.cwd(), 'src/components/ui/viewers/SheetViewer.tsx'),
      'utf8',
    );
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});
