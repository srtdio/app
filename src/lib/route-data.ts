// Press prefetch for data: a press on a nav item, card or menu (pointerdown,
// touchstart) starts the destination's first reads, so they run while the
// chunk downloads and the tap lands. Each starter lives in the lib module that
// owns the read and puts it through sharedRead (src/lib/session-read.ts), so
// the page's own mount joins the same request instead of asking again. The
// starter modules load with import() (they are part of the route's own
// chunks), so the shell never grows. A starter never paints anything and a
// failure is logged and swallowed: the page's own read retries.

import { logger } from '@/lib/logger';

/** Who is asking and in which workspace; null before the shell knows. */
export interface PrefetchContext {
  userId: string;
  workspaceId: string;
}

let context: PrefetchContext | null = null;

/** Set by the shell once the session and the active workspace are known. */
export function setPrefetchContext(next: PrefetchContext | null): void {
  context = next;
}

export function getPrefetchContext(): PrefetchContext | null {
  return context;
}

type DataStarter = (ctx: PrefetchContext) => Promise<void>;

/** Route path -> its first reads. */
export const ROUTE_DATA_STARTERS: Readonly<Record<string, DataStarter>> = {
  '/pipeline': (ctx) => import('@/lib/pipeline-posts').then((m) => m.prefetchPipelineData(ctx)),
  '/assets': (ctx) => import('@/lib/assets').then((m) => m.prefetchAssetsData(ctx)),
  '/briefs': (ctx) => import('@/lib/brief-list').then((m) => m.prefetchBriefsData(ctx)),
  '/plan': (ctx) => import('@/lib/plan-tab').then((m) => m.prefetchPlanTabData(ctx)),
  '/notifications': (ctx) =>
    import('@/components/pages/activity/data').then((m) => m.prefetchActivityData(ctx)),
  '/settings': (ctx) =>
    import('@/lib/workspace-members').then((m) => {
      m.ensureWorkspaceMembers(ctx.userId, ctx.workspaceId);
    }),
};

/** Start a route's first reads (every press; sharedRead joins a fresh one). */
export function prefetchRouteData(
  path: string,
  starters: Readonly<Record<string, DataStarter>> = ROUTE_DATA_STARTERS,
): void {
  const ctx = context;
  const start = starters[path];
  if (ctx === null || start === undefined) return;
  try {
    void start(ctx).catch((err: unknown) => {
      logger.warn('route data prefetch failed', { path, error: String(err) });
    });
  } catch (err: unknown) {
    logger.warn('route data prefetch failed', { path, error: String(err) });
  }
}
