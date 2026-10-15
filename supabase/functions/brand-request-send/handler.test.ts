import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import {
  brandRequestEmailBody,
  brandRequestIdempotencyKey,
  brandRequestSubject,
  handleBrandRequestSend,
} from './handler.ts';

const ENV: Record<string, string> = {
  APP_BASE_URL: 'https://app.test/',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
  RESEND_API_KEY: 'resend-key',
  INVITE_FROM_ADDRESS: 'Sorted <hello@mail.test>',
};

const REQUEST_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FORBIDDEN_WORDS = /\b(client|agency|trial)\b/i;
const EM_DASH = String.fromCharCode(0x2014);

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
  user?: { id: string } | null;
  rpcError?: string | null;
  sendCount?: number;
  brandName?: string | null;
}

function setup(opts: Setup = {}) {
  const user = opts.user === undefined ? { id: 'requester-1' } : opts.user;
  let sendCount = opts.sendCount ?? 0;
  const rpc = vi.fn(async () => {
    if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
    sendCount += 1;
    return { data: REQUEST_ID, error: null };
  });
  const callerFrom = vi.fn((table: string) =>
    table === 'users'
      ? query({ data: { display_name: 'Priya' }, error: null })
      : query({
          data: {
            agency_email: 'maker@studio.test',
            brand_name: opts.brandName === undefined ? 'Ramy Group' : opts.brandName,
            send_count: sendCount,
          },
          error: null,
        }),
  );
  const caller = {
    auth: {
      getUser: async () =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'jwt missing' } },
    },
    from: callerFrom,
    rpc,
  };
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
  const admin = { from: adminFrom };
  const factory = vi.fn((_url: string, key: string) => (key === 'service-key' ? admin : caller));
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    deps: {
      env: (name: string) => ENV[name],
      createClient: factory as unknown as typeof createClient,
    },
    rpc,
    fetchMock,
    adminFrom,
    deliveryInserts,
    deliveryUpdates,
  };
}

function request(body: unknown, auth = true): Request {
  return new Request('https://fn.test/brand-request-send', {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('brand-request-send auth', () => {
  it('rejects an unauthenticated request before any write or send', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ user: null });
    const res = await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }, false),
      s.deps,
    );
    expect(res.status).toBe(401);
    expect(s.rpc).not.toHaveBeenCalled();
    expect(s.adminFrom).not.toHaveBeenCalled();
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a user id in the body: the proc runs on the caller session', async () => {
    const s = setup();
    await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group', user_id: 'someone-else' }),
      s.deps,
    );
    expect(s.rpc).toHaveBeenCalledWith('brand_agency_request', {
      p_agency_email: 'maker@studio.test',
      p_brand_name: 'Ramy Group',
      p_trace_id: 'trace-1',
    });
  });
});

describe('brand-request-send idempotency', () => {
  it('sends one email per call, keyed by request id and send_count', async () => {
    const s = setup();
    const first = await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }),
      s.deps,
    );
    expect(first.status).toBe(200);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    const firstInit = s.fetchMock.mock.calls[0]?.[1] as ResendInit;
    expect(firstInit.headers['Idempotency-Key']).toBe(brandRequestIdempotencyKey(REQUEST_ID, 1));

    await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }),
      s.deps,
    );
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = s.fetchMock.mock.calls[1]?.[1] as ResendInit;
    expect(secondInit.headers['Idempotency-Key']).toBe(brandRequestIdempotencyKey(REQUEST_ID, 2));
  });

  it('a retried call for the same send_count reuses the same key', () => {
    expect(brandRequestIdempotencyKey(REQUEST_ID, 3)).toBe(
      brandRequestIdempotencyKey(REQUEST_ID, 3),
    );
    expect(brandRequestIdempotencyKey(REQUEST_ID, 3)).not.toBe(
      brandRequestIdempotencyKey(REQUEST_ID, 4),
    );
  });

  it('a refused request (too_many_requests) sends nothing and records nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ rpcError: 'too_many_requests' });
    const res = await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }),
      s.deps,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too_many_requests' });
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.adminFrom).not.toHaveBeenCalled();
  });

  it('records the send in delivery_attempts with no email thread', async () => {
    const s = setup();
    await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }),
      s.deps,
    );
    expect(s.deliveryInserts).toEqual([
      expect.objectContaining({
        channel: 'email',
        provider: 'resend',
        status: 'queued',
        email_thread_id: null,
      }),
    ]);
    expect(s.deliveryUpdates).toEqual([
      expect.objectContaining({ status: 'sent', provider_message_id: 'resend-msg-1' }),
    ]);
  });
});

describe('brand-request-send email copy', () => {
  it('names the requester and brand and links to sign-up for the recipient', async () => {
    const s = setup();
    await handleBrandRequestSend(
      request({ email: 'maker@studio.test', brand_name: 'Ramy Group' }),
      s.deps,
    );
    const init = s.fetchMock.mock.calls[0]?.[1] as ResendInit;
    const sent = JSON.parse(init.body) as { to: string; subject: string; text: string };
    expect(sent.to).toBe('maker@studio.test');
    expect(sent.subject).toBe('Priya from Ramy Group wants you to make their posts on Sorted');
    expect(sent.text).toContain('https://app.test/signup?email=maker%40studio.test');
  });

  it.each([
    ['Ramy Group', 'Ramy Group'],
    ['no brand', null],
  ])('contains no client, agency or trial wording (%s)', (_label, brandName) => {
    const subject = brandRequestSubject('Priya', brandName);
    const body = brandRequestEmailBody({
      requesterName: 'Priya',
      brandName,
      signUpUrl: 'https://app.test/signup?email=maker%40studio.test',
    });
    for (const copy of [subject, body.text, body.html]) {
      expect(copy).not.toMatch(FORBIDDEN_WORDS);
      expect(copy).not.toContain(EM_DASH);
    }
  });

  it('escapes the requester and brand in the html', () => {
    const body = brandRequestEmailBody({
      requesterName: '<b>Priya</b>',
      brandName: 'A & B',
      signUpUrl: 'https://app.test/signup',
    });
    expect(body.html).toContain('&lt;b&gt;Priya&lt;/b&gt;');
    expect(body.html).toContain('A &amp; B');
    expect(body.html).not.toContain('<b>Priya</b>');
  });
});
