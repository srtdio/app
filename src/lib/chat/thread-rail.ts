// iMessage-style threads for post-card replies, pure. A reply belongs to a
// thread when its thread root (chat_messages.thread_root_message_id, set by
// the record's trigger) is a post card message: those rows draw a rail
// instead of a quote or KEY chip. Replies whose root is a plain message keep
// their quote. Membership is decided once, when a row first goes on screen,
// and never changes look later because a root resolved (only a root's delete
// turns its members back into plain quotes). The rail only spans a contiguous
// run of members; a non-member row, a day pill or the unread divider ends a
// run, and the next member starts a new run headed by a chip. Counts come from
// loaded rows when the root is loaded (loaded history is contiguous back to
// the oldest page), else from one chat_thread_reply_counts call per page.
// Framework-free, so every rule is unit-tested without a DOM.

import type { Result } from '@srtdio/rpc';
import type { ReplyQuote } from '@/lib/chat/attachments';
import type { ThreadReplyCount } from '@/lib/chat/history';
import type { ThreadMessage } from '@/lib/chat/thread';

/** The fields the thread rules read off a message. */
export type RailFields = Pick<
  ThreadMessage,
  'id' | 'sharedPostIds' | 'reply' | 'threadRootId' | 'rootPostIds' | 'deleted'
>;

/** A row's thread: its root card message and the post that card shares (its first). */
export interface ThreadMembership {
  rootId: string;
  postId: string;
}

/** Membership decided per row id at first paint; null keeps today's look. */
export type MembershipMap = Map<string, ThreadMembership | null>;

/**
 * The root a reply to `parent` lands in, by the record trigger's rule
 * (coalesce(parent's root, parent id)); undefined when the parent's own root
 * is not known (an own unrecorded reply sent without one).
 */
export function senderRootFor(
  parent: Pick<ThreadMessage, 'id' | 'reply' | 'threadRootId'>,
): string | undefined {
  if (typeof parent.threadRootId === 'string') return parent.threadRootId;
  if (parent.threadRootId === null || parent.reply === null) return parent.id;
  return undefined;
}

/** A send's reply quote carrying the root derived from its loaded parent (unchanged otherwise). */
export function withThreadRoot(
  reply: ReplyQuote | null,
  parent: Pick<ThreadMessage, 'id' | 'reply' | 'threadRootId'> | undefined,
): ReplyQuote | null {
  if (reply === null || parent === undefined || parent.id !== reply.id) return reply;
  const rootId = senderRootFor(parent);
  return rootId === undefined ? reply : { ...reply, rootId };
}

/** The root a row sits under: its own, else derived from a loaded parent; null for a non-reply. */
function rowRootId(
  row: RailFields,
  byId: ReadonlyMap<string, RailFields>,
): string | null | undefined {
  if (typeof row.threadRootId === 'string') return row.threadRootId;
  if (row.threadRootId === null || row.reply === null) return null;
  const parent = byId.get(row.reply.id);
  return parent !== undefined ? senderRootFor(parent) : undefined;
}

/**
 * The post a thread root card shares: from the loaded root, else the row's
 * hydrated root post ids. Null when the root is not a card (or is deleted),
 * undefined while unknown.
 */
export function rootCardPost(
  rootId: string,
  row: RailFields,
  byId: ReadonlyMap<string, RailFields>,
): string | null | undefined {
  const root = byId.get(rootId);
  if (root !== undefined) return root.deleted === true ? null : (root.sharedPostIds[0] ?? null);
  if (row.rootPostIds !== undefined) return row.rootPostIds[0] ?? null;
  return undefined;
}

/**
 * A row's thread from what is known now: a member of a card-rooted thread,
 * null when it is not one, undefined while its root is unknown. A root that is
 * not loaded is vouched for by a loaded parent already decided in the same
 * thread (a live reply to a member).
 */
export function membershipOf(
  row: RailFields,
  byId: ReadonlyMap<string, RailFields>,
  decided: ReadonlyMap<string, ThreadMembership | null>,
): ThreadMembership | null | undefined {
  const rootId = rowRootId(row, byId);
  if (rootId === null || rootId === row.id) return null;
  if (rootId === undefined) return undefined;
  const postId = rootCardPost(rootId, row, byId);
  if (typeof postId === 'string') return { rootId, postId };
  if (postId === null) return null;
  const parentId = row.reply?.id;
  const parent = parentId !== undefined ? decided.get(parentId) : undefined;
  return parent != null && parent.rootId === rootId ? parent : undefined;
}

/**
 * Decide the rows going on screen, in order (a parent before its replies),
 * once each: a row already decided keeps its decision; one still unknown is
 * decided as not a member, so it paints with its quote and stays that way.
 * Updates `frozen` in place and returns it.
 */
export function freezeMemberships(
  rows: readonly RailFields[],
  byId: ReadonlyMap<string, RailFields>,
  frozen: MembershipMap,
): MembershipMap {
  for (const row of rows) {
    if (frozen.has(row.id)) continue;
    frozen.set(row.id, membershipOf(row, byId, frozen) ?? null);
  }
  return frozen;
}

/** A card message that can head a thread: it shares a post, is live, and is not a reply. */
export function isRootCard(
  row: Pick<ThreadMessage, 'sharedPostIds' | 'deleted' | 'reply' | 'threadRootId'>,
): boolean {
  return (
    row.sharedPostIds.length > 0 &&
    row.deleted !== true &&
    row.reply === null &&
    typeof row.threadRootId !== 'string'
  );
}

/**
 * A row's thread as it renders now: its frozen decision, unless the root card
 * is loaded and no longer a card (deleted): its members fall back to quotes.
 */
export function renderedMembership(
  rowId: string,
  frozen: ReadonlyMap<string, ThreadMembership | null>,
  byId: ReadonlyMap<string, RailFields>,
): ThreadMembership | null {
  const decided = frozen.get(rowId) ?? null;
  if (decided === null) return null;
  const root = byId.get(decided.rootId);
  if (root !== undefined && (root.deleted === true || root.sharedPostIds.length === 0)) return null;
  return decided;
}

/** Where a row sits on its thread's rail. */
export type RailRole = 'root' | 'middle' | 'last';

/** What one message row draws of the rail. */
export interface RailPlan {
  role: RailRole | null;
  /** The first member of a run its root card does not head: the root the chip above it names. */
  chipRoot: string | null;
  /** The rail goes on below this row (lines under it carry the through piece). */
  continues: boolean;
}

/** The list a rail is planned over: message rows, and the separators that end a run. */
export type RailItem<T extends RailFields = RailFields> =
  | { kind: 'break' }
  | { kind: 'message'; message: T };

export const NO_RAIL: RailPlan = { role: null, chipRoot: null, continues: false };

/**
 * Plan the rail over the rendered list. A run is consecutive members of one
 * thread, headed by its root card when the card sits right above the first
 * member, else by a chip. Any other row or a break ends it. In a run the last
 * member draws the bottom elbow; the root card draws the top elbow only when
 * a member follows it. Rows not in the map draw nothing.
 */
export function railPlans<T extends RailFields>(
  items: readonly RailItem<T>[],
  memberOf: (row: T) => ThreadMembership | null,
): Map<string, RailPlan> {
  const plans = new Map<string, RailPlan>();
  let run: { rootId: string; head: string | null; members: string[] } | null = null;
  const close = (): void => {
    if (run === null || run.members.length === 0) return;
    const { rootId, head, members } = run;
    if (head !== null) plans.set(head, { role: 'root', chipRoot: null, continues: true });
    members.forEach((id, i) => {
      const last = i === members.length - 1;
      plans.set(id, {
        role: last ? 'last' : 'middle',
        chipRoot: i === 0 && head === null ? rootId : null,
        continues: !last,
      });
    });
  };
  for (const item of items) {
    if (item.kind === 'break') {
      close();
      run = null;
      continue;
    }
    const row = item.message;
    const member = memberOf(row);
    if (member !== null && run !== null && run.rootId === member.rootId) {
      run.members.push(row.id);
      continue;
    }
    close();
    if (member !== null) run = { rootId: member.rootId, head: null, members: [row.id] };
    else if (isRootCard(row)) run = { rootId: row.id, head: row.id, members: [] };
    else run = null;
  }
  close();
  return plans;
}

/**
 * Live replies per thread root among the loaded rows: deleted ones and own
 * sends the record refused (they never land) are left out; a send still on
 * its way counts at once. One pass.
 */
export function localReplyCounts(
  rows: readonly Pick<ThreadMessage, 'threadRootId' | 'deleted' | 'state'>[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const root = row.threadRootId;
    if (typeof root !== 'string' || row.deleted === true || row.state === 'failed') continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

/** "1 reply" / "N replies"; null at 0 (nothing shows). */
export function replyCountLabel(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count === 1 ? '1 reply' : `${count} replies`;
}

/** A root's counts read: the record's count and the local count it was taken against, or none. */
export type CountEntry = { count: number; base: number } | 'none';

/**
 * A thread's reply count: counted from loaded rows when the root is loaded
 * (every reply after a loaded root is loaded); else the record's count plus
 * what changed locally since it was read (live arrivals, catch-up fills,
 * deletes). Null when it is not known (the read failed or timed out).
 */
export function threadReplyCount(input: {
  rootLoaded: boolean;
  local: number;
  entry: CountEntry | undefined;
}): number | null {
  if (input.rootLoaded) return input.local;
  if (input.entry === undefined || input.entry === 'none') return null;
  return Math.max(0, input.entry.count + input.local - input.entry.base);
}

/** The thread fields the page gate reads. */
export type RootFields = Pick<ThreadMessage, 'threadRootId' | 'rootPostIds'>;

/** A row whose thread root is not loaded and not hydrated yet. */
export function awaitsRootHydration(row: RootFields, loaded: ReadonlySet<string>): boolean {
  const root = row.threadRootId;
  return typeof root === 'string' && row.rootPostIds === undefined && !loaded.has(root);
}

/** A row whose chip names a root card that is not loaded: it needs that root's count. */
export function chipCountRoot(row: RootFields, loaded: ReadonlySet<string>): string | null {
  const root = row.threadRootId;
  if (typeof root !== 'string' || loaded.has(root)) return null;
  return row.rootPostIds?.[0] !== undefined ? root : null;
}

/**
 * The roots one counts read carries for a page: the not-loaded card roots of
 * its rows not asked for yet. Empty (no read) while a row of the page still
 * waits for its root's hydration (`waiting`: its wait has not run out), so a
 * page makes one read, never one per row.
 */
export function pageCountRoots<T extends RootFields>(
  pageRows: readonly T[],
  loaded: ReadonlySet<string>,
  requested: (rootId: string) => boolean,
  waiting: (row: T) => boolean = (row) => awaitsRootHydration(row, loaded),
): string[] {
  if (pageRows.some(waiting)) return [];
  const roots = new Set<string>();
  for (const row of pageRows) {
    const root = chipCountRoot(row, loaded);
    if (root !== null && !requested(root)) roots.add(root);
  }
  return [...roots].sort();
}

/** Root ids one counts read carries at most (the proc reads the first 200). */
export const THREAD_COUNT_ROOT_LIMIT = 200;

/** How long a page waits for its counts read before its chips paint without a count. */
export const THREAD_COUNTS_WAIT_MS = 4_000;

/** One thread's counts store: what was read per root, and the one read per page. */
export interface ThreadCounts {
  get: (rootId: string) => CountEntry | undefined;
  /** The root's count is in, or its read ended without one. */
  settled: (rootId: string) => boolean;
  /** A read for the root was started (it is never read twice). */
  requested: (rootId: string) => boolean;
  /**
   * Read the roots in one call. `baseOf` is each root's local count when the
   * answer lands. Null when there is nothing new to read.
   */
  request: (rootIds: readonly string[], baseOf: (rootId: string) => number) => Promise<void> | null;
}

/**
 * The counts store. A read that fails or outlives `timeoutMs` settles its
 * roots as 'none' for good (their chips paint without a count and never gain
 * one later); a late answer is dropped.
 */
export function createThreadCounts(
  load: (rootIds: string[]) => Promise<Result<Map<string, ThreadReplyCount>>>,
  timeoutMs: number = THREAD_COUNTS_WAIT_MS,
): ThreadCounts {
  const entries = new Map<string, CountEntry>();
  const requested = new Set<string>();
  return {
    get: (rootId) => entries.get(rootId),
    settled: (rootId) => entries.has(rootId),
    requested: (rootId) => requested.has(rootId),
    request: (rootIds, baseOf) => {
      // Over the proc's 200: the rest wait for the next read, never counted as 0.
      const fresh = [...new Set(rootIds)]
        .filter((id) => !requested.has(id))
        .slice(0, THREAD_COUNT_ROOT_LIMIT);
      if (fresh.length === 0) return null;
      for (const id of fresh) requested.add(id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const window = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const read = load(fresh).then(
        (result) => (result.ok ? result.data : 'failed'),
        (): 'failed' => 'failed',
      );
      return Promise.race([read, window]).then((outcome) => {
        if (timer !== undefined) clearTimeout(timer);
        for (const id of fresh) {
          entries.set(
            id,
            outcome === 'timeout' || outcome === 'failed'
              ? 'none'
              : { count: outcome.get(id)?.count ?? 0, base: baseOf(id) },
          );
        }
      });
    },
  };
}

/** How far a row's content shifts right for the rail. */
export type RowShift = 0 | 14 | 29;

/** What a row draws its tick or elbow into. */
export type RailTarget = 'photo' | 'bubble';

/** One row's rail geometry. */
export interface RowGeometry {
  /** Left padding class of the row (16px plus the shift). */
  padLeft: string;
  shift: RowShift;
  target: RailTarget;
  /** Width class from the rail (x=15) to the target's left edge; empty off the rail. */
  reach: string;
}

/** The 16px row padding plus the rail shift. */
const PAD_LEFT: Record<RowShift, string> = { 0: 'pl-4', 14: 'pl-[30px]', 29: 'pl-[45px]' };

/** From the rail (x=15) to an incoming target at x = 16 + shift, or 40px further past a photo column. */
const REACH: Record<RowShift, { first: string; pastPhoto: string }> = {
  0: { first: '', pastPhoto: '' },
  14: { first: 'w-[15px]', pastPhoto: 'w-[55px]' },
  29: { first: 'w-[30px]', pastPhoto: 'w-[70px]' },
};

/** From the rail to a right-aligned bubble: the row's content width less the bubble's. */
export const OWN_REACH = 'w-[calc(100cqw-100%+1px)]';

/**
 * A row's rail geometry. Selection mode, outgoing rows and rows off the rail
 * keep today's place. A member row and a left root card (from its first
 * paint, so its first reply never moves it) shift their content 14px right, a
 * thread view's root 29px. On a group row that shows
 * the sender photo, a member's tick runs into the photo; on a tucked row (the
 * gutter, no photo) and on a root card it runs to the bubble, past the gutter.
 */
export function rowGeometry(input: {
  role: RailRole | null;
  mine: boolean;
  isGroup: boolean;
  /** The row shows the sender photo (a group's run head). */
  photo: boolean;
  selecting: boolean;
  /** The thread view's root card row. */
  viewRoot?: boolean;
  /** A card that heads a thread: shifted from its first paint, rail or not. */
  rootCard?: boolean;
}): RowGeometry {
  const onRail = input.role !== null && !input.selecting;
  const shifted = !input.selecting && (onRail || input.rootCard === true);
  const shift: RowShift = !shifted || input.mine ? 0 : input.viewRoot === true ? 29 : 14;
  const target: RailTarget =
    input.isGroup && !input.mine && input.photo && input.role !== 'root' ? 'photo' : 'bubble';
  const pastPhoto = input.isGroup && !input.mine && target === 'bubble';
  return {
    padLeft: PAD_LEFT[shift],
    shift,
    target,
    reach: !onRail
      ? ''
      : input.mine
        ? OWN_REACH
        : pastPhoto
          ? REACH[shift].pastPhoto
          : REACH[shift].first,
  };
}
