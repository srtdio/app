import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

// The chat store's import graph can reach the agora-chat browser SDK; mock it
// so importing the module in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

// The device cache queues IndexedDB writes; keep them out of the node run.
vi.mock('@/lib/device-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/device-cache')>();
  return { ...actual, put: vi.fn() };
});

import {
  HIDE_CHUNK_SIZE,
  HIDES_WHAT,
  hideLocal,
  hideMessages,
  hiddenIdsFor,
  hidesKey,
  readHiddenRows,
  resetHides,
  subscribeHides,
  summaryWithoutHidden,
  unhideLocal,
  withoutHidden,
} from '@/lib/chat/hides';
import { OWN_PREFIX, type ConversationSummary } from '@/lib/chat/chat-store';
import type { ThreadMessage } from '@/lib/chat/thread';

const WS = 'ws-1';

function fakeClient(fail: (call: number) => boolean = () => false): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
} {
  let calls = 0;
  const rpc = vi.fn(() => {
    calls += 1;
    return Promise.resolve(
      fail(calls) ? { data: null, error: { message: 'refused' } } : { data: null, error: null },
    );
  });
  return { client: { rpc } as unknown as Client, rpc };
}

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: 'hello',
    createdAt: '2026-11-07T10:00:00Z',
    time: Date.parse('2026-11-07T10:00:00Z'),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

afterEach(() => {
  resetHides();
});

describe('withoutHidden', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('drops hidden items with a Set lookup and keeps the order', () => {
    expect(withoutHidden(rows, new Set(['b']), (r) => r.id)).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('returns the same array when nothing is hidden (render identity holds)', () => {
    expect(withoutHidden(rows, new Set<string>(), (r) => r.id)).toBe(rows);
    expect(withoutHidden(rows, new Set(['zzz']), (r) => r.id)).toBe(rows);
  });

  it('returns a new array when something goes', () => {
    const kept = withoutHidden(rows, new Set(['a']), (r) => r.id);
    expect(kept).not.toBe(rows);
    expect(kept).toHaveLength(2);
  });
});

describe('the hidden-id store', () => {
  it('an unknown workspace holds the empty set', () => {
    expect(hiddenIdsFor('nope').size).toBe(0);
    expect(hiddenIdsFor(null).size).toBe(0);
  });

  it('hideLocal hides at once and notifies every subscriber', () => {
    const listener = vi.fn();
    const off = subscribeHides(listener);
    const before = hiddenIdsFor(WS);
    hideLocal(WS, [
      { messageId: 'm1', channelId: 'c1' },
      { messageId: 'm2', channelId: 'c1' },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    const after = hiddenIdsFor(WS);
    expect([...after].sort()).toEqual(['m1', 'm2']);
    // A new set on every change (useSyncExternalStore sees the change).
    expect(after).not.toBe(before);
    off();
    hideLocal(WS, [{ messageId: 'm3', channelId: 'c1' }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hideLocal with nothing is a no-op (no notify)', () => {
    const listener = vi.fn();
    const off = subscribeHides(listener);
    hideLocal(WS, []);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('unhideLocal shows them again (Undo) and notifies; unknown ids do not notify', () => {
    hideLocal(WS, [
      { messageId: 'm1', channelId: 'c1' },
      { messageId: 'm2', channelId: 'c1' },
    ]);
    const listener = vi.fn();
    const off = subscribeHides(listener);
    unhideLocal(WS, ['m1']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...hiddenIdsFor(WS)]).toEqual(['m2']);
    unhideLocal(WS, ['never-hidden']);
    unhideLocal('other-ws', ['m2']);
    expect(listener).toHaveBeenCalledTimes(1);
    unhideLocal(WS, ['m2']);
    expect(hiddenIdsFor(WS).size).toBe(0);
    off();
  });

  it('keeps workspaces apart', () => {
    hideLocal(WS, [{ messageId: 'm1', channelId: 'c1' }]);
    expect(hiddenIdsFor('ws-2').has('m1')).toBe(false);
  });

  it('resetHides forgets every workspace (sign-out)', () => {
    hideLocal(WS, [{ messageId: 'm1', channelId: 'c1' }]);
    resetHides();
    expect(hiddenIdsFor(WS).size).toBe(0);
  });
});

describe('readHiddenRows and the key', () => {
  it('keeps only well-formed rows; a non-array is null', () => {
    expect(readHiddenRows(null)).toBeNull();
    expect(readHiddenRows({})).toBeNull();
    expect(
      readHiddenRows([
        { message_id: 'm1', channel_id: 'c1', extra: 1 },
        { message_id: 'm2' },
        null,
        'x',
      ]),
    ).toEqual([{ message_id: 'm1', channel_id: 'c1' }]);
  });

  it('the device-cache key ends in chat:hides', () => {
    expect(HIDES_WHAT).toBe('chat:hides');
    expect(hidesKey('u1', WS)).toBe(`u1:${WS}:chat:hides`);
  });
});

describe('hideMessages (chat_messages_hide)', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ messageId: `m${i}`, channelId: 'c1' }));

  it('writes in chunks of 100, in order, each with the action trace id', async () => {
    expect(HIDE_CHUNK_SIZE).toBe(100);
    const { client, rpc } = fakeClient();
    await hideMessages({ userId: 'u1', workspaceId: WS, items, traceId: 'trace-1', client });
    expect(rpc).toHaveBeenCalledTimes(3);
    const calls = rpc.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls.map((c) => c[0])).toEqual([
      'chat_messages_hide',
      'chat_messages_hide',
      'chat_messages_hide',
    ]);
    expect(calls.map((c) => (c[1].p_message_ids as string[]).length)).toEqual([100, 100, 50]);
    expect(calls[0]?.[1].p_message_ids).toEqual(items.slice(0, 100).map((i) => i.messageId));
    expect(calls[2]?.[1].p_message_ids).toEqual(items.slice(200).map((i) => i.messageId));
    for (const call of calls) expect(call[1].p_trace_id).toBe('trace-1');
  });

  it('once every chunk holds, the ids stay hidden after the local copy is undone', async () => {
    const { client } = fakeClient();
    const two = items.slice(0, 2);
    hideLocal(WS, two);
    await hideMessages({ userId: 'u1', workspaceId: WS, items: two, traceId: 't', client });
    // The recorded rows hold the ids; the device's local copy is no longer needed.
    unhideLocal(
      WS,
      two.map((i) => i.messageId),
    );
    expect([...hiddenIdsFor(WS)].sort()).toEqual(['m0', 'm1']);
  });

  it('throws on the first failed chunk and stops there', async () => {
    const { client, rpc } = fakeClient((call) => call === 2);
    await expect(
      hideMessages({ userId: 'u1', workspaceId: WS, items, traceId: 't', client }),
    ).rejects.toThrow('refused');
    expect(rpc).toHaveBeenCalledTimes(2);
    // Nothing is recorded as hidden by the failed write.
    expect(hiddenIdsFor(WS).size).toBe(0);
  });
});

describe('summaryWithoutHidden', () => {
  const summary: ConversationSummary = {
    lastMessageText: 'secret',
    lastMessageTs: 1000,
    unread: 2,
    lastMessageId: 'm3',
  };

  it('keeps the same summary when its line is not hidden', () => {
    expect(summaryWithoutHidden(summary, new Set<string>(), () => [])).toBe(summary);
    expect(summaryWithoutHidden(summary, new Set(['m1']), () => [])).toBe(summary);
    expect(summaryWithoutHidden(undefined, new Set(['m3']), () => [])).toBeUndefined();
  });

  it('falls back to the latest visible held message, keeping time and unread', () => {
    const held = [
      message({ id: 'm1', body: 'first' }),
      message({ id: 'm2', body: 'mine', mine: true }),
      message({ id: 'm3', body: 'secret' }),
    ];
    expect(summaryWithoutHidden(summary, new Set(['m3']), () => held)).toEqual({
      lastMessageText: 'mine',
      lastMessageTs: 1000,
      unread: 2,
      lastMessageId: 'm2',
      lastMessagePrefix: OWN_PREFIX,
    });
  });

  it('skips hidden, deleted and unsent rows; none left gives the empty line', () => {
    const held = [
      message({ id: 'm0', body: 'gone', deleted: true }),
      message({ id: 'm1', body: 'pending', state: 'sending' }),
      message({ id: 'm2', body: 'also hidden' }),
      message({ id: 'm3', body: 'secret' }),
    ];
    expect(summaryWithoutHidden(summary, new Set(['m2', 'm3']), () => held)).toEqual({
      lastMessageText: '',
      lastMessageTs: 1000,
      unread: 2,
    });
    expect(summaryWithoutHidden(summary, new Set(['m3']), () => undefined)).toEqual({
      lastMessageText: '',
      lastMessageTs: 1000,
      unread: 2,
    });
  });
});
