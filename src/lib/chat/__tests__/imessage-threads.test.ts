import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_THREAD_ROOT_KEY,
  hydrateRoots,
  markMessagesDeleted,
  missingRootIds,
  parseLiveThreadRoot,
  pendingMessage,
  rowToThreadMessage,
  sendText,
  type ChatMessageRow,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import {
  OUTBOX_STORAGE_KEY,
  readPersistedOutbox,
  writePersistedOutbox,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import {
  PAGE_HYDRATION_WAIT_MS,
  admitRows,
  hydrationDeadline,
  parentIndexOf,
  rowReady,
} from '@/lib/chat/post-refs';
import { threadViewRows } from '@/lib/chat/use-thread-view';

const ME = '11111111-1111-4111-8111-111111111111';

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'm1',
    channel_id: 'c1',
    workspace_id: 'ws',
    sender_user_id: ME,
    body: 'hi',
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    agora_event_id: null,
    created_at: '2026-10-01T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
    ...over,
  };
}

function connection(send: ThreadConnection['send']): ThreadConnection {
  return {
    send,
    open: vi.fn(),
    close: vi.fn(),
    renewToken: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
  };
}

describe('thread root on rows', () => {
  it('a reply row carries its root; a top-level row none', () => {
    const reply = rowToThreadMessage(
      row({ id: 'r', reply_to_message_id: 'p', thread_root_message_id: 'root' }),
      ME,
    );
    expect(reply.threadRootId).toBe('root');
    expect(rowToThreadMessage(row({}), ME).threadRootId).toBeUndefined();
  });

  it('a deleted reply keeps its root, read as a tombstone or deleted live', () => {
    const tomb = rowToThreadMessage(
      row({ id: 'r', deleted_at: '2026-10-01T10:05:00Z', thread_root_message_id: 'root' }),
      ME,
    );
    expect(tomb.deleted).toBe(true);
    expect(tomb.threadRootId).toBe('root');
    const live = rowToThreadMessage(
      row({ id: 'r', reply_to_message_id: 'root', thread_root_message_id: 'root' }),
      ME,
    );
    const [deleted] = markMessagesDeleted([live], ['r']);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.threadRootId).toBe('root');
  });

  it('roots not loaded are read with the quotes and hydrate their post ids', () => {
    const member = rowToThreadMessage(
      row({ id: 'r', reply_to_message_id: 'p', thread_root_message_id: 'root' }),
      ME,
    );
    expect(missingRootIds([member], new Set(['r']))).toEqual(['root']);
    expect(missingRootIds([member], new Set(['r', 'root']))).toEqual([]);
    const rootCard = rowToThreadMessage(row({ id: 'root', shared_post_ids: ['p9'] }), ME);
    const mine = new Set(['r']);
    const [hydrated] = hydrateRoots([member], [rootCard], mine);
    expect(hydrated?.rootPostIds).toEqual(['p9']);
    // A root that cannot be read (or is deleted) shares nothing once its batch settles.
    expect(hydrateRoots([member], [])).toEqual([member]);
    expect(hydrateRoots([member], [], mine)[0]?.rootPostIds).toEqual([]);
    const deletedRoot = { ...rootCard, deleted: true };
    expect(hydrateRoots([member], [deletedRoot], mine)[0]?.rootPostIds).toEqual([]);
    // Another batch's row with its read still in flight is left unknown.
    expect(hydrateRoots([member], [], new Set(['other']))).toEqual([member]);
  });
});

describe('live ext root key', () => {
  it('rides the derived root next to the sorted ids, and reads back', async () => {
    const createMessage = vi.fn();
    await sendText({
      connection: connection(vi.fn().mockResolvedValue({})),
      target: { targetId: 'peer', chatType: 'singleChat' },
      text: 'Reply in thread',
      attachments: [],
      sharedPostIds: [],
      reply: { id: 'card', authorUserId: null, preview: 'Shared post', rootId: 'card' },
      createMessage,
      liveIds: { sorted_message_id: 'new', sorted_channel_id: 'c1' },
    });
    const ext: unknown = createMessage.mock.calls[0]?.[0]?.ext;
    expect(ext).toMatchObject({
      sorted_message_id: 'new',
      [LIVE_THREAD_ROOT_KEY]: 'card',
      reply_to: { id: 'card', author_user_id: null, preview: 'Shared post' },
    });
    // Never inside reply_to.
    expect(ext).not.toHaveProperty('reply_to.rootId');
    expect(parseLiveThreadRoot(ext)).toBe('card');
    expect(parseLiveThreadRoot({ sorted_message_id: 'x' })).toBeNull();
  });

  it('an own unrecorded reply paints with its root at once', () => {
    const pending = pendingMessage({
      id: 'new',
      currentUserId: ME,
      text: 'hi',
      local: {
        attachments: [],
        sharedPostIds: [],
        reply: { id: 'm', authorUserId: null, preview: 'x', rootId: 'card' },
      },
      estimatedMs: 1,
    });
    expect(pending.threadRootId).toBe('card');
    const noRoot = pendingMessage({
      id: 'n2',
      currentUserId: ME,
      text: 'hi',
      local: { attachments: [], sharedPostIds: [], reply: null },
      estimatedMs: 1,
    });
    expect(noRoot.threadRootId).toBeUndefined();
  });

  it('survives an outbox restore', () => {
    const data = new Map<string, string>();
    const storage: OutboxStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
    const scope = { workspaceId: 'wa', userId: 'u1' };
    const reply = { id: 'card', authorUserId: null, preview: 'Shared post', rootId: 'card' };
    writePersistedOutbox(storage, scope, {
      c1: [
        {
          id: 'm1',
          text: 'Reply in thread',
          local: { attachments: [], sharedPostIds: [], reply },
          state: 'sending',
        },
      ],
    });
    expect(data.has(OUTBOX_STORAGE_KEY)).toBe(true);
    expect(readPersistedOutbox(storage, scope).c1?.[0]?.local.reply).toEqual(reply);
  });
});

describe('page gate: thread readiness', () => {
  const at = Date.parse('2026-10-01T10:00:00Z');
  const member = (over: Partial<ThreadMessage>): ThreadMessage => ({
    ...rowToThreadMessage(
      row({ id: 'r', reply_to_message_id: 'x', thread_root_message_id: 'root' }),
      ME,
    ),
    reply: { id: 'x', authorUserId: null, preview: 'resolved' },
    ...over,
  });
  const ready = (
    m: ThreadMessage,
    opts: { nowMs?: number; chip?: boolean; count?: boolean; loaded?: string[] } = {},
  ): boolean =>
    rowReady(m, at, {
      parentIndex: parentIndexOf([]),
      chipSettled: () => opts.chip ?? true,
      nowMs: opts.nowMs ?? at,
      loaded: new Set(opts.loaded ?? []),
      countSettled: () => opts.count ?? true,
      threadPost: (r) => r.rootPostIds?.[0] ?? null,
    });

  it('waits for the root hydration, capped', () => {
    expect(ready(member({}))).toBe(false);
    expect(ready(member({}), { nowMs: at + PAGE_HYDRATION_WAIT_MS })).toBe(true);
  });

  it('a deadline already run out sets no new timer (no re-render loop)', () => {
    const waiting = member({});
    const { gate } = admitRows(null, 'k', [waiting], () => false, at);
    const index = parentIndexOf([]);
    const loaded = new Set<string>();
    expect(hydrationDeadline(gate, [waiting], index, loaded)).toBe(at + PAGE_HYDRATION_WAIT_MS);
    expect(
      hydrationDeadline(gate, [waiting], index, loaded, at + PAGE_HYDRATION_WAIT_MS),
    ).toBeNull();
  });

  it('a chip root waits for its post and the page counts read', () => {
    const chip = member({ rootPostIds: ['p1'] });
    expect(ready(chip, { chip: false })).toBe(false);
    expect(ready(chip, { count: false })).toBe(false);
    expect(ready(chip)).toBe(true);
    // A loaded root needs no counts read.
    expect(ready(chip, { count: false, loaded: ['root'] })).toBe(true);
    // A plain root: nothing to wait for.
    expect(ready(member({ rootPostIds: [] }), { count: false })).toBe(true);
  });
});

describe('thread view rows', () => {
  it('its root, then replies oldest first; the chat’s loaded copies win and add live ones', () => {
    const root = rowToThreadMessage(row({ id: 'root', shared_post_ids: ['p1'] }), ME);
    const old = rowToThreadMessage(
      row({
        id: 'a',
        reply_to_message_id: 'root',
        thread_root_message_id: 'root',
        created_at: '2026-10-01T10:01:00Z',
      }),
      ME,
    );
    const loadedCopy = { ...old, reactions: [{ emoji: '👍', count: 1, mine: true }] };
    const live = rowToThreadMessage(
      row({
        id: 'b',
        reply_to_message_id: 'a',
        thread_root_message_id: 'root',
        created_at: '2026-10-01T10:02:00Z',
      }),
      ME,
    );
    const other = rowToThreadMessage(row({ id: 'o', thread_root_message_id: 'else' }), ME);
    const view = { rootId: 'root', root, fetched: [old], hasMore: false };
    const { root: shownRoot, replies } = threadViewRows(view, [loadedCopy, live, other]);
    expect(shownRoot).toBe(root);
    expect(replies.map((m) => m.id)).toEqual(['a', 'b']);
    expect(replies[0]?.reactions).toHaveLength(1);
  });
});
