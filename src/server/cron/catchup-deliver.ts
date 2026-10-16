// Catch-up email delivery (G3): trial gate, idempotency key, unsubscribe
// headers, the Resend send, and the ledger + inbox stamp.
//
// Stamp-only-on-success: inbox_entries.email_sent_at is written only after
// Resend accepts the email (2xx with an id). A failed send leaves the entries
// unstamped so the next slot can pick them up, and records a 'failed'
// delivery_attempts row. If stamping fails after Resend accepted, the attempt
// is still recorded as 'sent'; a retry reuses the same Idempotency-Key, so
// Resend returns the original response instead of sending a duplicate.

import { TRACE_ID_HEADER } from '@/server/trace';
import type {
  BuildIdempotencyKey,
  BuildUnsubscribeHeaders,
  CatchupDbClient,
  CatchupEnv,
  CatchupGate,
  CreateDeliverer,
  DeliveryAttemptRow,
  DeliveryResult,
  DeliveryStore,
  ResolveCatchupGate,
} from '@/server/cron/catchup-contracts';

export const CATCHUP_TEMPLATE_KEY = 'catch-up';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const STAMP_CHUNK_SIZE = 500;
const PROVIDER_ERROR_NAME = /^[a-z_]{1,64}$/;

const REQUIRED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'RESEND_API_KEY',
  'APP_BASE_URL',
  'CATCHUP_FROM_ADDRESS',
  'UNSUBSCRIBE_SIGNING_SECRET',
] as const satisfies readonly (keyof CatchupEnv)[];

function isBlank(value: string | undefined): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

export const resolveCatchupGate: ResolveCatchupGate = (env: CatchupEnv): CatchupGate => {
  for (const key of REQUIRED_ENV_KEYS) {
    if (isBlank(env[key])) {
      throw new Error(`catch-up env: ${key} is missing or blank`);
    }
  }
  const mode = env.CATCHUP_MODE;
  if (mode === 'live') {
    return { mode: 'live' };
  }
  if (mode !== 'trial') {
    throw new Error("catch-up env: CATCHUP_MODE must be 'trial' or 'live'");
  }
  const ids = (env.CATCHUP_TRIAL_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) {
    throw new Error(
      'catch-up env: CATCHUP_TRIAL_USER_IDS must list at least one user id in trial mode',
    );
  }
  return { mode: 'trial', userIds: new Set(ids) };
};

export const buildIdempotencyKey: BuildIdempotencyKey = (userId, workspaceId, localIsoDate, slot) =>
  `catchup:${userId}:${workspaceId}:${localIsoDate}:${slot}`;

export const buildUnsubscribeHeaders: BuildUnsubscribeHeaders = (oneClickUrl) => ({
  'List-Unsubscribe': `<${oneClickUrl}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function providerErrorName(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'name' in body) {
      const name = (body as { name: unknown }).name;
      if (typeof name === 'string' && PROVIDER_ERROR_NAME.test(name)) return name;
    }
  } catch {
    return null;
  }
  return null;
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'id' in body) {
      const id = (body as { id: unknown }).id;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch {
    return null;
  }
  return null;
}

export const createDeliverer: CreateDeliverer = (deps) => {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const { env, store, traceId, log } = deps;

  function attempt(
    workspaceId: string,
    userId: string,
    fields: Pick<DeliveryAttemptRow, 'status' | 'provider_message_id' | 'sent_at' | 'error'>,
  ): DeliveryAttemptRow {
    return {
      workspace_id: workspaceId,
      user_id: userId,
      channel: 'email',
      template_key: CATCHUP_TEMPLATE_KEY,
      provider: 'resend',
      ...fields,
    };
  }

  async function fail(userId: string, workspaceId: string, error: string): Promise<DeliveryResult> {
    log.warn('catch-up send failed', { user_id: userId, workspace_id: workspaceId, error });
    try {
      await store.recordAttempt(
        attempt(workspaceId, userId, {
          status: 'failed',
          provider_message_id: null,
          sent_at: null,
          error,
        }),
      );
    } catch (err) {
      log.error('catch-up failed-attempt record failed', {
        user_id: userId,
        workspace_id: workspaceId,
        error: errorMessage(err),
      });
    }
    return { ok: false, error };
  }

  return {
    async deliver(req) {
      const { userId, workspaceId, email, entryIds } = req;

      let response: Response;
      try {
        response = await doFetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': email.idempotencyKey,
            [TRACE_ID_HEADER]: traceId,
          },
          body: JSON.stringify({
            from: email.from,
            to: email.to,
            subject: email.rendered.subject,
            html: email.rendered.html,
            text: email.rendered.text,
            headers: email.headers,
          }),
        });
      } catch {
        return fail(userId, workspaceId, 'resend network error');
      }

      if (!response.ok) {
        const name = await providerErrorName(response);
        const suffix = name === null ? '' : ` ${name}`;
        return fail(userId, workspaceId, `resend ${response.status}${suffix}`);
      }

      const messageId = await readMessageId(response);
      if (messageId === null) {
        return fail(userId, workspaceId, `resend ${response.status} missing id`);
      }

      const sentAt = now().toISOString();
      try {
        await store.stampSent(userId, entryIds, sentAt);
      } catch (err) {
        log.error('catch-up stamp failed after send', {
          user_id: userId,
          workspace_id: workspaceId,
          provider_message_id: messageId,
          error: errorMessage(err),
        });
      }

      try {
        await store.recordAttempt(
          attempt(workspaceId, userId, {
            status: 'sent',
            provider_message_id: messageId,
            sent_at: sentAt,
            error: null,
          }),
        );
      } catch (err) {
        log.error('catch-up sent-attempt record failed', {
          user_id: userId,
          workspace_id: workspaceId,
          provider_message_id: messageId,
          error: errorMessage(err),
        });
      }

      return { ok: true, providerMessageId: messageId };
    },
  };
};

export function createSupabaseDeliveryStore(client: CatchupDbClient): DeliveryStore {
  return {
    async recordAttempt(row) {
      const { error } = await client.from('delivery_attempts').insert(row);
      if (error) throw new Error(`delivery_attempts insert failed: ${error.message}`);
    },
    async stampSent(userId, entryIds, atIso) {
      for (let i = 0; i < entryIds.length; i += STAMP_CHUNK_SIZE) {
        const chunk = entryIds.slice(i, i + STAMP_CHUNK_SIZE);
        const { error } = await client
          .from('inbox_entries')
          .update({ email_sent_at: atIso })
          .eq('user_id', userId)
          .in('id', chunk);
        if (error) throw new Error(`inbox_entries stamp failed: ${error.message}`);
      }
    },
  };
}
