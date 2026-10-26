// Shared shapes for the office Worker (docx and xlsx), its runner, the viewers
// and the thumbnail drawer. Types and constants only: importing this module
// pulls no parser into a chunk.

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Files over this are never parsed (viewer: error card; upload: NoThumbnail). */
export const OFFICE_MAX_BYTES = 20 * 1024 * 1024;
/** The viewer's parse cap; past it the Worker is terminated and the error card shows. */
export const OFFICE_VIEW_TIMEOUT_MS = 10_000;
/** Rows shown per sheet; the rest are counted for the cap note. */
export const SHEET_ROW_CAP = 5000;
/** Columns shown per sheet (Excel allows 16,384). */
export const SHEET_COL_CAP = 256;
/** Characters kept per cell. */
export const CELL_TEXT_CAP = 32_000;
/** Column width bounds in CSS px. */
export const COL_WIDTH_MIN = 48;
export const COL_WIDTH_MAX = 320;
/** Thumbnail text caps: lines drawn, characters per line, cells in the grid. */
export const THUMB_MAX_LINES = 12;
export const THUMB_LINE_CHARS = 80;
export const THUMB_GRID_ROWS = 8;
export const THUMB_GRID_COLS = 5;
export const THUMB_CELL_CHARS = 40;

/** A Word document as escaped HTML (sanitized again on the main thread before srcdoc). */
export interface DocxView {
  kind: 'docx';
  /** One string per page section; split at explicit page breaks. */
  pages: string[];
  /** docProps/app.xml <Pages>, when the file states it. */
  pageCount: number | null;
  /** Page height / width from the section's page size. */
  aspect: number;
  /** Margins as fractions of the page width: top, right, bottom, left. */
  margins: [number, number, number, number];
}

export type CellKind = 'n' | 's' | 'b' | 'e';

export interface SheetCell {
  r: number;
  c: number;
  text: string;
  kind: CellKind;
}

export interface SheetMerge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface SheetView {
  name: string;
  /** Rows in the sheet (its last used row). */
  totalRows: number;
  /** Rows shown: min(totalRows, SHEET_ROW_CAP). */
  shownRows: number;
  /** Columns shown: min(used columns, SHEET_COL_CAP). */
  shownCols: number;
  totalCols: number;
  /** CSS px per shown column, clamped to COL_WIDTH_MIN..COL_WIDTH_MAX. */
  colWidths: number[];
  merges: SheetMerge[];
  cells: SheetCell[];
}

export interface XlsxView {
  kind: 'xlsx';
  /** Visible worksheets only, in workbook order (at most 64). */
  sheets: SheetView[];
  /** Visible worksheets in the file, for the cap note. */
  totalSheets: number;
}

export interface DocxThumbText {
  kind: 'docx';
  title: string | null;
  paragraphs: string[];
  aspect: number;
}

export interface XlsxThumbGrid {
  kind: 'xlsx';
  /** THUMB_GRID_ROWS x THUMB_GRID_COLS, top-left of the first visible sheet. */
  cells: Array<Array<{ text: string; numeric: boolean }>>;
}

export type OfficeFailure =
  | 'too_large'
  | 'locked'
  | 'corrupt'
  | 'mismatch'
  | 'failed'
  | 'timeout'
  | 'aborted';

export interface OfficeRequest {
  op: 'view' | 'thumb';
  bytes: ArrayBuffer;
  /** The server's mime for the version; null for the sender's own file. */
  mime: string | null;
}

export type OfficeViewResult = DocxView | XlsxView | { kind: 'unsupported' };
export type OfficeThumbResult = DocxThumbText | XlsxThumbGrid | { kind: 'unsupported' };

export type OfficeResponse =
  | { ok: true; op: 'view'; result: OfficeViewResult }
  | { ok: true; op: 'thumb'; result: OfficeThumbResult }
  | { ok: false; reason: OfficeFailure };
