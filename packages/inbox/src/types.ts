// Shared types for the inbox fan-out. Row shapes are pinned to the generated
// Supabase types so a schema change surfaces here as a type error rather than a
// silent runtime drift. The worker feeds Realtime change payloads in as the
// ChangeEvent union below; everything downstream is typed against it.

import type { Database, Json } from '@srtdio/schemas';

type Tables = Database['public']['Tables'];
export type CommentRow = Tables['comments']['Row'];
export type PostRow = Tables['posts']['Row'];
export type BriefRow = Tables['briefs']['Row'];
export type AssetRow = Tables['assets']['Row'];
export type AssetVersionRow = Tables['asset_versions']['Row'];
export type WorkspaceMemberRow = Tables['workspace_members']['Row'];

export type { Json };

/** Roles that count as the agency-side audience for fan-out. */
export type Role = 'owner' | 'admin' | 'agency' | 'client';

/** Members notified for brief / asset events. */
export const AGENCY_ROLES: readonly Role[] = ['owner', 'admin', 'agency'];
/** Members notified for a post stage change (admins + owner only). */
export const ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];

/** The inbox_entries.event_type values this worker can emit. */
export type InboxEventType =
  | 'comment'
  | 'mention'
  | 'stage_change'
  | 'comment_resolved'
  | 'brief_created'
  | 'brief_closed'
  | 'asset_uploaded'
  | 'asset_version_added'
  | 'invite';

export type InboxEntityType = 'post' | 'brief' | 'chat_channel' | 'workspace';
export type InboxScope = 'everything' | 'posts' | 'briefs' | 'people' | 'groups' | 'clients';
export type InboxTier = 'urgent' | 'active' | 'ambient';

/**
 * A Realtime change as the worker observes it. `old` carries the pre-image used
 * to detect transitions (stage changed, thread resolved, status -> closed);
 * Supabase delivers it when the source table has REPLICA IDENTITY FULL.
 */
export type ChangeEvent =
  | { table: 'comments'; type: 'INSERT'; row: CommentRow }
  | { table: 'comments'; type: 'UPDATE'; row: CommentRow; old: Partial<CommentRow> }
  | { table: 'posts'; type: 'UPDATE'; row: PostRow; old: Partial<PostRow> }
  | { table: 'briefs'; type: 'INSERT'; row: BriefRow }
  | { table: 'briefs'; type: 'UPDATE'; row: BriefRow; old: Partial<BriefRow> }
  | { table: 'assets'; type: 'INSERT'; row: AssetRow }
  | { table: 'asset_versions'; type: 'INSERT'; row: AssetVersionRow }
  | { table: 'workspace_members'; type: 'INSERT'; row: WorkspaceMemberRow };

/** One inbox entry to be written: a recipient plus the event_type/tier for them. */
export interface Recipient {
  userId: string;
  eventType: InboxEventType;
  tier: InboxTier;
}

/**
 * The non-recipient half of an inbox entry, derived once per source event and
 * shared by every recipient. `sourceTable`/`sourceId` identify the source row
 * for the idempotency key; they are never written to inbox_entries.
 */
export interface Envelope {
  workspaceId: string;
  entityType: InboxEntityType | null;
  entityId: string | null;
  scope: InboxScope;
  scopeKey: string | null;
  payload: Json;
  sourceTable: string;
  sourceId: string;
}

/** Full set of inbox writes derived from a single source event. */
export interface Fanout {
  envelope: Envelope;
  recipients: Recipient[];
}
