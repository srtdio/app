// Framework-agnostic connection lifecycle. The React hook is a thin adapter over
// this; keeping the logic here lets it be unit-tested under the repo's node test
// job without a DOM, with agora-chat, the network and the timers fully injected.
//
// Contract: runChatConnection starts the connection loop and returns a handle.
// The loop owns its own retry and never gives up: every failure (token fetch,
// open, disconnect) schedules the next attempt with exponential backoff (1s
// doubling to a 30s cap, reset once connected) for as long as the tab is
// visible. While hidden the loop pauses (no timer runs); the wake signal (tab
// visible, browser online) resumes it with an immediate attempt. Status reads
// 'unavailable' only while the token endpoint refuses the caller (401/403) or
// cannot be reached (CORS/network); the loop keeps trying underneath. A kick
// (this account signed in on another device) stops retrying for the session
// with status 'kicked' until the user taps reconnect (handle.retry). Teardown
// (workspace change, unmount, or signout) clears every timer, removes the event
// handler, closes the connection, and drops the listeners, leaving nothing
// dangling. Nothing here throws; every failure is logged with the logger.
//
// Silent resume: the last good token is cached and reused on reopen until it is
// within TOKEN_REUSE_MARGIN_MS of expiry (any open failure or onTokenExpired
// drops it). After a wake or an SDK reconnecting/offline event the status stays
// as is for RECONNECT_GRACE_MS; 'reconnecting' reports only if still not live.

import { mark } from '@/lib/perf-marks';
import type { AgoraChat } from 'agora-chat';
import { logger } from '@/lib/logger';
import {
  CHAT_EVENT_HANDLER_ID,
  type ChatConnection,
  type ChatStatus,
  type ChatTokenResult,
  type CreateConnection,
} from '@/lib/chat/types';

/** First retry delay; each consecutive failure doubles it up to the cap. */
const BACKOFF_BASE_MS = 1_000;
/** Longest wait between two attempts. */
export const BACKOFF_CAP_MS = 30_000;
/**
 * SDK error types meaning another device took over this login (agora-chat
 * 1.3.1 status.d.ts: WEBIM_CONNCTION_USER_LOGIN_ANOTHER_DEVICE = 206,
 * WEBIM_CONNCTION_USER_KICKED_BY_OTHER_DEVICE = 217).
 */
const KICKED_ERROR_TYPES: readonly number[] = [206, 217];

/** How long a gap may last before the status flips to 'reconnecting'. */
export const RECONNECT_GRACE_MS = 1_500;
/** A cached token is reused only while it has more than this left before expiry. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

/** Whether an SDK error/disconnect reason is a multi-login kick. */
function isKickReason(error: { type?: unknown } | undefined): boolean {
  return (
    error !== undefined && typeof error.type === 'number' && KICKED_ERROR_TYPES.includes(error.type)
  );
}

/** The delay before attempt number `failures + 1`: 1s, 2s, 4s, ... capped at 30s. */
export function backoffDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

/** A subscriber to every incoming text message, regardless of the open thread. */
type GlobalMessageHandler = (message: AgoraChat.TextMsgBody) => void;

// Always-on fan-out for incoming text. The foundation handler (added below on
// every connection) feeds this registry so the live store can track unread for
// all conversations without opening a per-thread handler. The set is
// module-level so it survives reconnects; subscribers come and go with their
// own teardown and the foundation handler simply reads whoever is registered.
const globalMessageHandlers = new Set<GlobalMessageHandler>();

/** Subscribe to every incoming text message; returns the unsubscribe. */
export function subscribeGlobalMessages(handler: GlobalMessageHandler): () => void {
  globalMessageHandlers.add(handler);
  return () => {
    globalMessageHandlers.delete(handler);
  };
}

function dispatchGlobalMessage(message: AgoraChat.TextMsgBody): void {
  for (const handler of globalMessageHandlers) {
    handler(message);
  }
}

/** A subscriber to every incoming command message, regardless of the open thread. */
type GlobalCmdHandler = (message: AgoraChat.CmdMsgBody) => void;

// Always-on fan-out for incoming commands (delete, edit, read, ...), mirroring
// the text fan-out above, so the store sees a signal for any channel.
const globalCmdHandlers = new Set<GlobalCmdHandler>();

/** Subscribe to every incoming command message; returns the unsubscribe. */
export function subscribeGlobalCmds(handler: GlobalCmdHandler): () => void {
  globalCmdHandlers.add(handler);
  return () => {
    globalCmdHandlers.delete(handler);
  };
}

function dispatchGlobalCmd(message: AgoraChat.CmdMsgBody): void {
  for (const handler of globalCmdHandlers) {
    handler(message);
  }
}

export interface RunChatConnectionParams {
  /** Mints a fresh token; reused for every open and for renewal. */
  fetchToken: () => Promise<ChatTokenResult>;
  createConnection: CreateConnection;
  setStatus: (status: ChatStatus) => void;
  setClient: (client: ChatConnection | null) => void;
  /** Subscribe to signout; returns the unsubscribe to call in teardown. */
  addSignoutListener: (handler: () => void) => () => void;
  /** Subscribe to wake signals (tab visible, browser online); returns the unsubscribe. */
  addWakeListener?: (handler: () => void) => () => void;
  /** Whether the tab is visible; the backoff pauses while false. Defaults to always visible. */
  isVisible?: () => boolean;
  /** Timer injection for tests; defaults to the platform timers. */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the hook holds: stop everything, or attempt again right now (also after a kick). */
interface ChatConnectionHandle {
  teardown: () => void;
  retry: () => void;
}

/**
 * Begin connecting and return the handle. Status goes 'connecting' immediately,
 * 'connected' once the SDK opens, 'reconnecting' on any later gap,
 * 'unavailable' on signout or while the token endpoint refuses / is
 * unreachable, and 'kicked' when another device takes over the login. Renewal
 * is driven by the SDK's onTokenWillExpire callback; an expired token reopens
 * with a fresh one.
 */
export function runChatConnection(params: RunChatConnectionParams): ChatConnectionHandle {
  const { fetchToken, createConnection, setStatus, setClient, addSignoutListener } = params;
  const setTimer =
    params.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer =
    params.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  const isVisible = params.isVisible ?? ((): boolean => true);

  let connection: ChatConnection | null = null;
  let cancelled = false;
  let opening = false;
  let live = false;
  let everConnected = false;
  let failures = 0;
  let kicked = false;
  let unreachable = false;
  let timer: unknown = null;
  let graceTimer: unknown = null;
  let cachedToken: Extract<ChatTokenResult, { ok: true }> | null = null;

  setStatus('connecting');

  const detach = (conn: ChatConnection): void => {
    conn.removeEventHandler(CHAT_EVENT_HANDLER_ID);
    conn.close();
  };

  const clearPending = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const clearGrace = (): void => {
    if (graceTimer !== null) {
      clearTimer(graceTimer);
      graceTimer = null;
    }
  };

  // Show a gap only if it outlasts the grace period. The first connect and an
  // unreachable token endpoint still report immediately.
  const reportGap = (): void => {
    const status = retryingStatus();
    if (status !== 'reconnecting') {
      clearGrace();
      setStatus(status);
      return;
    }
    clearGrace();
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (cancelled || kicked || live) return;
      setStatus(retryingStatus());
    }, RECONNECT_GRACE_MS);
  };

  const getToken = async (): Promise<ChatTokenResult> => {
    if (
      cachedToken !== null &&
      Date.now() < Date.parse(cachedToken.expires_at) - TOKEN_REUSE_MARGIN_MS
    ) {
      return cachedToken;
    }
    cachedToken = null;
    const result = await fetchToken();
    if (result.ok) cachedToken = result;
    return result;
  };

  const dropConnection = (): void => {
    live = false;
    if (connection !== null) {
      const conn = connection;
      connection = null;
      detach(conn);
    }
    setClient(null);
  };

  const retryingStatus = (): ChatStatus => {
    if (unreachable) return 'unavailable';
    return everConnected ? 'reconnecting' : 'connecting';
  };

  const scheduleRetry = (): void => {
    if (cancelled || kicked || timer !== null) return;
    failures += 1;
    setStatus(retryingStatus());
    // Hidden: pause. The wake signal (tab visible) resumes with an attempt.
    if (!isVisible()) return;
    timer = setTimer(() => {
      timer = null;
      if (!isVisible()) return;
      void attempt();
    }, backoffDelayMs(failures));
  };

  const onConnected = (conn: ChatConnection): void => {
    if (cancelled || kicked || connection !== conn || live) return;
    live = true;
    mark('chat:agora:connected');
    everConnected = true;
    failures = 0;
    unreachable = false;
    clearPending();
    clearGrace();
    setClient(conn);
    setStatus('connected');
  };

  const onKicked = (reason: string): void => {
    if (cancelled || kicked) return;
    kicked = true;
    clearPending();
    clearGrace();
    dropConnection();
    logger.warn('chat: signed in on another device, live delivery stopped', { reason });
    setStatus('kicked');
  };

  const renew = async (conn: ChatConnection): Promise<void> => {
    const next = await fetchToken();
    if (cancelled || connection !== conn) return;
    if (!next.ok) {
      // The SDK will report onTokenExpired, which reopens with backoff.
      logger.warn('chat: token renewal fetch failed', { reason: next.reason });
      return;
    }
    cachedToken = next;
    try {
      await conn.renewToken(next.token);
    } catch (error) {
      logger.error('chat: renewToken failed', { error: String(error) });
    }
  };

  const attempt = async (): Promise<void> => {
    if (cancelled || kicked || opening || live) return;
    opening = true;
    try {
      const result = await getToken();
      if (cancelled || kicked) return;
      mark('chat:agora:token');
      if (!result.ok) {
        unreachable = result.reason === 'auth' || result.reason === 'network';
        logger.warn('chat: token fetch failed', { reason: result.reason, failures: failures + 1 });
        scheduleRetry();
        return;
      }
      unreachable = false;

      dropConnection();
      const conn = createConnection(result.app_key);
      connection = conn;
      const isCurrent = (): boolean => !cancelled && !kicked && connection === conn;
      conn.addEventHandler(CHAT_EVENT_HANDLER_ID, {
        onConnected: () => onConnected(conn),
        onReconnecting: () => {
          if (!isCurrent()) return;
          live = false;
          reportGap();
        },
        onOffline: () => {
          if (!isCurrent()) return;
          live = false;
          reportGap();
        },
        onOnline: () => {
          if (isCurrent() && !live) wake();
        },
        onDisconnected: (error) => {
          if (!isCurrent()) return;
          if (isKickReason(error)) {
            onKicked(error?.message ?? '');
            return;
          }
          live = false;
          logger.warn('chat: disconnected', { message: error?.message ?? '' });
          scheduleRetry();
        },
        onTokenWillExpire: () => {
          void renew(conn);
        },
        onTokenExpired: () => {
          if (!isCurrent()) return;
          logger.warn('chat: token expired, reopening');
          cachedToken = null;
          live = false;
          wake();
        },
        onTextMessage: (message) => dispatchGlobalMessage(message),
        onCmdMessage: (message) => dispatchGlobalCmd(message),
        onError: (error) => {
          if (isCurrent() && isKickReason(error)) {
            onKicked(error.message);
            return;
          }
          logger.warn('chat: sdk error', { type: error.type, message: error.message });
        },
      });

      mark('chat:agora:open');
      try {
        await conn.open({ user: result.agora_username, accessToken: result.token });
      } catch (error) {
        if (cancelled || kicked) return;
        // A rejected (possibly stale) token must not be retried: mint fresh next time.
        cachedToken = null;
        logger.warn('chat: open failed', { error: String(error), failures: failures + 1 });
        if (connection === conn) dropConnection();
        scheduleRetry();
        return;
      }
      if (cancelled) {
        detach(conn);
        return;
      }
      onConnected(conn);
    } finally {
      opening = false;
    }
  };

  // Automatic wake (tab visible, online, token expired): never overrides a kick.
  // The status change waits out the grace period so a fast resume stays silent.
  const wake = (): void => {
    if (cancelled || kicked || live || opening) return;
    clearPending();
    reportGap();
    void attempt();
  };

  // The user's tap: also reconnects after a kick. The status updates at once;
  // the banner gate decides what (if anything) the user sees.
  const retry = (): void => {
    if (cancelled || live || opening) return;
    kicked = false;
    clearPending();
    clearGrace();
    setStatus(retryingStatus());
    void attempt();
  };

  const removeWake = params.addWakeListener !== undefined ? params.addWakeListener(wake) : () => {};

  const teardown = (): void => {
    cancelled = true;
    clearPending();
    clearGrace();
    removeSignout();
    removeWake();
    dropConnection();
  };

  const removeSignout = addSignoutListener(() => {
    teardown();
    setStatus('unavailable');
  });

  void attempt();

  return { teardown, retry };
}
