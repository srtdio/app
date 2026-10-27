// @vitest-environment jsdom
// Device cache, part B: pre-warm. Once the list is ready and the tab is
// visible, at idle, the top chats with no remembered page run the open's
// bundle read and are kept as the page an open leaves behind: at most 5,
// never under Save-Data, never noting an open (no opened(), no hold), never
// over a chat a tap or a thread already has. A pre-warmed chat's first tap
// paints its rows with no skeleton.
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Result } from '@srtdio/rpc';
import { createOpenCache, type ChatKey } from '@/lib/chat/open-cache';
import {
  PREWARM_LIMIT,
  openingState,
  prewarmChats,
  rememberedFromBundle,
} from '@/lib/chat/use-chat-thread';
import { rowCursor, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChatOpenBundle } from '@/lib/chat/history';
import { schedulePrewarm } from '@/components/chat/ChatConnected';

const ME = '11111111-1111-4111-8111-111111111111';

function keyOf(i: number): ChatKey {
  return { userId: ME, workspaceId: 'w1', channelId: `c${i}` };
}

function row(key: ChatKey, i: number): ChatMessageRow {
  return {
    id: `m-${key.channelId}-${i}`,
    channel_id: key.channelId,
    workspace_id: key.workspaceId,
    sender_user_id: ME,
    body: `message ${i}`,
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
    created_at: `2026-10-20T10:00:${String(i).padStart(2, '0')}.000000+00:00`,
    edited_at: null,
    deleted_at: null,
    removed_files: {},
  } as ChatMessageRow;
}

function bundle(key: ChatKey, count: number): ChatOpenBundle {
  return {
    serverNow: '2026-10-25T12:00:00.000Z',
    page: { rows: Array.from({ length: count }, (_, i) => row(key, i)), hasMore: false },
    quoted: [],
    reactions: [],
    readPositions: { rows: [], times: new Map() },
    replyCounts: new Map(),
    marks: [],
    scheduled: [],
    openPosts: [],
    openPostCount: 0,
    sharedPlanIds: [],
    openBriefs: [],
    openBriefCount: 0,
  } as unknown as ChatOpenBundle;
}

function okRead(count = 3) {
  return vi.fn(
    (key: ChatKey): Promise<Result<ChatOpenBundle>> =>
      Promise.resolve({ ok: true, data: bundle(key, count) }),
  );
}

describe('prewarmChats', () => {
  it('reads at most 5 chats, keeps their pages, and never notes an open', async () => {
    const store = createOpenCache();
    const opened = vi.spyOn(store, 'opened');
    const read = okRead();
    const keys = Array.from({ length: 8 }, (_, i) => keyOf(i));
    const kept = await prewarmChats(keys, {
      store,
      read,
      saveData: () => false,
      current: () => true,
    });
    expect(PREWARM_LIMIT).toBe(5);
    expect(kept).toBe(5);
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls.map(([k]) => k.channelId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(opened).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i += 1) expect(store.openedAt(keyOf(i))).toBeNull();
    expect(store.recall(keyOf(5), 'thread')).toBeUndefined();
    // Kept as an open leaves it: released, not shown by any thread.
    expect(store.attached(keyOf(0))).toBe(false);
  });

  it('skips Save-Data', async () => {
    const store = createOpenCache();
    const read = okRead();
    const kept = await prewarmChats([keyOf(0)], {
      store,
      read,
      saveData: () => true,
      current: () => true,
    });
    expect(kept).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips a chat already remembered, opened by a tap, or shown by a thread', async () => {
    const store = createOpenCache();
    const kept = rememberedFromBundle(bundle(keyOf(0), 1), ME);
    if (kept === null) throw new Error('page');
    const remembered = store.attach(keyOf(0));
    remembered.keep(kept);
    remembered.release();
    store.stash(keyOf(1), 'bundle', new Promise<never>(() => {}));
    store.attach(keyOf(2));
    const read = okRead();
    await prewarmChats([keyOf(0), keyOf(1), keyOf(2), keyOf(3)], {
      store,
      read,
      saveData: () => false,
      current: () => true,
    });
    expect(read.mock.calls.map(([k]) => k.channelId)).toEqual(['c3']);
  });

  it('drops what lands after a switch, and never keeps an empty page', async () => {
    const store = createOpenCache();
    let live = true;
    const pending = prewarmChats([keyOf(0)], {
      store,
      read: (key) => {
        live = false;
        return Promise.resolve({ ok: true, data: bundle(key, 3) });
      },
      saveData: () => false,
      current: () => live,
    });
    expect(await pending).toBe(0);
    expect(store.size()).toBe(0);
    const empty = await prewarmChats([keyOf(1)], {
      store,
      read: okRead(0),
      saveData: () => false,
      current: () => true,
    });
    expect(empty).toBe(0);
    expect(store.recall(keyOf(1), 'thread')).toBeUndefined();
  });

  it("a pre-warmed chat's first tap paints its rows with no skeleton and revalidates from its end", async () => {
    const store = createOpenCache();
    await prewarmChats([keyOf(0)], {
      store,
      read: okRead(4),
      saveData: () => false,
      current: () => true,
    });
    const page = store.recall(keyOf(0), 'thread');
    expect(page?.through).toEqual(rowCursor(row(keyOf(0), 3)));
    const opening = openingState({
      channelId: 'c0',
      page,
      outbox: [],
      currentUserId: ME,
    });
    expect(opening.loading).toBe(false);
    expect(opening.messages.map((m) => m.id)).toEqual([0, 1, 2, 3].map((i) => `m-c0-${i}`));
    expect(opening.reads.status).toBe('ready');
  });
});

describe('schedulePrewarm', () => {
  function harness(visible: boolean) {
    const state = { visible, listener: null as (() => void) | null };
    const idle = vi.fn((task: () => void) => {
      task();
      return () => {};
    });
    const run = vi.fn();
    return { state, idle, run };
  }

  it('does nothing until the list is ready', () => {
    const { state, idle, run } = harness(true);
    schedulePrewarm({
      ready: false,
      visible: () => state.visible,
      onVisibilityChange: () => () => {},
      idle,
      run,
    });
    expect(idle).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('runs at idle once ready and visible, never on the paint itself', () => {
    const tasks: Array<() => void> = [];
    const run = vi.fn();
    schedulePrewarm({
      ready: true,
      visible: () => true,
      onVisibilityChange: () => () => {},
      idle: (task) => {
        tasks.push(task);
        return () => {};
      },
      run,
    });
    expect(run).not.toHaveBeenCalled();
    tasks.forEach((t) => t());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab waits for visible; a cancel before idle runs nothing', () => {
    const { state, idle, run } = harness(false);
    const cancel = schedulePrewarm({
      ready: true,
      visible: () => state.visible,
      onVisibilityChange: (listener) => {
        state.listener = listener;
        return () => {
          state.listener = null;
        };
      },
      idle,
      run,
    });
    expect(run).not.toHaveBeenCalled();
    state.visible = true;
    state.listener?.();
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.listener).toBeNull();
    cancel();

    const later = vi.fn();
    const stop = schedulePrewarm({
      ready: true,
      visible: () => true,
      onVisibilityChange: () => () => {},
      idle: () => () => later(),
      run,
    });
    stop();
    expect(later).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
