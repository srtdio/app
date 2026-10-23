// The workspace's approvers for the on-behalf approve sheet: active client-role
// members with their display names. One membership read plus one batched
// profile read, the same reads use-post-members makes. A failed read leaves the
// list empty (the sheet still approves, without a named approver).

import { useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import { toApproverOptions, type ApproverOption } from '@/components/ui/OnBehalfApproveSheet';

export function useWorkspaceApprovers(workspaceId: string | null): ApproverOption[] {
  const [approvers, setApprovers] = useState<ApproverOption[]>([]);
  useEffect(() => {
    setApprovers([]);
    if (workspaceId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const members = await listMembers(supabase, workspaceId);
        if (cancelled || !members.ok) return;
        const active = members.data.filter((m) => m.active && m.role === 'client');
        const profiles = await readProfiles(
          supabase,
          active.map((m) => m.user_id),
        );
        if (cancelled || !profiles.ok) return;
        const names = new Map(profiles.data.map((p) => [p.userId, p.displayName]));
        setApprovers(toApproverOptions(active, names));
      } catch {
        // A transport throw keeps the list empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return approvers;
}
