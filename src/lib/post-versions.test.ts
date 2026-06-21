import { describe, expect, it } from 'vitest';
import type { PostVersion } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';
import {
  currentVersionNumber,
  parseSnapshot,
  sortVersionsDesc,
  toVersionViews,
} from '@/lib/post-versions';

describe('parseSnapshot', () => {
  it('reads caption and gallery from the canonical v2 shape', () => {
    const raw: Json = { caption: 'Hello world', gallery: ['av-1', 'av-2', 'av-3'] };
    expect(parseSnapshot(raw)).toEqual({
      caption: 'Hello world',
      galleryVersionIds: ['av-1', 'av-2', 'av-3'],
    });
  });

  it('treats an empty v2 gallery and a null caption as empty', () => {
    expect(parseSnapshot({ caption: null, gallery: [] })).toEqual({
      caption: null,
      galleryVersionIds: [],
    });
  });

  it('filters non-string gallery entries, never throwing', () => {
    const raw: Json = { caption: 'c', gallery: ['av-1', 2, null, 'av-2', false] };
    expect(parseSnapshot(raw)).toEqual({ caption: 'c', galleryVersionIds: ['av-1', 'av-2'] });
  });

  it('handles a legacy ETL shape: keeps a string caption, drops unknown keys', () => {
    const raw: Json = {
      content: 'legacy body',
      images: ['x', 'y'],
      canva_link: 'https://example.com',
      location: 'NYC',
    };
    expect(parseSnapshot(raw)).toEqual({ caption: null, galleryVersionIds: [] });
  });

  it('reads a caption from a legacy shape when it is a string', () => {
    expect(parseSnapshot({ caption: 'kept', images: ['a'] })).toEqual({
      caption: 'kept',
      galleryVersionIds: [],
    });
  });

  it('returns empty for malformed inputs without throwing', () => {
    const cases: Array<Json | null> = [null, 42, 'a string', true, ['array', 'value']];
    for (const raw of cases) {
      expect(parseSnapshot(raw)).toEqual({ caption: null, galleryVersionIds: [] });
    }
    expect(parseSnapshot({ caption: 123, gallery: 'nope' })).toEqual({
      caption: null,
      galleryVersionIds: [],
    });
  });
});

describe('currentVersionNumber', () => {
  it('returns the highest version number', () => {
    expect(
      currentVersionNumber([{ versionNumber: 1 }, { versionNumber: 3 }, { versionNumber: 2 }]),
    ).toBe(3);
  });

  it('returns null for an empty list', () => {
    expect(currentVersionNumber([])).toBeNull();
  });
});

describe('sortVersionsDesc', () => {
  it('orders newest first without mutating the input', () => {
    const input = [{ versionNumber: 1 }, { versionNumber: 3 }, { versionNumber: 2 }];
    expect(sortVersionsDesc(input).map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(input.map((v) => v.versionNumber)).toEqual([1, 3, 2]);
  });
});

describe('toVersionViews', () => {
  // created_by is FK SET NULL (nullable at runtime) though the generated Row types
  // it as string; the override allows null so we can exercise the ex-member path.
  type RowOver = Partial<Omit<PostVersion, 'created_by'>> & { created_by?: string | null };
  function row(over: RowOver): PostVersion {
    const base = {
      id: 'v',
      post_id: 'p',
      workspace_id: 'w',
      version_number: 1,
      snapshot: { caption: 'c', gallery: [] } as Json,
      created_by: 'u-1' as string | null,
      legacy_author_name: null as string | null,
      created_at: '2026-06-01T00:00:00.000Z',
    };
    return { ...base, ...over } as unknown as PostVersion;
  }

  it('camelcases the rows and orders version_number ascending', () => {
    const views = toVersionViews([
      row({ id: 'b', version_number: 2 }),
      row({ id: 'a', version_number: 1, created_by: null }),
    ]);
    expect(views.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(views[0]).toMatchObject({ id: 'a', versionNumber: 1, createdBy: null });
    expect(views[1]).toMatchObject({ id: 'b', versionNumber: 2, createdBy: 'u-1' });
  });

  it('carries legacy_author_name through to legacyAuthorName, null when absent', () => {
    const views = toVersionViews([
      row({ id: 'a', version_number: 1, created_by: null, legacy_author_name: 'Casey Cutover' }),
      row({ id: 'b', version_number: 2, created_by: 'u-1', legacy_author_name: null }),
    ]);
    expect(views[0]).toMatchObject({ createdBy: null, legacyAuthorName: 'Casey Cutover' });
    expect(views[1]).toMatchObject({ createdBy: 'u-1', legacyAuthorName: null });
  });
});
