import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import {
  bookCallIdempotencyKey,
  bookCallSubject,
  formatSlot,
  formatSlotUtc,
  handleBookCallSend,
} from './handler.ts';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
  RESEND_API_KEY: 'resend-key',
  INVITE_FROM_ADDRESS: 'Sorted <hello@mail.test>',
  BOOK_CALL_TO_ADDRESS: 'calls@team.test',
};

const NOW = new Date('2026-10-17T10:00:00Z');
const WORKSPACE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SLOT_AT = '2026-10-20T11:00:00+05:30';
const TZ = 'Asia/Kolkata';
const VALID = { workspace_id: WORKSPACE_ID, slot_at: SLOT_AT, tz: TZ };

// A chainable PostgREST stub: filters return the chain; terminals resolve the result.
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'limit', 'insert', 'update']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = async () => result;
  chain.single = async () => result;
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
  return chain;
}

interface Setup {
  user?: { id: string; email: string } | null;
  member?: boolean;
  env?: Record<string, string | undefined>;
  resendStatus?: number;
}

function setup(opts: Setup = {}) {
  const user = opts.user === undefined ? { id: 'caller-1', email: 'priya@brand.test' } : opts.user;
  const env = { ...ENV, ...opts.env };
  const caller = {
    auth: {
      getUser: async () =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'jwt missing' } },
    },
  };
  const memberFilters: unknown[][] = [];
  const userFilters: unknown[][] = [];
  const deliveryInserts: unknown[] = [];
  const deliveryUpdates: unknown[] = [];
  const adminFrom = vi.fn((table: string) => {
    if (table === 'workspace_members') {
      const chain = query({ data: opts.member === false ? null : { id: 'm-1' }, error: null });
      chain.eq = vi.fn((...args: unknown[]) => {
        memberFilters.push(args);
        return chain;
      });
      return chain;
    }
    if (table === 'workspaces') {
      return query({ data: { name: 'Ramy Group', platform: 'instagram' }, error: null });
    }
    if (table === 'users') {
      const chain = query({ data: { display_name: 'Priya' }, error: null });
      chain.eq = vi.fn((...args: unknown[]) => {
        userFilters.push(args);
        return chain;
      });
      return chain;
    }
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
  const admin = { from: adminFrom };
  const factory = vi.fn((_url: string, key: string) => (key === 'service-key' ? admin : caller));
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    opts.resendStatus
      ? new Response('boom', { status: opts.resendStatus })
      : new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    deps: {
      env: (name: string) => env[name],
      createClient: factory as unknown as typeof createClient,
    },
    fetchMock,
    adminFrom,
    memberFilters,
    userFilters,
    factory,
    deliveryInserts,
    deliveryUpdates,
  };
}

function request(body: unknown, auth = true): Request {
  return new Request('https://fn.test/book-call-send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer caller-jwt' } : {}),
      'X-Trace-Id': 'trace-1',
    },
    body: JSON.stringify(body),
  });
}

type ResendInit = RequestInit & { headers: Record<string, string>; body: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('book-call-send auth', () => {
  it('rejects a request with no bearer before any read or send', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ user: null });
    const res = await handleBookCallSend(request(VALID, false), s.deps);
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Trace-Id')).toBe('trace-1');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized' } });
    expect(s.adminFrom).not.toHaveBeenCalled();
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a user id and email in the body: both come from the session', async () => {
    const s = setup();
    await handleBookCallSend(
      request({ ...VALID, user_id: 'someone-else', email: 'evil@x.test' }),
      s.deps,
    );
    expect(s.memberFilters).toContainEqual(['user_id', 'caller-1']);
    expect(s.deliveryInserts).toEqual([expect.objectContaining({ user_id: 'caller-1' })]);
    const sent = JSON.parse((s.fetchMock.mock.calls[0]?.[1] as ResendInit).body) as {
      text: string;
    };
    expect(sent.text).toContain('Email: priya@brand.test');
    expect(sent.text).not.toContain('evil@x.test');
  });

  it('403 not_member when the caller is not an active member', async () => {
    const s = setup({ member: false });
    const res = await handleBookCallSend(request(VALID), s.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'not_member' } });
    expect(s.memberFilters).toContainEqual(['active', true]);
    expect(s.deliveryInserts).toEqual([]);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
});

describe('book-call-send input', () => {
  it.each([
    ['missing workspace', { slot_at: SLOT_AT, tz: TZ }],
    ['bad uuid', { ...VALID, workspace_id: 'nope' }],
    ['slot without offset', { ...VALID, slot_at: '2026-10-20T11:00:00' }],
    ['bad tz', { ...VALID, tz: 'Mars/Olympus' }],
  ])('400 invalid_payload (%s)', async (_label, body) => {
    const s = setup();
    const res = await handleBookCallSend(request(body), s.deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_payload' } });
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it('400 slot_in_past for a slot before now', async () => {
    const s = setup();
    const res = await handleBookCallSend(
      request({ ...VALID, slot_at: '2026-10-16T09:00:00Z' }),
      s.deps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'slot_in_past' } });
    expect(s.adminFrom).not.toHaveBeenCalled();
  });
});

describe('book-call-send email', () => {
  it('sends to BOOK_CALL_TO_ADDRESS with the subject and rows', async () => {
    const s = setup();
    const res = await handleBookCallSend(request(VALID), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sent = JSON.parse((s.fetchMock.mock.calls[0]?.[1] as ResendInit).body) as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(sent.to).toBe('calls@team.test');
    expect(sent.from).toBe('Sorted <hello@mail.test>');
    expect(sent.subject).toBe('Call request: Ramy Group · Tue 20 Oct, 11:00');
    expect(sent.text).toContain('Name: Priya');
    expect(sent.text).toContain('Workspace: Ramy Group · instagram');
    expect(sent.text).toContain('Slot (tz): Tue 20 Oct, 11:00 (Asia/Kolkata)');
    expect(sent.text).toContain('Slot (UTC): 2026-10-20 05:30 UTC');
  });

  it('formats the slot in the given zone', () => {
    const slot = new Date('2026-10-20T05:30:00Z');
    expect(formatSlot(slot, 'Europe/London')).toBe('Tue 20 Oct, 06:30');
    expect(formatSlotUtc(slot)).toBe('2026-10-20 05:30 UTC');
    expect(bookCallSubject('A', slot, 'UTC')).toBe('Call request: A · Tue 20 Oct, 05:30');
  });

  it('keys Resend by (user, workspace, slot instant), deterministically', async () => {
    const s = setup();
    await handleBookCallSend(request(VALID), s.deps);
    await handleBookCallSend(request({ ...VALID, slot_at: '2026-10-20T05:30:00Z' }), s.deps);
    const keys = s.fetchMock.mock.calls.map(
      (call) => (call[1] as ResendInit).headers['Idempotency-Key'],
    );
    const slot = new Date(SLOT_AT);
    expect(keys[0]).toBe(await bookCallIdempotencyKey('caller-1', WORKSPACE_ID, slot));
    expect(keys[1]).toBe(keys[0]);
    expect(await bookCallIdempotencyKey('caller-2', WORKSPACE_ID, slot)).not.toBe(keys[0]);
  });

  it('records the send in delivery_attempts', async () => {
    const s = setup();
    await handleBookCallSend(request(VALID), s.deps);
    expect(s.deliveryInserts).toEqual([
      {
        workspace_id: WORKSPACE_ID,
        user_id: 'caller-1',
        channel: 'email',
        template_key: 'book_call',
        provider: 'resend',
        status: 'queued',
        email_thread_id: null,
      },
    ]);
    expect(s.deliveryUpdates).toEqual([
      expect.objectContaining({ status: 'sent', provider_message_id: 'resend-msg-1', error: null }),
    ]);
  });

  it('502 send_failed on a Resend error, attempt marked failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ resendStatus: 500 });
    const res = await handleBookCallSend(request(VALID), s.deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'send_failed' } });
    expect(s.deliveryUpdates).toEqual([
      expect.objectContaining({ status: 'failed', provider_message_id: null, sent_at: null }),
    ]);
  });

  it('502 send_failed when Resend is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ env: { BOOK_CALL_TO_ADDRESS: undefined } });
    const res = await handleBookCallSend(request(VALID), s.deps);
    expect(res.status).toBe(502);
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.deliveryUpdates).toEqual([
      expect.objectContaining({ status: 'failed', error: 'resend_not_configured' }),
    ]);
  });
});

describe('book-call-send identity comes only from the session', () => {
  it('ignores every identity and recipient field in the body', async () => {
    const s = setup();
    const res = await handleBookCallSend(
      request({
        ...VALID,
        user_id: 'someone-else',
        userId: 'someone-else',
        email: 'evil@x.test',
        name: 'Mallory',
        display_name: 'Mallory',
        to: 'victim@else.test',
      }),
      s.deps,
    );
    expect(res.status).toBe(200);
    expect(s.userFilters).toEqual([['id', 'caller-1']]);
    expect(s.memberFilters).not.toContainEqual(['user_id', 'someone-else']);
    const sent = JSON.parse((s.fetchMock.mock.calls[0]?.[1] as ResendInit).body) as {
      to: string;
      text: string;
      html: string;
    };
    expect(sent.to).toBe('calls@team.test');
    expect(sent.text).toContain('Name: Priya');
    expect(`${sent.text}${sent.html}`).not.toMatch(/Mallory|evil@x\.test|someone-else/);
  });

  it('builds the caller client from the anon key and the request bearer, the admin from the service key', async () => {
    const s = setup();
    await handleBookCallSend(request(VALID), s.deps);
    const calls = s.factory.mock.calls as unknown as Array<
      [string, string, { global?: { headers?: Record<string, string> } }]
    >;
    expect(calls[0]?.[1]).toBe('anon-key');
    expect(calls[0]?.[2].global?.headers).toEqual({ Authorization: 'Bearer caller-jwt' });
    expect(calls[1]?.[1]).toBe('service-key');
    expect(calls[1]?.[2].global).toBeUndefined();
  });

  it('keys the idempotency hash by the session user, not a body user id', async () => {
    const s = setup();
    await handleBookCallSend(request({ ...VALID, user_id: 'someone-else' }), s.deps);
    const key = (s.fetchMock.mock.calls[0]?.[1] as ResendInit).headers['Idempotency-Key'];
    expect(key).toBe(await bookCallIdempotencyKey('caller-1', WORKSPACE_ID, new Date(SLOT_AT)));
  });
});

describe('book-call-send env', () => {
  it('a missing env answers a JSON 500 with CORS headers, not a thrown error', async () => {
    const t = setup({ env: { SUPABASE_URL: undefined } });
    const req = new Request('https://fn.test/book-call-send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer caller-jwt',
        Origin: 'https://app.test',
      },
      body: JSON.stringify(VALID),
    });
    const res = await handleBookCallSend(req, t.deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.test');
    expect(res.headers.get('X-Trace-Id')).toBeTruthy();
  });

  it('needs no APP_BASE_URL: without an Origin the CORS fallback is *', async () => {
    const t = setup();
    const res = await handleBookCallSend(request(VALID), t.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
