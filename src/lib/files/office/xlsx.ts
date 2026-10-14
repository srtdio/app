// Excel (xlsx) reader for the viewer and the thumbnail, run inside the office
// Worker only. It reads the values the file last saved: a formula's cached
// <v>, else its formula text as plain text; nothing is ever evaluated. Shown:
// visible worksheets only (hidden and very hidden sheets are skipped), merged
// cells, column widths, and at most SHEET_ROW_CAP rows x SHEET_COL_CAP
// columns, each cell capped at CELL_TEXT_CAP characters. Never read: external
// links, data connections, hyperlink targets (a link's cell shows its text),
// pivot caches, macros, drawings.

import {
  CELL_TEXT_CAP,
  COL_WIDTH_MAX,
  COL_WIDTH_MIN,
  SHEET_COL_CAP,
  SHEET_ROW_CAP,
  THUMB_CELL_CHARS,
  THUMB_GRID_COLS,
  THUMB_GRID_ROWS,
  type CellKind,
  type SheetCell,
  type SheetMerge,
  type SheetView,
  type XlsxThumbGrid,
  type XlsxView,
} from './types';
import type { OfficePackage } from './package';
import { scanXml } from './xml';

const DEFAULT_COL_PX = 64;
/**
 * Characters of cell text kept for a whole book. Structured clone copies every
 * string, so many cells pointing at one long shared string must not multiply
 * into gigabytes on the way out of the Worker.
 */
export const BOOK_TEXT_BUDGET = 8_000_000;
/** What one kept cell costs the budget beyond its text (the object copied out of the Worker). */
const CELL_COST = 16;
/** Visible sheets shown per book (tabs), and what each costs the budget. */
export const MAX_SHEETS = 64;
const SHEET_COST = 1024;
/** Merges read per sheet, and kept after de-overlapping. */
const MAX_MERGES_READ = 20_000;
export const MAX_MERGES = 10_000;
/** Cells visited while de-overlapping merges; past it the rest are dropped. */
const MERGE_WORK_CAP = 4_000_000;

/**
 * At most MAX_MERGES merges that never overlap, so the viewer's merge index
 * stays within one entry per shown cell however many merges a file declares.
 * Overlapping (malformed) merges after the first are dropped. Pure.
 */
export function keepMerges(merges: SheetMerge[], rows: number, cols: number): SheetMerge[] {
  const taken = new Uint8Array(Math.max(rows * cols, 0));
  const out: SheetMerge[] = [];
  let work = 0;
  for (const m of merges) {
    if (out.length >= MAX_MERGES || work >= MERGE_WORK_CAP) break;
    let free = true;
    for (let r = m.r0; r <= m.r1 && free; r++) {
      for (let c = m.c0; c <= m.c1; c++) {
        work++;
        if (taken[r * cols + c] === 1) {
          free = false;
          break;
        }
      }
    }
    if (!free) continue;
    for (let r = m.r0; r <= m.r1; r++) taken.fill(1, r * cols + m.c0, r * cols + m.c1 + 1);
    out.push(m);
  }
  return out;
}

/** Thrown to end a sheet scan early; never escapes readSheet. */
const STOP = new Error('stop');

/** "A" -> 0, "AB" -> 27; -1 when not letters. Pure. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** 0 -> "A", 27 -> "AB". Pure. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "C12" -> { r: 11, c: 2 }, or null. Pure. */
export function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref.trim());
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const c = columnIndex(m[1]);
  const r = Number(m[2]) - 1;
  return c >= 0 && r >= 0 ? { r, c } : null;
}

/** Excel's column width (characters) in CSS px, clamped. Pure. */
export function columnPx(width: number): number {
  const px = Math.trunc(((256 * width + Math.trunc(128 / 7)) / 256) * 7);
  return Math.min(
    Math.max(Number.isFinite(px) ? px : DEFAULT_COL_PX, COL_WIDTH_MIN),
    COL_WIDTH_MAX,
  );
}

function cap(text: string): string {
  return text.length > CELL_TEXT_CAP ? text.slice(0, CELL_TEXT_CAP) : text;
}

// ---------------------------------------------------------------------------
// Number formats: enough to show saved values the way the sheet labels them.
// ---------------------------------------------------------------------------

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  48: '##0.0E+0',
  49: '@',
};

type Format =
  | { kind: 'general' }
  | { kind: 'text' }
  | { kind: 'date'; time: boolean; date: boolean; seconds: boolean }
  | {
      kind: 'number';
      decimals: number;
      group: boolean;
      percent: boolean;
      sci: boolean;
      prefix: string;
      suffix: string;
    };

/** Strip quoted literals, escapes, colours and locale tags from a format section. Pure. */
function bareFormat(code: string): string {
  return code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_.|\*./g, '');
}

/** The literal currency or unit text around a number format ("[$₹-4009] #,##0" -> "₹"). Pure. */
function affixes(code: string): { prefix: string; suffix: string } {
  const cur = /\[\$([^\]-]*)(?:-[0-9A-Fa-f]+)?\]/.exec(code);
  const quoted = (s: string): string =>
    (s.match(/"([^"]*)"/g) ?? []).map((q) => q.slice(1, -1)).join('') +
    (s.match(/\\(.)/g) ?? []).map((q) => q.slice(1)).join('') +
    s.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '').replace(/[#0?.,%Ee+\-\s;@]/g, '');
  const firstDigit = code.search(/[#0?]/);
  const lastDigit = Math.max(code.lastIndexOf('#'), code.lastIndexOf('0'), code.lastIndexOf('?'));
  let prefix = firstDigit > 0 ? quoted(code.slice(0, firstDigit)) : '';
  let suffix = lastDigit >= 0 ? quoted(code.slice(lastDigit + 1)) : '';
  if (cur !== null && cur[1] !== undefined) {
    const at = code.indexOf(cur[0]);
    if (firstDigit === -1 || at < firstDigit) prefix = cur[1] + prefix.replace(cur[1], '');
    else suffix = suffix.replace(cur[1], '') + cur[1];
  }
  return { prefix: prefix.slice(0, 8), suffix: suffix.slice(0, 8) };
}

/** Read one format code. Pure. */
export function parseFormat(id: number, code: string | undefined): Format {
  if (BUILTIN_DATE.has(id)) return { kind: 'date', date: true, time: id === 22, seconds: false };
  if (BUILTIN_TIME.has(id))
    return {
      kind: 'date',
      date: false,
      time: true,
      seconds: id === 19 || id === 21 || id === 46 || id === 47,
    };
  const full = code ?? BUILTIN_FORMATS[id];
  if (full === undefined || full === '' || full.toLowerCase() === 'general')
    return { kind: 'general' };
  const section = full.split(';')[0] ?? '';
  const bare = bareFormat(section);
  if (bare.trim() === '@') return { kind: 'text' };
  if (/[dmyhs]/i.test(bare) && !/[#0?]/.test(bare)) {
    const date = /[dy]/i.test(bare) || /m{3,}/i.test(bare);
    const time = /[hs]/i.test(bare);
    return { kind: 'date', date: date || !time, time, seconds: /s/i.test(bare) };
  }
  if (!/[#0?]/.test(bare)) return { kind: 'general' };
  const dot = bare.indexOf('.');
  const decimals = dot === -1 ? 0 : (bare.slice(dot + 1).match(/^[0#?]*/)?.[0].length ?? 0);
  const { prefix, suffix } = affixes(section);
  return {
    kind: 'number',
    decimals: Math.min(decimals, 15),
    group: bare.includes(','),
    percent: bare.includes('%'),
    sci: /E[+-]/i.test(bare),
    prefix,
    suffix: suffix.replace('%', ''),
  };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** An Excel serial (1900 or 1904 system) as "2026-10-13", "14:30" or both. Pure. */
export function formatSerialDate(
  serial: number,
  fmt: { date: boolean; time: boolean; seconds: boolean },
  date1904: boolean,
): string {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return String(serial);
  // 1900 system: serial 60 is the phantom 29 Feb 1900; Excel's day 0 is 30 Dec 1899 after it.
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !date1904 && serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days * 86400 + 0) * 1000);
  const d = new Date(base + ms);
  const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const totalSeconds = Math.round((serial % 1) * 86400);
  const hh = Math.floor(totalSeconds / 3600) % 24;
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const timePart = `${pad(hh)}:${pad(mm)}${fmt.seconds ? `:${pad(ss)}` : ''}`;
  if (fmt.date && fmt.time) return `${datePart} ${timePart}`;
  return fmt.time && !fmt.date ? timePart : datePart;
}

function groupDigits(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A General-format number: up to 11 significant digits, like Excel's cell. Pure. */
export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    const [mantissa = '0', exp = '0'] = n.toExponential(5).split('e');
    const m = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
    const e = Number(exp);
    return `${m}E${e < 0 ? '-' : '+'}${pad(Math.abs(e))}`;
  }
  return String(Number(n.toPrecision(11)));
}

/** A cached number shown through its format. Pure. */
export function formatNumber(raw: string, format: Format, date1904: boolean): string {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return raw;
  switch (format.kind) {
    case 'general':
    case 'text':
      return formatGeneral(n);
    case 'date':
      return formatSerialDate(n, format, date1904);
    case 'number': {
      if (format.sci) return n.toExponential(format.decimals).toUpperCase();
      const value = format.percent ? n * 100 : n;
      const fixed = Math.abs(value).toFixed(format.decimals);
      const [int = '0', frac] = fixed.split('.');
      const body = (format.group ? groupDigits(int) : int) + (frac !== undefined ? `.${frac}` : '');
      const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
      return `${sign}${format.prefix}${body}${format.percent ? '%' : ''}${format.suffix}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

interface Workbook {
  date1904: boolean;
  sheets: Array<{ name: string; path: string }>;
  /** Visible worksheets in the file (sheets holds at most MAX_SHEETS of them). */
  visibleSheets: number;
  strings: string[];
  formats: Format[];
}

function readStrings(pkg: OfficePackage, path: string | null): string[] {
  const xml = path !== null ? pkg.text(path) : null;
  if (xml === null) return [];
  const out: string[] = [];
  let cur: string | null = null;
  let inT = false;
  let skip = 0;
  scanXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === 'si') cur = '';
      else if (name === 'rPh' || name === 'phoneticPr') {
        if (!selfClosing) skip++;
      } else if (name === 't' && skip === 0) inT = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(cap(cur ?? ''));
        cur = null;
      } else if (name === 'rPh' || name === 'phoneticPr') skip = Math.max(0, skip - 1);
      else if (name === 't') inT = false;
    },
    text(text) {
      if (inT && cur !== null && cur.length < CELL_TEXT_CAP) cur += text;
    },
  });
  return out;
}

function readFormats(pkg: OfficePackage, path: string | null): Format[] {
  const xml = path !== null ? pkg.text(path) : null;
  if (xml === null) return [];
  const codes = new Map<number, string>();
  const ids: number[] = [];
  let inXfs = false;
  scanXml(xml, {
    open(name, attrs) {
      if (name === 'numFmt' && attrs.numFmtId !== undefined && attrs.formatCode !== undefined) {
        codes.set(Number(attrs.numFmtId), attrs.formatCode);
      } else if (name === 'cellXfs') inXfs = true;
      else if (name === 'xf' && inXfs) ids.push(Number(attrs.numFmtId ?? 0) || 0);
    },
    close(name) {
      if (name === 'cellXfs') inXfs = false;
    },
    text() {},
  });
  return ids.map((id) => parseFormat(id, codes.get(id)));
}

function readWorkbook(pkg: OfficePackage, part: string): Workbook {
  const xml = pkg.text(part);
  if (xml === null) throw new Error('workbook missing');
  const rels = pkg.relationships(part);
  const listed: Array<{ name: string; id: string }> = [];
  let date1904 = false;
  scanXml(xml, {
    open(name, attrs) {
      if (name === 'workbookPr') {
        const v = (attrs.date1904 ?? '').toLowerCase();
        date1904 = v === '1' || v === 'true';
      } else if (name === 'sheet') {
        const state = (attrs.state ?? 'visible').toLowerCase();
        if (state !== 'visible' || attrs.id === undefined) return;
        listed.push({ name: (attrs.name ?? 'Sheet').slice(0, 64), id: attrs.id });
      }
    },
    close() {},
    text() {},
  });
  const sheets: Array<{ name: string; path: string }> = [];
  let visibleSheets = 0;
  for (const s of listed) {
    const rel = rels.get(s.id);
    // Worksheets only: chart sheets, dialog and macro sheets have nothing to show here.
    if (rel === undefined || !rel.type.endsWith('/worksheet')) continue;
    visibleSheets++;
    if (sheets.length < MAX_SHEETS) sheets.push({ name: s.name, path: rel.target });
  }
  let strings: string | null = null;
  let styles: string | null = null;
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/sharedStrings')) strings = rel.target;
    else if (rel.type.endsWith('/styles')) styles = rel.target;
  }
  return {
    date1904,
    sheets,
    visibleSheets,
    strings: readStrings(pkg, strings),
    formats: readFormats(pkg, styles),
  };
}

/** One worksheet, reading at most `maxRows` x `maxCols`; later rows are only counted. */
function readSheet(
  pkg: OfficePackage,
  book: Workbook,
  sheet: { name: string; path: string },
  maxRows: number,
  maxCols: number,
  /** Stop reading past the cap (the thumbnail needs no row count). */
  stopAtCap = false,
  /** Characters this sheet may still keep (shared with the rest of the book). */
  budget: { chars: number } = { chars: BOOK_TEXT_BUDGET },
): SheetView {
  const xml = pkg.text(sheet.path);
  if (xml === null) throw new Error('sheet missing');
  const cells: SheetCell[] = [];
  const merges: SheetMerge[] = [];
  const widths = new Map<number, number>();
  let defaultPx = DEFAULT_COL_PX;
  let lastRow = -1;
  let lastCol = -1;
  // The highest column with a value anywhere, before the column cap.
  let lastColAll = -1;
  // Rows kept: lowered when the text budget runs out mid-sheet.
  let rowLimit = maxRows;
  let rowIndex = -1;
  let colCursor = 0;
  let cell: {
    r: number;
    c: number;
    t: string;
    s: number;
    f: string;
    v: string;
    hasV: boolean;
  } | null = null;
  let field: 'v' | 'f' | 'is' | null = null;
  let inIsT = false;
  // Inside <rPh> (phonetic reading): its <t> is not cell text.
  let phonetic = 0;
  let isText = '';

  try {
    scanXml(xml, {
      open(name, attrs) {
        switch (name) {
          case 'sheetFormatPr': {
            const w = Number(attrs.defaultColWidth ?? NaN);
            const base = Number(attrs.baseColWidth ?? NaN);
            if (Number.isFinite(w)) defaultPx = columnPx(w);
            else if (Number.isFinite(base)) defaultPx = columnPx(base + 0.71);
            break;
          }
          case 'col': {
            const min = Number(attrs.min ?? 0) - 1;
            const max = Math.min(Number(attrs.max ?? 0) - 1, maxCols - 1);
            const w = Number(attrs.width ?? NaN);
            if (Number.isFinite(w) && min >= 0) {
              for (let c = min; c <= max; c++) widths.set(c, columnPx(w));
            }
            break;
          }
          case 'row': {
            const r = Number(attrs.r ?? NaN);
            rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
            colCursor = 0;
            break;
          }
          case 'c': {
            const ref = attrs.r !== undefined ? parseRef(attrs.r) : null;
            const c = ref !== null ? ref.c : colCursor;
            const r = ref !== null ? ref.r : rowIndex;
            colCursor = c + 1;
            cell = {
              r,
              c,
              t: attrs.t ?? 'n',
              s: Number(attrs.s ?? 0) || 0,
              f: '',
              v: '',
              hasV: false,
            };
            break;
          }
          case 'v':
            if (cell !== null) {
              field = 'v';
              cell.hasV = true;
            }
            break;
          case 'f':
            if (cell !== null) field = 'f';
            break;
          case 'is':
            if (cell !== null) {
              field = 'is';
              isText = '';
            }
            break;
          case 't':
            if (field === 'is' && phonetic === 0) inIsT = true;
            break;
          case 'rPh':
            if (field === 'is') {
              phonetic++;
              inIsT = false;
            }
            break;
          case 'mergeCell': {
            const [a, b] = (attrs.ref ?? '').split(':');
            const from = a !== undefined ? parseRef(a) : null;
            const to = b !== undefined ? parseRef(b) : from;
            if (from !== null && to !== null && merges.length < MAX_MERGES_READ) {
              merges.push({
                r0: Math.min(from.r, to.r),
                c0: Math.min(from.c, to.c),
                r1: Math.max(from.r, to.r),
                c1: Math.max(from.c, to.c),
              });
            }
            break;
          }
          default:
            break;
        }
      },
      close(name) {
        if (name === 'v' || name === 'f') field = null;
        else if (name === 't') inIsT = false;
        else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
        else if (name === 'is') {
          if (cell !== null) cell.v = isText;
          field = null;
        } else if (name === 'c' && cell !== null) {
          const done = cell;
          cell = null;
          const shown = cellText(done, book);
          // An empty cell shows nothing: never kept, never counted.
          if (shown === null || shown.text === '') return;
          // Only rows and columns that hold a value count (formatting alone does not).
          lastRow = Math.max(lastRow, done.r);
          lastColAll = Math.max(lastColAll, done.c);
          if (done.r >= rowLimit || done.c >= maxCols) return;
          const text = cap(shown.text);
          const cost = text.length + CELL_COST;
          if (cost > budget.chars) {
            // Out of text budget: keep whole rows only; the cap note counts the rest.
            rowLimit = done.r;
            while (cells.length > 0 && (cells[cells.length - 1]?.r ?? -1) >= done.r) {
              const dropped = cells.pop();
              budget.chars += (dropped?.text.length ?? 0) + CELL_COST;
            }
            return;
          }
          budget.chars -= cost;
          lastCol = Math.max(lastCol, done.c);
          cells.push({ r: done.r, c: done.c, text, kind: shown.kind });
        } else if (name === 'row') {
          if (stopAtCap && rowIndex + 1 >= maxRows) throw STOP;
        }
      },
      text(text) {
        if (cell === null) return;
        if (field === 'v' && cell.v.length < CELL_TEXT_CAP) cell.v += text;
        else if (field === 'f' && cell.f.length < CELL_TEXT_CAP) cell.f += text;
        else if (field === 'is' && inIsT && isText.length < CELL_TEXT_CAP) isText += text;
      },
    });
  } catch (error) {
    if (error !== STOP) throw error;
  }

  // Rows may arrive out of order: drop anything past the budget cut, then
  // recount the columns that still hold a value.
  const kept = cells.filter((c) => c.r < rowLimit);
  lastCol = kept.reduce((n, c) => Math.max(n, c.c), -1);
  const totalRows = lastRow + 1;
  const shownRows = Math.min(totalRows, rowLimit);
  let usedCols = lastCol + 1;
  for (const m of merges) {
    if (m.r0 < shownRows) usedCols = Math.max(usedCols, Math.min(m.c1, maxCols - 1) + 1);
  }
  const shownCols = Math.min(usedCols, maxCols);
  const colWidths = Array.from({ length: shownCols }, (_, c) => widths.get(c) ?? defaultPx);
  const shownMerges = keepMerges(
    merges
      .filter((m) => m.r0 < shownRows && m.c0 < shownCols && (m.r1 > m.r0 || m.c1 > m.c0))
      .map((m) => ({
        r0: m.r0,
        c0: m.c0,
        r1: Math.min(m.r1, shownRows - 1),
        c1: Math.min(m.c1, shownCols - 1),
      })),
    shownRows,
    shownCols,
  );
  return {
    name: sheet.name,
    totalRows,
    shownRows,
    shownCols,
    totalCols: Math.max(usedCols, lastColAll + 1),
    colWidths,
    merges: shownMerges,
    cells: kept,
  };
}

/** What a cell shows: its saved value; a formula without one shows its text. Pure. */
function cellText(
  cell: { t: string; s: number; f: string; v: string; hasV: boolean },
  book: Workbook,
): { text: string; kind: CellKind } | null {
  const formulaText = cell.f.trim() !== '' ? `=${cell.f}` : null;
  if (!cell.hasV && cell.t !== 'inlineStr') {
    return formulaText !== null ? { text: formulaText, kind: 's' } : null;
  }
  switch (cell.t) {
    case 's': {
      const s = book.strings[Number(cell.v)];
      return s === undefined ? null : { text: s, kind: 's' };
    }
    case 'str':
    case 'inlineStr':
      return { text: cell.v, kind: 's' };
    case 'b':
      return { text: cell.v.trim() === '1' ? 'TRUE' : 'FALSE', kind: 'b' };
    case 'e':
      return { text: cell.v, kind: 'e' };
    case 'd':
      return { text: cell.v.replace('T', ' ').replace(/(:\d\d)\.\d+Z?$|Z$/, '$1'), kind: 's' };
    default: {
      if (cell.v.trim() === '')
        return formulaText !== null ? { text: formulaText, kind: 's' } : null;
      const format = book.formats[cell.s] ?? { kind: 'general' };
      return {
        text: formatNumber(cell.v, format, book.date1904),
        kind: format.kind === 'date' ? 's' : 'n',
      };
    }
  }
}

/** The viewer's model: every visible worksheet. */
export function readXlsxView(pkg: OfficePackage, part: string): XlsxView {
  const book = readWorkbook(pkg, part);
  if (book.sheets.length === 0) throw new Error('no visible worksheet');
  return {
    kind: 'xlsx',
    totalSheets: book.visibleSheets,
    sheets: (() => {
      // One budget for the whole book: every cell, merge and sheet is copied out of the Worker.
      const budget = { chars: BOOK_TEXT_BUDGET };
      const out: SheetView[] = [];
      for (const s of book.sheets) {
        if (budget.chars <= 0) break;
        const sheet = readSheet(pkg, book, s, SHEET_ROW_CAP, SHEET_COL_CAP, false, budget);
        budget.chars -=
          SHEET_COST + sheet.name.length + sheet.shownCols * 8 + sheet.merges.length * CELL_COST;
        out.push(sheet);
      }
      return out;
    })(),
  };
}

/** The thumbnail's grid: the first visible sheet's top-left cells as plain strings. */
export function readXlsxThumb(pkg: OfficePackage, part: string): XlsxThumbGrid {
  const book = readWorkbook(pkg, part);
  const first = book.sheets[0];
  if (first === undefined) throw new Error('no visible worksheet');
  const sheet = readSheet(pkg, book, first, THUMB_GRID_ROWS, THUMB_GRID_COLS, true);
  const cells = Array.from({ length: THUMB_GRID_ROWS }, () =>
    Array.from({ length: THUMB_GRID_COLS }, () => ({ text: '', numeric: false })),
  );
  for (const c of sheet.cells) {
    const row = cells[c.r];
    if (row === undefined || c.c >= THUMB_GRID_COLS) continue;
    const text = c.text.replace(/\s+/g, ' ').trim();
    row[c.c] = {
      text: text.length > THUMB_CELL_CHARS ? `${text.slice(0, THUMB_CELL_CHARS - 1)}…` : text,
      numeric: c.kind === 'n',
    };
  }
  return { kind: 'xlsx', cells };
}
