// Unit coverage for @srtdio/auth that needs no database: the fingerprint/IP
// helpers, the koa-style compose(), and fingerprintMiddleware()'s control flow
// against a hand-rolled Supabase client stub. Ungated, so it runs under the
// plain `pnpm test` unit pass as well as the auth E2E suite.

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  compose,
  fingerprintMiddleware,
  ipSubnet,
  isValidFingerprint,
  UnauthorizedError,
  type AuthContext,
  type Middleware,
} from '../../packages/auth/src/index';

const VALID_FP = 'a'.repeat(64);

// --- Pure helpers -----------------------------------------------------------

describe('isValidFingerprint', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isValidFingerprint(VALID_FP)).toBe(true);
    expect(isValidFingerprint('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects wrong length, casing, non-hex, and absent values', () => {
    expect(isValidFingerprint('a'.repeat(63))).toBe(false);
    expect(isValidFingerprint('a'.repeat(65))).toBe(false);
    expect(isValidFingerprint('A'.repeat(64))).toBe(false);
    expect(isValidFingerprint('g'.repeat(64))).toBe(false);
    expect(isValidFingerprint(null)).toBe(false);
    expect(isValidFingerprint(undefined)).toBe(false);
  });
});

describe('ipSubnet', () => {
  it('coarsens IPv4 to a /24', () => {
    expect(ipSubnet('203.0.113.42')).toBe('203.0.113.0/24');
  });

  it('coarsens IPv6 to a /48', () => {
    expect(ipSubnet('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
  });

  it('returns null for missing or unparseable input', () => {
    expect(ipSubnet(null)).toBeNull();
    expect(ipSubnet(undefined)).toBeNull();
    expect(ipSubnet('   ')).toBeNull();
    expect(ipSubnet('not-an-ip')).toBeNull();
    expect(ipSubnet('999.1.1.1')).toBeNull();
  });
});

// --- compose() --------------------------------------------------------------

const dummyCtx = {} as AuthContext;

describe('compose', () => {
  it('runs middlewares in order and reaches the terminal handler', async () => {
    const order: string[] = [];
    const mw =
      (tag: string): Middleware =>
      async (_ctx, next) => {
        order.push(`enter:${tag}`);
        const res = await next();
        order.push(`exit:${tag}`);
        return res;
      };
    const handler = (): Promise<Response> => {
      order.push('handler');
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const res = await compose(mw('a'), mw('b'))(dummyCtx, handler);

    expect(res.status).toBe(204);
    expect(order).toEqual(['enter:a', 'enter:b', 'handler', 'exit:b', 'exit:a']);
  });

  it('short-circuits when a middleware throws and never reaches the handler', async () => {
    let handlerRan = false;
    const boom: Middleware = () => {
      throw new UnauthorizedError('nope');
    };
    const handler = (): Promise<Response> => {
      handlerRan = true;
      return Promise.resolve(new Response());
    };

    await expect(compose(boom)(dummyCtx, handler)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(handlerRan).toBe(false);
  });

  it('with no middlewares invokes the handler directly', async () => {
    const res = await compose()(dummyCtx, () =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    expect(res.status).toBe(200);
  });

  it('rejects when a middleware calls next() twice', async () => {
    const doubleNext: Middleware = async (_ctx, next) => {
      await next();
      return next();
    };
    await expect(
      compose(doubleNext)(dummyCtx, () => Promise.resolve(new Response())),
    ).rejects.toThrow('next() called multiple times');
  });
});

// --- fingerprintMiddleware() ------------------------------------------------

interface StubResult {
  data: { id: string } | null;
  error: { message: string } | null;
}

/**
 * Minimal Supabase client stub shaped to exactly the two chains the middleware
 * drives: a select ... maybeSingle() lookup and an update ... eq() touch. Every
 * update payload is captured so the last_seen_at refresh can be asserted.
 */
function stubClient(
  lookup: StubResult,
  update: { error: { message: string } | null } = { error: null },
) {
  const updates: Array<Record<string, unknown>> = [];
  const selectChain = {
    eq: () => selectChain,
    is: () => selectChain,
    order: () => selectChain,
    limit: () => selectChain,
    maybeSingle: () => Promise.resolve(lookup),
  };
  const client = {
    from: () => ({
      select: () => selectChain,
      update: (values: Record<string, unknown>) => ({
        eq: () => {
          updates.push(values);
          return Promise.resolve(update);
        },
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient<Database>, updates };
}

function contextFor(client: SupabaseClient<Database>, fingerprint?: string): AuthContext {
  const headers = new Headers();
  if (fingerprint !== undefined) headers.set('X-Device-Fingerprint', fingerprint);
  return {
    request: new Request('https://api.test/resource', { method: 'POST', headers }),
    userId: 'user-1',
    client,
    traceId: 'trace-1',
  };
}

const next = (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 }));

describe('fingerprintMiddleware', () => {
  it('continues and refreshes last_seen_at when an active row matches', async () => {
    const { client, updates } = stubClient({ data: { id: 'row-1' }, error: null });

    const res = await fingerprintMiddleware()(contextFor(client, VALID_FP), next);

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty('last_seen_at');
  });

  it('rejects with 401 when the fingerprint header is absent', async () => {
    const { client } = stubClient({ data: { id: 'row-1' }, error: null });
    await expect(fingerprintMiddleware()(contextFor(client), next)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects with 401 when the fingerprint header is malformed', async () => {
    const { client } = stubClient({ data: { id: 'row-1' }, error: null });
    await expect(
      fingerprintMiddleware()(contextFor(client, 'not-a-hash'), next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects with 401 when no active row is found', async () => {
    const { client, updates } = stubClient({ data: null, error: null });
    const result = fingerprintMiddleware()(contextFor(client, VALID_FP), next);
    await expect(result).rejects.toBeInstanceOf(UnauthorizedError);
    expect(updates).toHaveLength(0);
  });

  it('rejects with 401 when the lookup itself errors', async () => {
    const { client } = stubClient({ data: null, error: { message: 'boom' } });
    await expect(
      fingerprintMiddleware()(contextFor(client, VALID_FP), next),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
