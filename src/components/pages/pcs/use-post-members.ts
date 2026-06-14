// Loads a workspace's ACTIVE members as picker options for the post owner picker
// and as the resolver behind the owner display name (never a raw uuid). Reuses
// the existing reads exactly as the chat member picker does: @srtdio/workspace's
// listMembers (RLS-scoped workspace_members select) for the membership, filtered
// to active rows, then chat-reads' batched readProfiles for name + avatar. One
// membership read plus one batched profile read, no N+1.

import { useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

export interface PostMembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

/** Resolve the workspace's active members to picker options. */
export function usePostMembers(workspaceId: string | null): PostMembersState {
  const [state, setState] = useState<PostMembersState>({
    options: [],
    loading: workspaceId !== null,
    error: null,
  });

  useEffect(() => {
    if (workspaceId === null) {
      setState({ options: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ options: [], loading: true, error: null });
    void (async () => {
      const members = await listMembers(supabase, workspaceId);
      if (cancelled) return;
      if (!members.ok) {
        setState({ options: [], loading: false, error: members.error.message });
        return;
      }
      const activeIds = members.data.filter((m) => m.active).map((m) => m.user_id);
      const profiles = await readProfiles(supabase, activeIds);
      if (cancelled) return;
      if (!profiles.ok) {
        setState({ options: [], loading: false, error: profiles.error.message });
        return;
      }
      setState({ options: toMemberOptions(profiles.data), loading: false, error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return state;
}
