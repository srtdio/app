// Client-generated chat message ids. chat_message_send takes the id from the
// client (uuid_v7, time-ordered) so a retry after a timeout reuses the SAME id
// and the proc's idempotent lookup returns the existing row instead of
// duplicating it. The trace id helper in src/lib/trace.ts wraps the same
// generator for a different purpose; this one exists so a message id is never
// confused with a trace id at a call site.

import { v7 as uuidv7 } from 'uuid';

/** Mint the id for one outbound message, at the moment the user taps Send. */
export function newMessageId(): string {
  return uuidv7();
}
