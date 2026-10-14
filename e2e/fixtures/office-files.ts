import { strToU8, zipSync, type Zippable } from 'fflate';

// Tiny Office packages built in memory for the office viewer spec: a docx with
// a title, a paragraph, one embedded picture and one EXTERNAL picture (which
// must never be requested), and a two-sheet xlsx. Nothing is committed as a
// binary.

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The host the docx's external picture points at; any request to it is a failure. */
export const TRACKER_HOST = 'tracker.office-fixture.test';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function rels(items: Array<[string, string, string, boolean?]>): Uint8Array {
  return strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      items
        .map(
          ([id, type, target, external]) =>
            `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external === true ? ' TargetMode="External"' : ''}/>`,
        )
        .join('') +
      '</Relationships>',
  );
}

function types(part: string, type: string): Uint8Array {
  return strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Override PartName="/${part}" ContentType="${type}.main+xml"/></Types>`,
  );
}

/** A 1x1 PNG, as an embedded picture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function picture(id: string): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline xmlns:wp="wp"><wp:extent cx="1905000" cy="952500"/>' +
    `<a:graphic xmlns:a="a"><a:blip r:embed="${id}"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

export function docxFixture(): Buffer {
  const body =
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Diwali campaign brief</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Drive festive gifting orders for the dry-fruit range across Instagram and LinkedIn.</w:t></w:r></w:p>' +
    picture('rIdImg') +
    picture('rIdExt') +
    '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Open the board</w:t></w:r></w:hyperlink></w:p>';
  const files: Zippable = {
    '[Content_Types].xml': types('word/document.xml', DOCX_MIME),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>`,
    ),
    'word/_rels/document.xml.rels': rels([
      ['rIdS', 'styles', 'styles.xml'],
      ['rIdImg', 'image', 'media/image1.png'],
      ['rIdExt', 'image', `https://${TRACKER_HOST}/pixel.png`, true],
      ['rIdLink', 'hyperlink', `https://${TRACKER_HOST}/board`, true],
    ]),
    'word/styles.xml': strToU8(
      `<w:styles xmlns:w="${W}"><w:style w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`,
    ),
    'word/media/image1.png': new Uint8Array(PNG),
  };
  return Buffer.from(zipSync(files));
}

function cell(ref: string, v: string | number): string {
  return typeof v === 'number'
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
}

export function xlsxFixture(): Buffer {
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const calendar =
    '<cols><col min="1" max="1" width="14"/><col min="2" max="2" width="30"/></cols><sheetData>' +
    `<row r="1">${cell('A1', 'November 2026 content calendar')}</row>` +
    `<row r="2">${cell('A2', 'Date')}${cell('B2', 'Topic')}${cell('C2', 'Boost')}</row>` +
    `<row r="3">${cell('A3', '1 Nov')}${cell('B3', 'Diwali gifting hamper')}${cell('C3', 5000)}</row>` +
    `<row r="4">${cell('A4', '2 Nov')}${cell('B4', 'Corporate gifting guide')}<c r="C4"><f>1+1</f></c></row>` +
    '</sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>';
  const budget =
    '<sheetData>' +
    `<row r="1">${cell('A1', 'Line item')}${cell('B1', 'Total')}</row>` +
    `<row r="2">${cell('A2', 'Instagram reels')}${cell('B2', 39000)}</row>` +
    '</sheetData>';
  const files: Zippable = {
    '[Content_Types].xml': types('xl/workbook.xml', XLSX_MIME),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns="${S}" xmlns:r="${REL}"><sheets>` +
        '<sheet name="Calendar" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" r:id="rId2" state="hidden"/>' +
        '<sheet name="Budget" sheetId="3" r:id="rId3"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': rels([
      ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
      ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ['rId3', 'worksheet', 'worksheets/sheet3.xml'],
    ]),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="${S}">${calendar}</worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8(`<worksheet xmlns="${S}"><sheetData/></worksheet>`),
    'xl/worksheets/sheet3.xml': strToU8(`<worksheet xmlns="${S}">${budget}</worksheet>`),
  };
  return Buffer.from(zipSync(files));
}
