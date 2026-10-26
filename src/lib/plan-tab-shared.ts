// The Plan tab's read, shared within this tab session (in memory only,
// src/lib/session-read.ts). A nav press on Plan starts it (prefetchPlanTabData
// in src/lib/plan-tab.ts) and the tab's mount joins the same request. The last
// good read of a range is kept for the session: coming back to the tab, or to
// a month already seen, paints it at once and refreshes quietly behind it
// (no request while it is fresh).
//
// The kept reads are marked stale the moment anything says they may differ: a
// plan changed (PLAN_CHANGED_EVENT), a post changed (POST_CHANGED_EVENT: stages
// and dates show on the tab), the workspace's rows changed, and the tab's own
// reloads (invalidatePlanTabReads). Stale still paints; the next read goes to
// the server. Sign-out deletes every session read.
//
// The workspace zone comes with the read (plan_bundle_read returns it), so no
// read of its own: a key never carries a zone. Only a laptop press that starts
// before the page knows the zone guesses it for the month around today (the
// context's zone, else the device's); a guess that lands on another month is
// a key the mount never asks for, so it is never painted.

import type { Client, Result } from '@srtdio/rpc';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { withReadTimeout, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { canCreatePlans, visibleRange } from '@/lib/plan-tab';
import { readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import { civilToday } from '@/lib/plan-week';
import type { PrefetchContext } from '@/lib/prefetch-context';
import { invalidateReads, peekKept, readKey, sharedRead } from '@/lib/session-read';
import { safeTimeZone } from '@/lib/time';

/** What one Plan tab read covers (the hook's inputs, minus the switches). */
export interface PlanTabReadArgs {
  workspaceId: string;
  /** The visible days (inclusive); null: every plan, the phone list. */
  range: { start: string; end: string } | null;
  onlyShared: boolean;
}

/** The session key of one Plan tab read. Every input is part of it. Pure. */
export function planTabReadKey(userId: string, args: PlanTabReadArgs): string {
  const what = [
    'plan-tab',
    args.range?.start ?? '',
    args.range?.end ?? '',
    args.onlyShared ? 'shared' : 'all',
  ].join('|');
  return readKey(userId, args.workspaceId, what);
}

// Every key this module started, so a change event marks them all stale.
const started = new Set<string>();

/** One Plan tab read (bounded at 5s, never throws). */
function loadPlanTab(client: Client, args: PlanTabReadArgs): Promise<Result<PlanTabData>> {
  const { workspaceId, range, onlyShared } = args;
  return withReadTimeout(
    (signal) => readPlanTab(client, { workspaceId, range, onlyShared }, signal),
    READ_TIMEOUT_MS,
  );
}

/**
 * The tab's read for `args`, joined with one already running or settled
 * inside the window. Without a user (no session context) it reads on its own,
 * shared with nobody. A failed read is never kept.
 */
export function readSharedPlanTab(
  client: Client,
  userId: string | null,
  args: PlanTabReadArgs,
): Promise<Result<PlanTabData>> {
  if (userId === null) return loadPlanTab(client, args);
  const key = planTabReadKey(userId, args);
  started.add(key);
  return sharedRead(key, () => loadPlanTab(client, args), { isOk: (result) => result.ok });
}

/** The last good read of `args` this session, at any age, or undefined. Never reads. */
export function peekPlanTab(userId: string | null, args: PlanTabReadArgs): PlanTabData | undefined {
  if (userId === null) return undefined;
  const kept = peekKept<Result<PlanTabData>>(planTabReadKey(userId, args));
  return kept !== undefined && kept.ok ? kept.data : undefined;
}

/** Mark every kept Plan tab read stale (a plan or post changed; the tab reloads). */
export function invalidatePlanTabReads(): void {
  for (const key of started) invalidateReads(key);
}

/**
 * Start the read the tab's first render asks for: the month around today on a
 * laptop (the tab opens on Month at today), every plan on a phone; shared
 * plans only for an approver. The viewer's side comes from the session-shared
 * role read (free when the shell already has it). The key is exactly the one
 * the mount computes, so the mount joins this read. A phone read needs no zone;
 * a laptop's month around today is taken in the context's zone, else the
 * device's (no zone read: the bundle carries the workspace's). Never throws.
 */
export async function startPlanTabRead(
  client: Client,
  ctx: PrefetchContext & { timeZone?: string },
  laptop: boolean,
  now: Date = new Date(),
): Promise<void> {
  const { resolveViewerSide } = await import('@/lib/chat/viewer-role');
  const side = await resolveViewerSide(client, ctx.workspaceId, ctx.userId);
  if (side === 'unknown') return;
  const range = laptop ? visibleRange('month', civilToday(now, safeTimeZone(ctx.timeZone))) : null;
  await readSharedPlanTab(client, ctx.userId, {
    workspaceId: ctx.workspaceId,
    range,
    onlyShared: !canCreatePlans(side),
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener(PLAN_CHANGED_EVENT, invalidatePlanTabReads);
  window.addEventListener(POST_CHANGED_EVENT, invalidatePlanTabReads);
}
