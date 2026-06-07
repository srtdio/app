// Realtime ingestion. Maps a Supabase postgres_changes payload to the typed
// ChangeEvent union the pipeline expects, and wires the six watched tables onto
// a single channel. Only the event types named in the EVENT MAP are forwarded;
// everything else (DELETEs, posts INSERTs, etc.) maps to null and is ignored.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import type {
  AssetRow,
  AssetVersionRow,
  BriefRow,
  ChangeEvent,
  CommentRow,
  PostRow,
  WorkspaceMemberRow,
} from '@srtdio/inbox';

export const WATCHED_TABLES = [
  'posts',
  'comments',
  'briefs',
  'assets',
  'asset_versions',
  'workspace_members',
] as const;

/** A postgres_changes payload, narrowed to the fields we read. */
export interface ChangePayload {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

export function mapChangePayload(payload: ChangePayload): ChangeEvent | null {
  const { table, eventType } = payload;
  switch (table) {
    case 'comments':
      if (eventType === 'INSERT') return { table, type: 'INSERT', row: payload.new as CommentRow };
      if (eventType === 'UPDATE')
        return {
          table,
          type: 'UPDATE',
          row: payload.new as CommentRow,
          old: payload.old as Partial<CommentRow>,
        };
      return null;
    case 'posts':
      if (eventType === 'UPDATE')
        return {
          table,
          type: 'UPDATE',
          row: payload.new as PostRow,
          old: payload.old as Partial<PostRow>,
        };
      return null;
    case 'briefs':
      if (eventType === 'INSERT') return { table, type: 'INSERT', row: payload.new as BriefRow };
      if (eventType === 'UPDATE')
        return {
          table,
          type: 'UPDATE',
          row: payload.new as BriefRow,
          old: payload.old as Partial<BriefRow>,
        };
      return null;
    case 'assets':
      if (eventType === 'INSERT') return { table, type: 'INSERT', row: payload.new as AssetRow };
      return null;
    case 'asset_versions':
      if (eventType === 'INSERT')
        return { table, type: 'INSERT', row: payload.new as AssetVersionRow };
      return null;
    case 'workspace_members':
      if (eventType === 'INSERT')
        return { table, type: 'INSERT', row: payload.new as WorkspaceMemberRow };
      return null;
    default:
      return null;
  }
}

/**
 * Subscribe to postgres_changes on every watched table and invoke `onEvent`
 * for each payload that maps to a fan-out trigger. Returns an unsubscribe fn.
 */
export function subscribeRealtime(
  client: SupabaseClient<Database>,
  onEvent: (event: ChangeEvent) => void | Promise<void>,
): () => void {
  const channel = client.channel('inbox-writer');
  for (const table of WATCHED_TABLES) {
    channel.on(
      // The realtime types are loose here; the payload shape is asserted in map.
      'postgres_changes' as never,
      { event: '*', schema: 'public', table } as never,
      (payload: ChangePayload) => {
        const event = mapChangePayload(payload);
        if (event) void onEvent(event);
      },
    );
  }
  channel.subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
