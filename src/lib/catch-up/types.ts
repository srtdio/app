// Shared catch-up contracts between the screen (owns every write) and the
// reply box (owns the field, the + tray, @, the mic and the voice draft).

/** What the reply box hands the screen on Send. */
export interface CatchUpSend {
  /** The typed text, trimmed ('' for a voice note or files only). */
  text: string;
  /** Files attached through the + tray (Photos, File, Assets), already uploaded. */
  attachmentAssetIds: string[];
  /** A recorded voice note (chat cards only), already uploaded; null when none. */
  voice: { assetId: string; durationMs: number } | null;
}

/** Where the reply goes: a chat (main or thread) or an item's comments. */
export type CatchUpReplyTarget =
  | { kind: 'chat'; channelId: string; threadRootId: string | null }
  | { kind: 'comment'; entityType: 'post' | 'brief'; entityId: string; parentCommentId: string | null }
  | { kind: 'plan-comment'; itemId: string };
