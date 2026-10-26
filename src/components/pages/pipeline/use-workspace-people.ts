// The workspace's active members for the Pipeline: approver first names (the
// card status line and the Send for review helper), a user id -> display
// name map (the creator's name in the reject confirm) and the on-behalf
// approver options (the board's and the move sheet's approve sheets). The
// rows and names come from the session-shared members read
// (src/lib/workspace-members.ts: one membership read plus one batched profile
// read per user and workspace), so the Pipeline, Settings, the approve sheets,
// chat pickers and the comment @-picker opened in the same window ask once
// between them. The approvers are a subset of the active members whose
// profiles are read there anyway, so nothing extra is read. A failed read
// leaves the lists empty, so the copy falls back to "approvers" and "The
// creator".

import { useMemo } from 'react';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { isClient } from '@/components/pages/pcs/roles';
import { firstNameOf } from '@/components/pages/pipeline/card-status';
import { toApproverOptions, type ApproverOption } from '@/components/ui/OnBehalfApproveSheet';

interface WorkspacePeople {
  approverFirstNames: string[];
  /** Active members' display names by user id. */
  names: ReadonlyMap<string, string>;
  /**
   * The on-behalf picker's approvers (active client members with a name), the
   * same list useWorkspaceApprovers builds, from the same reads.
   */
  approvers: ApproverOption[];
}

const EMPTY: WorkspacePeople = { approverFirstNames: [], names: new Map(), approvers: [] };

/** Members as people: approvers' first names in member order plus every name. Pure. */
export function toWorkspacePeople(
  members: readonly { user_id: string; role: string | null; active: boolean }[],
  profiles: readonly { userId: string; displayName: string | null }[],
): WorkspacePeople {
  const active = members.filter((m) => m.active);
  const activeIds = new Set(active.map((m) => m.user_id));
  const names = new Map<string, string>();
  for (const profile of profiles) {
    // Only active members' names, as when only their profiles were read.
    if (!activeIds.has(profile.userId)) continue;
    if (profile.displayName !== null && profile.displayName.trim() !== '') {
      names.set(profile.userId, profile.displayName);
    }
  }
  const approverFirstNames = active
    .filter((m) => isClient(m.role))
    .map((m) => firstNameOf(names.get(m.user_id)))
    .filter((name) => name !== '');
  return { approverFirstNames, names, approvers: toApproverOptions(active, names) };
}

export function useWorkspacePeople(workspaceId: string | null): WorkspacePeople {
  const { rows, profiles, loading, error } = useWorkspaceMembers(workspaceId);
  return useMemo(
    () =>
      loading || error !== null || workspaceId === null
        ? EMPTY
        : toWorkspacePeople(rows, [...profiles.values()]),
    [rows, profiles, loading, error, workspaceId],
  );
}
