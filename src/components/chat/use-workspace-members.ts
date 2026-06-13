// Loads the workspace's members as picker options, reusing the existing reads:
// @srtdio/workspace's listMembers (RLS-scoped workspace_members select) for the
// member ids and chat-reads' batched readProfiles for display name + avatar. No
// new DB read and no N+1: one membership read plus one batched profile read.

import { useCallback, useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

interface WorkspaceMembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

/** Resolve the active workspace's members to picker options. */
export function useWorkspaceMembers(workspaceId: string): WorkspaceMembersState {
  const [state, setState] = useState<WorkspaceMembersState>({
    options: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async (): Promise<WorkspaceMembersState> => {
    const members = await listMembers(supabase, workspaceId);
    if (!members.ok) return { options: [], loading: false, error: members.error.message };
    const userIds = members.data.map((m) => m.user_id);
    const profiles = await readProfiles(supabase, userIds);
    if (!profiles.ok) return { options: [], loading: false, error: profiles.error.message };
    return { options: toMemberOptions(profiles.data), loading: false, error: null };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setState({ options: [], loading: true, error: null });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
