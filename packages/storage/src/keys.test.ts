import { describe, expect, it } from 'vitest';
import {
  legacyThumbnailKey,
  legacyVersionKey,
  renditionKey,
  uploadStagingKey,
  versionKey,
} from './keys';

const WS = '11111111-1111-7111-8111-111111111111';
const ASSET = '55555555-5555-7555-8555-555555555555';
const VERSION = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

// The reference: the exact expressions public.storage_workspace_move uses
// (supabase/migrations/20261026150000_storage_shared_bucket.sql), copied verbatim:
//   versions:   'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/original'
//   renditions: 'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/' || r.role
// sqlConcat evaluates such an expression: quoted parts are literals, bare names
// are looked up in the row.
function sqlConcat(expression: string, row: Readonly<Record<string, string>>): string {
  return expression
    .split('||')
    .map((part) => part.trim())
    .map((part) => {
      if (part.startsWith("'") && part.endsWith("'")) return part.slice(1, -1);
      const value = row[part];
      if (value === undefined) throw new Error(`unknown column ${part}`);
      return value;
    })
    .join('');
}

const SQL_VERSION_KEY =
  "'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/original'";
const SQL_RENDITION_KEY =
  "'ws/' || p_workspace_id || '/' || v.asset_id || '/' || v.id || '/' || r.role";

describe('versionKey', () => {
  it('equals the storage_workspace_move version expression', () => {
    const sql = sqlConcat(SQL_VERSION_KEY, {
      p_workspace_id: WS,
      'v.asset_id': ASSET,
      'v.id': VERSION,
    });
    expect(versionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION })).toBe(sql);
    expect(sql).toBe(`ws/${WS}/${ASSET}/${VERSION}/original`);
  });
});

describe('renditionKey', () => {
  it('equals the storage_workspace_move rendition expression for the thumbnail role', () => {
    const sql = sqlConcat(SQL_RENDITION_KEY, {
      p_workspace_id: WS,
      'v.asset_id': ASSET,
      'v.id': VERSION,
      'r.role': 'thumbnail',
    });
    expect(
      renditionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION, role: 'thumbnail' }),
    ).toBe(sql);
    expect(sql).toBe(`ws/${WS}/${ASSET}/${VERSION}/thumbnail`);
  });

  it('never equals the version key of the same version', () => {
    expect(
      renditionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION, role: 'thumbnail' }),
    ).not.toBe(versionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION }));
  });
});

describe('ID-only keys', () => {
  it('carry no filename, extension or kind', () => {
    const keys = [
      versionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION }),
      renditionKey({ workspaceId: WS, assetId: ASSET, versionId: VERSION, role: 'thumbnail' }),
      uploadStagingKey({ workspaceId: WS, uploadId: VERSION }),
    ];
    for (const key of keys) {
      expect(key).not.toMatch(/\.[a-z0-9]+$/i);
      expect(key).not.toMatch(/images|videos|docs|pdf|thumb\.jpg/);
    }
  });
});

describe('uploadStagingKey', () => {
  it('is uploads/<workspace_id>/<upload_id>', () => {
    expect(uploadStagingKey({ workspaceId: WS, uploadId: VERSION })).toBe(
      `uploads/${WS}/${VERSION}`,
    );
  });
});

describe('legacy keys (legacy per-workspace bucket only)', () => {
  it('keep the {kindFolder}/{asset}/v{n}-{filename} layout', () => {
    expect(
      legacyVersionKey({ kind: 'image', assetId: ASSET, versionNumber: 1, filename: 'photo.png' }),
    ).toBe(`images/${ASSET}/v1-photo.png`);
    expect(
      legacyVersionKey({ kind: 'video', assetId: ASSET, versionNumber: 2, filename: 'clip.mp4' }),
    ).toBe(`videos/${ASSET}/v2-clip.mp4`);
    expect(
      legacyVersionKey({ kind: 'document', assetId: ASSET, versionNumber: 1, filename: 'a.docx' }),
    ).toBe(`docs/${ASSET}/v1-a.docx`);
    expect(
      legacyVersionKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'my file?.pdf' }),
    ).toBe(`pdf/${ASSET}/v1-my_file_.pdf`);
    expect(
      legacyVersionKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: '...' }),
    ).toBe(`pdf/${ASSET}/v1-file`);
  });

  it('keep the {kindFolder}/{asset}/v{n}-thumb.jpg thumbnail layout', () => {
    expect(legacyThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 })).toBe(
      `pdf/${ASSET}/v1-thumb.jpg`,
    );
    expect(legacyThumbnailKey({ kind: 'video', assetId: ASSET, versionNumber: 3 })).toBe(
      `videos/${ASSET}/v3-thumb.jpg`,
    );
    expect(legacyThumbnailKey({ kind: 'spreadsheet', assetId: ASSET, versionNumber: 1 })).toBe(
      `spreadsheet/${ASSET}/v1-thumb.jpg`,
    );
  });

  it('a legacy file literally named thumb.jpg keys to the legacy thumbnail key', () => {
    expect(
      legacyVersionKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'thumb.jpg' }),
    ).toBe(legacyThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 }));
  });
});
