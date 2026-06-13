import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  resolveChannelSummaries,
  listGroupsByIds,
  listProfilesByIds,
  type ChatChannelRow,
} from '@/lib/chat-reads';

const ME = 'me-0';

// Records every .from(table) call and serves canned rows per table through a
// thenable builder. Counting from() calls per table proves the resolver batches
// (one read per table) rather than fetching per channel.
function makeClient(rows: { groups: unknown[]; users: unknown[] }) {
  const fromCalls: string[] = [];
  const client = {
    from: (table: string) => {
      fromCalls.push(table);
      const data = table === 'groups' ? rows.groups : rows.users;
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'in', 'is']) b[method] = () => b;
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve);
      return b;
    },
  } as unknown as Client;
  return { client, fromCalls };
}

function channelRow(over: Partial<ChatChannelRow>): ChatChannelRow {
  return {
    agora_group_id: null,
    channel_id: 'c',
    channel_type: 'dm',
    created_at: '2026-06-01T00:00:00Z',
    dm_user_a: null,
    dm_user_b: null,
    entity_id: null,
    last_synced_at: null,
    workspace_id: 'ws-1',
    ...over,
  };
}

describe('listGroupsByIds / listProfilesByIds', () => {
  it('short-circuits with no query when there are no ids', async () => {
    const { client, fromCalls } = makeClient({ groups: [], users: [] });
    expect(await listGroupsByIds(client, { ids: [] })).toEqual({ ok: true, data: [] });
    expect(await listProfilesByIds(client, { ids: [] })).toEqual({ ok: true, data: [] });
    expect(fromCalls).toEqual([]);
  });
});

describe('resolveChannelSummaries', () => {
  it('resolves group names and DM peer names with one batched read per table', async () => {
    const channels: ChatChannelRow[] = [
      channelRow({ channel_id: 'g1', channel_type: 'group', entity_id: 'grp-1' }),
      channelRow({ channel_id: 'g2', channel_type: 'group', entity_id: 'grp-2' }),
      channelRow({ channel_id: 'd1', channel_type: 'dm', dm_user_a: ME, dm_user_b: 'peer-1' }),
      channelRow({ channel_id: 'd2', channel_type: 'dm', dm_user_a: 'peer-2', dm_user_b: ME }),
    ];
    const { client, fromCalls } = makeClient({
      groups: [
        { id: 'grp-1', name: 'Design' },
        { id: 'grp-2', name: 'Growth' },
      ],
      users: [
        { id: 'peer-1', display_name: 'Ada', avatar_url: null },
        { id: 'peer-2', display_name: 'Bo', avatar_url: 'a.png' },
      ],
    });

    const result = await resolveChannelSummaries(client, { channels, currentUserId: ME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.map((s) => s.title)).toEqual(['Design', 'Growth', 'Ada', 'Bo']);
    expect(result.data[3]?.avatarUrl).toBe('a.png');

    // Exactly one read of each table, never one-per-channel.
    expect(fromCalls.filter((t) => t === 'groups')).toHaveLength(1);
    expect(fromCalls.filter((t) => t === 'users')).toHaveLength(1);
  });

  it('falls back to generic labels when a referenced row is missing', async () => {
    const channels = [
      channelRow({ channel_id: 'd1', channel_type: 'dm', dm_user_a: ME, dm_user_b: 'ghost' }),
    ];
    const { client } = makeClient({ groups: [], users: [] });
    const result = await resolveChannelSummaries(client, { channels, currentUserId: ME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.title).toBe('Direct message');
  });
});
