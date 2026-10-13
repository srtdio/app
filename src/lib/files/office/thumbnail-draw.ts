// docx and xlsx thumbnails, made on the sender's device at send (decision
// 154). The office Worker extracts plain strings; this module draws them with
// our own code onto a canvas: fillRect for paper and grid lines, fillText for
// text, measureText to wrap and cut. No HTML is ever built or rendered, no
// picture or font from the file is used, and nothing is a screenshot. Paper is
// white and the greys are fixed, so the JPEG reads the same in both themes.
// Loaded with a dynamic import from thumbnail.ts only.

import { runOffice, type OfficeWorkerLike } from './run';
import {
  OFFICE_MAX_BYTES,
  THUMB_GRID_COLS,
  THUMB_GRID_ROWS,
  THUMB_LINE_CHARS,
  THUMB_MAX_LINES,
  type DocxThumbText,
  type XlsxThumbGrid,
} from './types';

export const THUMB_WIDTH = 580;
/** The bubble's tallest box (height / width 1.3), so a sending card never changes height. */
export const SHEET_THUMB_HEIGHT = 754;
const MAX_HEIGHT = 1160;

const PAPER = '#ffffff';
const INK = '#1d1d24';
const INK_SOFT = '#4a4a55';
const HEAD_BG = '#f3f3f7';
const HEAD_INK = '#6b6b7a';
const GRID = '#dcdce4';
const SANS = 'Inter, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

/** The drawing calls this module makes; nothing else on the context is touched. */
export interface DrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** Cut `text` to fit `max` px, ending in an ellipsis when cut. */
export function fitText(ctx: DrawContext, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

/** Greedy word wrap into at most `maxLines` lines of at most `max` px. */
export function wrapText(ctx: DrawContext, text: string, max: number, maxLines: number): string[] {
  const words = text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, THUMB_LINE_CHARS * maxLines)
    .split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word === '') continue;
    const next = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(next).width <= max && next.length <= THUMB_LINE_CHARS) {
      line = next;
      continue;
    }
    if (line !== '') lines.push(line);
    if (lines.length >= maxLines) break;
    line = word;
  }
  if (line !== '' && lines.length < maxLines) lines.push(line);
  return lines.map((l) => fitText(ctx, l.slice(0, THUMB_LINE_CHARS), max));
}

/** The canvas size for a Word page of `aspect` (height / width). Pure. */
export function docxThumbSize(aspect: number): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 11 / 8.5;
  return { width: THUMB_WIDTH, height: Math.min(Math.round(THUMB_WIDTH * a), MAX_HEIGHT) };
}

/** Word: a white page, the title in bold, then the first paragraphs; at most 12 lines. */
export function drawDocxThumb(
  ctx: DrawContext,
  width: number,
  height: number,
  text: DocxThumbText,
): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const margin = Math.round(width * 0.09);
  const max = width - margin * 2;
  let y = margin;
  let lines = 0;
  ctx.textBaseline = 'top';
  if (text.title !== null) {
    ctx.font = `600 30px ${SANS}`;
    ctx.fillStyle = INK;
    for (const line of wrapText(ctx, text.title, max, 2)) {
      ctx.fillText(line, margin, y);
      y += 40;
      lines++;
    }
    y += 14;
  }
  ctx.font = `19px ${SANS}`;
  ctx.fillStyle = INK_SOFT;
  for (const paragraph of text.paragraphs) {
    if (lines >= THUMB_MAX_LINES || y + 28 > height - margin) break;
    const room = Math.min(THUMB_MAX_LINES - lines, Math.floor((height - margin - y) / 30));
    for (const line of wrapText(ctx, paragraph, max, room)) {
      ctx.fillText(line, margin, y);
      y += 30;
      lines++;
    }
    y += 12;
  }
}

/** "A".."E". Pure. */
function letter(i: number): string {
  return String.fromCharCode(65 + i);
}

/** Excel: the first sheet's top-left 8 x 5 cells with column letters and row numbers. */
export function drawXlsxThumb(
  ctx: DrawContext,
  width: number,
  height: number,
  grid: XlsxThumbGrid,
): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const headH = 56;
  const rowNumW = 56;
  const colW = (width - rowNumW) / THUMB_GRID_COLS;
  const rowH = (height - headH) / THUMB_GRID_ROWS;
  const pad = 12;

  ctx.fillStyle = HEAD_BG;
  ctx.fillRect(0, 0, width, headH);
  ctx.fillRect(0, 0, rowNumW, height);

  ctx.textBaseline = 'middle';
  ctx.font = `500 20px ${SANS}`;
  ctx.fillStyle = HEAD_INK;
  for (let c = 0; c < THUMB_GRID_COLS; c++) {
    const label = letter(c);
    const x = rowNumW + c * colW + (colW - ctx.measureText(label).width) / 2;
    ctx.fillText(label, x, headH / 2);
  }
  for (let r = 0; r < THUMB_GRID_ROWS; r++) {
    const label = String(r + 1);
    const x = (rowNumW - ctx.measureText(label).width) / 2;
    ctx.fillText(label, x, headH + r * rowH + rowH / 2);
  }

  ctx.fillStyle = INK;
  for (let r = 0; r < THUMB_GRID_ROWS; r++) {
    const row = grid.cells[r];
    if (row === undefined) continue;
    for (let c = 0; c < THUMB_GRID_COLS; c++) {
      const cell = row[c];
      if (cell === undefined || cell.text === '') continue;
      ctx.font = cell.numeric ? `21px ${MONO}` : `21px ${SANS}`;
      const shown = fitText(ctx, cell.text, colW - pad * 2);
      const left = rowNumW + c * colW;
      const x = cell.numeric ? left + colW - pad - ctx.measureText(shown).width : left + pad;
      ctx.fillText(shown, x, headH + r * rowH + rowH / 2);
    }
  }

  ctx.fillStyle = GRID;
  for (let c = 0; c <= THUMB_GRID_COLS; c++) {
    ctx.fillRect(Math.round(rowNumW + c * colW) - (c === THUMB_GRID_COLS ? 1 : 0), 0, 1, height);
  }
  ctx.fillRect(0, headH, width, 1);
  for (let r = 1; r <= THUMB_GRID_ROWS; r++) {
    ctx.fillRect(0, Math.round(headH + r * rowH) - (r === THUMB_GRID_ROWS ? 1 : 0), width, 1);
  }
}

export interface OfficeThumbDeps {
  createCanvas: () => HTMLCanvasElement;
  readBytes: (file: File) => Promise<Uint8Array>;
  createWorker?: (() => OfficeWorkerLike) | undefined;
}

/**
 * Parse `file` in the office Worker (bounded by `timeoutMs`, terminated after)
 * and draw its thumbnail onto a fresh canvas. Throws on any failure; the
 * caller turns that into NoThumbnail and releases the canvas.
 */
export async function officeThumbnailCanvas(
  file: File,
  signal: AbortSignal,
  timeoutMs: number,
  deps: OfficeThumbDeps,
  held: { canvas: HTMLCanvasElement | null },
): Promise<void> {
  if (file.size > OFFICE_MAX_BYTES) throw new Error('too large');
  const bytes = await deps.readBytes(file);
  if (signal.aborted) throw new Error('aborted');
  const response = await runOffice({
    op: 'thumb',
    bytes,
    mime: null,
    timeoutMs,
    signal,
    createWorker: deps.createWorker,
  });
  if (!response.ok || response.op !== 'thumb') throw new Error('no thumbnail text');
  const result = response.result;
  if (result.kind === 'unsupported') throw new Error('unsupported');
  if (signal.aborted) throw new Error('aborted');
  const size =
    result.kind === 'docx'
      ? docxThumbSize(result.aspect)
      : { width: THUMB_WIDTH, height: SHEET_THUMB_HEIGHT };
  const canvas = deps.createCanvas();
  held.canvas = canvas;
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  if (result.kind === 'docx') drawDocxThumb(ctx, size.width, size.height, result);
  else drawXlsxThumb(ctx, size.width, size.height, result);
}
