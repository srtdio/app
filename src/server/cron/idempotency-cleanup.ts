// Scheduled cleanup for expired idempotency keys.
//
// Wired to a Cloudflare Cron Trigger (daily 03:00 UTC; see
// wrangler.workers.toml). Deletes every row whose expires_at has passed so the
// idempotency_keys table stays bounded. Workers invoke `scheduled`; the
// exported handleScheduled() carries the logic and is unit-testable.

import { v7 as uuidv7 } from 'uuid';
import {
  createSupabaseIdempotencyStore,
  type SupabaseStoreEnv,
} from '@/server/middleware/idempotency';
import { withTraceLogger } from '@/server/trace';

export async function handleScheduled(
  env: SupabaseStoreEnv,
  now: Date = new Date(),
): Promise<number> {
  const traceId = uuidv7();
  const log = withTraceLogger(traceId);
  const { store, dispose } = createSupabaseIdempotencyStore(env);
  try {
    const deleted = await store.cleanup(now);
    log.info('idempotency cleanup complete', { deleted });
    return deleted;
  } finally {
    await dispose();
  }
}

export default {
  async scheduled(_controller: unknown, env: SupabaseStoreEnv): Promise<void> {
    await handleScheduled(env);
  },
};
