import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  ASSET_PAGE_SIZE,
  LIBRARY_SELECT,
  assetCursorAfter,
  assetCursorOr,
  assetSearchOr,
  libraryAttachments,
  listLibraryAssetsPage,
  shapeLibraryRows,
  toggleLibraryAsset,
  type LibraryAsset,
} from '@/lib/chat/asset-picker';
import { buildAttachmentMeta, toMessageAttachment } from '@/lib/chat/attachments';
import { scheduleAttachmentArgs } from '@/lib/chat/scheduled';

interface Read {
  table: string;
  select: unknown[];
  filters: Array<{ method: string; args: unknown[] }>;
}

function makeClient(reply: (read: Read) => { data: unknown; count?: number; error?: unknown }) {
  const reads: Read[] = [];
  const from = vi.fn((table: string) => {
    const read: Read = { table, select: [], filters: [] };
    reads.push(read);
    const b: Record<string, unknown> = {};
    b.select = (...args: unknown[]) => {
      read.select = args;
      return b;
    };
    for (const method of ['eq', 'neq', 'is', 'or', 'order', 'limit', 'abortSignal']) {
      b[method] = (...args: unknown[]) => {
        read.filters.push({ method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ error: null, count: null, ...reply(read) }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, reads };
}

function raw(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `a${n}`,
    filename: `file-${n}.png`,
    display_name: null,
    uploaded_at: `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00Z`,
    current_version_id: `v${n}`,
    current_version: {
      id: `v${n}`,
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 100 + n,
      width: 640,
      height: 480,
      duration_ms: null,
    },
    ...over,
  };
}

const WS = 'ws-1';

describe('listLibraryAssetsPage', () => {
  it('one read per page: library origin, not deleted, no links, newest first, 50, exact count', async () => {
    const { client, reads } = makeClient(() => ({ data: [raw(1)], count: 1 }));
    const result = await listLibraryAssetsPage(client, {
      workspaceId: WS,
      search: '',
      cursor: null,
    });
    expect(reads).toHaveLength(1);
    const read = reads[0] as Read;
    expect(read.table).toBe('assets');
    expect(read.select).toEqual([LIBRARY_SELECT, { count: 'exact' }]);
    expect(read.filters).toContainEqual({ method: 'eq', args: ['workspace_id', WS] });
    expect(read.filters).toContainEqual({ method: 'eq', args: ['origin', 'library'] });
    expect(read.filters).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(read.filters).toContainEqual({ method: 'neq', args: ['current_version.kind', 'link'] });
    expect(read.filters).toContainEqual({
      method: 'order',
      args: ['uploaded_at', { ascending: false }],
    });
    expect(read.filters).toContainEqual({ method: 'limit', args: [ASSET_PAGE_SIZE] });
    expect(ASSET_PAGE_SIZE).toBe(50);
    expect(read.filters.some((f) => f.method === 'or')).toBe(false);
    expect(result.ok && result.data.count).toBe(1);
    expect(result.ok && result.data.rows.map((r) => r.versionId)).toEqual(['v1']);
  });

  it('search is a server-side ILIKE on display_name or filename', async () => {
    const { client, reads } = makeClient(() => ({ data: [], count: 0 }));
    await listLibraryAssetsPage(client, { workspaceId: WS, search: ' hero ', cursor: null });
    expect(reads[0]?.filters).toContainEqual({
      method: 'or',
      args: ['display_name.ilike."%hero%",filename.ilike."%hero%"'],
    });
  });

  it('escapes LIKE metacharacters and quotes the value', () => {
    expect(assetSearchOr('50%_a,b')).toBe(
      // escapeLike adds one backslash, the quoting doubles it (PostgREST unquotes it back).
      'display_name.ilike."%50\\\\%\\\\_a,b%",filename.ilike."%50\\\\%\\\\_a,b%"',
    );
    expect(assetSearchOr('   ')).toBeNull();
  });

  it('next page: one keyset read after the last row, no count', async () => {
    const { client, reads } = makeClient(() => ({ data: [raw(2)] }));
    const page1 = shapeLibraryRows([raw(5), raw(4)]);
    const cursor = assetCursorAfter(page1);
    expect(cursor).toEqual({ uploadedAt: '2026-09-14T00:00:00Z', id: 'a4' });
    if (cursor === null) throw new Error('no cursor');
    const result = await listLibraryAssetsPage(client, { workspaceId: WS, search: 'x', cursor });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.select[1]).toEqual({});
    expect(reads[0]?.filters).toContainEqual({ method: 'or', args: [assetCursorOr(cursor)] });
    expect(result.ok && result.data.count).toBeNull();
  });

  it('a failed read is a Result, never a throw', async () => {
    const { client } = makeClient(() => ({ data: null, error: { message: 'boom' } }));
    const result = await listLibraryAssetsPage(client, {
      workspaceId: WS,
      search: '',
      cursor: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('shapeLibraryRows', () => {
  it('names a row by display_name, else filename; drops a row with no current version', () => {
    const rows = shapeLibraryRows([
      raw(1, { display_name: 'Hero shot' }),
      raw(2),
      raw(3, { current_version: null, current_version_id: null }),
    ]);
    expect(rows.map((r) => [r.name, r.filename, r.versionId])).toEqual([
      ['Hero shot', 'file-1.png', 'v1'],
      ['file-2.png', 'file-2.png', 'v2'],
    ]);
  });
});

describe('library picks as attachments', () => {
  const [hero, deck] = shapeLibraryRows([
    raw(1, { display_name: 'Hero.png' }),
    raw(2, {
      display_name: null,
      filename: 'Deck.pdf',
      current_version: {
        id: 'v2',
        kind: 'file',
        mime_type: 'application/pdf',
        size_bytes: 2048,
        width: null,
        height: null,
        duration_ms: null,
      },
    }),
  ]) as [LibraryAsset, LibraryAsset];

  it('confirm yields the current version ids, already uploaded (no local half)', () => {
    const attachments = libraryAttachments([hero, deck]);
    expect(attachments.map((a) => a.assetId)).toEqual(['v1', 'v2']);
    expect(attachments.every((a) => a.local === undefined)).toBe(true);
  });

  it('meta equals an upload-sent message for the same file shape (no width/height)', () => {
    const attachments = libraryAttachments([hero, deck]);
    const uploaded = [
      toMessageAttachment(new File([new Uint8Array(101)], 'Hero.png', { type: 'image/png' }), 'v1'),
      toMessageAttachment(
        new File([new Uint8Array(2048)], 'Deck.pdf', { type: 'application/pdf' }),
        'v2',
      ),
    ];
    expect(buildAttachmentMeta(attachments)).toEqual(buildAttachmentMeta(uploaded));
    expect(buildAttachmentMeta(attachments)).toEqual({
      v1: { mime: 'image/png', name: 'Hero.png', size: 101 },
      v2: { mime: 'application/pdf', name: 'Deck.pdf', size: 2048 },
    });
    // The schedule write builds the same args from them.
    expect(scheduleAttachmentArgs(attachments)).toEqual({
      attachmentAssetIds: ['v1', 'v2'],
      attachmentMeta: buildAttachmentMeta(uploaded),
    });
  });

  it('carries duration only when the version has one', () => {
    const [audio] = shapeLibraryRows([
      raw(7, {
        current_version: {
          id: 'v7',
          kind: 'file',
          mime_type: 'audio/mpeg',
          size_bytes: 10,
          width: null,
          height: null,
          duration_ms: 4200,
        },
      }),
    ]);
    if (audio === undefined) throw new Error('no row');
    expect(libraryAttachments([audio])[0]?.durationMs).toBe(4200);
    expect(libraryAttachments([hero])[0]).not.toHaveProperty('durationMs');
  });

  it('never adds the same version twice; toggling picks by asset id', () => {
    const first = libraryAttachments([hero]);
    expect(libraryAttachments([hero, deck], first).map((a) => a.assetId)).toEqual(['v2']);
    const picked = toggleLibraryAsset(toggleLibraryAsset([], hero), deck);
    expect(picked.map((a) => a.assetId)).toEqual(['a1', 'a2']);
    expect(toggleLibraryAsset(picked, hero).map((a) => a.assetId)).toEqual(['a2']);
  });
});
