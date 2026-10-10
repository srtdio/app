// Catch-up reads from contiguousThrough, never from the newest row on screen.
// A live row (or an own recorded send) can sit past a row live delivery
// dropped; catch-up must still read that row back (T1, T2), resume after a
// capped run without skipping or repeating (T3), keep the objects of rows it
// re-reads (T4), forget the cursor on a reset (T5), and never let older pages
// or by-id hydration move it (T6). The steps mirror use-chat-thread.ts:
// latest page -> latestPageApplied, live fold / outbox recorded -> merge only,
// catch-up -> catchUpRows from through() -> merge -> catchUpApplied.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import {
  CATCH_UP_MAX_PAGES,
  catchUpRows,
  createContiguityTracker,
  insertedInside,
  type CatchUpLoaders,
} from '@/lib/chat/catch-up';
import { CATCH_UP_LIMIT, type HistoryPage } from '@/lib/chat/history';
import {
  compareCursors,
  hydrateReplies,
  mergeFetched,
  rowCursor,
  rowToThreadMessage,
  upsertMessage,
  withOutboxBubbles,
  type ChatMessageRow,
  type MessageCursor,
  type ThreadMessage,
} from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = 'group__ws__g1';

function row(id: string, second: number, sender: string = PEER): ChatMessageRow {
  return {
    id,
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: sender,
    body: `body ${id}`,
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
    created_at: new Date(Date.UTC(2026, 9, 3, 9, 0, second)).toISOString(),
    edited_at: null,
    deleted_at: null,
  };
}

const ok = <T>(data: T): Result<T> => ({ ok: true, data });

/** The record as the history reads see it: loadNewer is a keyset read over `rows`. */
function record(rows: readonly ChatMessageRow[]): CatchUpLoaders & {
  loadNewer: ReturnType<typeof vi.fn<(cursor: MessageCursor) => Promise<Result<ChatMessageRow[]>>>>;
} {
  const sorted = [...rows].sort((a, b) => compareCursors(rowCursor(a), rowCursor(b)));
  return {
    loadLatest: vi.fn(async () =>
      ok<HistoryPage>({ rows: sorted.slice(-50), hasMore: sorted.length > 50 }),
    ),
    loadNewer: vi.fn(async (cursor: MessageCursor) =>
      ok(sorted.filter((r) => compareCursors(rowCursor(r), cursor) > 0).slice(0, CATCH_UP_LIMIT)),
    ),
  };
}

const toMessages = (rows: readonly ChatMessageRow[]): ThreadMessage[] =>
  rows.map((r) => rowToThreadMessage(r, ME));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T09:30:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('catch-up contiguity', () => {
  it('T1 a dropped live row is read back and lands before the live row, which keeps its object', async () => {
    const a = row('a', 0);
    const r1 = row('r1', 10);
    const r2 = row('r2', 20);
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();

    // Latest page: only A existed.
    let messages = mergeFetched([], toMessages([a]));
    tracker.latestPageApplied(epoch, [a]);
    // Live: R1 dropped, R2 verified and folded.
    messages = mergeFetched(messages, toMessages([r2]));
    const r2Object = messages.find((m) => m.id === 'r2');

    // Catch-up starts at A, not at the newer R2.
    const loaders = record([a, r1, r2]);
    expect(tracker.through()).toEqual(rowCursor(a));
    const outcome = await catchUpRows(loaders, tracker.through());
    expect(loaders.loadNewer).toHaveBeenCalledWith(rowCursor(a));
    messages = mergeFetched(messages, toMessages(outcome.rows));
    tracker.catchUpApplied(epoch, outcome.through);

    expect(messages.map((m) => m.id)).toEqual(['a', 'r1', 'r2']);
    expect(messages.find((m) => m.id === 'r2')).toBe(r2Object);
    expect(tracker.through()).toEqual(rowCursor(r2));
  });

  it('T2 an own recorded send does not move contiguousThrough; an older peer row still loads', async () => {
    const a = row('a', 0);
    const peer = row('peer', 10);
    const own = row('own', 20, ME);
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();
    let messages = mergeFetched([], toMessages([a]));
    tracker.latestPageApplied(epoch, [a]);

    // The outbox 'recorded' event upserts the own row; the tracker is not told.
    messages = upsertMessage(messages, rowToThreadMessage(own, ME));
    expect(tracker.through()).toEqual(rowCursor(a));

    const outcome = await catchUpRows(record([a, peer, own]), tracker.through());
    messages = mergeFetched(messages, toMessages(outcome.rows));
    tracker.catchUpApplied(epoch, outcome.through);
    expect(messages.map((m) => m.id)).toEqual(['a', 'peer', 'own']);
    expect(tracker.through()).toEqual(rowCursor(own));
  });

  it('T3 a capped run stops at its last page and the next run resumes there', async () => {
    const start = row('start', 0);
    const pending = Array.from({ length: 25 * CATCH_UP_LIMIT }, (_, i) =>
      row(`p${String(i).padStart(5, '0')}`, 1 + i),
    );
    const loaders = record([start, ...pending]);
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();
    tracker.latestPageApplied(epoch, [start]);

    const run1 = await catchUpRows(loaders, tracker.through());
    expect(run1.ok && run1.capped).toBe(true);
    expect(run1.rows).toHaveLength(CATCH_UP_MAX_PAGES * CATCH_UP_LIMIT);
    tracker.catchUpApplied(epoch, run1.through);
    const lastOfRun1 = pending[CATCH_UP_MAX_PAGES * CATCH_UP_LIMIT - 1];
    expect(lastOfRun1).toBeDefined();
    if (lastOfRun1 !== undefined) expect(tracker.through()).toEqual(rowCursor(lastOfRun1));

    loaders.loadNewer.mockClear();
    const run2 = await catchUpRows(loaders, tracker.through());
    // Page 21 is read from exactly where run 1 stopped.
    if (lastOfRun1 !== undefined) {
      expect(loaders.loadNewer.mock.calls[0]?.[0]).toEqual(rowCursor(lastOfRun1));
    }
    expect(run2.ok && run2.capped).toBe(false);
    tracker.catchUpApplied(epoch, run2.through);

    const ids = [...run1.rows, ...run2.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(pending.map((r) => r.id));
  });

  it('T4 rows the catch-up re-reads keep their objects', async () => {
    const a = row('a', 0);
    const b = row('b', 10);
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();
    tracker.latestPageApplied(epoch, [a]);
    const before = withOutboxBubbles(mergeFetched([], toMessages([a, b])), [], ME);

    // B was folded live; the catch-up from A returns it again.
    const outcome = await catchUpRows(record([a, b]), tracker.through());
    expect(outcome.rows.map((r) => r.id)).toEqual(['b']);
    const after = withOutboxBubbles(mergeFetched(before, toMessages(outcome.rows)), [], ME);
    expect(after).toHaveLength(before.length);
    after.forEach((m, i) => expect(m).toBe(before[i]));
  });

  it('T5 a reset (thread switch, reopen, Retry) clears contiguousThrough; reads from before it cannot move it', () => {
    const a = row('a', 0);
    const b = row('b', 10);
    const tracker = createContiguityTracker();
    const first = tracker.reset();
    tracker.latestPageApplied(first, [a]);
    expect(tracker.through()).toEqual(rowCursor(a));

    const second = tracker.reset();
    expect(second).not.toBe(first);
    expect(tracker.through()).toBeUndefined();
    tracker.catchUpApplied(first, rowCursor(b));
    tracker.latestPageApplied(first, [b]);
    expect(tracker.through()).toBeUndefined();

    tracker.latestPageApplied(second, [b]);
    expect(tracker.through()).toEqual(rowCursor(b));
  });

  it('T6 older pages and by-id hydration never move contiguousThrough', async () => {
    const older = row('older', 0);
    const quoted = row('quoted', 5);
    const a = row('a', 10);
    const reply: ChatMessageRow = { ...row('reply', 20), reply_to_message_id: 'quoted' };
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();
    let messages = mergeFetched([], toMessages([a, reply]));
    tracker.latestPageApplied(epoch, [a, reply]);
    const through = tracker.through();

    // loadOlder page and the quoted-row hydration only touch the list.
    messages = mergeFetched(messages, toMessages([older]));
    messages = hydrateReplies(messages, toMessages([quoted]), true);
    expect(tracker.through()).toEqual(through);
    expect(through).toEqual(rowCursor(reply));

    // A later catch-up still starts from the latest page's newest row.
    const loaders = record([older, quoted, a, reply]);
    await catchUpRows(loaders, tracker.through());
    expect(loaders.loadNewer).toHaveBeenCalledWith(rowCursor(reply));
    expect(messages.map((m) => m.id)).toEqual(['older', 'a', 'reply']);
  });

  it('only a forward cursor advances it (a late latest page never moves it back)', () => {
    const a = row('a', 0);
    const b = row('b', 10);
    const tracker = createContiguityTracker();
    const epoch = tracker.reset();
    tracker.catchUpApplied(epoch, rowCursor(b));
    tracker.latestPageApplied(epoch, [a]);
    expect(tracker.through()).toEqual(rowCursor(b));
  });

  it('a failed page keeps the cursor of the pages before it', async () => {
    const start = row('start', 0);
    const full = Array.from({ length: CATCH_UP_LIMIT }, (_, i) => row(`f${i}`, 1 + i));
    const loaders: CatchUpLoaders = {
      loadLatest: vi.fn(),
      loadNewer: vi
        .fn<(cursor: MessageCursor) => Promise<Result<ChatMessageRow[]>>>()
        .mockResolvedValueOnce(ok(full))
        .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'boom' } }),
    };
    const outcome = await catchUpRows(loaders, rowCursor(start));
    expect(outcome.ok).toBe(false);
    expect(outcome.rows).toHaveLength(CATCH_UP_LIMIT);
    const last = full[full.length - 1];
    if (last !== undefined) expect(outcome.through).toEqual(rowCursor(last));
  });
});

describe('insertedInside', () => {
  const ids = (...list: string[]) => list.map((id) => ({ id }));
  it('is true for a row filled between two known rows', () => {
    expect(insertedInside(['a', 'c'], ids('a', 'b', 'c'))).toBe(true);
  });
  it('is false for an older page on top or new rows at the bottom', () => {
    expect(insertedInside(['b', 'c'], ids('a', 'b', 'c'))).toBe(false);
    expect(insertedInside(['a', 'b'], ids('a', 'b', 'c'))).toBe(false);
    expect(insertedInside([], ids('a'))).toBe(false);
    expect(insertedInside(['a', 'b'], ids('a', 'b'))).toBe(false);
  });
});
