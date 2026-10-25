import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  LATE_READ_GRACE_MS,
  READ_TIMEOUT_MS,
  abortable,
  listChannelSummaries,
  withLateRead,
  type ChatProfile,
} from '@/lib/chat-reads';
import { attachmentPreviewKind, loadLatestMessages } from '@/lib/chat/history';
import { previewText } from '@/lib/chat/chat-store';
import { createLiveVerifier } from '@/lib/chat/live-verify';
import { fetchOpenPosts } from '@/lib/chat/use-open-posts';
import { resetViewerSideCache, resolveViewerSide } from '@/lib/chat/viewer-role';
import { editedRows } from '@/lib/chat/use-chat-thread';
import { marksReadFailed } from '@/lib/chat/use-chat-marks';
import { CARD_READ_TRIES, createSharedCardCache } from '@/lib/chat/shared-cards';
import type { ChatMessageRow, ThreadMessage } from '@/lib/chat/thread';

afterEach(() => {
  vi.useRealTimers();
});

/** A deferred result the test resolves when it wants. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A PostgREST-ish builder per table: records abortSignal, awaits the table's promise. */
function tableClient(results: Record<string, Promise<{ data: unknown; error: null }>>) {
  const started: string[] = [];
  const signals: Record<string, AbortSignal> = {};
  const from = (table: string) => {
    started.push(table);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'in', 'is', 'or', 'gte', 'lt', 'lte', 'limit']) {
      b[m] = () => b;
    }
    b.abortSignal = (signal: AbortSignal) => {
      signals[table] = signal;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      (results[table] ?? Promise.resolve({ data: [], error: null })).then(resolve, reject);
    return b;
  };
  return { client: { from } as unknown as Client, started, signals };
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe('T1: roster read budget', () => {
  const channel = {
    channel_id: 'c1',
    channel_type: 'dm',
    entity_id: null,
    agora_group_id: null,
    dm_user_a: 'me',
    dm_user_b: 'peer',
    created_at: '2026-09-01T00:00:00Z',
  };

  it('each round-trip has its own 5s; groups, users and roles run in parallel', async () => {
    vi.useFakeTimers();
    const channels = deferred<{ data: unknown; error: null }>();
    const { client, started } = tableClient({
      chat_channels: channels.promise,
      users: never(),
      workspace_members: never(),
    });
    let result: Result<unknown> | null = null;
    void listChannelSummaries(client, { workspaceId: 'w', currentUserId: 'me' }).then((r) => {
      result = r;
    });
    // The registry answers at 4s: inside its own budget.
    await vi.advanceTimersByTimeAsync(4_000);
    channels.resolve({ data: [channel], error: null });
    await vi.advanceTimersByTimeAsync(0);
    // Stage two started together (no groups for a DM-only list).
    expect(started).toEqual(['chat_channels', 'users', 'workspace_members']);
    // Stage two gets a fresh 5s, not what is left of one shared budget.
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false });
  });

  it('a hung registry read fails at 5s and is aborted (E1)', async () => {
    vi.useFakeTimers();
    const { client, signals } = tableClient({ chat_channels: never() });
    let result: Result<unknown> | null = null;
    void listChannelSummaries(client, { workspaceId: 'w', currentUserId: 'me' }).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false });
    expect(signals.chat_channels?.aborted).toBe(true);
  });
});

describe('E1: bounded reads pass an abort signal the client can use', () => {
  it('a timed-out history read is aborted on the wire, not just ignored', async () => {
    vi.useFakeTimers();
    const { client, signals } = tableClient({ chat_messages: never() });
    const pending = loadLatestMessages(client, 'c1');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false });
    expect(signals.chat_messages?.aborted).toBe(true);
  });

  it('abortable leaves a builder without .abortSignal as it is', () => {
    const plain = { select: () => plain };
    expect(abortable(plain, new AbortController().signal)).toBe(plain);
  });
});

describe('T2: a late success wins', () => {
  it('fails at 5s, then hands the late data to onLate', async () => {
    vi.useFakeTimers();
    const later = deferred<Result<string>>();
    const onLate = vi.fn();
    const first = withLateRead(() => later.promise, { onLate });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await first).toMatchObject({ ok: false });
    later.resolve({ ok: true, data: 'rows' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledWith('rows');
  });

  it('an on-time answer never reaches onLate; cancel or the grace cap aborts', async () => {
    vi.useFakeTimers();
    const onLate = vi.fn();
    expect(await withLateRead(async () => ({ ok: true, data: 1 }), { onLate })).toEqual({
      ok: true,
      data: 1,
    });
    const seen: { cancelled?: AbortSignal; graced?: AbortSignal } = {};
    const cancel = new AbortController();
    void withLateRead(
      (s) => {
        seen.cancelled = s;
        return never();
      },
      { onLate, cancel: cancel.signal },
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    cancel.abort();
    expect(seen.cancelled?.aborted).toBe(true);
    void withLateRead(
      (s) => {
        seen.graced = s;
        return never();
      },
      { onLate },
    );
    await vi.advanceTimersByTimeAsync(LATE_READ_GRACE_MS);
    expect(seen.graced?.aborted).toBe(true);
    expect(onLate).not.toHaveBeenCalled();
  });
});

describe('E2: a live verify that fails retries once, then gives up loudly', () => {
  const row = { id: 'm1' } as ChatMessageRow;

  it('a retry that succeeds verifies the message; no give-up', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({ error: 'read timed out' })
      .mockResolvedValueOnce({ found: true, row });
    const onGiveUp = vi.fn();
    const delay = vi.fn(() => Promise.resolve());
    const verifier = createLiveVerifier({
      lookup,
      warn: vi.fn(),
      retryDelayMs: 5_000,
      onGiveUp,
      delay,
    });
    await expect(verifier.verify('m1')).resolves.toEqual({ found: true, row });
    expect(delay).toHaveBeenCalledWith(5_000);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('two failures give up (the store re-reads lines and counts)', async () => {
    const lookup = vi.fn().mockResolvedValue({ error: 'read timed out' });
    const onGiveUp = vi.fn();
    const verifier = createLiveVerifier({
      lookup,
      warn: vi.fn(),
      retryDelayMs: 5_000,
      onGiveUp,
      delay: () => Promise.resolve(),
    });
    await expect(verifier.verify('m1')).resolves.toEqual({ found: false });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledWith('m1');
  });
});

describe('E3: open posts and viewer side are bounded at 5s', () => {
  it('a hung open-posts round settles at 5s as failed reads', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = fetchOpenPosts({} as Client, 'w', { list: never, count: never }).then((d) => {
      done = true;
      return d;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ posts: null, count: null });
  });

  it('a hung role read resolves the side as unknown at 5s (not cached)', async () => {
    vi.useFakeTimers();
    resetViewerSideCache();
    const { client } = tableClient({ workspace_members: never() });
    let side: string | null = null;
    void resolveViewerSide(client, 'w', 'u').then((s) => {
      side = s;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(side).toBe('unknown');
    resetViewerSideCache();
  });
});

describe('E5: catch-up re-reads that carry a missed edit', () => {
  const loaded = { id: 'm1', body: 'old', editedAt: null } as unknown as ThreadMessage;
  const base = {
    id: 'm1',
    channel_id: 'c1',
    body: 'new',
    edited_at: '2026-09-30T10:00:00Z',
    deleted_at: null,
  } as unknown as ChatMessageRow;

  it('an edited row the thread does not show yet is reported; unchanged ones are not', () => {
    expect(editedRows([loaded], [base], 'c1')).toEqual([base]);
    const shown = { ...loaded, body: 'new', editedAt: base.edited_at } as ThreadMessage;
    expect(editedRows([shown], [base], 'c1')).toEqual([]);
    expect(editedRows([loaded], [{ ...base, deleted_at: 'x' }], 'c1')).toEqual([]);
    expect(editedRows([loaded], [{ ...base, edited_at: null }], 'c1')).toEqual([]);
    expect(editedRows([loaded], [base], 'other')).toEqual([]);
  });
});

describe('E8: the preview names what the attachment is', () => {
  it('a voice note is "Voice message" even with no mime', () => {
    const voice = { mime: '', name: 'note.webm', durationMs: 3200 };
    expect(attachmentPreviewKind(voice)).toBe('audio');
    expect(attachmentPreviewKind({ mime: '', name: 'v', transcript: 'hi' })).toBe('audio');
    expect(attachmentPreviewKind({ mime: '', name: 'clip.m4a' })).toBe('audio');
    expect(attachmentPreviewKind({ mime: '', name: 'shot.JPG' })).toBe('image');
    expect(attachmentPreviewKind({ mime: '', name: 'deck.pdf' })).toBe('file');
    expect(attachmentPreviewKind({ mime: 'image/png', name: 'x' })).toBe('image');
    expect(previewText({ body: '', hasAttachments: true, attachmentKinds: ['audio'] })).toBe(
      'Voice message',
    );
  });
});

describe('E16: marks read failure', () => {
  it('settled with no good read is failed (strip hidden, never "Nothing open")', () => {
    expect(marksReadFailed(true, null, 'c1')).toBe(true);
    expect(marksReadFailed(true, 'c1', 'c1')).toBe(false);
    expect(marksReadFailed(false, null, 'c1')).toBe(false);
  });
});

interface Post {
  id: string;
  approved_by: string | null;
}

function cards(readPosts: (ids: string[]) => Promise<Result<Post[]>>) {
  const read = vi.fn(readPosts);
  const cache = createSharedCardCache<Post, { id: string }>(
    {
      readPosts: read,
      readBriefs: async () => ({ ok: true, data: [] }),
      readNames: async (): Promise<Result<ChatProfile[]>> => ({ ok: true, data: [] }),
      postId: (p) => p.id,
      briefId: (b) => b.id,
      approverIds: () => [],
    },
    { schedule: (flush) => flush() },
  );
  return { cache, read };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const failure: Result<Post[]> = { ok: false, error: { code: 'unknown', message: 'x' } };

describe('T5: card read failures keep the skeleton, retry, then offer a tap', () => {
  it('RLS-missing is "not visible"; an error is not', async () => {
    const { cache } = cards(async () => ({ ok: true, data: [] }));
    cache.request({ postIds: ['hidden'] });
    await settle();
    expect(cache.posts(['hidden'])).toMatchObject({ loading: false, posts: [], failed: [] });
    const failing = cards(async () => failure);
    failing.cache.request({ postIds: ['p1'] });
    await settle();
    expect(failing.cache.posts(['p1'])).toMatchObject({ loading: true, failed: [] });
  });

  it(`retries on each trigger, gives up after ${CARD_READ_TRIES} tries, tap starts over`, async () => {
    const { cache, read } = cards(async () => failure);
    cache.request({ postIds: ['p1'] });
    await settle();
    // A plain re-request (a re-render) never re-reads a failed id; triggers do.
    cache.request({ postIds: ['p1'] });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    cache.retryFailed();
    await settle();
    cache.retryFailed({ postIds: ['p1'] });
    await settle();
    expect(read).toHaveBeenCalledTimes(CARD_READ_TRIES);
    expect(cache.posts(['p1'])).toMatchObject({ loading: false, failed: ['p1'] });
    cache.retryFailed();
    await settle();
    expect(read).toHaveBeenCalledTimes(CARD_READ_TRIES);
    read.mockImplementation(async () => ({ ok: true, data: [{ id: 'p1', approved_by: null }] }));
    cache.retry({ postIds: ['p1'] });
    await settle();
    expect(cache.posts(['p1'])).toMatchObject({ loading: false, failed: [] });
    expect(cache.posts(['p1']).posts).toHaveLength(1);
  });
});

describe('E10: a refresh during an in-flight read is not lost', () => {
  it('runs one more read after the current one', async () => {
    const first = deferred<Result<Post[]>>();
    const { cache, read } = cards(() => first.promise);
    cache.request({ postIds: ['p1'] });
    await settle();
    cache.refreshPosts(['p1']);
    cache.refreshPosts(['p1']);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockImplementation(async () => ({ ok: true, data: [{ id: 'p1', approved_by: 'u' }] }));
    first.resolve({ ok: true, data: [{ id: 'p1', approved_by: null }] });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.posts(['p1']).posts[0]?.approved_by).toBe('u');
  });
});
