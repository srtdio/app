import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import { handleResendWebhook } from './handler.ts';

const KEY_BASE64 = Buffer.from('test-signing-key-0123456789abcdef').toString('base64');
const SECRET = `whsec_${KEY_BASE64}`;
const NOW_MS = Date.parse('2026-10-23T12:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);

type Row = Record<string, string | null> & { id: string };

// A tiny in-memory delivery_attempts: the UPDATE chain collects its filters and
// applies them to the rows on .select(), so guards are tested by their effect.
function fakeDb(rows: Row[]) {
  const updates: Record<string, string>[] = [];
  const from = vi.fn<(table: string) => unknown>(() => {
    const filters: ((row: Row) => boolean)[] = [];
    let values: Record<string, string> = {};
    const chain = {
      update(v: Record<string, string>) {
        values = v;
        updates.push(v);
        return chain;
      },
      eq(column: string, value: string) {
        filters.push((row) => row[column] === value);
        return chain;
      },
      neq(column: string, value: string) {
        filters.push((row) => row[column] !== value);
        return chain;
      },
      in(column: string, list: string[]) {
        filters.push((row) => list.includes(String(row[column])));
        return chain;
      },
      async select() {
        const matched = rows.filter((row) => filters.every((f) => f(row)));
        for (const row of matched) Object.assign(row, values);
        return { data: matched.map((row) => ({ id: row.id })), error: null };
      },
    };
    return chain;
  });
  const factory = vi.fn(() => ({ from }));
  return { factory: factory as unknown as typeof createClient, from, updates };
}

function deps(db: ReturnType<typeof fakeDb>, env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    RESEND_WEBHOOK_SECRET: SECRET,
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ...env,
  };
  return { env: (name: string) => values[name], createClient: db.factory, now: () => NOW_MS };
}

function sign(id: string, timestamp: number, body: string, keyBase64 = KEY_BASE64): string {
  return createHmac('sha256', Buffer.from(keyBase64, 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
}

function event(type: string, emailId = 'msg-1', createdAt = '2026-10-23T11:59:00.000Z'): string {
  return JSON.stringify({ type, created_at: createdAt, data: { email_id: emailId } });
}

function webhook(
  body: string,
  opts: { timestamp?: number; signature?: string; signedBody?: string } = {},
): Request {
  const timestamp = opts.timestamp ?? NOW_S;
  const signature = opts.signature ?? `v1,${sign('msg_evt_1', timestamp, opts.signedBody ?? body)}`;
  return new Request('https://fn.test/resend-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': 'msg_evt_1',
      'svix-timestamp': String(timestamp),
      'svix-signature': signature,
    },
    body,
  });
}

function attempt(status: string): Row {
  return {
    id: 'a1',
    provider: 'resend',
    provider_message_id: 'msg-1',
    status,
    delivered_at: null,
    bounced_at: null,
  };
}

describe('resend-webhook signature', () => {
  it('accepts a valid signature and marks the attempt delivered', async () => {
    const rows = [attempt('sent')];
    const db = fakeDb(rows);
    const res = await handleResendWebhook(webhook(event('email.delivered')), deps(db));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; ignored?: boolean }).ignored).toBeUndefined();
    expect(rows[0]).toMatchObject({
      status: 'delivered',
      delivered_at: '2026-10-23T11:59:00.000Z',
    });
  });

  it('accepts when any of several v1 entries matches', async () => {
    const body = event('email.delivered');
    const good = sign('msg_evt_1', NOW_S, body);
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(
      webhook(body, { signature: `v1,${Buffer.from('nope').toString('base64')} v1,${good}` }),
      deps(db),
    );
    expect(res.status).toBe(200);
  });

  it('refuses a tampered body', async () => {
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(
      webhook(event('email.delivered', 'msg-2'), { signedBody: event('email.delivered') }),
      deps(db),
    );
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('refuses a signature made with the wrong secret', async () => {
    const body = event('email.delivered');
    const wrongKey = Buffer.from('some-other-key').toString('base64');
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(
      webhook(body, { signature: `v1,${sign('msg_evt_1', NOW_S, body, wrongKey)}` }),
      deps(db),
    );
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('refuses a stale timestamp, even when correctly signed', async () => {
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(
      webhook(event('email.delivered'), { timestamp: NOW_S - 301 }),
      deps(db),
    );
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('refuses missing signature headers', async () => {
    const db = fakeDb([attempt('sent')]);
    const req = new Request('https://fn.test/resend-webhook', {
      method: 'POST',
      body: event('email.delivered'),
    });
    expect((await handleResendWebhook(req, deps(db))).status).toBe(401);
  });

  it('fails loudly with 500 when the secret is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(
      webhook(event('email.delivered')),
      deps(db, { RESEND_WEBHOOK_SECRET: undefined }),
    );
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('refuses a method other than POST', async () => {
    const db = fakeDb([]);
    const req = new Request('https://fn.test/resend-webhook', { method: 'GET' });
    expect((await handleResendWebhook(req, deps(db))).status).toBe(405);
  });
});

describe('resend-webhook events', () => {
  it('marks a bounce with bounced_at', async () => {
    const rows = [attempt('sent')];
    const res = await handleResendWebhook(webhook(event('email.bounced')), deps(fakeDb(rows)));
    expect(res.status).toBe(200);
    expect(rows[0]).toMatchObject({ status: 'bounced', bounced_at: '2026-10-23T11:59:00.000Z' });
  });

  it('a delivered event after a bounce does not overwrite it', async () => {
    const rows = [{ ...attempt('bounced'), bounced_at: '2026-10-23T11:58:00.000Z' }];
    const db = fakeDb(rows);
    const res = await handleResendWebhook(webhook(event('email.delivered')), deps(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(rows[0]).toMatchObject({ status: 'bounced', delivered_at: null });
  });

  it('a bounce never overwrites a complaint', async () => {
    const rows = [attempt('complained')];
    const res = await handleResendWebhook(webhook(event('email.bounced')), deps(fakeDb(rows)));
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(rows[0]).toMatchObject({ status: 'complained', bounced_at: null });
  });

  it('marks a complaint', async () => {
    const rows = [attempt('delivered')];
    await handleResendWebhook(webhook(event('email.complained')), deps(fakeDb(rows)));
    expect(rows[0]?.status).toBe('complained');
  });

  it('a replayed delivered event changes nothing further', async () => {
    const rows = [attempt('sent')];
    const db = fakeDb(rows);
    await handleResendWebhook(webhook(event('email.delivered')), deps(db));
    const replay = await handleResendWebhook(
      webhook(event('email.delivered', 'msg-1', '2026-10-23T11:59:30.000Z')),
      deps(db),
    );
    expect(await replay.json()).toMatchObject({ ok: true, ignored: true });
    expect(rows[0]?.delivered_at).toBe('2026-10-23T11:59:00.000Z');
  });

  it('only touches resend rows for the event email id, in one update', async () => {
    const other = { ...attempt('sent'), id: 'a2', provider_message_id: 'msg-other' };
    const rows = [attempt('sent'), other];
    const db = fakeDb(rows);
    await handleResendWebhook(webhook(event('email.delivered')), deps(db));
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith('delivery_attempts');
    expect(other.status).toBe('sent');
  });

  it('ignores an unknown event type with 200 and no update', async () => {
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(webhook(event('email.opened')), deps(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('ignores an event that matches no row', async () => {
    const db = fakeDb([attempt('sent')]);
    const res = await handleResendWebhook(webhook(event('email.delivered', 'msg-x')), deps(db));
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
  });
});
