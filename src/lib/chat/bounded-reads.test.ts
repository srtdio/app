import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import {
  CLOCK_SKEW_MS,
  HISTORY_WINDOW_MS,
  readBoundedForward,
  readBoundedPage,
  type TimeBounds,
} from '@/lib/chat/bounded-window';
import {
  clearMessagePrefetch,
  HISTORY_PAGE_SIZE,
  loadConversationPreviews,
  loadLatestMessages,
  loadNewerMessages,
  loadOlderMessages,
  loadThreadPage,
  type HistoryPage,
} from '@/lib/chat/history';
import type { MessageCursor } from '@/lib/chat/thread';
import {
  monthsTouched,
  partitionFake,
  spreadRows,
  type FakeQuery,
  type FakeRow,
} from '@/lib/chat/__tests__/partition-fake';

const NOW = '2026-10-25T12:00:00.000Z';
const CH = 'group__ws1__g1';
const OTHER_CH = 'group__ws2__g9';

function historyReads(queries: FakeQuery[]): FakeQuery[] {
  // The paging floor probe (ORDER BY created_at ASC LIMIT 1, no range) aside.
  return queries.filter(
    (q) => q.table === 'chat_messages' && !(q.limit === 1 && q.order[0]?.ascending === true),
  );
}

function cursorOf(page: HistoryPage): MessageCursor {
  const oldest = page.rows[0];
  if (oldest === undefined) throw new Error('empty page');
  return { createdAt: oldest.created_at, id: oldest.id };
}

async function pageAll(
  load: (cursor?: MessageCursor) => Promise<Result<HistoryPage>>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  let page = await load();
  for (;;) {
    pages += 1;
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.rows.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE);
    ids.unshift(...page.data.rows.map((r) => r.id));
    if (!page.data.hasMore || page.data.rows.length === 0) break;
    if (pages > 100) throw new Error('paging did not terminate');
    page = await load(cursorOf(page.data));
  }
  return { ids, pages };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  clearMessagePrefetch();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded chat history reads', () => {
  it('the latest page carries both partition-key bounds and opens at most two months', async () => {
    const rows = spreadRows(120, '2026-10-01T00:00:00Z', '2026-10-24T00:00:00Z', () => ({
      channel_id: CH,
      workspace_id: 'ws1',
    }));
    const { client, queries } = partitionFake({ chat_messages: rows });
    const page = await loadLatestMessages(client, CH);
    expect(page.ok && page.data.rows.length).toBe(HISTORY_PAGE_SIZE);
    const reads = historyReads(queries);
    expect(reads).toHaveLength(1);
    const [read] = reads;
    expect(read?.filters).toContain('gte:created_at');
    expect(read?.filters).toContain('lt:created_at');
    const lower = read?.range.find(([op]) => op === 'gte')?.[1];
    const upper = read?.range.find(([op]) => op === 'lt')?.[1];
    expect(lower).toBe(new Date(Date.parse(NOW) + CLOCK_SKEW_MS - HISTORY_WINDOW_MS).toISOString());
    expect(upper).toBe(new Date(Date.parse(NOW) + CLOCK_SKEW_MS).toISOString());
    expect(read !== undefined && monthsTouched(read)).toBeLessThanOrEqual(2);
    // A busy channel never needs the floor probe.
    expect(queries.filter((q) => q.table === 'chat_messages')).toHaveLength(1);
  });

  it('an older page is bounded below and above (lte the cursor) plus the keyset filter', async () => {
    const rows = spreadRows(200, '2026-09-01T00:00:00Z', '2026-10-24T00:00:00Z', () => ({
      channel_id: CH,
    }));
    const { client, queries } = partitionFake({ chat_messages: rows });
    const cursor = { createdAt: rows[120]?.created_at ?? '', id: rows[120]?.id ?? '' };
    const page = await loadOlderMessages(client, CH, cursor);
    expect(page.ok && page.data.rows.map((r) => r.id)).toEqual(
      rows.slice(70, 120).map((r) => r.id),
    );
    for (const read of historyReads(queries)) {
      expect(read.filters).toEqual(expect.arrayContaining(['gte:created_at', 'or']));
      expect(read.filters.some((f) => f === 'lte:created_at' || f === 'lt:created_at')).toBe(true);
    }
  });

  it('pages through 300 messages spanning 3 months: all of them, no duplicates, no gaps, terminates', async () => {
    const rows = spreadRows(300, '2026-07-20T00:00:00Z', '2026-10-20T00:00:00Z', () => ({
      channel_id: CH,
    }));
    // Same-timestamp neighbours exercise the (created_at, id) keyset.
    const twin = rows[150];
    if (twin !== undefined) rows.push({ ...twin, id: `${twin.id}-b` });
    const { client, queries } = partitionFake({ chat_messages: rows });
    const { ids } = await pageAll((cursor) =>
      cursor === undefined ? loadLatestMessages(client, CH) : loadOlderMessages(client, CH, cursor),
    );
    const expected = [...rows]
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.id.localeCompare(b.id)
          : Date.parse(a.created_at) - Date.parse(b.created_at),
      )
      .map((r) => r.id);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    for (const read of historyReads(queries)) {
      expect(read.filters).toContain('gte:created_at');
      expect(read.filters.some((f) => f === 'lte:created_at' || f === 'lt:created_at')).toBe(true);
    }
    // The floor is read once per channel for the whole scroll back.
    const probes = queries.filter(
      (q) => q.table === 'chat_messages' && q.limit === 1 && q.order[0]?.ascending === true,
    );
    expect(probes.length).toBeLessThanOrEqual(1);
  });

  it('a sparse channel widens back to its first message (a year-old message is never hidden)', async () => {
    const rows: FakeRow[] = [
      { id: 'old-1', created_at: '2025-06-01T08:00:00.123456Z', channel_id: CH },
      { id: 'old-2', created_at: '2025-11-15T08:00:00Z', channel_id: CH },
      { id: 'new-1', created_at: '2026-10-20T08:00:00Z', channel_id: CH },
    ];
    const { client } = partitionFake({ chat_messages: rows });
    const page = await loadLatestMessages(client, CH);
    expect(page.ok && page.data.rows.map((r) => r.id)).toEqual(['old-1', 'old-2', 'new-1']);
    expect(page.ok && page.data.hasMore).toBe(false);
  });

  it('an empty channel ends after one window and the floor probe', async () => {
    const { client, queries } = partitionFake({ chat_messages: [] });
    const page = await loadLatestMessages(client, CH);
    expect(page.ok && page.data).toEqual({ rows: [], hasMore: false });
    expect(queries).toHaveLength(2);
  });

  it('cross-tenant: another workspace channel never appears, even with interleaved times', async () => {
    const mine = spreadRows(80, '2026-08-01T00:00:00Z', '2026-10-20T00:00:00Z', () => ({
      channel_id: CH,
      workspace_id: 'ws1',
    }));
    const theirs = spreadRows(
      80,
      '2026-08-01T00:00:01Z',
      '2026-10-20T00:00:01Z',
      () => ({ channel_id: OTHER_CH, workspace_id: 'ws2' }),
      'x',
    );
    const { client } = partitionFake({ chat_messages: [...mine, ...theirs] });
    const { ids } = await pageAll((cursor) =>
      cursor === undefined ? loadLatestMessages(client, CH) : loadOlderMessages(client, CH, cursor),
    );
    expect(ids).toEqual(mine.map((r) => r.id));
    const previews = await loadConversationPreviews(client, 'ws1');
    expect(previews.ok && previews.data.map((p) => p.channelId)).toEqual([CH]);
  });

  it('a thread page is bounded and filtered to its root', async () => {
    const rows = spreadRows(60, '2026-09-01T00:00:00Z', '2026-10-20T00:00:00Z', (i) => ({
      channel_id: CH,
      thread_root_message_id: i % 2 === 0 ? 'root' : null,
    }));
    const { client, queries } = partitionFake({ chat_messages: rows });
    const page = await loadThreadPage(client, CH, 'root');
    expect(page.ok && page.data.rows.length).toBe(30);
    for (const read of historyReads(queries)) {
      expect(read.filters).toEqual(
        expect.arrayContaining(['gte:created_at', 'eq:thread_root_message_id']),
      );
    }
  });

  it('catch-up is bounded from the cursor up to now plus the skew margin', async () => {
    const rows = spreadRows(10, '2026-10-24T00:00:00Z', '2026-10-25T11:00:00Z', () => ({
      channel_id: CH,
    }));
    const { client, queries } = partitionFake({ chat_messages: rows });
    const cursor = { createdAt: rows[4]?.created_at ?? '', id: rows[4]?.id ?? '' };
    const newer = await loadNewerMessages(client, CH, cursor);
    expect(newer.ok && newer.data.map((r) => r.id)).toEqual(rows.slice(5).map((r) => r.id));
    expect(queries[0]?.filters).toEqual(
      expect.arrayContaining(['gte:created_at', 'lt:created_at', 'or']),
    );
  });
});

describe('readBoundedPage / readBoundedForward', () => {
  function windowSource(rows: FakeRow[]) {
    const windows: TimeBounds[] = [];
    let oldestCalls = 0;
    const inWindow = (r: FakeRow, b: TimeBounds): boolean => {
      const t = Date.parse(r.created_at);
      if (t < Date.parse(b.from)) return false;
      if (b.to === null) return true;
      return b.toInclusive ? t <= Date.parse(b.to) : t < Date.parse(b.to);
    };
    return {
      windows,
      oldestCalls: () => oldestCalls,
      read: (b: TimeBounds, limit: number): Promise<Result<FakeRow[]>> => {
        windows.push(b);
        const hit = rows
          .filter((r) => inWindow(r, b))
          .sort((a, c) => Date.parse(c.created_at) - Date.parse(a.created_at));
        return Promise.resolve({ ok: true, data: hit.slice(0, limit) });
      },
      readAsc: (b: TimeBounds, limit: number): Promise<Result<FakeRow[]>> => {
        windows.push(b);
        const hit = rows
          .filter((r) => inWindow(r, b))
          .sort((a, c) => Date.parse(a.created_at) - Date.parse(c.created_at));
        return Promise.resolve({ ok: true, data: hit.slice(0, limit) });
      },
      oldest: (): Promise<Result<string | null>> => {
        oldestCalls += 1;
        const first = [...rows].sort(
          (a, c) => Date.parse(a.created_at) - Date.parse(c.created_at),
        )[0];
        return Promise.resolve({ ok: true, data: first?.created_at ?? null });
      },
    };
  }

  it('windows are disjoint, each has both bounds, and the floor is read once', async () => {
    const rows = spreadRows(20, '2024-01-01T00:00:00Z', '2026-10-01T00:00:00Z', () => ({}));
    const src = windowSource(rows);
    const res = await readBoundedPage({
      pageSize: 50,
      upper: NOW,
      upperInclusive: false,
      read: src.read,
      oldest: src.oldest,
    });
    expect(res.ok && res.data).toHaveLength(20);
    expect(src.oldestCalls()).toBe(1);
    for (const w of src.windows) expect(w.to).not.toBeNull();
    for (let i = 1; i < src.windows.length; i += 1) {
      expect(src.windows[i]?.to).toBe(src.windows[i - 1]?.from);
      expect(src.windows[i]?.toInclusive).toBe(false);
    }
    expect(src.windows.at(-1)?.from).toBe(rows[0]?.created_at);
  });

  it('a slow device clock (rows newer than the edge) re-reads open-ended from the oldest row', async () => {
    const rows = spreadRows(3, '2026-12-01T00:00:00Z', '2026-12-02T00:00:00Z', () => ({}));
    const src = windowSource(rows);
    const res = await readBoundedPage({
      pageSize: 50,
      upper: NOW,
      upperInclusive: false,
      openEnded: true,
      read: src.read,
      oldest: src.oldest,
    });
    expect(res.ok && res.data).toHaveLength(3);
    expect(src.windows.at(-1)).toEqual({ from: rows[0]?.created_at, to: null, toInclusive: false });
  });

  it('forward paging walks to now and leaves the last window open-ended', async () => {
    const rows = spreadRows(30, '2026-01-01T00:00:00Z', '2026-10-25T00:00:00Z', () => ({}));
    const src = windowSource(rows);
    const res = await readBoundedForward({
      pageSize: 50,
      lower: rows[0]?.created_at ?? '',
      read: src.readAsc,
      nowMs: Date.parse(NOW),
    });
    expect(res.ok && res.data.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(src.windows.at(-1)?.to).toBeNull();
    for (const w of src.windows.slice(0, -1)) expect(w.to).not.toBeNull();
  });

  it('a failed window fails the page', async () => {
    const res = await readBoundedPage<FakeRow>({
      pageSize: 50,
      upper: NOW,
      upperInclusive: false,
      read: () => Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } }),
      oldest: () => Promise.resolve({ ok: true, data: null }),
    });
    expect(res).toEqual({ ok: false, error: { code: 'unknown', message: 'boom' } });
  });
});
