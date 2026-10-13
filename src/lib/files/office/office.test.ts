import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { DOC_HTML_BUDGET } from './docx';
import { handleOfficeRequest } from './handle';
import { runOffice, type OfficeWorkerLike } from './run';
import { PNG_1X1, docx, encryptedOffice, p, pptx, row, xlsx } from './test-fixtures';
import {
  CELL_TEXT_CAP,
  DOCX_MIME,
  OFFICE_MAX_BYTES,
  SHEET_ROW_CAP,
  XLSX_MIME,
  type DocxView,
  type OfficeRequest,
  type OfficeResponse,
  type XlsxView,
} from './types';
import { decodeEntities, parseXmlTree, scanXml, XmlError } from './xml';
import {
  BOOK_TEXT_BUDGET,
  MAX_MERGES,
  columnPx,
  formatGeneral,
  formatNumber,
  formatSerialDate,
  parseFormat,
} from './xlsx';
import { readZipDirectory, readZipEntry, ZipError } from './zip';

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function view(bytes: Uint8Array, mime: string | null = null): OfficeResponse {
  return handleOfficeRequest({ op: 'view', bytes: buf(bytes), mime });
}

function docView(bytes: Uint8Array): DocxView {
  const res = view(bytes);
  if (!res.ok || res.op !== 'view' || res.result.kind !== 'docx') {
    throw new Error(`not a docx view: ${JSON.stringify(res)}`);
  }
  return res.result;
}

function bookView(bytes: Uint8Array): XlsxView {
  const res = view(bytes);
  if (!res.ok || res.op !== 'view' || res.result.kind !== 'xlsx') {
    throw new Error(`not an xlsx view: ${JSON.stringify(res)}`);
  }
  return res.result;
}

describe('xml', () => {
  it('decodes only the predefined entities and numeric references', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; &#65;&#x42; &nbsp; &#xD800;')).toBe(
      'a <b> & AB &nbsp; &#xD800;',
    );
  });

  it('refuses a DTD outright (no entity expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "xx">]><a>&x;</a>';
    expect(() => parseXmlTree(bomb)).toThrow(XmlError);
  });

  it('reads local names, attributes and text; malformed input throws', () => {
    const tree = parseXmlTree('<w:p a:b="1 &amp; 2"><w:t>hi</w:t></w:p>');
    const node = tree.children[0];
    expect(typeof node !== 'string' && node?.name).toBe('p');
    expect(typeof node !== 'string' && node?.attrs.b).toBe('1 & 2');
    expect(() => scanXml('<a><b></a>', { open() {}, close() {}, text() {} })).toThrow(XmlError);
    expect(() => parseXmlTree('<a>')).toThrow(XmlError);
    expect(() => parseXmlTree('<a b=c/>')).toThrow(XmlError);
  });
});

describe('zip', () => {
  it('caps an entry while it inflates (zip bomb)', () => {
    const bomb = zipSync({ 'x.xml': new Uint8Array(4 * 1024 * 1024) });
    const entry = readZipDirectory(bomb).get('x.xml');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(() => readZipEntry(bomb, { ...entry, size: 1000 }, 1000 * 2)).toThrow(ZipError);
    expect(readZipEntry(bomb, entry, 8 * 1024 * 1024).length).toBe(4 * 1024 * 1024);
  });

  it('refuses an encrypted entry as locked', () => {
    const z = zipSync({ 'a.txt': strToU8('hi') });
    const entry = readZipDirectory(z).get('a.txt');
    if (entry === undefined) throw new Error('missing');
    expect(() => readZipEntry(z, { ...entry, flags: 1 }, 100)).toThrow(
      expect.objectContaining({ code: 'locked' }),
    );
  });
});

describe('guards', () => {
  it('over 20 MiB is too_large before any parse', () => {
    const res = handleOfficeRequest({
      op: 'view',
      bytes: new ArrayBuffer(OFFICE_MAX_BYTES + 1),
      mime: DOCX_MIME,
    });
    expect(res).toEqual({ ok: false, reason: 'too_large' });
  });

  it('corrupt bytes are an error, never a partial render', () => {
    expect(view(strToU8('not a zip at all'))).toEqual({ ok: false, reason: 'corrupt' });
    const truncated = docx({ body: p('Hello') }).slice(0, 200);
    expect(view(truncated).ok).toBe(false);
  });

  it('a password-protected (OLE2) file is locked', () => {
    expect(view(encryptedOffice())).toEqual({ ok: false, reason: 'locked' });
    expect(handleOfficeRequest({ op: 'thumb', bytes: buf(encryptedOffice()), mime: null })).toEqual(
      {
        ok: false,
        reason: 'locked',
      },
    );
  });

  it("the package's own main part decides the kind; a stated mime must agree", () => {
    expect(view(docx({ body: p('x') }), XLSX_MIME)).toEqual({ ok: false, reason: 'mismatch' });
    expect(view(docx({ body: p('x') }), DOCX_MIME).ok).toBe(true);
  });

  it('pptx is unsupported (Preview not available yet), for view and thumb', () => {
    expect(view(pptx())).toEqual({ ok: true, op: 'view', result: { kind: 'unsupported' } });
    expect(handleOfficeRequest({ op: 'thumb', bytes: buf(pptx()), mime: null })).toEqual({
      ok: true,
      op: 'thumb',
      result: { kind: 'unsupported' },
    });
  });
});

describe('docx', () => {
  it('writes escaped text, headings and run formatting', () => {
    const doc = docView(
      docx({
        body:
          p('Diwali brief', 'Title') +
          p('1. Objective', 'Heading1') +
          '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t> &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>',
        pages: 4,
      }),
    );
    const html = doc.pages.join('');
    expect(html).toContain('<h1 class="title">Diwali brief</h1>');
    expect(html).toContain('<h2>1. Objective</h2>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(doc.pageCount).toBe(4);
  });

  it('a hyperlink keeps its text but never becomes a link', () => {
    const html = docView(
      docx({
        body: '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>Open me</w:t></w:r></w:hyperlink></w:p>',
        rels: [{ id: 'rIdL', type: 'hyperlink', target: 'https://evil.example', external: true }],
      }),
    ).pages.join('');
    expect(html).toContain('Open me');
    expect(html).not.toMatch(/<a\b|href|evil\.example/);
  });

  it('embedded pictures become data: URIs; external pictures are dropped', () => {
    const drawing = (id: string): string =>
      `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><wp:extent cx="952500" cy="476250"/><a:graphic xmlns:a="y"><a:blip r:embed="${id}"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const html = docView(
      docx({
        body: drawing('rIdImg') + drawing('rIdExt'),
        rels: [
          { id: 'rIdImg', type: 'image', target: 'media/image1.png' },
          {
            id: 'rIdExt',
            type: 'image',
            target: 'https://tracker.example/pixel.png',
            external: true,
          },
        ],
        files: { 'word/media/image1.png': PNG_1X1 },
      }),
    ).pages.join('');
    expect(html).toMatch(
      /<img alt="" src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="100" height="50">/,
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).not.toContain('tracker.example');
  });

  it('an SVG or unknown picture is never embedded', () => {
    const html = docView(
      docx({
        body: '<w:p><w:r><w:drawing><a:blip xmlns:a="y" r:embed="rIdSvg"/></w:drawing></w:r></w:p>',
        rels: [{ id: 'rIdSvg', type: 'image', target: 'media/x.svg' }],
        files: { 'word/media/x.svg': strToU8('<svg onload="alert(1)"/>') },
      }),
    ).pages.join('');
    expect(html).not.toContain('<img');
  });

  it('splits pages at explicit page breaks; deleted text and field codes are skipped', () => {
    const doc = docView(
      docx({
        body:
          p('One') +
          '<w:p><w:r><w:br w:type="page"/><w:t>Two</w:t></w:r></w:p>' +
          '<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r></w:p>',
      }),
    );
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[1]).toContain('Two');
    expect(doc.pages.join('')).not.toMatch(/gone|HYPERLINK/);
  });

  it('tables keep colspan and rowspan', () => {
    const tc = (text: string, pr = ''): string => `<w:tc><w:tcPr>${pr}</w:tcPr>${p(text)}</w:tc>`;
    const html = docView(
      docx({
        body:
          '<w:tbl>' +
          `<w:tr>${tc('Wide', '<w:gridSpan w:val="2"/>')}${tc('Tall', '<w:vMerge w:val="restart"/>')}</w:tr>` +
          `<w:tr>${tc('a')}${tc('b')}${tc('', '<w:vMerge/>')}</w:tr>` +
          '</w:tbl>',
      }),
    ).pages.join('');
    expect(html).toContain('<td colspan="2">');
    expect(html).toContain('<td rowspan="2">');
  });

  it(`a document over ${DOC_HTML_BUDGET.toLocaleString('en-US')} HTML characters is too large to open in place`, () => {
    const quotes = '&quot;'.repeat(DOC_HTML_BUDGET / 5);
    const bytes = docx({ body: `<w:p><w:r><w:t>${quotes}</w:t></w:r></w:p>` });
    expect(view(bytes)).toEqual({ ok: false, reason: 'too_large' });
    // The thumbnail still reads its text.
    expect(handleOfficeRequest({ op: 'thumb', bytes: buf(bytes), mime: null }).ok).toBe(true);
  });

  it('the thumbnail text is a title and the first paragraphs, no pictures', () => {
    const res = handleOfficeRequest({
      op: 'thumb',
      bytes: buf(docx({ body: p('Brief', 'Title') + p('First paragraph.') + p('Second.') })),
      mime: null,
    });
    expect(res).toMatchObject({
      ok: true,
      op: 'thumb',
      result: { kind: 'docx', title: 'Brief', paragraphs: ['First paragraph.', 'Second.'] },
    });
  });
});

describe('xlsx', () => {
  it('a formula with no cached value shows its text, never a result', () => {
    const book = bookView(
      xlsx([
        {
          name: 'Calc',
          xml: '<sheetData><row r="1"><c r="A1"><f>1+1</f></c><c r="B1"><f>2+2</f><v>4</v></c></row></sheetData>',
        },
      ]),
    );
    const cells = book.sheets[0]?.cells ?? [];
    expect(cells.find((c) => c.c === 0)?.text).toBe('=1+1');
    expect(cells.find((c) => c.c === 1)?.text).toBe('4');
  });

  it('hidden and very hidden sheets are absent; tabs keep workbook order', () => {
    const book = bookView(
      xlsx([
        { name: 'One', xml: `<sheetData>${row(1, ['A', 'x'])}</sheetData>` },
        { name: 'Secret', state: 'hidden', xml: `<sheetData>${row(1, ['A', 's'])}</sheetData>` },
        { name: 'Deep', state: 'veryHidden', xml: '<sheetData/>' },
        { name: 'Two', xml: `<sheetData>${row(1, ['A', 'y'])}</sheetData>` },
      ]),
    );
    expect(book.sheets.map((s) => s.name)).toEqual(['One', 'Two']);
  });

  it('merged cells, widths clamped 48..320, shared strings and numbers', () => {
    const book = bookView(
      xlsx(
        [
          {
            name: 'S',
            xml:
              '<cols><col min="1" max="1" width="2"/><col min="2" max="2" width="200"/><col min="3" max="3" width="12"/></cols>' +
              '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="C2"><v>1234.5</v></c></row></sheetData>' +
              '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>',
          },
        ],
        ['Header'],
      ),
    );
    const sheet = book.sheets[0];
    expect(sheet?.merges).toEqual([{ r0: 0, c0: 0, r1: 0, c1: 2 }]);
    expect(sheet?.colWidths).toEqual([48, 320, 84]);
    expect(sheet?.cells).toContainEqual({ r: 0, c: 0, text: 'Header', kind: 's' });
    expect(sheet?.cells).toContainEqual({ r: 1, c: 2, text: '1234.5', kind: 'n' });
  });

  it(`shows the first ${SHEET_ROW_CAP} rows and counts the rest`, () => {
    let rows = '';
    for (let r = 1; r <= SHEET_ROW_CAP + 1; r++) rows += row(r, ['A', r]);
    const sheet = bookView(xlsx([{ name: 'Big', xml: `<sheetData>${rows}</sheetData>` }]))
      .sheets[0];
    expect(sheet?.totalRows).toBe(SHEET_ROW_CAP + 1);
    expect(sheet?.shownRows).toBe(SHEET_ROW_CAP);
    expect(sheet?.cells).toHaveLength(SHEET_ROW_CAP);
  });

  it(`caps a long cell at ${CELL_TEXT_CAP} characters`, () => {
    const long = 'x'.repeat(CELL_TEXT_CAP + 500);
    const sheet = bookView(
      xlsx([{ name: 'L', xml: `<sheetData>${row(1, ['A', long])}</sheetData>` }]),
    ).sheets[0];
    expect(sheet?.cells[0]?.text.length).toBe(CELL_TEXT_CAP);
  });

  it('one long shared string in every cell cannot blow up the copy out of the Worker', () => {
    const long = 'y'.repeat(CELL_TEXT_CAP);
    let rows = '';
    const perRow = 20;
    for (let r = 1; r <= 400; r++) {
      let cells = '';
      for (let c = 0; c < perRow; c++)
        cells += `<c r="${String.fromCharCode(65 + c)}${r}" t="s"><v>0</v></c>`;
      rows += `<row r="${r}">${cells}</row>`;
    }
    const sheet = bookView(xlsx([{ name: 'Bomb', xml: `<sheetData>${rows}</sheetData>` }], [long]))
      .sheets[0];
    const kept = (sheet?.cells ?? []).reduce((n, c) => n + c.text.length, 0);
    expect(kept).toBeLessThanOrEqual(BOOK_TEXT_BUDGET);
    expect(sheet?.totalRows).toBe(400);
    expect(sheet?.shownRows).toBeLessThan(400);
    // Whole rows only.
    expect(sheet?.cells.length).toBe((sheet?.shownRows ?? 0) * perRow);
  });

  it('columns past the cap are counted (for the cap note); phonetic text stays out', () => {
    const sheet = bookView(
      xlsx([
        {
          name: 'Wide',
          xml:
            '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>漢字</t></r><rPh sb="0" eb="2"><t>かんじ</t></rPh></is></c>' +
            '<c r="IW1"><v>1</v></c></row></sheetData>',
        },
      ]),
    ).sheets[0];
    expect(sheet?.cells[0]?.text).toBe('漢字');
    expect(sheet?.totalCols).toBe(257);
    expect(sheet?.shownCols).toBe(1);
  });

  it('an unterminated entity run stays linear', () => {
    const start = Date.now();
    expect(decodeEntities('&'.repeat(200_000)).length).toBe(200_000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('many overlapping merges collapse to non-overlapping ones (bounded merge index)', () => {
    const merges =
      '<mergeCell ref="A1:Z300"/>'.repeat(MAX_MERGES * 2) + '<mergeCell ref="AA1:AB2"/>';
    const sheet = bookView(
      xlsx([
        {
          name: 'M',
          xml: `<sheetData>${row(300, ['AB', 'x'])}</sheetData><mergeCells>${merges}</mergeCells>`,
        },
      ]),
    ).sheets[0];
    expect(sheet?.merges).toEqual([{ r0: 0, c0: 0, r1: 299, c1: 25 }]);
  });

  it('empty cells are never kept; every kept cell costs the budget', () => {
    const sheet = bookView(
      xlsx([
        {
          name: 'E',
          xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"/><c r="B1" t="str"><v/></c><c r="C1"><v>1</v></c></row></sheetData>',
        },
      ]),
    ).sheets[0];
    expect(sheet?.cells).toEqual([{ r: 0, c: 2, text: '1', kind: 'n' }]);
  });

  it('booleans, errors and dates read as Excel shows them', () => {
    const styles =
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00"/></numFmts>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="10"/></cellXfs></styleSheet>';
    const sheet = bookView(
      xlsx(
        [
          {
            name: 'T',
            xml:
              '<sheetData><row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="e"><v>#DIV/0!</v></c>' +
              '<c r="C1" s="1"><v>46308</v></c><c r="D1" s="2"><v>76000</v></c><c r="E1" s="3"><v>0.125</v></c></row></sheetData>',
          },
        ],
        [],
        styles,
      ),
    ).sheets[0];
    const text = (sheet?.cells ?? []).map((c) => c.text);
    expect(text).toEqual(['TRUE', '#DIV/0!', '2026-10-13', '₹76,000.00', '12.50%']);
  });

  it('number formats', () => {
    expect(formatNumber('1234567.891', parseFormat(4, undefined), false)).toBe('1,234,567.89');
    expect(formatNumber('0.5', parseFormat(9, undefined), false)).toBe('50%');
    expect(formatNumber('-3', parseFormat(3, undefined), false)).toBe('-3');
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(123456789012)).toBe('1.23457E+11');
    expect(formatSerialDate(45000.5, { date: true, time: true, seconds: false }, false)).toBe(
      '2023-03-15 12:00',
    );
    // Excel's default width (9.140625 stored) is 64 px.
    expect(columnPx(9.140625)).toBe(64);
  });

  it('the thumbnail grid is the top-left 8 x 5 of the first visible sheet', () => {
    const res = handleOfficeRequest({
      op: 'thumb',
      bytes: buf(
        xlsx([
          { name: 'Hidden', state: 'hidden', xml: `<sheetData>${row(1, ['A', 'no'])}</sheetData>` },
          {
            name: 'Shown',
            xml: `<sheetData>${row(1, ['A', 'Date'], ['B', 42], ['G', 'far'])}${row(20, ['A', 'deep'])}</sheetData>`,
          },
        ]),
      ),
      mime: null,
    });
    if (!res.ok || res.op !== 'thumb' || res.result.kind !== 'xlsx') throw new Error('no grid');
    const grid = res.result.cells;
    expect(grid).toHaveLength(8);
    expect(grid.every((r) => r.length === 5)).toBe(true);
    expect(grid[0]?.[0]).toEqual({ text: 'Date', numeric: false });
    expect(grid[0]?.[1]).toEqual({ text: '42', numeric: true });
    expect(JSON.stringify(grid)).not.toMatch(/far|deep|no"/);
  });
});

describe('runOffice: one Worker per parse, always terminated', () => {
  class FakeWorker implements OfficeWorkerLike {
    onmessage: ((event: MessageEvent<OfficeResponse>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    terminated = 0;
    posted: OfficeRequest | null = null;
    constructor(private readonly answer: boolean) {}
    postMessage(message: OfficeRequest): void {
      this.posted = message;
      if (this.answer) {
        const response = handleOfficeRequest(message);
        queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<OfficeResponse>));
      }
    }
    terminate(): void {
      this.terminated++;
    }
  }

  it('answers and terminates', async () => {
    const worker = new FakeWorker(true);
    const res = await runOffice({
      op: 'view',
      bytes: docx({ body: p('Hi') }),
      mime: null,
      timeoutMs: 1000,
      createWorker: () => worker,
    });
    expect(res.ok).toBe(true);
    expect(worker.terminated).toBe(1);
  });

  it('a parse past the cap times out and the Worker is terminated', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(false);
      const pending = runOffice({
        op: 'view',
        bytes: docx({ body: p('Hi') }),
        mime: null,
        timeoutMs: 10_000,
        createWorker: () => worker,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ ok: false, reason: 'timeout' });
      expect(worker.terminated).toBe(1);
      expect(worker.onmessage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort (the viewer closing) terminates the Worker; a Worker error is a failure', async () => {
    const controller = new AbortController();
    const worker = new FakeWorker(false);
    const pending = runOffice({
      op: 'view',
      bytes: new Uint8Array(4),
      mime: null,
      timeoutMs: 10_000,
      signal: controller.signal,
      createWorker: () => worker,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    expect(worker.terminated).toBe(1);

    const broken = new FakeWorker(false);
    const failing = runOffice({
      op: 'view',
      bytes: new Uint8Array(4),
      mime: null,
      timeoutMs: 10_000,
      createWorker: () => broken,
    });
    broken.onerror?.(new Event('error'));
    expect(await failing).toEqual({ ok: false, reason: 'failed' });
    expect(broken.terminated).toBe(1);
  });
});
