import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Regression for the ETL post_versions read. The bug: fetchVersionsForPosts()
// SELECTed columns that do not exist on v1 public.post_versions (content, images,
// canva_link, drive_link, linkedin_link, content_pillar, location), so the real
// run failed at FATAL: column pv.content does not exist. v1 post_versions has
// EXACTLY: id, post_id, caption, edited_by, edited_by_role, edited_at. The query
// (and the V1PostVersion type) must reference only columns that exist on v1.

const source = readFileSync(fileURLToPath(new URL('../src/source.ts', import.meta.url)), 'utf8');

// Isolate the fetchVersionsForPosts SQL so an unrelated query cannot mask a phantom.
function versionsQuery(): string {
  const start = source.indexOf('async fetchVersionsForPosts');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('async fetchCommentRefsBatch', start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('fetchVersionsForPosts v1 column set', () => {
  const sql = versionsQuery();

  it('selects only columns that exist on v1 post_versions', () => {
    expect(sql).toContain('pv.post_id');
    expect(sql).toContain('pv.caption');
    expect(sql).toContain('pv.edited_by');
    expect(sql).toContain('pv.edited_at');
  });

  it.each([
    'pv.content',
    'pv.images',
    'pv.canva_link',
    'pv.drive_link',
    'pv.linkedin_link',
    'pv.content_pillar',
    'pv.location',
  ])('does not reference the phantom v1 column %s', (phantom) => {
    expect(sql).not.toContain(phantom);
  });

  it('V1PostVersion type declares no phantom field', () => {
    const start = source.indexOf('export type V1PostVersion');
    const end = source.indexOf('};', start);
    const decl = source.slice(start, end);
    for (const field of [
      'content',
      'images',
      'canva_link',
      'drive_link',
      'linkedin_link',
      'content_pillar',
      'location',
    ]) {
      expect(decl).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    for (const field of ['post_id', 'caption', 'edited_by', 'edited_at']) {
      expect(decl).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
});
