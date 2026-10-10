import { describe, expect, it } from 'vitest';
import {
  applyClear,
  applyClears,
  applyRoster,
  beginLoad,
  loadFailed,
  loadReady,
  loadScope,
  selectLoadStatus,
  isChannelHidden,
  outboxDropChannel,
  selectHidden,
  applyIncoming,
  applyChannelPreviews,
  applyPreviews,
  applyServerClock,
  CLOCK_SAMPLER_LIMIT,
  createClockSampler,
  channelsShowingDeleted,
  stripDeletedQuotes,
  stripPersistedQuotes,
  applyUnreadCounts,
  clearPendingOpen,
  clearPersistedOutbox,
  OUTBOX_STORAGE_KEY,
  persistedOutboxIds,
  readPersistedOutbox,
  writePersistedOutbox,
  type OutboxStorage,
  initialState,
  outboxPut,
  outboxRemove,
  outboxSetState,
  selectOutbox,
  type Outbox,
  type OutboxEntry,
  markRead,
  mergeInitial,
  previewText,
  messagePreviewContent,
  PREVIEW_LABELS,
  requestOpen,
  selectConversation,
  selectTotalUnread,
  setActive,
  updateOwnMessage,
  type ChatStoreState,
} from '@/lib/chat/chat-store';

const ME = 'me';

/** A store seeded with two known channels from chat_unread_counts. */
function seeded(): ChatStoreState {
  return applyUnreadCounts(mergeInitial([{ channelId: 'a' }, { channelId: 'b' }]), [
    { channelId: 'a', unread: 1, lastMessageAt: '1970-01-01T00:00:00.010Z' },
    { channelId: 'b', unread: 2, lastMessageAt: '1970-01-01T00:00:00.020Z' },
  ]);
}

describe('mergeInitial + applyUnreadCounts', () => {
  it('keys every roster channel at unread 0 and lets chat_unread_counts drive badges + order', () => {
    const state = applyUnreadCounts(mergeInitial([{ channelId: 'a' }, { channelId: 'silent' }]), [
      { channelId: 'a', unread: 3, lastMessageAt: '1970-01-01T00:00:00.005Z' },
    ]);

    expect(selectConversation(state, 'a')).toEqual({
      lastMessageText: '',
      lastMessageTs: 5,
      unread: 3,
    });
    expect(selectConversation(state, 'silent')).toEqual({
      lastMessageText: '',
      lastMessageTs: 0,
      unread: 0,
    });
    expect(selectTotalUnread(state)).toBe(3);
  });

  it('pins the active conversation at unread 0 on refresh and keeps the preview text', () => {
    const viewing = setActive(
      applyPreviews(
        seeded(),
        [
          {
            channelId: 'a',
            messageId: 'm',
            senderUserId: 'x',
            body: 'hi a',
            hasAttachments: false,
            createdAt: '1970-01-01T00:00:00.010Z',
          },
        ],
        ME,
      ),
      'a',
    );
    const refreshed = applyUnreadCounts(viewing, [
      { channelId: 'a', unread: 5, lastMessageAt: '1970-01-01T00:00:00.030Z' },
    ]);
    expect(selectConversation(refreshed, 'a')).toEqual({
      lastMessageText: 'hi a',
      lastMessageTs: 30,
      unread: 0,
      lastMessageId: 'm',
    });
  });
});

describe('applyUnreadCounts absent channels', () => {
  it('sets a channel absent from the result to 0 (a stale live increment does not survive)', () => {
    const state = applyUnreadCounts(seeded(), [
      { channelId: 'b', unread: 4, lastMessageAt: '1970-01-01T00:00:00.040Z' },
    ]);
    expect(selectConversation(state, 'a')?.unread).toBe(0);
    expect(selectConversation(state, 'a')?.lastMessageTs).toBe(10);
    expect(selectConversation(state, 'b')?.unread).toBe(4);
    expect(selectTotalUnread(applyUnreadCounts(seeded(), []))).toBe(0);
  });
});

describe('outbox (per-channel unrecorded sends)', () => {
  const entry = (id: string, state: OutboxEntry['state'] = 'sending'): OutboxEntry => ({
    id,
    text: id,
    local: { attachments: [], sharedPostIds: [], reply: null },
    state,
  });

  it("keeps each channel's sends apart, so switching channels loses nothing", () => {
    let box: Outbox = {};
    box = outboxPut(box, 'a', entry('a1'));
    box = outboxPut(box, 'b', entry('b1'));
    box = outboxSetState(box, 'a', 'a1', 'failed');
    expect(selectOutbox(box, 'a')).toEqual([entry('a1', 'failed')]);
    expect(selectOutbox(box, 'b')).toEqual([entry('b1')]);
    box = outboxRemove(box, 'b', 'b1');
    expect(selectOutbox(box, 'b')).toEqual([]);
    expect(Object.keys(box)).toEqual(['a']);
    expect(outboxSetState(box, 'a', 'unknown', 'failed')).toBe(box);
  });
});

describe('outbox persistence (reload)', () => {
  const entry = (id: string): OutboxEntry => ({
    id,
    text: `body ${id}`,
    local: {
      attachments: [{ assetId: 'v1', name: 'a.png', mime: 'image/png', size: 3 }],
      sharedPostIds: ['p1'],
      sharedBriefIds: [],
      reply: { id: 'q1', authorUserId: null, preview: 'hi' },
    },
    state: 'sending',
  });

  function memoryStorage(): OutboxStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }

  const A = { workspaceId: 'wa', userId: 'u1' };

  it('drops the File on write; an unfinished upload restores failed with Remove only (filesMissing)', () => {
    const storage = memoryStorage();
    const file = new File(['abc'], 'p.png', { type: 'image/png' });
    const local = { key: 'local-1', file, previewUrl: 'blob:p', progress: 0.4 };
    const uploaded = { key: 'local-2', file, previewUrl: 'blob:q', progress: 1 };
    const pending: OutboxEntry = {
      id: 'm1',
      text: '',
      local: {
        attachments: [
          { assetId: 'v9', name: 'q.png', mime: 'image/png', size: 3, local: uploaded },
          { assetId: '', name: 'p.png', mime: 'image/png', size: 3, local },
        ],
        sharedPostIds: [],
        reply: null,
      },
      state: 'sending',
    };
    const done: OutboxEntry = {
      id: 'm2',
      text: 'hi',
      local: {
        attachments: [
          { assetId: 'v1', name: 'a.png', mime: 'image/png', size: 3, local: uploaded },
        ],
        sharedPostIds: [],
        reply: null,
      },
      state: 'sending',
    };
    writePersistedOutbox(storage, A, { c1: [pending, done] });
    const raw = storage.data.get(OUTBOX_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('blob:');
    expect(raw).not.toContain('"local-');
    expect(readPersistedOutbox(storage, A)).toEqual({
      c1: [
        {
          id: 'm1',
          text: '',
          local: {
            attachments: [
              { assetId: 'v9', name: 'q.png', mime: 'image/png', size: 3 },
              { assetId: '', name: 'p.png', mime: 'image/png', size: 3 },
            ],
            sharedPostIds: [],
            reply: null,
          },
          state: 'failed',
          filesMissing: true,
        },
        // Every file already has its version id: it can still record, so it resumes.
        {
          id: 'm2',
          text: 'hi',
          local: {
            attachments: [{ assetId: 'v1', name: 'a.png', mime: 'image/png', size: 3 }],
            sharedPostIds: [],
            reply: null,
          },
          state: 'sending',
        },
      ],
    });
  });

  it('restores entries for the same workspace and user only, all as sending', () => {
    const storage = memoryStorage();
    writePersistedOutbox(storage, A, { c1: [{ ...entry('m1'), state: 'failed' }] });
    expect([...storage.data.keys()]).toEqual([OUTBOX_STORAGE_KEY]);
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    expect(readPersistedOutbox(storage, { workspaceId: 'wb', userId: 'u1' })).toEqual({});
    // Another workspace leaves the blob alone (it resumes on return).
    expect(storage.data.has(OUTBOX_STORAGE_KEY)).toBe(true);
  });

  it("never hands one user another user's bodies, and deletes them", () => {
    const storage = memoryStorage();
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    expect(readPersistedOutbox(storage, { workspaceId: 'wa', userId: 'u2' })).toEqual({});
    expect(storage.data.has(OUTBOX_STORAGE_KEY)).toBe(false);
  });

  it('keeps one slot per workspace: writing B never drops A', () => {
    const storage = memoryStorage();
    const B = { workspaceId: 'wb', userId: 'u1' };
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    writePersistedOutbox(storage, B, { c9: [entry('m9')] });
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    expect(readPersistedOutbox(storage, B)).toEqual({ c9: [entry('m9')] });
    expect(persistedOutboxIds(storage)).toEqual(new Set(['m1', 'm9']));
  });

  it('emptying one workspace keeps the others; the last slot removes the key', () => {
    const storage = memoryStorage();
    const B = { workspaceId: 'wb', userId: 'u1' };
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    writePersistedOutbox(storage, B, { c9: [entry('m9')] });
    writePersistedOutbox(storage, B, {});
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    expect(readPersistedOutbox(storage, B)).toEqual({});
    writePersistedOutbox(storage, A, {});
    expect(storage.data.has(OUTBOX_STORAGE_KEY)).toBe(false);
  });

  it("replaces another user's blob on write, never merging it", () => {
    const storage = memoryStorage();
    writePersistedOutbox(storage, { workspaceId: 'wb', userId: 'u2' }, { c9: [entry('m9')] });
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    expect(storage.data.get(OUTBOX_STORAGE_KEY)).not.toContain('m9');
    expect(persistedOutboxIds(storage)).toEqual(new Set(['m1']));
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
  });

  it('folds a v1 blob into v2 under its workspace and removes v1', () => {
    const storage = memoryStorage();
    storage.setItem(
      'sorted:chat:outbox:v1',
      JSON.stringify({ workspaceId: 'wa', userId: 'u1', outbox: { c1: [entry('m1')] } }),
    );
    writePersistedOutbox(storage, { workspaceId: 'wb', userId: 'u1' }, { c9: [entry('m9')] });
    expect(storage.data.has('sorted:chat:outbox:v1')).toBe(false);
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    expect(persistedOutboxIds(storage)).toEqual(new Set(['m1', 'm9']));
  });

  it("migrates on read and drops another user's v1 blob", () => {
    const storage = memoryStorage();
    storage.setItem(
      'sorted:chat:outbox:v1',
      JSON.stringify({ workspaceId: 'wa', userId: 'u1', outbox: { c1: [entry('m1')] } }),
    );
    expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    expect(storage.data.has('sorted:chat:outbox:v1')).toBe(false);
    expect(storage.data.has(OUTBOX_STORAGE_KEY)).toBe(true);

    const other = memoryStorage();
    other.setItem(
      'sorted:chat:outbox:v1',
      JSON.stringify({ workspaceId: 'wa', userId: 'u2', outbox: { c1: [entry('m1')] } }),
    );
    expect(readPersistedOutbox(other, A)).toEqual({});
    expect([...other.data.keys()]).toEqual([]);
  });

  it('an emptied outbox removes the key; sign-out clears v1 and v2', () => {
    const storage = memoryStorage();
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    writePersistedOutbox(storage, A, {});
    expect(storage.data.has(OUTBOX_STORAGE_KEY)).toBe(false);
    writePersistedOutbox(storage, A, { c1: [entry('m1')] });
    storage.setItem('sorted:chat:outbox:v1', '{}');
    clearPersistedOutbox(storage);
    expect([...storage.data.keys()]).toEqual([]);
  });

  it('a malformed v1 or v2 blob is an empty outbox and is removed', () => {
    for (const key of [OUTBOX_STORAGE_KEY, 'sorted:chat:outbox:v1']) {
      const storage = memoryStorage();
      storage.setItem(key, '{not json');
      expect(readPersistedOutbox(storage, A)).toEqual({});
      expect(storage.data.has(key)).toBe(false);
      storage.setItem(key, '{not json');
      expect(persistedOutboxIds(storage)).toEqual(new Set());
      storage.setItem(key, '{not json');
      expect(() => writePersistedOutbox(storage, A, { c1: [entry('m1')] })).not.toThrow();
      expect(readPersistedOutbox(storage, A)).toEqual({ c1: [entry('m1')] });
    }
  });

  it('drops malformed entries and survives a corrupt blob', () => {
    const storage = memoryStorage();
    storage.setItem(
      OUTBOX_STORAGE_KEY,
      JSON.stringify({
        userId: 'u1',
        byWorkspace: {
          wa: {
            c1: [
              { id: 5 },
              { id: 'm2', text: 'ok', local: { attachments: [], sharedPostIds: [], reply: null } },
            ],
          },
        },
      }),
    );
    expect(readPersistedOutbox(storage, A)).toEqual({
      c1: [
        {
          id: 'm2',
          text: 'ok',
          local: { attachments: [], sharedPostIds: [], reply: null },
          state: 'sending',
        },
      ],
    });
    storage.setItem(OUTBOX_STORAGE_KEY, '{not json');
    expect(readPersistedOutbox(storage, A)).toEqual({});
  });

  it('a throwing storage never throws out of read, write or clear', () => {
    const boom = (): never => {
      throw new Error('SecurityError');
    };
    const storage: OutboxStorage = { getItem: boom, setItem: boom, removeItem: boom };
    expect(readPersistedOutbox(storage, A)).toEqual({});
    expect(() => writePersistedOutbox(storage, A, { c1: [entry('m1')] })).not.toThrow();
    expect(() => clearPersistedOutbox(storage)).not.toThrow();
    expect(readPersistedOutbox(null, A)).toEqual({});
  });
});

describe('applyPreviews / previewText', () => {
  it('sets the line from the record with a You prefix for own sends and an attachment label', () => {
    const state = applyPreviews(
      seeded(),
      [
        {
          channelId: 'a',
          messageId: 'm1',
          senderUserId: ME,
          body: 'sent by me',
          hasAttachments: false,
          createdAt: '1970-01-01T00:00:00.010Z',
        },
        {
          channelId: 'b',
          messageId: 'm2',
          senderUserId: 'x',
          body: '',
          hasAttachments: true,
          createdAt: '1970-01-01T00:00:00.020Z',
        },
      ],
      ME,
    );
    expect(selectConversation(state, 'a')).toEqual({
      lastMessageText: 'sent by me',
      lastMessagePrefix: 'You',
      lastMessageTs: 10,
      unread: 1,
      lastMessageId: 'm1',
    });
    expect(selectConversation(state, 'b')?.lastMessageText).toBe('Attachment');
    expect(previewText({ body: ' ', hasAttachments: false })).toBe('');
  });
});

describe('applyIncoming', () => {
  it('increments unread and updates the last message + ts on a non-active conversation', () => {
    const next = applyIncoming(seeded(), {
      channelId: 'a',
      senderIsSelf: false,
      text: 'new a',
      ts: 30,
    });

    const convo = selectConversation(next, 'a');
    expect(convo?.unread).toBe(2);
    expect(convo?.lastMessageText).toBe('new a');
    expect(convo?.lastMessageTs).toBe(30);
  });

  it('does not increment the active conversation and keeps it read, but updates the line', () => {
    const active = setActive(markRead(seeded(), 'a'), 'a');
    const next = applyIncoming(active, {
      channelId: 'a',
      senderIsSelf: false,
      text: 'while open',
      ts: 40,
    });

    const convo = selectConversation(next, 'a');
    expect(convo?.unread).toBe(0);
    expect(convo?.lastMessageText).toBe('while open');
  });

  it('ignores a self-sent incoming message (no increment, no change)', () => {
    const state = seeded();
    const next = applyIncoming(state, {
      channelId: 'a',
      senderIsSelf: true,
      text: 'echo',
      ts: 50,
    });

    expect(next).toBe(state);
    expect(selectConversation(next, 'a')?.unread).toBe(1);
  });
});

describe('updateOwnMessage', () => {
  it("sets the last message with the 'You' prefix and does not change unread", () => {
    const next = updateOwnMessage(seeded(), { channelId: 'b', text: 'sent', ts: 60 });

    const convo = selectConversation(next, 'b');
    expect(convo?.lastMessageText).toBe('sent');
    expect(convo?.lastMessagePrefix).toBe('You');
    expect(convo?.unread).toBe(2);
  });
});

describe('selectTotalUnread', () => {
  it('equals the sum of unread across conversations', () => {
    expect(selectTotalUnread(seeded())).toBe(3);
    expect(selectTotalUnread(initialState())).toBe(0);
  });
});

describe('markRead', () => {
  it('zeroes one conversation and lowers the total unread', () => {
    const next = markRead(seeded(), 'b');

    expect(selectConversation(next, 'b')?.unread).toBe(0);
    expect(selectTotalUnread(next)).toBe(1);
  });
});

describe('setActive then applyIncoming', () => {
  it('increments again after the active conversation is cleared', () => {
    const cleared = setActive(seeded(), null);
    const next = applyIncoming(cleared, {
      channelId: 'a',
      senderIsSelf: false,
      text: 'back',
      ts: 70,
    });

    expect(selectConversation(next, 'a')?.unread).toBe(2);
  });
});

describe('pending open', () => {
  it('records and clears a requested open', () => {
    const requested = requestOpen(initialState(), 'a');
    expect(requested.pendingOpenConversationId).toBe('a');
    expect(clearPendingOpen(requested).pendingOpenConversationId).toBeNull();
  });
});

describe('isChannelHidden', () => {
  it('is false for a channel with no clear', () => {
    expect(isChannelHidden({ lastMessageTs: 5 }, undefined)).toBe(false);
    expect(isChannelHidden(undefined, undefined)).toBe(false);
  });

  it('hides a cleared channel while no known message is newer than the clear', () => {
    expect(isChannelHidden({ lastMessageTs: 0 }, 100)).toBe(true);
    expect(isChannelHidden({ lastMessageTs: 100 }, 100)).toBe(true);
    expect(isChannelHidden(undefined, 100)).toBe(true);
  });

  it('unhides once a message newer than the clear is known', () => {
    expect(isChannelHidden({ lastMessageTs: 101 }, 100)).toBe(false);
  });
});

describe('delete chat for me (clears)', () => {
  it('applyClear empties the card, zeroes unread and hides the channel', () => {
    const state = applyClear(seeded(), 'b', 1000);
    expect(selectConversation(state, 'b')).toEqual({
      lastMessageText: '',
      lastMessageTs: 0,
      unread: 0,
    });
    expect(selectHidden(state, 'b')).toBe(true);
    expect(selectHidden(state, 'a')).toBe(false);
    expect(selectTotalUnread(state)).toBe(1);
  });

  it('a live incoming or own message newer than the clear unhides it', () => {
    const cleared = applyClear(seeded(), 'b', 1000);
    const incoming = applyIncoming(cleared, {
      channelId: 'b',
      senderIsSelf: false,
      text: 'back',
      ts: 1001,
    });
    expect(selectHidden(incoming, 'b')).toBe(false);
    const own = updateOwnMessage(cleared, { channelId: 'b', text: 'hi', ts: 2000 });
    expect(selectHidden(own, 'b')).toBe(false);
  });

  it('an unread refresh keeps a cleared channel hidden at 0 until a newer message lands', () => {
    const cleared = applyClear(seeded(), 'b', 1000);
    const stale = applyUnreadCounts(cleared, [
      { channelId: 'b', unread: 4, lastMessageAt: '1970-01-01T00:00:00.500Z' },
    ]);
    expect(selectConversation(stale, 'b')?.unread).toBe(0);
    expect(selectHidden(stale, 'b')).toBe(true);
    const fresh = applyUnreadCounts(cleared, [
      { channelId: 'b', unread: 1, lastMessageAt: '1970-01-01T00:00:02.000Z' },
    ]);
    expect(selectConversation(fresh, 'b')?.unread).toBe(1);
    expect(selectHidden(fresh, 'b')).toBe(false);
  });

  it('applyClears reads the rows (later clear wins) and skips bad times', () => {
    const state = applyClears(initialState(), [
      { channelId: 'a', clearedAt: '1970-01-01T00:00:01.000Z' },
      { channelId: 'a', clearedAt: '1970-01-01T00:00:00.500Z' },
      { channelId: 'x', clearedAt: 'not a time' },
    ]);
    expect(state.clears).toEqual({ a: 1000 });
  });

  it('outboxDropChannel drops only that channel', () => {
    const entry: OutboxEntry = {
      id: 'm',
      text: 't',
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'failed',
    };
    const outbox: Outbox = { a: [entry], b: [entry] };
    expect(outboxDropChannel(outbox, 'a')).toEqual({ b: [entry] });
    expect(outboxDropChannel(outbox, 'z')).toBe(outbox);
  });
});

describe('load lifecycle', () => {
  const scope = loadScope('w1', ME);
  const roster = [
    {
      channelId: 'a',
      channelType: 'group' as const,
      title: 'A',
      avatarUrl: null,
      agoraGroupId: 'ag',
      groupId: 'g',
      peerUserId: null,
      createdAt: 't',
    },
  ];

  it('starts loading and reads loading for any other scope', () => {
    expect(selectLoadStatus(initialState(), scope)).toBe('loading');
    expect(selectLoadStatus(beginLoad(initialState(), scope), scope)).toBe('loading');
    expect(selectLoadStatus(beginLoad(initialState(), scope), null)).toBe('loading');
  });

  it('loadReady applies roster, clears, previews and counts in one transition', () => {
    const ready = loadReady(beginLoad(initialState(), scope), {
      scope,
      roster,
      clears: [{ channelId: 'a', clearedAt: '1970-01-01T00:00:00.050Z' }],
      previews: [],
      counts: [{ channelId: 'a', unread: 4, lastMessageAt: '1970-01-01T00:00:00.040Z' }],
      currentUserId: ME,
    });
    expect(selectLoadStatus(ready, scope)).toBe('ready');
    expect(ready.roster).toBe(roster);
    expect(selectHidden(ready, 'a')).toBe(true);
    expect(selectConversation(ready, 'a')?.unread).toBe(0);
  });

  it('loadFailed drops every row; stale scopes are ignored', () => {
    const other = beginLoad(initialState(), loadScope('w2', ME));
    expect(loadFailed(other, scope)).toBe(other);
    const failed = loadFailed(beginLoad(initialState(), scope), scope);
    expect(failed.status).toBe('error');
    expect(failed.roster).toEqual([]);
  });

  it('beginLoad keeps the viewed channel only for a same-scope retry', () => {
    const viewing = setActive(beginLoad(initialState(), scope), 'a');
    expect(beginLoad(viewing, scope).activeConversationId).toBe('a');
    expect(beginLoad(viewing, loadScope('w2', ME)).activeConversationId).toBeNull();
  });

  it('applyRoster keeps known summaries and keys new channels empty', () => {
    const base = applyUnreadCounts(mergeInitial([{ channelId: 'a' }]), [
      { channelId: 'a', unread: 1, lastMessageAt: '1970-01-01T00:00:00.010Z' },
    ]);
    const next = applyRoster(base, [...roster, { ...roster[0]!, channelId: 'b' }]);
    expect(selectConversation(next, 'a')?.unread).toBe(1);
    expect(selectConversation(next, 'b')).toEqual({
      lastMessageText: '',
      lastMessageTs: 0,
      unread: 0,
    });
    expect(next.roster.map((c) => c.channelId)).toEqual(['a', 'b']);
  });
});

describe('D1: a delete signal re-reads only the lines that showed the message', () => {
  const previews = (
    rows: { channelId: string; messageId: string; body: string; sender?: string }[],
  ): Parameters<typeof applyPreviews>[1] =>
    rows.map((r, i) => ({
      channelId: r.channelId,
      messageId: r.messageId,
      senderUserId: r.sender ?? 'x',
      body: r.body,
      hasAttachments: false,
      createdAt: `1970-01-01T00:00:00.0${10 + i}Z`,
    }));

  it('finds the channels whose line shows a deleted id (any channel, open or not)', () => {
    const state = setActive(
      applyPreviews(
        seeded(),
        previews([
          { channelId: 'a', messageId: 'ma', body: 'open chat line' },
          { channelId: 'b', messageId: 'mb', body: 'secret text' },
        ]),
        ME,
      ),
      'a',
    );
    expect(channelsShowingDeleted(state, ['mb'])).toEqual(['b']);
    expect(channelsShowingDeleted(state, ['older'])).toEqual([]);
    expect(channelsShowingDeleted(state, [])).toEqual([]);
  });

  it('applies the re-read to just those channels; an emptied channel loses its line', () => {
    const state = applyPreviews(
      seeded(),
      previews([
        { channelId: 'a', messageId: 'ma', body: 'keep me' },
        { channelId: 'b', messageId: 'mb', body: 'secret text' },
      ]),
      ME,
    );
    // The re-read: b's newest live message is now an older one of mine.
    const reread = previews([
      { channelId: 'a', messageId: 'ma2', body: 'changed elsewhere' },
      { channelId: 'b', messageId: 'mb0', body: 'earlier line', sender: ME },
    ]);
    const next = applyChannelPreviews(state, ['b'], reread, ME);
    expect(selectConversation(next, 'b')).toMatchObject({
      lastMessageText: 'earlier line',
      lastMessagePrefix: 'You',
      lastMessageId: 'mb0',
      unread: 2,
    });
    expect(selectConversation(next, 'a')?.lastMessageText).toBe('keep me');
    const emptied = applyChannelPreviews(state, ['b'], [], ME);
    expect(selectConversation(emptied, 'b')?.lastMessageText).toBe('');
    expect(selectConversation(emptied, 'b')?.lastMessageId).toBeUndefined();
    expect(JSON.stringify(emptied)).not.toContain('secret text');
  });

  it('incoming and own lines carry their message id', () => {
    const incoming = applyIncoming(seeded(), {
      channelId: 'b',
      messageId: 'live-1',
      senderIsSelf: false,
      text: 'x',
      ts: 50,
    });
    expect(channelsShowingDeleted(incoming, ['live-1'])).toEqual(['b']);
    const own = updateOwnMessage(seeded(), {
      channelId: 'a',
      messageId: 'own-1',
      text: 'y',
      ts: 60,
    });
    expect(channelsShowingDeleted(own, ['own-1'])).toEqual(['a']);
  });
});

describe('D1: queued sends quoting a deleted message', () => {
  const quoting = (id: string, quoteId: string): OutboxEntry => ({
    id,
    text: 'reply',
    local: {
      attachments: [],
      sharedPostIds: [],
      reply: { id: quoteId, authorUserId: 'peer', preview: 'the deleted words' },
    },
    state: 'sending',
  });

  it('stripDeletedQuotes clears reply.preview and keeps the reply id', () => {
    const outbox: Outbox = { a: [quoting('s1', 'gone'), quoting('s2', 'kept')] };
    const next = stripDeletedQuotes(outbox, new Set(['gone']));
    expect(next.a?.[0]?.local.reply).toEqual({ id: 'gone', authorUserId: 'peer', preview: '' });
    expect(next.a?.[1]?.local.reply?.preview).toBe('the deleted words');
    expect(stripDeletedQuotes(outbox, new Set(['other']))).toBe(outbox);
  });

  it('stripPersistedQuotes clears the stored preview in place; reply_to stays', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    const scope = { workspaceId: 'w', userId: 'u' };
    writePersistedOutbox(storage, scope, { a: [quoting('s1', 'gone'), quoting('s2', 'kept')] });
    stripPersistedQuotes(storage, ['gone']);
    const raw = data.get(OUTBOX_STORAGE_KEY) ?? '';
    expect(raw).toContain('the deleted words'); // s2 still quotes a live message
    const restored = readPersistedOutbox(storage, scope);
    expect(restored.a?.[0]?.local.reply).toEqual({ id: 'gone', authorUserId: 'peer', preview: '' });
    expect(restored.a?.[1]?.local.reply?.preview).toBe('the deleted words');
    // Never throws on blocked storage.
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(() => stripPersistedQuotes(blocked, ['gone'])).not.toThrow();
  });
});

describe('D3: server clock offset', () => {
  it('starts at 0 and is set from an own send ack (server created_at minus the device send time)', () => {
    expect(initialState().serverClockOffsetMs).toBe(0);
    const sentAt = Date.parse('2026-09-22T10:00:00.000Z');
    const next = applyServerClock(initialState(), '2026-09-22T10:02:00.000Z', sentAt);
    expect(next.serverClockOffsetMs).toBe(120_000);
    // A bad time keeps it.
    expect(applyServerClock(next, 'not a time', sentAt)).toBe(next);
  });

  it('a fresh first attempt samples the clock; a retry and an outbox replay never do', () => {
    let device = Date.parse('2026-09-22T10:00:00.000Z');
    const sampler = createClockSampler(() => device);
    let state = initialState();
    // Replayed from storage: never marked fresh, so its ack is never applied.
    expect(sampler.begin('queued')).toBeNull();
    expect(state.serverClockOffsetMs).toBe(0);
    // Fresh: applied.
    sampler.fresh('fresh');
    const fresh = sampler.begin('fresh');
    expect(fresh).toBe(device);
    sampler.settled('fresh');
    state = applyServerClock(state, '2026-09-22T10:00:03.000Z', fresh as number);
    expect(state.serverClockOffsetMs).toBe(3000);
    // A retry of the fresh id hours later: the old created_at must not move it.
    device += 3 * 60 * 60 * 1000;
    expect(sampler.begin('fresh')).toBeNull();
  });

  it('R11: an id leaves the set on its first ack and on its first failure; the set is bounded', () => {
    const sampler = createClockSampler(() => 1);
    sampler.fresh('acked');
    sampler.fresh('failed');
    expect(sampler.size()).toBe(2);
    expect(sampler.begin('acked')).toBe(1);
    sampler.settled('acked');
    expect(sampler.size()).toBe(1);
    expect(sampler.begin('failed')).toBe(1);
    sampler.settled('failed');
    expect(sampler.size()).toBe(0);
    // The retry after the failure does not sample.
    expect(sampler.begin('failed')).toBeNull();
    for (let i = 0; i < CLOCK_SAMPLER_LIMIT + 50; i += 1) sampler.fresh(`never-attempted-${i}`);
    expect(sampler.size()).toBe(CLOCK_SAMPLER_LIMIT);
  });

  it('survives a reload of the list', () => {
    const withOffset = applyServerClock(initialState(), '1970-01-01T00:00:05.000Z', 0);
    expect(beginLoad(withOffset, 's').serverClockOffsetMs).toBe(5000);
  });
});

describe('T3: voice note peaks survive an outbox reload', () => {
  const scope = { workspaceId: 'wa', userId: 'u1' };
  function storage(): OutboxStorage {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }
  const voice = (peaks: unknown) =>
    ({
      id: 'v1',
      text: '',
      local: {
        attachments: [
          {
            assetId: 'ver-1',
            name: 'voice-note.webm',
            mime: 'audio/webm',
            durationMs: 3000,
            peaks,
          },
        ],
        sharedPostIds: [],
        reply: null,
      },
      state: 'sending',
    }) as unknown as OutboxEntry;

  it('keeps valid peaks through write and read', () => {
    const store = storage();
    const peaks = Array.from({ length: 48 }, (_, i) => i);
    writePersistedOutbox(store, scope, { c1: [voice(peaks)] });
    const read = readPersistedOutbox(store, scope).c1?.[0]?.local.attachments[0];
    expect(read?.peaks).toEqual(peaks);
    expect(read?.durationMs).toBe(3000);
  });

  it.each([
    ['not an array', 'loud'],
    ['too many', new Array<number>(49).fill(1)],
    ['a non-number', [1, 'x']],
    ['empty', []],
  ])('invalid peaks (%s) read as absent, the note itself survives', (_label, peaks) => {
    const store = storage();
    writePersistedOutbox(store, scope, { c1: [voice(peaks)] });
    const read = readPersistedOutbox(store, scope).c1?.[0]?.local.attachments[0];
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('peaks');
  });
});

describe('shared plan previews', () => {
  it('a plan-only message reads "Plan", after Post and Brief in the order', () => {
    expect(PREVIEW_LABELS.plan).toBe('Plan');
    expect(previewText({ body: '', hasAttachments: true, sharedPlanCount: 1 })).toBe('Plan');
    expect(
      previewText({ body: '', hasAttachments: true, sharedBriefCount: 1, sharedPlanCount: 1 }),
    ).toBe('Brief');
    expect(
      previewText({ body: '', hasAttachments: true, sharedPostCount: 1, sharedPlanCount: 1 }),
    ).toBe('Post');
    expect(previewText({ body: 'hi', hasAttachments: true, sharedPlanCount: 1 })).toBe('hi');
  });

  it('messagePreviewContent counts plan ids', () => {
    const content = messagePreviewContent({
      body: '',
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      sharedPlanIds: ['plan1'],
    });
    expect(content.sharedPlanCount).toBe(1);
    expect(content.hasAttachments).toBe(true);
    expect(previewText(content)).toBe('Plan');
  });
});
