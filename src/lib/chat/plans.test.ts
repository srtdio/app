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
  planItemDayInZone,
  mergeDraftRows,
  postPlansLine,
  readPlanBundles,
  bundleChunks,
  readPostPlans,
  readPostThumbs,
  runSlotWrite,
  readPlanScreen,
  runPlanShare,
  sameReadValue,
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

// A plan_bundle_read fake: by id it answers every asked plan except 'hidden'
// (RLS), each with one post item and one concept; every call is recorded.
function bundleRpc(over: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, ...args });
    const ids = (Array.isArray(args.p_plan_ids) ? args.p_plan_ids : []).filter(
      (id): id is string => typeof id === 'string' && id !== 'hidden',
    );
    return {
      data: {
        timezone: 'UTC',
        plans: ids.map((id) => ({
          id,
          workspace_id: 'ws',
          title: 'T',
          starts_on: '2026-10-12',
          ends_on: '2026-10-18',
          audience: 'client',
          created_by: null,
          updated_at: '2026-10-10T00:00:00Z',
        })),
        items: ids.flatMap((id) => [
          {
            id: `${id}-c`,
            plan_id: id,
            kind: 'concept',
            position: 1,
            title: 'C',
            description: null,
            post_id: null,
            created_at: '1',
            target_date: null,
          },
          {
            id: `${id}-p`,
            plan_id: id,
            kind: 'post',
            position: 0,
            title: null,
            description: null,
            post_id: `${id}-post`,
            created_at: '1',
            target_date: null,
          },
        ]),
        draft_rows: [],
        next_cursor: null,
        reviews: ids.map((id) => ({ item_id: `${id}-c`, side: 'client', status: 'approved' })),
        posts: ids.map((id) => ({
          id: `${id}-post`,
          stage: 'review',
          title: 'Post',
          format: 'image',
          target_date: '2026-10-13T12:00:00Z',
        })),
        comment_counts: Object.fromEntries(ids.map((id) => [`${id}-c`, 2])),
        thumbs: { posts: {}, concepts: {} },
        also_in: null,
        loose_posts: [],
        any_plan: ids.length > 0,
        last_sent_at: null,
        ...over,
      },
      error: null,
    };
  });
  const from = vi.fn(() => {
    throw new Error('no table reads');
  });
  return { client: { rpc, from } as unknown as Client, calls, rpc, from };
}

describe('plan reads (plan_bundle_read)', () => {
  it('readPlanBundles: one plan_bundle_read by id, no table read; a hidden plan is absent', async () => {
    const { client, calls, from } = bundleRpc();
    const result = await readPlanBundles(client, ['a', 'hidden', 'a'], undefined, 'UTC', 'ws');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.data.keys()]).toEqual(['a']);
    // Date order: the post (13 Oct) before the undated concept.
    expect(result.data.get('a')?.items.map((i) => i.id)).toEqual(['a-p', 'a-c']);
    expect(result.data.get('a')?.postStages).toEqual({ 'a-post': 'review' });
    expect(result.data.get('a')?.postInfo['a-post']).toEqual({
      title: 'Post',
      format: 'image',
      target_date: '2026-10-13T12:00:00Z',
    });
    expect(result.data.get('a')?.reviews).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'plan_bundle_read',
      p_workspace_id: 'ws',
      p_plan_ids: ['a', 'hidden'],
    });
    expect(typeof calls[0]?.p_trace_id).toBe('string');
    expect(calls[0]).not.toHaveProperty('_trace_id');
    expect(from).not.toHaveBeenCalled();
  });

  it('chunks the ids at 200 per call, all calls at once', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`);
    const { client, calls } = bundleRpc();
    const result = await readPlanBundles(client, ids, undefined, undefined, 'ws');
    expect(calls.map((c) => (c.p_plan_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(result.ok && result.data.size).toBe(450);
    expect(bundleChunks(ids).map((c) => c.length)).toEqual([200, 200, 50]);
    // The table reads elsewhere still chunk at 100.
    expect(planChunks(ids.slice(0, 250)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(PLAN_READ_CHUNK).toBe(100);
  });

  it('orders items in the bundle zone when no zone is given', async () => {
    // The post at 13 Oct 20:00 UTC is 14 Oct in Kolkata: after the 13 Oct concept there.
    const items = [
      {
        id: 'a-p',
        plan_id: 'a',
        kind: 'post',
        position: 0,
        title: null,
        description: null,
        post_id: 'a-post',
        created_at: '1',
        target_date: null,
      },
      {
        id: 'a-c',
        plan_id: 'a',
        kind: 'concept',
        position: 1,
        title: 'C',
        description: null,
        post_id: null,
        created_at: '1',
        target_date: '2026-10-13',
      },
    ];
    const posts = [{ id: 'a-post', stage: 'review', target_date: '2026-10-13T20:00:00Z' }];
    const kolkata = bundleRpc({ timezone: 'Asia/Kolkata', items, posts });
    const inZone = await readPlanBundles(kolkata.client, ['a'], undefined, undefined, 'ws');
    expect(inZone.ok && inZone.data.get('a')?.items.map((i) => i.id)).toEqual(['a-c', 'a-p']);
    // An explicit zone wins over the bundle's.
    const utc = await readPlanBundles(kolkata.client, ['a'], undefined, 'UTC', 'ws');
    expect(utc.ok && utc.data.get('a')?.items.map((i) => i.id)).toEqual(['a-p', 'a-c']);
  });

  it('a failed chunk fails the read; no workspace fails without a call', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'workspace_member_only' } }));
    const client = { rpc } as unknown as Client;
    const failed = await readPlanBundles(client, ['a'], undefined, undefined, 'ws');
    expect(!failed.ok && failed.error.code).toBe('workspace_member_only');
    rpc.mockClear();
    const none = await readPlanBundles(client, ['a']);
    expect(none.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect((await readPlanBundles(client, [], undefined, undefined, 'ws')).ok).toBe(true);
  });

  it('readPlanScreen: ONE call carries counts, tiles, Also in and the last send', async () => {
    const { client, calls } = bundleRpc({
      thumbs: {
        posts: { 'a-post': 'v-post' },
        concepts: { 'a-c': { kind: 'image', versionId: 'v-c' } },
      },
      also_in: { 'a-post': ['Launch'] },
      last_sent_at: '2026-10-11T09:00:00Z',
    });
    const result = await readPlanScreen(client, 'a', undefined, {
      workspaceId: 'ws',
      sentInChannelId: 'dm__ws__a__b',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'plan_bundle_read',
      p_workspace_id: 'ws',
      p_plan_ids: ['a'],
      p_channel_id: 'dm__ws__a__b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.commentCounts).toEqual({ 'a-c': 2 });
    expect(result.data.thumbs).toEqual({ 'a-post': 'v-post' });
    expect(result.data.conceptThumbs).toEqual({ 'a-c': { kind: 'image', versionId: 'v-c' } });
    expect(result.data.alsoIn).toEqual({ 'a-post': ['Launch'] });
    expect(result.data.lastSentAt).toBe('2026-10-11T09:00:00Z');
    expect(result.data.lastChangedAt).toBe('2026-10-10T00:00:00Z');
  });

  it('readPlanScreen outside a chat sends no p_channel_id; lastSentAt is null', async () => {
    const { client, calls } = bundleRpc();
    const result = await readPlanScreen(client, 'a', undefined, { workspaceId: 'ws' });
    expect(calls[0]).not.toHaveProperty('p_channel_id');
    expect(result.ok && result.data.lastSentAt).toBeNull();
  });

  it('readPlanScreen: a hidden plan is not available (bundle null), no name read', async () => {
    const { client } = bundleRpc();
    const readNames = vi.fn(async () => ({ ok: true as const, data: [] }));
    const result = await readPlanScreen(client, 'hidden', undefined, {
      workspaceId: 'ws',
      readNames,
      approvers: () => ['u1'],
    });
    expect(result.ok && result.data.bundle).toBeNull();
    expect(readNames).not.toHaveBeenCalled();
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
    let reads = 0;
    const cache = createPlanCardCache(async (ids) => {
      reads += 1;
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
    const shown = cache.snapshot(['a']).bundles.get('a');
    const v = cache.version();
    cache.refresh(['a']);
    await vi.waitFor(() => expect(reads).toBe(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.version()).toBe(v);
    expect(cache.snapshot(['a']).loading).toBe(false);
    expect(cache.snapshot(['a']).bundles.get('a')).toBe(shown);
  });

  it('a background re-read with identical data changes nothing and notifies nobody', async () => {
    let reads = 0;
    const cache = createPlanCardCache(async (ids) => {
      reads += 1;
      // A fresh read: new objects every time, same data.
      return ok(new Map(ids.map((id) => [id, bundle(id)])));
    });
    cache.request(['a']);
    await vi.waitFor(() => expect(cache.snapshot(['a']).loading).toBe(false));
    const shown = cache.snapshot(['a']).bundles.get('a');
    const v = cache.version();
    const heard = vi.fn();
    cache.subscribe(heard);
    cache.refresh(['a']);
    await vi.waitFor(() => expect(reads).toBe(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).not.toHaveBeenCalled();
    expect(cache.version()).toBe(v);
    expect(cache.snapshot(['a']).bundles.get('a')).toBe(shown);
    cache.dispose();
  });

  it('a background re-read with changed data updates in place, never through loading', async () => {
    let posts = 5;
    const read = (id: string): PlanBundle => {
      const b = bundle(id);
      const items = Array.from({ length: posts }, (_, n) => ({
        id: `${id}-i${n}`,
        plan_id: id,
        kind: 'post' as const,
        position: n,
        title: null,
        description: null,
        post_id: null,
        created_at: '2026-10-09T09:00:00Z',
      }));
      return { ...b, items };
    };
    const cache = createPlanCardCache(async (ids) => ok(new Map(ids.map((id) => [id, read(id)]))));
    cache.request(['a']);
    await vi.waitFor(() => expect(cache.snapshot(['a']).loading).toBe(false));
    const seen: Array<{ loading: boolean; items: number | undefined }> = [];
    cache.subscribe(() => {
      const snap = cache.snapshot(['a']);
      seen.push({ loading: snap.loading, items: snap.bundles.get('a')?.items.length });
    });
    posts = 6;
    cache.refresh(['a']);
    expect(cache.snapshot(['a']).loading).toBe(false);
    await vi.waitFor(() => expect(cache.snapshot(['a']).bundles.get('a')?.items).toHaveLength(6));
    expect(seen).toEqual([{ loading: false, items: 6 }]);
    cache.dispose();
  });

  it('retry on an id that has not failed notifies nobody', () => {
    const cache = createPlanCardCache(async () => ok(new Map()));
    const heard = vi.fn();
    cache.subscribe(heard);
    cache.retry(['never-asked']);
    expect(heard).not.toHaveBeenCalled();
    cache.dispose();
  });
});

describe('sameReadValue', () => {
  it('compares plain read data structurally', () => {
    expect(sameReadValue(bundle('a'), bundle('a'))).toBe(true);
    expect(sameReadValue(bundle('a'), bundle('b'))).toBe(false);
    expect(sameReadValue({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameReadValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameReadValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameReadValue([], {})).toBe(false);
    expect(sameReadValue(null, {})).toBe(false);
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
    expect(src).toContain('planCards.addRowHere(row, traceId);');
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
    pc: { title: 'C', target_date: '2026-10-11T12:00:00+00:00' },
  };

  it("a concept takes plan_items.target_date; a post slot its post's target_date (item 8)", () => {
    expect(planItemDay(row({ id: 'c', target_date: '2026-10-12' }), info)).toBe('2026-10-12');
    // pa's post date is 13 Oct: a stale plan_items.target_date (15 Oct) never places it.
    expect(
      planItemDay(row({ id: 'p', kind: 'post', post_id: 'pa', target_date: '2026-10-15' }), info),
    ).toBe('2026-10-13');
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
      // A stale plan_items.target_date never places a post slot.
      row({ id: 'post', kind: 'post', post_id: 'p1', position: 2, target_date: '2026-10-19' }),
      row({ id: 'post2', kind: 'post', post_id: 'p2', position: 3 }),
    ];
    const out = assembleBundles(
      plans,
      items,
      [],
      [
        // 12:00 Asia/Kolkata on 12 and 17 Oct: read in the workspace zone.
        { id: 'p1', stage: 'review', title: 'P', target_date: '2026-10-12T06:30:00+00:00' },
        { id: 'p2', stage: 'review', title: 'Q', target_date: '2026-10-17T06:30:00+00:00' },
      ],
      'Asia/Kolkata',
    );
    expect(out.get('plan')?.items.map((i) => i.id)).toEqual(['post', 'post2', 'late', 'none']);
    expect(out.get('plan')?.postInfo.p1?.target_date).toBe('2026-10-12T06:30:00+00:00');
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

describe("a post's live plans (W10)", () => {
  function query(result: { data: unknown; error: { message: string } | null }, delayMs = 0) {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'abortSignal']) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown) =>
      new Promise((r) => setTimeout(() => r(result), delayMs)).then(resolve);
    const from = vi.fn(() => q);
    return { client: { from } as unknown as Client, calls, from };
  }

  it('one select: live items of the post joined to live plans, one row per plan', async () => {
    const { client, calls, from } = query({
      data: [
        { plan_id: 'a', plans: { title: 'Week 42' } },
        { plan_id: 'a', plans: { title: 'Week 42' } },
        { plan_id: 'b', plans: [{ title: 'Diwali' }] },
      ],
      error: null,
    });
    const result = await readPostPlans(client, 'post1');
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('plan_items');
    expect(calls).toContainEqual(['select', ['plan_id, plans!inner(title)']]);
    expect(calls).toContainEqual(['eq', ['post_id', 'post1']]);
    expect(calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(calls).toContainEqual(['is', ['plans.deleted_at', null]]);
    expect(result).toEqual({
      ok: true,
      data: [
        { planId: 'a', title: 'Week 42' },
        { planId: 'b', title: 'Diwali' },
      ],
    });
  });

  it('an error or the 5s cap is a failure', async () => {
    expect(
      (await readPostPlans(query({ data: null, error: { message: 'x' } }).client, 'p')).ok,
    ).toBe(false);
    vi.useFakeTimers();
    try {
      const pending = readPostPlans(query({ data: [], error: null }, 60_000).client, 'p');
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the confirm line: none, one plan, two or more', () => {
    expect(postPlansLine([])).toBeNull();
    expect(postPlansLine([{ planId: 'a', title: 'Week 42' }])).toBe(
      "It's in Week 42 and will leave that plan.",
    );
    expect(
      postPlansLine([
        { planId: 'a', title: 'Week 42' },
        { planId: 'b', title: 'B' },
        { planId: 'c', title: 'C' },
      ]),
    ).toBe("It's in Week 42 and 2 other plans and will leave them.");
  });
});

describe('slot write (W4)', () => {
  it('applies at once, keeps it on success', async () => {
    const applied: string[] = [];
    const result = await runSlotWrite({
      status: 'approved',
      previous: 'waiting',
      apply: (s) => applied.push(s),
      write: () => Promise.resolve({ ok: true, data: null }),
    });
    expect(result.ok).toBe(true);
    expect(applied).toEqual(['approved']);
  });

  it('reverts to the previous status on failure or a throw', async () => {
    const applied: string[] = [];
    const failed = await runSlotWrite({
      status: 'approved',
      previous: 'changes',
      apply: (s) => applied.push(s),
      write: () =>
        Promise.resolve({ ok: false, error: { code: 'unknown', message: 'post_not_ready' } }),
    });
    expect(failed.ok).toBe(false);
    expect(applied).toEqual(['approved', 'changes']);
    const thrown = await runSlotWrite({
      status: 'waiting',
      previous: 'approved',
      apply: (s) => applied.push(s),
      write: () => Promise.reject(new Error('boom')),
    });
    expect(thrown.ok).toBe(false);
    expect(applied.slice(2)).toEqual(['waiting', 'approved']);
  });

  it('day in the workspace zone: a concept date as is, a post instant read in the zone', () => {
    const concept = {
      id: 'c',
      plan_id: 'p',
      kind: 'concept' as const,
      position: 0,
      title: 'C',
      description: null,
      post_id: null,
      created_at: '',
      target_date: '2026-10-14',
    };
    const post = { ...concept, id: 'p1', kind: 'post' as const, post_id: 'x', target_date: null };
    const info = { x: { title: 'X', target_date: '2026-10-13T20:00:00+00:00' } };
    expect(planItemDayInZone(concept, info, 'Asia/Kolkata')).toBe('2026-10-14');
    // A post slot: its post's instant read in the zone (20:00 UTC is 14 Oct in Kolkata).
    expect(planItemDayInZone(post, info, 'Asia/Kolkata')).toBe('2026-10-14');
    expect(planItemDayInZone(post, info, 'UTC')).toBe('2026-10-13');
    // plan_items.target_date on a post slot is never read.
    expect(planItemDayInZone({ ...post, target_date: '2026-10-16' }, info, 'UTC')).toBe(
      '2026-10-13',
    );
  });

  it("a client's draft row: the post's target_date read in the zone, never sliced (item 8)", () => {
    // plan_draft_rows returns p.target_date (12:00 in the workspace zone).
    const [row] = mergeDraftRows(
      [],
      [
        {
          plan_id: 'p',
          item_id: 'd1',
          item_position: 0,
          post_number: 7,
          title: 'Teaser',
          // 12:00 on 15 Oct in Pacific/Auckland (UTC+13) is 23:00 UTC on 14 Oct.
          target_date: '2026-10-14T23:00:00+00:00',
        },
      ],
    );
    expect(row?.target_date).toBe('2026-10-14T23:00:00+00:00');
    expect(planItemDayInZone(row!, {}, 'Pacific/Auckland')).toBe('2026-10-15');
    // Slicing the string would have said 14 Oct.
    expect(planItemDayInZone(row!, {}, 'UTC')).toBe('2026-10-14');
  });
});

describe('row thumbnails (L2)', () => {
  it('one select per chunk; the first live image per post wins; non-images skipped', async () => {
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
          {
            entity_id: 'a',
            entity_type: 'post',
            asset_version_id: 'v-video',
            asset_versions: { mime_type: 'video/mp4' },
          },
          {
            entity_id: 'a',
            entity_type: 'post',
            asset_version_id: 'v-a1',
            asset_versions: { mime_type: 'image/png' },
          },
          {
            entity_id: 'a',
            entity_type: 'post',
            asset_version_id: 'v-a2',
            asset_versions: { mime_type: 'image/png' },
          },
          {
            entity_id: 'b',
            entity_type: 'post',
            asset_version_id: 'v-b',
            asset_versions: [{ mime_type: 'image/jpeg' }],
          },
        ],
        error: null,
      }).then(resolve);
    const from = vi.fn(() => q);
    const result = await readPostThumbs({ from } as unknown as Client, ['a', 'b', 'c']);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('asset_attachments');
    // One read covers post images and concept tiles (entity_type in both).
    expect(calls).toContainEqual(['in', ['entity_type', ['post', 'plan_item']]]);
    expect(calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(result).toEqual({ ok: true, data: { a: 'v-a1', b: 'v-b' } });
    expect((await readPostThumbs({ from } as unknown as Client, [])).ok).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
  });
});
