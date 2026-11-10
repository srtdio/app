import type { MentionPick } from '@/lib/chat/mentions';

// Shared catch-up contracts between the screen (owns every write) and the
// reply box (owns the field, the + tray, @, the mic and the voice draft).

/** What the reply box hands the screen on Send. */
export interface CatchUpSend {
  /** The typed text, trimmed ('' for a voice note or files only). */
  text: string;
  /** Files attached through the + tray (Photos, File, Assets), already uploaded. */
  attachmentAssetIds: string[];
  /** A recorded voice note (chat cards only), already uploaded; null when none. */
  voice: {
    assetId: string;
    durationMs: number;
    /** The file's type, name, size and waveform: the chat bubble reads them back (attachment_meta). */
    mime?: string;
    name?: string;
    size?: number;
    peaks?: number[];
  } | null;
}

/** Where the reply goes: a chat (main or thread) or an item's comments. */
export type CatchUpReplyTarget =
  | { kind: 'chat'; channelId: string; threadRootId: string | null }
  | {
      kind: 'comment';
      entityType: 'post' | 'brief';
      entityId: string;
      parentCommentId: string | null;
    }
  | { kind: 'plan-comment'; itemId: string };

/** A reply box's movable draft (text + @ picks); it moves into the thread sheet and back. */
export interface CatchUpDraft {
  text: string;
  picks: readonly MentionPick[];
}

export const EMPTY_DRAFT: CatchUpDraft = { text: '', picks: [] };

/** Per parent: up to 2 unique repliers (newest first) and the newest reply's time. */
export interface ReplyInfo {
  repliers: string[];
  lastAt: string;
}

/** Reply counts and per-parent ReplyInfo from the reply rows (any order). Pure. */
export function replyStatsOf(
  rows: readonly { parent: string | null; author: string | null; at: string }[],
): { counts: Map<string, number>; info: Map<string, ReplyInfo> } {
  const counts = new Map<string, number>();
  const info = new Map<string, ReplyInfo>();
  const newestFirst = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const r of newestFirst) {
    if (r.parent === null) continue;
    counts.set(r.parent, (counts.get(r.parent) ?? 0) + 1);
    const got = info.get(r.parent) ?? { repliers: [], lastAt: r.at };
    if (r.author !== null && got.repliers.length < 2 && !got.repliers.includes(r.author))
      got.repliers.push(r.author);
    info.set(r.parent, got);
  }
  return { counts, info };
}
