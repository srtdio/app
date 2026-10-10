// Framework-agnostic message-thread model. Postgres (public.chat_messages) is
// the chat record and the only history read path; Agora is live delivery only.
// This module holds the pure pieces: the rendered message shape, the mapping
// from a chat_messages row and from a live Agora event, the live `ext` contract
// that carries the Sorted ids on every Agora message, keyset cursors for
// pagination and catch-up, and the pure list transitions (merge, upsert, state,
// reactions, read ticks, deletes). The SDK connection and message factory are injected,
// so every branch is unit-tested under the node test job with no SDK and no DOM.
//
// Agora type names are taken verbatim from the installed agora-chat 1.3.1
// typings (`import type { AgoraChat }`): the connection exposes
// `send(MessageBody)`, incoming text arrives on `onTextMessage(TextMsgBody)` and
// incoming command messages on `onCmdMessage(CmdMsgBody)`.

import type { AgoraChat } from 'agora-chat';
import { truncateBody } from '@/lib/chat/mentions';
import { awaitsRootHydration } from '@/lib/chat/thread-rail';
import type { Database } from '@srtdio/schemas';
import type { ChatConnection } from '@/lib/chat/types';
import { toAgoraUsername, userIdFromAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  buildMessageExt,
  classifyAttachment,
  parseAttachmentMeta,
  parseForwardedFrom,
  parseAttachments,
  parseReply,
  parseSharedPostIds,
  type MessageAttachment,
  type MessageExt,
  type ReplyQuote,
} from '@/lib/chat/attachments';

/** One chat_messages row as PostgREST returns it. */
export type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row'];

/** Our own SDK event-handler id, separate from the Foundation's 'sorted-chat'. */
export const THREAD_EVENT_HANDLER_ID = 'chat-thread';

export type ThreadChatType = 'singleChat' | 'groupChat';

/**
 * Where a message sits on its way to the record. 'sending' is the optimistic
 * bubble before chat_message_send returns, 'sent' means the row exists in
 * Postgres (whatever Agora did), 'failed' means the proc failed or timed out and
 * the bubble offers Retry with the same id.
 */
export type MessageState = 'sending' | 'sent' | 'failed';

/** Read state of an own message, advanced monotonically by the peer's cursor. */
export type MessageStatus = 'sent' | 'read';

/** Where a channel's live messages are delivered on the Agora side. */
export interface ChannelTarget {
  targetId: string;
  chatType: ThreadChatType;
  /**
   * A group whose Agora group is not synced yet: the Agora usernames of its
   * members (sender excluded) each get the message once as singleChat,
   * carrying the same ext. `targetId` is then the Sorted channel id and is
   * never sent to. Absent for a synced group or a DM.
   */
  fanout?: readonly string[];
}

/** An unsynced group's live fan-out is skipped above this many recipients. */
export const MAX_FANOUT = 50;

/**
 * The fan-out target for a group whose Agora group is not synced yet: one
 * singleChat per member (deduped, the sender excluded). Null when there is no
 * one to reach or more than MAX_FANOUT recipients (the live publish is then
 * skipped; receivers catch up from Postgres). Pure.
 */
export function fanoutTarget(
  channelId: string,
  memberUserIds: readonly string[],
  currentUserId: string,
): ChannelTarget | null {
  const recipients = [...new Set(memberUserIds)].filter((id) => id !== currentUserId).sort();
  if (recipients.length === 0 || recipients.length > MAX_FANOUT) return null;
  return { targetId: channelId, chatType: 'singleChat', fanout: recipients.map(toAgoraUsername) };
}

/** Whether two targets route the same way (same recipient(s), same chat type). Pure. */
export function sameTarget(a: ChannelTarget | null, b: ChannelTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.targetId !== b.targetId || a.chatType !== b.chatType) return false;
  if (a.fanout === undefined || b.fanout === undefined) return a.fanout === b.fanout;
  return a.fanout.length === b.fanout.length && a.fanout.every((to, i) => to === b.fanout?.[i]);
}

/** The `ext` key every live message carries the sender's current workspace under. */
export const LIVE_WORKSPACE_KEY = 'sorted_workspace_id';

// The workspace the chat store is in, stamped on every live send. Set by the
// store on each workspace (null outside one); never hardcoded.
let liveWorkspaceId: string | null = null;

/** Set (or clear) the workspace every live send is stamped with. */
export function setLiveWorkspaceId(workspaceId: string | null): void {
  liveWorkspaceId = workspaceId;
}

/** The workspace a live message names on its ext; null when absent (older client). */
export function extWorkspaceId(ext: unknown): string | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const value = (ext as Record<string, unknown>)[LIVE_WORKSPACE_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A live message from another workspace than the current one (absent = not foreign). Pure. */
export function isForeignWorkspace(ext: unknown, currentWorkspaceId: string | null): boolean {
  const named = extWorkspaceId(ext);
  return named !== null && currentWorkspaceId !== null && named !== currentWorkspaceId;
}

/** Stamp the current workspace onto a built message's ext (in place). */
function stampWorkspace(message: AgoraChat.MessageBody): AgoraChat.MessageBody {
  if (liveWorkspaceId === null) return message;
  const carrier = message as { ext?: Record<string, unknown> };
  carrier.ext = { ...(carrier.ext ?? {}), [LIVE_WORKSPACE_KEY]: liveWorkspaceId };
  return message;
}

/** The `send` member every live publish goes through. */
export interface LiveSendConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/**
 * Send one live message to a target: once to the group or peer, or, for a
 * fan-out target, once per member as singleChat (the builder gets each
 * recipient). Every message carries the current workspace on its ext. A fan-out resolves with the first delivery and rejects only when
 * every delivery failed.
 */
export async function sendRouted(
  connection: LiveSendConnection,
  target: ChannelTarget,
  build: (to: string, chatType: ThreadChatType) => AgoraChat.MessageBody,
): Promise<AgoraChat.SendMsgResult> {
  if (target.fanout === undefined) {
    return connection.send(stampWorkspace(build(target.targetId, target.chatType)));
  }
  const results = await Promise.allSettled(
    target.fanout.map((to) =>
      Promise.resolve().then(() => connection.send(stampWorkspace(build(to, 'singleChat')))),
    ),
  );
  const delivered = results.find(
    (r): r is PromiseFulfilledResult<AgoraChat.SendMsgResult> => r.status === 'fulfilled',
  );
  if (delivered !== undefined) return delivered.value;
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  throw failed !== undefined && failed.reason instanceof Error
    ? failed.reason
    : new Error('live fan-out failed');
}

/** One emoji reaction on a message, aggregated across users. */
export interface MessageReaction {
  emoji: string;
  count: number;
  /** True when the current user is among the reactors (tap again to remove). */
  mine: boolean;
}

/** A message as the thread UI renders it. */
export interface ThreadMessage {
  /** The Sorted id (client-generated uuid_v7, the chat_messages primary id). */
  id: string;
  /** Sorted user id, or null when the sender is unknown (deleted account, unmappable). */
  senderUserId: string | null;
  body: string;
  /**
   * Server created_at as stored (verbatim string, used for the keyset cursor).
   * For a live message not yet fetched from Postgres it is derived from the
   * Agora server time and `provisionalTime` is true until the next catch-up.
   */
  createdAt: string;
  /** Epoch ms of createdAt, used only for ordering and read-tick comparison. */
  time: number;
  /** True while `createdAt` comes from Agora (or a pending send), not Postgres. */
  provisionalTime: boolean;
  /**
   * An unrecorded own send: the estimated server time of its Send tap (device
   * clock + the server clock offset known then), which its time label shows
   * until the row lands (createdAt stays '' until then).
   */
  estimatedMs?: number;
  /** True when the current user sent it (own bubble). */
  mine: boolean;
  /** Asset attachments; from the row's ids + attachment_meta, or the live `ext`. */
  attachments: MessageAttachment[];
  /** Shared post uuids (row `shared_post_ids` or live `ext`); empty when there are none. */
  sharedPostIds: string[];
  /** Shared brief uuids (row `shared_brief_ids`); empty when there are none. */
  sharedBriefIds: string[];
  /**
   * Shared plan uuids (row `shared_plan_ids`, written only by chat_plan_share);
   * absent or empty when there are none. Never sent live or from the outbox.
   */
  sharedPlanIds?: string[];
  /** The quoted message when this is a reply; null otherwise. */
  reply: ReplyQuote | null;
  /**
   * The quoted message's shared post ids, carried by reply hydration so a reply
   * to a card message renders its KEY chip even when the card is not loaded.
   * Absent when unknown or when the quoted message shares no posts.
   */
  parentSharedPostIds?: string[];
  /**
   * The top-level message of this reply's thread (row thread_root_message_id,
   * set by the record's trigger; on an own unrecorded send, the root the
   * sender derived). Null when this is not a reply; absent when unknown.
   */
  threadRootId?: string | null;
  /**
   * The thread root's shared post ids when the root is not loaded, filled by
   * reply hydration (empty: the root shares no post, is deleted or not
   * visible). Absent until hydrated, or when the root is loaded.
   */
  rootPostIds?: string[];
  state: MessageState;
  /** Read state; rendered as ticks for own DM messages only. */
  status: MessageStatus;
  /** Emoji reactions on this message; empty when there are none. */
  reactions: MessageReaction[];
  /** True when this message was forwarded from another; absent is the same as false. */
  forwarded?: boolean;
  /**
   * The source message's id when read from the record (forwarded_from_message_id);
   * notes use it for the "Saved from" line. Absent on live copies.
   */
  forwardedFromId?: string;
  /**
   * An own unrecorded send whose picked files were lost to a reload: it reads
   * "Photos not sent" and offers Remove only. Absent is the same as false.
   */
  filesMissing?: boolean;
  /** Server edited_at when the body was edited; absent is the same as null. */
  editedAt?: string | null;
  /**
   * Deleted for everyone: renders as a tombstone (deletedMessageLabel) with no
   * content, reactions, menu, swipe-reply or selection. Absent is the same as false.
   */
  deleted?: boolean;
  /** This is a reply whose quoted message was deleted; absent is the same as false. */
  parentDeleted?: boolean;
  /**
   * The stored chat_messages.mentions: the server-expanded user ids ("@all"
   * already expanded to its recipients), null when the row has none (a
   * forward). Absent while the row has not been read from Postgres (live).
   */
  mentions?: string[] | null;
}

/** A row's stored mentions as user ids (lowercase); null when it has none. */
export function storedMentions(raw: ChatMessageRow['mentions']): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase());
}

/**
 * The preview a quote of a deleted message carries in the data. Never shown:
 * every surface reads {@link deletedMessageLabel} instead.
 */
export const DELETED_MESSAGE_LABEL = 'Message deleted';

/** What your own deleted message (its tombstone, or a quote of it) reads. */
export const DELETED_OWN_LABEL = 'You deleted this message';

/** What someone else's deleted message (its tombstone, or a quote of it) reads. */
export const DELETED_OTHER_LABEL = 'This message was deleted';

/** The deleted-message line for a message by the viewer (own) or anyone else. Pure. */
export function deletedMessageLabel(author: { mine: boolean }): string {
  return author.mine ? DELETED_OWN_LABEL : DELETED_OTHER_LABEL;
}

/**
 * The connection surface the thread drives: the Foundation ChatConnection plus
 * `send`, the one messaging member it does not expose. It extends ChatConnection
 * so the Foundation client casts to it structurally, without `unknown` or `any`.
 */
export interface ThreadConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/**
 * The `ext` keys every live Agora message carries so receivers can dedupe
 * against the record and route to a channel without an Agora-side lookup.
 */
export const LIVE_MESSAGE_ID_KEY = 'sorted_message_id';
export const LIVE_CHANNEL_ID_KEY = 'sorted_channel_id';
/** The `ext` key naming a live-only signal on a command message. */
export const LIVE_EVENT_KEY = 'sorted_event';
/**
 * The `ext` key carrying a reply's thread root, as the sender derived it. Only
 * own unrecorded rows and the store's previews read it; the open thread
 * renders live rows from their verified record row, which carries the root.
 */
export const LIVE_THREAD_ROOT_KEY = 'sorted_thread_root_id';

/** The thread root a live message names on its ext; null when absent. */
export function parseLiveThreadRoot(ext: unknown): string | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const value = (ext as Record<string, unknown>)[LIVE_THREAD_ROOT_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The Sorted ids stamped on a live text message. */
export interface LiveMessageIds {
  sorted_message_id: string;
  sorted_channel_id: string;
}

/** The ext carried on a live text message: content + the Sorted ids. */
export type LiveTextExt = MessageExt & LiveMessageIds;

/** Injected `AgoraChat.message.create` for text; keeps the SDK out of this module. */
export type CreateTextMessage = (options: {
  chatType: ThreadChatType;
  type: 'txt';
  to: string;
  msg: string;
  /** Custom extension carried on the message; omitted for a bare text send. */
  ext?: MessageExt | LiveTextExt;
}) => AgoraChat.MessageBody;

/**
 * Resolve a channel to its Agora target. Group channels message the synced Agora
 * group id; DM channels message the peer's derived Agora username. Returns null
 * when the channel cannot be opened yet (group not synced, peer unknown), which
 * the UI renders as a Postgres-only thread (history and sends still work).
 */
export function targetFromSummary(summary: ChannelSummary): ChannelTarget | null {
  switch (summary.channelType) {
    case 'group':
      return summary.agoraGroupId !== null
        ? { targetId: summary.agoraGroupId, chatType: 'groupChat' }
        : null;
    case 'dm':
      return summary.peerUserId !== null
        ? { targetId: toAgoraUsername(summary.peerUserId), chatType: 'singleChat' }
        : null;
    case 'notes':
      // Notes never go live: Postgres only, synced by catch-up.
      return null;
  }
}

/** Read the Sorted ids off a live message's `ext`; absent on pre-rewrite clients. */
export function parseLiveIds(ext: unknown): { ok: true; ids: LiveMessageIds } | { ok: false } {
  if (typeof ext !== 'object' || ext === null) return { ok: false };
  const record = ext as Record<string, unknown>;
  const messageId = record[LIVE_MESSAGE_ID_KEY];
  const channelId = record[LIVE_CHANNEL_ID_KEY];
  if (typeof messageId !== 'string' || messageId === '') return { ok: false };
  if (typeof channelId !== 'string' || channelId === '') return { ok: false };
  return { ok: true, ids: { sorted_message_id: messageId, sorted_channel_id: channelId } };
}

/** A live-only signal carried on a command message's `ext`. */
export type LiveEvent =
  | { kind: 'reaction'; messageId: string; emoji: string; op: 'add' | 'remove' }
  | { kind: 'read'; channelId: string; messageId: string }
  | { kind: 'mark'; messageId: string }
  | { kind: 'delete'; messageIds: string[] }
  | { kind: 'edit'; messageId: string; body: string; editedAt: string }
  | { kind: 'unknown' };

/** Read a live signal off a command message's `ext`; 'unknown' for anything else. */
export function parseLiveEvent(ext: unknown): LiveEvent {
  if (typeof ext !== 'object' || ext === null) return { kind: 'unknown' };
  const record = ext as Record<string, unknown>;
  const event = record[LIVE_EVENT_KEY];
  if (event === 'delete') {
    const ids = record.message_ids;
    if (!Array.isArray(ids)) return { kind: 'unknown' };
    const messageIds = ids.filter((id): id is string => typeof id === 'string' && id !== '');
    return messageIds.length > 0 ? { kind: 'delete', messageIds } : { kind: 'unknown' };
  }
  if (event === 'edit') {
    const ids = record.message_ids;
    const body = record.body;
    const editedAt = record.edited_at;
    if (!Array.isArray(ids) || ids.length !== 1) return { kind: 'unknown' };
    const id: unknown = ids[0];
    if (typeof id !== 'string' || id === '') return { kind: 'unknown' };
    if (typeof body !== 'string') return { kind: 'unknown' };
    if (typeof editedAt !== 'string' || Number.isNaN(Date.parse(editedAt))) {
      return { kind: 'unknown' };
    }
    return { kind: 'edit', messageId: id, body, editedAt };
  }
  const messageId = record.message_id;
  if (typeof messageId !== 'string' || messageId === '') return { kind: 'unknown' };
  if (event === 'mark') return { kind: 'mark', messageId };
  if (event === 'reaction') {
    const emoji = record.emoji;
    const op = record.op;
    if (typeof emoji !== 'string' || emoji === '') return { kind: 'unknown' };
    if (op !== 'add' && op !== 'remove') return { kind: 'unknown' };
    return { kind: 'reaction', messageId, emoji, op };
  }
  if (event === 'read') {
    const channelId = record.channel_id;
    if (typeof channelId !== 'string' || channelId === '') return { kind: 'unknown' };
    return { kind: 'read', channelId, messageId };
  }
  return { kind: 'unknown' };
}

/** Build the `ext` for a live reaction signal. */
export function reactionEventExt(input: {
  messageId: string;
  emoji: string;
  op: 'add' | 'remove';
}): Record<string, unknown> {
  return {
    [LIVE_EVENT_KEY]: 'reaction',
    message_id: input.messageId,
    emoji: input.emoji,
    op: input.op,
  };
}

/** Build the `ext` for a live read-position signal. */
export function readEventExt(input: {
  channelId: string;
  messageId: string;
}): Record<string, unknown> {
  return { [LIVE_EVENT_KEY]: 'read', channel_id: input.channelId, message_id: input.messageId };
}

/** Build the `ext` for a live mark signal (receivers re-read that one mark row). */
export function markEventExt(input: { messageId: string }): Record<string, unknown> {
  return { [LIVE_EVENT_KEY]: 'mark', message_id: input.messageId };
}

/** Build the `ext` for a live delete signal (receivers turn these ids into tombstones). */
export function deleteEventExt(input: { messageIds: readonly string[] }): Record<string, unknown> {
  return { [LIVE_EVENT_KEY]: 'delete', message_ids: [...input.messageIds] };
}

/** Build the `ext` for a live edit signal: one id, the recorded body and edited_at. */
export function editEventExt(input: {
  messageId: string;
  body: string;
  editedAt: string;
}): Record<string, unknown> {
  return {
    [LIVE_EVENT_KEY]: 'edit',
    message_ids: [input.messageId],
    body: input.body,
    edited_at: input.editedAt,
  };
}

/** Sender-side content the row does not carry, kept from the local send. */
export interface LocalMessageContent {
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  /** Shared brief uuids; absent is the same as none. */
  sharedBriefIds?: readonly string[];
  reply: ReplyQuote | null;
  /**
   * Save to notes: the source message's id (p_forwarded_from_message_id). A
   * send that carries it sends no mentions. Absent on ordinary sends.
   */
  forwardedFromMessageId?: string;
}

/**
 * Map one chat_messages row to the rendered shape. Attachments come from
 * `attachment_asset_ids` enriched by `attachment_meta` (mime, name, transcript),
 * shared posts from `shared_post_ids`, and a reply from `reply_to_message_id`,
 * so a message read from Postgres renders exactly as it did live. The row keeps
 * only the quoted id, so its quote starts unresolved (empty preview) until
 * {@link hydrateReplies} fills it. Local content (own send echo) wins when set.
 */
export function rowToThreadMessage(
  row: ChatMessageRow,
  currentUserId: string,
  local?: LocalMessageContent,
): ThreadMessage {
  const senderUserId = row.sender_user_id;
  if (row.deleted_at !== null) return tombstoneFromRow(row, currentUserId);
  const attachments =
    local !== undefined && local.attachments.length > 0
      ? [...local.attachments]
      : parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []);
  const sharedPostIds =
    local !== undefined && local.sharedPostIds.length > 0
      ? [...local.sharedPostIds]
      : [...(row.shared_post_ids ?? [])];
  const localBriefs = local?.sharedBriefIds ?? [];
  const sharedBriefIds =
    localBriefs.length > 0 ? [...localBriefs] : [...(row.shared_brief_ids ?? [])];
  const sharedPlanIds = [...(row.shared_plan_ids ?? [])];
  const reply =
    local?.reply ??
    (row.reply_to_message_id !== null && row.reply_to_message_id !== ''
      ? { id: row.reply_to_message_id, authorUserId: null, preview: '' }
      : null);
  const root = rowThreadRoot(row);
  return {
    ...(root !== null ? { threadRootId: root } : {}),
    id: row.id,
    senderUserId,
    body: row.body ?? '',
    createdAt: row.created_at,
    time: Date.parse(row.created_at),
    provisionalTime: false,
    mine: senderUserId !== null && senderUserId === currentUserId,
    attachments,
    sharedPostIds,
    sharedBriefIds,
    ...(sharedPlanIds.length > 0 ? { sharedPlanIds } : {}),
    reply,
    state: 'sent',
    status: 'sent',
    reactions: [],
    editedAt: row.edited_at,
    deleted: false,
    mentions: storedMentions(row.mentions),
    ...(row.forwarded_from_message_id != null && row.forwarded_from_message_id !== ''
      ? { forwarded: true, forwardedFromId: row.forwarded_from_message_id }
      : {}),
  };
}

/** A row's thread root; a row read without the column (an older select) reads as none. */
function rowThreadRoot(row: ChatMessageRow): string | null {
  const root: string | null | undefined = row.thread_root_message_id;
  return root !== undefined && root !== null && root !== '' ? root : null;
}

/**
 * A deleted row: keeps its id, sender, time, side and thread root (a deleted
 * reply stays in its thread as a tombstone); no content of any kind.
 */
function tombstoneFromRow(row: ChatMessageRow, currentUserId: string): ThreadMessage {
  const senderUserId = row.sender_user_id;
  const root = rowThreadRoot(row);
  return {
    ...(root !== null ? { threadRootId: root } : {}),
    id: row.id,
    senderUserId,
    body: '',
    createdAt: row.created_at,
    time: Date.parse(row.created_at),
    provisionalTime: false,
    mine: senderUserId !== null && senderUserId === currentUserId,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    editedAt: row.edited_at,
    deleted: true,
  };
}

/** The same message as a tombstone: content, reactions and quote cleared; the thread root stays. */
function asTombstone(message: ThreadMessage): ThreadMessage {
  return {
    ...(message.threadRootId !== undefined ? { threadRootId: message.threadRootId } : {}),
    ...(message.rootPostIds !== undefined ? { rootPostIds: message.rootPostIds } : {}),
    id: message.id,
    senderUserId: message.senderUserId,
    body: '',
    createdAt: message.createdAt,
    time: message.time,
    provisionalTime: message.provisionalTime,
    mine: message.mine,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: message.state,
    status: message.status,
    reactions: [],
    editedAt: message.editedAt ?? null,
    deleted: true,
  };
}

/** The glyph before an attachment's label (quote, reply bar, chat list line). */
export type AttachmentSummaryIcon = 'mic' | 'camera' | 'video' | 'file';

/**
 * What a message's attachments read as, WhatsApp style: a voice note is
 * "Voice message" with its m:ss length, images "Photo" or "N photos" with the
 * first image as the thumbnail, a video "Video", any other file its name.
 */
export interface AttachmentSummary {
  icon: AttachmentSummaryIcon;
  label: string;
  /** A voice note's recorded length as m:ss; absent when unknown. */
  duration?: string;
  /** The asset version id to presign for the thumbnail (images). */
  thumbAssetVersionId?: string;
  /** An own unsent image's local preview, shown instead of a presign. */
  thumbLocalUrl?: string;
}

/** The attachment fields a summary reads. */
export type SummaryAttachment = Pick<MessageAttachment, 'assetId' | 'name' | 'mime'> &
  Partial<Pick<MessageAttachment, 'durationMs' | 'transcript' | 'local'>>;

/** Fixed labels the summary uses (the chat list line matches its glyph on them). */
export const SUMMARY_LABELS = {
  voice: 'Voice message',
  photo: 'Photo',
  video: 'Video',
  file: 'File',
} as const;

/** Format a millisecond length as m:ss ("0:07", "12:05"). Pure. */
export function formatSummaryDuration(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isVoice(a: SummaryAttachment): boolean {
  return (
    a.durationMs !== undefined ||
    a.transcript !== undefined ||
    classifyAttachment(a.mime) === 'audio'
  );
}

/**
 * The one summary behind the reply quote, the composer reply bar, the chat
 * list line and the marks row: images first ("Photo" / "N photos" with the
 * first as thumbnail), then video, a file (its name), then a voice note.
 * Null when the message carries no attachment. Pure.
 */
export function attachmentSummary(message: {
  attachments: readonly SummaryAttachment[];
}): AttachmentSummary | null {
  const all = message.attachments;
  if (all.length === 0) return null;
  const images = all.filter((a) => !isVoice(a) && classifyAttachment(a.mime) === 'image');
  const [first] = images;
  if (first !== undefined) {
    const local = first.local?.previewUrl ?? null;
    return {
      icon: 'camera',
      label: images.length === 1 ? SUMMARY_LABELS.photo : `${images.length} photos`,
      ...(first.assetId !== '' ? { thumbAssetVersionId: first.assetId } : {}),
      ...(local !== null ? { thumbLocalUrl: local } : {}),
    };
  }
  if (all.some((a) => !isVoice(a) && a.mime.startsWith('video/'))) {
    return { icon: 'video', label: SUMMARY_LABELS.video };
  }
  const file = all.find((a) => !isVoice(a));
  if (file !== undefined) {
    const name = file.name.trim();
    return { icon: 'file', label: name !== '' ? name : SUMMARY_LABELS.file };
  }
  const voice = all[0] as SummaryAttachment;
  return {
    icon: 'mic',
    label: SUMMARY_LABELS.voice,
    ...(voice.durationMs !== undefined
      ? { duration: formatSummaryDuration(voice.durationMs) }
      : {}),
  };
}

/** A summary as one line of text ("Voice message (0:07)", "3 photos", "brief.pdf"). Pure. */
export function attachmentSummaryText(summary: AttachmentSummary): string {
  return summary.duration !== undefined ? `${summary.label} (${summary.duration})` : summary.label;
}

/**
 * The glyph for a stored text line that is a bare summary (the chat list line
 * carries text only); null for anything else, so a body line never gets one. Pure.
 */
export function summaryIconOfLine(line: string): AttachmentSummaryIcon | null {
  if (line === SUMMARY_LABELS.photo || /^\d+ photos$/.test(line)) return 'camera';
  if (line === SUMMARY_LABELS.video) return 'video';
  if (line === SUMMARY_LABELS.voice || /^Voice message \(\d+:\d{2}\)$/.test(line)) return 'mic';
  if (line === SUMMARY_LABELS.file) return 'file';
  return null;
}

/** A merge keeps the non-empty plan ids (the row's, else what the list held). */
function keptPlanIds(
  existing: Pick<ThreadMessage, 'sharedPlanIds'>,
  incoming: Pick<ThreadMessage, 'sharedPlanIds'>,
): Pick<ThreadMessage, 'sharedPlanIds'> {
  const kept =
    (existing.sharedPlanIds ?? []).length > 0 ? existing.sharedPlanIds : incoming.sharedPlanIds;
  return kept !== undefined && kept.length > 0 ? { sharedPlanIds: kept } : {};
}

/** Longest body snapshot a reply quote carries. */
export const REPLY_PREVIEW_LIMIT = 120;

/** The quote line for a message: its body (clipped), else a label for its content. */
export function replyPreview(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds'> &
    Partial<Pick<ThreadMessage, 'sharedBriefIds' | 'sharedPlanIds'>>,
): string {
  const body = message.body.trim();
  // Never cut through an @[uuid] token: the quote resolves it to "@Name" at render.
  if (body !== '') return truncateBody(body, REPLY_PREVIEW_LIMIT);
  const summary = attachmentSummary(message);
  if (summary !== null) return attachmentSummaryText(summary);
  if (message.sharedPostIds.length > 0) return 'Shared post';
  if ((message.sharedBriefIds ?? []).length > 0) return 'Shared brief';
  if ((message.sharedPlanIds ?? []).length > 0) return 'Shared plan';
  return 'Message';
}

/** A reply read from a row whose quote has not been resolved yet. */
function unresolvedReply(message: ThreadMessage): boolean {
  return message.reply !== null && message.reply.preview === '';
}

/** Quoted ids that are unresolved and not in the list (to fetch in one read). */
export function missingReplyIds(messages: readonly ThreadMessage[]): string[] {
  const loaded = new Set(messages.map((m) => m.id));
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.reply !== null && unresolvedReply(m) && !loaded.has(m.reply.id)) ids.add(m.reply.id);
  }
  return [...ids];
}

/**
 * Resolve unresolved reply quotes from the loaded list plus `sources` (quoted
 * rows fetched separately). With `settle`, a quote whose message cannot be
 * found (deleted, not visible) falls back to a generic label instead of staying
 * blank. Resolved quotes are left untouched. A quoted card message also hands
 * its shared post ids to the reply (parentSharedPostIds).
 */
export function hydrateReplies(
  messages: ThreadMessage[],
  sources: readonly ThreadMessage[],
  settle = false,
): ThreadMessage[] {
  if (!messages.some(unresolvedReply)) return messages;
  const byId = new Map<string, ThreadMessage>();
  for (const m of sources) byId.set(m.id, m);
  for (const m of messages) byId.set(m.id, m);
  return messages.map((m) => {
    if (m.reply === null || !unresolvedReply(m)) return m;
    const quoted = byId.get(m.reply.id);
    if (quoted === undefined) {
      return settle ? { ...m, reply: { ...m.reply, preview: 'Message' } } : m;
    }
    if (quoted.deleted === true) {
      return {
        ...m,
        reply: { id: quoted.id, authorUserId: quoted.senderUserId, preview: DELETED_MESSAGE_LABEL },
        parentDeleted: true,
      };
    }
    return {
      ...m,
      reply: { id: quoted.id, authorUserId: quoted.senderUserId, preview: replyPreview(quoted) },
      ...(quoted.sharedPostIds.length > 0
        ? { parentSharedPostIds: [...quoted.sharedPostIds] }
        : {}),
    };
  });
}

/** Thread roots of `fetched` that are not loaded and not hydrated (to read in the quotes' IN read). */
export function missingRootIds(
  fetched: readonly ThreadMessage[],
  loaded: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  for (const m of fetched) {
    if (awaitsRootHydration(m, loaded) && typeof m.threadRootId === 'string')
      ids.add(m.threadRootId);
  }
  return [...ids];
}

/**
 * Fill the root post ids of rows whose thread root is not loaded, from
 * `sources` (root rows fetched separately). A deleted root shares nothing.
 * `settle` names the rows whose read this was: a root of theirs that cannot
 * be found (not visible) shares nothing instead of staying unknown; rows of
 * another batch whose read is still in flight are left alone. The same list
 * when nothing changes.
 */
export function hydrateRoots(
  messages: ThreadMessage[],
  sources: readonly ThreadMessage[],
  settle: ReadonlySet<string> = new Set(),
): ThreadMessage[] {
  const loaded = new Set(messages.map((m) => m.id));
  if (!messages.some((m) => awaitsRootHydration(m, loaded))) return messages;
  const byId = new Map(sources.map((m) => [m.id, m] as const));
  let changed = false;
  const next = messages.map((m) => {
    if (!awaitsRootHydration(m, loaded) || typeof m.threadRootId !== 'string') return m;
    const root = byId.get(m.threadRootId);
    if (root === undefined && !settle.has(m.id)) return m;
    changed = true;
    return {
      ...m,
      rootPostIds: root === undefined || root.deleted === true ? [] : [...root.sharedPostIds],
    };
  });
  return changed ? next : messages;
}

/**
 * Map a live Agora text message to the rendered shape. Messages without the
 * Sorted ids on `ext` are rejected (pre-rewrite clients during the reload
 * window). Time is the Agora SERVER time of the message, never the local clock,
 * and stays provisional until the row is fetched on the next catch-up.
 */
export function mapLiveTextMessage(
  raw: AgoraChat.TextMsgBody,
  currentUserId: string,
): { ok: true; channelId: string; message: ThreadMessage } | { ok: false; reason: 'missing_ids' } {
  const ids = parseLiveIds(raw.ext);
  if (!ids.ok) return { ok: false, reason: 'missing_ids' };
  const mapped =
    raw.from !== undefined ? userIdFromAgoraUsername(raw.from) : ({ ok: false } as const);
  const senderUserId = mapped.ok ? mapped.userId : null;
  return {
    ok: true,
    channelId: ids.ids.sorted_channel_id,
    message: {
      id: ids.ids.sorted_message_id,
      senderUserId,
      body: raw.msg,
      createdAt: new Date(raw.time).toISOString(),
      time: raw.time,
      provisionalTime: true,
      mine: senderUserId !== null && senderUserId === currentUserId,
      attachments: parseAttachments(raw.ext),
      sharedPostIds: parseSharedPostIds(raw.ext),
      sharedBriefIds: [],
      reply: parseReply(raw.ext),
      ...liveThreadRoot(raw.ext),
      state: 'sent',
      status: 'sent',
      reactions: [],
      ...(parseForwardedFrom(raw.ext) !== null ? { forwarded: true } : {}),
    },
  };
}

/** A live message's thread root from its ext (store previews); absent when not carried. */
function liveThreadRoot(ext: unknown): Pick<ThreadMessage, 'threadRootId'> {
  const root = parseLiveThreadRoot(ext);
  return root !== null ? { threadRootId: root } : {};
}

/**
 * Total order on messages: server time (an unrecorded own send by its
 * estimated server time), then id (uuid_v7 is time-ordered too).
 */
export function compareMessages(a: ThreadMessage, b: ThreadMessage): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** True when a fetched row's edit or delete state differs from the loaded message. */
function changedOnRecord(existing: ThreadMessage, incoming: ThreadMessage): boolean {
  return (
    (existing.editedAt ?? null) !== (incoming.editedAt ?? null) ||
    (existing.deleted === true) !== (incoming.deleted === true)
  );
}

/**
 * Point every reply quote at a deleted message to the tombstone label; replies
 * to live messages are unchanged. The same list when nothing changes.
 */
function syncDeletedQuotes(messages: ThreadMessage[]): ThreadMessage[] {
  const deleted = new Set(messages.filter((m) => m.deleted === true).map((m) => m.id));
  if (deleted.size === 0) return messages;
  let changed = false;
  const next = messages.map((m) => {
    if (m.reply === null || !deleted.has(m.reply.id) || m.parentDeleted === true) return m;
    changed = true;
    const quoted: ThreadMessage = {
      ...m,
      reply: { ...m.reply, preview: DELETED_MESSAGE_LABEL },
      parentDeleted: true,
    };
    delete quoted.parentSharedPostIds;
    return quoted;
  });
  return changed ? next : messages;
}

/**
 * Fold rows fetched from Postgres into the list. A fetched row replaces a
 * provisional entry with the same id (server time wins) while keeping the
 * richer live content and the local reaction/read state. An id already backed
 * by the record is left alone unless its edited_at or deleted_at changed: an
 * edit takes the new body (keeping reactions, read state and the resolved
 * quote), a delete turns it into a tombstone. New ids are inserted in order.
 */
export function mergeFetched(messages: ThreadMessage[], fetched: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const incoming of fetched) {
    const existing = byId.get(incoming.id);
    if (existing === undefined) {
      byId.set(incoming.id, incoming);
      continue;
    }
    if (!existing.provisionalTime) {
      if (!changedOnRecord(existing, incoming)) continue;
      byId.set(
        incoming.id,
        incoming.deleted === true
          ? asTombstone({ ...existing, editedAt: incoming.editedAt ?? null })
          : {
              ...existing,
              body: incoming.body,
              editedAt: incoming.editedAt ?? null,
              ...(incoming.mentions !== undefined ? { mentions: incoming.mentions } : {}),
            },
      );
      continue;
    }
    if (incoming.deleted === true) {
      // A delete missed live: the row wins outright, no live content survives.
      byId.set(incoming.id, asTombstone({ ...incoming, status: existing.status }));
      continue;
    }
    byId.set(incoming.id, {
      ...incoming,
      attachments: existing.attachments.length > 0 ? existing.attachments : incoming.attachments,
      sharedPostIds:
        existing.sharedPostIds.length > 0 ? existing.sharedPostIds : incoming.sharedPostIds,
      sharedBriefIds:
        existing.sharedBriefIds.length > 0 ? existing.sharedBriefIds : incoming.sharedBriefIds,
      ...keptPlanIds(existing, incoming),
      reply: existing.reply ?? incoming.reply,
      reactions: existing.reactions,
      status: existing.status,
    });
  }
  return syncDeletedQuotes([...byId.values()].sort(compareMessages));
}

/** Append a live message, ignoring a duplicate id (already fetched or echoed). */
export function appendMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  if (messages.some((m) => m.id === message.id)) return messages;
  return [...messages, message].sort(compareMessages);
}

/** Replace the message with the same id, or append when it is not present. */
export function upsertMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message].sort(compareMessages);
  const next = [...messages];
  next[index] = message;
  return next.sort(compareMessages);
}

/**
 * Turn messages into tombstones by id (deleted for everyone): content,
 * reactions and quote cleared locally, time slot and side kept, and replies
 * quoting them read "Message deleted". The same list when none match.
 */
export function markMessagesDeleted(
  messages: ThreadMessage[],
  ids: readonly string[],
): ThreadMessage[] {
  const hit = new Set(ids);
  if (!messages.some((m) => hit.has(m.id) && m.deleted !== true)) return messages;
  return syncDeletedQuotes(
    messages.map((m) => (hit.has(m.id) && m.deleted !== true ? asTombstone(m) : m)),
  );
}

/**
 * Apply a recorded edit: the body and edited_at of one loaded, live message
 * change (attachments, cards and mentions stay); reply quotes of it refresh.
 * The same list when the id is not loaded or is a tombstone.
 */
export function applyEdit(
  messages: ThreadMessage[],
  input: { messageId: string; body: string; editedAt: string; mentions?: string[] | null },
): ThreadMessage[] {
  const existing = messages.find((m) => m.id === input.messageId);
  if (existing === undefined || existing.deleted === true) return messages;
  const edited: ThreadMessage = {
    ...existing,
    body: input.body,
    editedAt: input.editedAt,
    ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
  };
  return upsertMessage(messages, edited).map((m) =>
    m.reply !== null && m.reply.id === input.messageId && m.parentDeleted !== true
      ? { ...m, reply: { ...m.reply, preview: replyPreview(edited) } }
      : m,
  );
}

/**
 * Apply a live edit from the message's re-read row, never the Agora payload.
 * A row that was never edited, or whose edited_at is not newer than the one
 * the list shows (equal or older: a slower read racing a newer edit), changes
 * nothing (the same list). Recheck, catch-up and live edits all go through here.
 */
export function applyEditFromRow(messages: ThreadMessage[], row: ChatMessageRow): ThreadMessage[] {
  const existing = messages.find((m) => m.id === row.id);
  if (existing === undefined || row.edited_at === null || row.deleted_at !== null) return messages;
  const shown = existing.editedAt ?? null;
  if (shown === row.edited_at) return messages;
  if (shown !== null) {
    const shownMs = Date.parse(shown);
    const rowMs = Date.parse(row.edited_at);
    if (!Number.isNaN(shownMs) && (Number.isNaN(rowMs) || rowMs <= shownMs)) return messages;
  }
  return applyEdit(messages, {
    messageId: row.id,
    body: row.body ?? '',
    editedAt: row.edited_at,
    mentions: storedMentions(row.mentions),
  });
}

/** Drop messages by id; the same list when none match. */
export function removeMessages(messages: ThreadMessage[], ids: readonly string[]): ThreadMessage[] {
  const drop = new Set(ids);
  if (!messages.some((m) => drop.has(m.id))) return messages;
  return messages.filter((m) => !drop.has(m.id));
}

/** Set one message's delivery state; other messages unchanged. */
export function setMessageState(
  messages: ThreadMessage[],
  id: string,
  state: MessageState,
): ThreadMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, state } : m));
}

/** Replace one message's attachments (upload progress, a returned version id). */
export function setMessageAttachments(
  messages: ThreadMessage[],
  id: string,
  attachments: readonly MessageAttachment[],
): ThreadMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, attachments: [...attachments] } : m));
}

/**
 * Build the optimistic own bubble. It is placed, grouped under its day pill
 * and labelled by `estimatedMs`, the estimated server time of its Send tap
 * (never another message's time, never epoch), among the recorded rows by
 * time, so the recorded row (same id, server created_at) that replaces it
 * lands in the same place.
 */
export function pendingMessage(params: {
  id: string;
  currentUserId: string;
  text: string;
  local: LocalMessageContent;
  estimatedMs: number;
}): ThreadMessage {
  return {
    id: params.id,
    senderUserId: params.currentUserId,
    body: params.text,
    createdAt: '',
    time: params.estimatedMs,
    provisionalTime: true,
    estimatedMs: params.estimatedMs,
    mine: true,
    attachments: [...params.local.attachments],
    sharedPostIds: [...params.local.sharedPostIds],
    sharedBriefIds: [...(params.local.sharedBriefIds ?? [])],
    reply: params.local.reply,
    ...pendingThreadRoot(params.local.reply),
    state: 'sending',
    status: 'sent',
    reactions: [],
  };
}

/** An own unrecorded send's thread root: none without a reply, else the root the sender derived. */
function pendingThreadRoot(reply: ReplyQuote | null): Pick<ThreadMessage, 'threadRootId'> {
  if (reply === null) return {};
  return reply.rootId !== undefined ? { threadRootId: reply.rootId } : {};
}

/** An unrecorded own send as the outbox holds it (structural: see chat-store OutboxEntry). */
export interface UnrecordedSend {
  id: string;
  text: string;
  local: LocalMessageContent;
  state: 'sending' | 'failed';
  /** Estimated server time of the Send tap; absent on a send persisted before it was kept. */
  createdMs?: number;
  filesMissing?: true;
}

/**
 * Lay a channel's unrecorded sends over its loaded list: each renders as an own
 * bubble in its outbox state ('sending' or 'failed' with Retry), placed by
 * the estimated server time of its tap among the loaded messages (a failed
 * one keeps its place). An id the list already holds as recorded is skipped
 * (its row exists, so the send landed). `nowMs` stands in for a send with no
 * tap time (restore stamps one, so this is a fallback only).
 */
export function withOutboxBubbles(
  messages: ThreadMessage[],
  entries: readonly UnrecordedSend[],
  currentUserId: string,
  nowMs: number = Date.now(),
): ThreadMessage[] {
  if (entries.length === 0) return messages;
  const recordedIds = new Set(messages.filter((m) => m.state === 'sent').map((m) => m.id));
  const outboxIds = new Set(entries.map((e) => e.id));
  const list = messages.filter((m) => m.state === 'sent' || !outboxIds.has(m.id));
  for (const entry of entries) {
    if (recordedIds.has(entry.id)) continue;
    const bubble = pendingMessage({
      id: entry.id,
      currentUserId,
      text: entry.text,
      local: entry.local,
      estimatedMs: entry.createdMs ?? nowMs,
    });
    list.push({
      ...bubble,
      state: entry.state,
      ...(entry.filesMissing === true ? { filesMissing: true } : {}),
    });
  }
  return list.sort(compareMessages);
}

/** A keyset position: the (created_at, id) pair of one recorded message. */
export interface MessageCursor {
  createdAt: string;
  id: string;
}

/** The record-backed messages only (a pending or Agora-timed one has no cursor). */
function recorded(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.filter((m) => !m.provisionalTime && m.state === 'sent');
}

/** The oldest recorded message's cursor, for "load older"; undefined when none. */
export function oldestCursor(messages: ThreadMessage[]): MessageCursor | undefined {
  const first = recorded(messages)[0];
  return first === undefined ? undefined : { createdAt: first.createdAt, id: first.id };
}

/** A row's keyset position. */
export function rowCursor(row: Pick<ChatMessageRow, 'created_at' | 'id'>): MessageCursor {
  return { createdAt: row.created_at, id: row.id };
}

/**
 * Keyset order of two cursors (created_at, then id), as the history reads
 * order them: negative when `a` is older. Timestamps compare by instant; two
 * stamps in the same millisecond fall back to their text (same server format).
 */
export function compareCursors(a: MessageCursor, b: MessageCursor): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at - bt;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Apply a live reaction add/remove optimistically; Postgres is truth on next load. */
export function applyReactionOp(
  messages: ThreadMessage[],
  input: { messageId: string; emoji: string; op: 'add' | 'remove'; mine: boolean },
): ThreadMessage[] {
  return messages.map((m) => {
    if (m.id !== input.messageId) return m;
    const existing = m.reactions.find((r) => r.emoji === input.emoji);
    if (input.op === 'add') {
      if (existing === undefined) {
        return {
          ...m,
          reactions: [...m.reactions, { emoji: input.emoji, count: 1, mine: input.mine }],
        };
      }
      if (input.mine && existing.mine) return m;
      return {
        ...m,
        reactions: m.reactions.map((r) =>
          r.emoji === input.emoji ? { ...r, count: r.count + 1, mine: r.mine || input.mine } : r,
        ),
      };
    }
    if (existing === undefined) return m;
    if (input.mine && !existing.mine) return m;
    const count = existing.count - 1;
    return {
      ...m,
      reactions:
        count <= 0
          ? m.reactions.filter((r) => r.emoji !== input.emoji)
          : m.reactions.map((r) =>
              r.emoji === input.emoji ? { ...r, count, mine: input.mine ? false : r.mine } : r,
            ),
    };
  });
}

/** Set reactions for messages present in the map; messages absent from it are unchanged. */
export function mergeReactions(
  messages: ThreadMessage[],
  byId: Map<string, MessageReaction[]>,
): ThreadMessage[] {
  return messages.map((m) => {
    const reactions = byId.get(m.id);
    return reactions !== undefined ? { ...m, reactions } : m;
  });
}

/**
 * Replace the reactions of the re-read ids with what the record holds (an id
 * the read returned nothing for has none left). Rows keep their order, and a
 * row whose reactions did not change keeps its object. Pure.
 */
export function replaceReactions(
  messages: ThreadMessage[],
  checked: readonly string[],
  byId: Map<string, MessageReaction[]>,
): ThreadMessage[] {
  const ids = new Set(checked);
  let changed = false;
  const next = messages.map((m) => {
    if (!ids.has(m.id)) return m;
    const reactions = byId.get(m.id) ?? [];
    if (sameReactions(m.reactions, reactions)) return m;
    changed = true;
    return { ...m, reactions };
  });
  return changed ? next : messages;
}

function sameReactions(a: readonly MessageReaction[], b: readonly MessageReaction[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r) => {
    const other = b.find((o) => o.emoji === r.emoji);
    return other !== undefined && other.count === r.count && other.mine === r.mine;
  });
}

/**
 * Mark every own message sent at or before the peer's read position as 'read'.
 * Pure and monotonic: only mine messages ranked below 'read' advance; non-mine
 * and later messages are unchanged.
 */
export function markReadUpTo(messages: ThreadMessage[], readTimeMs: number): ThreadMessage[] {
  return messages.map((m) =>
    m.mine && m.time <= readTimeMs && m.status !== 'read' ? { ...m, status: 'read' } : m,
  );
}

/**
 * Mark own messages read up to a message id the peer reported reading. The id
 * resolves to its time in the loaded list; an id that is not loaded (older than
 * the window, or newer than anything here) leaves the list unchanged.
 */
export function markReadUpToMessage(messages: ThreadMessage[], messageId: string): ThreadMessage[] {
  const anchor = messages.find((m) => m.id === messageId);
  return anchor === undefined ? messages : markReadUpTo(messages, anchor.time);
}

/**
 * Subscribe to live traffic for one channel and return the teardown. Registers
 * the 'chat-thread' handler (separate from the Foundation handler) and removes
 * exactly it on teardown. Text messages route by the Sorted channel id on their
 * `ext`; a message without the ids is dropped and reported to `onIgnored`.
 * Command messages carry reaction and read signals for the same channel.
 */
export function subscribeIncoming(params: {
  connection: ThreadConnection;
  channelId: string;
  currentUserId: string;
  onMessage: (message: ThreadMessage) => void;
  /** A message arrived without the Sorted ids (pre-rewrite sender). */
  onIgnored: (rawId: string) => void;
  /** A peer added or removed a reaction on a message in this channel. */
  onReaction: (input: {
    messageId: string;
    emoji: string;
    op: 'add' | 'remove';
    fromUserId: string;
  }) => void;
  /** A peer reported reading this channel up to a message id. */
  onRead: (input: { messageId: string; fromUserId: string }) => void;
  /** A sender deleted their messages for everyone; ids are globally unique. */
  onDelete?: (input: { messageIds: string[]; fromUserId: string }) => void;
  /** A sender edited one of their messages (the body and edited_at as recorded). */
  onEdit?: (input: {
    messageId: string;
    body: string;
    editedAt: string;
    fromUserId: string;
  }) => void;
}): () => void {
  const { connection, channelId, currentUserId, onMessage, onIgnored, onReaction, onRead } = params;
  const { onDelete, onEdit } = params;
  const senderOf = (from: string | undefined): string | undefined => {
    if (from === undefined) return undefined;
    const mapped = userIdFromAgoraUsername(from);
    return mapped.ok ? mapped.userId : undefined;
  };
  connection.addEventHandler(THREAD_EVENT_HANDLER_ID, {
    onTextMessage: (raw) => {
      const mapped = mapLiveTextMessage(raw, currentUserId);
      if (!mapped.ok) {
        onIgnored(raw.id);
        return;
      }
      if (mapped.channelId === channelId) onMessage(mapped.message);
    },
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind === 'unknown') return;
      const fromUserId = senderOf(raw.from);
      if (fromUserId === undefined) return;
      if (event.kind === 'reaction') {
        onReaction({ messageId: event.messageId, emoji: event.emoji, op: event.op, fromUserId });
        return;
      }
      if (event.kind === 'delete') {
        onDelete?.({ messageIds: event.messageIds, fromUserId });
        return;
      }
      if (event.kind === 'edit') {
        onEdit?.({
          messageId: event.messageId,
          body: event.body,
          editedAt: event.editedAt,
          fromUserId,
        });
        return;
      }
      // Mark signals are consumed by the marks subscription (subscribeMarkEvents).
      if (event.kind === 'mark') return;
      if (event.channelId === channelId) onRead({ messageId: event.messageId, fromUserId });
    },
  });
  return () => connection.removeEventHandler(THREAD_EVENT_HANDLER_ID);
}

/**
 * Publish a message to the channel over Agora for live delivery. A bare text
 * send passes no `ext`; a send carrying attachments, shared posts or a reply
 * adds them to `ext`, and a send stamped with `liveIds` (every send from the
 * chat thread, after the row is recorded) adds the Sorted ids receivers dedupe
 * on. Live delivery only: the record is written by chat_message_send first.
 */
export function sendText(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  text: string;
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  reply: ReplyQuote | null;
  createMessage: CreateTextMessage;
  liveIds?: LiveMessageIds;
  /** The source message id when this send forwards it. */
  forwardedFrom?: string | null;
}): Promise<AgoraChat.SendMsgResult> {
  const built = buildLiveTextExt(params);
  const ext = built !== null ? { ext: built } : {};
  return sendRouted(params.connection, params.target, (to, chatType) =>
    params.createMessage({ chatType, type: 'txt', to, msg: params.text, ...ext }),
  );
}

/**
 * The `ext` a live text send carries (before sendRouted stamps the workspace),
 * or null for a bare text send. Pure; shared with the chat-scheduled-send
 * Worker so a scheduled message publishes with the same keys and values.
 */
export function buildLiveTextExt(params: {
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  reply: ReplyQuote | null;
  liveIds?: LiveMessageIds;
  forwardedFrom?: string | null;
}): (MessageExt & Partial<LiveMessageIds> & { [LIVE_THREAD_ROOT_KEY]?: string }) | null {
  const forwardedFrom = params.forwardedFrom ?? null;
  const hasContentExt =
    params.attachments.length > 0 ||
    params.sharedPostIds.length > 0 ||
    params.reply !== null ||
    forwardedFrom !== null;
  const hasExt = hasContentExt || params.liveIds !== undefined;
  if (!hasExt) return null;
  return {
    ...buildMessageExt({
      attachments: params.attachments,
      sharedPostIds: params.sharedPostIds,
      reply: params.reply,
      forwardedFrom,
    }),
    ...(params.liveIds !== undefined ? params.liveIds : {}),
    ...(params.reply?.rootId !== undefined ? { [LIVE_THREAD_ROOT_KEY]: params.reply.rootId } : {}),
  };
}

/** A gap this long (or longer) between neighbours starts a new run and shows a time label. */
export const RUN_GAP_MS = 10 * 60 * 1000;

/** True when `next` is 10 minutes or more after `prev`; unusable times (0) never count. */
export function isTimeGap(
  prev: Pick<ThreadMessage, 'time'>,
  next: Pick<ThreadMessage, 'time'>,
): boolean {
  if (!(prev.time > 0) || !(next.time > 0)) return false;
  return next.time - prev.time >= RUN_GAP_MS;
}

/**
 * Whether `next` starts a new run after `prev`: a switch between own and peer, a
 * different peer sender, or a gap of 10 minutes or more. A day change also breaks
 * a run; the caller knows the day pills and applies that separately.
 */
export function breaksRun(
  prev: Pick<ThreadMessage, 'mine' | 'senderUserId' | 'time'> | undefined,
  next: Pick<ThreadMessage, 'mine' | 'senderUserId' | 'time'>,
): boolean {
  if (prev === undefined) return true;
  if (prev.mine !== next.mine) return true;
  if (!prev.mine && prev.senderUserId !== next.senderUserId) return true;
  return isTimeGap(prev, next);
}
