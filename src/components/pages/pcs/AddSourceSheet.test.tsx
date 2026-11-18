import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADD_SOURCE_ACCEPT,
  ADD_SOURCE_ROWS,
  ADD_SOURCE_TITLE,
  addSourceTitle,
} from '@/components/pages/pcs/AddSourceSheet';

// The post's Add / Replace source sheet (18 Nov 2026). node environment, no
// DOM: the pure parts are called, the page wiring is pinned against the source.

const SHEET = readFileSync(fileURLToPath(new URL('./AddSourceSheet.tsx', import.meta.url)), 'utf8');
const PAGE = readFileSync(fileURLToPath(new URL('../PostDetailPage.tsx', import.meta.url)), 'utf8');

describe('AddSourceSheet', () => {
  it('three sources, in order: a photo or video, a document, Assets', () => {
    expect(ADD_SOURCE_ROWS.map((row) => row.source)).toEqual(['media', 'document', 'assets']);
    expect(ADD_SOURCE_ROWS.map((row) => row.label)).toEqual([
      'Photo or video',
      'Document',
      'Assets',
    ]);
  });

  it("rows are the app's sheet row (ui/ActionRow), with no type or alignment of their own", () => {
    expect(SHEET).toContain('<ActionRow');
    expect(SHEET).toContain('sub={row.hint}');
    expect(SHEET).not.toContain('PressableRow');
    // No hand-set font weight, size or text alignment in this sheet.
    expect(SHEET).not.toMatch(/\bfont-(medium|semibold|bold|normal)\b/);
    expect(SHEET).not.toMatch(/\btext-(xs|sm|base|lg|xl|center|right)\b/);
  });

  it("the title says Add, or Replace with the picture's place", () => {
    expect(addSourceTitle(null)).toBe(ADD_SOURCE_TITLE);
    expect(addSourceTitle(0)).toBe('Replace picture 1');
    expect(addSourceTitle(4)).toBe('Replace picture 5');
  });

  it('the device filters split the allowed types: pictures and videos, or documents', () => {
    const media = ADD_SOURCE_ACCEPT.media.split(',');
    const documents = ADD_SOURCE_ACCEPT.document.split(',');
    expect(media).toContain('image/jpeg');
    expect(media).toContain('video/mp4');
    expect(media).not.toContain('application/pdf');
    expect(documents).toContain('application/pdf');
    expect(documents.some((mime) => mime.startsWith('image/'))).toBe(false);
    expect(documents.some((mime) => mime.startsWith('video/'))).toBe(false);
    // Voice-note audio is never a post file.
    expect([...media, ...documents].some((mime) => mime.startsWith('audio/'))).toBe(false);
  });

  it('Add and Replace both open the source sheet first; every pick ends in one commit', () => {
    const open = PAGE.slice(PAGE.indexOf('function openAdd(target: AddTarget): void {'));
    expect(open.slice(0, open.indexOf('\n  }\n'))).toContain('setSourceTarget(target);');
    const apply = PAGE.slice(PAGE.indexOf('async function applyNewVersions'));
    const body = apply.slice(0, apply.indexOf('\n  }\n'));
    expect(body.split('commitGallery(')).toHaveLength(2);
    // New files land last.
    expect(body).toContain('ids = append(ids, versionId);');
    // Assets picks go through the same path as uploads.
    expect(PAGE).toContain('picks.map((pick) => pick.versionId)');
  });
});
