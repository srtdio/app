// Live message verification. Agora is delivery only and anyone holding a token
// could publish a message carrying a made-up sorted_message_id, so nothing that
// arrives live renders on its own say-so: the receiver looks the id up in
// chat_messages (RLS applies) and renders the ROW. An id with no readable row
// is discarded. The thread (open channel) and the store (badges, toasts) both
// receive the same Agora message, so one verifier per Supabase client is
// shared between them: the lookup runs once per id and the "absent" warning is
// logged once, by the verifier, never by both callers. A lookup that fails
// (an error or its 5s timeout) is tried once more after 5s; if that fails too
// the verifier gives up on it and tells its listeners, and the store re-reads
// the list lines and unread counts, so the message is never silently lost.

import type { Client } from '@srtdio/rpc';
import { logger } from '@/lib/logger';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { loadMessageById, type MessageLookup } from '@/lib/chat/history';

/** How many settled lookups are remembered (FIFO) for dedupe. */
const VERIFIED_IDS_LIMIT = 500;

export interface LiveVerifier {
  /** Resolve a live message id to its row, or { found: false } (discard it). */
  verify: (messageId: string) => Promise<MessageLookup>;
  /**
   * Drop every retry still waiting (unmount, workspace switch): those
   * messages resolve as not verified, with no second read and no give-up.
   */
  cancelRetries?: () => void;
}

interface LiveVerifierDeps {
  lookup: (messageId: string) => Promise<MessageLookup | { error: string }>;
  warn: (message: string, context: Record<string, unknown>) => void;
  /** Retry a failed lookup once after this long (ms); absent: no retry. */
  retryDelayMs?: number;
  /** Both tries failed: the message could not be verified. */
  onGiveUp?: (messageId: string) => void;
  /** Injected in tests. */
  delay?: (ms: number) => Promise<void>;
}

/** Build a verifier over an injected lookup (unit-tested with a fake). */
export function createLiveVerifier(deps: LiveVerifierDeps): LiveVerifier {
  const results = new Map<string, Promise<MessageLookup>>();
  // Retries waiting to run: a cancel clears their timers and settles them.
  const waiting = new Map<ReturnType<typeof setTimeout>, () => void>();
  let generation = 0;
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(timer);
        resolve();
      }, ms);
      waiting.set(timer, resolve);
    });
  const verify = (messageId: string): Promise<MessageLookup> => {
    const known = results.get(messageId);
    if (known !== undefined) return known;
    const retryDelayMs = deps.retryDelayMs;
    const first = deps.lookup(messageId);
    const attempt =
      retryDelayMs === undefined
        ? first
        : first.then(async (outcome) => {
            if (!('error' in outcome)) return outcome;
            const started = generation;
            await (deps.delay ?? wait)(retryDelayMs);
            // Cancelled while waiting: no second read, no give-up.
            if (generation !== started) return outcome;
            const again = await deps.lookup(messageId);
            if ('error' in again) deps.onGiveUp?.(messageId);
            return again;
          });
    const pending = attempt.then((outcome): MessageLookup => {
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
  const cancelRetries = (): void => {
    generation += 1;
    for (const [timer, settle] of waiting) {
      clearTimeout(timer);
      settle();
    }
    waiting.clear();
  };
  return { verify, cancelRetries };
}

const verifiers = new WeakMap<Client, LiveVerifier>();

/** Who hears that a live message could not be verified after its retry. */
const giveUpListeners = new Set<(messageId: string) => void>();

/** Subscribe to verify give-ups (the store re-reads lines and counts); returns the unsubscribe. */
export function onLiveVerifyGiveUp(listener: (messageId: string) => void): () => void {
  giveUpListeners.add(listener);
  return () => {
    giveUpListeners.delete(listener);
  };
}

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
    retryDelayMs: READ_TIMEOUT_MS,
    onGiveUp: (messageId) => {
      for (const listener of [...giveUpListeners]) listener(messageId);
    },
  });
  verifiers.set(client, verifier);
  return verifier;
}
