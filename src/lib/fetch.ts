import { TRACE_ID_HEADER, generateTraceId, getCurrentTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';

/**
 * Every request through fetchWithTrace that has not answered by now rejects,
 * like a network error, so no screen waits on it forever. A caller's own
 * shorter signal (withReadTimeout's 5 s) still fires first.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface FetchOptions {
  /**
   * This call's ceiling in ms, or null for none (uploads and long Worker calls
   * that carry their own). Omitted: REQUEST_TIMEOUT_MS.
   */
  timeoutMs?: number | null;
}

/**
 * Writes that keep no default ceiling: a timed-out one may still land on the
 * server, and a retry would apply it twice (no client id or server dedupe).
 * Until each gets server idempotency they wait as before. Supabase RPC names.
 */
export const NO_LIMIT_RPCS: ReadonlySet<string> = new Set([
  'brief_create',
  'chat_message_schedule',
  'chat_plan_share',
  'chat_task_save_batch',
  'comment_batch_create',
  'comment_create',
  'plan_concept_add',
  'plan_create',
  'plan_create_with_items',
  'plan_item_comment_create',
  'plan_item_review',
  'post_create',
  'stage_transition',
  'workspace_create',
]);

/** Edge functions that send an email per call: a retry would send it twice. */
export const NO_LIMIT_FUNCTIONS: ReadonlySet<string> = new Set([
  'book-call-send',
  'brand-request-send',
  'demo-request-send',
  'invite-send',
]);

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, 'http://local').pathname;
  } catch {
    return '';
  }
}

/** The default ceiling for a request: none for the writes above, else REQUEST_TIMEOUT_MS. */
export function defaultTimeoutFor(input: RequestInfo | URL): number | null {
  const path = requestPath(input);
  const rpc = /\/rest\/v1\/rpc\/([^/?]+)$/.exec(path)?.[1];
  if (rpc !== undefined && NO_LIMIT_RPCS.has(rpc)) return null;
  const fn = /\/functions\/v1\/([^/?]+)/.exec(path)?.[1];
  if (fn !== undefined && NO_LIMIT_FUNCTIONS.has(fn)) return null;
  return REQUEST_TIMEOUT_MS;
}

/** The reason a request past its ceiling rejects with (what AbortSignal.timeout uses). */
function timeoutReason(ms: number): unknown {
  const message = `request timed out after ${ms} ms`;
  if (typeof DOMException === 'function') return new DOMException(message, 'TimeoutError');
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

/**
 * One signal that aborts on the caller's signal or after `ms`, whichever comes
 * first. A plain timer (not AbortSignal.timeout) so it can be cleared once the
 * response has arrived: a body still streaming is never cut off by it.
 */
function limitSignal(
  caller: AbortSignal | null | undefined,
  ms: number,
): { signal: AbortSignal; clear: () => void } {
  const timer = new AbortController();
  const id = setTimeout(() => timer.abort(timeoutReason(ms)), ms);
  if (caller === null || caller === undefined) {
    return { signal: timer.signal, clear: () => clearTimeout(id) };
  }
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') {
    return { signal: any.call(AbortSignal, [caller, timer.signal]), clear: () => clearTimeout(id) };
  }
  // No AbortSignal.any (older Safari): one controller that listens to both.
  const both = new AbortController();
  const onCaller = (): void => both.abort(caller.reason);
  const onTimer = (): void => both.abort(timer.signal.reason);
  if (caller.aborted) onCaller();
  else caller.addEventListener('abort', onCaller, { once: true });
  timer.signal.addEventListener('abort', onTimer, { once: true });
  return {
    signal: both.signal,
    clear: () => {
      clearTimeout(id);
      caller.removeEventListener('abort', onCaller);
      timer.signal.removeEventListener('abort', onTimer);
    },
  };
}

/**
 * fetch() wrapper that attaches the X-Trace-Id header on every request.
 *
 * All API calls must go through this wrapper, never native fetch directly.
 * ESLint forbids the global `fetch` outside this file.
 *
 * Each request gets defaultTimeoutFor(input) unless `options.timeoutMs` says
 * otherwise. No retries here: retry is the user's Try again or the caller's.
 */
export async function fetchWithTrace(
  input: RequestInfo | URL,
  init?: RequestInit,
  traceId?: string,
  options?: FetchOptions,
): Promise<Response> {
  const trace = traceId ?? getCurrentTraceId() ?? generateTraceId();
  const headers = new Headers(init?.headers);
  if (!headers.has(TRACE_ID_HEADER)) {
    headers.set(TRACE_ID_HEADER, trace);
  }

  const method = init?.method ?? 'GET';
  if (import.meta.env.DEV) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Production correlation uses Sentry breadcrumbs; dev gets a log line.
    logger.debug(`${method} ${url}`, { trace_id: trace });
  }

  const timeoutMs = options?.timeoutMs === undefined ? defaultTimeoutFor(input) : options.timeoutMs;
  if (timeoutMs === null) return fetch(input, { ...init, headers });
  const limit = limitSignal(init?.signal, timeoutMs);
  try {
    return await fetch(input, { ...init, headers, signal: limit.signal });
  } finally {
    limit.clear();
  }
}
