// Live Bank: while the Bank is open (the phone chip, the laptop side panel or
// the table), its private broadcast topic 'bank:<workspace_id>'
// (20261106120000_bank_live_ping) tells it that anyone added, moved, edited,
// commented on or bucketed a bank idea, or changed a bucket. The message
// carries ids only; the Bank re-reads its page through RLS, so nothing hidden
// travels. A burst (a move touches several rows) becomes one call after
// PLAN_LIVE_SETTLE_MS. Agency side only: the policy (bank_live_can_receive)
// refuses a client, and the client never subscribes. Never on a paint path:
// the Bank paints first and the subscription starts after.

import type { PushChannel } from '@/lib/inbox/inbox-push';
import type { PlanLiveClient } from '@/lib/chat/plan-live';

/**
 * One call per burst, the Plan's PLAN_LIVE_SETTLE_MS (bank-live.test.ts keeps
 * them equal). Own values, not imports: specs that mock plan-live still load
 * the Bank.
 */
export const BANK_LIVE_SETTLE_MS = 300;
/** The broadcast event the bank triggers send (the Plan's PLAN_LIVE_EVENT). */
export const BANK_LIVE_EVENT = 'changed';

/** The workspace bank's private topic. Pure. */
export function bankLiveTopic(workspaceId: string): string {
  return `bank:${workspaceId}`;
}

/**
 * Listen for changes to one workspace's bank. Returns stop(), which removes
 * the channel and drops a pending call. `onChange` runs at most once per
 * settle window.
 */
export function subscribeBankLive(
  client: PlanLiveClient,
  workspaceId: string,
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
    }, BANK_LIVE_SETTLE_MS);
  };
  void client.auth.getSession().then(async ({ data }) => {
    const token = data.session?.access_token;
    if (stopped || token === undefined) return;
    await client.realtime.setAuth(token);
    if (stopped) return;
    channel = client
      .channel(bankLiveTopic(workspaceId), { config: { private: true } })
      .on('broadcast', { event: BANK_LIVE_EVENT }, settle);
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
