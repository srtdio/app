// Activity push: one private Realtime broadcast channel per signed-in user
// (inbox:<user id>). The inbox_entries_push_ins trigger
// (20261028090000_inbox_push_nudge.sql) sends a content-free nudge {w:
// workspace id} on every insert; the store runs its existing inbox tick on a
// nudge for the active workspace. The nudge carries no content and nothing is
// ever rendered from it. The 30 s poll stays as the safety net: while the
// channel is SUBSCRIBED it stretches to 120 s visible and returns to 30 s the
// moment the channel errors, closes or times out.
//
// Pure decisions and the subscription live here; InboxStoreProvider wires them
// to the tick. Reconnect is supabase-js's own; every re-SUBSCRIBED reports so
// the store ticks once to catch anything missed while disconnected.

import { SIGNOUT_EVENT } from '@/lib/events';

/** At most one push-driven tick per this many ms. */
export const PUSH_MIN_GAP_MS = 1_000;

/** The poll's base interval (the safety net, unchanged). */
export const POLL_MS = 30_000;

/** The broadcast event the trigger sends. */
export const INBOX_PUSH_EVENT = 'inbox';

/** The private topic for one user's nudges. */
export function inboxTopic(userId: string): string {
  return `inbox:${userId}`;
}

/**
 * How many POLL_MS intervals make one poll tick: hidden every second (60 s),
 * visible with a live channel every fourth (120 s), visible otherwise every one
 * (30 s). Pure.
 */
export function intervalsPerTick(hidden: boolean, live: boolean): number {
  if (hidden) return 2;
  return live ? 4 : 1;
}

/** The workspace id a nudge names, or null for anything else. Pure. */
export function nudgeWorkspace(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const w = (payload as { w?: unknown }).w;
  return typeof w === 'string' && w.length > 0 ? w : null;
}

/**
 * Whether a nudge ticks the active workspace. A nudge for another workspace is
 * ignored: the store shows nothing for other workspaces today. Pure.
 */
export function nudgeTicks(payload: unknown, activeWorkspaceId: string | null): boolean {
  const w = nudgeWorkspace(payload);
  return w !== null && w === activeWorkspaceId;
}

export interface TickGate {
  nudge: () => void;
  dispose: () => void;
}

export interface TickGateOptions {
  minGapMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Coalesce nudges into ticks: at most one tick per minGapMs, and a nudge while a
 * tick is in flight (or one is already scheduled) queues exactly one follow-up.
 */
export function createTickGate(
  run: () => Promise<void> | void,
  options: TickGateOptions = {},
): TickGate {
  const minGap = options.minGapMs ?? PUSH_MIN_GAP_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let lastStart = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let pending = false;
  let timer: unknown = null;
  let disposed = false;

  const start = (): void => {
    timer = null;
    if (disposed) return;
    lastStart = now();
    inFlight = true;
    pending = false;
    void Promise.resolve()
      .then(run)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (pending) {
          pending = false;
          nudge();
        }
      });
  };

  const nudge = (): void => {
    if (disposed || timer !== null) return;
    if (inFlight) {
      pending = true;
      return;
    }
    const wait = lastStart + minGap - now();
    if (wait <= 0) start();
    else timer = setTimer(start, wait);
  };

  return {
    nudge,
    dispose: () => {
      disposed = true;
      pending = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** The slice of a Realtime channel this module uses. */
export interface PushChannel {
  on(
    type: 'broadcast',
    filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): PushChannel;
  subscribe(callback: (status: string) => void): unknown;
}

/** The slice of the Supabase client this module uses. */
export interface PushClient {
  channel(name: string, opts: { config: { private: boolean } }): PushChannel;
  removeChannel(channel: PushChannel): unknown;
  realtime: { setAuth(token?: string | null): unknown };
  auth: {
    onAuthStateChange(
      callback: (event: string, session: { access_token: string } | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
  };
}

export interface InboxPushHandlers {
  /** A nudge arrived (payload only; never rendered). */
  onNudge: (payload: unknown) => void;
  /** The channel went live (SUBSCRIBED) or not. */
  onLive: (live: boolean) => void;
  /** SUBSCRIBED again; first is true on the first SUBSCRIBED of this subscription. */
  onSubscribed: (first: boolean) => void;
}

/**
 * Subscribe one user's private inbox channel. setAuth runs with the current
 * token before subscribing and again on every TOKEN_REFRESHED. Stops on
 * sorted:signout, on SIGNED_OUT and on the returned stop (user switch, unmount).
 */
export function subscribeInboxPush(
  client: PushClient,
  userId: string,
  accessToken: string,
  handlers: InboxPushHandlers,
  target: EventTarget = window,
): () => void {
  let stopped = false;
  let everSubscribed = false;
  let channel: PushChannel | null = null;

  let authSub: { unsubscribe: () => void } | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    authSub?.unsubscribe();
    authSub = null;
    target.removeEventListener(SIGNOUT_EVENT, stop);
    if (channel !== null) void client.removeChannel(channel);
    channel = null;
    handlers.onLive(false);
  };
  target.addEventListener(SIGNOUT_EVENT, stop);
  authSub = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      stop();
      return;
    }
    if (event === 'TOKEN_REFRESHED' && session !== null && !stopped) {
      void client.realtime.setAuth(session.access_token);
    }
  }).data.subscription;

  void Promise.resolve(client.realtime.setAuth(accessToken)).then(() => {
    if (stopped) return;
    channel = client
      .channel(inboxTopic(userId), { config: { private: true } })
      .on('broadcast', { event: INBOX_PUSH_EVENT }, (message) => {
        if (!stopped) handlers.onNudge(message.payload);
      });
    channel.subscribe((status) => {
      if (stopped) return;
      if (status === 'SUBSCRIBED') {
        handlers.onLive(true);
        handlers.onSubscribed(!everSubscribed);
        everSubscribed = true;
      } else {
        // CHANNEL_ERROR, TIMED_OUT, CLOSED: back to the 30 s poll.
        handlers.onLive(false);
      }
    });
  });

  return stop;
}
