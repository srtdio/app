// Test-only builders for catch-up specs: an inbox row through the feed's own
// mapEntry, so every spec reads entries the way the screen does.

import type { Database, Json } from '@srtdio/schemas';
import { mapEntry, type ActivityItem } from '@/components/pages/activity/data';
import { buildCatchUpQueue, type CatchUpItem } from '@/lib/catch-up/queue';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

export function inboxRow(over: Partial<InboxEntryRow> = {}): InboxEntryRow {
  return {
    id: 'e1',
    workspace_id: 'w1',
    user_id: 'u-me',
    event_type: 'comment',
    entity_type: 'post',
    entity_id: 'p1',
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    created_at: '2026-11-08T10:00:00.000Z',
    read_at: null,
    snoozed_until: null,
    deleted_at: null,
    email_sent_at: null,
    payload: {} as Json,
    actor_user_id: 'u-actor',
    ...over,
  };
}

export function entry(
  over: Partial<InboxEntryRow> = {},
  fields: Partial<ActivityItem> = {},
): ActivityItem {
  return { ...mapEntry(inboxRow(over)), ...fields };
}

/** One catch-up card (item) holding `entries`, built by the real queue. */
export function cardOf(...entries: ActivityItem[]): CatchUpItem {
  const [first] = entries;
  if (first === undefined) throw new Error('cardOf needs an entry');
  const card = buildCatchUpQueue({ tapped: first, held: entries, nowMs: 0 })[0];
  if (card === undefined) throw new Error('cardOf: no card');
  return card;
}
