import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Result } from '@srtdio/rpc';
import type { ConversationPreview } from '@/lib/chat/history';

// The provider's import graph pulls the real agora-chat browser SDK. Mock it so
// importing it in node never touches browser globals, mirroring ChatShell.test.tsx.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  handleMessagesDeleted,
  listenForChatSignout,
  loadChatList,
  previewMentionText,
  pruneDraftsFromRoster,
  releaseCancelled,
  ROSTER_ROW_CAP,
  resolvePreviewMentions,
  routeGlobalCmd,
  type ChatListReaders,
} from '@/components/chat/ChatStoreProvider';
import { deleteEventExt, readEventExt, type ChatMessageRow } from '@/lib/chat/thread';
import { ChannelCard, channelListContent, draftLine } from '@/components/chat/ChannelList';
import { rememberMentionNames, resetMentionNames } from '@/lib/chat/mentions';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  applyChannelPreviews,
  applyPreviews,
  channelsShowingDeleted,
  setActive,
  beginLoad,
  initialState,
  loadScope,
  selectConversation,
  selectHidden,
  selectLoadStatus,
  type ChatStoreState,
} from '@/lib/chat/chat-store';

const ME = 'me';

function cmdRow(id: string, deleted: boolean): ChatMessageRow {
  return {
    id,
    channel_id: 'other',
    workspace_id: 'w1',
    sender_user_id: 'p',
    body: deleted ? null : 'words',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-22T10:00:00.000000+00:00',
    edited_at: null,
    deleted_at: deleted ? '2026-09-22T10:01:00.000000+00:00' : null,
  };
}

const SCOPE = loadScope('w1', ME);

function channel(channelId: string, createdAt: string): ChannelSummary {
  return {
    channelId,
    channelType: 'group',
    title: channelId,
    avatarUrl: null,
    agoraGroupId: `ag-${channelId}`,
    groupId: `g-${channelId}`,
    peerUserId: null,
    createdAt,
  };
}

function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data });
}

function failed<T>(): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } });
}

// 'old' was created first but has the newest message; 'cleared' was deleted
// for the caller after its last message.
function readers(over: Partial<ChatListReaders> = {}): ChatListReaders {
  return {
    roster: () =>
      ok([
        channel('new', '2026-01-03T00:00:00Z'),
        channel('cleared', '2026-01-02T00:00:00Z'),
        channel('old', '2026-01-01T00:00:00Z'),
      ]),
    clears: () => ok([{ channelId: 'cleared', clearedAt: '2026-02-01T00:00:00Z' }]),
    previews: () =>
      ok([
        {
          channelId: 'old',
          messageId: 'm1',
          senderUserId: 'x',
          body: 'latest',
          hasAttachments: false,
          createdAt: '2026-03-01T00:00:00Z',
        },
        {
          channelId: 'new',
          messageId: 'm2',
          senderUserId: ME,
          body: 'earlier',
          hasAttachments: false,
          createdAt: '2026-02-15T00:00:00Z',
        },
        {
          channelId: 'cleared',
          messageId: 'm3',
          senderUserId: 'x',
          body: 'gone',
          hasAttachments: false,
          createdAt: '2026-01-20T00:00:00Z',
        },
      ]),
    counts: () =>
      ok([
        { channelId: 'old', unread: 2, lastMessageAt: '2026-03-01T00:00:00Z' },
        { channelId: 'cleared', unread: 1, lastMessageAt: '2026-01-20T00:00:00Z' },
      ]),
    ...over,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

/** Render the list body exactly as ChannelList wires it from the store. */
function paint(state: ChatStoreState, scope: string, onRetry: () => void = () => {}): ReactElement {
  const status = selectLoadStatus(state, scope);
  return channelListContent({
    channels: status === 'ready' ? state.roster : [],
    status,
    onRetry,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: () => {},
    search: '',
    onSearchChange: () => {},
    summaryFor: (id) => selectConversation(state, id),
    isHidden: (id) => selectHidden(state, id),
  });
}

function rowIds(tree: ReactElement): string[] {
  return findAll(tree, (el) => el.type === ChannelCard).map(
    (el) => (el.props as { channel: ChannelSummary }).channel.channelId,
  );
}

function skeletonRows(tree: ReactElement): ReactElement[] {
  return findAll(
    tree,
    (el) => (el.props as Record<string, unknown>)['data-skeleton-row'] !== undefined,
  );
}

describe('loadChatList', () => {
  it('starts all four reads before any resolves (parallel, no extra round trip)', async () => {
    const started: string[] = [];
    const base = readers();
    const tracked: ChatListReaders = {
      roster: (signal) => (started.push('roster'), base.roster(signal)),
      clears: (signal) => (started.push('clears'), base.clears(signal)),
      previews: (signal) => (started.push('previews'), base.previews(signal)),
      counts: (signal) => (started.push('counts'), base.counts(signal)),
    };
    const pending = loadChatList(tracked, SCOPE, ME);
    // Each read starts inside its 5s timeout wrapper, all in the same tick.
    await Promise.resolve();
    expect(started.sort()).toEqual(['clears', 'counts', 'previews', 'roster']);
    await pending;
  });

  it('never exposes a ready roster before clears are applied', async () => {
    const loading = beginLoad(initialState(), SCOPE);
    expect(selectLoadStatus(loading, SCOPE)).toBe('loading');
    expect(loading.roster).toEqual([]);

    const ready = (await loadChatList(readers(), SCOPE, ME))(loading);
    expect(ready.status).toBe('ready');
    expect(ready.clears['cleared']).toBe(Date.parse('2026-02-01T00:00:00Z'));
    expect(selectHidden(ready, 'cleared')).toBe(true);
    expect(selectConversation(ready, 'cleared')?.unread).toBe(0);
  });

  it('a cleared channel never appears in the first rendered list', async () => {
    const loading = beginLoad(initialState(), SCOPE);
    expect(rowIds(paint(loading, SCOPE))).toEqual([]);
    const ready = (await loadChatList(readers(), SCOPE, ME))(loading);
    expect(rowIds(paint(ready, SCOPE))).not.toContain('cleared');
  });

  it('the first ready list is already recency-sorted', async () => {
    const ready = (await loadChatList(readers(), SCOPE, ME))(beginLoad(initialState(), SCOPE));
    // createdAt order would be new, old; recency puts old (newest message) first.
    expect(rowIds(paint(ready, SCOPE))).toEqual(['old', 'new']);
  });

  it.each(['roster', 'clears', 'previews', 'counts'] as const)(
    'a failed %s read renders the error state with Retry, never a partial list',
    async (which) => {
      const failing: Partial<ChatListReaders> = { [which]: () => failed() };
      const state = (await loadChatList(readers(failing), SCOPE, ME))(
        beginLoad(initialState(), SCOPE),
      );
      expect(state.status).toBe('error');
      const onRetry = vi.fn();
      const tree = paint(state, SCOPE, onRetry);
      expect(rowIds(tree)).toEqual([]);
      const empties = findAll(tree, (el) => el.type === EmptyState);
      expect(empties).toHaveLength(1);
      expect((empties[0]!.props as { title: string }).title).toBe("Couldn't load chats");
      const retry = findAll(
        (empties[0]!.props as { action: ReactNode }).action,
        (el) => (el.props as { children?: unknown }).children === 'Retry',
      );
      expect(retry).toHaveLength(1);
      (retry[0]!.props as { onClick: () => void }).onClick();
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  it('Retry reloads: error, then skeleton, then the ready list', async () => {
    const errored = (await loadChatList(readers({ clears: () => failed() }), SCOPE, ME))(
      beginLoad(initialState(), SCOPE),
    );
    const retrying = beginLoad(errored, SCOPE);
    expect(skeletonRows(paint(retrying, SCOPE)).length).toBeGreaterThan(0);
    const ready = (await loadChatList(readers(), SCOPE, ME))(retrying);
    expect(rowIds(paint(ready, SCOPE))).toEqual(['old', 'new']);
  });

  it('a workspace switch shows skeleton, never the prior workspace rows', async () => {
    const ready = (await loadChatList(readers(), SCOPE, ME))(beginLoad(initialState(), SCOPE));
    const next = loadScope('w2', ME);
    // Before the switch effect runs, the prior state is read under the new scope.
    const firstPaint = paint(ready, next);
    expect(rowIds(firstPaint)).toEqual([]);
    expect(skeletonRows(firstPaint).length).toBeGreaterThan(0);
    const switching = beginLoad(ready, next);
    expect(switching.roster).toEqual([]);
    expect(rowIds(paint(switching, next))).toEqual([]);
  });

  it('a stale response for a previous workspace is ignored', async () => {
    const transition = await loadChatList(readers(), SCOPE, ME);
    const moved = beginLoad(initialState(), loadScope('w2', ME));
    expect(transition(moved)).toBe(moved);
  });
});

describe('D1: the store handles a delete signal for any channel', () => {
  it('a non-open chat whose line showed the message re-reads it in one batched read', async () => {
    let state: ChatStoreState = setActive(
      applyPreviews(
        {
          ...initialState(),
          conversations: {
            open: { lastMessageText: '', lastMessageTs: 0, unread: 0 },
            other: { lastMessageText: '', lastMessageTs: 0, unread: 3 },
          },
        },
        [
          {
            channelId: 'open',
            messageId: 'o1',
            senderUserId: 'p',
            body: 'open line',
            hasAttachments: false,
            createdAt: '1970-01-01T00:00:00.010Z',
          },
          {
            channelId: 'other',
            messageId: 'x9',
            senderUserId: 'p',
            body: 'deleted words',
            hasAttachments: false,
            createdAt: '1970-01-01T00:00:00.020Z',
          },
        ],
        ME,
      ),
      'open',
    );
    const reads = vi.fn(() =>
      Promise.resolve([
        {
          channelId: 'open',
          messageId: 'o1',
          senderUserId: 'p',
          body: 'open line',
          hasAttachments: false,
          createdAt: '1970-01-01T00:00:00.010Z',
        },
        {
          channelId: 'other',
          messageId: 'x8',
          senderUserId: 'p',
          body: 'the line before',
          hasAttachments: false,
          createdAt: '1970-01-01T00:00:00.015Z',
        },
      ]),
    );
    const stripDrafts = vi.fn();
    const stripOutbox = vi.fn();
    const pending: Promise<void>[] = [];
    handleMessagesDeleted(
      {
        channelsShowing: (ids) => channelsShowingDeleted(state, ids),
        rereadPreviews: (channelIds) => {
          pending.push(
            reads().then((rows) => {
              state = applyChannelPreviews(state, channelIds, rows, ME);
            }),
          );
        },
        stripDrafts,
        stripOutbox,
      },
      ['x9', 'x10'],
    );
    await Promise.all(pending);
    expect(reads).toHaveBeenCalledOnce();
    expect(selectConversation(state, 'other')?.lastMessageText).toBe('the line before');
    expect(selectConversation(state, 'other')?.unread).toBe(3);
    expect(selectConversation(state, 'open')?.lastMessageText).toBe('open line');
    expect(stripDrafts).toHaveBeenCalledWith(['x9', 'x10']);
    expect(stripOutbox).toHaveBeenCalledWith(['x9', 'x10']);
  });

  it('a live delete cmd for a non-open chat strips its preview, draft and outbox', async () => {
    const state: ChatStoreState = setActive(
      applyPreviews(
        {
          ...initialState(),
          conversations: {
            open: { lastMessageText: '', lastMessageTs: 0, unread: 0 },
            other: { lastMessageText: '', lastMessageTs: 0, unread: 0 },
          },
        },
        [
          {
            channelId: 'other',
            messageId: 'x9',
            senderUserId: 'p',
            body: 'deleted words',
            hasAttachments: false,
            createdAt: '1970-01-01T00:00:00.020Z',
          },
        ],
        ME,
      ),
      'open',
    );
    const rereadPreviews = vi.fn();
    const stripDrafts = vi.fn();
    const stripOutbox = vi.fn();
    const deps = {
      channelsShowing: (ids: readonly string[]) => channelsShowingDeleted(state, ids),
      rereadPreviews,
      stripDrafts,
      stripOutbox,
    };
    const loadByIds = vi.fn((ids: readonly string[]) =>
      Promise.resolve<Result<ChatMessageRow[]>>({
        ok: true,
        data: ids.map((id) => cmdRow(id, true)),
      }),
    );
    const onDeleted = (ids: readonly string[]): void => handleMessagesDeleted(deps, ids);
    await routeGlobalCmd(deleteEventExt({ messageIds: ['x9'] }), { loadByIds, onDeleted });
    await routeGlobalCmd(readEventExt({ channelId: 'other', messageId: 'x9' }), {
      loadByIds,
      onDeleted,
    });
    expect(loadByIds).toHaveBeenCalledOnce();
    expect(rereadPreviews).toHaveBeenCalledExactlyOnceWith(['other']);
    expect(stripDrafts).toHaveBeenCalledExactlyOnceWith(['x9']);
    expect(stripOutbox).toHaveBeenCalledExactlyOnceWith(['x9']);
  });

  it('R1: a delete cmd is re-read in one batched read; only ids deleted on record strip', async () => {
    const loadByIds = vi.fn((ids: readonly string[]) =>
      Promise.resolve<Result<ChatMessageRow[]>>({
        ok: true,
        // 'live' is not deleted, 'gone' is, 'unknown' is not found at all.
        data: [cmdRow('live', false), cmdRow('gone', true)].filter((r) => ids.includes(r.id)),
      }),
    );
    const onDeleted = vi.fn();
    await routeGlobalCmd(deleteEventExt({ messageIds: ['live', 'gone', 'unknown', 'gone'] }), {
      loadByIds,
      onDeleted,
    });
    expect(loadByIds).toHaveBeenCalledOnce();
    expect(loadByIds.mock.calls[0]?.[0]).toEqual(['live', 'gone', 'unknown']);
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith(['gone']);
  });

  it('R1: a cmd naming only a non-deleted id does nothing', async () => {
    const onDeleted = vi.fn();
    await routeGlobalCmd(deleteEventExt({ messageIds: ['live'] }), {
      loadByIds: () => Promise.resolve({ ok: true, data: [cmdRow('live', false)] }),
      onDeleted,
    });
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('R1: a failed re-read does nothing', async () => {
    const onDeleted = vi.fn();
    await routeGlobalCmd(deleteEventExt({ messageIds: ['gone'] }), {
      loadByIds: () =>
        Promise.resolve({ ok: false, error: { code: 'unknown', message: 'nope' } } as Result<
          ChatMessageRow[]
        >),
      onDeleted,
    });
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('no line shows a deleted id: no read at all', () => {
    const rereadPreviews = vi.fn();
    handleMessagesDeleted(
      { channelsShowing: () => [], rereadPreviews, stripDrafts: vi.fn(), stripOutbox: vi.fn() },
      ['older'],
    );
    expect(rereadPreviews).not.toHaveBeenCalled();
  });
});

describe('chat list mentions', () => {
  const ANA = '11111111-1111-4111-8111-111111111111';
  const GONE = '99999999-9999-4999-8999-999999999999';
  const preview = (body: string): ConversationPreview => ({
    channelId: 'c1',
    messageId: 'm1',
    senderUserId: 'x',
    body,
    hasAttachments: false,
    createdAt: '2026-09-22T10:00:00Z',
  });

  it('previews resolve tokens to "@Name" after one batched name read', async () => {
    resetMentionNames();
    const readNames = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: ids
        .filter((id) => id === ANA)
        .map((id) => ({ userId: id, displayName: 'Ana', avatarUrl: null, member: true })),
    }));
    const result = await resolvePreviewMentions(
      { ok: true, data: [preview(`hi @[${ANA}]`), preview(`and @[${GONE}] @[${ANA}]`)] },
      readNames,
      'w1',
      'x',
    );
    expect(readNames).toHaveBeenCalledTimes(1);
    expect(readNames).toHaveBeenCalledWith([ANA, GONE], expect.any(AbortSignal));
    expect(result.ok && result.data.map((p) => p.body)).toEqual([
      'hi @Ana',
      'and @Unknown member @Ana',
    ]);
    // Known names need no second read.
    await resolvePreviewMentions({ ok: true, data: [preview(`@[${ANA}]`)] }, readNames, 'w1', 'x');
    expect(readNames).toHaveBeenCalledTimes(1);
  });

  it('own sends, forwards and the Draft line read "@Name"', () => {
    resetMentionNames();
    rememberMentionNames('w1', [{ userId: ANA, displayName: 'Ana' }]);
    expect(previewMentionText(`ok @[${ANA}]`, 'w1')).toBe('ok @Ana');
    expect(draftLine(`draft @[${ANA}] @[${GONE}]`, 'w1')).toBe('draft @Ana @Unknown member');
    resetMentionNames();
  });
});

describe('T7: a cancelled send releases its stored files and object URLs', () => {
  function adapter(keys: string[]) {
    const deleted: string[][] = [];
    return {
      deleted,
      files: {
        put: vi.fn(async () => {}),
        get: vi.fn(async () => undefined),
        keys: vi.fn(async () => [...keys]),
        delete: vi.fn(async (drop: readonly string[]) => {
          deleted.push([...drop]);
        }),
        clear: vi.fn(async () => {}),
        close: vi.fn(),
      },
    };
  }
  const file = new File(['abc'], 'a.png', { type: 'image/png' });
  const entry = {
    id: 'm1',
    local: {
      attachments: [
        {
          assetId: '',
          name: 'a.png',
          mime: 'image/png',
          local: { key: 'k1', file, previewUrl: 'blob:preview-1', progress: 0.3 },
        },
      ],
      sharedPostIds: [],
      reply: null,
    },
  };

  it('deletes its IndexedDB files and revokes its previews', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { files, deleted } = adapter(['m1:0', 'm1:1', 'm2:0']);
    await releaseCancelled(files, entry);
    expect(deleted).toEqual([['m1:0', 'm1:1']]);
    expect(revoke).toHaveBeenCalledWith('blob:preview-1');
    revoke.mockRestore();
  });

  it('waits for a save still in flight, so no blob is left behind', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { files, deleted } = adapter(['m1:0']);
    let landed: (() => void) | undefined;
    const saving = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const done = releaseCancelled(files, entry, saving);
    await Promise.resolve();
    expect(deleted).toEqual([]);
    landed?.();
    await done;
    expect(deleted).toEqual([['m1:0']]);
    revoke.mockRestore();
  });

  it('no file store: nothing throws', async () => {
    await expect(releaseCancelled(null, entry)).resolves.toBeUndefined();
  });
});

describe('drafts and on-device chat data', () => {
  it('a sign-out event clears drafts, emoji recents and voice transcripts', async () => {
    const drafts = await import('@/lib/chat/drafts');
    const { EMOJI_RECENTS_KEY } = await import('@/lib/chat/emoji-list');
    const { voiceStore } = await import('@/lib/chat/transcript-store');
    const { SIGNOUT_EVENT } = await import('@/lib/events');
    const data = new Map<string, string>([[EMOJI_RECENTS_KEY, '["😀"]']]);
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const win = Object.assign(new EventTarget(), { localStorage });
    vi.stubGlobal('window', win);
    try {
      drafts.setDraftScope({ userId: ME, workspaceId: 'ws-1' });
      drafts.setDraft('chan-a', { text: 'left behind' });
      drafts.setDraftScope(null);
      expect(data.has(drafts.DRAFTS_STORAGE_KEY)).toBe(true);
      voiceStore.update('m1', { transcript: 'private' });
      const off = listenForChatSignout(win);
      win.dispatchEvent(new Event(SIGNOUT_EVENT));
      off();
      expect(drafts.getDraft('chan-a')).toBe(drafts.EMPTY_DRAFT);
      expect(data.has(drafts.DRAFTS_STORAGE_KEY)).toBe(false);
      expect(data.has(EMOJI_RECENTS_KEY)).toBe(false);
      expect(voiceStore.get('m1')).toBeUndefined();
    } finally {
      drafts.resetDrafts();
      vi.unstubAllGlobals();
    }
  });

  it('a successful complete roster read prunes with its channel ids', () => {
    const prune = vi.fn();
    const roster = [{ channelId: 'a' }, { channelId: 'b' }];
    expect(pruneDraftsFromRoster('ws-1', { ok: true, data: roster }, prune)).toBe(true);
    expect(prune).toHaveBeenCalledWith('ws-1', new Set(['a', 'b']));
  });

  it('a failed roster read does not prune', () => {
    const prune = vi.fn();
    const failed = { ok: false, error: { message: 'timeout' } } as Result<{ channelId: string }[]>;
    expect(pruneDraftsFromRoster('ws-1', failed, prune)).toBe(false);
    expect(prune).not.toHaveBeenCalled();
  });

  it('a roster read that may have hit the row cap does not prune', () => {
    const prune = vi.fn();
    const roster = Array.from({ length: ROSTER_ROW_CAP - 1 }, (_, i) => ({ channelId: `c${i}` }));
    expect(pruneDraftsFromRoster('ws-1', { ok: true, data: roster }, prune)).toBe(false);
    expect(prune).not.toHaveBeenCalled();
  });
});
