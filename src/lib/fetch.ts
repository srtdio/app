import { TRACE_ID_HEADER, generateTraceId, getCurrentTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';

/**
 * fetch() wrapper that attaches the X-Trace-Id header on every request.
 *
 * All API calls must go through this wrapper, never native fetch directly.
 * ESLint forbids the global `fetch` outside this file.
 */
export async function fetchWithTrace(
  input: RequestInfo | URL,
  init?: RequestInit,
  traceId?: string,
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

  return fetch(input, { ...init, headers });
}
