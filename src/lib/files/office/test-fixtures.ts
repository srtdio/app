// Tiny docx, xlsx and pptx packages built in memory for the office tests.
// Test-only: nothing in the app imports this module.

import { strToU8, zipSync, type Zippable } from 'fflate';
import { DOCX_MIME, PPTX_MIME, XLSX_MIME } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function rels(
  items: Array<{ id: string; type: string; target: string; external?: boolean }>,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items
      .map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"${
            r.external === true ? ' TargetMode="External"' : ''
          }/>`,
      )
      .join('') +
    '</Relationships>'
  );
}

function contentTypes(main: string, type: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/${main}" ContentType="${type}"/>` +
    '</Types>'
  );
}

/** A 1x1 PNG. */
export const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

export interface DocxFixture {
  /** Inner XML of <w:body>. */
  body: string;
  /** Extra word/_rels/document.xml.rels relationships. */
  rels?: Array<{ id: string; type: string; target: string; external?: boolean }>;
  /** Extra files, by package path. */
  files?: Record<string, Uint8Array>;
  pages?: number;
  styles?: boolean;
}

export function docx(fixture: DocxFixture): Uint8Array {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypes('word/document.xml', `${DOCX_MIME}.main+xml`)),
    '_rels/.rels': strToU8(
      rels([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${fixture.body}</w:body></w:document>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      rels([
        ...(fixture.styles === false ? [] : [{ id: 'rIdS', type: 'styles', target: 'styles.xml' }]),
        ...(fixture.rels ?? []),
      ]),
    ),
    'word/styles.xml': strToU8(
      `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    ),
    ...(fixture.pages !== undefined
      ? { 'docProps/app.xml': strToU8(`<Properties><Pages>${fixture.pages}</Pages></Properties>`) }
      : {}),
  };
  for (const [path, bytes] of Object.entries(fixture.files ?? {})) files[path] = bytes;
  return zipSync(files);
}

/** A paragraph of plain runs. */
export function p(text: string, style?: string): string {
  const pPr = style !== undefined ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export interface SheetFixture {
  name: string;
  state?: 'hidden' | 'veryHidden';
  /** Inner XML of <worksheet> (cols, sheetData, mergeCells...). */
  xml: string;
}

export function xlsx(sheets: SheetFixture[], strings: string[] = [], styles?: string): Uint8Array {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypes('xl/workbook.xml', `${XLSX_MIME}.main+xml`)),
    '_rels/.rels': strToU8(
      rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    ),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns="${S}" xmlns:r="${R}"><sheets>` +
        sheets
          .map(
            (s, i) =>
              `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state !== undefined ? ` state="${s.state}"` : ''}/>`,
          )
          .join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      rels([
        ...sheets.map((_, i) => ({
          id: `rId${i + 1}`,
          type: 'worksheet',
          target: `worksheets/sheet${i + 1}.xml`,
        })),
        { id: 'rIdSS', type: 'sharedStrings', target: 'sharedStrings.xml' },
        { id: 'rIdST', type: 'styles', target: 'styles.xml' },
        {
          id: 'rIdX',
          type: 'externalLink',
          target: 'https://evil.example/book.xlsx',
          external: true,
        },
      ]),
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst xmlns="${S}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    ),
    'xl/styles.xml': strToU8(
      styles ?? `<styleSheet xmlns="${S}"><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<worksheet xmlns="${S}">${s.xml}</worksheet>`,
    );
  });
  return zipSync(files);
}

export function pptx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes('ppt/presentation.xml', `${PPTX_MIME}.main+xml`)),
    '_rels/.rels': strToU8(
      rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    ),
    'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="x"/>'),
  });
}

/** An OLE2 header: how Office wraps a password-protected OOXML file. */
export function encryptedOffice(): Uint8Array {
  const b = new Uint8Array(1024);
  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return b;
}

/** A row of inline-string / number cells: row(1, ['A', 'x'], ['B', 2]). */
export function row(r: number, ...cells: Array<[string, string | number]>): string {
  return (
    `<row r="${r}">` +
    cells
      .map(([col, v]) =>
        typeof v === 'number'
          ? `<c r="${col}${r}"><v>${v}</v></c>`
          : `<c r="${col}${r}" t="inlineStr"><is><t>${v}</t></is></c>`,
      )
      .join('') +
    '</row>'
  );
}
