// Worker-safe traced fetch.
//
// Cloudflare Workers must not evaluate the browser env validator at startup.
// src/lib/env.ts runs `safeParse(import.meta.env)` at module scope; in a Worker
// import.meta.env is undefined, so the module throws and `wrangler deploy` fails
// validation with error 10021. The app's fetchWithTrace (src/lib/fetch.ts) pulls
// in @/lib/logger -> @/lib/sentry -> @/lib/env transitively, so Workers cannot
// use it.
//
// This module is the Worker-side equivalent of fetchWithTrace, narrowed to the
// R2StorageClient TracedFetch contract (header injection only). It imports
// nothing from @/lib/fetch, @/lib/logger, @/lib/sentry, or @/lib/env. The trace
// id stays uuid_v7 and rides the X-Trace-Id header; never SET LOCAL.

import { v7 as uuidv7 } from 'uuid';
import { TRACE_ID_HEADER } from '@/server/trace';
import type { TracedFetch } from '@srtdio/storage';

/**
 * TracedFetch implementation for Workers. R2StorageClient passes the request's
 * trace_id explicitly; we attach it as X-Trace-Id (unless already present) and
 * delegate to the global fetch. A uuid_v7 is minted only if no trace_id is
 * supplied, matching fetchWithTrace's fallback. `globalThis.fetch` is used so
 * this stays the sanctioned Worker fetch wrapper without tripping the
 * no-restricted-globals lint rule that guards bare `fetch`.
 */
export const tracedFetch: TracedFetch = (input, init, traceId) => {
  const headers = new Headers(init?.headers);
  if (!headers.has(TRACE_ID_HEADER)) {
    headers.set(TRACE_ID_HEADER, traceId ?? uuidv7());
  }
  return globalThis.fetch(input, { ...init, headers });
};
