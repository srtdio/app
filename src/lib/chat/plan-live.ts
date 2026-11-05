// Live Plan: while a plan is open, its private broadcast topic 'plan:<id>'
// (20261105170000_plan_live_ping) tells the screen that anyone changed the
// plan, an item, a review or a comment. The message carries ids only; the
// listener re-reads through RLS, so nothing hidden ever travels. A burst of
// messages (a move touches several rows) becomes one call after
// PLAN_LIVE_SETTLE_MS. Nothing here sits on a paint path: the screen paints
// first and the subscription starts after.

import type { PushChannel } from '@/lib/inbox/inbox-push';

/** One call per burst: a move or a save touches several rows at once. */
export const PLAN_LIVE_SETTLE_MS = 300;
/** The broadcast event the plan triggers send. */
export const PLAN_LIVE_EVENT = 'changed';

/** The slice of the Supabase client this module uses. */
export interface PlanLiveClient {
  channel(name: string, opts: { config: { private: boolean } }): PushChannel;
  removeChannel(channel: PushChannel): unknown;
  realtime: { setAuth(token?: string | null): unknown };
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  };
}

/** The plan's private topic. Pure. */
export function planLiveTopic(planId: string): string {
  return `plan:${planId}`;
}

/**
 * Listen for changes to one plan. Returns stop(), which removes the channel
 * and drops a pending call. `onChange` runs at most once per settle window.
 */
export function subscribePlanLive(
  client: PlanLiveClient,
  planId: string,
  onChange: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let channel: PushChannel | null = null;
  const settle = (): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, PLAN_LIVE_SETTLE_MS);
  };
  void client.auth.getSession().then(async ({ data }) => {
    const token = data.session?.access_token;
    if (stopped || token === undefined) return;
    await client.realtime.setAuth(token);
    if (stopped) return;
    channel = client
      .channel(planLiveTopic(planId), { config: { private: true } })
      .on('broadcast', { event: PLAN_LIVE_EVENT }, settle);
    channel.subscribe(() => undefined);
  });
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (channel !== null) void client.removeChannel(channel);
    channel = null;
  };
}
