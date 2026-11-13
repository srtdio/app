// Catch up's queue (9 Nov 2026): ONE card per ITEM (a post, a brief, a plan
// item, a bank idea, a chat's main conversation, a chat thread), never one per
// notification. The queue is the items with unread card-making entries in the
// workspace, newest activity first, the tapped item first when entered from a
// seed. Every unread entry of an item rides on its card (Activity-only kinds
// too), so Mark as read marks them all in one call. Own actions never make a
// card. The queue is fixed when catch up opens: new arrivals wait. Pure.

import {
  PLAN_ITEM_ENTITY,
  isChatRow,
  isSnoozed,
  type ActivityItem,
} from '@/components/pages/activity/data';

/** What a card is about. */
export type CatchUpItemKind = 'post' | 'brief' | 'plan-item' | 'idea' | 'chat-main' | 'chat-thread';

/** One card: an item and every unread entry the person holds for it. */
export interface CatchUpItem {
  /** Stable key: post:<id>, brief:<id>, plan_item:<id>, chat:<channel>, thread:<channel>:<root>. */
  key: string;
  kind: CatchUpItemKind;
  /** The item's id (post, brief, plan item, channel). */
  entityId: string;
  /** chat-thread only: the thread's root message. */
  threadRootId: string | null;
  workspaceId: string;
  /** The newest card-making entry: names the card, carries the woken comment or message. */
  lead: ActivityItem;
  /** The card-making entries, newest first (the lead first). */
  cardEntries: ActivityItem[];
  /** Every entry on this card, newest first: card-making and Activity-only. */
  entries: ActivityItem[];
  /** The newest card-making entry's time (the queue order). */
  latestAt: string;
  /**
   * 'threads': a stand-in card (an unread thread, catch-up/threads.ts, or a
   * chat with unread messages and no inbox entry, catch-up/tab-store.ts). Its
   * entries are stand-ins, never inbox ids: a decision writes the chat's read
   * point only. Absent on every inbox card.
   */
  source?: 'threads';
}

/** The stage changes that make a card (sent for review, approved, rejected, parked). */
const CARD_STAGES: ReadonlySet<string> = new Set(['review', 'approved', 'rejected', 'parked']);

/** Entry kinds that make a card (decision 3); the rest stay Activity-only. */
const CARD_EVENTS: ReadonlySet<string> = new Set([
  'mention',
  'comment',
  'plan_comment',
  'checkpoints_added',
  'plan_review',
  'thread_started',
  'brief_created',
]);

/** Whether an entry is the viewer's own action (own row, or the actor is me). Pure. */
export function isOwnEntry(item: ActivityItem, selfId: string | null): boolean {
  if (item.own === true) return true;
  return selfId !== null && item.actorId !== null && item.actorId === selfId;
}

/**
 * Whether an entry makes a card: mention (comment, plan or chat), comment,
 * plan comment, feedback points, plan review, a stage change to review /
 * approved / rejected / parked, a thread started on your item, a brief created
 * for you. Never an own action. Alerts (bank, plan, task) never do. Pure.
 */
export function makesCard(item: ActivityItem, selfId: string | null = null): boolean {
  if (isOwnEntry(item, selfId)) return false;
  if (item.alert != null) return false;
  if (item.eventType === 'stage_change')
    return item.toStage !== null && CARD_STAGES.has(item.toStage);
  return CARD_EVENTS.has(item.eventType);
}

/** The item an entry belongs to, or null (no item: an invite, a file, a welcome). Pure. */
export function itemOf(
  item: ActivityItem,
): { key: string; kind: CatchUpItemKind; entityId: string; threadRootId: string | null } | null {
  if (item.entityId === null) return null;
  if (isChatRow(item)) {
    const root = item.threadRootId ?? null;
    return root !== null
      ? {
          key: `thread:${item.entityId}:${root}`,
          kind: 'chat-thread',
          entityId: item.entityId,
          threadRootId: root,
        }
      : {
          key: `chat:${item.entityId}`,
          kind: 'chat-main',
          entityId: item.entityId,
          threadRootId: null,
        };
  }
  if (item.entityType === 'post') {
    return {
      key: `post:${item.entityId}`,
      kind: 'post',
      entityId: item.entityId,
      threadRootId: null,
    };
  }
  if (item.entityType === 'brief') {
    return {
      key: `brief:${item.entityId}`,
      kind: 'brief',
      entityId: item.entityId,
      threadRootId: null,
    };
  }
  if (item.entityType === PLAN_ITEM_ENTITY) {
    return {
      key: `plan_item:${item.entityId}`,
      kind: item.scopeKey === 'bank' ? 'idea' : 'plan-item',
      entityId: item.entityId,
      threadRootId: null,
    };
  }
  return null;
}

function ms(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function newestFirst(a: ActivityItem, b: ActivityItem): number {
  const d = ms(b.createdAt) - ms(a.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The fixed queue. `held` is every entry the screen holds; unread, not
 * snoozed entries of the workspace group by item; an item is a card when one
 * of them makes a card. `tapped` (a seed) puts its item first (its entry rides
 * even when read). Newest activity first, distinct by key. Pure.
 */
export function buildCatchUpQueue(input: {
  tapped: ActivityItem | null;
  held: readonly ActivityItem[];
  nowMs: number;
  follow?: readonly ActivityItem[];
  workspaceId?: string | null;
  selfId?: string | null;
  /** Only these card kinds (a tab's catch up, 13 Nov 2026); absent: every kind. */
  kinds?: readonly CatchUpItemKind[];
}): CatchUpItem[] {
  const { tapped, nowMs } = input;
  const selfId = input.selfId ?? null;
  const workspaceId = tapped?.workspaceId ?? input.workspaceId ?? null;
  const seen = new Set<string>();
  const groups = new Map<string, { at: ReturnType<typeof itemOf>; entries: ActivityItem[] }>();
  const add = (item: ActivityItem, force: boolean): void => {
    if (seen.has(item.id)) return;
    if (!force) {
      if (item.readAt !== null || isSnoozed(item, nowMs)) return;
      if (workspaceId !== null && item.workspaceId !== workspaceId) return;
    }
    const at = itemOf(item);
    if (at === null) return;
    seen.add(item.id);
    const group = groups.get(at.key) ?? { at, entries: [] };
    group.entries.push(item);
    groups.set(at.key, group);
  };
  if (tapped !== null) add(tapped, true);
  for (const item of input.follow ?? []) add(item, false);
  for (const item of input.held) add(item, false);
  const tappedKey = tapped !== null ? (itemOf(tapped)?.key ?? null) : null;
  const out: CatchUpItem[] = [];
  for (const [key, group] of groups) {
    const at = group.at;
    if (at === null) continue;
    const entries = [...group.entries].sort(newestFirst);
    const cardEntries = entries.filter((e) => makesCard(e, selfId));
    // A tapped item is a card even when its tapped entry alone would not make one.
    const lead = cardEntries[0] ?? (key === tappedKey ? entries[0] : undefined);
    if (lead === undefined) continue;
    if (input.kinds !== undefined && !input.kinds.includes(at.kind)) continue;
    out.push({
      key,
      kind: at.kind,
      entityId: at.entityId,
      threadRootId: at.threadRootId,
      workspaceId: lead.workspaceId,
      lead,
      cardEntries: cardEntries.length > 0 ? cardEntries : [lead],
      entries,
      latestAt: lead.createdAt,
    });
  }
  out.sort((a, b) => {
    if (a.key === tappedKey) return -1;
    if (b.key === tappedKey) return 1;
    return newestFirst(a.lead, b.lead);
  });
  return out;
}

/** The unread entry ids a card's Mark as read writes (every entry of the item, one call). Pure. */
export function unreadIdsOf(item: CatchUpItem): string[] {
  return item.entries.filter((e) => e.readAt === null).map((e) => e.id);
}

/** Every distinct entry the screen holds, from any number of lists, first copy wins. Pure. */
export function heldEntries(
  ...lists: ReadonlyArray<readonly ActivityItem[] | undefined>
): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
