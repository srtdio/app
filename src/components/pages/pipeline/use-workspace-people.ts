// The workspace's active members for the Pipeline: approver first names (the
// card status line and the Send for review helper) and a user id -> display
// name map (the creator's name in the reject confirm). One membership read and
// one batched profile read per workspace, the same reads use-post-members
// makes. A failed read leaves the lists empty, so the copy falls back to
// "approvers" and "The creator".

import { useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import { isClient } from '@/components/pages/pcs/roles';
import { firstNameOf } from '@/components/pages/pipeline/card-status';

export interface WorkspacePeople {
  approverFirstNames: string[];
  /** Active members' display names by user id. */
  names: ReadonlyMap<string, string>;
}

const EMPTY: WorkspacePeople = { approverFirstNames: [], names: new Map() };

/** Members as people: approvers' first names in member order plus every name. Pure. */
export function toWorkspacePeople(
  members: readonly { user_id: string; role: string | null; active: boolean }[],
  profiles: readonly { userId: string; displayName: string | null }[],
): WorkspacePeople {
  const names = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.displayName !== null && profile.displayName.trim() !== '') {
      names.set(profile.userId, profile.displayName);
    }
  }
  const approverFirstNames = members
    .filter((m) => m.active && isClient(m.role))
    .map((m) => firstNameOf(names.get(m.user_id)))
    .filter((name) => name !== '');
  return { approverFirstNames, names };
}

export function useWorkspacePeople(workspaceId: string | null): WorkspacePeople {
  const [people, setPeople] = useState<WorkspacePeople>(EMPTY);
  useEffect(() => {
    setPeople(EMPTY);
    if (workspaceId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const members = await listMembers(supabase, workspaceId);
        if (cancelled || !members.ok) return;
        const active = members.data.filter((m) => m.active);
        const profiles = await readProfiles(
          supabase,
          active.map((m) => m.user_id),
        );
        if (cancelled || !profiles.ok) return;
        setPeople(toWorkspacePeople(active, profiles.data));
      } catch {
        // A transport throw keeps the fallback copy.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return people;
}
