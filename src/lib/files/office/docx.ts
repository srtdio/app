// Word (docx) reader for the viewer and the thumbnail, run inside the office
// Worker only. It walks word/document.xml and writes a small, fixed HTML
// vocabulary (p, h1-h6, strong, em, u, s, sub, sup, br, table, tr, td, img,
// div.page) with every text escaped. Never written: links (a hyperlink's text
// stays as plain text), scripts, styles from the file, fields' instructions,
// deleted text, embedded objects, alt chunks (embedded HTML), external images
// or fonts. Pictures come only from the package's own media, as data: URIs of
// a sniffed PNG, JPEG, GIF or WebP. The main thread sanitizes the output again
// before it reaches the sandboxed iframe.

import type { DocxThumbText, DocxView } from './types';
import { THUMB_LINE_CHARS, THUMB_MAX_LINES } from './types';
import { child, children, descendant, parseXmlTree, type XmlNode } from './xml';
import { ZipError } from './zip';
import type { OfficePackage, Relationship } from './package';

/** Pictures: per image and for the whole document. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGES_MAX_BYTES = 15 * 1024 * 1024;
/**
 * HTML characters a document may produce (about 4 MB of text: hundreds of
 * pages). Past it the file is too large to open in place; Download still works.
 */
export const DOC_HTML_BUDGET = 4_000_000;
/** Page sections and pictures a document may produce; past them breaks are ignored and pictures dropped. */
export const MAX_PAGES = 500;
export const MAX_IMAGES = 500;
/** Nested tables deeper than this are dropped. */
const MAX_TABLE_DEPTH = 8;
/** EMU per CSS px (914400 per inch, 96 px per inch). */
const EMU_PER_PX = 9525;
const LETTER_ASPECT = 11 / 8.5;

/** Escape text for HTML. Pure. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The image mime from magic bytes, or null for anything that is not a plain raster. Pure. */
function sniffImage(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'image/gif';
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** True for an on/off property that is on (<w:b/>, <w:b w:val="1"/>, not val="0|false"). Pure. */
function isOn(node: XmlNode | null): boolean {
  if (node === null) return false;
  const v = (node.attrs.val ?? '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'none' && v !== 'off';
}

interface Styles {
  /** styleId -> heading level 1..6, 0 for Title. */
  headings: Map<string, number>;
}

function readStyles(pkg: OfficePackage, rels: Map<string, Relationship>): Styles {
  const headings = new Map<string, number>();
  let path: string | null = null;
  for (const rel of rels.values()) if (rel.type.endsWith('/styles')) path = rel.target;
  const xml = path !== null ? pkg.text(path) : null;
  if (xml === null) return { headings };
  const root = parseXmlTree(xml);
  const stylesNode = child(root, 'styles');
  if (stylesNode === null) return { headings };
  for (const style of children(stylesNode, 'style')) {
    const id = style.attrs.styleId;
    const name = (child(style, 'name')?.attrs.val ?? '').toLowerCase();
    if (id === undefined) continue;
    const m = /^heading ([1-6])$/.exec(name);
    if (m !== null) headings.set(id, Number(m[1]));
    else if (name === 'title') headings.set(id, 0);
  }
  return { headings };
}

interface Numbering {
  /** numId -> ilvl -> numFmt ("bullet", "decimal", ...). */
  formats: Map<string, Map<string, string>>;
}

function readNumbering(pkg: OfficePackage, rels: Map<string, Relationship>): Numbering {
  const formats = new Map<string, Map<string, string>>();
  let path: string | null = null;
  for (const rel of rels.values()) if (rel.type.endsWith('/numbering')) path = rel.target;
  const xml = path !== null ? pkg.text(path) : null;
  if (xml === null) return { formats };
  const root = child(parseXmlTree(xml), 'numbering');
  if (root === null) return { formats };
  const abstract = new Map<string, Map<string, string>>();
  for (const a of children(root, 'abstractNum')) {
    const levels = new Map<string, string>();
    for (const lvl of children(a, 'lvl')) {
      levels.set(lvl.attrs.ilvl ?? '0', child(lvl, 'numFmt')?.attrs.val ?? 'bullet');
    }
    if (a.attrs.abstractNumId !== undefined) abstract.set(a.attrs.abstractNumId, levels);
  }
  for (const num of children(root, 'num')) {
    const ref = child(num, 'abstractNumId')?.attrs.val;
    const levels = ref !== undefined ? abstract.get(ref) : undefined;
    if (num.attrs.numId !== undefined && levels !== undefined) formats.set(num.attrs.numId, levels);
  }
  return { formats };
}

class Writer {
  pages: string[] = [];
  private cur = '';
  private imagesBytes = 0;
  private counters = new Map<string, number>();
  /** HTML characters written, pictures excluded (they have their own byte cap). */
  private htmlChars = 0;
  private imageCount = 0;
  /** Inside a table a page break never splits the page (it would cut the table). */
  private tableDepth = 0;

  constructor(
    private readonly pkg: OfficePackage,
    private readonly rels: Map<string, Relationship>,
    private readonly styles: Styles,
    private readonly numbering: Numbering,
    private readonly withImages: boolean,
  ) {}

  emit(html: string): void {
    this.htmlChars += html.length;
    // Everything here is sanitized and laid out on the main thread: too much is too large.
    // (The thumbnail reads text only and never sends this HTML anywhere.)
    if (this.withImages && this.htmlChars > DOC_HTML_BUDGET)
      throw new ZipError('document too long', 'too_large');
    this.cur += html;
  }

  pageBreak(): void {
    // Past MAX_PAGES the rest flows on the last page (each page is laid out on the main thread).
    if (this.tableDepth > 0 || this.pages.length >= MAX_PAGES - 1) return;
    this.pages.push(this.cur);
    this.cur = '';
  }

  finish(): string[] {
    this.pages.push(this.cur);
    const pages = this.pages.filter((p, i) => p !== '' || i === 0);
    return pages.length > 0 ? pages : [''];
  }

  image(node: XmlNode): string {
    if (!this.withImages) return '';
    const blip = descendant(node, 'blip') ?? descendant(node, 'imagedata');
    const id = blip?.attrs.embed ?? blip?.attrs.id;
    if (id === undefined) return '';
    const rel = this.rels.get(id);
    if (rel === undefined) return '';
    let bytes: Uint8Array | null;
    try {
      bytes = this.pkg.bytesOf(rel.target, IMAGE_MAX_BYTES);
    } catch {
      return '';
    }
    if (bytes === null) return '';
    const mime = sniffImage(bytes);
    if (
      mime === null ||
      this.imageCount >= MAX_IMAGES ||
      this.imagesBytes + bytes.length > IMAGES_MAX_BYTES
    ) {
      return '';
    }
    this.imageCount++;
    this.imagesBytes += bytes.length;
    const extent = descendant(node, 'extent');
    const w = Math.round(Number(extent?.attrs.cx ?? 0) / EMU_PER_PX);
    const h = Math.round(Number(extent?.attrs.cy ?? 0) / EMU_PER_PX);
    const size =
      Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w < 20000 && h < 20000
        ? ` width="${w}" height="${h}"`
        : '';
    const payload = base64(bytes);
    // The picture's bytes count against IMAGES_MAX_BYTES; the tag itself still costs the budget.
    this.htmlChars -= payload.length;
    return `<img alt="" src="data:${mime};base64,${payload}"${size}>`;
  }

  /** A paragraph's inline content; a page break inside it splits the paragraph. */
  inline(node: XmlNode, open: string, close: string, out: { text: string }): void {
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      switch (c.name) {
        case 'r':
          this.run(c, open, close, out);
          break;
        case 'hyperlink':
        case 'ins':
        case 'moveTo':
        case 'smartTag':
        case 'fldSimple':
        case 'customXml':
        case 'dir':
        case 'bdo':
          this.inline(c, open, close, out);
          break;
        case 'sdt': {
          const content = child(c, 'sdtContent');
          if (content !== null) this.inline(content, open, close, out);
          break;
        }
        default:
          break;
      }
    }
  }

  run(r: XmlNode, open: string, close: string, out: { text: string }): void {
    const pr = child(r, 'rPr');
    const tags: string[] = [];
    if (pr !== null) {
      if (isOn(child(pr, 'b'))) tags.push('strong');
      if (isOn(child(pr, 'i'))) tags.push('em');
      if (isOn(child(pr, 'u'))) tags.push('u');
      if (isOn(child(pr, 'strike')) || isOn(child(pr, 'dstrike'))) tags.push('s');
      const va = child(pr, 'vertAlign')?.attrs.val;
      if (va === 'superscript') tags.push('sup');
      else if (va === 'subscript') tags.push('sub');
      if (isOn(child(pr, 'vanish'))) return;
    }
    const before = tags.map((t) => `<${t}>`).join('');
    const after = tags
      .slice()
      .reverse()
      .map((t) => `</${t}>`)
      .join('');
    let buf = '';
    const flush = (): void => {
      if (buf !== '') this.emit(`${before}${buf}${after}`);
      buf = '';
    };
    for (const c of r.children) {
      if (typeof c === 'string') continue;
      switch (c.name) {
        case 't': {
          const text = c.children.filter((x): x is string => typeof x === 'string').join('');
          buf += escapeHtml(text);
          out.text += text;
          break;
        }
        case 'tab':
          buf += '<span class="tab"></span>';
          out.text += ' ';
          break;
        case 'br':
        case 'cr':
          if (c.attrs.type === 'page') {
            flush();
            this.emit(close);
            this.pageBreak();
            this.emit(open);
          } else {
            buf += '<br>';
            out.text += ' ';
          }
          break;
        case 'noBreakHyphen':
          buf += '-';
          break;
        case 'sym':
          break;
        case 'drawing':
        case 'pict':
          buf += this.image(c);
          break;
        case 'AlternateContent': {
          const choice = child(c, 'Choice');
          if (choice !== null && descendant(choice, 'blip') !== null) buf += this.image(choice);
          break;
        }
        default:
          break;
      }
    }
    flush();
  }

  paragraph(p: XmlNode): string {
    const pr = child(p, 'pPr');
    const styleId = pr !== null ? child(pr, 'pStyle')?.attrs.val : undefined;
    const level = styleId !== undefined ? this.styles.headings.get(styleId) : undefined;
    const jc = pr !== null ? child(pr, 'jc')?.attrs.val : undefined;
    const classes: string[] = [];
    if (jc === 'center') classes.push('al-c');
    else if (jc === 'right' || jc === 'end') classes.push('al-r');
    else if (jc === 'both' || jc === 'distribute') classes.push('al-j');
    if (pr !== null && isOn(child(pr, 'pageBreakBefore'))) this.pageBreak();

    let tag = 'p';
    if (level !== undefined) tag = level === 0 ? 'h1' : `h${Math.min(level + 1, 6)}`;
    if (level === 0) classes.push('title');

    let marker = '';
    const numPr = pr !== null ? child(pr, 'numPr') : null;
    if (numPr !== null && level === undefined) {
      const numId = child(numPr, 'numId')?.attrs.val ?? '';
      const ilvl = child(numPr, 'ilvl')?.attrs.val ?? '0';
      const fmt = this.numbering.formats.get(numId)?.get(ilvl);
      if (numId !== '0' && fmt !== undefined) {
        const depth = Math.min(Math.max(Number(ilvl) || 0, 0), 8);
        classes.push('li', `lv${depth}`);
        if (fmt === 'bullet' || fmt === 'none') {
          marker = fmt === 'none' ? '' : '• ';
        } else {
          const key = `${numId}:${ilvl}`;
          const n = (this.counters.get(key) ?? 0) + 1;
          this.counters.set(key, n);
          // A higher level restarts the deeper ones.
          for (const k of this.counters.keys()) {
            const [kn, kl] = k.split(':');
            if (kn === numId && Number(kl) > depth) this.counters.delete(k);
          }
          marker = `${n}. `;
        }
      }
    }

    const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
    const open = `<${tag}${cls}>`;
    const close = `</${tag}>`;
    const out = { text: '' };
    this.emit(open);
    if (marker !== '') this.emit(escapeHtml(marker));
    this.inline(p, open, close, out);
    this.emit(close);
    const sect = pr !== null ? child(pr, 'sectPr') : null;
    if (sect !== null) {
      const type = child(sect, 'type')?.attrs.val ?? 'nextPage';
      if (type !== 'continuous') this.pageBreak();
    }
    return out.text;
  }

  table(tbl: XmlNode, depth: number): void {
    if (depth > MAX_TABLE_DEPTH) return;
    const rows = children(tbl, 'tr');
    // Grid columns per row, so a vertical merge finds the cells it continues.
    const grid = rows.map((tr) => {
      const cells: Array<{ tc: XmlNode; col: number; span: number; merge: string | null }> = [];
      let col = Number(child(child(tr, 'trPr') ?? tr, 'gridBefore')?.attrs.val ?? 0) || 0;
      for (const tc of children(tr, 'tc')) {
        const pr = child(tc, 'tcPr');
        const span = Math.max(
          1,
          Math.min(Number(child(pr ?? tc, 'gridSpan')?.attrs.val ?? 1) || 1, 64),
        );
        const vm = pr !== null ? child(pr, 'vMerge') : null;
        const merge = vm === null ? null : (vm.attrs.val ?? 'continue');
        cells.push({ tc, col, span, merge });
        col += span;
      }
      return cells;
    });
    this.emit('<table>');
    this.tableDepth++;
    grid.forEach((cells, ri) => {
      this.emit('<tr>');
      for (const cell of cells) {
        if (cell.merge === 'continue') continue;
        let rowSpan = 1;
        if (cell.merge === 'restart') {
          for (let k = ri + 1; k < grid.length; k++) {
            const below = grid[k]?.find((x) => x.col === cell.col);
            if (below === undefined || below.merge !== 'continue') break;
            rowSpan++;
          }
        }
        const attrs =
          (cell.span > 1 ? ` colspan="${cell.span}"` : '') +
          (rowSpan > 1 ? ` rowspan="${rowSpan}"` : '');
        this.emit(`<td${attrs}>`);
        this.blocks(cell.tc, depth + 1, null);
        this.emit('</td>');
      }
      this.emit('</tr>');
    });
    this.tableDepth--;
    this.emit('</table>');
  }

  /** Paragraphs and tables in order; `texts` collects plain paragraph text when given. */
  blocks(
    node: XmlNode,
    depth: number,
    texts: Array<{ text: string; heading: boolean }> | null,
  ): void {
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      if (c.name === 'p') {
        const pr = child(c, 'pPr');
        const styleId = pr !== null ? child(pr, 'pStyle')?.attrs.val : undefined;
        const text = this.paragraph(c);
        texts?.push({ text, heading: styleId !== undefined && this.styles.headings.has(styleId) });
      } else if (c.name === 'tbl') {
        this.table(c, depth);
      } else if (c.name === 'sdt') {
        const content = child(c, 'sdtContent');
        if (content !== null) this.blocks(content, depth, texts);
      } else if (c.name === 'customXml') {
        this.blocks(c, depth, texts);
      }
    }
  }
}

interface Parsed {
  writer: Writer;
  texts: Array<{ text: string; heading: boolean }>;
  aspect: number;
  margins: [number, number, number, number];
}

function parse(pkg: OfficePackage, part: string, withImages: boolean): Parsed {
  const xml = pkg.text(part);
  if (xml === null) throw new Error('main part missing');
  const rels = pkg.relationships(part);
  const root = parseXmlTree(xml);
  const body = child(child(root, 'document') ?? root, 'body');
  if (body === null) throw new Error('no body');
  const writer = new Writer(pkg, rels, readStyles(pkg, rels), readNumbering(pkg, rels), withImages);
  const texts: Array<{ text: string; heading: boolean }> = [];
  writer.blocks(body, 0, texts);

  const sect = child(body, 'sectPr');
  const pgSz = sect !== null ? child(sect, 'pgSz') : null;
  const pgMar = sect !== null ? child(sect, 'pgMar') : null;
  const w = Number(pgSz?.attrs.w ?? 0);
  const h = Number(pgSz?.attrs.h ?? 0);
  const aspect = w > 0 && h > 0 ? Math.min(Math.max(h / w, 0.3), 3) : LETTER_ASPECT;
  const width = w > 0 ? w : 12240;
  const frac = (v: string | undefined, fallback: number): number => {
    const n = Number(v ?? fallback);
    return Number.isFinite(n) ? Math.min(Math.max(n / width, 0), 0.3) : fallback / width;
  };
  const margins: [number, number, number, number] = [
    frac(pgMar?.attrs.top, 1440),
    frac(pgMar?.attrs.right, 1440),
    frac(pgMar?.attrs.bottom, 1440),
    frac(pgMar?.attrs.left, 1440),
  ];
  return { writer, texts, aspect, margins };
}

/** docProps/app.xml's page count, when stated. */
function statedPages(pkg: OfficePackage): number | null {
  const xml = pkg.text('docProps/app.xml');
  if (xml === null) return null;
  const m = /<(?:\w+:)?Pages>\s*(\d{1,5})\s*</.exec(xml);
  const n = m !== null ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The viewer's model: escaped HTML per page section. */
export function readDocxView(pkg: OfficePackage, part: string): DocxView {
  const { writer, aspect, margins } = parse(pkg, part, true);
  return { kind: 'docx', pages: writer.finish(), pageCount: statedPages(pkg), aspect, margins };
}

/** Collapse whitespace and cap a line. Pure. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The thumbnail's plain text: a title and the first paragraphs. No images are read. */
export function readDocxThumb(pkg: OfficePackage, part: string): DocxThumbText {
  const { texts, aspect } = parse(pkg, part, false);
  const nonEmpty = texts.filter((t) => t.text.trim() !== '');
  const first = nonEmpty[0];
  const title =
    first !== undefined && first.heading ? clip(first.text, THUMB_LINE_CHARS * 2) : null;
  const rest = (title !== null ? nonEmpty.slice(1) : nonEmpty)
    .slice(0, THUMB_MAX_LINES)
    .map((t) => clip(t.text, THUMB_LINE_CHARS * 4));
  return { kind: 'docx', title, paragraphs: rest, aspect };
}
