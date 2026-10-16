import { describe, expect, it } from 'vitest';
import {
  CATCHUP_TEMPLATE_KEY,
  buildIdempotencyKey,
  buildUnsubscribeHeaders,
  createDeliverer,
  createSupabaseDeliveryStore,
  resolveCatchupGate,
} from './catchup-deliver';
import type {
  CatchupDbClient,
  CatchupEnv,
  DeliverRequest,
  DeliveryAttemptRow,
  DeliveryStore,
  Logger,
} from './catchup-contracts';

// Contract-only tests for catchup-deliver.ts. All I/O is injected: fetch,
// clock, store and logger are fakes, so nothing leaves the process.

const SECRET_KEY = 'sb-secret-value-do-not-leak';
const RESEND_KEY = 're-api-key-do-not-leak';
const SIGNING_SECRET = 'unsub-signing-secret-do-not-leak';

const USER = 'user-0000-0000-0000-000000000001';
const WS = 'ws-00000000-0000-0000-000000000001';
const TRACE = '01920000-0000-7000-8000-000000000001';
const NOW = new Date('2026-06-15T05:00:00.000Z');
const ONE_CLICK = 'https://app.example.test/unsubscribe/one-click?t=abc';

function makeEnv(overrides: Partial<CatchupEnv> = {}): CatchupEnv {
  return {
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SECRET_KEY: SECRET_KEY,
    RESEND_API_KEY: RESEND_KEY,
    APP_BASE_URL: 'https://app.example.test',
    CATCHUP_FROM_ADDRESS: 'Sorted <catchup@example.test>',
    UNSUBSCRIBE_SIGNING_SECRET: SIGNING_SECRET,
    CATCHUP_MODE: 'live',
    ...overrides,
  };
}

const noop = (): void => undefined;
const log: Logger = {
  setTraceId: noop,
  clearTraceId: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

interface StoreEvent {
  kind: 'stamp' | 'attempt';
  userId?: string;
  entryIds?: readonly string[];
  atIso?: string;
  row?: DeliveryAttemptRow;
}

function makeStore(): { store: DeliveryStore; events: StoreEvent[] } {
  const events: StoreEvent[] = [];
  const store: DeliveryStore = {
    recordAttempt(row) {
      events.push({ kind: 'attempt', row });
      return Promise.resolve();
    },
    stampSent(userId, entryIds, atIso) {
      events.push({ kind: 'stamp', userId, entryIds: [...entryIds], atIso });
      return Promise.resolve();
    },
  };
  return { store, events };
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function makeFetch(respond: () => Promise<Response>): {
  fetch: typeof globalThis.fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });
    return respond();
  };
  return { fetch: fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const ENTRY_IDS = ['entry-1', 'entry-2', 'entry-3'] as const;

function makeRequest(): DeliverRequest {
  return {
    userId: USER,
    workspaceId: WS,
    entryIds: ENTRY_IDS,
    email: {
      to: 'recipient@example.test',
      from: 'Sorted <catchup@example.test>',
      rendered: { subject: 'Your catch-up', html: '<p>hi</p>', text: 'hi' },
      idempotencyKey: buildIdempotencyKey(USER, WS, '2026-06-15', '10:30'),
      headers: buildUnsubscribeHeaders(ONE_CLICK),
    },
  };
}

function setup(respond: () => Promise<Response>) {
  const { store, events } = makeStore();
  const { fetch, requests } = makeFetch(respond);
  const deliverer = createDeliverer({
    env: makeEnv(),
    store,
    traceId: TRACE,
    log,
    fetch,
    now: () => NOW,
  });
  return { deliverer, events, requests };
}

describe('CATCHUP_TEMPLATE_KEY', () => {
  it("is 'catch-up'", () => {
    expect(CATCHUP_TEMPLATE_KEY).toBe('catch-up');
  });
});

describe('buildIdempotencyKey', () => {
  it('formats catchup:{user}:{workspace}:{local date}:{slot}', () => {
    expect(buildIdempotencyKey(USER, WS, '2026-06-15', '10:30')).toBe(
      `catchup:${USER}:${WS}:2026-06-15:10:30`,
    );
    expect(buildIdempotencyKey('u', 'w', '2026-12-31', '15:30')).toBe(
      'catchup:u:w:2026-12-31:15:30',
    );
  });

  it('differs per slot, date, user and workspace', () => {
    const base = buildIdempotencyKey('u', 'w', '2026-06-15', '10:30');
    expect(buildIdempotencyKey('u', 'w', '2026-06-15', '15:30')).not.toBe(base);
    expect(buildIdempotencyKey('u', 'w', '2026-06-16', '10:30')).not.toBe(base);
    expect(buildIdempotencyKey('u2', 'w', '2026-06-15', '10:30')).not.toBe(base);
    expect(buildIdempotencyKey('u', 'w2', '2026-06-15', '10:30')).not.toBe(base);
  });
});

describe('buildUnsubscribeHeaders', () => {
  it('returns exactly the two one-click headers', () => {
    expect(buildUnsubscribeHeaders(ONE_CLICK)).toStrictEqual({
      'List-Unsubscribe': `<${ONE_CLICK}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('createDeliverer: outbound Resend request', () => {
  it('POSTs with Idempotency-Key, X-Trace-Id, Authorization and body headers', async () => {
    const { deliverer, requests } = setup(() => jsonResponse(200, { id: 'msg_1' }));
    const req = makeRequest();
    await deliverer.deliver(req);

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    if (sent === undefined) throw new Error('no request captured');
    expect(sent.method).toBe('POST');
    expect(sent.url.toLowerCase()).toContain('resend');
    expect(sent.headers.get('Idempotency-Key')).toBe(req.email.idempotencyKey);
    expect(sent.headers.get('X-Trace-Id')).toBe(TRACE);
    expect(sent.headers.get('Authorization')).toBe(`Bearer ${RESEND_KEY}`);

    expect(sent.body['headers']).toStrictEqual({
      'List-Unsubscribe': `<${ONE_CLICK}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(sent.body['from']).toBe(req.email.from);
    expect([sent.body['to']].flat()).toContain(req.email.to);
    expect(sent.body['subject']).toBe('Your catch-up');
    expect(sent.body['html']).toBe('<p>hi</p>');
    expect(sent.body['text']).toBe('hi');
  });
});

describe('createDeliverer: stamp only on success', () => {
  it('2xx with id: stamps the entry ids, then records a sent attempt', async () => {
    const { deliverer, events } = setup(() => jsonResponse(200, { id: 'msg_ok' }));
    const result = await deliverer.deliver(makeRequest());

    expect(result).toStrictEqual({ ok: true, providerMessageId: 'msg_ok' });
    expect(events.map((e) => e.kind)).toStrictEqual(['stamp', 'attempt']);

    const [stamp, attempt] = events;
    expect(stamp?.userId).toBe(USER);
    expect(stamp?.entryIds).toStrictEqual([...ENTRY_IDS]);
    expect(stamp?.atIso).toBe(NOW.toISOString());

    expect(attempt?.row).toStrictEqual({
      workspace_id: WS,
      user_id: USER,
      channel: 'email',
      template_key: 'catch-up',
      provider: 'resend',
      provider_message_id: 'msg_ok',
      status: 'sent',
      sent_at: NOW.toISOString(),
      error: null,
    });
  });

  const failures: [string, () => Promise<Response>][] = [
    ['500', () => jsonResponse(500, { message: 'internal' })],
    ['409 idempotency conflict', () => jsonResponse(409, { message: 'conflict' })],
    ['network throw', () => Promise.reject(new TypeError('network down'))],
    ['2xx without id', () => jsonResponse(200, {})],
  ];

  for (const [name, respond] of failures) {
    it(`${name}: no stamp, one failed attempt, ok:false, no throw`, async () => {
      const { deliverer, events } = setup(respond);
      const result = await deliverer.deliver(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
        expect(result.error).not.toContain(RESEND_KEY);
      }
      expect(events.filter((e) => e.kind === 'stamp')).toHaveLength(0);
      const attempts = events.filter((e) => e.kind === 'attempt');
      expect(attempts).toHaveLength(1);
      const row = attempts[0]?.row;
      expect(row?.status).toBe('failed');
      expect(row?.template_key).toBe('catch-up');
      expect(row?.provider).toBe('resend');
      expect(row?.channel).toBe('email');
      expect(row?.user_id).toBe(USER);
      expect(row?.workspace_id).toBe(WS);
      expect(row?.provider_message_id).toBeNull();
      expect(typeof row?.error).toBe('string');
      expect(row?.error ?? '').not.toContain(RESEND_KEY);
    });
  }
});

describe('resolveCatchupGate', () => {
  function expectThrowsWithoutSecrets(env: CatchupEnv): void {
    let message = '';
    expect(() => {
      try {
        resolveCatchupGate(env);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }).toThrow();
    for (const secret of [SECRET_KEY, RESEND_KEY, SIGNING_SECRET]) {
      expect(message).not.toContain(secret);
    }
  }

  it('throws when CATCHUP_MODE is missing', () => {
    const env: Partial<CatchupEnv> = makeEnv();
    delete env.CATCHUP_MODE;
    expectThrowsWithoutSecrets(env as CatchupEnv);
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: '' }));
  });

  it("throws on 'Live' (case-sensitive) and on 'test'", () => {
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: 'Live' }));
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: 'test' }));
  });

  it('throws in trial mode with an empty or blank trial list', () => {
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: 'trial' }));
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: 'trial', CATCHUP_TRIAL_USER_IDS: '' }));
    expectThrowsWithoutSecrets(makeEnv({ CATCHUP_MODE: 'trial', CATCHUP_TRIAL_USER_IDS: ' , ' }));
  });

  it('trial mode parses trimmed comma-separated ids into a Set', () => {
    const gate = resolveCatchupGate(
      makeEnv({ CATCHUP_MODE: 'trial', CATCHUP_TRIAL_USER_IDS: ' u1 ,u2,, u3 ' }),
    );
    expect(gate.mode).toBe('trial');
    if (gate.mode === 'trial') {
      expect(gate.userIds).toBeInstanceOf(Set);
      expect([...gate.userIds].sort()).toStrictEqual(['u1', 'u2', 'u3']);
    }
  });

  it('live mode resolves to { mode: live }', () => {
    expect(resolveCatchupGate(makeEnv({ CATCHUP_MODE: 'live' }))).toStrictEqual({ mode: 'live' });
  });

  const required = [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'RESEND_API_KEY',
    'APP_BASE_URL',
    'CATCHUP_FROM_ADDRESS',
    'UNSUBSCRIBE_SIGNING_SECRET',
  ] as const;

  for (const key of required) {
    it(`throws when ${key} is missing or blank, without leaking secrets`, () => {
      const missing: Partial<CatchupEnv> = makeEnv();
      delete missing[key];
      expectThrowsWithoutSecrets(missing as CatchupEnv);
      expectThrowsWithoutSecrets(makeEnv({ [key]: '   ' }));
    });
  }
});

describe('createSupabaseDeliveryStore', () => {
  interface Op {
    table: string;
    op: 'insert' | 'update';
    payload: unknown;
    filters: { method: 'eq' | 'in'; column: string; value: unknown }[];
  }

  function makeClient(): { client: CatchupDbClient; ops: Op[] } {
    const ops: Op[] = [];
    const ok = { data: null, error: null };

    function chain(op: Op) {
      const builder = {
        eq(column: string, value: unknown) {
          op.filters.push({ method: 'eq', column, value });
          return builder;
        },
        in(column: string, value: unknown) {
          op.filters.push({ method: 'in', column, value });
          return builder;
        },
        select() {
          return builder;
        },
        then<T>(resolve: (v: typeof ok) => T) {
          return Promise.resolve(ok).then(resolve);
        },
      };
      return builder;
    }

    const fake = {
      from(table: string) {
        return {
          insert(payload: unknown) {
            const op: Op = { table, op: 'insert', payload, filters: [] };
            ops.push(op);
            return chain(op);
          },
          update(payload: unknown) {
            const op: Op = { table, op: 'update', payload, filters: [] };
            ops.push(op);
            return chain(op);
          },
        };
      },
    };
    return { client: fake as unknown as CatchupDbClient, ops };
  }

  it('recordAttempt inserts one row into delivery_attempts', async () => {
    const { client, ops } = makeClient();
    const store = createSupabaseDeliveryStore(client);
    const row: DeliveryAttemptRow = {
      workspace_id: WS,
      user_id: USER,
      channel: 'email',
      template_key: 'catch-up',
      provider: 'resend',
      provider_message_id: 'msg_1',
      status: 'sent',
      sent_at: NOW.toISOString(),
      error: null,
    };
    await store.recordAttempt(row);

    expect(ops).toHaveLength(1);
    expect(ops[0]?.table).toBe('delivery_attempts');
    expect(ops[0]?.op).toBe('insert');
    expect([ops[0]?.payload].flat()).toStrictEqual([row]);
  });

  it('stampSent updates inbox_entries.email_sent_at scoped by user_id and ids', async () => {
    const { client, ops } = makeClient();
    const store = createSupabaseDeliveryStore(client);
    await store.stampSent(USER, ['e1', 'e2'], NOW.toISOString());

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.table).toBe('inbox_entries');
    expect(op?.op).toBe('update');
    expect(op?.payload).toStrictEqual({ email_sent_at: NOW.toISOString() });
    expect(op?.filters).toContainEqual({ method: 'eq', column: 'user_id', value: USER });
    expect(op?.filters).toContainEqual({ method: 'in', column: 'id', value: ['e1', 'e2'] });
  });
});
