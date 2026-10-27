import { describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import { handleOpsCockpit, sessionIdOf, type OpsCockpitDeps } from './handler.ts';
import { EMAIL_BOUNCES_SQL, EMAIL_SQL, type SqlRunner } from './sources.ts';

const OPERATOR = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000002';
const NOW = new Date('2026-10-27T10:00:00Z');

/** A JWT-shaped string with a session_id claim (the fake auth accepts it as-is). */
function jwtFor(sub: string, sessionId = 'sess-1'): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64({ sub, session_id: sessionId })}.sig`;
}

interface World {
  /** user id -> revoked_at (null = active operator). Missing: not an operator. */
  operators: Map<string, string | null>;
  accessLog: Record<string, unknown>[];
  rpcError?: string;
}

function fakeClientFactory(world: World): typeof createClient {
  const factory = () => ({
    auth: {
      getUser: (jwt: string) => {
        const payload = JSON.parse(
          Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}',
        ) as { sub?: string };
        return Promise.resolve(
          payload.sub
            ? { data: { user: { id: payload.sub } }, error: null }
            : { data: { user: null }, error: { message: 'bad jwt' } },
        );
      },
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return chain;
        },
        is: (col: string, value: unknown) => {
          filters[`is:${col}`] = value;
          return chain;
        },
        maybeSingle: () => {
          const id = String(filters.user_id);
          const active = world.operators.has(id) && world.operators.get(id) === null;
          return Promise.resolve({ data: active ? { user_id: id } : null, error: null });
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'cockpit_access_log') world.accessLog.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
    rpc: () =>
      Promise.resolve(
        world.rpcError
          ? { data: null, error: { message: world.rpcError } }
          : {
              data: {
                signed_up: 40,
                confirmed: 35,
                signed_in_30d: 20,
                active_today: 7,
                active_7d: 12,
                active_30d: 18,
                daily: [{ day: '2026-10-27', active: 7, self_signups: 2 }],
                countries_30d: [{ country: 'IN', people: 10 }],
              },
              error: null,
            },
      ),
  });
  return factory as unknown as typeof createClient;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://movnexawfhsyuluspxoc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SENTRY_TOKEN: 'sentry-token',
  SENTRY_ORG: 'srtdio',
  SENTRY_PROJECT: 'frontend',
  CF_ANALYTICS_TOKEN: 'cf-token',
  CF_ACCOUNT_ID: 'acc',
  CF_ZONE_ID: 'zone',
  CF_WEB_ANALYTICS_SITE_TAG: 'site',
  OPS_MGMT_TOKEN: 'mgmt',
};

type Vendor = 'sentry' | 'logs' | 'cloudflare';

function vendorFetch(fail: Partial<Record<Vendor, 'down' | 'auth' | 'hang'>> = {}) {
  return vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const vendor: Vendor = url.includes('sentry.io')
      ? 'sentry'
      : url.includes('api.supabase.com')
        ? 'logs'
        : 'cloudflare';
    const mode = fail[vendor];
    if (mode === 'hang') return new Promise<Response>(() => undefined);
    if (mode === 'down') return Promise.reject(new Error('ECONNRESET'));
    if (mode === 'auth') return Promise.resolve(new Response('{}', { status: 401 }));
    if (vendor === 'sentry') {
      return Promise.resolve(
        Response.json([
          {
            id: '1',
            title: 'TypeError: x is undefined',
            culprit: 'PipelinePage',
            count: '12',
            firstSeen: '2026-10-27T09:30:00Z',
            lastSeen: '2026-10-27T09:59:00Z',
            substatus: 'new',
            permalink: 'https://sentry.io/issues/1',
          },
        ]),
      );
    }
    if (vendor === 'logs') {
      return Promise.resolve(Response.json({ result: [{ fn: 'invite-send', failures: 4 }] }));
    }
    return Promise.resolve(
      Response.json({
        data: {
          viewer: {
            zones: [
              {
                total: [{ count: 1000 }],
                errors: [{ count: 2 }],
                daily: [{ dimensions: { date: '2026-10-27' }, uniq: { uniques: 50 } }],
              },
            ],
          },
        },
      }),
    );
  });
}

const sql: SqlRunner = (text) => {
  if (text === EMAIL_BOUNCES_SQL) return Promise.resolve([{ bounced: 1 }]);
  if (text === EMAIL_SQL) {
    return Promise.resolve([
      {
        delivered: 9,
        bounced: 1,
        delayed: 0,
        spam: 0,
        latest: [
          {
            id: 'e1',
            template_key: 'member_invite',
            status: 'bounced',
            at: '2026-10-27T09:00:00Z',
            // Even if SQL ever handed back a full address, the response masks it.
            recipient: 'priya.sharma@example.com',
          },
        ],
      },
    ]);
  }
  if (text.includes('chat_messages')) return Promise.resolve([{ messages: 30, voice_notes: 4 }]);
  if (text.includes('public.groups')) return Promise.resolve([{ groups: 6 }]);
  return Promise.resolve([{ failed: 0, problems: [] }]);
};

function deps(world: World, overrides: Partial<OpsCockpitDeps> = {}): OpsCockpitDeps {
  return {
    env: (name) => ENV[name],
    createClient: fakeClientFactory(world),
    fetch: vendorFetch() as unknown as typeof globalThis.fetch,
    sql,
    now: () => NOW,
    timeoutMs: 50,
    ...overrides,
  };
}

function request(query: string, token: string | null): Request {
  const headers = new Headers({ Origin: 'https://srtd.io' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return new Request(`https://x.supabase.co/functions/v1/ops-cockpit?${query}`, { headers });
}

function world(): World {
  return { operators: new Map([[OPERATOR, null]]), accessLog: [] };
}

describe('ops-cockpit auth', () => {
  it('404s with an empty body for a signed-in non-operator', async () => {
    const w = world();
    const res = await handleOpsCockpit(request('mode=status', jwtFor(OTHER)), deps(w));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('404s for a revoked operator', async () => {
    const w = world();
    w.operators.set(OTHER, '2026-10-01T00:00:00Z');
    const res = await handleOpsCockpit(
      request('mode=full&tab=users&open=1', jwtFor(OTHER)),
      deps(w),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(w.accessLog).toEqual([]);
  });

  it('404s without a token', async () => {
    const res = await handleOpsCockpit(request('mode=status', null), deps(world()));
    expect(res.status).toBe(404);
  });

  it('answers the preflight with the caller origin', async () => {
    const res = await handleOpsCockpit(
      new Request('https://x/functions/v1/ops-cockpit', {
        method: 'OPTIONS',
        headers: { Origin: 'https://test.srtdio-app.pages.dev' },
      }),
      deps(world()),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://test.srtdio-app.pages.dev',
    );
  });
});

describe('ops-cockpit modes', () => {
  it('status: red when one function fails 3+ times in the hour', async () => {
    const res = await handleOpsCockpit(request('mode=status', jwtFor(OPERATOR)), deps(world()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { level: string; alerts: { id: string }[] };
    expect(body.level).toBe('red');
    expect(body.alerts.map((a) => a.id)).toContain('fn:invite-send');
  });

  it('one failing source leaves the others intact', async () => {
    const res = await handleOpsCockpit(
      request('mode=full&tab=errors', jwtFor(OPERATOR)),
      deps(world(), {
        fetch: vendorFetch({ sentry: 'hang', cloudflare: 'auth' }) as unknown as typeof fetch,
      }),
    );
    const body = (await res.json()) as {
      tiles: Record<string, { state: string; reason?: string; value?: number }>;
      data: { state: string; reason?: string };
    };
    expect(body.tiles.errors).toEqual({ state: 'error', reason: "Can't reach Sentry" });
    expect(body.tiles.traffic).toEqual({ state: 'error', reason: 'Token expired: Cloudflare' });
    expect(body.data).toEqual({ state: 'error', reason: "Can't reach Sentry" });
    expect(body.tiles.backend).toMatchObject({ state: 'ok', value: 4, level: 'red' });
    expect(body.tiles.email).toMatchObject({ state: 'ok', value: 9 });
    expect(body.tiles.chat).toMatchObject({ state: 'ok', value: 30 });
    expect(body.tiles.users).toMatchObject({ state: 'ok', value: 7 });
  });

  it('masks every email address', async () => {
    const res = await handleOpsCockpit(
      request('mode=full&tab=email', jwtFor(OPERATOR)),
      deps(world()),
    );
    const text = await res.text();
    expect(text).not.toContain('priya.sharma@example.com');
    const body = JSON.parse(text) as { data: { data: { latest: { to: string }[] } } };
    expect(body.data.data.latest[0]?.to).toBe('p***@example.com');
  });

  it('writes the access log on open only, never on a poll', async () => {
    const w = world();
    await handleOpsCockpit(request('mode=full&tab=users', jwtFor(OPERATOR)), deps(w));
    await handleOpsCockpit(request('mode=status', jwtFor(OPERATOR)), deps(w));
    expect(w.accessLog).toEqual([]);
    await handleOpsCockpit(
      request('mode=full&tab=users&open=1', jwtFor(OPERATOR, 'sess-9')),
      deps(w),
    );
    expect(w.accessLog).toHaveLength(1);
    expect(w.accessLog[0]).toMatchObject({
      operator_user_id: OPERATOR,
      route: 'cockpit/users',
      session_id: 'sess-9',
    });
    expect(String(w.accessLog[0]?.trace_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a failed users rpc shows its reason on the Users tile only', async () => {
    const w = { ...world(), rpcError: 'boom' };
    const res = await handleOpsCockpit(request('mode=full&tab=users', jwtFor(OPERATOR)), deps(w));
    const body = (await res.json()) as { tiles: Record<string, { state: string }> };
    expect(body.tiles.users).toEqual({ state: 'error', reason: "Can't reach Users" });
    expect(body.tiles.email?.state).toBe('ok');
  });
});

describe('sessionIdOf', () => {
  it('reads the session_id claim', () => {
    expect(sessionIdOf(jwtFor(OPERATOR, 'abc'))).toBe('abc');
    expect(sessionIdOf('nope')).toBeNull();
  });
});
