import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ACTIVITY_PAGE_SIZE,
  cursorAfter,
  fetchActivityEntries,
  type ActivityCursor,
} from '@/components/pages/activity/data';
import { fetchInboxSince, fetchNewestInboxAt } from '@/lib/inbox/inbox-reads';
import {
  monthsTouched,
  partitionFake,
  spreadRows,
  type FakeQuery,
  type FakeRow,
} from '@/lib/chat/__tests__/partition-fake';

const NOW = '2026-10-25T12:00:00.000Z';

function entries(
  count: number,
  fromIso: string,
  toIso: string,
  workspaceId = 'w1',
  prefix = 'e',
): FakeRow[] {
  return spreadRows(
    count,
    fromIso,
    toIso,
    () => ({
      user_id: 'u1',
      workspace_id: workspaceId,
      actor_user_id: null,
      event_type: 'asset_uploaded',
      entity_type: null,
      entity_id: null,
      scope: 'posts',
      scope_key: null,
      tier: 'active',
      payload: {},
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
    }),
    prefix,
  );
}

function inboxReads(queries: FakeQuery[]): FakeQuery[] {
  return queries.filter(
    (q) => q.table === 'inbox_entries' && !(q.limit === 1 && q.order[0]?.ascending === true),
  );
}

async function pageAll(
  client: Parameters<typeof fetchActivityEntries>[0],
  workspaceId: string,
  direction: 'newest' | 'oldest' = 'newest',
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: ActivityCursor | undefined;
  for (let i = 0; i < 100; i += 1) {
    const res = await fetchActivityEntries(client, workspaceId, {
      direction,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.length).toBeLessThanOrEqual(ACTIVITY_PAGE_SIZE);
    ids.push(...res.data.map((item) => item.id));
    if (res.data.length < ACTIVITY_PAGE_SIZE) return ids;
    cursor = cursorAfter(res.data);
  }
  throw new Error('inbox paging did not terminate');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('partition-bounded inbox reads', () => {
  it('the first inbox page carries both partition-key bounds and opens at most two months', async () => {
    const rows = entries(120, '2026-10-01T00:00:00Z', '2026-10-24T00:00:00Z');
    const { client, queries } = partitionFake({ inbox_entries: rows });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok && res.data).toHaveLength(ACTIVITY_PAGE_SIZE);
    const reads = inboxReads(queries);
    expect(reads).toHaveLength(1);
    const [read] = reads;
    expect(read?.filters).toEqual(expect.arrayContaining(['gte:created_at', 'lt:created_at']));
    expect(read !== undefined && monthsTouched(read)).toBeLessThanOrEqual(2);
  });

  it('paging newest-first reaches the oldest entry: all of them, once, in order (the inbox is permanent)', async () => {
    // A long-lived inbox: 260 entries over 16 months, sparse at the start.
    const rows = [
      ...entries(10, '2025-06-01T00:00:00Z', '2025-12-31T00:00:00Z', 'w1', 'old'),
      ...entries(250, '2026-01-01T00:00:00Z', '2026-10-24T00:00:00Z'),
    ];
    const { client, queries } = partitionFake({ inbox_entries: rows });
    const ids = await pageAll(client, 'w1');
    expect(ids).toEqual([...rows].reverse().map((r) => r.id));
    expect(new Set(ids).size).toBe(rows.length);
    expect(ids.at(-1)).toBe('old-0000');
    for (const read of inboxReads(queries)) {
      expect(read.filters).toContain('gte:created_at');
      expect(read.filters.some((f) => f === 'lt:created_at' || f === 'lte:created_at')).toBe(true);
    }
  });

  it('paging oldest-first starts at the first entry and walks forward to now', async () => {
    const rows = entries(120, '2026-02-01T00:00:00Z', '2026-10-24T00:00:00Z');
    const { client } = partitionFake({ inbox_entries: rows });
    const ids = await pageAll(client, 'w1', 'oldest');
    expect(ids).toEqual(rows.map((r) => r.id));
  });

  it('cross-tenant: another workspace inbox never appears', async () => {
    const mine = entries(70, '2026-06-01T00:00:00Z', '2026-10-20T00:00:00Z');
    const theirs = entries(70, '2026-06-01T00:00:01Z', '2026-10-20T00:00:01Z', 'w2', 'x');
    const { client } = partitionFake({ inbox_entries: [...mine, ...theirs] });
    const ids = await pageAll(client, 'w1');
    expect(ids).toEqual([...mine].reverse().map((r) => r.id));
  });

  it('the newest-entry seed and the since poll are bounded on both sides', async () => {
    const rows = entries(5, '2026-10-20T00:00:00Z', '2026-10-24T00:00:00Z');
    const { client, queries } = partitionFake({ inbox_entries: rows });
    const newest = await fetchNewestInboxAt(client, { workspaceId: 'w1', userId: 'u1' });
    expect(newest).toEqual({ ok: true, data: rows[4]?.created_at });
    expect(queries[0]?.filters).toEqual(
      expect.arrayContaining(['gte:created_at', 'lt:created_at']),
    );
    const since = await fetchInboxSince(client, {
      workspaceId: 'w1',
      userId: 'u1',
      sinceIso: '2026-10-21T00:00:00.000Z',
    });
    expect(since.ok).toBe(true);
    for (const q of queries.slice(1)) {
      expect(q.filters).toEqual(expect.arrayContaining(['gt:created_at', 'lt:created_at']));
    }
  });

  it('an old inbox with nothing recent still finds its newest entry', async () => {
    const rows = entries(3, '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z');
    const { client } = partitionFake({ inbox_entries: rows });
    const newest = await fetchNewestInboxAt(client, { workspaceId: 'w1', userId: 'u1' });
    expect(newest).toEqual({ ok: true, data: rows[2]?.created_at });
  });
});
