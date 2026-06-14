// Shared types for the Activity (Digest) surface. ActivityItem is the enriched,
// view-ready shape produced by data.ts (one per inbox_entries row); the page and
// the pure digest logic operate on it without touching PostgREST again.

/** The scope routing values the inbox writer stamps (mirrors @srtdio/inbox InboxScope). */
export type ActivityScope = 'everything' | 'posts' | 'briefs' | 'people' | 'groups' | 'clients';

/** The three state chips: All / Unread / Snoozed. */
export type ActivityState = 'all' | 'unread' | 'snoozed';

export interface ActivityItem {
  id: string;
  createdAt: string;
  eventType: string;
  tier: string;
  scope: string;
  readAt: string | null;
  snoozedUntil: string | null;
  actorName: string | null;
  entityType: 'post' | 'brief' | 'workspace' | null;
  entityId: string | null;
  entityTitle: string | null;
  fromStage: string | null;
  toStage: string | null;
}
