// The Plan tab's read, shared within this tab session (in memory only,
// src/lib/session-read.ts). A nav press on Plan starts it (prefetchPlanTabData
// in src/lib/plan-tab.ts) and the tab's mount joins the same request. A range
// read inside the freshness window paints at once with no request (coming back
// to the tab, or to a month already seen); past the window it is absent, so
// the tab shows its loading state and reads again. Older data is never
// painted, and nothing is re-read behind a painted range.
//
// The kept reads are dropped the moment anything says they may differ: a plan
// changed (PLAN_CHANGED_EVENT), a post changed (POST_CHANGED_EVENT: stages and
// dates show on the tab), the workspace's rows changed or sign-out (both drop
// every session read), and the tab's own reloads (dropPlanTabReads).

import type { Client, Result } from '@srtdio/rpc';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { withReadTimeout, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { canCreatePlans, visibleRange } from '@/lib/plan-tab';
import { readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import { civilToday } from '@/lib/plan-week';
import type { PrefetchContext } from '@/lib/route-data';
import { invalidateReads, peekRead, readKey, sharedRead } from '@/lib/session-read';
import { safeTimeZone } from '@/lib/time';

/** What one Plan tab read covers (the hook's inputs, minus the switches). */
export interface PlanTabReadArgs {
  workspaceId: string;
  /** The visible days (inclusive); null: every plan, the phone list. */
  range: { start: string; end: string } | null;
  timeZone: string;
  onlyShared: boolean;
}

/** The session key of one Plan tab read. Every input is part of it. Pure. */
export function planTabReadKey(userId: string, args: PlanTabReadArgs): string {
  const what = [
    'plan-tab',
    args.range?.start ?? '',
    args.range?.end ?? '',
    args.timeZone,
    args.onlyShared ? 'shared' : 'all',
  ].join('|');
  return readKey(userId, args.workspaceId, what);
}

// Every key this module started, so a change event drops them all.
const started = new Set<string>();

/** One Plan tab read (bounded at 5s, never throws). */
function loadPlanTab(client: Client, args: PlanTabReadArgs): Promise<Result<PlanTabData>> {
  const { workspaceId, range, timeZone, onlyShared } = args;
  return withReadTimeout(
    (signal) => readPlanTab(client, { workspaceId, range, timeZone, onlyShared }, signal),
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

/** A read of `args` settled inside the window, or undefined. Never reads. */
export function peekPlanTab(
  userId: string | null,
  args: PlanTabReadArgs,
  nowMs: number = Date.now(),
): PlanTabData | undefined {
  if (userId === null) return undefined;
  const kept = peekRead<Result<PlanTabData>>(planTabReadKey(userId, args), nowMs);
  return kept !== undefined && kept.ok ? kept.data : undefined;
}

/** Forget every kept Plan tab read (a plan or post changed; the tab reloads). */
export function dropPlanTabReads(): void {
  for (const key of started) invalidateReads(key);
  started.clear();
}

// The workspace's zone, for a press that starts before the page knows it (the
// shell's prefetch context carries ids only). One row, shared per window.
const ZONE_FRESH_MS = 5 * 60_000;

async function selectZone(client: Client, workspaceId: string): Promise<string | null> {
  try {
    const res = await client
      .from('workspaces')
      .select('timezone')
      .eq('id', workspaceId)
      .maybeSingle();
    if (res.error || res.data === null) return null;
    return (res.data as { timezone: string | null }).timezone;
  } catch {
    return null;
  }
}

function readZone(client: Client, userId: string, workspaceId: string): Promise<string | null> {
  return sharedRead(
    readKey(userId, workspaceId, 'workspace-zone'),
    () => selectZone(client, workspaceId),
    { freshMs: ZONE_FRESH_MS, isOk: (zone) => zone !== null },
  );
}

/**
 * Start the read the tab's first render asks for: the month around today on a
 * laptop (the tab opens on Month at today), every plan on a phone; shared
 * plans only for an approver. The viewer's side comes from the session-shared
 * role read (free when the shell already has it); the zone from the context
 * when it carries one, else one shared row. The key is exactly the one the
 * mount computes, so the mount joins this read; a guess that differs (a zone
 * or side that changed meanwhile) is a key the mount never asks for, so it is
 * never painted. Never throws.
 */
export async function startPlanTabRead(
  client: Client,
  ctx: PrefetchContext & { timeZone?: string },
  laptop: boolean,
  now: Date = new Date(),
): Promise<void> {
  const { resolveViewerSide } = await import('@/lib/chat/viewer-role');
  const [side, zone] = await Promise.all([
    resolveViewerSide(client, ctx.workspaceId, ctx.userId),
    ctx.timeZone !== undefined
      ? Promise.resolve<string | null>(ctx.timeZone)
      : readZone(client, ctx.userId, ctx.workspaceId),
  ]);
  if (side === 'unknown') return;
  const timeZone = safeTimeZone(zone);
  const range = laptop ? visibleRange('month', civilToday(now, timeZone)) : null;
  await readSharedPlanTab(client, ctx.userId, {
    workspaceId: ctx.workspaceId,
    range,
    timeZone,
    onlyShared: !canCreatePlans(side),
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener(PLAN_CHANGED_EVENT, dropPlanTabReads);
  window.addEventListener(POST_CHANGED_EVENT, dropPlanTabReads);
}
