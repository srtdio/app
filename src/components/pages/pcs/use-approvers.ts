// The workspace's approvers for the on-behalf approve sheet: active client-role
// members with their display names, from the session-shared members read
// (src/lib/workspace-members.ts: one membership read plus one batched profile
// read per user and workspace), so every approve sheet, the Pipeline and
// Settings opened in the same window ask once between them. A failed read
// leaves the list empty (the sheet still approves, without a named approver).

import { useMemo } from 'react';
import type { ChatProfile } from '@/lib/chat-reads';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { toApproverOptions, type ApproverOption } from '@/components/ui/OnBehalfApproveSheet';

const NONE: ApproverOption[] = [];

/** Active client-role members with a name, in member order. Pure. */
export function approversFrom(
  rows: readonly { user_id: string; role: string | null; active: boolean }[],
  profiles: ReadonlyMap<string, ChatProfile>,
): ApproverOption[] {
  const active = rows.filter((m) => m.active && m.role === 'client');
  const names = new Map<string, string>();
  for (const m of active) {
    const profile = profiles.get(m.user_id);
    if (profile !== undefined) names.set(m.user_id, profile.displayName);
  }
  return toApproverOptions(active, names);
}

export function useWorkspaceApprovers(workspaceId: string | null): ApproverOption[] {
  const { rows, profiles, loading, error } = useWorkspaceMembers(workspaceId);
  return useMemo(
    () =>
      loading || error !== null || workspaceId === null ? NONE : approversFrom(rows, profiles),
    [rows, profiles, loading, error, workspaceId],
  );
}
