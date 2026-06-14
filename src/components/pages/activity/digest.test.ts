import { describe, expect, it } from 'vitest';
import { bucketLabel, entityKey, filterByState, groupDigest, isCurrentlySnoozed } from './digest';
import type { ActivityItem } from './types';

const NOW = Date.parse('2026-06-14T12:00:00.000Z');

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'i',
    createdAt: new Date(NOW).toISOString(),
    eventType: 'comment',
    tier: 'active',
    scope: 'everything',
    readAt: null,
    snoozedUntil: null,
    actorName: null,
    entityType: null,
    entityId: null,
    entityTitle: null,
    fromStage: null,
    toStage: null,
    ...over,
  };
}

describe('isCurrentlySnoozed', () => {
  it('is true only when snoozedUntil is in the future', () => {
    expect(
      isCurrentlySnoozed(item({ snoozedUntil: new Date(NOW + 1000).toISOString() }), NOW),
    ).toBe(true);
    expect(
      isCurrentlySnoozed(item({ snoozedUntil: new Date(NOW - 1000).toISOString() }), NOW),
    ).toBe(false);
    expect(isCurrentlySnoozed(item({ snoozedUntil: null }), NOW)).toBe(false);
  });
});

describe('filterByState', () => {
  const unread = item({ id: 'a' });
  const read = item({ id: 'b', readAt: new Date(NOW).toISOString() });
  const snoozed = item({ id: 'c', snoozedUntil: new Date(NOW + 60_000).toISOString() });
  const items = [unread, read, snoozed];

  it('all excludes currently-snoozed entries', () => {
    expect(filterByState(items, 'all', NOW).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('unread excludes read and snoozed entries', () => {
    expect(filterByState(items, 'unread', NOW).map((i) => i.id)).toEqual(['a']);
  });

  it('snoozed keeps only currently-snoozed entries', () => {
    expect(filterByState(items, 'snoozed', NOW).map((i) => i.id)).toEqual(['c']);
  });
});

describe('bucketLabel', () => {
  it('classifies today, yesterday and earlier by calendar day', () => {
    expect(bucketLabel(new Date(NOW).toISOString(), NOW)).toBe('Today');
    expect(bucketLabel(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe('Yesterday');
    expect(bucketLabel(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe('Earlier');
  });
});

describe('entityKey', () => {
  it('threads two post entries sharing an entity id', () => {
    const a = item({ id: 'a', entityType: 'post', entityId: 'X' });
    const b = item({ id: 'b', entityType: 'post', entityId: 'X' });
    expect(entityKey(a)).toBe(entityKey(b));
    expect(entityKey(a)).toBe('post:X');
  });

  it('keeps workspace and id-less entries solo (never threads)', () => {
    const ws = item({ id: 'w', entityType: 'workspace', entityId: 'X' });
    const none = item({ id: 'n', entityType: null, entityId: null });
    expect(entityKey(ws)).toBe('solo:w');
    expect(entityKey(none)).toBe('solo:n');
  });
});

describe('groupDigest', () => {
  it('orders buckets, groups and entries newest-first and threads by entity', () => {
    const p1a = item({
      id: 'p1a',
      entityType: 'post',
      entityId: 'X',
      createdAt: new Date(NOW).toISOString(),
    });
    const p1b = item({
      id: 'p1b',
      entityType: 'post',
      entityId: 'X',
      createdAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    });
    const solo = item({ id: 'solo', createdAt: new Date(NOW - 3_600_000).toISOString() });
    const y1 = item({ id: 'y1', createdAt: new Date(NOW - 86_400_000).toISOString() });
    const e1 = item({ id: 'e1', createdAt: new Date(NOW - 5 * 86_400_000).toISOString() });

    const digest = groupDigest([p1b, solo, p1a, e1, y1], NOW);

    expect(digest.map((b) => b.bucket)).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(digest[0]?.groups.map((g) => g.map((i) => i.id))).toEqual([['p1a', 'p1b'], ['solo']]);
    expect(digest[1]?.groups).toEqual([[y1]]);
    expect(digest[2]?.groups).toEqual([[e1]]);
  });
});
