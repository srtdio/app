import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import {
  ceilingNowMs,
  noteAuthToken,
  resetServerClock,
  SERVER_NOW_MARGIN_MS,
  serverNowMs,
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
import { fetchInboxSince } from '@/lib/inbox/inbox-reads';
import {
  monthsTouched,
  noteServerNow,
  partitionFake,
  spreadRows,
  tokenIssuedAt,
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
  // The server's clock, as the iat of a freshly refreshed access token reports it.
  resetServerClock();
  noteServerNow(Date.parse(NOW));
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
    expect(lower).toBe(
      new Date(Date.parse(NOW) + SERVER_NOW_MARGIN_MS - HISTORY_WINDOW_MS).toISOString(),
    );
    expect(upper).toBe(new Date(Date.parse(NOW) + SERVER_NOW_MARGIN_MS).toISOString());
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

  it('catch-up is bounded from the cursor up to the server clock plus a minute', async () => {
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

describe('partition bounds come from the server clock, never the device clock', () => {
  const DAY_MS = 86_400_000;
  // The server's newest message, half a minute before its now.
  const rows = (): FakeRow[] => [
    { id: 'older', created_at: '2026-10-20T08:00:00.000Z', channel_id: CH },
    { id: 'newest', created_at: '2026-10-25T11:59:30.000Z', channel_id: CH },
  ];
  const cases: Array<[string, number]> = [
    ['3 days slow', -3 * DAY_MS],
    ['3 days fast', 3 * DAY_MS],
  ];
  for (const [label, skewMs] of cases) {
    it(`a device clock ${label} still opens on the newest message`, async () => {
      vi.setSystemTime(new Date(Date.parse(NOW) + skewMs));
      resetServerClock();
      // A fresh access token arrives: its iat is the server's now.
      noteServerNow(Date.parse(NOW));
      const { client, queries } = partitionFake({ chat_messages: rows() });
      const page = await loadLatestMessages(client, CH);
      expect(page.ok && page.data.rows.map((r) => r.id).at(-1)).toBe('newest');
      const [read] = historyReads(queries);
      // The ceiling is the later of the device and the server now: a slow
      // device is lifted to the server's now, a fast one keeps its own.
      const upper = new Date(
        Math.max(Date.parse(NOW), Date.parse(NOW) + skewMs) + SERVER_NOW_MARGIN_MS,
      ).toISOString();
      expect(read?.range).toEqual([
        ['gte', new Date(Date.parse(upper) - HISTORY_WINDOW_MS).toISOString()],
        ['lt', upper],
      ]);
    });
  }

  it('before the first fresh token the newest page has no upper bound, and still finds the newest', async () => {
    vi.setSystemTime(new Date(Date.parse(NOW) - 3 * DAY_MS));
    resetServerClock();
    const { client, queries } = partitionFake({ chat_messages: rows() });
    const page = await loadLatestMessages(client, CH);
    expect(page.ok && page.data.rows.map((r) => r.id)).toEqual(['older', 'newest']);
    const [first] = historyReads(queries);
    expect(first?.filters).toContain('gte:created_at');
    expect(first?.filters.some((f) => f === 'lt:created_at' || f === 'lte:created_at')).toBe(false);
    // Catch-up before the first fresh token: bounded below only.
    const cursor = { createdAt: '2026-10-20T08:00:00.000Z', id: 'older' };
    const newer = await loadNewerMessages(client, CH, cursor);
    expect(newer.ok && newer.data.map((r) => r.id)).toEqual(['newest']);
    expect(queries.at(-1)?.filters).not.toContain('lt:created_at');
  });

  it('the offset follows the latest fresh token; an unreadable token keeps it', () => {
    resetServerClock();
    expect(serverNowMs()).toBeNull();
    noteAuthToken('SIGNED_IN', tokenIssuedAt(Date.parse(NOW)));
    expect(serverNowMs()).toBe(Date.parse(NOW));
    noteAuthToken('TOKEN_REFRESHED', tokenIssuedAt(Date.parse(NOW) + 5 * 60_000));
    expect(serverNowMs()).toBe(Date.parse(NOW) + 5 * 60_000);
    noteAuthToken('TOKEN_REFRESHED', null);
    noteAuthToken('TOKEN_REFRESHED', 'not.a-token');
    noteAuthToken('TOKEN_REFRESHED', 'no-dots');
    expect(serverNowMs()).toBe(Date.parse(NOW) + 5 * 60_000);
    // Time passing on the device moves the server's now with it.
    vi.setSystemTime(new Date(Date.parse(NOW) + 1_000));
    expect(serverNowMs()).toBe(Date.parse(NOW) + 5 * 60_000 + 1_000);
  });
});

describe('server clock from the access token iat', () => {
  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;

  it('INITIAL_SESSION never sets the offset (a stored token can be an hour old)', () => {
    resetServerClock();
    noteAuthToken('INITIAL_SESSION', tokenIssuedAt(Date.parse(NOW) - 59 * 60_000));
    expect(serverNowMs()).toBeNull();
  });

  it('a stored token replayed under SIGNED_IN after INITIAL_SESSION is ignored', () => {
    resetServerClock();
    const stored = tokenIssuedAt(Date.parse(NOW) - 50 * 60_000);
    noteAuthToken('INITIAL_SESSION', stored);
    noteAuthToken('SIGNED_IN', stored);
    expect(serverNowMs()).toBeNull();
    // The next refresh is fresh: it sets the offset.
    noteAuthToken('TOKEN_REFRESHED', tokenIssuedAt(Date.parse(NOW)));
    expect(serverNowMs()).toBe(Date.parse(NOW));
  });

  it('an older token never moves the offset back', () => {
    resetServerClock();
    noteAuthToken('TOKEN_REFRESHED', tokenIssuedAt(Date.parse(NOW)));
    noteAuthToken('SIGNED_IN', tokenIssuedAt(Date.parse(NOW) - HOUR_MS));
    expect(serverNowMs()).toBe(Date.parse(NOW));
  });

  it('other events never set the offset', () => {
    resetServerClock();
    noteAuthToken('USER_UPDATED', tokenIssuedAt(Date.parse(NOW)));
    noteAuthToken('SIGNED_OUT', tokenIssuedAt(Date.parse(NOW)));
    expect(serverNowMs()).toBeNull();
  });

  const skews: Array<[string, number]> = [
    ['3 days slow', -3 * DAY_MS],
    ['3 days fast', 3 * DAY_MS],
  ];
  for (const [label, skewMs] of skews) {
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED'] as const) {
      it(`${event} on a device ${label}: offset = iat*1000 - Date.now()`, () => {
        vi.setSystemTime(new Date(Date.parse(NOW) + skewMs));
        resetServerClock();
        noteAuthToken(event, tokenIssuedAt(Date.parse(NOW)));
        expect(serverNowMs()).toBe(Date.parse(NOW));
      });
    }
  }
});

describe('a wrong-low server estimate never hides recent rows (ceiling = max(device, server))', () => {
  const MIN_MS = 60_000;
  const DAY_MS = 86_400_000;
  const OLD_AT = '2026-10-20T08:00:00.000Z';
  const inboxRow = (id: string, createdAt: string): FakeRow => ({
    id,
    created_at: createdAt,
    workspace_id: 'ws1',
    user_id: 'u1',
    actor_user_id: null,
    event_type: 'asset_uploaded',
    entity_type: null,
    entity_id: null,
    scope: 'posts',
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    deleted_at: null,
  });

  /** A message and an inbox entry from 1 min ago (real time) come back from every now-bounded read. */
  async function expectRecentEverywhere(): Promise<void> {
    const recentAt = new Date(Date.parse(NOW) - MIN_MS).toISOString();
    const chat: FakeRow[] = [
      { id: 'older', created_at: OLD_AT, channel_id: CH, workspace_id: 'ws1', deleted_at: null },
      { id: 'recent', created_at: recentAt, channel_id: CH, workspace_id: 'ws1', deleted_at: null },
    ];
    const { client } = partitionFake({
      chat_messages: chat,
      inbox_entries: [inboxRow('e-old', OLD_AT), inboxRow('e-recent', recentAt)],
    });
    // Newest page (the open read and the tap prefetch share it).
    const page = await loadLatestMessages(client, CH);
    expect(page.ok && page.data.rows.map((r) => r.id).at(-1)).toBe('recent');
    // Catch-up from the older row.
    const newer = await loadNewerMessages(client, CH, { createdAt: OLD_AT, id: 'older' });
    expect(newer.ok && newer.data.map((r) => r.id)).toEqual(['recent']);
    // Conversation previews: the last line is the recent message.
    const previews = await loadConversationPreviews(client, 'ws1');
    expect(previews.ok && previews.data.map((p) => p.messageId)).toEqual(['recent']);
    // Since-poll: the recent inbox entry is picked up.
    const since = await fetchInboxSince(client, {
      workspaceId: 'ws1',
      userId: 'u1',
      sinceIso: '2026-10-24T00:00:00.000Z',
    });
    expect(since.ok && since.data.rows.map((r) => r.id)).toEqual(['e-recent']);
  }

  it('SIGNED_IN with a 50-min-old stored token and no INITIAL_SESSION first', async () => {
    resetServerClock();
    noteAuthToken('SIGNED_IN', tokenIssuedAt(Date.parse(NOW) - 50 * MIN_MS));
    // The estimate is wrong low (taken as fresh), the ceiling is not.
    expect(serverNowMs()).toBe(Date.parse(NOW) - 50 * MIN_MS);
    expect(ceilingNowMs()).toBe(Date.parse(NOW));
    await expectRecentEverywhere();
  });

  it("another tab's older-but-newer-than-seen token (offset -30 min)", async () => {
    resetServerClock();
    noteAuthToken('INITIAL_SESSION', tokenIssuedAt(Date.parse(NOW) - 55 * MIN_MS));
    noteAuthToken('SIGNED_IN', tokenIssuedAt(Date.parse(NOW) - 30 * MIN_MS));
    expect(serverNowMs()).toBe(Date.parse(NOW) - 30 * MIN_MS);
    expect(ceilingNowMs()).toBe(Date.parse(NOW));
    await expectRecentEverywhere();
  });

  it('device 3 days slow + a fresh TOKEN_REFRESHED: the server estimate wins', async () => {
    vi.setSystemTime(new Date(Date.parse(NOW) - 3 * DAY_MS));
    resetServerClock();
    noteAuthToken('TOKEN_REFRESHED', tokenIssuedAt(Date.parse(NOW)));
    expect(ceilingNowMs()).toBe(Date.parse(NOW));
    await expectRecentEverywhere();
  });

  it('device 3 days fast: the device clock is the ceiling, the newest row still comes back', async () => {
    vi.setSystemTime(new Date(Date.parse(NOW) + 3 * DAY_MS));
    resetServerClock();
    noteAuthToken('TOKEN_REFRESHED', tokenIssuedAt(Date.parse(NOW)));
    expect(ceilingNowMs()).toBe(Date.parse(NOW) + 3 * DAY_MS);
    await expectRecentEverywhere();
  });

  it('no offset yet: no ceiling at all, the newest row comes back', async () => {
    resetServerClock();
    expect(ceilingNowMs()).toBeNull();
    await expectRecentEverywhere();
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
