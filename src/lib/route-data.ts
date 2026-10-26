// Press prefetch for data: a press on a nav item, card or menu (pointerdown,
// touchstart) starts the destination's first reads, so they run while the
// chunk downloads and the tap lands. Each starter lives in the lib module that
// owns the read and puts it through sharedRead (src/lib/session-read.ts), so
// the page's own mount joins the same request instead of asking again. The
// starter modules load with import() (they are part of the route's own
// chunks), so the shell never grows. A starter never paints anything and a
// failure is logged and swallowed: the page's own read retries. App.tsx
// imports this table (it links every route's read module); the shell's
// presses reach it through prefetch-context.ts.

import {
  getPrefetchContext,
  prefetchRouteData,
  setPrefetchContext,
  setRouteDataStarters,
  type DataStarter,
  type PrefetchContext,
} from '@/lib/prefetch-context';

export { getPrefetchContext, prefetchRouteData, setPrefetchContext, type PrefetchContext };

/** Route path -> its first reads. */
export const ROUTE_DATA_STARTERS: Readonly<Record<string, DataStarter>> = {
  '/pipeline': (ctx) => import('@/lib/pipeline-posts').then((m) => m.prefetchPipelineData(ctx)),
  '/assets': (ctx) => import('@/lib/assets').then((m) => m.prefetchAssetsData(ctx)),
  '/briefs': (ctx) => import('@/lib/brief-list-shared').then((m) => m.prefetchBriefsData(ctx)),
  '/plan': (ctx) => import('@/lib/plan-tab').then((m) => m.prefetchPlanTabData(ctx)),
  '/notifications': (ctx) =>
    import('@/components/pages/activity/data').then((m) => m.prefetchActivityData(ctx)),
  '/settings': (ctx) =>
    import('@/lib/workspace-members').then((m) => {
      m.ensureWorkspaceMembers(ctx.userId, ctx.workspaceId);
    }),
};

setRouteDataStarters(ROUTE_DATA_STARTERS);
