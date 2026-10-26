// The viewer's role in a workspace, read once per (user, workspace) per session
// window and shared by Pipeline, Post detail, Assets, Plan and chat. The read
// is the same RLS-scoped workspace_members SELECT each surface made on its own
// (the active row's role); this only de-duplicates it. A failed read is never
// kept (the next caller retries) and is kept apart from "no role", so a
// surface can say "Couldn't check your access." rather than hide an action.

import type { Client } from '@srtdio/rpc';
import { invalidateReads, peekRead, readKey, sharedRead } from '@/lib/session-read';

export type MemberRoleRead = { ok: true; role: string | null } | { ok: false };

/** Roles change rarely; a membership change fires workspace-data-changed. */
export const ROLE_FRESH_MS = 5 * 60_000;

async function selectRole(
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

function roleKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'member-role');
}

/** The viewer's active role, shared per session window. Never throws. */
export function readSharedMemberRole(
  client: Client,
  workspaceId: string,
  userId: string,
): Promise<MemberRoleRead> {
  return sharedRead(roleKey(userId, workspaceId), () => selectRole(client, workspaceId, userId), {
    freshMs: ROLE_FRESH_MS,
    isOk: (read) => read.ok,
  });
}

/** A role already read in this session window, or undefined. Never reads. */
export function peekSharedMemberRole(
  workspaceId: string,
  userId: string,
): MemberRoleRead | undefined {
  return peekRead<MemberRoleRead>(roleKey(userId, workspaceId));
}


/**
 * Forget this (user, workspace)'s role read, running or settled. A caller that
 * gave up on a hung read (viewer-role's 5s bound) drops it, so the next mount
 * starts a new read instead of joining the one that never answered.
 */
export function dropSharedMemberRole(workspaceId: string, userId: string): void {
  invalidateReads(roleKey(userId, workspaceId));
}
