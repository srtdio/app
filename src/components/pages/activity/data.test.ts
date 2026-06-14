import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  activityLine,
  bucketActorNames,
  entityHref,
  filterByScope,
  filterByState,
  groupDigest,
  isSnoozed,
  mapEntry,
  payloadStr,
  relativeTime,
  unreadCount,
  type ActivityItem,
} from '@/components/pages/activity/data';

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
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
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
          to_stage: 'review',
          from_stage: 'draft',
          title: 'Launch brief',
          created_by: 'user-a',
        },
      }),
    );
    expect(mapped.commentId).toBe('c1');
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
    const mapped = mapEntry(row({ payload: 42 as unknown as Database['public']['Tables']['inbox_entries']['Row']['payload'] }));
    expect(mapped.title).toBeNull();
    expect(mapped.actorId).toBeNull();
  });
});

describe('activityLine null-safe rendering', () => {
  it('drops a missing actor name per event type', () => {
    expect(activityLine(item({ eventType: 'comment', actorName: null }))).toBe('New comment on a post');
    expect(activityLine(item({ eventType: 'mention', actorName: null }))).toBe('New mention in a post');
    expect(activityLine(item({ eventType: 'decision_marked', actorName: null }))).toBe(
      'Decision flagged on a post',
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
    expect(
      activityLine(item({ eventType: 'comment', actorName: 'Alice', title: 'Q3 post' })),
    ).toBe('Alice commented on Q3 post');
    expect(
      activityLine(item({ eventType: 'brief_created', actorName: 'Bo', entityType: 'brief', title: 'Brief X' })),
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

describe('entityHref', () => {
  it('routes posts and briefs, nothing else', () => {
    expect(entityHref(item({ entityType: 'post', entityId: 'p9' }))).toBe('/posts/p9');
    expect(entityHref(item({ entityType: 'brief', entityId: 'b9' }))).toBe('/briefs/b9');
    expect(entityHref(item({ entityType: 'workspace', entityId: 'w9' }))).toBeNull();
    expect(entityHref(item({ entityType: 'post', entityId: null }))).toBeNull();
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

  const items = [
    item({ id: 'today-a', createdAt: todayTs }),
    item({ id: 'yest', createdAt: yesterdayTs }),
    item({ id: 'old', createdAt: olderTs }),
    item({ id: 'today-b', createdAt: new Date(startOfToday + 8 * 3_600_000).toISOString() }),
  ];

  it('newest: Today -> Yesterday -> Earlier, newest entry first', () => {
    const buckets = groupDigest(items, 'newest');
    expect(buckets.map((b) => b.key)).toEqual(['today', 'yesterday', 'earlier']);
    expect(buckets[0]?.items.map((i) => i.id)).toEqual(['today-b', 'today-a']);
  });

  it('oldest reverses both bucket and entry order', () => {
    const buckets = groupDigest(items, 'oldest');
    expect(buckets.map((b) => b.key)).toEqual(['earlier', 'yesterday', 'today']);
    expect(buckets[2]?.items.map((i) => i.id)).toEqual(['today-a', 'today-b']);
  });

  it('drops empty buckets', () => {
    const buckets = groupDigest([item({ createdAt: todayTs })], 'newest');
    expect(buckets.map((b) => b.key)).toEqual(['today']);
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
