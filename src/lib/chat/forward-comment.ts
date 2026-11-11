// A post or brief comment forwarded to chats (Thread polish 2, 11 Nov 2026).
// Chat's own mechanics: the Forward picker, then for each picked chat ONE chat
// message through the send record carrying the comment's text AND its files.
// The files go as the comment's stored attachment ids exactly as they are
// (the same asset version ids, never re-uploaded), with attachment_meta built
// the way a forwarded chat message's is (forwardRecordInput). A comment is not
// a chat message, so forwarded_from_message_id stays null. Both callers (the
// comments screen and catch up) run through forwardComment, so neither can
// drop the files. Pure pieces plus one sequential run; nothing here reads on a
// tap: `load` runs after the picker's Send.

import type { MessageAttachment } from '@/lib/chat/attachments';
import { forwardRecordInput, runForward } from '@/lib/chat/forward';
import type { SendRecordParams } from '@/lib/chat/record';

/** What a comment sends: its text and its files (one per stored attachment id, in order). */
export interface CommentForwardSource {
  body: string;
  attachments: readonly MessageAttachment[];
}

/**
 * Forward is offered on a comment that is sent, not deleted, and has text or
 * at least one file (a file-only comment forwards its files). Pure.
 */
export function canForwardComment(comment: {
  sent: boolean;
  deleted: boolean;
  body: string;
  fileCount: number;
}): boolean {
  if (!comment.sent || comment.deleted) return false;
  return comment.body.trim() !== '' || comment.fileCount > 0;
}

/**
 * The record input for one forwarded copy of a comment: chat's own forward
 * input (body, every attachment id as stored, their meta), no source message
 * id. Pure.
 */
export function commentForwardRecord(
  source: CommentForwardSource,
  ids: { id: string; channelId: string; traceId: string },
): Omit<SendRecordParams, 'client'> {
  return {
    ...forwardRecordInput(
      {
        id: '',
        body: source.body,
        attachments: [...source.attachments],
        sharedPostIds: [],
        sharedBriefIds: [],
      },
      ids,
    ),
    forwardedFromMessageId: null,
  };
}

export type CommentForwardResult<T> = { ok: true } | { ok: false; failed: T | null };

/**
 * Forward one comment to each picked chat, in order; the first failed send
 * stops the run and names its chat (chat's runForward). `load` gives the
 * comment's text and files and runs here, after the picker's Send (it may
 * read file details the screen does not hold yet); null (the read failed) or
 * nothing to send fails the forward on its first chat, and the picker toasts.
 */
export async function forwardComment<T extends { channelId: string }>(deps: {
  targets: readonly T[];
  load: () => Promise<CommentForwardSource | null>;
  send: (record: Omit<SendRecordParams, 'client'>) => Promise<{ ok: boolean }>;
  newId: () => string;
  newTrace: () => string;
}): Promise<CommentForwardResult<T>> {
  if (deps.targets.length === 0) return { ok: true };
  const source = await deps.load();
  if (source === null || (source.body.trim() === '' && source.attachments.length === 0)) {
    return { ok: false, failed: deps.targets[0] ?? null };
  }
  const run = await runForward({
    targets: deps.targets,
    messages: [source],
    sendOne: async (target, comment) => {
      const sent = await deps.send(
        commentForwardRecord(comment, {
          id: deps.newId(),
          channelId: target.channelId,
          traceId: deps.newTrace(),
        }),
      );
      return sent.ok ? { ok: true } : { ok: false, message: 'Not sent' };
    },
  });
  return run.ok ? { ok: true } : { ok: false, failed: run.failed };
}
