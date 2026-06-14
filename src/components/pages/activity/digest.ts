// Pure, hookless digest logic for the Activity surface. Every function is a plain
// transform over ActivityItem[], unit-tested by walking the returned data. The
// page wires these to the chips and renders groupDigest's output as cards.

import type { ActivityItem, ActivityScope, ActivityState } from './types';

export type Bucket = 'Today' | 'Yesterday' | 'Earlier';

const BUCKET_ORDER: readonly Bucket[] = ['Today', 'Yesterday', 'Earlier'];
const DAY_MS = 86_400_000;

export interface DigestBucket {
  bucket: Bucket;
  /** Threaded groups, each entries newest-first; groups themselves newest-first. */
  groups: ActivityItem[][];
}

/** Snoozed and still in the future relative to now. */
export function isCurrentlySnoozed(item: ActivityItem, nowMs: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > nowMs;
}

export function filterByState(
  items: ActivityItem[],
  state: ActivityState,
  nowMs: number,
): ActivityItem[] {
  if (state === 'snoozed') return items.filter((item) => isCurrentlySnoozed(item, nowMs));
  if (state === 'unread') {
    return items.filter((item) => !isCurrentlySnoozed(item, nowMs) && item.readAt === null);
  }
  return items.filter((item) => !isCurrentlySnoozed(item, nowMs));
}

export function filterByScope(items: ActivityItem[], scope: ActivityScope): ActivityItem[] {
  if (scope === 'everything') return items;
  return items.filter((item) => item.scope === scope);
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar-day bucket in local time: Today, Yesterday, or Earlier. */
export function bucketLabel(createdAt: string, nowMs: number): Bucket {
  const diffDays = Math.round(
    (startOfLocalDay(nowMs) - startOfLocalDay(Date.parse(createdAt))) / DAY_MS,
  );
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return 'Earlier';
}

/** Post/brief entries with an id THREAD by entity; everything else stays solo. */
export function entityKey(item: ActivityItem): string {
  if ((item.entityType === 'post' || item.entityType === 'brief') && item.entityId !== null) {
    return `${item.entityType}:${item.entityId}`;
  }
  return `solo:${item.id}`;
}

export function groupDigest(items: ActivityItem[], nowMs: number = Date.now()): DigestBucket[] {
  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const result: DigestBucket[] = [];
  for (const bucket of BUCKET_ORDER) {
    const inBucket = sorted.filter((item) => bucketLabel(item.createdAt, nowMs) === bucket);
    if (inBucket.length === 0) continue;
    // Insertion order over the newest-first list keeps both groups and their
    // entries newest-first; a thread's first-seen entry is its newest.
    const groups = new Map<string, ActivityItem[]>();
    for (const item of inBucket) {
      const key = entityKey(item);
      const existing = groups.get(key);
      if (existing !== undefined) existing.push(item);
      else groups.set(key, [item]);
    }
    result.push({ bucket, groups: [...groups.values()] });
  }
  return result;
}
