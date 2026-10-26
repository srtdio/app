// The viewer's workspace role for the pipeline, read the same way PCS reads it
// (an active workspace_members row) but with the failure kept apart from "no
// role": fetchMemberRole folds an error into null, which the move sheet would
// show as "Not available for your role". Here a failed read is its own state so
// the sheet can say "Couldn't check your access." and offer Retry.

import type { Client } from '@srtdio/posts';
import { readSharedMemberRole, type MemberRoleRead } from '@/lib/member-role';

/** The role read's lifecycle: unknown while loading, failed, or settled. */
export type RoleStatus = 'loading' | 'error' | 'ready';

/**
 * Read the viewer's active role; a PostgREST error or a throw is `{ ok: false }`.
 * The read is the session-shared one (src/lib/member-role.ts): a role Post
 * detail, Assets, Plan or chat read in this window answers here with no request.
 */
export function readMemberRole(
  client: Client,
  workspaceId: string,
  userId: string,
): Promise<MemberRoleRead> {
  return readSharedMemberRole(client, workspaceId, userId);
}

/** The line the move sheet shows when the role read failed. */
export const ROLE_READ_ERROR = "Couldn't check your access. Try again.";

/** The line the move sheet shows while the role read is in flight. */
export const ROLE_READ_PENDING = 'Checking your access…';
