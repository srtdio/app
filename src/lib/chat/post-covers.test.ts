import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));

import { COVER_TTL_MS, coverFor, idsToRead, requestPostCovers } from '@/lib/chat/post-covers';
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
