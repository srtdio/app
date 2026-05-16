// Trace ID extraction for Cloudflare Workers. Wired into actual Workers in PR 6+.
//
// The frontend is the source of truth: it generates the uuid_v7 trace_id and
// sends it via the X-Trace-Id header. The server only reads that header, and
// generates a fallback id if it is missing (never generates first).
//
// PR 6 wires extractTraceId() into structured logging; PR 17 wires trace_id
// into audit_log writes.

import { v7 as uuidv7 } from 'uuid';

export const TRACE_ID_HEADER = 'X-Trace-Id';

/**
 * Read the trace_id from an inbound request, or mint one if absent.
 */
export function extractTraceId(request: Request): string {
  return request.headers.get(TRACE_ID_HEADER) ?? uuidv7();
}

/**
 * Logger stub that prefixes every line with the trace_id. PR 6 replaces this
 * with real structured logging.
 */
export function withTraceLogger(traceId: string) {
  return {
    info(message: string, context?: Record<string, unknown>): void {
      console.warn(`[trace ${traceId}] ${message}`, context ?? '');
    },
    error(message: string, context?: Record<string, unknown>): void {
      console.error(`[trace ${traceId}] ${message}`, context ?? '');
    },
  };
}
