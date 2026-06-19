// computeRecipients: the heart of the fan-out. Given a Realtime change and a
// reader over the current DB state, it returns the exact set of inbox writes
// (recipient + event_type + tier) the change should produce, per the EVENT MAP
// and RECIPIENT COMPUTE rules. It performs no writes and no KV access; that is
// the worker's job. The reader is an interface so unit tests can drive every
// branch without a database.

import { extractMentions } from './mentions';
import { decisionFlipped, stageChanged, stageTier } from './transitions';
import {
  ADMIN_ROLES,
  AGENCY_ROLES,
  type ChangeEvent,
  type InboxEventType,
  type Recipient,
  type Role,
} from './types';

/**
 * Read-side dependencies of the recipient computation. Every method reflects
 * current DB ground truth and is expected to run with service-role reach
 * (RLS-bypassing) so it sees all members regardless of the caller.
 */
export interface RecipientReader {
  /** owner_user_id of a post, or null if the post is gone. */
  postOwner(postId: string): Promise<string | null>;
  /** created_by of a brief, or null if absent. */
  briefCreatedBy(briefId: string): Promise<string | null>;
  /** Distinct author_user_id of non-deleted comments on an entity. */
  commentAuthors(entityType: 'post' | 'brief', entityId: string): Promise<string[]>;
  /** Active members of the workspace whose role is in `roles`. */
  membersByRole(workspaceId: string, roles: readonly Role[]): Promise<string[]>;
  /** Subset of `candidates` that are active members of the workspace. */
  validateMembers(workspaceId: string, candidates: readonly string[]): Promise<string[]>;
}

// Build Recipients from a user-id list, dropping null/empty ids (a null
// author is an ex-member with no account, so there is nobody to notify),
// the actor, and de-duping.
function build(
  userIds: readonly (string | null)[],
  eventType: InboxEventType,
  tier: Recipient['tier'],
  exclude?: string | null,
): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const userId of userIds) {
    if (!userId || userId === exclude || seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, eventType, tier });
  }
  return out;
}

/** Recipients of a comment on an entity (no mentions): owner/creator + thread. */
async function commentAudience(
  reader: RecipientReader,
  workspaceId: string,
  entityType: 'post' | 'brief',
  entityId: string,
): Promise<string[]> {
  const authors = await reader.commentAuthors(entityType, entityId);
  if (entityType === 'post') {
    const owner = await reader.postOwner(entityId);
    return owner ? [owner, ...authors] : authors;
  }
  const creator = await reader.briefCreatedBy(entityId);
  const agency = await reader.membersByRole(workspaceId, AGENCY_ROLES);
  return creator ? [creator, ...agency, ...authors] : [...agency, ...authors];
}

export async function computeRecipients(
  event: ChangeEvent,
  reader: RecipientReader,
): Promise<Recipient[]> {
  switch (event.table) {
    case 'comments': {
      const { workspace_id, entity_id, author_user_id } = event.row;
      // comments.entity_type is generated as `string`; it is only ever
      // 'post' | 'brief' at runtime (enforced by the comments CHECK / enum).
      const entity_type = event.row.entity_type as 'post' | 'brief';

      if (event.type === 'UPDATE') {
        if (!decisionFlipped(event)) return [];
        const audience = await commentAudience(reader, workspace_id, entity_type, entity_id);
        return build(audience, 'decision_marked', 'active', author_user_id);
      }

      // INSERT: validated mentions, the comment audience, plus mention entries.
      const mentioned = await reader.validateMembers(
        workspace_id,
        extractMentions(event.row.mentions),
      );
      const audience = await commentAudience(reader, workspace_id, entity_type, entity_id);
      return [
        ...build([...audience, ...mentioned], 'comment', 'active', author_user_id),
        ...build(mentioned, 'mention', 'urgent', author_user_id),
      ];
    }

    case 'posts': {
      if (!stageChanged(event)) return [];
      const { workspace_id, owner_user_id, brief_id, stage } = event.row;
      const admins = await reader.membersByRole(workspace_id, ADMIN_ROLES);
      const creator = brief_id ? await reader.briefCreatedBy(brief_id) : null;
      const ids = creator ? [owner_user_id, creator, ...admins] : [owner_user_id, ...admins];
      return build(ids, 'stage_change', stageTier(stage));
    }

    case 'briefs': {
      const agency = await reader.membersByRole(event.row.workspace_id, AGENCY_ROLES);
      if (event.type === 'INSERT') return build(agency, 'brief_created', 'active');
      // UPDATE -> closed (actionability already screened by the worker/envelope).
      return build([...agency, event.row.created_by], 'brief_closed', 'active');
    }

    case 'assets': {
      const agency = await reader.membersByRole(event.row.workspace_id, AGENCY_ROLES);
      return build(agency, 'asset_uploaded', 'active');
    }

    case 'asset_versions': {
      if (event.row.version_number <= 1) return [];
      const agency = await reader.membersByRole(event.row.workspace_id, AGENCY_ROLES);
      return build(agency, 'asset_version_added', 'active');
    }

    case 'workspace_members': {
      if (event.row.active !== false) return [];
      return build([event.row.user_id], 'invite', 'urgent');
    }
  }
}
