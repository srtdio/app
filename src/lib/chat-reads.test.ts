import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  listChannels,
  listMessages,
  PAGE_SIZE,
  type ChatChannelRow,
  type ChatMessageRow,
} from '@/lib/chat-reads';

// A thenable query builder: every chained method returns itself and records its
// calls, and awaiting it yields the configured { data, error }. Mirrors the
// subset of the PostgREST builder the chat reads touch.
interface QueryCall {
  method: string;
  args: unknown[];
}

function builder(result: { data: unknown; error: { message: string } | null }) {
  const calls: QueryCall[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'range']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { b, calls };
}

function makeClient(result: { data: unknown; error: { message: string } | null }) {
  let calls: QueryCall[] = [];
  const client = {
    from: () => {
      const built = builder(result);
      calls = built.calls;
      return built.b;
    },
  } as unknown as Client;
  return { client, eqArgs: (): QueryCall[] => calls.filter((c) => c.method === 'eq') };
}

function channelRow(over: Partial<ChatChannelRow> = {}): ChatChannelRow {
  return {
    agora_group_id: null,
    channel_id: 'group:abc',
    channel_type: 'group',
    created_at: '2026-06-01T00:00:00Z',
    dm_user_a: null,
    dm_user_b: null,
    entity_id: null,
    last_synced_at: null,
    workspace_id: 'ws-1',
    ...over,
  };
}

function messageRow(over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    agora_event_id: 'evt-1',
    attachment_asset_ids: null,
    body: 'hi',
    channel_id: 'group:abc',
    created_at: '2026-06-01T00:00:00Z',
    deleted_at: null,
    edited_at: null,
    id: 'msg-1',
    mentions: null,
    sender_user_id: 'user-1',
    workspace_id: 'ws-1',
    ...over,
  };
}

describe('listChannels', () => {
  it('returns typed rows on success and filters by workspace_id', async () => {
    const rows = [channelRow(), channelRow({ channel_id: 'dm:ws-1:a:b', channel_type: 'dm' })];
    const { client, eqArgs } = makeClient({ data: rows, error: null });
    const result = await listChannels(client, { workspace_id: 'ws-1' });
    expect(result).toEqual({ ok: true, data: rows });
    expect(eqArgs()).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] });
  });

  it('returns [] (not null) when there are no rows', async () => {
    const { client } = makeClient({ data: null, error: null });
    const result = await listChannels(client, { workspace_id: 'ws-1' });
    expect(result).toEqual({ ok: true, data: [] });
  });

  it('returns ok:false (no throw) on a transport error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await listChannels(client, { workspace_id: 'ws-1' });
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'boom' } });
  });
});

describe('listMessages', () => {
  it('returns typed rows on success and filters by workspace_id + channel_id', async () => {
    const rows = [messageRow(), messageRow({ id: 'msg-2' })];
    const { client, eqArgs } = makeClient({ data: rows, error: null });
    const result = await listMessages(client, { workspace_id: 'ws-1', channel_id: 'group:abc' });
    expect(result).toEqual({ ok: true, data: rows });
    expect(eqArgs()).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] });
    expect(eqArgs()).toContainEqual({ method: 'eq', args: ['channel_id', 'group:abc'] });
  });

  it('returns [] (not null) when there are no rows', async () => {
    const { client } = makeClient({ data: null, error: null });
    const result = await listMessages(client, { workspace_id: 'ws-1', channel_id: 'group:abc' });
    expect(result).toEqual({ ok: true, data: [] });
  });

  it('returns ok:false (no throw) on a transport error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await listMessages(client, { workspace_id: 'ws-1', channel_id: 'group:abc' });
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'boom' } });
  });

  it('respects pagination bounds: page N maps to range [N*size, N*size+size-1]', async () => {
    let captured: unknown[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'is', 'order']) b[method] = () => b;
        b.range = (...args: unknown[]) => {
          captured = args;
          return b;
        };
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve);
        return b;
      },
    } as unknown as Client;

    await listMessages(client, { workspace_id: 'ws-1', channel_id: 'group:abc', page: 2 });
    expect(captured).toEqual([2 * PAGE_SIZE, 2 * PAGE_SIZE + PAGE_SIZE - 1]);
  });

  it('clamps a negative page to the first page', async () => {
    let captured: unknown[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'is', 'order']) b[method] = () => b;
        b.range = (...args: unknown[]) => {
          captured = args;
          return b;
        };
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve);
        return b;
      },
    } as unknown as Client;

    await listMessages(client, { workspace_id: 'ws-1', channel_id: 'group:abc', page: -5 });
    expect(captured).toEqual([0, PAGE_SIZE - 1]);
  });
});
