// Loads the workspace's members as picker options, reusing the existing reads:
// @srtdio/workspace's listMembers (RLS-scoped workspace_members select) for the
// member ids and chat-reads' batched readProfiles for display name + avatar. No
// new DB read and no N+1: one membership read plus one batched profile read.
// Only active memberships become options, one per user (a user can hold an
// inactive row next to their active one).

import { useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import type { Database } from '@srtdio/schemas';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { readProfiles } from '@/lib/chat-reads';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

export interface WorkspaceMembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

type MemberRow = Pick<
  Database['public']['Tables']['workspace_members']['Row'],
  'user_id' | 'active'
>;

/** The distinct user ids of the active members, in row order. */
export function activeMemberIds(rows: readonly MemberRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.active === true) ids.add(row.user_id);
  }
  return [...ids];
}

/** The members failure line; the raw error goes to the logger only. */
export const MEMBERS_LOAD_FAILED = "Couldn't load members, try again";

/** The two reads, injected so the error mapping is unit-tested. */
export interface MemberReaders {
  members: () => Promise<Result<MemberRow[]>>;
  profiles: (userIds: string[]) => ReturnType<typeof readProfiles>;
}

/** Read the members then their profiles; a failure is the fixed copy, never raw text. */
export async function loadWorkspaceMembers(readers: MemberReaders): Promise<WorkspaceMembersState> {
  const members = await readers.members();
  if (!members.ok) {
    logger.warn('chat: members load failed', { error: members.error.message });
    return { options: [], loading: false, error: MEMBERS_LOAD_FAILED };
  }
  const profiles = await readers.profiles(activeMemberIds(members.data));
  if (!profiles.ok) {
    logger.warn('chat: member profiles load failed', { error: profiles.error.message });
    return { options: [], loading: false, error: MEMBERS_LOAD_FAILED };
  }
  return { options: toMemberOptions(profiles.data), loading: false, error: null };
}

/** The state before a workspace is known: nothing to show, nothing pending, no error. */
const NO_WORKSPACE: WorkspaceMembersState = { options: [], loading: false, error: null };

/**
 * Resolve the active workspace's members to picker options. A null or empty
 * workspace id (the workspace context has not resolved yet) issues no read:
 * filtering workspace_members by an empty uuid is a guaranteed PostgREST 400.
 */
export function useWorkspaceMembers(workspaceId: string | null): WorkspaceMembersState {
  const [state, setState] = useState<WorkspaceMembersState>(() =>
    workspaceId ? { options: [], loading: true, error: null } : NO_WORKSPACE,
  );

  useEffect(() => {
    if (!workspaceId) {
      setState(NO_WORKSPACE);
      return;
    }
    let cancelled = false;
    setState({ options: [], loading: true, error: null });
    void loadWorkspaceMembers({
      members: () => listMembers(supabase, workspaceId),
      profiles: (userIds) => readProfiles(supabase, userIds),
    }).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return state;
}
