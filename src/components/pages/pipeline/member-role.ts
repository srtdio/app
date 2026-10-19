// The viewer's workspace role for the pipeline, read the same way PCS reads it
// (an active workspace_members row) but with the failure kept apart from "no
// role": fetchMemberRole folds an error into null, which the move sheet would
// show as "Not available for your role". Here a failed read is its own state so
// the sheet can say "Couldn't check your access." and offer Retry.

import type { Client } from '@srtdio/posts';

/** The role read's lifecycle: unknown while loading, failed, or settled. */
export type RoleStatus = 'loading' | 'error' | 'ready';

export type MemberRoleRead = { ok: true; role: string | null } | { ok: false };

/** Read the viewer's active role; a PostgREST error or a throw is `{ ok: false }`. */
export async function readMemberRole(
  client: Client,
  workspaceId: string,
  userId: string,
): Promise<MemberRoleRead> {
  try {
    const res = await client
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle();
    if (res.error) return { ok: false };
    if (res.data === null) return { ok: true, role: null };
    return { ok: true, role: (res.data as { role: string | null }).role };
  } catch {
    return { ok: false };
  }
}

/** The line the move sheet shows when the role read failed. */
export const ROLE_READ_ERROR = "Couldn't check your access.";

/** The line the move sheet shows while the role read is in flight. */
export const ROLE_READ_PENDING = 'Checking your access…';
