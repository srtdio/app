import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  activityLine,
  bucketActorNames,
  cardBodyLine,
  cardTitle,
  entityHref,
  entityKey,
  fetchActivityEntries,
  filterByScope,
  filterByState,
  groupDigest,
  isSnoozed,
  mapEntry,
  payloadNum,
  payloadStr,
  relativeTime,
  resolveBodyMentions,
  shortLine,
  unreadCount,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { EX_MEMBER_LABEL } from '@/components/comments/commentProfiles';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

function row(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'comment',
    entity_type: 'post',
    entity_id: 'p1',
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-06-14T00:00:00.000Z',
    ...over,
  };
}

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T00:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: null,
    assetId: null,
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    number: null,
    pointsAdded: null,
    checkpointTotal: null,
    batchId: null,
    ...over,
  };
}

describe('payloadStr', () => {
  it('reads a string field', () => {
    expect(payloadStr({ a: 'x' }, 'a')).toBe('x');
  });
  it('returns null for missing, non-string, null, or non-object', () => {
    expect(payloadStr({ a: 1 }, 'a')).toBeNull();
    expect(payloadStr({}, 'a')).toBeNull();
    expect(payloadStr(null, 'a')).toBeNull();
    expect(payloadStr('nope', 'a')).toBeNull();
    expect(payloadStr({ a: null }, 'a')).toBeNull();
  });
});

describe('mapEntry', () => {
  it('reads every payload field with the typed reader', () => {
    const mapped = mapEntry(
      row({
        event_type: 'brief_created',
        entity_type: 'brief',
        payload: {
          comment_id: 'c1',
          asset_id: 'a1',
          to_stage: 'review',
          from_stage: 'draft',
          title: 'Launch brief',
          created_by: 'user-a',
        },
      }),
    );
    expect(mapped.commentId).toBe('c1');
    expect(mapped.assetId).toBe('a1');
    expect(mapped.toStage).toBe('review');
    expect(mapped.fromStage).toBe('draft');
    expect(mapped.title).toBe('Launch brief');
    expect(mapped.actorId).toBe('user-a');
    expect(mapped.actorName).toBeNull();
  });

  it('falls back to to / from short keys for stages', () => {
    const mapped = mapEntry(row({ payload: { to: 'approved', from: 'review' } }));
    expect(mapped.toStage).toBe('approved');
    expect(mapped.fromStage).toBe('review');
  });

  it('uses invited_by as the actor when created_by is absent', () => {
    const mapped = mapEntry(row({ event_type: 'invite', payload: { invited_by: 'inviter' } }));
    expect(mapped.actorId).toBe('inviter');
  });

  it('never throws on a malformed payload', () => {
    const mapped = mapEntry(
      row({
        payload: 42 as unknown as Database['public']['Tables']['inbox_entries']['Row']['payload'],
      }),
    );
    expect(mapped.title).toBeNull();
    expect(mapped.actorId).toBeNull();
  });
});

describe('activityLine null-safe rendering', () => {
  it('drops a missing actor name per event type', () => {
    expect(activityLine(item({ eventType: 'comment', actorName: null }))).toBe(
      'New comment on a post',
    );
    expect(activityLine(item({ eventType: 'mention', actorName: null }))).toBe(
      'New mention in a post',
    );
    expect(activityLine(item({ eventType: 'comment_resolved', actorName: null }))).toBe(
      'A comment thread was resolved on a post',
    );
    expect(activityLine(item({ eventType: 'comment_resolved', actorName: 'Ada' }))).toBe(
      'Ada resolved a thread on a post',
    );
    expect(activityLine(item({ eventType: 'stage_change', toStage: 'approved' }))).toBe(
      'Moved to approved',
    );
  });

  it('falls back to a brief / Activity when there is no title', () => {
    expect(activityLine(item({ eventType: 'comment', entityType: 'brief' }))).toBe(
      'New comment on a brief',
    );
    expect(activityLine(item({ eventType: 'comment', entityType: null }))).toBe(
      'New comment on Activity',
    );
  });

  it('uses the actor name and title when present', () => {
    expect(activityLine(item({ eventType: 'comment', actorName: 'Alice', title: 'Q3 post' }))).toBe(
      'Alice commented on Q3 post',
    );
    expect(
      activityLine(
        item({
          eventType: 'brief_created',
          actorName: 'Bo',
          entityType: 'brief',
          title: 'Brief X',
        }),
      ),
    ).toBe('Bo created Brief X');
  });

  it('never prints undefined or null', () => {
    for (const type of ['comment', 'mention', 'stage_change', 'brief_created', 'invite']) {
      const line = activityLine(item({ eventType: type }));
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('null');
    }
  });
});

describe('cardTitle', () => {
  it('uses the entity title when present', () => {
    expect(cardTitle(item({ entityType: 'post', title: 'Q3 post' }))).toBe('Q3 post');
  });
  it('falls back to a generic entity label for a post/brief without a title', () => {
    expect(cardTitle(item({ entityType: 'post', title: null }))).toBe('Untitled post');
    expect(cardTitle(item({ entityType: 'brief', title: null }))).toBe('Untitled brief');
  });
  it('falls back to the full activity line for a non-entity event', () => {
    expect(cardTitle(item({ eventType: 'invite', entityType: null, actorName: 'Bo' }))).toBe(
      'Bo invited a new member',
    );
  });
});

describe('shortLine', () => {
  it('drops the entity title and actor, leaving the event only', () => {
    expect(shortLine(item({ eventType: 'comment', actorName: 'Alice', title: 'Q3' }))).toBe(
      'New comment',
    );
    expect(shortLine(item({ eventType: 'mention', title: 'Q3' }))).toBe('New mention');
    expect(shortLine(item({ eventType: 'stage_change', toStage: 'approved' }))).toBe(
      'Moved to approved',
    );
    expect(shortLine(item({ eventType: 'brief_closed' }))).toBe('Brief closed');
  });
  it('never prints undefined or null', () => {
    for (const type of ['comment', 'mention', 'stage_change', 'brief_created', 'invite']) {
      const line = shortLine(item({ eventType: type }));
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('null');
    }
  });
});

describe('payloadNum', () => {
  it('reads a finite-number field, null otherwise', () => {
    expect(payloadNum({ count: 3 }, 'count')).toBe(3);
    expect(payloadNum({ count: 0 }, 'count')).toBe(0);
    expect(payloadNum({ count: '3' }, 'count')).toBeNull();
    expect(payloadNum({ count: Number.NaN }, 'count')).toBeNull();
    expect(payloadNum({}, 'count')).toBeNull();
    expect(payloadNum(null, 'count')).toBeNull();
  });
});

describe('feedback ledger event lines (checkpoints_added / post_ready)', () => {
  it('renders the points count with singular / plural, falling back when absent', () => {
    expect(
      activityLine(item({ eventType: 'checkpoints_added', title: 'Q3 post', pointsAdded: 3 })),
    ).toBe('3 points sent on Q3 post');
    expect(
      activityLine(item({ eventType: 'checkpoints_added', title: 'Q3 post', pointsAdded: 1 })),
    ).toBe('1 point sent on Q3 post');
    expect(
      activityLine(item({ eventType: 'checkpoints_added', title: null, pointsAdded: null })),
    ).toBe('Points sent on a post');
    expect(shortLine(item({ eventType: 'checkpoints_added', pointsAdded: 2 }))).toBe(
      '2 points sent',
    );
    expect(shortLine(item({ eventType: 'checkpoints_added', pointsAdded: null }))).toBe(
      'Points sent',
    );
  });

  it('renders the ready ping line', () => {
    expect(activityLine(item({ eventType: 'post_ready', title: 'Q3 post' }))).toBe(
      'Q3 post is ready for review',
    );
    expect(activityLine(item({ eventType: 'post_ready', title: null }))).toBe(
      'a post is ready for review',
    );
    expect(shortLine(item({ eventType: 'post_ready' }))).toBe('Ready for review');
  });

  it('never prints undefined or null', () => {
    for (const type of ['checkpoints_added', 'post_ready']) {
      const line = activityLine(item({ eventType: type }));
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('null');
    }
  });
});

describe('mapEntry ledger counts', () => {
  it('reads checkpoints_added count and post_ready checkpoints as numbers', () => {
    const added = mapEntry(
      row({
        event_type: 'checkpoints_added',
        payload: { batch_id: 'b1', count: 4, seqs: [1, 2, 3, 4] },
      }),
    );
    expect(added.pointsAdded).toBe(4);
    expect(added.batchId).toBe('b1');
    expect(added.checkpointTotal).toBeNull();
    const ready = mapEntry(row({ event_type: 'post_ready', payload: { checkpoints: 7 } }));
    expect(ready.checkpointTotal).toBe(7);
    expect(ready.pointsAdded).toBeNull();
  });
});

describe('cardBodyLine', () => {
  it('uses the real comment body, trimmed to ~140 chars, for a comment event', () => {
    const short = cardBodyLine(item({ eventType: 'comment', body: '  Looks great, ship it!  ' }));
    expect(short).toBe('Looks great, ship it!');

    const long = 'x'.repeat(200);
    const trimmed = cardBodyLine(item({ eventType: 'comment', body: long }));
    expect(trimmed.length).toBeLessThanOrEqual(141); // 140 chars + an ellipsis
    expect(trimmed.endsWith('…')).toBe(true);
  });

  it('keeps the generic label for a non-comment event even when a body is set', () => {
    expect(
      cardBodyLine(item({ eventType: 'stage_change', toStage: 'approved', body: 'ignored' })),
    ).toBe('Moved to approved');
    expect(cardBodyLine(item({ eventType: 'mention', body: 'still generic' }))).toBe('New mention');
  });

  it('falls back to the generic label when a comment body is null or empty', () => {
    expect(cardBodyLine(item({ eventType: 'comment', body: null }))).toBe('New comment');
    expect(cardBodyLine(item({ eventType: 'comment', body: '   ' }))).toBe('New comment');
  });
});

describe('resolveBodyMentions', () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  const names: Record<string, string> = { [id1]: 'Alice', [id2]: 'Bo' };
  const nameOf = (id: string): string | null => names[id] ?? null;

  it('resolves a single @[uuid] token to @Name', () => {
    expect(resolveBodyMentions(`hey @[${id1}] welcome`, nameOf)).toBe('hey @Alice welcome');
  });

  it('renders @(ex-member) when nameOf returns null', () => {
    expect(resolveBodyMentions(`@[${id2}] ping`, () => null)).toBe(`@${EX_MEMBER_LABEL} ping`);
  });

  it('resolves multiple tokens and preserves surrounding text verbatim', () => {
    expect(resolveBodyMentions(`cc @[${id1}] and @[${id2}] — done`, nameOf)).toBe(
      'cc @Alice and @Bo — done',
    );
  });

  it('returns a body with no tokens unchanged', () => {
    expect(resolveBodyMentions('plain text, no mentions', nameOf)).toBe('plain text, no mentions');
  });
});

describe('entityHref', () => {
  it('routes posts and briefs, nothing else', () => {
    expect(entityHref(item({ entityType: 'post', entityId: 'p9' }))).toBe('/posts/p9');
    expect(entityHref(item({ entityType: 'brief', entityId: 'b9' }))).toBe('/briefs/b9');
    expect(entityHref(item({ entityType: 'workspace', entityId: 'w9' }))).toBeNull();
    expect(entityHref(item({ entityType: 'post', entityId: null }))).toBeNull();
  });

  it('deep-links a post/brief comment to its exact comment via ?comment=', () => {
    expect(
      entityHref(
        item({ eventType: 'comment', entityType: 'post', entityId: 'p9', commentId: 'c3' }),
      ),
    ).toBe('/posts/p9?comment=c3');
    expect(entityHref(item({ entityType: 'post', entityId: 'p9', commentId: null }))).toBe(
      '/posts/p9',
    );
    expect(
      entityHref(
        item({ eventType: 'comment', entityType: 'brief', entityId: 'b9', commentId: 'c4' }),
      ),
    ).toBe('/briefs/b9?comment=c4');
    expect(entityHref(item({ entityType: 'brief', entityId: 'b9', commentId: null }))).toBe(
      '/briefs/b9',
    );
  });

  it('deep-links asset events to the lightbox via ?asset=, ignoring the entity', () => {
    expect(
      entityHref(
        item({ eventType: 'asset_uploaded', entityType: null, entityId: null, assetId: 'a7' }),
      ),
    ).toBe('/assets?asset=a7');
    expect(
      entityHref(
        item({ eventType: 'asset_version_added', entityType: null, entityId: null, assetId: 'a8' }),
      ),
    ).toBe('/assets?asset=a8');
    expect(
      entityHref(
        item({ eventType: 'asset_uploaded', entityType: null, entityId: null, assetId: null }),
      ),
    ).toBeNull();
    expect(
      entityHref(item({ eventType: 'stage_change', entityType: null, entityId: null })),
    ).toBeNull();
  });
});

describe('snooze + state filtering', () => {
  const now = Date.parse('2026-06-14T12:00:00.000Z');
  const future = '2026-06-14T18:00:00.000Z';
  const past = '2026-06-14T06:00:00.000Z';

  it('isSnoozed only when snoozed_until is in the future', () => {
    expect(isSnoozed(item({ snoozedUntil: future }), now)).toBe(true);
    expect(isSnoozed(item({ snoozedUntil: past }), now)).toBe(false);
    expect(isSnoozed(item({ snoozedUntil: null }), now)).toBe(false);
  });

  it('All hides snoozed, Unread is unread + not snoozed, Snoozed is only snoozed', () => {
    const unread = item({ id: 'a', readAt: null });
    const read = item({ id: 'b', readAt: past });
    const snoozed = item({ id: 'c', readAt: null, snoozedUntil: future });
    const all = [unread, read, snoozed];
    expect(filterByState(all, 'all', now).map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterByState(all, 'unread', now).map((i) => i.id)).toEqual(['a']);
    expect(filterByState(all, 'snoozed', now).map((i) => i.id)).toEqual(['c']);
  });

  it('unreadCount ignores read and snoozed rows', () => {
    const all = [
      item({ id: 'a', readAt: null }),
      item({ id: 'b', readAt: past }),
      item({ id: 'c', readAt: null, snoozedUntil: future }),
    ];
    expect(unreadCount(all, now)).toBe(1);
  });
});

describe('filterByScope', () => {
  it('everything passes all; a specific scope filters', () => {
    const all = [item({ id: 'a', scope: 'posts' }), item({ id: 'b', scope: 'briefs' })];
    expect(filterByScope(all, 'everything')).toHaveLength(2);
    expect(filterByScope(all, 'briefs').map((i) => i.id)).toEqual(['b']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-06-14T12:00:00.000Z');
  it('buckets elapsed time', () => {
    expect(relativeTime('2026-06-14T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-06-14T11:30:00.000Z', now)).toBe('30m');
    expect(relativeTime('2026-06-14T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-06-12T12:00:00.000Z', now)).toBe('2d');
  });
  it('collapses future / unparseable to just now / empty', () => {
    expect(relativeTime('2026-06-14T13:00:00.000Z', now)).toBe('just now');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('groupDigest', () => {
  const dayMs = 86_400_000;
  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const todayTs = new Date(startOfToday + 6 * 3_600_000).toISOString();
  const yesterdayTs = new Date(startOfToday - 6 * 3_600_000).toISOString();
  const olderTs = new Date(startOfToday - 3 * dayMs).toISOString();

  // Solo entries (no shared entity) so each is its own group and the bucket /
  // entry ordering is observed directly through the flattened groups.
  const items = [
    item({ id: 'today-a', entityType: null, entityId: null, createdAt: todayTs }),
    item({ id: 'yest', entityType: null, entityId: null, createdAt: yesterdayTs }),
    item({ id: 'old', entityType: null, entityId: null, createdAt: olderTs }),
    item({
      id: 'today-b',
      entityType: null,
      entityId: null,
      createdAt: new Date(startOfToday + 8 * 3_600_000).toISOString(),
    }),
  ];

  it('newest: Today -> Yesterday -> Earlier, newest entry first', () => {
    const buckets = groupDigest(items, 'newest');
    expect(buckets.map((b) => b.key)).toEqual(['today', 'yesterday', 'earlier']);
    expect(buckets[0]?.groups.flat().map((i) => i.id)).toEqual(['today-b', 'today-a']);
  });

  it('oldest reverses both bucket and entry order', () => {
    const buckets = groupDigest(items, 'oldest');
    expect(buckets.map((b) => b.key)).toEqual(['earlier', 'yesterday', 'today']);
    expect(buckets[2]?.groups.flat().map((i) => i.id)).toEqual(['today-a', 'today-b']);
  });

  it('drops empty buckets', () => {
    const buckets = groupDigest([item({ createdAt: todayTs })], 'newest');
    expect(buckets.map((b) => b.key)).toEqual(['today']);
  });

  it('threads entries that share a post/brief entity and leaves the rest solo', () => {
    const a = item({ id: 'a', entityType: 'post', entityId: 'p1', createdAt: todayTs });
    const b = item({
      id: 'b',
      entityType: 'post',
      entityId: 'p1',
      createdAt: new Date(startOfToday + 9 * 3_600_000).toISOString(),
    });
    const c = item({
      id: 'c',
      entityType: 'brief',
      entityId: 'x9',
      createdAt: new Date(startOfToday + 7 * 3_600_000).toISOString(),
    });
    const buckets = groupDigest([a, b, c], 'newest');
    expect(buckets[0]?.groups.map((g) => g.map((i) => i.id))).toEqual([['b', 'a'], ['c']]);
  });
});

describe('entityKey', () => {
  it('threads by entity for post/brief and stays solo otherwise', () => {
    expect(entityKey(item({ entityType: 'post', entityId: 'p1' }))).toBe('post:p1');
    expect(entityKey(item({ entityType: 'brief', entityId: 'b2' }))).toBe('brief:b2');
    expect(entityKey(item({ id: 'z', entityType: 'post', entityId: null }))).toBe('solo:z');
    expect(entityKey(item({ id: 'q', entityType: null, entityId: null }))).toBe('solo:q');
  });
});

describe('bucketActorNames', () => {
  it('returns distinct non-null names in order', () => {
    const names = bucketActorNames([
      item({ actorName: 'Alice' }),
      item({ actorName: null }),
      item({ actorName: 'Bo' }),
      item({ actorName: 'Alice' }),
    ]);
    expect(names).toEqual(['Alice', 'Bo']);
  });
});

// A hand-rolled PostgREST-ish fake: every builder method returns the same
// chainable, which resolves (it is a thenable) to the canned result for its
// table. No network, no Supabase. Covers from/select/eq/is/order/limit/lt for the
// inbox read and from/select/in for the enrichment joins.
describe('fetchActivityEntries enrichment', () => {
  type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
  type FakeClient = Parameters<typeof fetchActivityEntries>[0];

  interface FakeBuilder extends PromiseLike<QueryResult> {
    select(cols?: string): FakeBuilder;
    eq(col: string, val: unknown): FakeBuilder;
    is(col: string, val: unknown): FakeBuilder;
    order(col: string, opts?: unknown): FakeBuilder;
    limit(n: number): FakeBuilder;
    lt(col: string, val: unknown): FakeBuilder;
    like(col: string, pattern: string): FakeBuilder;
    in(col: string, vals: readonly unknown[]): FakeBuilder;
  }

  function builder(result: QueryResult): FakeBuilder {
    const self: FakeBuilder = {
      select: () => self,
      eq: () => self,
      is: () => self,
      order: () => self,
      limit: () => self,
      lt: () => self,
      like: () => self,
      in: () => self,
      then(onfulfilled, onrejected) {
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return self;
  }

  function fakeClient(tables: Record<string, QueryResult>): FakeClient {
    const client = {
      from(table: string): FakeBuilder {
        return builder(tables[table] ?? { data: [], error: null });
      },
    };
    return client as unknown as FakeClient;
  }

  const ok = (data: Record<string, unknown>[]): QueryResult => ({ data, error: null });
  const err = (message: string): QueryResult => ({ data: null, error: { message } });

  const inboxRow = (over: Partial<InboxEntryRow>): Record<string, unknown> =>
    row(over) as unknown as Record<string, unknown>;

  it('resolves a comment actorName via comments -> users and the title via posts', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-comment',
          event_type: 'comment',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { comment_id: 'c1' },
        }),
      ]),
      comments: ok([{ id: 'c1', author_user_id: 'u-alice' }]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
      users: ok([{ id: 'u-alice', display_name: 'Alice', avatar_url: null }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.actorName).toBe('Alice');
      expect(res.data[0]?.title).toBe('Q3 Launch');
    }
  });

  it('maps the comment body, post format and actor avatar onto the item', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-comment',
          event_type: 'comment',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { comment_id: 'c1' },
        }),
      ]),
      comments: ok([{ id: 'c1', author_user_id: 'u-alice', body: 'Looks great, ship it!' }]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch', format: 'carousel' }]),
      users: ok([{ id: 'u-alice', display_name: 'Alice', avatar_url: 'https://cdn/x.png' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.body).toBe('Looks great, ship it!');
      expect(res.data[0]?.format).toBe('carousel');
      expect(res.data[0]?.actorAvatarUrl).toBe('https://cdn/x.png');
      expect(cardBodyLine(res.data[0] ?? item({}))).toBe('Looks great, ship it!');
    }
  });

  it('maps the post caption and the first-image asset_version_id onto a post item', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-post',
          event_type: 'stage_change',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { to: 'approved' },
        }),
      ]),
      posts: ok([
        { id: 'p1', title: 'Q3 Launch', format: 'single_image', caption: 'Ship day copy' },
      ]),
      asset_attachments: ok([
        { entity_id: 'p1', asset_version_id: 'av-9', asset_versions: { mime_type: 'image/png' } },
      ]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.caption).toBe('Ship day copy');
      expect(res.data[0]?.thumbnailAssetVersionId).toBe('av-9');
    }
  });

  it('degrades the thumbnail to null when the first-image sub-query errors', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-post',
          event_type: 'stage_change',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { to: 'approved' },
        }),
      ]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch', format: 'single_image', caption: null }]),
      asset_attachments: err('attachments boom'),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.thumbnailAssetVersionId).toBeNull();
      expect(res.data[0]?.title).toBe('Q3 Launch');
    }
  });

  it('resolves a stage_change title via posts with a null actor and the payload stage', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-stage',
          event_type: 'stage_change',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { from: 'draft', to: 'review' },
        }),
      ]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.title).toBe('Q3 Launch');
      expect(res.data[0]?.actorName).toBeNull();
      expect(res.data[0]?.toStage).toBe('review');
    }
  });

  it('degrades when the comments sub-query errors: feed ok, actorName null', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-comment',
          event_type: 'comment',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { comment_id: 'c1' },
        }),
      ]),
      comments: err('comments boom'),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
      users: ok([{ id: 'u-alice', display_name: 'Alice', avatar_url: null }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.actorName).toBeNull();
      expect(res.data[0]?.title).toBe('Q3 Launch');
    }
  });

  it('degrades when the users sub-query errors: feed ok, actorName null', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-comment',
          event_type: 'comment',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { comment_id: 'c1' },
        }),
      ]),
      comments: ok([{ id: 'c1', author_user_id: 'u-alice' }]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
      users: err('users down'),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.actorName).toBeNull();
      expect(res.data[0]?.title).toBe('Q3 Launch');
    }
  });

  it('resolves a checkpoints_added batch author + first-point body via comments -> users', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-points',
          event_type: 'checkpoints_added',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { batch_id: 'batch-1', count: 2 },
        }),
      ]),
      // Two points in the batch, same author; the fake returns them in ledger_seq
      // order (the real query orders ascending), so seq 1 is the preview.
      comments: ok([
        {
          author_user_id: 'u-alice',
          body: 'First point: tighten the hook',
          ledger_seq: 1,
          ledger_batch_id: 'batch-1',
        },
        {
          author_user_id: 'u-alice',
          body: 'Second point: swap the image',
          ledger_seq: 2,
          ledger_batch_id: 'batch-1',
        },
      ]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
      users: ok([{ id: 'u-alice', display_name: 'Alice', avatar_url: 'https://cdn/a.png' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entry = res.data[0] ?? item({});
      expect(entry.actorName).toBe('Alice');
      expect(entry.actorAvatarUrl).toBe('https://cdn/a.png');
      expect(activityLine(entry)).toBe('Alice sent 2 points on Q3 Launch');
      expect(cardBodyLine(entry)).toBe('First point: tighten the hook');
    }
  });

  it('degrades a checkpoints_added batch with no readable comments: actor + body null', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-points',
          event_type: 'checkpoints_added',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { batch_id: 'batch-1', count: 3 },
        }),
      ]),
      comments: ok([]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const entry = res.data[0] ?? item({});
      expect(entry.actorName).toBeNull();
      expect(entry.body).toBeNull();
      expect(activityLine(entry)).toBe('3 points sent on Q3 Launch');
      expect(cardBodyLine(entry)).toBe('3 points sent');
    }
  });
});
