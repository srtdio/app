import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  buildIngestParams,
  handle,
  verifyAgoraSignature,
  type ChatIngestClient,
  type ChatWebhookIngestParams,
  type ChatWebhookIngestResult,
  type ChatWebhookMirrorEnv,
} from './chat-webhook-mirror';
import { toAgoraUsername } from './agora-identity';

const SECRET = 'agora-webhook-secret';
const USER = '33333333-3333-7333-8333-333333333333';
const CHANNEL = 'group__11111111-1111-7111-8111-111111111111__general';

const env: ChatWebhookMirrorEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  AGORA_WEBHOOK_SECRET: SECRET,
};

/** Attach the Agora signature: security = md5Hex(callId + secret + timestamp). */
function sign(payload: Record<string, unknown>): Record<string, unknown> {
  const security = createHash('md5')
    .update(`${String(payload.callId)}${SECRET}${String(payload.timestamp)}`, 'utf8')
    .digest('hex');
  return { ...payload, security };
}

function webhookRequest(payload: Record<string, unknown>): Request {
  return new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** A spy client that captures the rpc args and returns the given proc result. */
function spyClient(result: ChatWebhookIngestResult): {
  client: ChatIngestClient;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn(() => Promise.resolve({ data: result, error: null }));
  return { client: { rpc } as unknown as ChatIngestClient, rpc };
}

function lastParams(rpc: ReturnType<typeof vi.fn>): ChatWebhookIngestParams {
  return rpc.mock.calls[0]![1] as ChatWebhookIngestParams;
}

const messageEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  sign({
    callId: 'call-1',
    timestamp: 1_700_000_000_000,
    eventType: 'chat',
    chat_type: 'group',
    group_id: CHANNEL,
    from: toAgoraUsername(USER),
    msg_id: 'msg-1',
    payload: {
      bodies: [{ type: 'txt', msg: 'hello team' }],
      ext: { mentions: [USER], attachment_asset_ids: ['aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'] },
    },
    ...overrides,
  });

describe('verifyAgoraSignature', () => {
  it('accepts a correctly signed payload and rejects a tampered one', () => {
    const payload = sign({ callId: 'c', timestamp: 123 });
    expect(verifyAgoraSignature(payload, SECRET)).toBe(true);
    expect(verifyAgoraSignature({ ...payload, security: 'deadbeef' }, SECRET)).toBe(false);
    expect(verifyAgoraSignature({ callId: 'c', timestamp: 123 }, SECRET)).toBe(false);
  });
});

describe('chat-webhook-mirror handle', () => {
  it('calls the proc with signature_verified true on a valid signature', async () => {
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-1',
      message_stored: true,
      outcome: 'success',
    });
    const res = await handle(webhookRequest(messageEvent()), env, () => client);

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe('chat_webhook_ingest');
    expect(lastParams(rpc).p_signature_verified).toBe(true);
  });

  it('returns 401 and does NOT call the proc when the signature fails', async () => {
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-1',
      message_stored: false,
      outcome: 'success',
    });
    const bad = { ...messageEvent(), security: 'not-the-right-digest' };
    const res = await handle(webhookRequest(bad), env, () => client);

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a message event for a known channel with the reverse-mapped sender', async () => {
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-1',
      message_stored: true,
      outcome: 'success',
    });
    await handle(webhookRequest(messageEvent()), env, () => client);

    const params = lastParams(rpc);
    expect(params.p_source_event_id).toBe('call-1');
    expect(params.p_event_type).toBe('chat');
    expect(params.p_channel_id).toBe(CHANNEL);
    expect(params.p_message_id).toBe('msg-1');
    expect(params.p_agora_event_id).toBe('msg-1');
    expect(params.p_sender_user_id).toBe(USER);
    expect(params.p_body).toBe('hello team');
    expect(params.p_mentions).toEqual([USER]);
    expect(params.p_attachment_asset_ids).toEqual(['aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa']);
    expect(params.p_created_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('still acks 200 and calls the proc when the channel is unknown (skipped)', async () => {
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-2',
      message_stored: false,
      outcome: 'skipped',
    });
    const res = await handle(
      webhookRequest(
        messageEvent({ group_id: 'group__deadbeef-dead-7dead-8dead-deaddeaddead__x' }),
      ),
      env,
      () => client,
    );

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe('skipped');
  });

  it('acks 200 without crashing on a duplicate redelivery', async () => {
    // The proc dedupes via DB unique indexes; the worker just acks each time.
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-1',
      message_stored: false,
      outcome: 'success',
    });
    const first = await handle(webhookRequest(messageEvent()), env, () => client);
    const second = await handle(webhookRequest(messageEvent()), env, () => client);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('passes null message fields for a non-message event', async () => {
    const { client, rpc } = spyClient({
      webhook_event_id: 'we-3',
      message_stored: false,
      outcome: 'success',
    });
    const nonMessage = sign({
      callId: 'call-9',
      timestamp: 1_700_000_000_001,
      eventType: 'user_presence',
    });
    const res = await handle(webhookRequest(nonMessage), env, () => client);

    expect(res.status).toBe(200);
    const params = lastParams(rpc);
    expect(params.p_event_type).toBe('user_presence');
    expect(params.p_message_id).toBeNull();
    expect(params.p_agora_event_id).toBeNull();
    expect(params.p_channel_id).toBeNull();
    expect(params.p_sender_user_id).toBeNull();
    expect(params.p_created_at).toBeNull();
  });

  it('acks 200 but reports a failure outcome (raw event captured, retriable)', async () => {
    const { client } = spyClient({
      webhook_event_id: 'we-4',
      message_stored: false,
      outcome: 'failure',
    });
    const res = await handle(webhookRequest(messageEvent()), env, () => client);
    expect(res.status).toBe(200);
  });

  it('returns 500 when the rpc itself errors (DB unreachable)', async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'connection refused' } }),
    );
    const client = { rpc } as unknown as ChatIngestClient;
    const res = await handle(webhookRequest(messageEvent()), env, () => client);
    expect(res.status).toBe(500);
  });
});

describe('buildIngestParams', () => {
  it('treats msg_id presence as the message marker', () => {
    const params = buildIngestParams({ callId: 'c', msg_id: 'm', payload: {} }, 'trace-1', true);
    expect(params.p_message_id).toBe('m');
    expect(params.p_agora_event_id).toBe('m');
    expect(params.p_trace_id).toBe('trace-1');
  });
});
