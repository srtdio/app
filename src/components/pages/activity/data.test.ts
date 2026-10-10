import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  activityLine,
  bucketActorNames,
  cardBodyLine,
  cardTitle,
  chatMentionPreview,
  entityHref,
  entityKey,
  fetchActivityEntries,
  filterByScope,
  filterByState,
  groupDigest,
  isChatMention,
  isSnoozed,
  mapEntry,
  payloadNum,
  payloadStr,
  relativeTime,
  resolveBodyMentions,
  segmentSelfMentions,
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
    actor_user_id: null,
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
    messageId: null,
    channelType: null,
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
      'Someone approved a post',
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
      'Someone approved a post',
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
    ).toBe('Someone approved a post');
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

  it('Mentions keeps read + unread mentions, drops snoozed and non-mention rows, newest first', () => {
    const unreadMention = item({ id: 'm-unread', eventType: 'mention', readAt: null });
    const readMention = item({ id: 'm-read', eventType: 'mention', readAt: past });
    const snoozedMention = item({
      id: 'm-snoozed',
      eventType: 'mention',
      readAt: null,
      snoozedUntil: future,
    });
    const comment = item({ id: 'c', eventType: 'comment', readAt: null });
    // Input arrives newest-first (as the server page does); order must survive.
    const input = [unreadMention, comment, readMention, snoozedMention];
    expect(filterByState(input, 'mentions', now).map((i) => i.id)).toEqual(['m-unread', 'm-read']);
  });
});

describe('segmentSelfMentions', () => {
  it('accents only the self @name and leaves other names and text plain', () => {
    const segs = segmentSelfMentions('Hey @Alice and @Bob, ship it', 'Alice');
    expect(segs).toEqual([
      { text: 'Hey ', self: false },
      { text: '@Alice', self: true },
      { text: ' and @Bob, ship it', self: false },
    ]);
  });

  it('does not light up a self name that is only a prefix of a longer name', () => {
    const segs = segmentSelfMentions('ping @Alexandra now', 'Alex');
    expect(segs).toEqual([{ text: 'ping @Alexandra now', self: false }]);
  });

  it('returns a single plain segment when selfName is null or unmatched', () => {
    expect(segmentSelfMentions('no mentions here', null)).toEqual([
      { text: 'no mentions here', self: false },
    ]);
    expect(segmentSelfMentions('hi @Bob', 'Alice')).toEqual([{ text: 'hi @Bob', self: false }]);
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
    not(col: string, op: string, val: unknown): FakeBuilder;
    or(filters: string): FakeBuilder;
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
      not: () => self,
      or: () => self,
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

  it('a chat mention row reads "<actor> mentioned you in <group>" with the message first line', async () => {
    const ANA = '11111111-1111-4111-8111-111111111111';
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-chat',
          event_type: 'mention',
          entity_type: 'chat_channel',
          entity_id: 'chan-g',
          scope: 'groups',
          actor_user_id: 'u-bob',
          payload: { message_id: 'msg-1' },
        }),
      ]),
      chat_channels: ok([{ channel_id: 'chan-g', channel_type: 'group', entity_id: 'g1' }]),
      chat_messages: ok([{ id: 'msg-1', body: `hey @[${ANA}] see this\nsecond line` }]),
      groups: ok([{ id: 'g1', name: 'Launch crew' }]),
      users: ok([
        { id: 'u-bob', display_name: 'Bob', avatar_url: null },
        { id: ANA, display_name: 'Ana', avatar_url: null },
      ]),
      workspace_members: ok([{ user_id: ANA, role: 'client' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chat = res.data[0] ?? item({});
    expect(chat.actorName).toBe('Bob');
    expect(chat.channelType).toBe('group');
    expect(activityLine(chat)).toBe('Bob mentioned you in Launch crew');
    expect(chat.body).toBe('hey @Ana see this');
    expect(entityHref(chat)).toBe('/chat?channel=chan-g&message=msg-1');
  });

  it('B1 a removed member with a readable profile reads "@Unknown member" in Activity; an active one is unchanged', async () => {
    const ANA = '11111111-1111-4111-8111-111111111111';
    const EX = '22222222-2222-4222-8222-222222222222';
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-chat',
          event_type: 'mention',
          entity_type: 'chat_channel',
          entity_id: 'chan-g',
          scope: 'groups',
          actor_user_id: 'u-bob',
          payload: { message_id: 'msg-1' },
        }),
      ]),
      chat_channels: ok([{ channel_id: 'chan-g', channel_type: 'group', entity_id: 'g1' }]),
      chat_messages: ok([{ id: 'msg-1', body: `hey @[${ANA}] and @[${EX}]` }]),
      groups: ok([{ id: 'g1', name: 'Launch crew' }]),
      // users RLS still returns the ex-member's profile...
      users: ok([
        { id: 'u-bob', display_name: 'Bob', avatar_url: null },
        { id: ANA, display_name: 'Ana', avatar_url: null },
        { id: EX, display_name: 'Eve', avatar_url: null },
      ]),
      // ...but only Ana has an active, non-removed membership.
      workspace_members: ok([{ user_id: ANA, role: 'client' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chat = res.data[0] ?? item({});
    expect(chat.body).toBe('hey @Ana and @Unknown member');
    expect(chat.body).not.toContain('Eve');
  });

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

  it('resolves a stage_change actor from actor_user_id with its avatar and actor_role', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-stage',
          event_type: 'stage_change',
          entity_type: 'post',
          entity_id: 'p1',
          actor_user_id: 'u-chitra',
          payload: { from: 'review', to: 'approved', actor_role: 'agency' },
        }),
      ]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch', number: 12 }]),
      users: ok([{ id: 'u-chitra', display_name: 'Chitra', avatar_url: 'https://a/c.png' }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const row = res.data[0]!;
      expect(row.actorName).toBe('Chitra');
      expect(row.actorAvatarUrl).toBe('https://a/c.png');
      expect(activityLine(row, 'key')).toBe('Chitra approved KEY-12 on behalf of client');
    }
  });

  it('a post_deleted row keeps its payload number and title when the post read misses it', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-del',
          event_type: 'post_deleted',
          entity_type: 'post',
          entity_id: 'p9',
          actor_user_id: 'u-chitra',
          payload: { number: 9, title: 'Old teaser', actor_role: 'agency' },
        }),
      ]),
      posts: ok([]),
      users: ok([{ id: 'u-chitra', display_name: 'Chitra', avatar_url: null }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const row = res.data[0]!;
      expect(row.number).toBe(9);
      expect(row.title).toBe('Old teaser');
      expect(activityLine(row, 'key')).toBe('Chitra deleted KEY-9 Old teaser');
      expect(entityHref(row, 'key')).toBeNull();
    }
  });

  it('an assets_deleted row resolves its actor and opens Assets', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-assets',
          event_type: 'assets_deleted',
          entity_type: 'workspace',
          entity_id: 'w1',
          scope: 'everything',
          actor_user_id: 'u-asha',
          payload: { count: 3, filenames: ['a.png', 'b.png', 'c.png'], actor_role: 'client' },
        }),
      ]),
      users: ok([{ id: 'u-asha', display_name: 'Asha', avatar_url: null }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const row = res.data[0]!;
      expect(activityLine(row, 'key')).toBe('Asha deleted 3 assets');
      expect(entityHref(row, 'key')).toBe('/assets');
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

  it('resolves a mention preview body from the joined comment (no extra fetch)', async () => {
    const client = fakeClient({
      inbox_entries: ok([
        inboxRow({
          id: 'e-mention',
          event_type: 'mention',
          entity_type: 'post',
          entity_id: 'p1',
          payload: { comment_id: 'c1' },
        }),
      ]),
      comments: ok([
        {
          id: 'c1',
          author_user_id: 'u-alice',
          body: 'Please review @[00000000-0000-4000-8000-000000000002]',
        },
      ]),
      posts: ok([{ id: 'p1', title: 'Q3 Launch' }]),
      users: ok([
        { id: 'u-alice', display_name: 'Alice', avatar_url: null },
        { id: '00000000-0000-4000-8000-000000000002', display_name: 'Bob', avatar_url: null },
      ]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]?.eventType).toBe('mention');
      // The mention token is resolved to @Name; the raw @[uuid] never survives.
      expect(res.data[0]?.body).toBe('Please review @Bob');
    }
  });
});

// A recording fake that captures every builder call so the query the loader
// composes (event_type filter + keyset `before` + DESC order + page-size limit)
// can be asserted directly. Only inbox_entries is exercised here; the enrichment
// joins see empty tables and degrade to null, which is fine for query assertions.
describe('fetchActivityEntries query composition', () => {
  type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
  type FakeClient = Parameters<typeof fetchActivityEntries>[0];

  interface Call {
    method: string;
    args: unknown[];
  }

  function recordingClient(inboxRows: Record<string, unknown>[]): {
    client: FakeClient;
    calls: Call[];
  } {
    const calls: Call[] = [];
    function builder(result: QueryResult, record: boolean): Record<string, unknown> {
      const self: Record<string, unknown> = {};
      for (const method of [
        'select',
        'eq',
        'is',
        'order',
        'limit',
        'lt',
        'like',
        'in',
        'not',
        'or',
      ]) {
        self[method] = (...args: unknown[]) => {
          if (record) calls.push({ method, args });
          return self;
        };
      }
      self.then = (
        onfulfilled: (v: QueryResult) => unknown,
        onrejected?: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(onfulfilled, onrejected);
      return self;
    }
    const client = {
      from(table: string) {
        const isInbox = table === 'inbox_entries';
        return builder(
          isInbox ? { data: inboxRows, error: null } : { data: [], error: null },
          isInbox,
        );
      },
    };
    return { client: client as unknown as FakeClient, calls };
  }

  const hasCall = (
    calls: { method: string; args: unknown[] }[],
    method: string,
    args: unknown[],
  ): boolean =>
    calls.some((c) => c.method === method && JSON.stringify(c.args) === JSON.stringify(args));

  it('applies the event_type filter when eventType is given', async () => {
    const { client, calls } = recordingClient([]);
    await fetchActivityEntries(client, 'w1', { eventType: 'mention' });
    expect(hasCall(calls, 'eq', ['event_type', 'mention'])).toBe(true);
    expect(hasCall(calls, 'eq', ['workspace_id', 'w1'])).toBe(true);
    expect(hasCall(calls, 'order', ['created_at', { ascending: false }])).toBe(true);
    expect(hasCall(calls, 'limit', [50])).toBe(true);
  });

  it('filters the chat bell rows out server-side (Activity is posts only)', async () => {
    const { client, calls } = recordingClient([]);
    await fetchActivityEntries(client, 'w1');
    expect(
      hasCall(calls, 'not', ['event_type', 'in', '(reminder,scheduled_sent,scheduled_failed)']),
    ).toBe(true);
    expect(
      hasCall(calls, 'or', [
        'event_type.neq.mention,entity_type.is.null,entity_type.neq.chat_channel',
      ]),
    ).toBe(true);
  });

  it('omits the event_type filter when eventType is absent', async () => {
    const { client, calls } = recordingClient([]);
    await fetchActivityEntries(client, 'w1');
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'event_type')).toBe(false);
  });

  it('preserves keyset pagination alongside the event_type filter', async () => {
    const { client, calls } = recordingClient([]);
    await fetchActivityEntries(client, 'w1', {
      before: '2026-06-14T00:00:00.000Z',
      eventType: 'mention',
    });
    expect(hasCall(calls, 'lt', ['created_at', '2026-06-14T00:00:00.000Z'])).toBe(true);
    expect(hasCall(calls, 'eq', ['event_type', 'mention'])).toBe(true);
    expect(hasCall(calls, 'order', ['created_at', { ascending: false }])).toBe(true);
    expect(hasCall(calls, 'limit', [50])).toBe(true);
  });
});

describe('chat mention rows', () => {
  const chat = (over: Partial<ActivityItem>): ActivityItem =>
    item({
      eventType: 'mention',
      entityType: 'chat_channel',
      entityId: 'chan-1',
      scope: 'people',
      messageId: 'msg-9',
      actorName: 'Bob',
      ...over,
    });

  it('a DM mention reads "<actor> mentioned you"; a group one names the group', () => {
    expect(activityLine(chat({ channelType: 'dm' }))).toBe('Bob mentioned you');
    expect(activityLine(chat({ channelType: 'group', title: 'Ops' }))).toBe(
      'Bob mentioned you in Ops',
    );
    expect(activityLine(chat({ channelType: 'dm', actorName: null }))).toBe('New mention');
  });

  it('links to the chat and the message', () => {
    expect(entityHref(chat({}))).toBe('/chat?channel=chan-1&message=msg-9');
    expect(entityHref(chat({ messageId: null }))).toBe('/chat?channel=chan-1');
  });

  it('maps the sender from actor_user_id and the message id from the payload', () => {
    const mapped = mapEntry(
      row({
        event_type: 'mention',
        entity_type: 'chat_channel',
        entity_id: 'chan-1',
        actor_user_id: 'u-bob',
        payload: { message_id: 'msg-9' },
      }),
    );
    expect(mapped.actorId).toBe('u-bob');
    expect(mapped.messageId).toBe('msg-9');
    expect(isChatMention(mapped)).toBe(true);
  });

  it('the preview is the first line with tokens resolved, never a raw token', () => {
    const ANA = '11111111-1111-4111-8111-111111111111';
    const GONE = '99999999-9999-4999-8999-999999999999';
    const names = new Map([[ANA, 'Ana']]);
    expect(chatMentionPreview(`\n @[${ANA}] and @[${GONE}]\nmore`, (id) => names.get(id))).toBe(
      '@Ana and @Unknown member',
    );
    expect(chatMentionPreview(null, () => undefined)).toBeNull();
  });

  it('a comment mention row is unchanged', () => {
    const comment = item({
      eventType: 'mention',
      entityType: 'post',
      entityId: 'p1',
      title: 'Q3 Launch',
      actorName: 'Bob',
      commentId: 'c1',
    });
    expect(isChatMention(comment)).toBe(false);
    expect(activityLine(comment)).toBe('Bob mentioned you in Q3 Launch');
    expect(entityHref(comment)).toBe('/posts/p1?comment=c1');
    expect(
      mapEntry(row({ event_type: 'mention', entity_type: 'post', payload: { created_by: 'u1' } }))
        .actorId,
    ).toBe('u1');
  });
});

describe('actor rows: who did what (approve, reject, park, review, deletes)', () => {
  const stage = (to: string, over: Partial<ActivityItem> = {}): ActivityItem =>
    item({ eventType: 'stage_change', toStage: to, number: 12, actorName: 'Chitra', ...over });

  it('stage_change lines name the actor and KEY-N', () => {
    expect(activityLine(stage('approved', { actorRole: 'client' }), 'gbl')).toBe(
      'Chitra approved GBL-12',
    );
    expect(activityLine(stage('rejected', { actorRole: 'client' }), 'gbl')).toBe(
      'Chitra rejected GBL-12',
    );
    expect(activityLine(stage('parked', { actorRole: 'client' }), 'gbl')).toBe(
      'Chitra parked GBL-12',
    );
    expect(activityLine(stage('review', { actorRole: 'client' }), 'gbl')).toBe(
      'Chitra sent GBL-12 for review',
    );
  });

  it('send for review is plain even for an agency-side actor', () => {
    expect(activityLine(stage('review', { actorRole: 'agency' }), 'gbl')).toBe(
      'Chitra sent GBL-12 for review',
    );
  });

  it('an agency-side approve, reject or park adds "on behalf of client"; never a workspace name', () => {
    expect(activityLine(stage('parked', { actorRole: 'agency' }), 'gbl')).toBe(
      'Chitra parked GBL-12 on behalf of client',
    );
    for (const role of ['agency', 'admin', 'owner']) {
      const line = activityLine(stage('approved', { actorRole: role }), 'gbl');
      expect(line).toBe('Chitra approved GBL-12 on behalf of client');
    }
    expect(activityLine(stage('rejected', { actorRole: 'agency' }), 'gbl')).toBe(
      'Chitra rejected GBL-12 on behalf of client',
    );
  });

  it('an old row with no actor_role: name only, no suffix', () => {
    expect(activityLine(stage('approved', { actorRole: null }), 'gbl')).toBe(
      'Chitra approved GBL-12',
    );
    expect(activityLine(stage('approved'), 'gbl')).toBe('Chitra approved GBL-12');
  });

  it('a missing actor reads "Someone"', () => {
    expect(activityLine(stage('approved', { actorName: null }), 'gbl')).toBe(
      'Someone approved GBL-12',
    );
  });

  it('post_deleted: "<Name> deleted KEY-N <title>", plain even for agency; not tappable', () => {
    const del = item({
      eventType: 'post_deleted',
      number: 7,
      title: 'Diwali teaser',
      actorName: 'Chitra',
      actorRole: 'agency',
    });
    expect(activityLine(del, 'gbl')).toBe('Chitra deleted GBL-7 Diwali teaser');
    expect(cardBodyLine(del, 'gbl')).toBe('Chitra deleted GBL-7 Diwali teaser');
    expect(entityHref(del, 'gbl')).toBeNull();
  });

  it('assets_deleted: count 1 names the file, N counts; tap opens Assets', () => {
    const one = item({
      eventType: 'assets_deleted',
      entityType: 'workspace',
      entityId: 'w1',
      actorName: 'Asha',
      actorRole: 'client',
      assetCount: 1,
      filenames: ['brief.pdf'],
    });
    expect(activityLine(one)).toBe('Asha deleted brief.pdf');
    const many = { ...one, assetCount: 4, filenames: ['a', 'b', 'c'] };
    expect(activityLine(many)).toBe('Asha deleted 4 assets');
    const agency = { ...many, actorName: 'Chitra', actorRole: 'agency' };
    expect(activityLine(agency)).toBe('Chitra deleted 4 assets');
    expect(activityLine({ ...one, actorName: null })).toBe('Someone deleted brief.pdf');
    expect(entityHref(one)).toBe('/assets');
  });

  it('mapEntry reads actor_user_id, actor_role, count and filenames', () => {
    const mapped = mapEntry(
      row({
        event_type: 'assets_deleted',
        entity_type: 'workspace',
        entity_id: 'w1',
        actor_user_id: 'u9',
        payload: { count: 2, filenames: ['a', 'b'], actor_role: 'client' },
      }),
    );
    expect(mapped.actorId).toBe('u9');
    expect(mapped.actorRole).toBe('client');
    expect(mapped.assetCount).toBe(2);
    expect(mapped.filenames).toEqual(['a', 'b']);
    const old = mapEntry(
      row({
        event_type: 'stage_change',
        actor_user_id: 'u1',
        payload: { from: 'review', to: 'approved' },
      }),
    );
    expect(old.actorRole).toBeNull();
    expect(old.actorId).toBe('u1');
  });
});

describe('plan comments and approvals', () => {
  type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
  type FakeClient = Parameters<typeof fetchActivityEntries>[0];
  const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const POST_ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const COMMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  /** A fake client that records every `.in()` per table and serves canned rows. */
  function recordingClient(tables: Record<string, QueryResult>): {
    client: FakeClient;
    ins: { table: string; col: string; vals: unknown[] }[];
  } {
    const ins: { table: string; col: string; vals: unknown[] }[] = [];
    const client = {
      from(table: string) {
        const result = tables[table] ?? { data: [], error: null };
        const self = {
          select: () => self,
          eq: () => self,
          is: () => self,
          order: () => self,
          limit: () => self,
          lt: () => self,
          like: () => self,
          not: () => self,
          or: () => self,
          in: (col: string, vals: readonly unknown[]) => {
            ins.push({ table, col, vals: [...vals] });
            return self;
          },
          then(
            onfulfilled?: (value: QueryResult) => unknown,
            onrejected?: (reason: unknown) => unknown,
          ) {
            return Promise.resolve(result).then(onfulfilled, onrejected);
          },
        };
        return self;
      },
    };
    return { client: client as unknown as FakeClient, ins };
  }

  const ok = (data: Record<string, unknown>[]): QueryResult => ({ data, error: null });
  const planRow = (over: Partial<InboxEntryRow>): Record<string, unknown> =>
    row({
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: ITEM,
      scope: 'posts',
      scope_key: PLAN,
      actor_user_id: 'u-ana',
      payload: { plan_id: PLAN, comment_id: COMMENT, visibility: 'everyone' },
      ...over,
    }) as unknown as Record<string, unknown>;

  it('mapEntry reads plan_id, the actor and the review side and status for plan events only', () => {
    const comment = mapEntry(
      row({
        event_type: 'plan_comment',
        entity_type: 'plan_item',
        entity_id: ITEM,
        actor_user_id: 'u-ana',
        payload: { plan_id: PLAN, comment_id: COMMENT, visibility: 'team' },
      }),
    );
    expect(comment.planId).toBe(PLAN);
    expect(comment.commentId).toBe(COMMENT);
    expect(comment.actorId).toBe('u-ana');
    expect(comment.reviewSide).toBeNull();
    const review = mapEntry(
      row({
        event_type: 'plan_review',
        entity_type: 'plan_item',
        entity_id: ITEM,
        actor_user_id: 'u-cy',
        payload: { plan_id: PLAN, side: 'client', status: 'approved' },
      }),
    );
    expect(review.reviewSide).toBe('client');
    expect(review.reviewStatus).toBe('approved');
    expect(review.actorId).toBe('u-cy');
    // A post row never reads a plan_id, even when the payload carries one.
    expect(mapEntry(row({ payload: { plan_id: PLAN } })).planId).toBeNull();
  });

  it('plan_comment reads "<actor> commented on a plan item"; the card title is the item title', () => {
    const it1 = item({
      eventType: 'plan_comment',
      entityType: 'plan_item',
      entityId: ITEM,
      actorName: 'Ana',
      title: 'Diwali reel',
      planId: PLAN,
    });
    expect(activityLine(it1)).toBe('Ana commented on a plan item');
    expect(shortLine(it1)).toBe('Ana commented on a plan item');
    expect(cardTitle(it1)).toBe('Diwali reel');
    expect(activityLine({ ...it1, actorName: null })).toBe('New comment on a plan item');
    // The comment body is the card's body line when present.
    expect(cardBodyLine({ ...it1, body: 'Love it' })).toBe('Love it');
    expect(cardBodyLine({ ...it1, body: null })).toBe('Ana commented on a plan item');
  });

  it('plan_review is side-aware: client plain, team marked; approved and changes', () => {
    const base = item({
      eventType: 'plan_review',
      entityType: 'plan_item',
      entityId: ITEM,
      actorName: 'Cy',
      planId: PLAN,
    });
    expect(activityLine({ ...base, reviewSide: 'client', reviewStatus: 'approved' })).toBe(
      'Cy approved a plan item',
    );
    expect(activityLine({ ...base, reviewSide: 'client', reviewStatus: 'changes' })).toBe(
      'Cy asked changes on a plan item',
    );
    expect(activityLine({ ...base, reviewSide: 'team', reviewStatus: 'approved' })).toBe(
      'Cy approved a plan item (team review)',
    );
    expect(shortLine({ ...base, reviewSide: 'team', reviewStatus: 'changes' })).toBe(
      'Cy asked changes on a plan item (team review)',
    );
    expect(
      activityLine({ ...base, actorName: null, reviewSide: 'client', reviewStatus: 'approved' }),
    ).toBe('A plan item was approved');
    // An unresolved item title falls back to the plan title, then "Plan item".
    expect(cardTitle({ ...base, title: null, planTitle: 'October plan' })).toBe('October plan');
    expect(cardTitle({ ...base, title: null, planTitle: null })).toBe('Plan item');
  });

  it('entityHref: comment with comment_id, review, missing plan_id, missing entity_id', () => {
    const comment = item({
      eventType: 'plan_comment',
      entityType: 'plan_item',
      entityId: ITEM,
      planId: PLAN,
      commentId: COMMENT,
    });
    expect(entityHref(comment)).toBe(`/plans/${PLAN}?item=${ITEM}&comment=${COMMENT}`);
    expect(entityHref({ ...comment, commentId: null })).toBe(`/plans/${PLAN}?item=${ITEM}`);
    const review = { ...comment, eventType: 'plan_review', commentId: null };
    expect(entityHref(review)).toBe(`/plans/${PLAN}?item=${ITEM}`);
    // A review never carries &comment= even if a comment id leaked in.
    expect(entityHref({ ...review, commentId: COMMENT })).toBe(`/plans/${PLAN}?item=${ITEM}`);
    expect(entityHref({ ...comment, planId: null })).toBeNull();
    const noPlanField: ActivityItem = { ...comment };
    delete noPlanField.planId;
    expect(entityHref(noPlanField)).toBeNull();
    expect(entityHref({ ...comment, entityId: null })).toBeNull();
  });

  it('entityKey threads plan events on the same item, never with an unrelated row', () => {
    const a = item({ id: 'a', eventType: 'plan_comment', entityType: 'plan_item', entityId: ITEM });
    const b = item({ id: 'b', eventType: 'plan_review', entityType: 'plan_item', entityId: ITEM });
    expect(entityKey(a)).toBe(entityKey(b));
    expect(entityKey(a)).not.toBe(entityKey(item({ entityId: ITEM })));
  });

  it('fetch: one IN read per table; titles from plan_items / posts; snippets only from plan_item_comments', async () => {
    const { client, ins } = recordingClient({
      inbox_entries: ok([
        planRow({ id: 'e1' }),
        planRow({
          id: 'e2',
          event_type: 'plan_review',
          entity_id: POST_ITEM,
          actor_user_id: 'u-cy',
          payload: { plan_id: PLAN, side: 'client', status: 'approved' },
        }),
        planRow({
          id: 'e3',
          event_type: 'plan_review',
          payload: { plan_id: PLAN, side: 'team', status: 'changes' },
        }),
      ]),
      plan_items: ok([
        { id: ITEM, plan_id: PLAN, kind: 'concept', title: 'Diwali reel', post_id: null },
        { id: POST_ITEM, plan_id: PLAN, kind: 'post', title: null, post_id: 'post-1' },
      ]),
      plans: ok([{ id: PLAN, title: 'October plan' }]),
      plan_item_comments: ok([{ id: COMMENT, author_user_id: 'u-ana', body: 'Love it' }]),
      // A same-id row in comments must never feed the plan snippet.
      comments: ok([{ id: COMMENT, author_user_id: 'u-x', body: 'WRONG TABLE' }]),
      posts: ok([{ id: 'post-1', title: 'Launch post', format: 'text', caption: null, number: 4 }]),
      users: ok([
        { id: 'u-ana', display_name: 'Ana', avatar_url: null },
        { id: 'u-cy', display_name: 'Cy', avatar_url: null },
      ]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [c, r, t] = res.data;
    expect(c?.title).toBe('Diwali reel');
    expect(c?.planTitle).toBe('October plan');
    expect(c?.body).toBe('Love it');
    expect(c?.actorName).toBe('Ana');
    expect(c && activityLine(c)).toBe('Ana commented on a plan item');
    expect(c && entityHref(c)).toBe(`/plans/${PLAN}?item=${ITEM}&comment=${COMMENT}`);
    expect(r?.title).toBe('Launch post');
    expect(r?.body).toBeNull();
    expect(r && activityLine(r)).toBe('Cy approved a plan item');
    expect(t && activityLine(t)).toBe('Ana asked changes on a plan item (team review)');

    const perTable = (table: string) => ins.filter((call) => call.table === table);
    expect(perTable('plan_items')).toHaveLength(1);
    expect(perTable('plans')).toHaveLength(1);
    expect(perTable('plan_item_comments')).toHaveLength(1);
    expect(perTable('posts')).toHaveLength(1);
    // The comments table is never read for a plan comment.
    expect(perTable('comments')).toHaveLength(0);
    expect(perTable('plan_items')[0]?.vals.sort()).toEqual([ITEM, POST_ITEM].sort());
    expect(perTable('plans')[0]?.vals).toEqual([PLAN]);
    expect(perTable('plan_item_comments')[0]?.vals).toEqual([COMMENT]);
    expect(perTable('posts')[0]?.vals).toEqual(['post-1']);
  });

  it('fetch: no plan rows means no plan reads; failed plan reads degrade, never fail the feed', async () => {
    const quiet = recordingClient({ inbox_entries: ok([]) });
    await fetchActivityEntries(quiet.client, 'w1');
    expect(quiet.ins.some((c) => c.table.startsWith('plan'))).toBe(false);

    const failing = recordingClient({
      inbox_entries: ok([planRow({ id: 'e1' })]),
      plan_items: { data: null, error: { message: 'boom' } },
      plans: { data: null, error: { message: 'boom' } },
      plan_item_comments: { data: null, error: { message: 'boom' } },
    });
    const res = await fetchActivityEntries(failing.client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]?.title).toBeNull();
    expect(res.data[0]?.body).toBeNull();
    expect(res.data[0] && cardTitle(res.data[0])).toBe('Plan item');
  });
});
