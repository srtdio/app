import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import {
  demoRequestIdempotencyKey,
  demoRequestSubject,
  handleDemoRequestSend,
  slotUtc,
} from './handler.ts';
import { sha256Hex } from './mail.ts';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  RESEND_API_KEY: 'resend-key',
  INVITE_FROM_ADDRESS: 'Sorted <hello@mail.test>',
  BOOK_CALL_TO_ADDRESS: 'team@srtd.test',
};

// Wednesday 14 Oct 2026, 10:00 IST.
const NOW = new Date('2026-10-14T04:30:00Z');

// The rate limiter is module state, so every test uses its own email and IP.
let seq = 0;
function unique(): { email: string; ip: string } {
  seq += 1;
  return { email: `asha${seq}@agency.test`, ip: `203.0.113.${seq}` };
}

function valid(email: string, patch: Record<string, unknown> = {}) {
  return {
    name: 'Asha Rao',
    email,
    mobile: '9876543210',
    day: '2026-10-16',
    slot: '11:00 am',
    website: '',
    ...patch,
  };
}

// A chainable PostgREST stub: filters return the chain; terminals resolve the result.
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'insert', 'update']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = async () => result;
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
  return chain;
}

function setup(opts: { resendStatus?: number; env?: Record<string, string | undefined> } = {}) {
  const env = { ...ENV, ...opts.env };
  const deliveryInserts: unknown[] = [];
  const deliveryUpdates: unknown[] = [];
  const adminFrom = vi.fn(() => {
    const chain = query({ data: { id: 'attempt-1' }, error: null });
    chain.insert = vi.fn((row: unknown) => {
      deliveryInserts.push(row);
      return chain;
    });
    chain.update = vi.fn((row: unknown) => {
      deliveryUpdates.push(row);
      return chain;
    });
    return chain;
  });
  const factory = vi.fn(() => ({ from: adminFrom }));
  const status = opts.resendStatus ?? 200;
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    status === 200
      ? new Response(JSON.stringify({ id: 'resend-msg-1' }), { status })
      : new Response('upstream down', { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    deps: {
      env: (name: string) => env[name],
      createClient: factory as unknown as typeof createClient,
      now: () => NOW,
    },
    fetchMock,
    adminFrom,
    deliveryInserts,
    deliveryUpdates,
  };
}

function request(body: unknown, ip: string | null, headers: Record<string, string> = {}): Request {
  return new Request('https://fn.test/demo-request-send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': 'trace-1',
      ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

type ResendInit = RequestInit & { headers: Record<string, string>; body: string };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('demo-request-send send', () => {
  it('mails only the team inbox, keyed by email, day and slot', async () => {
    const s = setup();
    const { email, ip } = unique();
    const res = await handleDemoRequestSend(request(valid(email.toUpperCase()), ip), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    const init = s.fetchMock.mock.calls[0]?.[1] as ResendInit;
    const sent = JSON.parse(init.body) as {
      to: string;
      from: string;
      subject: string;
      text: string;
    };
    expect(sent.to).toBe('team@srtd.test');
    expect(sent.from).toBe('Sorted <hello@mail.test>');
    expect(sent.subject).toBe('Demo request: Asha Rao · 2026-10-16 11:00 am IST');
    expect(sent.text).toContain(`Email: ${email}`);
    expect(sent.text).toContain('Mobile: +91 9876543210');
    expect(sent.text).toContain('Slot (IST): 2026-10-16 11:00 am IST');
    expect(sent.text).toContain('Slot (UTC): 2026-10-16 05:30 UTC');
    expect(sent.text).toContain('Source: srtd.io/demo');
    expect(init.headers['Idempotency-Key']).toBe(
      await sha256Hex([email, '2026-10-16', '11:00 am']),
    );
  });

  it('a body naming another recipient is ignored', async () => {
    const s = setup();
    const { email, ip } = unique();
    await handleDemoRequestSend(request(valid(email, { to: 'victim@else.test' }), ip), s.deps);
    const init = s.fetchMock.mock.calls[0]?.[1] as ResendInit;
    expect((JSON.parse(init.body) as { to: string }).to).toBe('team@srtd.test');
  });

  it('the idempotency key is stable per (email, day, slot)', async () => {
    const a = { email: 'a@b.test', day: '2026-10-16', slot: '11:00 am' } as const;
    expect(await demoRequestIdempotencyKey(a)).toBe(await demoRequestIdempotencyKey(a));
    expect(await demoRequestIdempotencyKey(a)).not.toBe(
      await demoRequestIdempotencyKey({ ...a, slot: '3:00 pm' }),
    );
  });

  it('records the send in delivery_attempts with no workspace or user', async () => {
    const s = setup();
    const { email, ip } = unique();
    await handleDemoRequestSend(request(valid(email), ip), s.deps);
    expect(s.deliveryInserts).toEqual([
      expect.objectContaining({
        workspace_id: null,
        user_id: null,
        channel: 'email',
        template_key: 'demo_request',
        provider: 'resend',
        status: 'queued',
      }),
    ]);
    expect(s.deliveryUpdates).toEqual([
      expect.objectContaining({ status: 'sent', provider_message_id: 'resend-msg-1' }),
    ]);
  });

  it('a Resend failure is 502 send_failed and marks the attempt failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ resendStatus: 500 });
    const { email, ip } = unique();
    const res = await handleDemoRequestSend(request(valid(email), ip), s.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'send_failed' } });
    expect(s.deliveryUpdates).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('no recipient configured is 502 send_failed and sends nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ env: { BOOK_CALL_TO_ADDRESS: undefined } });
    const { email, ip } = unique();
    const res = await handleDemoRequestSend(request(valid(email), ip), s.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'send_failed' } });
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
});

describe('demo-request-send honeypot', () => {
  it('a filled website field returns ok and sends and records nothing', async () => {
    const s = setup();
    const { email, ip } = unique();
    const res = await handleDemoRequestSend(
      request(valid(email, { website: 'https://spam.test' }), ip),
      s.deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.adminFrom).not.toHaveBeenCalled();
    // Nothing was counted either: three real requests still go through.
    for (let i = 0; i < 3; i += 1) {
      expect((await handleDemoRequestSend(request(valid(email), ip), s.deps)).status).toBe(200);
    }
  });
});

describe('demo-request-send rate limit', () => {
  it('a fourth request from one email within the hour is 429', async () => {
    const s = setup();
    const { email } = unique();
    for (let i = 0; i < 3; i += 1) {
      const res = await handleDemoRequestSend(request(valid(email), unique().ip), s.deps);
      expect(res.status).toBe(200);
    }
    const res = await handleDemoRequestSend(request(valid(email), unique().ip), s.deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: 'too_many_requests' } });
    expect(s.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a fourth request from one IP within the hour is 429, X-Forwarded-For first hop', async () => {
    const s = setup();
    const { ip } = unique();
    const forwarded = { 'X-Forwarded-For': `${ip}, 10.0.0.1` };
    for (let i = 0; i < 3; i += 1) {
      const res = await handleDemoRequestSend(
        request(valid(unique().email), null, forwarded),
        s.deps,
      );
      expect(res.status).toBe(200);
    }
    const blocked = await handleDemoRequestSend(
      request(valid(unique().email), null, forwarded),
      s.deps,
    );
    expect(blocked.status).toBe(429);
    // The same client seen through CF-Connecting-IP is the same key.
    const viaCf = await handleDemoRequestSend(request(valid(unique().email), ip), s.deps);
    expect(viaCf.status).toBe(429);
    expect(s.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('the limit lifts after an hour', async () => {
    const s = setup();
    const { email, ip } = unique();
    for (let i = 0; i < 3; i += 1) await handleDemoRequestSend(request(valid(email), ip), s.deps);
    const later = { ...s.deps, now: () => new Date(NOW.getTime() + 60 * 60 * 1000) };
    expect((await handleDemoRequestSend(request(valid(email), ip), later)).status).toBe(200);
  });
});

describe('demo-request-send validation', () => {
  it.each([
    ['a past day', { day: '2026-10-13' }],
    ['today', { day: '2026-10-14' }],
    ['a day past the 30 day window', { day: '2026-11-16' }],
    ['a weekend day', { day: '2026-10-17' }],
    ['no such day', { day: '2026-02-30' }],
    ['a slot that is not offered', { slot: '10:00 am' }],
    ['a short mobile', { mobile: '98765' }],
    ['a bad email', { email: 'not-an-email' }],
    ['an empty name', { name: '   ' }],
    ['a name over 80 characters', { name: 'a'.repeat(81) }],
  ])('rejects %s with 400 invalid_payload', async (_label, patch) => {
    const s = setup();
    const { email, ip } = unique();
    const res = await handleDemoRequestSend(request(valid(email, patch), ip), s.deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_payload' } });
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.adminFrom).not.toHaveBeenCalled();
  });

  it('accepts the last day of the window', async () => {
    const s = setup();
    const { email, ip } = unique();
    // 13 Nov 2026 is a Friday, 30 days after 14 Oct.
    const res = await handleDemoRequestSend(
      request(valid(email, { day: '2026-11-13' }), ip),
      s.deps,
    );
    expect(res.status).toBe(200);
  });

  it('converts each IST slot to UTC', () => {
    expect(slotUtc('2026-10-16', '12:30 pm')).toBe('2026-10-16 07:00 UTC');
    expect(slotUtc('2026-10-16', '6:00 pm')).toBe('2026-10-16 12:30 UTC');
    expect(demoRequestSubject({ name: 'A', day: '2026-10-16', slot: '3:00 pm' })).toBe(
      'Demo request: A · 2026-10-16 3:00 pm IST',
    );
  });
});
