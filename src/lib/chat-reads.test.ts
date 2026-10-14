import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  dmPeerId,
  listChannelSummaries,
  readProfiles,
  shapeChannelSummaries,
} from '@/lib/chat-reads';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER1 = '22222222-2222-4222-8222-222222222222';
const PEER2 = '33333333-3333-4333-8333-333333333333';

// A thenable PostgREST-ish builder: chained query methods return self; awaiting
// yields the configured result. Mirrors src/lib/assets.test.ts.
function builder(result: { data: unknown; error: { message: string } | null }) {
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'in', 'is']) {
    b[method] = () => b;
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

function makeClient(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const from = vi.fn((table: string) => builder(results[table] ?? { data: [], error: null }));
  return { client: { from } as unknown as Client, from };
}

describe('dmPeerId', () => {
  it('returns whichever participant is not the current user', () => {
    expect(dmPeerId({ dm_user_a: ME, dm_user_b: PEER1 }, ME)).toBe(PEER1);
    expect(dmPeerId({ dm_user_a: PEER1, dm_user_b: ME }, ME)).toBe(PEER1);
    expect(dmPeerId({ dm_user_a: null, dm_user_b: null }, ME)).toBeNull();
  });
});

describe('shapeChannelSummaries', () => {
  it('resolves group names by entity_id and DM peers by user id', () => {
    const channels = [
      {
        channel_id: 'g',
        channel_type: 'group',
        entity_id: 'grp1',
        agora_group_id: 'ag1',
        dm_user_a: null,
        dm_user_b: null,
        created_at: 't2',
      },
      {
        channel_id: 'd',
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: PEER1,
        created_at: 't1',
      },
    ] as never;
    const groups = new Map([['grp1', { id: 'grp1', name: 'Alpha' }]]) as never;
    const users = new Map([
      [PEER1, { id: PEER1, display_name: 'Ada', avatar_url: 'http://x/a.png' }],
    ]) as never;

    const out = shapeChannelSummaries(channels, groups, users, ME);
    expect(out[0]).toMatchObject({ channelType: 'group', title: 'Alpha', agoraGroupId: 'ag1' });
    expect(out[1]).toMatchObject({
      channelType: 'dm',
      title: 'Ada',
      avatarUrl: 'http://x/a.png',
      peerUserId: PEER1,
    });
  });

  it('falls back to neutral labels for missing rows', () => {
    const channels = [
      {
        channel_id: 'g',
        channel_type: 'group',
        entity_id: 'grpX',
        agora_group_id: null,
        dm_user_a: null,
        dm_user_b: null,
        created_at: 't',
      },
      {
        channel_id: 'd',
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: PEER1,
        created_at: 't',
      },
    ] as never;
    const out = shapeChannelSummaries(channels, new Map(), new Map(), ME);
    expect(out[0]?.title).toBe('Group');
    expect(out[1]?.title).toBe('Direct message');
  });
});

describe('listChannelSummaries', () => {
  it('resolves group and DM display with one batched read each (no per-row loop)', async () => {
    const { client, from } = makeClient({
      chat_channels: {
        data: [
          {
            channel_id: 'g1',
            channel_type: 'group',
            entity_id: 'grp1',
            agora_group_id: 'ag1',
            dm_user_a: null,
            dm_user_b: null,
            created_at: 't4',
          },
          {
            channel_id: 'g2',
            channel_type: 'group',
            entity_id: 'grp2',
            agora_group_id: 'ag2',
            dm_user_a: null,
            dm_user_b: null,
            created_at: 't3',
          },
          {
            channel_id: 'd1',
            channel_type: 'dm',
            entity_id: null,
            agora_group_id: null,
            dm_user_a: ME,
            dm_user_b: PEER1,
            created_at: 't2',
          },
          {
            channel_id: 'd2',
            channel_type: 'dm',
            entity_id: null,
            agora_group_id: null,
            dm_user_a: PEER2,
            dm_user_b: ME,
            created_at: 't1',
          },
        ],
        error: null,
      },
      groups: {
        data: [
          { id: 'grp1', name: 'Alpha' },
          { id: 'grp2', name: 'Beta' },
        ],
        error: null,
      },
      users: {
        data: [
          { id: PEER1, display_name: 'Ada', avatar_url: null },
          { id: PEER2, display_name: 'Bay', avatar_url: null },
        ],
        error: null,
      },
    });

    const result = await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });

    expect(result.ok).toBe(true);
    const groupReads = from.mock.calls.filter(([t]) => t === 'groups');
    const userReads = from.mock.calls.filter(([t]) => t === 'users');
    // Batched: one read total for all groups, one for all DM peers, never per channel.
    expect(groupReads).toHaveLength(1);
    expect(userReads).toHaveLength(1);
    if (result.ok) {
      expect(result.data.map((c) => c.title)).toEqual(['Alpha', 'Beta', 'Ada', 'Bay']);
    }
  });

  it('skips the groups read when there are no group channels', async () => {
    const { client, from } = makeClient({
      chat_channels: {
        data: [
          {
            channel_id: 'd1',
            channel_type: 'dm',
            entity_id: null,
            agora_group_id: null,
            dm_user_a: ME,
            dm_user_b: PEER1,
            created_at: 't1',
          },
        ],
        error: null,
      },
      users: { data: [{ id: PEER1, display_name: 'Ada', avatar_url: null }], error: null },
    });

    await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(from.mock.calls.filter(([t]) => t === 'groups')).toHaveLength(0);
  });

  it('surfaces a read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({
      chat_channels: { data: null, error: { message: 'boom' } },
    });
    const result = await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(result.ok).toBe(false);
  });
});

describe('listChannelSummaries peer roles', () => {
  const dmChannels = {
    data: [
      {
        channel_id: 'd1',
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: ME,
        dm_user_b: PEER1,
        created_at: 't2',
      },
      {
        channel_id: 'd2',
        channel_type: 'dm',
        entity_id: null,
        agora_group_id: null,
        dm_user_a: PEER2,
        dm_user_b: ME,
        created_at: 't1',
      },
      {
        channel_id: 'g1',
        channel_type: 'group',
        entity_id: 'grp1',
        agora_group_id: 'ag1',
        dm_user_a: null,
        dm_user_b: null,
        created_at: 't0',
      },
    ],
    error: null,
  };

  // Records every chained call on the workspace_members builder.
  function recordingClient(members: { data: unknown; error: { message: string } | null }) {
    const calls: [string, unknown[]][] = [];
    const tables: Record<string, { data: unknown; error: { message: string } | null }> = {
      chat_channels: dmChannels,
      groups: { data: [{ id: 'grp1', name: 'Alpha' }], error: null },
      users: {
        data: [
          { id: PEER1, display_name: 'Ada', avatar_url: null },
          { id: PEER2, display_name: 'Bay', avatar_url: null },
        ],
        error: null,
      },
    };
    const from = vi.fn((table: string) => {
      if (table !== 'workspace_members') return builder(tables[table] ?? { data: [], error: null });
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'is']) {
        b[method] = (...args: unknown[]) => {
          calls.push([method, args]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(members).then(resolve);
      return b;
    });
    return { client: { from } as unknown as Client, from, calls };
  }

  it('reads active peer roles in one batched workspace_members query', async () => {
    const { client, from, calls } = recordingClient({
      data: [{ user_id: PEER1, role: 'client' }],
      error: null,
    });
    await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(from.mock.calls.filter(([t]) => t === 'workspace_members')).toHaveLength(1);
    expect(calls).toEqual([
      ['select', ['user_id, role']],
      ['eq', ['workspace_id', 'w1']],
      ['eq', ['active', true]],
      ['is', ['removed_at', null]],
      ['in', ['user_id', [PEER1, PEER2]]],
    ]);
  });

  it('merges role onto DM summaries; null when absent and for groups', async () => {
    const { client } = recordingClient({
      data: [{ user_id: PEER1, role: 'agency' }],
      error: null,
    });
    const result = await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(result.ok && result.data.map((c) => [c.channelId, c.role])).toEqual([
      ['d1', 'agency'],
      ['d2', null],
      ['g1', null],
    ]);
  });

  it('skips the members read when there are no DM peers', async () => {
    const { client, from } = makeClient({
      chat_channels: { data: [dmChannels.data[2]], error: null },
      groups: { data: [{ id: 'grp1', name: 'Alpha' }], error: null },
    });
    await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(from.mock.calls.filter(([t]) => t === 'workspace_members')).toHaveLength(0);
  });

  it('surfaces a members read failure as a Result error', async () => {
    const { client } = recordingClient({ data: null, error: { message: 'denied' } });
    const result = await listChannelSummaries(client, { workspaceId: 'w1', currentUserId: ME });
    expect(result.ok).toBe(false);
  });
});

describe('readProfiles', () => {
  it('reads all ids in a single IN query and maps to ChatProfile', async () => {
    const { client, from } = makeClient({
      users: {
        data: [
          { id: PEER1, display_name: 'Ada', avatar_url: null, username: 'ada' },
          { id: PEER2, display_name: 'Bay', avatar_url: 'http://x/b.png' },
        ],
        error: null,
      },
    });
    const result = await readProfiles(client, [PEER1, PEER2, PEER1]);
    expect(from.mock.calls.filter(([t]) => t === 'users')).toHaveLength(1);
    expect(result.ok && result.data).toEqual([
      { userId: PEER1, displayName: 'Ada', avatarUrl: null, username: 'ada' },
      { userId: PEER2, displayName: 'Bay', avatarUrl: 'http://x/b.png', username: null },
    ]);
  });

  it('returns an empty list without a read when given no ids', async () => {
    const { client, from } = makeClient({});
    const result = await readProfiles(client, []);
    expect(from).not.toHaveBeenCalled();
    expect(result.ok && result.data).toEqual([]);
  });
});
