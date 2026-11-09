// Emoji reaction reads: ONE query per batch of targets (`<key> IN (...)`),
// never one per row, inside the chat read budget (5s). Post / brief comments
// read comment_reactions, plan comments plan_item_comment_reactions, chat
// chat_reactions; RLS decides what the viewer sees. Plus the who-reacted names
// for a target whose rows are already held (one batched profile read for the
// names the caller cannot give). Never throws.

import type { Client, Result } from '@srtdio/rpc';
import {
  abortable,
  readMentionProfiles,
  withReadTimeout,
  type ChatProfile,
} from '@/lib/chat-reads';
import type { ReactionKind, ReactionRow } from '@/lib/reactions/model';

/** Each kind's table and its target column. */
export const REACTION_SOURCE = {
  comment: { table: 'comment_reactions', key: 'comment_id' },
  'plan-comment': { table: 'plan_item_comment_reactions', key: 'comment_id' },
  chat: { table: 'chat_reactions', key: 'message_id' },
} as const satisfies Record<ReactionKind, { table: string; key: string }>;

interface RawRow {
  comment_id?: string;
  message_id?: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

/** Raw rows to ReactionRows for one kind. Pure. */
export function toReactionRows(kind: ReactionKind, raw: readonly RawRow[]): ReactionRow[] {
  const key = REACTION_SOURCE[kind].key;
  const out: ReactionRow[] = [];
  for (const row of raw) {
    const targetId = row[key];
    if (typeof targetId !== 'string') continue;
    out.push({ targetId, userId: row.user_id, emoji: row.emoji, createdAt: row.created_at });
  }
  return out;
}

/**
 * Every reaction on `ids` in one select (the chips order by created_at on the
 * device). An empty id list
 * answers at once with no round trip.
 */
export async function readReactions(
  client: Client,
  kind: ReactionKind,
  ids: readonly string[],
): Promise<Result<ReactionRow[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const { table, key } = REACTION_SOURCE[kind];
  return withReadTimeout(async (signal) => {
    const query = client
      .from(table)
      .select(`${key}, user_id, emoji, created_at`)
      .in(key, [...ids]);
    const res = await abortable(query, signal);
    if (res.error) {
      return {
        ok: false,
        error: { code: 'unknown', message: `readReactions: ${res.error.message}` },
      };
    }
    return { ok: true, data: toReactionRows(kind, (res.data ?? []) as unknown as RawRow[]) };
  });
}

/** The who-reacted model's input: rows plus names, as chat's sheet reads it. */
export interface WhoReactedData {
  rows: { userId: string; emoji: string; createdAt: string }[];
  profiles: Map<string, ChatProfile>;
  former: Set<string>;
}

/**
 * Names for rows already held: `known` first, the rest in one batched profile
 * read (never one per person). A failed name read still shows the reactions.
 */
export async function whoReactedFromRows(
  client: Client,
  params: {
    rows: readonly ReactionRow[];
    workspaceId: string | null;
    known: (userId: string) => ChatProfile | undefined;
  },
): Promise<Result<WhoReactedData>> {
  const profiles = new Map<string, ChatProfile>();
  const former = new Set<string>();
  const missing: string[] = [];
  for (const row of params.rows) {
    const hit = params.known(row.userId);
    if (hit !== undefined) profiles.set(row.userId, hit);
    else if (!missing.includes(row.userId)) missing.push(row.userId);
  }
  if (missing.length > 0 && params.workspaceId !== null) {
    const read = await readMentionProfiles(client, {
      workspaceId: params.workspaceId,
      userIds: missing,
      timeoutMs: 5_000,
    });
    if (read.ok) {
      for (const p of read.data) {
        if (p.member === false) former.add(p.userId);
        else profiles.set(p.userId, p);
      }
    }
  }
  return {
    ok: true,
    data: {
      rows: params.rows.map((r) => ({ userId: r.userId, emoji: r.emoji, createdAt: r.createdAt })),
      profiles,
      former,
    },
  };
}
