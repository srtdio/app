// A new group's Agora group is created by the chat-agora-sync cron up to ~60s
// after the group itself, and the client learns its agora_group_id only from a
// roster read. So on the thread's existing catch-up runs (60s interval, tab
// visible, back online, connected) the store checks the group rows the roster
// still has unsynced: one batched read of exactly those channels, and when any
// came back synced, the existing roster reload applies it (summaryChanged then
// switches an open chat to live in place). Nothing unsynced = no read at all.
// DMs and notes never count: they have no Agora group by design.

import type { Client, Result } from '@srtdio/rpc';
import { abortable, withReadTimeout, type ChannelSummary } from '@/lib/chat-reads';
import { isNotesChannelId } from '@/lib/chat/notes';

/** The roster's group channels with no agora_group_id yet. Pure. */
export function unsyncedGroupChannelIds(roster: Iterable<ChannelSummary>): string[] {
  const ids: string[] = [];
  for (const summary of roster) {
    if (summary.channelType !== 'group' || summary.agoraGroupId !== null) continue;
    if (isNotesChannelId(summary.channelId)) continue;
    ids.push(summary.channelId);
  }
  return ids;
}

export interface GroupSyncRow {
  channel_id: string;
  agora_group_id: string | null;
  last_synced_at: string | null;
}

/** One IN read of chat_channels (RLS) for the given channels' sync state, 5s budget. */
export function readGroupSyncRows(
  client: Client,
  channelIds: readonly string[],
): Promise<Result<GroupSyncRow[]>> {
  return withReadTimeout(async (signal) => {
    const res = await abortable(
      client
        .from('chat_channels')
        .select('channel_id, agora_group_id, last_synced_at')
        .in('channel_id', [...channelIds]),
      signal,
    );
    if (res.error) {
      return { ok: false, error: { code: 'unknown', message: res.error.message } };
    }
    return { ok: true, data: (res.data ?? []) as GroupSyncRow[] };
  });
}

export type GroupSyncOutcome = 'none' | 'busy' | 'pending' | 'reloaded' | 'failed';

export interface GroupSyncCheck {
  /** Check the roster's unsynced groups once; overlapping calls are skipped. */
  run: () => Promise<GroupSyncOutcome>;
  /** Workspace switch or unmount: a read still in flight no longer reloads. */
  dispose: () => void;
}

/**
 * The single-flight check. `roster` is read at call time (the store's current
 * summaries); `reload` is the store's existing roster reload request.
 */
export function createGroupSyncCheck(deps: {
  roster: () => Iterable<ChannelSummary>;
  read: (channelIds: readonly string[]) => Promise<Result<GroupSyncRow[]>>;
  reload: () => void;
  onError?: (context: Record<string, unknown>) => void;
}): GroupSyncCheck {
  let disposed = false;
  let inFlight = false;
  return {
    run: async () => {
      if (disposed) return 'none';
      const ids = unsyncedGroupChannelIds(deps.roster());
      if (ids.length === 0) return 'none';
      if (inFlight) return 'busy';
      inFlight = true;
      try {
        const result = await deps.read(ids);
        if (disposed) return 'none';
        if (!result.ok) {
          deps.onError?.({ error: result.error.message });
          return 'failed';
        }
        if (!result.data.some((row) => row.agora_group_id !== null)) return 'pending';
        deps.reload();
        return 'reloaded';
      } finally {
        inFlight = false;
      }
    },
    dispose: () => {
      disposed = true;
    },
  };
}
