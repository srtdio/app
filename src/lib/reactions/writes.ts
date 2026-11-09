// Emoji reaction writes: the viewer's add or remove on one target, each with
// its explicit p_trace_id (uuid_v7). The actor is auth.uid() server-side;
// no user id is ever sent. Chat reuses its own record procs. Never throws.

import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { addReactionRecord, removeReactionRecord, type WriteResult } from '@/lib/chat/record';
import type { ReactionKind } from '@/lib/reactions/model';

type Functions = Database['public']['Functions'];

/** What a reaction lands on: a comment, a plan comment, or a chat message (with its channel). */
export type ReactionTarget =
  | { kind: Exclude<ReactionKind, 'chat'>; id: string }
  | { kind: 'chat'; id: string; channelId: string };

/** The proc a kind and op call (chat's two are its record helpers). Pure. */
export function reactionProc(
  kind: Exclude<ReactionKind, 'chat'>,
  op: 'add' | 'remove',
):
  | 'comment_reaction_add'
  | 'comment_reaction_remove'
  | 'plan_item_comment_reaction_add'
  | 'plan_item_comment_reaction_remove' {
  if (kind === 'comment') return op === 'add' ? 'comment_reaction_add' : 'comment_reaction_remove';
  return op === 'add' ? 'plan_item_comment_reaction_add' : 'plan_item_comment_reaction_remove';
}

/** Record the viewer's add or remove. */
export async function writeReaction(
  client: Client,
  target: ReactionTarget,
  emoji: string,
  op: 'add' | 'remove',
  traceId: string,
): Promise<WriteResult> {
  if (target.kind === 'chat') {
    const params = { client, channelId: target.channelId, messageId: target.id, emoji, traceId };
    return op === 'add' ? addReactionRecord(params) : removeReactionRecord(params);
  }
  const args: Functions['comment_reaction_add']['Args'] = {
    p_comment_id: target.id,
    p_emoji: emoji,
    p_trace_id: traceId,
  };
  try {
    const { error } = await client.rpc(reactionProc(target.kind, op), args);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}
