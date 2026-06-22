// Loads the workspace's members as @-mention candidates for the comment
// composer, reusing the SAME reads as src/components/chat/use-workspace-members:
// @srtdio/workspace's listMembers (RLS-scoped workspace_members select, gives
// user_id + role) and chat-reads' batched readProfiles (display name + avatar).
// The chat hook drops role on the way to its picker options; this one ZIPS the
// two reads so role is retained for the mention rows. One membership read plus
// one batched profile read: no new DB read and no N+1.

import { useCallback, useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';

/** One selectable person in the mention picker (name + role + avatar). */
export interface MentionCandidate {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

interface MentionCandidatesState {
  candidates: MentionCandidate[];
  loading: boolean;
  error: string | null;
}

/** Resolve the active workspace's members to mention candidates, retaining role. */
export function useMentionCandidates(workspaceId: string): MentionCandidatesState {
  const [state, setState] = useState<MentionCandidatesState>({
    candidates: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async (): Promise<MentionCandidatesState> => {
    const members = await listMembers(supabase, workspaceId);
    if (!members.ok) return { candidates: [], loading: false, error: members.error.message };
    const roleById = new Map(members.data.map((m) => [m.user_id, m.role]));
    const userIds = members.data.map((m) => m.user_id);
    const profiles = await readProfiles(supabase, userIds);
    if (!profiles.ok) return { candidates: [], loading: false, error: profiles.error.message };
    const byId = new Map(profiles.data.map((p) => [p.userId, p]));
    const candidates: MentionCandidate[] = userIds
      .map((id) => {
        const profile = byId.get(id);
        return {
          id,
          name: profile?.displayName ?? '',
          role: roleById.get(id) ?? '',
          avatarUrl: profile?.avatarUrl ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { candidates, loading: false, error: null };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setState({ candidates: [], loading: true, error: null });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
