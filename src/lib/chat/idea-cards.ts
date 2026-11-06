// Idea cards in chat (chat_plan_item_share): a concept, planned or in the
// bank, shared into a message as `shared_plan_item_ids`. The card reads its
// values live from plan_items (never a snapshot on the message): every idea id
// asked in the same tick (one thread page's cards mount in one commit, so
// their effects run together) is read in ONE batch after paint: one
// plan_items select and one plan_item_comments select by the id list in
// parallel, then one plans select for the planned ones' titles. A row RLS
// hides (a team-only idea for a client, a deleted idea) comes back missing:
// the card says the viewer has no access. A plan write anywhere
// (PLAN_CHANGED_EVENT) re-reads the ideas shown. Nothing reads before a
// chat's first paint: cards ask from an effect.

import type { Client, Result } from '@srtdio/rpc';
import { abortable } from '@/lib/chat-reads';
import { planChunks, readCommentCounts } from '@/lib/chat/plans';

/** What one idea card shows. */
export type IdeaCardView =
  | {
      kind: 'idea';
      id: string;
      title: string;
      planId: string | null;
      planTitle: string | null;
      day: string | null;
      archived: boolean;
      showToClient: boolean;
      starred: boolean;
      comments: number;
    }
  | { kind: 'none'; id: string };

/** The eyebrow over an idea card. */
export const IDEA_EYEBROW = 'Idea';
/** The card a viewer without access sees. */
export const IDEA_NO_ACCESS = "You don't have access to this idea.";

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Oct" from a civil date (the plan card's day format). Pure. */
function shortCivil(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  const month = MONTHS[Number(m) - 1];
  if (month === undefined || d === undefined) return isoDate;
  return `${Number(d)} ${month}`;
}

/** Where the idea lives: "Bank", "Bank · archived" or "{plan} · {date}". Pure. */
export function ideaWhere(
  view: Pick<Extract<IdeaCardView, { kind: 'idea' }>, 'planId' | 'planTitle' | 'day' | 'archived'>,
): string {
  if (view.planId === null) return view.archived ? 'Bank · archived' : 'Bank';
  const plan = view.planTitle !== null && view.planTitle.trim() !== '' ? view.planTitle : 'Plan';
  return `${plan} · ${view.day !== null ? shortCivil(view.day) : 'No date'}`;
}

/** The card's line: "{where} · {n} comments". Pure. */
export function ideaLine(view: Extract<IdeaCardView, { kind: 'idea' }>): string {
  const n = view.comments;
  return `${ideaWhere(view)} · ${n} ${n === 1 ? 'comment' : 'comments'}`;
}

/** Where a tap goes: the bank idea route, or the plan item route. Pure. */
export function ideaHref(
  view: Pick<Extract<IdeaCardView, { kind: 'idea' }>, 'id' | 'planId'>,
): string {
  if (view.planId === null) {
    return `/plan/bank?${new URLSearchParams({ item: view.id }).toString()}`;
  }
  return `/plan/${encodeURIComponent(view.planId)}?${new URLSearchParams({ item: view.id }).toString()}`;
}

interface IdeaRow {
  id: string;
  title: string | null;
  plan_id: string | null;
  target_date: string | null;
  archived_at: string | null;
  show_to_client: boolean | null;
  starred_at: string | null;
}

type Query = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  in: (column: string, values: readonly string[]) => Query;
  is: (column: string, value: null) => Query;
  eq: (column: string, value: string) => Query;
};

async function selectByIds<T>(
  client: Client,
  table: 'plan_items' | 'plans',
  columns: string,
  ids: readonly string[],
  signal: AbortSignal | undefined,
  extra: (q: Query) => Query,
): Promise<Result<T[]>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, data: [] };
  const results = await Promise.all(
    planChunks(unique).map((chunk) => {
      const base = (client.from(table) as unknown as { select: (c: string) => Query })
        .select(columns)
        .in('id', chunk);
      return abortable(extra(base), signal) as unknown as Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    }),
  );
  const rows: T[] = [];
  for (const r of results) {
    if (r.error !== null)
      return { ok: false, error: { code: 'unknown', message: r.error.message } };
    rows.push(...((r.data as T[] | null) ?? []));
  }
  return { ok: true, data: rows };
}

/**
 * The idea cards for these ids: plan_items and comment counts in parallel,
 * then the planned ones' plan titles. Missing rows read as no access. Never
 * throws.
 */
export async function readIdeaCards(
  client: Client,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Map<string, IdeaCardView>>> {
  try {
    const [items, comments] = await Promise.all([
      selectByIds<IdeaRow>(
        client,
        'plan_items',
        'id, title, plan_id, target_date, archived_at, show_to_client, starred_at',
        ids,
        signal,
        (q) => q.is('deleted_at', null).eq('kind', 'concept'),
      ),
      readCommentCounts(client, ids, signal),
    ]);
    if (!items.ok) return items;
    if (!comments.ok) return comments;
    const planIds = items.data.flatMap((r) => (r.plan_id !== null ? [r.plan_id] : []));
    const plans = await selectByIds<{ id: string; title: string }>(
      client,
      'plans',
      'id, title',
      planIds,
      signal,
      (q) => q.is('deleted_at', null),
    );
    if (!plans.ok) return plans;
    return { ok: true, data: ideaViews(ids, items.data, comments.data, plans.data) };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

/** The views for the asked ids from the rows read (missing = no access). Pure. */
export function ideaViews(
  ids: readonly string[],
  items: readonly IdeaRow[],
  comments: Readonly<Record<string, number>>,
  plans: ReadonlyArray<{ id: string; title: string }>,
): Map<string, IdeaCardView> {
  const byId = new Map(items.map((r) => [r.id, r] as const));
  const titles = new Map(plans.map((p) => [p.id, p.title] as const));
  const views = new Map<string, IdeaCardView>();
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) {
      views.set(id, { kind: 'none', id });
      continue;
    }
    views.set(id, {
      kind: 'idea',
      id,
      title: row.title ?? '',
      planId: row.plan_id,
      planTitle: row.plan_id !== null ? (titles.get(row.plan_id) ?? null) : null,
      day: row.target_date,
      archived: row.archived_at !== null,
      showToClient: row.show_to_client === true,
      starred: row.starred_at !== null,
      comments: comments[id] ?? 0,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Messages the open bundle carried without their idea ids
// ---------------------------------------------------------------------------

/**
 * Whether a recorded message reads as empty: no body, files, shared posts,
 * briefs, plans or ideas, and not deleted. The chat open bundle (and search)
 * rows do not carry shared_plan_item_ids yet, so an idea message from the
 * bundle arrives like this; its ids are read in the cards' batch. Pure.
 */
export function looksLikeBundleIdea(message: {
  body: string;
  attachments: readonly unknown[];
  sharedPostIds: readonly string[];
  sharedBriefIds: readonly string[];
  sharedPlanIds?: readonly string[] | undefined;
  sharedPlanItemIds?: readonly string[] | undefined;
  deleted?: boolean | undefined;
  state?: string | undefined;
}): boolean {
  return (
    message.deleted !== true &&
    message.state !== 'pending' &&
    message.state !== 'failed' &&
    message.body.trim() === '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0 &&
    (message.sharedPlanIds ?? []).length === 0 &&
    (message.sharedPlanItemIds ?? []).length === 0
  );
}

/** chat_messages by id: each message's shared idea ids (rows without any are skipped). Never throws. */
export async function readMessageIdeaIds(
  client: Client,
  messageIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Map<string, string[]>>> {
  try {
    const unique = [...new Set(messageIds)];
    const out = new Map<string, string[]>();
    if (unique.length === 0) return { ok: true, data: out };
    const results = await Promise.all(
      planChunks(unique).map((chunk) => {
        const q = (
          client.from('chat_messages') as unknown as {
            select: (c: string) => {
              in: (
                column: string,
                values: readonly string[],
              ) => {
                not: (
                  column: string,
                  op: string,
                  value: null,
                ) => PromiseLike<{
                  data: unknown;
                  error: { message: string } | null;
                }>;
              };
            };
          }
        )
          .select('id, shared_plan_item_ids')
          .in('id', chunk)
          .not('shared_plan_item_ids', 'is', null);
        return abortable(q, signal) as unknown as Promise<{
          data: unknown;
          error: { message: string } | null;
        }>;
      }),
    );
    for (const r of results) {
      if (r.error !== null)
        return { ok: false, error: { code: 'unknown', message: r.error.message } };
      for (const row of (r.data as Array<{
        id: string;
        shared_plan_item_ids: string[] | null;
      }> | null) ?? []) {
        if ((row.shared_plan_item_ids ?? []).length > 0)
          out.set(row.id, row.shared_plan_item_ids ?? []);
      }
    }
    return { ok: true, data: out };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

// ---------------------------------------------------------------------------
// The batched store (one read per tick of asks)
// ---------------------------------------------------------------------------

export interface IdeaCardStore {
  /** Ask for these ids; ids not yet held are read in the next batch. */
  request: (ids: readonly string[]) => void;
  /** Ask which ideas these (empty-looking) messages carry, in the next batch. */
  requestMessages: (messageIds: readonly string[]) => void;
  /** A message's idea ids: undefined while unknown, [] when it carries none. */
  messageIdeas: (messageId: string) => readonly string[] | undefined;
  /** Read these ids again (a plan change). */
  refresh: (ids: readonly string[]) => void;
  /** The held view, or undefined while it loads; 'failed' when its read failed. */
  get: (id: string) => IdeaCardView | 'failed' | undefined;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  /** Every id held or asked (for a plan change refresh). */
  held: () => string[];
}

export interface IdeaCardReads {
  ideas: (ids: string[]) => Promise<Result<Map<string, IdeaCardView>>>;
  messages: (messageIds: string[]) => Promise<Result<Map<string, string[]>>>;
}

/**
 * A store whose asks in one tick become one pass: at most one chat_messages
 * read (empty-looking bundle rows), then one idea read for every id asked
 * plus the ones those messages carry. `schedule` defaults to a microtask.
 */
export function createIdeaCardStore(
  reads: IdeaCardReads,
  schedule: (run: () => void) => void = (run) => queueMicrotask(run),
): IdeaCardStore {
  const views = new Map<string, IdeaCardView | 'failed'>();
  const byMessage = new Map<string, readonly string[]>();
  const pending = new Set<string>();
  const pendingMessages = new Set<string>();
  const inFlight = new Set<string>();
  const messagesInFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let v = 0;
  let scheduled = false;
  const emit = (): void => {
    v += 1;
    for (const l of listeners) l();
  };
  const flush = async (): Promise<void> => {
    scheduled = false;
    const messageIds = [...pendingMessages];
    pendingMessages.clear();
    const ids = new Set(pending);
    pending.clear();
    for (const id of messageIds) messagesInFlight.add(id);
    for (const id of ids) inFlight.add(id);
    if (messageIds.length > 0) {
      const found = await reads.messages(messageIds);
      for (const id of messageIds) {
        messagesInFlight.delete(id);
        // A failed read leaves the message as it is (no card, no retry loop).
        const carried = found.ok ? (found.data.get(id) ?? []) : [];
        byMessage.set(id, carried);
        for (const ideaId of carried) {
          if (!views.has(ideaId) && !inFlight.has(ideaId)) {
            ids.add(ideaId);
            inFlight.add(ideaId);
          }
        }
      }
      emit();
    }
    const list = [...ids];
    if (list.length === 0) return;
    const result = await reads.ideas(list);
    for (const id of list) {
      inFlight.delete(id);
      views.set(id, result.ok ? (result.data.get(id) ?? { kind: 'none', id }) : 'failed');
    }
    emit();
  };
  const kick = (): void => {
    if (!scheduled && (pending.size > 0 || pendingMessages.size > 0)) {
      scheduled = true;
      schedule(() => void flush());
    }
  };
  const enqueue = (ids: readonly string[]): void => {
    for (const id of ids) pending.add(id);
    kick();
  };
  return {
    request: (ids) =>
      enqueue(ids.filter((id) => !views.has(id) && !inFlight.has(id) && !pending.has(id))),
    requestMessages: (messageIds) => {
      for (const id of messageIds) {
        if (!byMessage.has(id) && !messagesInFlight.has(id)) pendingMessages.add(id);
      }
      kick();
    },
    messageIdeas: (messageId) => byMessage.get(messageId),
    refresh: (ids) => enqueue(ids.filter((id) => !inFlight.has(id))),
    get: (id) => views.get(id),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => v,
    held: () => [...views.keys()],
  };
}
