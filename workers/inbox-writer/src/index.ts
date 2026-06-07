// inbox-writer Worker entry. The fan-out is driven by Supabase Realtime: the
// consumer holds a postgres_changes subscription on the six watched tables and
// runs processEvent per change. Because a plain Worker invocation is not a
// durable long-lived context, startConsumer is also callable from a persistent
// runtime (e.g. a Durable Object) and from the integration tests.
//
// The fetch handler is a health/readiness probe only; it performs no writes.

import { buildDeps, type Env } from './env';
import { processEvent } from './process';
import { subscribeRealtime } from './realtime';
import { readerClient } from './env';

/** Start the Realtime consumer. Returns an unsubscribe function. */
export function startConsumer(env: Env): () => void {
  const deps = buildDeps(env);
  const client = readerClient(env);
  return subscribeRealtime(client, async (event) => {
    try {
      await processEvent(event, deps);
    } catch {
      // processEvent already recorded the failure (audit_log + structured log);
      // swallow here so one bad event cannot tear down the subscription.
    }
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'inbox-writer' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('inbox-writer', { status: 200 });
  },
};
