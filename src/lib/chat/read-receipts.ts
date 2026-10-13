// The reading layer's pure rules: who has read a message, where the DM "Seen"
// line and the group "Read by" line go, and the first unread message as the
// viewer's cursor stood on open. A member has read message M when their cursor
// message is M or newer, compared by created_at, then id (the keyset order of
// chat_messages). No React, no reads: the hook feeds these from one batched
// chat_read_cursors select, so every rule is unit-tested without a client.

import type { ThreadMessage } from '@/lib/chat/thread';

/** A point in the thread's (created_at, id) order. */
export interface ThreadPoint {
  /** Epoch ms of created_at. */
  time: number;
  id: string;
}

/** One member's read position: the cursor message's point plus last_read_at and read_at. */
export interface ReadPosition extends ThreadPoint {
  userId: string;
  /** chat_read_cursors.last_read_at as stored (the cursor message's created_at; ordering only). */
  lastReadAt: string;
  /** chat_read_cursors.read_at: when the cursor last advanced (display only); null when unknown. */
  readAt: string | null;
}

/** A raw chat_read_cursors row, as the channel read returns it. */
export interface ReadCursorRow {
  userId: string;
  lastReadMessageId: string;
  lastReadAt: string;
  readAt: string | null;
}

/** True when a cursor at `cursor` covers message `m` (the cursor is m or newer). Pure. */
export function covers(cursor: ThreadPoint, m: ThreadPoint): boolean {
  if (cursor.time !== m.time) return cursor.time > m.time;
  return cursor.id >= m.id;
}

/**
 * Resolve cursor rows to positions. Each cursor message's created_at comes from
 * `timeOf` (loaded thread or a batched lookup); a cursor whose message cannot
 * be resolved falls back to its last_read_at, which is never earlier than the
 * message it points at. Pure.
 */
export function resolvePositions(
  rows: readonly ReadCursorRow[],
  timeOf: (messageId: string) => number | undefined,
): Map<string, ReadPosition> {
  const out = new Map<string, ReadPosition>();
  for (const row of rows) {
    const known = timeOf(row.lastReadMessageId);
    const fallback = Date.parse(row.lastReadAt);
    const time = known ?? (Number.isNaN(fallback) ? 0 : fallback);
    out.set(row.userId, {
      userId: row.userId,
      id: row.lastReadMessageId,
      time,
      lastReadAt: row.lastReadAt,
      readAt: row.readAt,
    });
  }
  return out;
}

/** Whether a message counts for receipts: recorded, own, not deleted. */
function receiptable(m: ThreadMessage): boolean {
  return m.mine && m.state === 'sent' && m.deleted !== true && m.createdAt !== '';
}

/**
 * Who of `memberIds` has read `message`: the sender is never counted, and a
 * cursor of anyone not in `memberIds` (an ex-member) is ignored. Pure.
 */
export function readersOf(
  message: ThreadPoint & { senderUserId: string | null },
  positions: ReadonlyMap<string, ReadPosition>,
  memberIds: readonly string[],
): { read: ReadPosition[]; unread: string[] } {
  const read: ReadPosition[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  for (const id of memberIds) {
    if (id === message.senderUserId || seen.has(id)) continue;
    seen.add(id);
    const pos = positions.get(id);
    if (pos !== undefined && covers(pos, message)) read.push(pos);
    else unread.push(id);
  }
  return { read, unread };
}

/**
 * The DM "Seen" slot: the LAST own recorded message the peer's cursor covers,
 * with the peer's read_at (when they read it; null when unknown). Never a
 * sending, failed or deleted bubble; null when the peer has read none of mine
 * (or has no cursor). Pure.
 */
export function seenLineTarget(
  messages: readonly ThreadMessage[],
  peer: ReadPosition | undefined,
): { messageId: string; readAt: string | null } | null {
  if (peer === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || !receiptable(m)) continue;
    if (covers(peer, m)) return { messageId: m.id, readAt: peer.readAt };
  }
  return null;
}

/**
 * The group "Read by" slot: the LAST own message, when it is recorded (a
 * sending or failed last message shows no line). Deleted ones are skipped. Pure.
 */
export function readByTarget(messages: readonly ThreadMessage[]): ThreadMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || !m.mine || m.deleted === true) continue;
    return receiptable(m) ? m : null;
  }
  return null;
}

/** "Read by all" when everyone has, else "Read by X of Y"; null with nobody to read it. Pure. */
export function readByLabel(read: number, total: number): string | null {
  if (total <= 0) return null;
  return read >= total ? 'Read by all' : `Read by ${read} of ${total}`;
}

/** The viewer's cursor as captured on open: a position, no row at all, or not known. */
export type OpenCursor =
  | { kind: 'cursor'; position: ThreadPoint }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** The viewer's open cursor from a cursors read: its position, or 'none' without a row. Pure. */
export function openCursorFrom(
  read: { rows: readonly ReadCursorRow[]; times: ReadonlyMap<string, number> },
  viewerId: string,
): OpenCursor {
  const own = read.rows.find((row) => row.userId === viewerId);
  if (own === undefined) return { kind: 'none' };
  const position = resolvePositions([own], (id) => read.times.get(id)).get(viewerId);
  return position === undefined
    ? { kind: 'unknown' }
    : { kind: 'cursor', position: { time: position.time, id: position.id } };
}

/** Where the unread run starts, as the open cursor puts it. */
export type FirstUnread =
  /** The first unread message is loaded: the divider goes above it. */
  | { kind: 'loaded'; firstId: string; count: number }
  /** It is older than the loaded pages: load back to the cursor message first. */
  | { kind: 'beyond'; cursorId: string; count: number };

/**
 * The first unread message from the cursor captured on open (never the cursor
 * written after open). Unread = someone else's recorded message newer than the
 * cursor. With the cursor message not loaded while older pages remain, the run
 * starts above the loaded history ('beyond'); its count is the larger of the
 * loaded run and `unreadAtOpen` (the chat list's count on open). With no
 * cursor row, the run is everything only when the whole history is loaded.
 * Null when nothing is unread or the cursor is not known. Pure.
 */
export function firstUnread(input: {
  messages: readonly ThreadMessage[];
  open: OpenCursor;
  hasMore: boolean;
  unreadAtOpen: number;
}): FirstUnread | null {
  const { messages, open } = input;
  if (open.kind === 'unknown') return null;
  if (open.kind === 'none' && input.hasMore) return null;
  const isUnread = (m: ThreadMessage): boolean =>
    !m.mine &&
    m.deleted !== true &&
    m.createdAt !== '' &&
    (open.kind === 'none' || !covers(open.position, m));
  let firstId: string | null = null;
  let count = 0;
  for (const m of messages) {
    if (!isUnread(m)) continue;
    firstId ??= m.id;
    count += 1;
  }
  if (open.kind === 'cursor') {
    const cursorLoaded = messages.some((m) => m.id === open.position.id);
    const olderThanLoaded =
      !cursorLoaded &&
      input.hasMore &&
      messages.length > 0 &&
      messages.every((m) => m.createdAt === '' || !covers(open.position, m));
    if (olderThanLoaded && count > 0) {
      return {
        kind: 'beyond',
        cursorId: open.position.id,
        count: Math.max(count, input.unreadAtOpen),
      };
    }
  }
  return firstId === null ? null : { kind: 'loaded', firstId, count };
}

/** The unread divider and pill label: "N unread". */
export function unreadLabel(count: number): string {
  return `${count} unread`;
}
