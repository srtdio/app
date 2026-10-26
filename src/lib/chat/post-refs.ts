// Post references in a thread, pure. A card message is one that shares posts
// (shared_post_ids). A message "about" a post is a reply whose target is a card
// message: outside a card's thread (thread-rail.ts) it renders a KEY chip
// instead of a quote. The composer's hash picker opens while the text at the
// caret is a hash token. Client-side over the loaded pages only; no reads here.

import type { ReplyQuote } from '@/lib/chat/attachments';
import type { ThreadMessage } from '@/lib/chat/thread';
import { awaitsRootHydration, chipCountRoot, type RootFields } from '@/lib/chat/thread-rail';

type CardFields = Pick<ThreadMessage, 'sharedPostIds'>;
type RefFields = Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds'>;

/** Post ids of a card message, keyed by its message id. */
type ParentIndex = ReadonlyMap<string, readonly string[]>;

/** The chip a message carries: the card message it replies to and that card's post. */
interface ChipTarget {
  cardMessageId: string;
  postId: string;
}

/** A message that shares at least one post (it renders post cards). */
export function isCardMessage(row: CardFields): boolean {
  return row.sharedPostIds.length > 0;
}

/** Index the loaded card messages by id (the chip parents present in the pages). */
export function parentIndexOf(rows: readonly RefFields[]): Map<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const row of rows) if (isCardMessage(row)) index.set(row.id, row.sharedPostIds);
  return index;
}

/**
 * The chip for a message, or null when its reply target is not a card message.
 * The parent's post ids come from the loaded row when present, else from the
 * hydrated parentSharedPostIds (the resolveReplies IN read). A card that shares
 * several posts is about its first.
 */
export function chipTargetFor(row: RefFields, parentIndex: ParentIndex): ChipTarget | null {
  if (row.reply === null) return null;
  const postIds = parentIndex.get(row.reply.id) ?? row.parentSharedPostIds ?? [];
  const postId = postIds[0];
  return postId !== undefined ? { cardMessageId: row.reply.id, postId } : null;
}

/** The distinct post ids of every chip in the rows, sorted (the chip batch's key). */
export function chipPostIds(rows: readonly RefFields[], parentIndex: ParentIndex): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const target = chipTargetFor(row, parentIndex);
    if (target !== null) ids.add(target.postId);
  }
  return [...ids].sort();
}

/** The newest loaded card message sharing the post, or null. */
export function newestCardFor<T extends Pick<ThreadMessage, 'id' | 'sharedPostIds'>>(
  rows: readonly T[],
  postId: string,
): T | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && row.sharedPostIds.includes(postId)) return row;
  }
  return null;
}

/** A share waiting for its card message: the post, the ids and the newest time loaded when it was sent. */
interface ExpectedCard {
  postId: string;
  known: ReadonlySet<string>;
  /** The newest loaded message time when the share was sent; the card orders after it. */
  after: number;
}

/** Snapshot what is loaded when a share is sent, so only its own card can match. */
export function expectedCard(
  rows: readonly Pick<ThreadMessage, 'id' | 'time'>[],
  postId: string,
): ExpectedCard {
  let after = Number.NEGATIVE_INFINITY;
  for (const row of rows) if (row.time > after) after = row.time;
  return { postId, known: new Set(rows.map((r) => r.id)), after };
}

/**
 * The card message a share just queued, newest first: an own outbox bubble
 * (still 'sending' or 'failed', so a live echo of a send from another device,
 * which arrives 'sent', never matches) that was not loaded when the share was
 * sent, orders after everything loaded then (an own card on an older page
 * loaded since never matches), and shares the post. Null until it lands.
 */
export function newCardFor<
  T extends Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'mine' | 'state' | 'time'>,
>(rows: readonly T[], expected: ExpectedCard): T | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined || row.time <= expected.after) continue;
    if (!row.mine || row.state === 'sent' || expected.known.has(row.id)) continue;
    if (row.sharedPostIds.includes(expected.postId)) return row;
  }
  return null;
}

/** A share's card that has not appeared is forgotten after this long. */
export const EXPECT_CARD_MS = 30_000;

/** The one share a thread waits on to turn its card into the About. */
interface CardExpectation {
  /**
   * Wait for the card of a share about to be sent. False (and nothing waited
   * on) when the thread cannot send; the caller tells the user.
   */
  expect: (
    rows: readonly Pick<ThreadMessage, 'id' | 'time'>[],
    postId: string,
    canSend: boolean,
  ) => boolean;
  /** The card, once it is in the rows; resolving stops the wait. */
  resolve: (
    rows: readonly Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'mine' | 'state' | 'time'>[],
  ) => { postId: string; cardMessageId: string } | null;
  /** Stop waiting (conversation switch, unmount, a new share). */
  clear: () => void;
  pending: () => ExpectedCard | null;
}

export function createCardExpectation(
  timers: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  } = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  timeoutMs: number = EXPECT_CARD_MS,
): CardExpectation {
  let current: ExpectedCard | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    current = null;
  };
  return {
    expect: (rows, postId, canSend) => {
      clear();
      if (!canSend) return false;
      current = expectedCard(rows, postId);
      timer = timers.set(clear, timeoutMs);
      return true;
    },
    resolve: (rows) => {
      if (current === null) return null;
      const card = newCardFor(rows, current);
      if (card === null) return null;
      const postId = current.postId;
      clear();
      return { postId, cardMessageId: card.id };
    },
    clear,
    pending: () => current,
  };
}

/** A reply read from a row whose quote (and its parent's post ids) is not resolved yet. */
function isUnhydratedReply(row: Pick<ThreadMessage, 'reply'>): boolean {
  return row.reply !== null && row.reply.preview === '';
}

/**
 * How long a page row waits for its reply hydration (the resolveReplies IN
 * read) before it goes on screen with the blank quote it has today. A failed
 * read never settles the quote, so the wait must be bounded.
 */
export const PAGE_HYDRATION_WAIT_MS = 4_000;

type GateFields = RefFields & RootFields & Pick<ThreadMessage, 'time'>;

/**
 * Which rows of a conversation are on screen. Page rows (the first page, an
 * older page) wait until every one of them is ready and then go on together,
 * so a page appears whole, with its chips; a row that arrives after the page
 * (an own send, a live message) is newer than everything shown and never
 * waits. Kept per conversation; the shown list is always cut from the latest
 * rows, so a state change on a shown row is never delayed.
 */
export interface PageGate {
  key: string;
  shown: Set<string>;
  /** The newest time on screen; anything newer is an arrival, not a page row. */
  newestShown: number;
  /** Page rows not on screen yet, with when they were first seen (ms). */
  pending: Map<string, number>;
  /** The last cut, returned again while the on-screen rows are unchanged. */
  last: readonly GateFields[];
}

interface RowReadiness {
  parentIndex: ParentIndex;
  /** The chip post is in the batch (a row or null) or its read was attempted. */
  chipSettled: (postId: string) => boolean;
  nowMs: number;
  /** Every loaded message id (thread roots on any page count as loaded). */
  loaded?: ReadonlySet<string>;
  /** A not-loaded thread root's count is in, or its read ended without one. */
  countSettled?: (rootId: string) => boolean;
  /** The card post a row's thread names (its chip and the thread view), null off a thread. */
  threadPost?: (row: GateFields) => string | null;
}

/**
 * Whether a page row's thread is ready: a row whose thread root is not loaded
 * waits for the root's hydration (capped, then it paints as a plain reply); a
 * member waits for its card's post, and a member of a not-loaded card root
 * for the page's counts read too, so its chip paints whole.
 */
function threadReady(row: GateFields, since: number, r: RowReadiness): boolean {
  const loaded = r.loaded;
  if (loaded === undefined) return true;
  if (awaitsRootHydration(row, loaded)) return r.nowMs - since >= PAGE_HYDRATION_WAIT_MS;
  const post = r.threadPost?.(row) ?? null;
  if (post !== null && !r.chipSettled(post)) return false;
  const root = chipCountRoot(row, loaded);
  return root === null || (r.countSettled?.(root) ?? true);
}

/**
 * Whether a page row can go on screen: its thread is ready; its chip post is
 * settled when it has a chip; an unhydrated reply whose parent is not loaded
 * waits for hydration (capped); anything else is ready at once.
 */
export function rowReady(row: GateFields, since: number, r: RowReadiness): boolean {
  if (!threadReady(row, since, r)) return false;
  const target = chipTargetFor(row, r.parentIndex);
  if (target !== null) return r.chipSettled(target.postId);
  if (isUnhydratedReply(row)) return r.nowMs - since >= PAGE_HYDRATION_WAIT_MS;
  return true;
}

/**
 * Cut the on-screen rows from the latest list. Rows never seen before are
 * arrivals (newer than everything shown: on at once) or page rows (pending);
 * pending rows go on together once every one is ready. The gate is updated in
 * place and returned. With nothing pending the input array is returned as is;
 * otherwise the previous cut is returned while its rows are unchanged.
 */
export function admitRows<T extends GateFields>(
  prev: PageGate | null,
  key: string,
  rows: readonly T[],
  ready: (row: T, since: number) => boolean,
  nowMs: number,
): { gate: PageGate; rows: T[] } {
  const gate: PageGate =
    prev !== null && prev.key === key
      ? prev
      : {
          key,
          shown: new Set(),
          newestShown: Number.NEGATIVE_INFINITY,
          pending: new Map(),
          last: [],
        };
  const ids = new Set(rows.map((r) => r.id));
  for (const id of gate.shown) if (!ids.has(id)) gate.shown.delete(id);
  for (const id of gate.pending.keys()) if (!ids.has(id)) gate.pending.delete(id);
  for (const row of rows) {
    if (gate.shown.has(row.id) || gate.pending.has(row.id)) continue;
    if (gate.shown.size > 0 && row.time > gate.newestShown) gate.shown.add(row.id);
    else gate.pending.set(row.id, nowMs);
  }
  if (gate.pending.size > 0) {
    let all = true;
    for (const row of rows) {
      const since = gate.pending.get(row.id);
      if (since !== undefined && !ready(row, since)) {
        all = false;
        break;
      }
    }
    if (all) {
      for (const id of gate.pending.keys()) gate.shown.add(id);
      gate.pending.clear();
    }
  }
  let out = gate.pending.size === 0 ? (rows as T[]) : rows.filter((r) => gate.shown.has(r.id));
  const last = gate.last as readonly T[];
  if (out !== rows && out.length === last.length && out.every((r, i) => r === last[i]))
    out = last as T[];
  gate.last = out;
  for (const r of out) if (r.time > gate.newestShown) gate.newestShown = r.time;
  return { gate, rows: out };
}

/** The first page is still held: nothing on screen while page rows wait. */
export function holdingFirstPage(gate: PageGate): boolean {
  return gate.shown.size === 0 && gate.pending.size > 0;
}

/**
 * When the earliest pending row waiting on hydration may go on screen without
 * it (ms), or null when no pending row waits on hydration. The thread sets a
 * timer for it so the wait ends without a list change.
 */
export function hydrationDeadline(
  gate: PageGate,
  rows: readonly GateFields[],
  parentIndex: ParentIndex,
  loaded?: ReadonlySet<string>,
  /** Deadlines at or before this have already run out (no timer for them). */
  afterMs: number = Number.NEGATIVE_INFINITY,
): number | null {
  let deadline: number | null = null;
  for (const row of rows) {
    const since = gate.pending.get(row.id);
    if (since === undefined) continue;
    const waitsRoot = loaded !== undefined && awaitsRootHydration(row, loaded);
    const waitsQuote = isUnhydratedReply(row) && chipTargetFor(row, parentIndex) === null;
    if (!waitsRoot && !waitsQuote) continue;
    const at = since + PAGE_HYDRATION_WAIT_MS;
    if (at <= afterMs) continue;
    if (deadline === null || at < deadline) deadline = at;
  }
  return deadline;
}

/**
 * The About state from the batch: 'visible' once its post is in, 'pending'
 * while the read is in flight, 'gone' when it resolved to nothing (RLS or a
 * failed read). The About reply rides a send only while the bar is visible.
 */
export function aboutState(post: unknown): 'visible' | 'pending' | 'gone' {
  if (post === undefined) return 'pending';
  return post === null ? 'gone' : 'visible';
}

/**
 * The reply a send carries: the reply draft wins; else the About card, unless
 * the send itself shares posts (a new card is never a reply to the old one).
 */
export function replyForSend(
  reply: ReplyQuote | null,
  about: ReplyQuote | null,
  sharesPosts: boolean,
): ReplyQuote | null {
  if (reply !== null) return reply;
  return sharesPosts ? null : about;
}

/** A hash token ending at the caret: start of text or after whitespace, no spaces. */
const HASH_AT_CARET = /(^|\s)#([^\s#]*)$/;

/** The query typed after a hash at the caret, or null when the caret is not in one. */
export function caretHashQuery(text: string, caret: number): string | null {
  const match = HASH_AT_CARET.exec(text.slice(0, Math.max(0, Math.min(caret, text.length))));
  return match !== null ? (match[2] ?? '') : null;
}

/**
 * Remove the hash token ending at the caret (the whitespace before it stays) and
 * put the caret where the token began. Text without a token is returned as is.
 */
export function stripHashToken(text: string, caret: number): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const query = caretHashQuery(text, at);
  if (query === null) return { text, caret: at };
  const start = at - query.length - 1;
  return { text: text.slice(0, start) + text.slice(at), caret: start };
}
