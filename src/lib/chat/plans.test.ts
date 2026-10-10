import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';
import {
  PLAN_READ_CHUNK,
  PLAN_READ_TRIES,
  PLAN_SHARE_FAILED,
  TEAM_PLAN_CLIENT_CHAT,
  assembleBundles,
  conceptAddArgs,
  conceptEditArgs,
  createShareEpoch,
  readItemFiles,
  createPlanCardCache,
  initialShareProgress,
  planChunks,
  planItemDay,
  readPlanBundles,
  readPlanScreen,
  runPlanShare,
  sortPlanItemsByDate,
  type PlanBundle,
  type PlanItemRow,
  type PlanDraft,
  type PlanShareDeps,
} from '@/lib/chat/plans';
import { forwardLandsInOpenChat, sharePlanToChannel } from '@/lib/chat/share-plan';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import type { ChatMessageRow } from '@/lib/chat/thread';

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const err = <T>(message: string): Result<T> => ({ ok: false, error: { code: 'unknown', message } });

const DRAFT: PlanDraft = {
  workspaceId: 'ws',
  channelId: 'dm__ws__a__b',
  title: 'Week of 12 Oct',
  startsOn: '2026-10-12',
  endsOn: '2026-10-18',
  audience: 'client',
  concepts: [
    { key: 'k1', title: 'Reel', description: 'd1', versionIds: ['v1'], targetDate: null },
    { key: 'k2', title: 'Carousel', description: 'd2', versionIds: [], targetDate: '2026-10-14' },
    { key: 'k3', title: 'Leaders', description: '', versionIds: [], targetDate: null },
  ],
  postIds: ['p1', 'p2'],
};

function deps(over: Partial<PlanShareDeps> = {}): PlanShareDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: vi.fn(async () => {
      calls.push('create');
      return ok('plan1');
    }),
    conceptAdd: vi.fn(async (_planId, concept) => {
      calls.push(`concept:${concept.key}`);
      return ok(`item-${concept.key}`);
    }),
    postsAdd: vi.fn(async (_planId, ids) => {
      calls.push(`posts:${ids.join(',')}`);
      return ok(ids.length);
    }),
    share: vi.fn(async (_planId, _channel, messageId) => {
      calls.push(`share:${messageId}`);
      return ok({});
    }),
    ...over,
  };
}

describe('runPlanShare', () => {
  it('runs create, each concept in order, posts in one call, then the share, one trace', async () => {
    const d = deps();
    const result = await runPlanShare(d, DRAFT, initialShareProgress('msg1'), 'trace1');
    expect(result.ok).toBe(true);
    expect(d.calls).toEqual([
      'create',
      'concept:k1',
      'concept:k2',
      'concept:k3',
      'posts:p1,p2',
      'share:msg1',
    ]);
    for (const fn of [d.create, d.conceptAdd, d.postsAdd, d.share]) {
      for (const call of (fn as ReturnType<typeof vi.fn>).mock.calls) {
        expect(call).toContain('trace1');
      }
    }
  });

  it('resumes from the failed step and never repeats plan_create or an added concept', async () => {
    let failOnce = true;
    const d = deps({
      conceptAdd: vi.fn(async (_planId, concept) => {
        if (concept.key === 'k2' && failOnce) {
          failOnce = false;
          return err<string>('network');
        }
        d.calls.push(`concept:${concept.key}`);
        return ok(`item-${concept.key}`);
      }),
    });
    const first = await runPlanShare(d, DRAFT, initialShareProgress('msg1'), 't');
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.step).toBe('concepts');
    expect(first.copy).toBe(PLAN_SHARE_FAILED);
    expect(first.progress).toMatchObject({ planId: 'plan1', conceptsDone: 1, shared: false });
    const second = await runPlanShare(d, DRAFT, first.progress, 't');
    expect(second.ok).toBe(true);
    expect(d.calls.filter((c) => c === 'create')).toHaveLength(1);
    expect(d.calls.filter((c) => c === 'concept:k1')).toHaveLength(1);
    expect(d.calls.filter((c) => c === 'concept:k2')).toHaveLength(1);
    expect(d.calls.filter((c) => c === 'concept:k3')).toHaveLength(1);
  });

  it('a failed share step retries with the same message id (idempotent) and no other writes', async () => {
    let failOnce = true;
    const d = deps({
      share: vi.fn(async (_p, _c, messageId) => {
        d.calls.push(`share:${messageId}`);
        if (failOnce) {
          failOnce = false;
          return err<unknown>('timeout');
        }
        return ok({});
      }),
    });
    const first = await runPlanShare(d, DRAFT, initialShareProgress('msg1'), 't');
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.step).toBe('share');
    const second = await runPlanShare(d, DRAFT, first.progress, 't');
    expect(second.ok).toBe(true);
    expect(d.calls).toEqual([
      'create',
      'concept:k1',
      'concept:k2',
      'concept:k3',
      'posts:p1,p2',
      'share:msg1',
      'share:msg1',
    ]);
  });

  it("'plan_not_shared_with_client' surfaces as the inline team-only copy", async () => {
    const d = deps({ share: vi.fn(async () => err<unknown>('plan_not_shared_with_client')) });
    const result = await runPlanShare(
      d,
      { ...DRAFT, audience: 'team' },
      initialShareProgress('m'),
      't',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.copy).toBe(TEAM_PLAN_CLIENT_CHAT);
  });

  it('no posts: the posts step is skipped, never called with an empty list', async () => {
    const d = deps();
    const result = await runPlanShare(d, { ...DRAFT, postIds: [] }, initialShareProgress('m'), 't');
    expect(result.ok).toBe(true);
    expect(d.postsAdd).not.toHaveBeenCalled();
  });

  it('a failed create keeps nothing and retries create', async () => {
    let n = 0;
    const d = deps({
      create: vi.fn(async () => {
        n += 1;
        return n === 1 ? err<string>('boom') : ok('plan9');
      }),
    });
    const first = await runPlanShare(d, DRAFT, initialShareProgress('m'), 't');
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.step).toBe('create');
    expect(first.progress.planId).toBeNull();
    const second = await runPlanShare(d, DRAFT, first.progress, 't');
    expect(second.ok && second.progress.planId).toBe('plan9');
  });
});

// A recording PostgREST-ish fake: each from() starts a query; awaiting it yields
// rows from the table's handler, given the IN list.
function fakeClient(tables: Record<string, (column: string, ids: string[]) => unknown[]>) {
  const log: Array<{ table: string; select: string; column: string; ids: string[] }> = [];
  const from = vi.fn((table: string) => {
    let select = '';
    let column = '';
    let ids: string[] = [];
    const q: Record<string, unknown> = {};
    q.select = (cols: string) => {
      select = cols;
      return q;
    };
    q.in = (col: string, values: string[]) => {
      column = col;
      ids = values;
      return q;
    };
    for (const m of ['is', 'eq', 'order', 'abortSignal']) q[m] = () => q;
    q.then = (resolve: (v: unknown) => unknown) => {
      log.push({ table, select, column, ids });
      const handler = tables[table];
      return Promise.resolve({ data: handler ? handler(column, ids) : [], error: null }).then(
        resolve,
      );
    };
    return q;
  });
  return { client: { from } as unknown as Client, log };
}

describe('plan reads', () => {
  it('reads plans, items, reviews and post stages by id lists, never an embed', async () => {
    const { client, log } = fakeClient({
      plans: (_c, ids) =>
        ids
          .filter((id) => id !== 'hidden')
          .map((id) => ({
            id,
            workspace_id: 'ws',
            title: 'T',
            starts_on: '2026-10-12',
            ends_on: '2026-10-18',
            audience: 'client',
            created_by: null,
          })),
      plan_items: () => [
        {
          id: 'i1',
          plan_id: 'a',
          kind: 'concept',
          position: 1,
          title: 'C',
          description: null,
          post_id: null,
          created_at: '1',
        },
        {
          id: 'i2',
          plan_id: 'a',
          kind: 'post',
          position: 0,
          title: null,
          description: null,
          post_id: 'p1',
          created_at: '1',
        },
      ],
      plan_item_reviews: () => [{ item_id: 'i1', side: 'client', status: 'approved' }],
      posts: () => [{ id: 'p1', stage: 'review', title: 'Post', target_date: null }],
    });
    const result = await readPlanBundles(client, ['a', 'hidden']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.data.keys()]).toEqual(['a']);
    expect(result.data.get('a')?.items.map((i) => i.id)).toEqual(['i2', 'i1']);
    expect(result.data.get('a')?.postStages).toEqual({ p1: 'review' });
    expect(log.map((l) => [l.table, l.column])).toEqual([
      ['plans', 'id'],
      ['plan_items', 'plan_id'],
      ['plan_item_reviews', 'item_id'],
      ['posts', 'id'],
    ]);
    for (const l of log) expect(l.select).not.toMatch(/[()]/);
  });

  it('chunks id lists at 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    expect(planChunks(ids).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(PLAN_READ_CHUNK).toBe(100);
    const { client, log } = fakeClient({ plans: () => [] });
    await readPlanBundles(client, ids);
    expect(log.filter((l) => l.table === 'plans').map((l) => l.ids.length)).toEqual([100, 100, 50]);
  });

  it('the plan screen adds one comment-count read over every item id', async () => {
    const { client, log } = fakeClient({
      plans: (_c, ids) =>
        ids.map((id) => ({
          id,
          workspace_id: 'ws',
          title: 'T',
          starts_on: '2026-10-12',
          ends_on: '2026-10-18',
          audience: 'team',
          created_by: null,
        })),
      plan_items: () => [
        {
          id: 'i1',
          plan_id: 'a',
          kind: 'concept',
          position: 0,
          title: 'C',
          description: null,
          post_id: null,
          created_at: '1',
        },
      ],
      plan_item_comments: () => [{ item_id: 'i1' }, { item_id: 'i1' }],
    });
    const result = await readPlanScreen(client, 'a');
    expect(result.ok && result.data.commentCounts).toEqual({ i1: 2 });
    expect(log.filter((l) => l.table === 'plan_item_comments')).toHaveLength(1);
  });
});

function bundle(id: string): PlanBundle {
  return assembleBundles(
    [
      {
        id,
        workspace_id: 'ws',
        title: id,
        starts_on: '2026-10-12',
        ends_on: '2026-10-18',
        audience: 'client',
        created_by: null,
      },
    ],
    [],
    [],
    [],
  ).get(id) as PlanBundle;
}

describe('createPlanCardCache', () => {
  it('coalesces asks in one tick into one read; ids already read are never asked again', async () => {
    const reads: string[][] = [];
    const cache = createPlanCardCache(async (ids) => {
      reads.push(ids);
      return ok(new Map(ids.map((id) => [id, bundle(id)])));
    });
    cache.request(['a']);
    cache.request(['b', 'a']);
    await vi.waitFor(() => expect(cache.snapshot(['a', 'b']).loading).toBe(false));
    expect(reads).toEqual([['a', 'b']]);
    cache.request(['a', 'b']);
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    expect(cache.snapshot(['a']).bundles.get('a')?.plan.title).toBe('a');
  });

  it('an id absent under RLS settles as not available (no bundle, not loading)', async () => {
    const cache = createPlanCardCache(async () => ok(new Map()));
    cache.request(['x']);
    await vi.waitFor(() => expect(cache.snapshot(['x']).loading).toBe(false));
    expect(cache.snapshot(['x']).bundles.size).toBe(0);
    expect(cache.snapshot(['x']).failed).toEqual([]);
  });

  it('a failed read keeps loading, retries, then gives up after the tries', async () => {
    let n = 0;
    const cache = createPlanCardCache(
      async () => {
        n += 1;
        return err<Map<string, PlanBundle>>('down');
      },
      { retryDelayMs: 1 },
    );
    cache.request(['a']);
    await vi.waitFor(() => expect(cache.snapshot(['a']).failed).toEqual(['a']));
    expect(n).toBe(PLAN_READ_TRIES);
    cache.retry(['a']);
    expect(cache.snapshot(['a']).loading).toBe(true);
    cache.dispose();
  });

  it('refresh re-reads a known plan; a failed refresh keeps the card', async () => {
    let fail = false;
    let title = 'one';
    const cache = createPlanCardCache(async (ids) => {
      if (fail) return err<Map<string, PlanBundle>>('down');
      return ok(
        new Map(ids.map((id) => [id, { ...bundle(id), plan: { ...bundle(id).plan, title } }])),
      );
    });
    cache.request(['a']);
    await vi.waitFor(() => expect(cache.snapshot(['a']).bundles.get('a')?.plan.title).toBe('one'));
    title = 'two';
    cache.refresh(['a']);
    await vi.waitFor(() => expect(cache.snapshot(['a']).bundles.get('a')?.plan.title).toBe('two'));
    fail = true;
    const v = cache.version();
    cache.refresh(['a']);
    await vi.waitFor(() => expect(cache.version()).toBeGreaterThan(v));
    expect(cache.snapshot(['a']).bundles.get('a')?.plan.title).toBe('two');
  });
});

describe('sharePlanToChannel (Forward)', () => {
  const row = { id: 'm1', channel_id: 'c' } as unknown as ChatMessageRow;

  it('records with a fresh message id, then publishes live with the row ids', async () => {
    const publish = vi.fn(async () => ({}));
    const record = vi.fn(async () => ok(row));
    const result = await sharePlanToChannel(
      {
        guard: createInFlightGuard(),
        record,
        publish,
        newMessageId: () => 'fresh',
        newTraceId: () => 't',
        onPublishFailed: () => {},
      },
      { channelId: 'c', planId: 'plan1' },
    );
    expect(result.ok).toBe(true);
    expect(record).toHaveBeenCalledWith({
      id: 'fresh',
      channelId: 'c',
      planId: 'plan1',
      traceId: 't',
    });
    expect(publish).toHaveBeenCalledWith({ sorted_message_id: 'm1', sorted_channel_id: 'c' });
  });

  it('a record failure maps to copy and never publishes', async () => {
    const publish = vi.fn(async () => ({}));
    const result = await sharePlanToChannel(
      {
        guard: createInFlightGuard(),
        record: async () => err<ChatMessageRow>('plan not available'),
        publish,
        newMessageId: () => 'x',
        newTraceId: () => 't',
        onPublishFailed: () => {},
      },
      { channelId: 'c', planId: 'plan1' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'record', copy: PLAN_SHARE_FAILED });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('share epoch (F2)', () => {
  it('a share started before a close or reopen is no longer current', () => {
    const epoch = createShareEpoch();
    epoch.next(); // open
    const token = epoch.current();
    expect(epoch.isCurrent(token)).toBe(true);
    epoch.next(); // close
    epoch.next(); // reopen
    expect(epoch.isCurrent(token)).toBe(false);
    expect(epoch.isCurrent(epoch.current())).toBe(true);
  });
});

describe('readItemFiles (F5)', () => {
  it('filters plan_item attachments on entity and deleted_at is null', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'eq', 'is', 'order', 'abortSignal']) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: [
          { asset_version_id: 'v2', position: 1 },
          { asset_version_id: 'v1', position: 0 },
        ],
        error: null,
      }).then(resolve);
    const client = { from: () => q } as unknown as Client;
    const result = await readItemFiles(client, 'item1');
    expect(result.ok && result.data).toEqual(['v1', 'v2']);
    expect(calls).toContainEqual(['eq', ['entity_type', 'plan_item']]);
    expect(calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(calls).toContainEqual(['in', ['entity_id', ['item1']]]);
  });
});

describe('Forward into the open chat (G3)', () => {
  it('lands in the open thread only when the target is the open chat', () => {
    expect(forwardLandsInOpenChat('c1', 'c1')).toBe(true);
    expect(forwardLandsInOpenChat('c2', 'c1')).toBe(false);
    expect(forwardLandsInOpenChat('c1', null)).toBe(false);
  });

  it('with no separate publish (the thread adds and publishes), the row comes back for the thread', async () => {
    const row = { id: 'm9', channel_id: 'c1' } as unknown as ChatMessageRow;
    const result = await sharePlanToChannel(
      {
        guard: createInFlightGuard(),
        record: async () => ok(row),
        publish: null,
        newMessageId: () => 'm9',
        newTraceId: () => 't9',
        onPublishFailed: () => {},
      },
      { channelId: 'c1', planId: 'plan1' },
    );
    expect(result).toEqual({ ok: true, row, traceId: 't9' });
  });

  it('PlanCard wires it: no live publish here, then addRowHere with the row', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../components/chat/PlanCard.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('!here && connection !== null && target !== null');
    expect(src).toContain('if (here) planCards?.addRowHere(result.row, result.traceId);');
  });
});

// ---------------------------------------------------------------------------
// Date order (D2) and the concept date args (D4)
// ---------------------------------------------------------------------------

function row(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'C',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date: null,
    ...over,
  };
}

describe('plan items in date order', () => {
  const info = {
    pa: { title: 'A', target_date: '2026-10-13T09:00:00+00:00' },
    pb: { title: 'B', target_date: null },
    pc: { title: 'C', target_date: '2026-10-11' },
  };

  it('a concept takes its own date, a post its post date; unreadable or empty is undated', () => {
    expect(planItemDay(row({ id: 'c', target_date: '2026-10-12' }), info)).toBe('2026-10-12');
    expect(planItemDay(row({ id: 'p', kind: 'post', post_id: 'pa' }), info)).toBe('2026-10-13');
    expect(planItemDay(row({ id: 'p', kind: 'post', post_id: 'pb' }), info)).toBeNull();
    expect(planItemDay(row({ id: 'p', kind: 'post', post_id: 'gone' }), info)).toBeNull();
    expect(planItemDay(row({ id: 'c' }), info)).toBeNull();
  });

  it('mixed dated concepts and posts ascending, undated last', () => {
    const items = [
      row({ id: 'undatedConcept', position: 0 }),
      row({ id: 'post13', kind: 'post', post_id: 'pa', position: 1 }),
      row({ id: 'concept12', target_date: '2026-10-12', position: 2 }),
      row({ id: 'undatedPost', kind: 'post', post_id: 'pb', position: 3 }),
      row({ id: 'post11', kind: 'post', post_id: 'pc', position: 4 }),
      row({ id: 'concept20', target_date: '2026-10-20', position: 5 }),
    ];
    expect(sortPlanItemsByDate(items, info).map((i) => i.id)).toEqual([
      'post11',
      'concept12',
      'post13',
      'concept20',
      'undatedConcept',
      'undatedPost',
    ]);
  });

  it('ties keep position, then creation, and the sort never mutates its input', () => {
    const items = [
      row({ id: 'b', target_date: '2026-10-12', position: 2 }),
      row({ id: 'a2', target_date: '2026-10-12', position: 1, created_at: '2026-10-09T11:00:00Z' }),
      row({ id: 'a1', target_date: '2026-10-12', position: 1, created_at: '2026-10-09T10:00:00Z' }),
    ];
    const before = items.map((i) => i.id);
    expect(sortPlanItemsByDate(items, {}).map((i) => i.id)).toEqual(['a1', 'a2', 'b']);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('15+ items out of order come back by day, undated last in position order', () => {
    const days = [9, 3, 15, 1, 12, 7, 14, 2, 11, 5, 13, 4, 10, 8, 6];
    const items = days.map((d, k) =>
      row({ id: `i${d}`, position: k, target_date: `2026-10-${String(d).padStart(2, '0')}` }),
    );
    items.push(row({ id: 'u1', position: 15 }), row({ id: 'u0', position: 3 }));
    const sorted = sortPlanItemsByDate(items, {}).map((i) => i.id);
    expect(sorted).toEqual([...Array.from({ length: 15 }, (_, k) => `i${k + 1}`), 'u0', 'u1']);
  });

  it('all undated: the plan position order', () => {
    const items = [
      row({ id: 'c', position: 2 }),
      row({ id: 'a', position: 0 }),
      row({ id: 'b', position: 1 }),
    ];
    expect(sortPlanItemsByDate(items, {}).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('assembled bundles are already in date order (first paint, no reorder)', () => {
    const plans = [
      {
        id: 'plan',
        workspace_id: 'ws',
        title: 'T',
        starts_on: '2026-10-12',
        ends_on: '2026-10-18',
        audience: 'client' as const,
        created_by: null,
      },
    ];
    const items = [
      row({ id: 'late', target_date: '2026-10-18', position: 0 }),
      row({ id: 'none', position: 1 }),
      row({ id: 'post', kind: 'post', post_id: 'p1', position: 2 }),
    ];
    const out = assembleBundles(
      plans,
      items,
      [],
      [{ id: 'p1', stage: 'review', title: 'P', target_date: '2026-10-12' }],
    );
    expect(out.get('plan')?.items.map((i) => i.id)).toEqual(['post', 'late', 'none']);
  });

  it('the item read selects plan_items.target_date', async () => {
    const src = readFileSync(fileURLToPath(new URL('./plans.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/ITEM_COLUMNS =\s*'[^']*\btarget_date\b/);
  });
});

describe('concept date args', () => {
  const concept = { key: 'k', title: 'Reel', description: 'd', versionIds: ['v1'] };

  it('create with a date sends it', () => {
    expect(conceptAddArgs('plan', { ...concept, targetDate: '2026-10-14' }, 't')).toEqual({
      p_plan_id: 'plan',
      p_title: 'Reel',
      p_description: 'd',
      p_attachment_version_ids: ['v1'],
      p_target_date: '2026-10-14',
      p_trace_id: 't',
    });
  });

  it('create without a date leaves the key out (the column stays null)', () => {
    const args = conceptAddArgs('plan', { ...concept, targetDate: null }, 't');
    expect('p_target_date' in args).toBe(false);
  });

  const base = {
    title: 'Reel',
    description: '',
    targetDate: '2026-10-14',
    currentFiles: ['v1', 'v2'],
    pickedFiles: null,
  };

  it('date-only edit sends the new date and null files (links kept)', () => {
    expect(conceptEditArgs('i1', { ...base, targetDate: '2026-10-20' }, 't')).toEqual({
      p_item_id: 'i1',
      p_title: 'Reel',
      p_description: '',
      p_attachment_version_ids: null,
      p_target_date: '2026-10-20',
      p_trace_id: 't',
    });
    // Unread files and an untouched picker also keep the links.
    expect(
      conceptEditArgs('i1', { ...base, currentFiles: null }, 't').p_attachment_version_ids,
    ).toBeNull();
  });

  it('title-only edit sends null files', () => {
    const args = conceptEditArgs('i1', { ...base, title: 'Reel v2' }, 't');
    expect(args.p_title).toBe('Reel v2');
    expect(args.p_attachment_version_ids).toBeNull();
    // Files picked again in the same order are unchanged: still null.
    expect(
      conceptEditArgs('i1', { ...base, title: 'Reel v2', pickedFiles: ['v1', 'v2'] }, 't')
        .p_attachment_version_ids,
    ).toBeNull();
  });

  it('a file change (added, removed or reordered) sends the picked array', () => {
    const files = (picked: string[]) =>
      conceptEditArgs('i1', { ...base, pickedFiles: picked }, 't').p_attachment_version_ids;
    expect(files(['v1', 'v2', 'v3'])).toEqual(['v1', 'v2', 'v3']);
    expect(files(['v2'])).toEqual(['v2']);
    expect(files(['v2', 'v1'])).toEqual(['v2', 'v1']);
    expect(files([])).toEqual([]);
  });

  it('edit clear sends null (never leaves the key out)', () => {
    expect(conceptEditArgs('i1', { ...base, targetDate: null }, 't').p_target_date).toBeNull();
    expect(conceptEditArgs('i1', { ...base, targetDate: '' }, 't').p_target_date).toBeNull();
    expect('p_target_date' in conceptEditArgs('i1', { ...base, targetDate: null }, 't')).toBe(true);
  });

  it('edit keeps the date when unchanged (it is always sent)', () => {
    expect(conceptEditArgs('i1', base, 't').p_target_date).toBe('2026-10-14');
  });

  it('the run sends each draft concept with its own date', async () => {
    const seen: Array<string | null> = [];
    const d = deps({
      conceptAdd: async (_p, c) => {
        seen.push(c.targetDate);
        return { ok: true, data: c.key };
      },
    });
    await runPlanShare(d, DRAFT, initialShareProgress('m1'), 't');
    expect(seen).toEqual([null, '2026-10-14', null]);
  });
});
