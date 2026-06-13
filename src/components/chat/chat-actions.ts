// Chat group/DM management actions. Each function maps the UI's params onto the
// generated proc-arg shape and calls the matching @srtdio/rpc wrapper as-is (the
// wrappers are not modified here), then invokes a success callback. They return
// the wrapper's DomainError on an expected failure and never throw, so the UI
// branches on the return value (inline error) instead of catching. The trace id
// is minted at the action boundary by the caller (useNewTrace) and passed in.
//
// Kept free of React so every branch is unit-tested under the node test job with
// the wrappers and client mocked and no DOM. The actor is resolved server-side
// by the procs; only the explicit targets (DM peer, members) are passed.

import type { Client, DomainError } from '@srtdio/rpc';
import {
  dmChannelEnsure,
  groupCreate,
  groupLeave,
  groupMemberAdd,
  groupMemberRemove,
  groupRename,
} from '@srtdio/rpc';

/** Ensure (create or reuse) the DM channel with one peer, then open it. */
export async function startDmChannel(
  client: Client,
  params: { workspaceId: string; peerUserId: string; traceId: string },
  onOpen: (channelId: string) => void,
): Promise<DomainError | null> {
  const result = await dmChannelEnsure(client, {
    p_workspace_id: params.workspaceId,
    p_other_user_id: params.peerUserId,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onOpen(result.data);
  return null;
}

/** Create a group with its initial members in a single call (no per-member loop). */
export async function createGroupChannel(
  client: Client,
  params: { workspaceId: string; name: string; memberUserIds: string[]; traceId: string },
  onCreated: (groupId: string) => void,
): Promise<DomainError | null> {
  const result = await groupCreate(client, {
    p_workspace_id: params.workspaceId,
    p_name: params.name,
    p_member_user_ids: params.memberUserIds,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onCreated(result.data);
  return null;
}

/** Rename a group. */
export async function renameGroupChannel(
  client: Client,
  params: { groupId: string; name: string; traceId: string },
  onDone: () => void,
): Promise<DomainError | null> {
  const result = await groupRename(client, {
    p_group_id: params.groupId,
    p_name: params.name,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onDone();
  return null;
}

/** Add one member to a group by Sorted user id. */
export async function addGroupMember(
  client: Client,
  params: { groupId: string; userId: string; traceId: string },
  onDone: () => void,
): Promise<DomainError | null> {
  const result = await groupMemberAdd(client, {
    p_group_id: params.groupId,
    p_user_id: params.userId,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onDone();
  return null;
}

/** Remove one member from a group by Sorted user id. */
export async function removeGroupMember(
  client: Client,
  params: { groupId: string; userId: string; traceId: string },
  onDone: () => void,
): Promise<DomainError | null> {
  const result = await groupMemberRemove(client, {
    p_group_id: params.groupId,
    p_user_id: params.userId,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onDone();
  return null;
}

/** Leave a group (self only; the proc resolves the actor). */
export async function leaveGroupChannel(
  client: Client,
  params: { groupId: string; traceId: string },
  onDone: () => void,
): Promise<DomainError | null> {
  const result = await groupLeave(client, {
    p_group_id: params.groupId,
    p_trace_id: params.traceId,
  });
  if (!result.ok) return result.error;
  onDone();
  return null;
}
