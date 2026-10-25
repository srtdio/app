import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));

import {
  COVER_TTL_MS,
  coverFor,
  idsToRead,
  primeCovers,
  requestPostCovers,
} from '@/lib/chat/post-covers';
import type { Client } from '@srtdio/rpc';

const NOW = 1_000_000;

describe('idsToRead', () => {
  it('asks for unknown and stale ids once each, never ones in flight', () => {
    const known = (id: string) =>
      id === 'fresh'
        ? { cover: null, at: NOW - 1 }
        : id === 'stale'
          ? { cover: null, at: NOW - COVER_TTL_MS }
          : undefined;
    const busy = (id: string) => id === 'busy';
    expect(idsToRead(['new', 'fresh', 'stale', 'busy', 'new'], known, busy, NOW)).toEqual([
      'new',
      'stale',
    ]);
  });
});

/** A client whose asset_attachments read returns `rows`, counting reads. */
function recordingClient(rows: unknown[]): { client: Client; reads: () => number } {
  let count = 0;
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    order: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
      count += 1;
      resolve({ data: rows, error: null });
    },
  };
  return { client: { from: () => chain } as unknown as Client, reads: () => count };
}

describe('requestPostCovers', () => {
  it('reads every id in one query, stores none for a post without media, then reads nothing', async () => {
    const { client, reads } = recordingClient([
      {
        entity_id: 'p-1',
        asset_version_id: 'v-1',
        asset_versions: { mime_type: 'image/jpeg', width: 1080, height: 1350 },
      },
    ]);
    await requestPostCovers(client, 'ws-x', ['p-1', 'p-2']);
    expect(reads()).toBe(1);
    expect(coverFor('ws-x', 'p-1')).toEqual({
      assetVersionId: 'v-1',
      kind: 'image',
      width: 1080,
      height: 1350,
    });
    expect(coverFor('ws-x', 'p-2')).toBeNull();
    await requestPostCovers(client, 'ws-x', ['p-1', 'p-2']);
    expect(reads()).toBe(1);
  });
});

describe('primeCovers', () => {
  it('stores covers a caller already read, so a request for them reads nothing', async () => {
    const cover = { assetVersionId: 'v-9', kind: 'video' as const, width: 1080, height: 1920 };
    primeCovers('ws-p', [
      ['p-9', cover],
      ['p-10', null],
    ]);
    expect(coverFor('ws-p', 'p-9')).toEqual(cover);
    expect(coverFor('ws-p', 'p-10')).toBeNull();
    const { client, reads } = recordingClient([]);
    await requestPostCovers(client, 'ws-p', ['p-9', 'p-10']);
    expect(reads()).toBe(0);
    // An id it was not given is still read.
    await requestPostCovers(client, 'ws-p', ['p-9', 'p-11']);
    expect(reads()).toBe(1);
  });
});
