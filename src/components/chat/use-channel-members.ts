// The people the mention picker offers in one chat: a group's current members
// or a DM's other person, never the viewer. Two reads at most, both batched: the
// group's member ids (listGroupMemberIds, groups only) and one readChatMembers
// (users IN + workspace_members IN, active only). Loaded once per chat open;
// the names also go to the mention registry so the chat list's "Draft:" line
// resolves a draft's tokens. Both reads share one 5s budget (withReadTimeout
// with the time left): a hang is a failed read, so the composer's hold always
// releases within 5s overall.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import {
  listGroupMemberIds,
  READ_TIMEOUT_MS,
  readChatMembers,
  withReadTimeout,
  type ChatMember,
} from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';
import { isFormerMember, rememberMentionNames, type MentionMember } from '@/lib/chat/mentions';

/** Which chat to list: a group by its Sorted group id, or a DM by its peer. */
export interface ChannelMembersInput {
  workspaceId: string | null;
  currentUserId: string | null;
  groupId: string | null;
  peerUserId: string | null;
}

/** The two reads, injected so the rules are unit-tested without a client. */
export interface ChannelMemberReaders {
  groupMemberIds: (groupId: string, signal?: AbortSignal) => Promise<Result<string[]>>;
  members: (
    workspaceId: string,
    userIds: string[],
    signal?: AbortSignal,
  ) => Promise<Result<ChatMember[]>>;
}

/** One chat's member list: loaded, or failed (a read error or a 5s timeout). */
export type ChannelMembersLoad = { ok: true; members: MentionMember[] } | { ok: false };

/** Milliseconds left before `deadline` (never negative). */
function budgetLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function channelMemberIdsResult(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
  deadline: number = Date.now() + READ_TIMEOUT_MS,
): Promise<Result<string[]>> {
  if (input.groupId !== null) {
    const groupId = input.groupId;
    const ids = await withReadTimeout(
      (signal) => readers.groupMemberIds(groupId, signal),
      budgetLeft(deadline),
    );
    if (!ids.ok) {
      logger.warn('chat: mention members read failed', { error: ids.error.message });
      return ids;
    }
    return { ok: true, data: ids.data.filter((id) => id !== input.currentUserId) };
  }
  return {
    ok: true,
    data:
      input.peerUserId !== null && input.peerUserId !== input.currentUserId
        ? [input.peerUserId]
        : [],
  };
}

/** The candidate ids: the group's members, or the DM peer; never the viewer. */
export async function channelMemberIds(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
): Promise<string[]> {
  const ids = await channelMemberIdsResult(input, readers);
  return ids.ok ? ids.data : [];
}

/**
 * Load one chat's picker rows, keeping a failure (read error or timeout) apart
 * from an empty list: only a successful read may say someone left. Never throws.
 */
export async function loadChannelMembersResult(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
): Promise<ChannelMembersLoad> {
  if (input.workspaceId === null) return { ok: true, members: [] };
  const workspaceId = input.workspaceId;
  // One deadline for both reads: the second only gets what the first left.
  const deadline = Date.now() + READ_TIMEOUT_MS;
  const ids = await channelMemberIdsResult(input, readers, deadline);
  if (!ids.ok) return { ok: false };
  if (ids.data.length === 0) return { ok: true, members: [] };
  const result = await withReadTimeout(
    (signal) => readers.members(workspaceId, ids.data, signal),
    budgetLeft(deadline),
  );
  if (!result.ok) {
    logger.warn('chat: mention member profiles read failed', { error: result.error.message });
    return { ok: false };
  }
  return {
    ok: true,
    members: result.data.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      username: m.username ?? null,
      role: m.role,
    })),
  };
}

/** Load the picker rows for one chat; a failed read yields none (logged). */
export async function loadChannelMembers(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
): Promise<MentionMember[]> {
  const load = await loadChannelMembersResult(input, readers);
  return load.ok ? load.members : [];
}

/**
 * Whether a stored mention's person is confirmed gone from this chat: only a
 * SUCCESSFUL read says so, the member read not listing them or a mention
 * profile read finding them without an active membership (isFormerMember).
 * Loading or a failed read confirms nothing, so their mention is kept.
 */
export function mentionGone(
  load: ChannelMembersLoad | null,
  selfId: string | null,
  workspaceId: string | null,
): (userId: string) => boolean {
  // Only this workspace's former flags count: one learned elsewhere never drops anyone here.
  const former = (userId: string): boolean => isFormerMember(workspaceId, userId);
  if (load === null || !load.ok) return (userId) => userId !== selfId && former(userId);
  const ids = new Set(load.members.map((m) => m.userId));
  return (userId) => userId !== selfId && (!ids.has(userId) || former(userId));
}

const READERS: ChannelMemberReaders = {
  groupMemberIds: (groupId, signal) =>
    listGroupMemberIds(supabase, { groupId, ...(signal !== undefined ? { signal } : {}) }),
  members: (workspaceId, userIds, signal) =>
    readChatMembers(supabase, {
      workspaceId,
      userIds,
      ...(signal !== undefined ? { signal } : {}),
    }),
};

/**
 * The open chat's member list as loaded (ok or failed): null until the list
 * for THIS chat has settled, so the composer knows when its names are in; a
 * previous chat's list never counts. A timeout or a rejection settles it as
 * failed, so it never stays null.
 */
export function useChannelMembersState(input: ChannelMembersInput): ChannelMembersLoad | null {
  const [loaded, setLoaded] = useState<{ key: string; load: ChannelMembersLoad } | null>(null);
  const { workspaceId, currentUserId, groupId, peerUserId } = input;
  const key = [workspaceId, currentUserId, groupId, peerUserId].join('|');
  useEffect(() => {
    let cancelled = false;
    void loadChannelMembersResult({ workspaceId, currentUserId, groupId, peerUserId }, READERS)
      .catch((error: unknown): ChannelMembersLoad => {
        logger.warn('chat: mention members load threw', { error: String(error) });
        return { ok: false };
      })
      .then((next) => {
        if (cancelled) return;
        if (next.ok) rememberMentionNames(workspaceId, next.members);
        setLoaded({ key, load: next });
      });
    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, currentUserId, groupId, peerUserId]);
  return loaded !== null && loaded.key === key ? loaded.load : null;
}

/**
 * The mention picker's people for the open chat: null until the list for THIS
 * chat has settled (loaded, or failed to []).
 */
export function useChannelMembers(input: ChannelMembersInput): MentionMember[] | null {
  const load = useChannelMembersState(input);
  return load === null ? null : load.ok ? load.members : [];
}
