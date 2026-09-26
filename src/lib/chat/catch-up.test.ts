import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import { catchUpRows, startCatchUpTriggers, CATCH_UP_INTERVAL_MS } from '@/lib/chat/catch-up';
import { CATCH_UP_LIMIT, type HistoryPage } from '@/lib/chat/history';
import type { ChatMessageRow, MessageCursor } from '@/lib/chat/thread';

function rows(count: number, from: number): ChatMessageRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      id: `m${String(n).padStart(5, '0')}`,
      created_at: new Date(Date.UTC(2026, 8, 22, 0, 0, n)).toISOString(),
    } as ChatMessageRow;
  });
}

const ok = <T>(data: T): Result<T> => ({ ok: true, data });

describe('catchUpRows', () => {
  it('loads the latest page instead of skipping when nothing is recorded yet', async () => {
    const loadLatest = vi.fn(async () => ok<HistoryPage>({ rows: rows(3, 0), hasMore: false }));
    const loadNewer = vi.fn();
    const outcome = await catchUpRows({ loadLatest, loadNewer }, undefined);
    expect(loadLatest).toHaveBeenCalledOnce();
    expect(loadNewer).not.toHaveBeenCalled();
    expect(outcome.ok && outcome.rows).toHaveLength(3);
    expect(outcome.ok && outcome.latestPage).toEqual({ hasMore: false });
  });

  it('keeps paging while a page hits the 200 cap, from the newest row of each page', async () => {
    const first = rows(CATCH_UP_LIMIT, 0);
    const second = rows(CATCH_UP_LIMIT, CATCH_UP_LIMIT);
    const third = rows(7, 2 * CATCH_UP_LIMIT);
    const loadNewer = vi
      .fn<(cursor: MessageCursor) => Promise<Result<ChatMessageRow[]>>>()
      .mockResolvedValueOnce(ok(first))
      .mockResolvedValueOnce(ok(second))
      .mockResolvedValueOnce(ok(third));
    const cursor = { createdAt: '2026-09-21T00:00:00Z', id: 'm-start' };
    const outcome = await catchUpRows({ loadLatest: vi.fn(), loadNewer }, cursor);
    expect(loadNewer).toHaveBeenCalledTimes(3);
    const lastOfFirst = first[first.length - 1];
    expect(loadNewer.mock.calls[1]?.[0]).toEqual({
      createdAt: lastOfFirst?.created_at,
      id: lastOfFirst?.id,
    });
    expect(outcome.ok && outcome.rows).toHaveLength(2 * CATCH_UP_LIMIT + 7);
  });
});

describe('startCatchUpTriggers', () => {
  function setup(initiallyVisible: boolean) {
    let visible = initiallyVisible;
    let onVisibility: () => void = () => {};
    let onOnline: () => void = () => {};
    const intervals = new Map<number, () => void>();
    let nextHandle = 1;
    const run = vi.fn();
    const clearInterval = vi.fn((h: unknown) => intervals.delete(h as number));
    const setInterval = vi.fn((fn: () => void, ms: number) => {
      expect(ms).toBe(CATCH_UP_INTERVAL_MS);
      const handle = nextHandle++;
      intervals.set(handle, fn);
      return handle;
    });
    const stop = startCatchUpTriggers({
      run,
      isVisible: () => visible,
      onVisibilityChange: (h) => {
        onVisibility = h;
        return () => {
          onVisibility = () => {};
        };
      },
      onOnline: (h) => {
        onOnline = h;
        return () => {
          onOnline = () => {};
        };
      },
      setInterval,
      clearInterval,
    });
    return {
      run,
      intervals,
      stop,
      setVisible: (v: boolean) => {
        visible = v;
        onVisibility();
      },
      online: () => onOnline(),
      tick: () => intervals.forEach((fn) => fn()),
    };
  }

  it('runs on visible and online, every interval while visible, and never while hidden', () => {
    const t = setup(true);
    expect(t.intervals.size).toBe(1);
    t.tick();
    expect(t.run).toHaveBeenCalledTimes(1);

    t.setVisible(false);
    expect(t.intervals.size).toBe(0);
    expect(t.run).toHaveBeenCalledTimes(1);

    t.setVisible(true);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(t.intervals.size).toBe(1);

    t.online();
    expect(t.run).toHaveBeenCalledTimes(3);
  });

  it('clears the interval on teardown and starts none while hidden', () => {
    const hidden = setup(false);
    expect(hidden.intervals.size).toBe(0);
    const t = setup(true);
    t.stop();
    expect(t.intervals.size).toBe(0);
    t.online();
    expect(t.run).not.toHaveBeenCalled();
  });
});
