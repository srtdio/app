// Live message verification. Agora is delivery only and anyone holding a token
// could publish a message carrying a made-up sorted_message_id, so nothing that
// arrives live renders on its own say-so: the receiver looks the id up in
// chat_messages (RLS applies) and renders the ROW. An id with no readable row
// is discarded. The thread (open channel) and the store (badges, toasts) both
// receive the same Agora message, so one verifier per Supabase client is
// shared between them: the lookup runs once per id and the "absent" warning is
// logged once, by the verifier, never by both callers.

import type { Client } from '@srtdio/rpc';
import { logger } from '@/lib/logger';
import { loadMessageById, type MessageLookup } from '@/lib/chat/history';

/** How many settled lookups are remembered (FIFO) for dedupe. */
export const VERIFIED_IDS_LIMIT = 500;

export interface LiveVerifier {
  /** Resolve a live message id to its row, or { found: false } (discard it). */
  verify: (messageId: string) => Promise<MessageLookup>;
}

export interface LiveVerifierDeps {
  lookup: (messageId: string) => Promise<MessageLookup | { error: string }>;
  warn: (message: string, context: Record<string, unknown>) => void;
}

/** Build a verifier over an injected lookup (unit-tested with a fake). */
export function createLiveVerifier(deps: LiveVerifierDeps): LiveVerifier {
  const results = new Map<string, Promise<MessageLookup>>();
  const verify = (messageId: string): Promise<MessageLookup> => {
    const known = results.get(messageId);
    if (known !== undefined) return known;
    const pending = deps.lookup(messageId).then((outcome): MessageLookup => {
      if ('error' in outcome) {
        deps.warn('chat: live message verification failed, discarded', {
          message_id: messageId,
          error: outcome.error,
        });
        // Not cached: a later arrival (or the next catch-up) may succeed.
        results.delete(messageId);
        return { found: false };
      }
      if (!outcome.found) {
        deps.warn('chat: live message has no record row, discarded', { message_id: messageId });
      }
      return outcome;
    });
    results.set(messageId, pending);
    if (results.size > VERIFIED_IDS_LIMIT) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    return pending;
  };
  return { verify };
}

const verifiers = new WeakMap<Client, LiveVerifier>();

/** The verifier shared by every caller on this Supabase client. */
export function liveVerifierFor(client: Client): LiveVerifier {
  const existing = verifiers.get(client);
  if (existing !== undefined) return existing;
  const verifier = createLiveVerifier({
    lookup: async (messageId) => {
      const result = await loadMessageById(client, messageId);
      return result.ok ? result.data : { error: result.error.message };
    },
    warn: (message, context) => logger.warn(message, context),
  });
  verifiers.set(client, verifier);
  return verifier;
}
