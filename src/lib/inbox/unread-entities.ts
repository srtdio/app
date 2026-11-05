// Unread comment markers: the caller's unread comment and mention entries per
// post and per plan item (inbox_unread_entity_targets), the one source for the
// Pipeline card marker, the Plan row marker and the Plan nav badge. The same
// read names each entity's newest unread comment, so every unread marker opens
// straight onto it (the jump-to-latest rule). Activity
// reads the same inbox rows, so reading a comment in either place clears both.
//
// One read per workspace, shared through session-read (kept for the session,
// saved on the device, so a cold open paints the last counts at once). The
// shell (InboxStoreProvider) drives it with useUnreadEntitiesSync: a read after
// first paint, again on every inbox change and when the tab becomes visible
// (sharedRead's freshness window joins repeats). Readers use the selector hooks,
// which subscribe to this module only (no contexts, no reads of their own).
//
// Opening a post or a plan item calls markEntityReadOnOpen: the entity's count
// drops to zero at once, inbox_mark_entity_read runs in the background, and an
// inbox change lets Activity and its badge re-read. A failed call restores the
// count quietly.

import { useEffect, useSyncExternalStore } from 'react';
import { withTraceHeader, type Client, type Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import {
  invalidateReads,
  onSessionReadsHydrated,
  peekKept,
  primeRead,
  readKey,
  sharedRead,
} from '@/lib/session-read';

/** The entities that carry unread comment markers. */
export type UnreadEntityType = 'post' | 'plan_item';

/** Unread counts keyed by entityKey(type, id); absent means zero. */
export type UnreadEntities = Readonly<Record<string, number>>;

/** Where one entity's newest unread comment is. */
export interface UnreadTarget {
  /** The newest unread comment (or the comment a mention sits in); null when unknown. */
  commentId: string | null;
  /** The plan a plan item belongs to; null for a post. */
  planId: string | null;
  /** When the newest unread entry arrived (ISO); null when unknown. */
  at: string | null;
}

/** Newest unread targets keyed by entityKey(type, id); absent means none. */
export type UnreadTargets = Readonly<Record<string, UnreadTarget>>;

/** The unread map and the newest unread targets, from one read. */
export interface UnreadRead {
  counts: UnreadEntities;
  targets: UnreadTargets;
}

type Functions = Database['public']['Functions'];

const EMPTY: UnreadEntities = Object.freeze({});
const NO_TARGETS: UnreadTargets = Object.freeze({});

/** The map key for one entity. Pure. */
export function entityKey(type: UnreadEntityType, id: string): string {
  return `${type}:${id}`;
}

/** The marker's accessible name: "1 unread comment" / "3 unread comments". Pure. */
export function unreadCommentsLabel(count: number): string {
  return count === 1 ? '1 unread comment' : `${count} unread comments`;
}

/** The session read key of the unread map for one user in one workspace. Pure. */
export function unreadEntitiesKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'inbox-unread-entities');
}

/** The session read key of the newest unread targets (kept beside the counts). Pure. */
export function unreadTargetsKey(countsKey: string): string {
  return `${countsKey}:targets`;
}

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Map the proc's rows to the keyed counts; unknown types and zero rows drop. Pure. */
export function mapUnreadEntities(data: unknown): UnreadEntities {
  if (!Array.isArray(data)) return EMPTY;
  const out: Record<string, number> = {};
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const rec = row as { entity_type?: unknown; entity_id?: unknown; unread?: unknown };
    if (rec.entity_type !== 'post' && rec.entity_type !== 'plan_item') continue;
    if (typeof rec.entity_id !== 'string' || rec.entity_id === '') continue;
    const n = toCount(rec.unread);
    if (n > 0) out[entityKey(rec.entity_type, rec.entity_id)] = n;
  }
  return out;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Map the proc's rows to the newest unread target per entity; rows without unread drop. Pure. */
export function mapUnreadTargets(data: unknown): UnreadTargets {
  if (!Array.isArray(data)) return NO_TARGETS;
  const out: Record<string, UnreadTarget> = {};
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const rec = row as Record<string, unknown>;
    if (rec.entity_type !== 'post' && rec.entity_type !== 'plan_item') continue;
    if (typeof rec.entity_id !== 'string' || rec.entity_id === '') continue;
    if (toCount(rec.unread) === 0) continue;
    out[entityKey(rec.entity_type, rec.entity_id)] = {
      commentId: nonEmpty(rec.latest_comment_id),
      planId: rec.entity_type === 'plan_item' ? nonEmpty(rec.plan_id) : null,
      at: nonEmpty(rec.latest_at),
    };
  }
  return out;
}

/**
 * The newest unread plan item comment across every plan (what the Plan nav
 * badge opens): its plan, item and comment, or null when none is known. Pure.
 */
export function newestPlanUnread(
  counts: UnreadEntities,
  targets: UnreadTargets,
): { planId: string; itemId: string; commentId: string | null } | null {
  let best: { planId: string; itemId: string; commentId: string | null } | null = null;
  let bestAt = '';
  for (const [key, target] of Object.entries(targets)) {
    if (!key.startsWith('plan_item:') || (counts[key] ?? 0) <= 0) continue;
    if (target.planId === null) continue;
    const at = target.at ?? '';
    if (best !== null && at <= bestAt) continue;
    best = {
      planId: target.planId,
      itemId: key.slice('plan_item:'.length),
      commentId: target.commentId,
    };
    bestAt = at;
  }
  return best;
}

/**
 * A link with the comment to land on (?comment=, kept alongside any query the
 * link already has); the link itself when there is none. Pure.
 */
export function withCommentTarget(href: string, commentId: string | null | undefined): string {
  if (commentId === null || commentId === undefined || commentId === '') return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}comment=${encodeURIComponent(commentId)}`;
}

/**
 * Where the Plan tab goes: with unread plan comments, straight to the newest
 * one in the Plan tab (/plan/:id?item=&comment=); otherwise the tab itself. Pure.
 */
export function planTabHref(
  tab: string,
  newest: { planId: string; itemId: string; commentId: string | null } | null,
): string {
  if (newest === null) return tab;
  const item = `/plan/${encodeURIComponent(newest.planId)}?item=${encodeURIComponent(newest.itemId)}`;
  return withCommentTarget(item, newest.commentId);
}

/** The sum of every plan item's unread count (the Plan nav badge). Pure. */
export function planItemsUnreadTotal(map: UnreadEntities): number {
  let total = 0;
  for (const [key, n] of Object.entries(map)) if (key.startsWith('plan_item:')) total += n;
  return total;
}

/** One inbox_unread_entity_targets rpc. The actor is auth.uid() server side. Never throws. */
export async function fetchUnreadEntities(
  client: Client,
  params: { workspaceId: string; traceId: string },
): Promise<Result<UnreadRead>> {
  const args: Functions['inbox_unread_entity_targets']['Args'] = {
    p_trace_id: params.traceId,
    p_workspace_id: params.workspaceId,
  };
  try {
    const res = await withTraceHeader(
      client.rpc('inbox_unread_entity_targets', args),
      args.p_trace_id,
    );
    if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
    return {
      ok: true,
      data: { counts: mapUnreadEntities(res.data), targets: mapUnreadTargets(res.data) },
    };
  } catch (err: unknown) {
    return { ok: false, error: { code: 'unknown', message: String(err) } };
  }
}

/** One inbox_mark_entity_read rpc. Never throws. */
export async function sendMarkEntityRead(
  client: Client,
  params: { workspaceId: string; entityType: UnreadEntityType; entityId: string; traceId: string },
): Promise<Result<null>> {
  const args: Functions['inbox_mark_entity_read']['Args'] = {
    p_workspace_id: params.workspaceId,
    p_entity_type: params.entityType,
    p_entity_id: params.entityId,
    p_trace_id: params.traceId,
  };
  try {
    const res = await withTraceHeader(client.rpc('inbox_mark_entity_read', args), args.p_trace_id);
    if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
    return { ok: true, data: null };
  } catch (err: unknown) {
    return { ok: false, error: { code: 'unknown', message: String(err) } };
  }
}

// ---- The module store: the active tenant and its kept map. ----

interface Active {
  key: string;
  workspaceId: string;
}

let active: Active | null = null;
let pending: Promise<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): UnreadEntities {
  if (active === null) return EMPTY;
  return peekKept<UnreadEntities>(active.key) ?? EMPTY;
}

function targetsSnapshot(): UnreadTargets {
  if (active === null) return NO_TARGETS;
  return peekKept<UnreadTargets>(unreadTargetsKey(active.key)) ?? NO_TARGETS;
}

/** Start (or join) the read for the active tenant; repaint readers when it lands. */
function refresh(): void {
  const current = active;
  if (current === null) return;
  const load = async (): Promise<UnreadEntities> => {
    const res = await fetchUnreadEntities(supabase, {
      workspaceId: current.workspaceId,
      traceId: generateTraceId(),
    });
    if (!res.ok) throw new Error(res.error.message);
    // The targets ride beside the counts under their own key (same read).
    primeRead(unreadTargetsKey(current.key), res.data.targets);
    return res.data.counts;
  };
  const run = sharedRead(current.key, load).then(
    () => {
      if (active?.key === current.key) notify();
    },
    (err: unknown) => {
      logger.warn('unread entities: read failed', { error: String(err) });
    },
  );
  pending = run;
  void run.finally(() => {
    if (pending === run) pending = null;
  });
}

/**
 * The shell's driver (InboxStoreProvider): sets the active tenant, reads after
 * first paint, re-reads on inbox changes and tab return. A workspace switch is
 * a clean cut: the old map is never shown under the new workspace.
 */
export function useUnreadEntitiesSync(userId: string | null, workspaceId: string | null): void {
  useEffect(() => {
    if (userId === null || workspaceId === null) {
      active = null;
      notify();
      return;
    }
    const key = unreadEntitiesKey(userId, workspaceId);
    active = { key, workspaceId };
    notify();
    refresh();
    const onChanged = (): void => {
      invalidateReads(key);
      refresh();
    };
    const onVisible = (): void => {
      if (!document.hidden) refresh();
    };
    const offHydrated = onSessionReadsHydrated(notify);
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offHydrated();
      window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onVisible);
      if (active?.key === key) {
        active = null;
        notify();
      }
    };
  }, [userId, workspaceId]);
}

/** The viewer's unread comment count on one post or plan item (0 when none or unknown). */
export function useEntityUnread(type: UnreadEntityType, id: string): number {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot);
  return map[entityKey(type, id)] ?? 0;
}

/** The total unread comments across plan items (the Plan nav badge). */
export function usePlanItemsUnreadTotal(): number {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot);
  return planItemsUnreadTotal(map);
}

/**
 * The newest unread comment on one post or plan item (null when it has none
 * unread or the comment is unknown): what a tap on its marker lands on.
 */
export function useEntityUnreadComment(type: UnreadEntityType, id: string): string | null {
  const counts = useSyncExternalStore(subscribe, snapshot, snapshot);
  const targets = useSyncExternalStore(subscribe, targetsSnapshot, targetsSnapshot);
  const key = entityKey(type, id);
  if ((counts[key] ?? 0) <= 0) return null;
  return targets[key]?.commentId ?? null;
}

/** The newest unread plan item comment across plans (the Plan nav badge's tap), or null. */
export function useNewestPlanUnread(): ReturnType<typeof newestPlanUnread> {
  const counts = useSyncExternalStore(subscribe, snapshot, snapshot);
  const targets = useSyncExternalStore(subscribe, targetsSnapshot, targetsSnapshot);
  return newestPlanUnread(counts, targets);
}

/** The newest unread comment on a plan item right now (read at tap time, no hook). */
export function peekEntityUnreadComment(type: UnreadEntityType, id: string): string | null {
  const key = entityKey(type, id);
  if ((snapshot()[key] ?? 0) <= 0) return null;
  return targetsSnapshot()[key]?.commentId ?? null;
}

function markNow(type: UnreadEntityType, id: string): void {
  const current = active;
  if (current === null) return;
  const before = peekKept<UnreadEntities>(current.key);
  const k = entityKey(type, id);
  if (before === undefined || (before[k] ?? 0) <= 0) return;
  const next: Record<string, number> = { ...before };
  delete next[k];
  const after: UnreadEntities = next;
  primeRead(current.key, after);
  notify();
  void sendMarkEntityRead(supabase, {
    workspaceId: current.workspaceId,
    entityType: type,
    entityId: id,
    traceId: generateTraceId(),
  }).then((res) => {
    if (res.ok) {
      // Activity and its badge read the same rows: let them re-read.
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
      return;
    }
    logger.warn('unread entities: mark read failed', { error: res.error.message });
    // Restore only if nothing newer replaced the optimistic map.
    if (active?.key === current.key && peekKept<UnreadEntities>(current.key) === after) {
      primeRead(current.key, before);
      notify();
    }
  });
}

/**
 * A post page or plan item screen opened: its unread comments are read. Zeroes
 * the marker at once and marks the rows read in the background; does nothing
 * when the entity has no unread comments. When the map is still loading (a
 * cold deep link), it waits for that read first. A command: returns nothing.
 */
export function markEntityReadOnOpen(type: UnreadEntityType, id: string): void {
  if (active === null || id === '') return;
  if (peekKept<UnreadEntities>(active.key) === undefined && pending !== null) {
    void pending.then(() => markNow(type, id));
    return;
  }
  markNow(type, id);
}

/** Test seam: forget the active tenant and any read in flight. */
export function resetUnreadEntitiesForTest(): void {
  active = null;
  pending = null;
  notify();
}

/** Test seam: make one tenant active with a known map (no read runs). */
export function seedUnreadEntitiesForTest(seed: {
  userId: string;
  workspaceId: string;
  map: UnreadEntities;
}): void {
  const key = unreadEntitiesKey(seed.userId, seed.workspaceId);
  active = { key, workspaceId: seed.workspaceId };
  primeRead(key, seed.map);
  notify();
}
