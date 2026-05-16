import { v7 as uuidv7 } from 'uuid';

/**
 * HTTP header that carries the trace_id across FE -> API -> Worker boundaries.
 */
export const TRACE_ID_HEADER = 'X-Trace-Id';

/**
 * Generate a uuid_v7 trace_id. v7 is time-ordered (sortable), which makes log
 * correlation easier than random v4. Per PRD section 24 / Schema section 1.
 */
export function generateTraceId(): string {
  return uuidv7();
}

// Module-level holder for the active trace_id. React owns the source of truth
// via TraceProvider, but non-React modules (the Supabase fetch wrapper) need a
// way to read the current trace_id synchronously. TraceProvider keeps this in
// sync; getCurrentTraceId() never returns empty because it is seeded on load.
let currentTraceId = generateTraceId();

export function getCurrentTraceId(): string {
  return currentTraceId;
}

export function setCurrentTraceId(traceId: string): void {
  currentTraceId = traceId;
}
