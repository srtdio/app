import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import { handleCatchupUnsubscribe } from './handler.ts';

// Shared fixed vector. Edge code cannot import packages/, so these literals
// must stay identical to UNSUBSCRIBE_TEST_VECTOR in
// packages/inbox/src/catchup-contracts.ts.
const USER_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-signing-secret';
const TOKEN = '1cG5xz_Fx7sb5-I-ZIlG4AnHelpNwVy1BIFj-JwhriU';

const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const UNKNOWN_USER = '00000000-0000-4000-8000-000000000003';
const FN_URL = 'https://db.test/functions/v1/catchup-unsubscribe';
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';
const WRITE_METHODS = new Set(['update', 'insert', 'upsert', 'delete']);

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
  UNSUBSCRIBE_SIGNING_SECRET: SECRET,
  APP_BASE_URL: 'https://app.test/',
};

async function sign(userId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId)),
  );
  return Buffer.from(mac).toString('base64url');
}

interface RecordedCall {
  table: string | null;
  method: string;
  args: unknown[];
}

interface RecordedWrite {
  table: string;
  method: string;
  payload: unknown;
  filters: Array<[string, unknown]>;
}

type Row = { id: string; email_opt_in: boolean };
type Result = { data: unknown; error: unknown };

// A recording PostgREST fake. Every builder method returns the same chain and
// is logged; terminals (then, single, maybeSingle) resolve against an in-memory
// users table. Writes are applied only when filtered by id.
function makeFake(initial: Record<string, boolean>) {
  const users = new Map<string, Row>(
    Object.entries(initial).map(([id, optIn]) => [id, { id, email_opt_in: optIn }]),
  );
  const calls: RecordedCall[] = [];
  const writes: RecordedWrite[] = [];

  function chain(table: string): unknown {
    let write: RecordedWrite | null = null;
    const filters: Array<[string, unknown]> = [];

    const settle = (mode: 'many' | 'single' | 'maybeSingle'): Result => {
      const idFilter = filters.find(([column]) => column === 'id');
      const matched = table === 'users' && idFilter ? users.get(String(idFilter[1])) : undefined;
      if (write && write.method === 'update' && matched) {
        Object.assign(matched, write.payload as Partial<Row>);
      }
      const rows = matched ? [{ ...matched }] : [];
      if (mode === 'many') return { data: rows, error: null };
      if (rows.length === 1) return { data: rows[0], error: null };
      if (mode === 'maybeSingle') return { data: null, error: null };
      return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    };

    const proxy: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (
              onFulfilled: (value: Result) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) => Promise.resolve(settle('many')).then(onFulfilled, onRejected);
          }
          if (prop === 'single' || prop === 'maybeSingle') {
            return (...args: unknown[]) => {
              calls.push({ table, method: prop, args });
              return Promise.resolve(settle(prop));
            };
          }
          const method = String(prop);
          return (...args: unknown[]) => {
            calls.push({ table, method, args });
            if (WRITE_METHODS.has(method)) {
              write = { table, method, payload: args[0], filters };
              writes.push(write);
            } else if (method === 'eq') {
              filters.push([String(args[0]), args[1]]);
            } else if (method === 'match' && typeof args[0] === 'object' && args[0] !== null) {
              for (const [column, value] of Object.entries(args[0])) filters.push([column, value]);
            } else if (method === 'filter' && args[1] === 'eq') {
              filters.push([String(args[0]), args[2]]);
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  }

  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: null, method: 'rpc', args });
    return Promise.resolve({ data: null, error: null });
  });
  const client: Record<string, unknown> = {
    from: (table: string) => {
      calls.push({ table, method: 'from', args: [table] });
      return chain(table);
    },
    rpc,
  };
  client.schema = () => client;

  const factory = vi.fn<(url: string, key: string, opts?: unknown) => typeof client>(() => client);
  return {
    users,
    calls,
    writes,
    rpc,
    factory,
    deps: {
      env: (name: string): string | undefined => ENV[name],
      createClient: factory as unknown as typeof createClient,
    },
  };
}

type Fake = ReturnType<typeof makeFake>;

function expectNoWrites(fake: Fake): void {
  expect(fake.writes).toEqual([]);
  expect(fake.calls.filter((c) => WRITE_METHODS.has(c.method) || c.method === 'rpc')).toEqual([]);
  expect(fake.rpc).not.toHaveBeenCalled();
}

function query(u: string | null, t: string | null): string {
  const params = new URLSearchParams();
  if (u !== null) params.set('u', u);
  if (t !== null) params.set('t', t);
  const qs = params.toString();
  return qs ? `${FN_URL}?${qs}` : FN_URL;
}

function getRequest(u: string | null, t: string | null): Request {
  return new Request(query(u, t), { method: 'GET', headers: { Origin: 'https://app.test' } });
}

function oneClickRequest(u: string | null, t: string | null): Request {
  return new Request(query(u, t), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: ONE_CLICK_BODY,
  });
}

// RFC 8058 one-click sent as multipart/form-data; Request sets the boundary.
function multipartOneClickRequest(u: string | null, t: string | null): Request {
  const form = new FormData();
  form.set('List-Unsubscribe', 'One-Click');
  return new Request(query(u, t), { method: 'POST', body: form });
}

function jsonRequest(body: unknown): Request {
  return new Request(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function flipFirst(value: string): string {
  return (value.startsWith('A') ? 'B' : 'A') + value.slice(1);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('catchup-unsubscribe shared vector', () => {
  it('the hardcoded vector is HMAC-SHA256 base64url of the user id', async () => {
    await expect(sign(USER_ID, SECRET)).resolves.toBe(TOKEN);
  });
});

describe('catchup-unsubscribe GET', () => {
  it('returns 200 {subscribed:true} for an opted-in user and never writes', async () => {
    const fake = makeFake({ [USER_ID]: true });
    const res = await handleCatchupUnsubscribe(getRequest(USER_ID, TOKEN), fake.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: true });
    expectNoWrites(fake);
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(true);
  });

  it('returns 200 {subscribed:false} for an opted-out user and never writes', async () => {
    const fake = makeFake({ [USER_ID]: false });
    const res = await handleCatchupUnsubscribe(getRequest(USER_ID, TOKEN), fake.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
    expectNoWrites(fake);
  });

  it.each([
    ['a tampered token', USER_ID, flipFirst(TOKEN)],
    ['a truncated token', USER_ID, TOKEN.slice(0, -1)],
    ['another user id', OTHER_USER, TOKEN],
    ['a missing token', USER_ID, null],
    ['a missing user id', null, TOKEN],
    ['garbage', USER_ID, '!!!not*base64%%%'],
  ])('returns 404 with an empty body for %s and never writes', async (_l, u, t) => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const res = await handleCatchupUnsubscribe(getRequest(u, t), fake.deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
  });

  it('returns 404 with an empty body for a valid token of an unknown user', async () => {
    const fake = makeFake({ [USER_ID]: true });
    const token = await sign(UNKNOWN_USER, SECRET);
    const res = await handleCatchupUnsubscribe(getRequest(UNKNOWN_USER, token), fake.deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
  });
});

describe('catchup-unsubscribe one-click POST (RFC 8058)', () => {
  it('sets email_opt_in=false for exactly that user and returns 200 with an empty body', async () => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const res = await handleCatchupUnsubscribe(oneClickRequest(USER_ID, TOKEN), fake.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(fake.writes).toHaveLength(1);
    const [write] = fake.writes;
    expect(write?.table).toBe('users');
    expect(write?.method).toBe('update');
    expect(write?.payload).toEqual({ email_opt_in: false });
    expect(write?.filters).toContainEqual(['id', USER_ID]);
    expect(write?.filters.filter(([column]) => column === 'id')).toEqual([['id', USER_ID]]);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(false);
    expect(fake.users.get(OTHER_USER)?.email_opt_in).toBe(true);
  });

  it('uses the service-role client against SUPABASE_URL', async () => {
    const fake = makeFake({ [USER_ID]: true });
    await handleCatchupUnsubscribe(oneClickRequest(USER_ID, TOKEN), fake.deps);
    expect(fake.factory).toHaveBeenCalled();
    for (const call of fake.factory.mock.calls) {
      expect(call[0]).toBe(ENV.SUPABASE_URL);
    }
    expect(fake.factory.mock.calls.some((call) => call[1] === ENV.SUPABASE_SERVICE_ROLE_KEY)).toBe(
      true,
    );
  });

  it.each([
    ['a tampered token', USER_ID, flipFirst(TOKEN)],
    ['another user id', OTHER_USER, TOKEN],
    ['a missing token', USER_ID, null],
    ['an empty token', USER_ID, ''],
  ])('returns 404 with an empty body for %s and never writes', async (_l, u, t) => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const res = await handleCatchupUnsubscribe(oneClickRequest(u, t), fake.deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(true);
    expect(fake.users.get(OTHER_USER)?.email_opt_in).toBe(true);
  });
});

describe('catchup-unsubscribe one-click POST as multipart/form-data', () => {
  it('sets email_opt_in=false for exactly that user and returns 200 with an empty body', async () => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const req = multipartOneClickRequest(USER_ID, TOKEN);
    expect(req.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    const res = await handleCatchupUnsubscribe(req, fake.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(fake.writes).toHaveLength(1);
    const [write] = fake.writes;
    expect(write?.table).toBe('users');
    expect(write?.method).toBe('update');
    expect(write?.payload).toEqual({ email_opt_in: false });
    expect(write?.filters.filter(([column]) => column === 'id')).toEqual([['id', USER_ID]]);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(false);
    expect(fake.users.get(OTHER_USER)?.email_opt_in).toBe(true);
  });

  it('returns 404 with an empty body for a bad token and never writes', async () => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const res = await handleCatchupUnsubscribe(
      multipartOneClickRequest(USER_ID, flipFirst(TOKEN)),
      fake.deps,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(true);
  });
});

describe('catchup-unsubscribe JSON POST', () => {
  it('unsubscribe sets email_opt_in=false and returns {subscribed:false}', async () => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const res = await handleCatchupUnsubscribe(
      jsonRequest({ u: USER_ID, t: TOKEN, action: 'unsubscribe' }),
      fake.deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
    const updates = fake.writes.filter((w) => w.method === 'update');
    expect(fake.writes).toEqual(updates);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe('users');
    expect(updates[0]?.payload).toEqual({ email_opt_in: false });
    expect(updates[0]?.filters.filter(([column]) => column === 'id')).toEqual([['id', USER_ID]]);
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(false);
    expect(fake.users.get(OTHER_USER)?.email_opt_in).toBe(true);
  });

  it('resubscribe sets email_opt_in=true and returns {subscribed:true}', async () => {
    const fake = makeFake({ [USER_ID]: false, [OTHER_USER]: false });
    const res = await handleCatchupUnsubscribe(
      jsonRequest({ u: USER_ID, t: TOKEN, action: 'resubscribe' }),
      fake.deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: true });
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.payload).toEqual({ email_opt_in: true });
    expect(fake.writes[0]?.filters.filter(([column]) => column === 'id')).toEqual([
      ['id', USER_ID],
    ]);
    expect(fake.users.get(USER_ID)?.email_opt_in).toBe(true);
    expect(fake.users.get(OTHER_USER)?.email_opt_in).toBe(false);
  });

  it.each([
    ['a tampered token', { u: USER_ID, t: flipFirst(TOKEN), action: 'unsubscribe' }],
    ['another user id', { u: OTHER_USER, t: TOKEN, action: 'unsubscribe' }],
    ['the wrong secret', { u: USER_ID, t: 'placeholder', action: 'resubscribe' }],
  ])('returns 404 with an empty body for %s and never writes', async (label, body) => {
    const fake = makeFake({ [USER_ID]: true, [OTHER_USER]: true });
    const payload =
      label === 'the wrong secret' ? { ...body, t: await sign(USER_ID, 'wrong-secret') } : body;
    const res = await handleCatchupUnsubscribe(jsonRequest(payload), fake.deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
  });

  it('returns 404 with an empty body for an empty token and never writes', async () => {
    const fake = makeFake({ [USER_ID]: true });
    const res = await handleCatchupUnsubscribe(
      jsonRequest({ u: USER_ID, t: '', action: 'unsubscribe' }),
      fake.deps,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an unknown action', { u: USER_ID, t: TOKEN, action: 'delete' }],
    ['a missing action', { u: USER_ID, t: TOKEN }],
  ])('returns 400 with an empty body for %s and never writes', async (_l, body) => {
    const fake = makeFake({ [USER_ID]: true });
    const res = await handleCatchupUnsubscribe(jsonRequest(body), fake.deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
    expectNoWrites(fake);
  });
});

describe('catchup-unsubscribe trace id', () => {
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const INBOUND = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  function tracedGet(traceId: string): Request {
    return new Request(query(USER_ID, TOKEN), {
      method: 'GET',
      headers: { 'X-Trace-Id': traceId },
    });
  }

  // A raw newline cannot be set on a fetch Headers value, so the injection-style
  // case uses the same payload with the newline already folded to a space.
  it('echoes a valid uuid and replaces a malformed one with a uuid-shaped id', async () => {
    const fake = makeFake({ [USER_ID]: true });
    const echoed = await handleCatchupUnsubscribe(tracedGet(INBOUND), fake.deps);
    expect(echoed.headers.get('X-Trace-Id')).toBe(INBOUND);

    for (const bad of ['not-a-uuid', 'abc X: y', `${INBOUND}x`, `${INBOUND}, evil`]) {
      const res = await handleCatchupUnsubscribe(tracedGet(bad), fake.deps);
      const traceId = res.headers.get('X-Trace-Id');
      expect(traceId).toMatch(UUID_SHAPE);
      expect(traceId).not.toBe(bad);
      expect(traceId).not.toContain('X: y');
    }
  });
});

describe('catchup-unsubscribe CORS', () => {
  it('answers OPTIONS with 204 and CORS headers, touching nothing', async () => {
    const fake = makeFake({ [USER_ID]: true });
    const res = await handleCatchupUnsubscribe(
      new Request(FN_URL, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
      fake.deps,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(fake.calls).toEqual([]);
    expectNoWrites(fake);
  });
});
