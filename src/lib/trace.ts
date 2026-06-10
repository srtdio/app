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
// sync; getCurrentTraceId() never returns empty because it is lazily seeded on
// first access.
//
// Seeding is lazy (not at module scope) because Cloudflare Workers disallow
// random generation in global scope: workers/asset-read imports TRACE_ID_HEADER
// from this module, which evaluates it at Worker startup. Calling
// generateTraceId() at module scope (uuid v7 crypto randomness) made
// `wrangler deploy` fail validation with error 10021.
let currentTraceId: string | null = null;

export function getCurrentTraceId(): string {
  if (currentTraceId === null) {
    currentTraceId = generateTraceId();
  }
  return currentTraceId;
}

export function setCurrentTraceId(traceId: string): void {
  currentTraceId = traceId;
}
