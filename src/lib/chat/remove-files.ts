// Remove files, keep the message: a sender takes their own files off chat
// messages while the text stays. The flow is record -> purge -> signal, like
// delete-flow.ts: chat_message_remove_files rewrites the rows (a message left
// with nothing becomes a tombstone), POST /purge-chat frees the storage, and a
// live 'files_removed' command tells the other members to re-read the rows.
// A failed purge or signal never fails the removal (the nightly job sweeps;
// peers catch up on the next read).
//
// The removed state lives in a small per-channel overlay (pending removals
// behind the Undo window, plus re-read rows from a live signal) that the
// thread and the chat info tabs read, so every surface agrees at once.
// Pure of React.

import type { AgoraChat } from 'agora-chat';
import type { Client, Result } from '@srtdio/rpc';
import { userIdFromAgoraUsername } from '@/lib/chat/agora-identity';
import { loadMessagesByIds } from '@/lib/chat/history';
import { removeFilesRecord, type RemoveFileTarget } from '@/lib/chat/record';
import type { PurgeChatOutcome } from '@/lib/chat/delete-flow';
import {
  applyFilesRemoved,
  filesRemovedEventExt,
  markMessagesDeleted,
  parseLiveEvent,
  parseRemovedFiles,
  removedKindOf,
  type ChatMessageRow,
  type RemovedFiles,
  type ThreadMessage,
} from '@/lib/chat/thread';
import type { ChatConnection } from '@/lib/chat/types';

export type { RemoveFileTarget } from '@/lib/chat/record';
export type { RemovedFiles } from '@/lib/chat/thread';

/** The header button that opens select mode in the Media and Files tabs. */
export const SELECT_LABEL = 'Select';
/** The one danger button of the select-mode bottom bar. */
export const REMOVE_LABEL = 'Remove';
/** The More menu row on an own single-file message. */
export const REMOVE_FILE_MENU_LABEL = 'Remove file';
/** The photo viewer's bin button. */
export const REMOVE_PHOTO_ARIA = 'Remove photo';
export const REMOVE_VIDEO_ARIA = 'Remove video';
/** The ownership or marked refusal. */
export const REMOVE_REFUSED_TOAST = "Couldn't remove. Only your own files can be removed.";
/** Any other failure. */
export const REMOVE_FAILED_TOAST = "Couldn't remove. Try again.";

/** The viewer bin's label for an image or a video. Pure. */
export function removeMediaAria(mime: string): string {
  return mime.startsWith('video/') ? REMOVE_VIDEO_ARIA : REMOVE_PHOTO_ARIA;
}

/** The toast for a refused or failed removal: the proc's refusals read as ownership. Pure. */
export function removeFailureCopy(message: string): string {
  return /only your own files|not a member/i.test(message)
    ? REMOVE_REFUSED_TOAST
    : REMOVE_FAILED_TOAST;
}

function part(count: number, one: string, many: string): string | null {
  if (count <= 0) return null;
  return count === 1 ? one : `${count} ${many}`;
}

/**
 * The Undo strip and the in-bubble line: "1 photo removed", "2 videos
 * removed", "File removed", "3 files removed"; mixed kinds join with " and "
 * in the order photo, video, file ("1 photo and 1 file removed"). A lone
 * single file reads "File removed"; in a mix it reads "1 file". '' for none. Pure.
 */
export function removedFilesLabel(counts: Partial<RemovedFiles>): string {
  const photo = counts.photo ?? 0;
  const video = counts.video ?? 0;
  const file = counts.file ?? 0;
  if (photo === 0 && video === 0 && file === 1) return 'File removed';
  const parts = [
    part(photo, '1 photo', 'photos'),
    part(video, '1 video', 'videos'),
    part(file, '1 file', 'files'),
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? '' : `${parts.join(' and ')} removed`;
}

/** Per-kind counts of these mimes, as chat_message_remove_files counts them. Pure. */
export function removedCountsOf(mimes: readonly string[]): RemovedFiles {
  const counts: RemovedFiles = { photo: 0, video: 0, file: 0 };
  for (const mime of mimes) counts[removedKindOf(mime)] += 1;
  return counts;
}

/** A file a surface hands to the removal: its message, asset id and mime (for the counts). */
export interface RemovableFile extends RemoveFileTarget {
  mime: string;
}

/** Voice notes go only by Delete. */
export function isVoiceMime(mime: string): boolean {
  return mime.startsWith('audio/');
}

/** Anything with `has(messageId)`: the marks map, or a set of marked ids. */
export interface MarkedLookup {
  has(messageId: string): boolean;
}

/**
 * One file the viewer may remove: on their own, recorded, live, unmarked
 * message, and not a voice note. No time limit. Pure.
 */
export function canRemoveFile(
  message: { id: string; senderUserId: string | null; deleted?: boolean },
  file: { assetId?: string; mime: string },
  viewerId: string,
  marks: MarkedLookup,
): boolean {
  if (viewerId === '' || message.senderUserId !== viewerId) return false;
  if (message.deleted === true || marks.has(message.id)) return false;
  if (file.assetId !== undefined && file.assetId === '') return false;
  return !isVoiceMime(file.mime);
}

/** The attachments of a message the viewer may remove. Pure. */
export function removableAttachments(
  message: Pick<ThreadMessage, 'id' | 'senderUserId' | 'deleted' | 'attachments' | 'state'>,
  viewerId: string,
  marks: MarkedLookup,
): ThreadMessage['attachments'] {
  if (message.state !== 'sent') return [];
  return message.attachments.filter((a) => canRemoveFile(message, a, viewerId, marks));
}

/** True when the message has at least one file the viewer may remove. Pure. */
export function canRemove(
  message: Pick<ThreadMessage, 'id' | 'senderUserId' | 'deleted' | 'attachments' | 'state'>,
  viewerId: string,
  marks: MarkedLookup,
): boolean {
  return removableAttachments(message, viewerId, marks).length > 0;
}

/**
 * More -> "Remove file": only on an own, unmarked message with exactly one
 * file that is not a voice note (an album goes by the viewer bin or Select). Pure.
 */
export function canRemoveSingleFile(
  message: Pick<ThreadMessage, 'id' | 'senderUserId' | 'deleted' | 'attachments' | 'state'>,
  viewerId: string,
  marks: MarkedLookup,
): boolean {
  return message.attachments.length === 1 && canRemove(message, viewerId, marks);
}

// ---------------------------------------------------------------------------
// The flow: record -> purge -> signal.

export interface RemoveFilesDeps {
  client: Client;
  /** POST /purge-chat for the removed asset ids (see purgeChatFiles). */
  purgeChat?: (assetIds: string[]) => Promise<PurgeChatOutcome>;
  onPurgeFailed?: (error: string) => void;
  /** Publish the live command; undefined while there is no live target (notes, offline). */
  signal: ((ext: Record<string, unknown>) => Promise<unknown>) | undefined;
  onSignalFailed: (error: unknown) => void;
}

export type RemoveFilesOutcome =
  | { ok: true; removed: RemoveFileTarget[] }
  | { ok: false; removed: RemoveFileTarget[]; message: string; error: string };

/**
 * Remove these files for everyone. The record goes first; only the accepted
 * files are purged and signalled. A refused record returns the toast copy
 * (removeFailureCopy) and the raw error for the log.
 */
export async function runRemoveFiles(
  deps: RemoveFilesDeps,
  input: { channelId: string; files: readonly RemoveFileTarget[]; traceId: string },
): Promise<RemoveFilesOutcome> {
  if (input.files.length === 0) return { ok: true, removed: [] };
  const result = await removeFilesRecord({
    client: deps.client,
    channelId: input.channelId,
    files: input.files,
    traceId: input.traceId,
  });
  const removed = result.removed;
  if (removed.length > 0) {
    if (deps.purgeChat !== undefined) {
      try {
        const purged = await deps.purgeChat([...new Set(removed.map((f) => f.assetId))]);
        if (!purged.ok) deps.onPurgeFailed?.(purged.error);
      } catch (error) {
        deps.onPurgeFailed?.(String(error));
      }
    }
    if (deps.signal !== undefined) {
      const messageIds = [...new Set(removed.map((f) => f.messageId))];
      try {
        void deps
          .signal(filesRemovedEventExt({ messageIds }))
          .catch((error: unknown) => deps.onSignalFailed(error));
      } catch (error) {
        deps.onSignalFailed(error);
      }
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      removed,
      message: removeFailureCopy(result.message),
      error: result.message,
    };
  }
  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// The overlay: what every surface of a channel shows as removed right now.

/** The columns of a re-read row the overlay keeps. */
export type RemovedRow = Pick<
  ChatMessageRow,
  'id' | 'channel_id' | 'sender_user_id' | 'attachment_asset_ids' | 'removed_files' | 'deleted_at'
>;

export interface RemovedOverlay {
  /** Files removed here, waiting out (or past) the Undo window: asset ids per message id. */
  pending: ReadonlyMap<string, ReadonlySet<string>>;
  /** Rows re-read after a live 'files_removed' signal, by message id. */
  rows: ReadonlyMap<string, RemovedRow>;
}

export const EMPTY_OVERLAY: RemovedOverlay = { pending: new Map(), rows: new Map() };

/** True when the overlay hides this file (removed here, or gone from the re-read row). Pure. */
export function isFileRemoved(
  overlay: RemovedOverlay,
  messageId: string,
  assetId: string,
): boolean {
  if (overlay.pending.get(messageId)?.has(assetId) === true) return true;
  const row = overlay.rows.get(messageId);
  if (row === undefined) return false;
  if (row.deleted_at !== null) return true;
  return !(row.attachment_asset_ids ?? []).includes(assetId);
}

/**
 * The thread's messages with the overlay applied: a re-read row's files and
 * counts win (a deleted row becomes a tombstone), then the pending removals
 * drop their files. Idempotent, so a list that already carries the removal
 * is unchanged. The same list when nothing applies. Pure.
 */
export function applyRemovedOverlay(
  messages: ThreadMessage[],
  overlay: RemovedOverlay,
): ThreadMessage[] {
  if (overlay.pending.size === 0 && overlay.rows.size === 0) return messages;
  let next = messages;
  if (overlay.rows.size > 0) {
    const tombstones: string[] = [];
    let changed = false;
    const mapped = next.map((m) => {
      const row = overlay.rows.get(m.id);
      if (row === undefined || m.deleted === true) return m;
      if (row.deleted_at !== null) {
        tombstones.push(m.id);
        return m;
      }
      const kept = new Set(row.attachment_asset_ids ?? []);
      const attachments = m.attachments.filter((a) => a.assetId === '' || kept.has(a.assetId));
      const removedFiles = parseRemovedFiles(row.removed_files);
      if (attachments.length === m.attachments.length && removedFiles === null) return m;
      changed = true;
      return {
        ...m,
        attachments,
        ...(removedFiles !== null ? { removedFiles } : {}),
      };
    });
    if (changed) next = mapped;
    if (tombstones.length > 0) next = markMessagesDeleted(next, tombstones);
  }
  return overlay.pending.size > 0 ? applyFilesRemoved(next, overlay.pending) : next;
}

type Listener = () => void;

/**
 * The per-channel overlay store. `add` returns the undo for exactly those
 * files; a refused record calls it too. Snapshots are immutable, so React
 * reads them with useSyncExternalStore.
 */
export function createRemovedFilesStore(): {
  get: (channelId: string) => RemovedOverlay;
  subscribe: (listener: Listener) => () => void;
  add: (channelId: string, files: readonly RemoveFileTarget[]) => () => void;
  applyRows: (channelId: string, rows: readonly RemovedRow[]) => void;
  reset: () => void;
} {
  let overlays = new Map<string, RemovedOverlay>();
  const listeners = new Set<Listener>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const set = (channelId: string, overlay: RemovedOverlay): void => {
    overlays = new Map(overlays).set(channelId, overlay);
    emit();
  };
  const get = (channelId: string): RemovedOverlay => overlays.get(channelId) ?? EMPTY_OVERLAY;
  return {
    get,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add: (channelId, files) => {
      if (files.length === 0) return () => {};
      const current = get(channelId);
      const pending = new Map(current.pending);
      for (const f of files) {
        pending.set(f.messageId, new Set(pending.get(f.messageId)).add(f.assetId));
      }
      set(channelId, { ...current, pending });
      return () => {
        const now = get(channelId);
        const back = new Map(now.pending);
        for (const f of files) {
          const ids = back.get(f.messageId);
          if (ids === undefined) continue;
          const left = new Set(ids);
          left.delete(f.assetId);
          if (left.size === 0) back.delete(f.messageId);
          else back.set(f.messageId, left);
        }
        set(channelId, { ...now, pending: back });
      };
    },
    applyRows: (channelId, rows) => {
      if (rows.length === 0) return;
      const current = get(channelId);
      const next = new Map(current.rows);
      for (const row of rows) next.set(row.id, row);
      set(channelId, { ...current, rows: next });
    },
    reset: () => {
      overlays = new Map();
      emit();
    },
  };
}

/** The app's one overlay store (tests create their own). */
export const removedFilesStore = createRemovedFilesStore();

// ---------------------------------------------------------------------------
// Live receive.

/** The handler id of the files-removed subscription (distinct from the thread's). */
export const FILES_REMOVED_EVENT_HANDLER_ID = 'chat-files-removed';

export type FilesRemovedConnection = Pick<ChatConnection, 'addEventHandler' | 'removeEventHandler'>;

/** Subscribe to live 'files_removed' signals; returns the teardown. */
export function subscribeFilesRemoved(
  connection: FilesRemovedConnection,
  onRemoved: (input: { messageIds: string[]; fromUserId: string }) => void,
): () => void {
  const handler: AgoraChat.EventHandlerType = {
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind !== 'files_removed' || raw.from === undefined) return;
      const mapped = userIdFromAgoraUsername(raw.from);
      if (!mapped.ok) return;
      onRemoved({ messageIds: event.messageIds, fromUserId: mapped.userId });
    },
  };
  connection.addEventHandler(FILES_REMOVED_EVENT_HANDLER_ID, handler);
  return () => connection.removeEventHandler(FILES_REMOVED_EVENT_HANDLER_ID);
}

/**
 * A live signal's rows, re-read from chat_messages (never the payload): only
 * rows of this channel by the signal's sender count. Pure of state; the
 * caller hands them to the store's applyRows.
 */
export async function rereadRemovedRows(
  client: Client,
  input: { channelId: string; messageIds: readonly string[]; fromUserId: string },
): Promise<Result<RemovedRow[]>> {
  const read = await loadMessagesByIds(client, input.messageIds);
  if (!read.ok) return read;
  return {
    ok: true,
    data: read.data.filter(
      (row) => row.channel_id === input.channelId && row.sender_user_id === input.fromUserId,
    ),
  };
}
