// trace_id sourcing for the posts write path. A trace_id is always an explicit
// RPC parameter (never inferred server-side, never SET LOCAL); when a caller
// does not already hold one for the request, we mint a uuid_v7 at entry. v7 is
// time-ordered so it sorts by creation, which keeps audit_log correlation cheap.
// This mirrors src/lib/trace.ts; the package keeps its own copy so it carries no
// dependency on the frontend application module.

import { v7 as uuidv7 } from 'uuid';

/** Return the supplied trace_id, or mint a fresh uuid_v7 when none was given. */
export function resolveTraceId(traceId?: string): string {
  return traceId ?? uuidv7();
}
