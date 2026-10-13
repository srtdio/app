import { describe, expect, it } from 'vitest';
import {
  BUBBLE_NAME_BUDGET,
  NAME_ELLIPSIS,
  extensionTail,
  fileKindLabel,
  graphemes,
  isOfficeMime,
  middleTruncate,
} from '@/lib/files/display-name';

/** Width in the helper's units: wide scripts count 2. */
function units(text: string): number {
  return graphemes(text).reduce((sum, g) => {
    const code = g.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x0900 && code <= 0x0dff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xff00 && code <= 0xff60);
    return sum + (wide ? 2 : 1);
  }, 0);
}

describe('middleTruncate (decision 152: wrap, then cut the middle, keep the extension)', () => {
  it('keeps a name that fits untouched', () => {
    expect(middleTruncate('brief.pdf')).toBe('brief.pdf');
    expect(middleTruncate('  spaced name.docx  ')).toBe('spaced name.docx');
  });

  it('an 80-char name with spaces and hyphens: cut in the middle, tail and extension kept', () => {
    const name = 'Q3 brand-refresh guidelines - client review round two - final final v12.pdf';
    const padded = `${name.slice(0, -4)} extra words here.pdf`;
    expect(padded.length).toBeGreaterThanOrEqual(80);
    const out = middleTruncate(padded);
    expect(out).toContain(NAME_ELLIPSIS);
    expect(out.endsWith('here.pdf')).toBe(true);
    expect(out.startsWith('Q3 brand-refresh')).toBe(true);
    expect(units(out)).toBeLessThanOrEqual(BUBBLE_NAME_BUDGET);
    // Never end-truncated: the last characters are the real tail of the name.
    expect(padded.endsWith(out.slice(out.indexOf(NAME_ELLIPSIS) + 1))).toBe(true);
  });

  it('an 80-char name with no spaces is cut the same way', () => {
    const name = `${'a'.repeat(76)}.mp4`;
    const out = middleTruncate(name);
    expect(out.endsWith('aaaaaa.mp4')).toBe(true);
    expect(out).toContain(NAME_ELLIPSIS);
    expect(units(out)).toBeLessThanOrEqual(BUBBLE_NAME_BUDGET);
  });

  it('a double extension keeps both parts', () => {
    expect(extensionTail('backup-2026.tar.gz')).toBe('.tar.gz');
    const out = middleTruncate(`${'x'.repeat(70)}.tar.gz`);
    expect(out.endsWith('.tar.gz')).toBe(true);
    expect(out).toContain(NAME_ELLIPSIS);
  });

  it('a name with no extension keeps its last characters', () => {
    expect(extensionTail('README')).toBe('');
    expect(extensionTail('.env')).toBe('');
    const name = `${'Long name without any extension at all '.repeat(3)}END`;
    const out = middleTruncate(name);
    expect(out.endsWith('ll END')).toBe(true);
    expect(units(out)).toBeLessThanOrEqual(BUBBLE_NAME_BUDGET);
  });

  it('CJK names count each glyph as two units and keep the extension', () => {
    const name = `${'企画書最終版'.repeat(6)}.pdf`;
    const out = middleTruncate(name);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out).toContain(NAME_ELLIPSIS);
    expect(units(out)).toBeLessThanOrEqual(BUBBLE_NAME_BUDGET);
    // A short CJK name fits as is.
    expect(middleTruncate('企画書.pdf')).toBe('企画書.pdf');
  });

  it('Devanagari never splits a cluster (combining marks stay with their letter)', () => {
    const name = `${'प्रस्ताव दस्तावेज़ '.repeat(4)}अंतिम.docx`;
    const out = middleTruncate(name);
    expect(out.endsWith('.docx')).toBe(true);
    expect(out).toContain(NAME_ELLIPSIS);
    // Every grapheme in the output is a whole grapheme of the input.
    const input = new Set(graphemes(name));
    for (const g of graphemes(out)) {
      if (g !== NAME_ELLIPSIS) expect(input.has(g)).toBe(true);
    }
    expect(units(out)).toBeLessThanOrEqual(BUBBLE_NAME_BUDGET);
  });

  it('an empty name reads Attachment', () => {
    expect(middleTruncate('   ')).toBe('Attachment');
  });
});

describe('fileKindLabel (from the mime, never the name)', () => {
  it.each([
    ['application/pdf', 'PDF'],
    ['video/mp4', 'Video'],
    ['video/quicktime', 'Video'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint'],
    ['text/csv', 'CSV'],
    ['application/octet-stream', 'File'],
    ['', 'File'],
  ])('%s -> %s', (mime, label) => {
    expect(fileKindLabel(mime)).toBe(label);
  });

  it('isOfficeMime is docx, xlsx and pptx only', () => {
    expect(
      isOfficeMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
    expect(isOfficeMime('application/msword')).toBe(false);
    expect(isOfficeMime('application/pdf')).toBe(false);
  });
});
