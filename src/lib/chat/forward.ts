// Forwarding messages to other chats. Pure pieces only (no React, no SDK, no
// client) so the unit job covers them: which messages can be forwarded and in
// what order, the thread's selection rules now that selection serves both
// Forward (anyone's recorded message) and Delete (own, unmarked only), the
// picker's channel list and copy, the record input for one forwarded copy, and
// the sequential run that stops at the first failing chat.

import type { ChannelSummary } from '@/lib/chat-reads';
import { filterChannelsByName } from '@/lib/channel-filter';
import { sortChannelsByRecency, type RecencySummary } from '@/lib/chat/sort-conversations';
import { buildAttachmentMeta } from '@/lib/chat/attachments';
import { previewText } from '@/lib/chat/chat-store';
import type { ChatMark, SelectionRole } from '@/lib/chat/marks';
import type { SendRecordParams } from '@/lib/chat/record';
import { compareMessages, type ThreadMessage } from '@/lib/chat/thread';

/**
 * Only a recorded, live message can be forwarded: a sending or failed bubble
 * has no row yet, and a deleted one is a tombstone with no content.
 */
export function canForward(message: Pick<ThreadMessage, 'state' | 'deleted'>): boolean {
  return message.state === 'sent' && message.deleted !== true;
}

/** The forwardable messages among `messages`, in thread (original) order. */
export function forwardableInOrder(messages: readonly ThreadMessage[]): ThreadMessage[] {
  return messages.filter(canForward).sort(compareMessages);
}

/**
 * How a row takes part in thread selection: any recorded, live message can be
 * checked (Forward takes anyone's; a mark only blocks Delete, never the
 * selection), and pending, failed and deleted ones show nothing.
 */
export function threadSelectionRole(
  message: Pick<ThreadMessage, 'state' | 'deleted'>,
): SelectionRole {
  return canForward(message) ? 'selectable' : 'none';
}

/** Selection mode in the thread: whether the row can be checked. */
export function threadSelectable(message: Pick<ThreadMessage, 'state' | 'deleted'>): boolean {
  return threadSelectionRole(message) === 'selectable';
}

/** Keep only selected ids that are still loaded and selectable. */
export function pruneThreadSelection(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
): Set<string> {
  const allowed = new Set(messages.filter((m) => threadSelectable(m)).map((m) => m.id));
  return new Set([...selected].filter((id) => allowed.has(id)));
}

/** Own messages can be deleted for everyone this long after their server created_at. */
export const DELETE_SELECTION_WINDOW_MS = 30 * 60 * 1000;

/** Why the selection's Delete is disabled; the bar shows it as one line. */
export type DeleteBlock = 'others' | 'marked' | 'old';

/** The reason line for each disabled Delete. */
export const DELETE_BLOCK_COPY: Record<DeleteBlock, string> = {
  others: 'Only your own messages can be deleted',
  marked: "Marked messages can't be deleted",
  old: "Messages older than 30 min can't be deleted",
};

/** Which reason wins when several apply. */
const DELETE_BLOCK_PRIORITY: readonly DeleteBlock[] = ['others', 'marked', 'old'];

/**
 * Why Delete cannot apply to the selection, or null when it can (or nothing is
 * selected: Delete is simply disabled at 0 with no reason). Priority: someone
 * else's message, then a marked one, then age (sending and failed rows are
 * never selectable). `nowMs` is server time (the store's clock offset applied),
 * never the device clock alone.
 */
export function deleteSelectionBlock(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
  marks: Map<string, ChatMark>,
  nowMs: number,
  /** Notes: own notes delete at any age (no 30 minute window). */
  noWindow = false,
): DeleteBlock | null {
  if (selected.size === 0) return null;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const hit = new Set<DeleteBlock>();
  for (const id of selected) {
    const message = byId.get(id);
    if (message === undefined || !message.mine || message.deleted === true) {
      hit.add('others');
      continue;
    }
    if (marks.has(id)) hit.add('marked');
    const created = Date.parse(message.createdAt);
    if (noWindow) continue;
    if (Number.isNaN(created) || nowMs - created > DELETE_SELECTION_WINDOW_MS) hit.add('old');
  }
  return DELETE_BLOCK_PRIORITY.find((block) => hit.has(block)) ?? null;
}

/**
 * Milliseconds from `nowMs` (server time) until the earliest selected own
 * message leaves the 30 minute window (Delete and its reason re-compute
 * then), or null when none is still inside it. Pure.
 */
export function nextSelectionBoundaryMs(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
  nowMs: number,
): number | null {
  let earliest: number | null = null;
  for (const message of messages) {
    if (!selected.has(message.id) || !message.mine || message.state !== 'sent') continue;
    const created = Date.parse(message.createdAt);
    if (Number.isNaN(created)) continue;
    // Delete allows age <= window, so it changes just after the boundary.
    const at = created + DELETE_SELECTION_WINDOW_MS + 1;
    if (at > nowMs && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest === null ? null : earliest - nowMs;
}

/**
 * While selecting: one timeout for the moment the earliest selected own
 * message leaves the Delete window, which calls `onBoundary` (Delete and its
 * reason re-compute; the caller schedules again). No interval. Returns the
 * cancel, which the caller runs on exit and unmount.
 */
export function scheduleSelectionBoundary(input: {
  selected: ReadonlySet<string>;
  messages: readonly ThreadMessage[];
  /** Server time now (device clock plus the store's offset). */
  now: () => number;
  onBoundary: () => void;
}): () => void {
  const delay = nextSelectionBoundaryMs(input.selected, input.messages, input.now());
  if (delay === null) return () => {};
  const handle = setTimeout(input.onBoundary, delay);
  return () => clearTimeout(handle);
}

/**
 * Delete stays own-only: every selected message must be the caller's own,
 * recorded, unmarked (the proc refuses marked ones) and inside the 30 minute
 * window on server time. False at 0.
 */
export function canDeleteSelection(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
  marks: Map<string, ChatMark>,
  nowMs: number,
): boolean {
  return selected.size > 0 && deleteSelectionBlock(selected, messages, marks, nowMs) === null;
}

/** The selected messages to forward, in thread order. */
export function selectedForForward(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
): ThreadMessage[] {
  return forwardableInOrder(messages.filter((m) => selected.has(m.id)));
}

/**
 * The picker's chats: every channel the caller is in (hidden ones included),
 * most recent first, then narrowed by the name search.
 */
export function forwardPickerChannels(
  channels: readonly ChannelSummary[],
  summaryFor: (channelId: string) => RecencySummary | undefined,
  query: string,
): ChannelSummary[] {
  // Personal notes is always first (D9); the rest by recency.
  const notes = channels.filter((c) => c.channelType === 'notes');
  const rest = sortChannelsByRecency(
    channels.filter((c) => c.channelType !== 'notes'),
    summaryFor,
  );
  return filterChannelsByName([...notes, ...rest], query);
}

/** Toggle a chat in the picker's selection (new Set). */
export function toggleForwardTarget(selected: ReadonlySet<string>, channelId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(channelId)) next.delete(channelId);
  else next.add(channelId);
  return next;
}

/** The picker's send button label. */
export function sendToLabel(count: number): string {
  return `Send to ${count} ${count === 1 ? 'chat' : 'chats'}`;
}

/** Toast when forwarding to a chat failed. */
export function forwardFailedMessage(title: string): string {
  return `Couldn't forward to ${title}. Try again.`;
}

/** The label shown above a forwarded message's body. */
export const FORWARDED_LABEL = 'Forwarded';

/**
 * The record input for one forwarded copy: a fresh id, the source's body,
 * attachments (same asset ids and meta, never re-uploaded), shared posts and
 * briefs, no reply, no mentions, and the source id. Marks are not carried.
 */
export function forwardRecordInput(
  source: ThreadMessage,
  ids: { id: string; channelId: string; traceId: string },
): Omit<SendRecordParams, 'client'> {
  return {
    id: ids.id,
    channelId: ids.channelId,
    traceId: ids.traceId,
    body: source.body,
    attachmentAssetIds: source.attachments.map((a) => a.assetId),
    attachmentMeta: buildAttachmentMeta(source.attachments),
    sharedPostIds: [...source.sharedPostIds],
    sharedBriefIds: [...source.sharedBriefIds],
    replyToMessageId: null,
    forwardedFromMessageId: source.id,
  };
}

/** The chat-list preview line for a forwarded copy. */
export function forwardPreviewText(source: ThreadMessage): string {
  return previewText({
    body: source.body,
    hasAttachments:
      source.attachments.length > 0 ||
      source.sharedPostIds.length > 0 ||
      source.sharedBriefIds.length > 0,
  });
}

export type ForwardRunResult<T> = { ok: true } | { ok: false; failed: T; message: string };

/**
 * Forward sequentially: for each chat, each message in order. The first failed
 * send stops the whole run and names its chat; chats after it are untouched.
 */
export async function runForward<T>(deps: {
  targets: readonly T[];
  messages: readonly ThreadMessage[];
  sendOne: (
    target: T,
    message: ThreadMessage,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}): Promise<ForwardRunResult<T>> {
  for (const target of deps.targets) {
    for (const message of deps.messages) {
      const result = await deps.sendOne(target, message);
      if (!result.ok) return { ok: false, failed: target, message: result.message };
    }
  }
  return { ok: true };
}

/**
 * The open thread's way out of selection mode (through history.back()), or
 * null when no selection is open. A channel switch goes through
 * leaveSelectionThen so selection exits first, then the switch runs.
 */
let selectionLeave: ((then: () => void) => void) | null = null;

/** The thread registers its selection exit while selecting. */
export function setSelectionLeave(leave: (then: () => void) => void): void {
  selectionLeave = leave;
}

/** Selection exited: forget its exit (only if it is still the registered one; null forgets any). */
export function clearSelectionLeave(leave: ((then: () => void) => void) | null): void {
  if (leave === null || selectionLeave === leave) selectionLeave = null;
}

/** Run `run` once no selection is open: at once, or after selection exits. */
export function leaveSelectionThen(run: () => void): void {
  const leave = selectionLeave;
  if (leave === null) {
    run();
    return;
  }
  leave(run);
}
