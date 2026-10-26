// Delete own messages for everyone: record first (chat_message_delete, chunked
// at 100 ids per call), then for each accepted chunk turn the ids into
// tombstones locally and signal peers live with ext { sorted_event: 'delete',
// message_ids }. A failed signal never fails the delete (the rows are wiped; a
// receiver that misses it reads the tombstones on its next history load).
//
// Files: a message carrying files is confirmed with the files copy below, its
// attachment asset ids are collected BEFORE chat_message_delete (the delete
// wipes attachment_asset_ids, and the tombstones drop them locally), and only
// once every chunk is recorded are they sent to the asset-upload Worker's
// POST /purge-chat. A failed purge never undoes the delete: the proc already
// marked the rows purge_requested_at and the nightly job sweeps them.
// Text-only messages take the delete path unchanged.
//
// Edit own message: the same order. chat_message_edit first; only the
// returned row updates the bubble (the new text never shows before the record
// holds it), then peers get ext { sorted_event: 'edit', message_ids: [id],
// body, edited_at }. A failed record returns the mapped user copy. The edit
// always carries the body's COMPLETE mention list (empty when none): the proc
// reads an omitted list as "clear all mentions". A refused mention re-reads the
// chat's members once and edits again without the ones who left (without any
// mention when that re-read fails).
//
// Pure of React and the SDK so the ordering is unit-tested directly.

import type { Client } from '@srtdio/rpc';
import { deleteMessagesRecord, editFailureCopy, editMessageRecord } from '@/lib/chat/record';
import {
  deleteEventExt,
  editEventExt,
  type ChatMessageRow,
  type ThreadMessage,
} from '@/lib/chat/thread';
import {
  ALL_MENTION,
  isEveryoneRefusal,
  isMentionRefusal,
  mentionTargets,
  mentionsAfterRefusal,
} from '@/lib/chat/mentions';
import { recheck } from '@/lib/chat/send-flow';
import { readChannelMemberIds } from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';
import type {
  PurgeChatRequest,
  PurgeChatResponse,
} from '@/server/workers/asset-upload-purge-contracts';

/** The confirm a delete shows. */
export interface DeleteConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
}

/** Personal notes: the delete is private and final, never "for everyone". */
const DELETE_NOTE_TITLE = 'Delete note?';
const DELETE_NOTE_MESSAGE = "This can't be undone.";

/** The confirm for deleting notes (one or several). Pure. */
export function deleteNotesConfirmCopy(count: number): DeleteConfirmCopy {
  return {
    title: count === 1 ? DELETE_NOTE_TITLE : `Delete ${count} notes?`,
    message: DELETE_NOTE_MESSAGE,
    confirmLabel: 'Delete',
  };
}

const DELETE_FILES_TITLE_ONE = 'Delete this message?';
const DELETE_FILES_TITLE_MANY = 'Delete these messages?';
const DELETE_FILES_MESSAGE_MANY =
  "Files in these messages are permanently deleted for privacy. Files shared in chat never go to Recently deleted and can't be restored.";
const DELETE_FILES_CONFIRM = 'Delete for everyone';
/** The toast once a delete that carried files is recorded. */
export const FILES_DELETED_TOAST = 'Deleted. File removed for good.';

/** The one-message body, naming its first file. */
function deleteFilesMessageOne(fileName: string): string {
  return `${fileName} is permanently deleted for privacy. Files shared in chat never go to Recently deleted and can't be restored.`;
}

/**
 * The files confirm for the messages about to be deleted, or null when none
 * carries a file (the caller keeps today's text-only confirm). Pure.
 */
export function deleteConfirmCopy(
  messages: readonly Pick<ThreadMessage, 'attachments'>[],
): DeleteConfirmCopy | null {
  const withFiles = messages.filter((m) => m.attachments.length > 0);
  if (withFiles.length === 0) return null;
  const one = messages.length === 1;
  const firstName = withFiles[0]?.attachments.find((a) => a.name !== '')?.name ?? '';
  return {
    title: one ? DELETE_FILES_TITLE_ONE : DELETE_FILES_TITLE_MANY,
    message: one && firstName !== '' ? deleteFilesMessageOne(firstName) : DELETE_FILES_MESSAGE_MANY,
    confirmLabel: DELETE_FILES_CONFIRM,
  };
}

/**
 * The recorded attachment asset ids of these messages, deduped; uploads still
 * in flight (no id yet) carry none. Read from the thread before the delete.
 */
export function attachmentAssetIds(
  messages: readonly Pick<ThreadMessage, 'id' | 'attachments'>[],
  messageIds: readonly string[],
): string[] {
  const wanted = new Set(messageIds);
  const ids = new Set<string>();
  for (const message of messages) {
    if (!wanted.has(message.id)) continue;
    for (const attachment of message.attachments) {
      if (attachment.assetId !== '') ids.add(attachment.assetId);
    }
  }
  return [...ids];
}

export type PurgeChatOutcome = { ok: true; data: PurgeChatResponse } | { ok: false; error: string };

interface PurgeChatConfig {
  /** The asset-upload worker base URL; the /purge-chat route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  assetIds: readonly string[];
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST {workspace_id, asset_ids} to the worker's /purge-chat route with a
 * Bearer token. Never throws: a transport failure or a non-OK status becomes
 * { ok: false } with a log-only reason (nothing here is user copy).
 */
export async function purgeChatFiles(config: PurgeChatConfig): Promise<PurgeChatOutcome> {
  const body: PurgeChatRequest = {
    workspace_id: config.workspaceId,
    asset_ids: [...config.assetIds],
  };
  let response: Response;
  try {
    response = await config.fetcher(`${config.endpoint.replace(/\/+$/, '')}/purge-chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  if (!response.ok) return { ok: false, error: `purge-chat ${response.status}` };
  try {
    return { ok: true, data: (await response.json()) as PurgeChatResponse };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

interface DeleteFlowDeps {
  client: Client;
  /** Turn accepted ids into tombstones in the thread (and tell the store). */
  markDeletedLocal: (ids: string[]) => void;
  /** Publish the live delete command; undefined while there is no connection. */
  signal: ((ext: Record<string, unknown>) => Promise<unknown>) | undefined;
  onSignalFailed: (error: unknown) => void;
  /** The attachment asset ids of these messages, read before the delete; absent: none. */
  collectAssetIds?: (messageIds: readonly string[]) => string[];
  /** POST /purge-chat for the collected ids (see purgeChatFiles). */
  purgeChat?: (assetIds: string[]) => Promise<PurgeChatOutcome>;
  onPurgeFailed?: (error: string) => void;
}

export async function runDelete(
  deps: DeleteFlowDeps,
  input: { channelId: string; messageIds: readonly string[]; traceId: string },
): Promise<{ ok: true; toast?: string } | { ok: false; message: string; deleted: string[] }> {
  // Before the record: the delete wipes the ids the files are found by.
  const assetIds = deps.collectAssetIds?.(input.messageIds) ?? [];
  const result = await deleteMessagesRecord({
    client: deps.client,
    channelId: input.channelId,
    messageIds: input.messageIds,
    traceId: input.traceId,
    onChunkDeleted: (ids) => {
      deps.markDeletedLocal(ids);
      if (deps.signal === undefined) return;
      let pending: Promise<unknown>;
      try {
        pending = deps.signal(deleteEventExt({ messageIds: ids }));
      } catch (error) {
        deps.onSignalFailed(error);
        return;
      }
      void pending.catch((error: unknown) => deps.onSignalFailed(error));
    },
  });
  if (!result.ok) return { ok: false, message: result.message, deleted: result.deleted };
  if (assetIds.length === 0) return { ok: true };
  if (deps.purgeChat !== undefined) {
    try {
      const purged = await deps.purgeChat(assetIds);
      if (!purged.ok) deps.onPurgeFailed?.(purged.error);
    } catch (error) {
      deps.onPurgeFailed?.(String(error));
    }
  }
  return { ok: true, toast: FILES_DELETED_TOAST };
}

interface EditFlowDeps {
  client: Client;
  /** Show the recorded row (new body and edited_at) in the thread. */
  applyLocal: (row: ChatMessageRow) => void;
  /** Publish the live edit command; undefined while there is no connection. */
  signal: ((ext: Record<string, unknown>) => Promise<unknown>) | undefined;
  onSignalFailed: (error: unknown) => void;
  /** Re-read the chat's members after a refused mention; defaults to readChannelMemberIds. */
  recheckMentions?: (channelId: string) => Promise<Result<string[]>>;
  /** Override for tests. */
  timeoutMs?: number;
}

export async function runEdit(
  deps: EditFlowDeps,
  input: {
    channelId: string;
    messageId: string;
    body: string;
    traceId: string;
    /** The chat's type; a DM never sends "all" in p_mentions. */
    channelType?: 'dm' | 'group' | 'notes';
  },
): Promise<{ ok: true } | { ok: false; message: string; error: string }> {
  const edit = (mentions: string[]): ReturnType<typeof editMessageRecord> =>
    editMessageRecord({
      client: deps.client,
      channelId: input.channelId,
      messageId: input.messageId,
      body: input.body,
      mentions,
      traceId: input.traceId,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  let mentions = mentionTargets(input.body, input.channelType);
  let result = await edit(mentions);
  // As runSend: the chat's type was unknown and "all" went out in a DM: drop
  // only "all" and edit with the people first; a further refusal takes the
  // ladder below.
  if (
    !result.ok &&
    input.channelType === undefined &&
    mentions.includes(ALL_MENTION) &&
    isEveryoneRefusal(result.message)
  ) {
    mentions = mentions.filter((id) => id !== ALL_MENTION);
    result = await edit(mentions);
  }
  if (!result.ok && mentions.length > 0 && isMentionRefusal(result.message)) {
    const read =
      deps.recheckMentions ??
      ((channelId: string) => readChannelMemberIds(deps.client, { channelId }));
    const retry = mentionsAfterRefusal(mentions, await recheck(read, input.channelId));
    result = await edit(retry);
    // Refused again: the last step edits without mentions, never a failed edit.
    if (!result.ok && retry.length > 0 && isMentionRefusal(result.message)) {
      result = await edit([]);
    }
  }
  if (!result.ok) {
    return { ok: false, message: editFailureCopy(result.message), error: result.message };
  }
  const row = result.row;
  deps.applyLocal(row);
  if (deps.signal !== undefined) {
    let pending: Promise<unknown> | null = null;
    try {
      pending = deps.signal(
        editEventExt({
          messageId: row.id,
          body: row.body ?? '',
          editedAt: row.edited_at ?? new Date().toISOString(),
        }),
      );
    } catch (error) {
      deps.onSignalFailed(error);
    }
    if (pending !== null) void pending.catch((error: unknown) => deps.onSignalFailed(error));
  }
  return { ok: true };
}
