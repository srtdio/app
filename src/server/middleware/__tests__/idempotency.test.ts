import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_KEY_IN_PROGRESS,
  ERROR_KEY_MISMATCH,
  ERROR_KEY_REQUIRED,
  IDEMPOTENCY_HEADER,
  type IdempotencyScope,
  type IdempotencyStore,
  type Reservation,
  type ReserveResult,
  type StoredRecord,
  withIdempotency,
} from '@/server/middleware/idempotency';
import { TRACE_ID_HEADER } from '@/server/trace';

interface Entry extends StoredRecord {
  expiresAt: number;
}

/**
 * In-memory store mirroring the Supabase unique-constraint semantics: `reserve`
 * is atomic per scope, so a second reservation for a live key returns the
 * existing record instead of inserting.
 */
class MemoryStore implements IdempotencyStore {
  readonly rows = new Map<string, Entry>();

  private id(key: string, scope: IdempotencyScope): string {
    return JSON.stringify([key, scope.workspaceId, scope.userId]);
  }

  reserve(reservation: Reservation): Promise<ReserveResult> {
    const id = this.id(reservation.key, reservation);
    const existing = this.rows.get(id);
    if (existing) {
      return Promise.resolve({
        outcome: 'existing',
        record: {
          requestHash: existing.requestHash,
          responseStatus: existing.responseStatus,
          responseBody: existing.responseBody,
        },
      });
    }
    this.rows.set(id, {
      requestHash: reservation.requestHash,
      responseStatus: null,
      responseBody: null,
      expiresAt: reservation.expiresAt.getTime(),
    });
    return Promise.resolve({ outcome: 'reserved' });
  }

  finalize(input: {
    key: string;
    scope: IdempotencyScope;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    const id = this.id(input.key, input.scope);
    const row = this.rows.get(id);
    if (row) {
      row.responseStatus = input.responseStatus;
      row.responseBody = input.responseBody;
    }
    return Promise.resolve();
  }

  release(input: { key: string; scope: IdempotencyScope }): Promise<void> {
    this.rows.delete(this.id(input.key, input.scope));
    return Promise.resolve();
  }

  cleanup(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt < now.getTime()) {
        this.rows.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

function postRequest(body: unknown, key: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) {
    headers.set(IDEMPOTENCY_HEADER, key);
  }
  return new Request('https://api.test/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('withIdempotency', () => {
  it('replays the cached response for the same key + same body, calling the handler once', async () => {
    const store = new MemoryStore();
    const handler = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ id: 'post_1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const wrapped = withIdempotency(handler, { store });

    const first = await wrapped(postRequest({ title: 'hi' }, 'key-1'));
    const second = await wrapped(postRequest({ title: 'hi' }, 'key-1'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ id: 'post_1' });
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns 409 IDEMPOTENCY_KEY_MISMATCH for the same key + different body', async () => {
    const store = new MemoryStore();
    const handler = vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 }));
    const wrapped = withIdempotency(handler, { store });

    await wrapped(postRequest({ title: 'a' }, 'key-2'));
    const conflict = await wrapped(postRequest({ title: 'b' }, 'key-2'));

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: ERROR_KEY_MISMATCH, message: expect.any(String) },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns 400 IDEMPOTENCY_KEY_REQUIRED when the header is missing on a mutating request', async () => {
    const store = new MemoryStore();
    const handler = vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 }));
    const wrapped = withIdempotency(handler, { store });

    const res = await wrapped(postRequest({ title: 'x' }, null));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: ERROR_KEY_REQUIRED, message: expect.any(String) },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips the middleware for GET (no key required)', async () => {
    const store = new MemoryStore();
    const handler = vi.fn(async (): Promise<Response> => new Response('ok', { status: 200 }));
    const wrapped = withIdempotency(handler, { store });

    const res = await wrapped(new Request('https://api.test/posts', { method: 'GET' }));

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(0);
  });

  it('invokes the handler once under concurrent requests with the same key', async () => {
    const store = new MemoryStore();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (): Promise<Response> => {
      enter();
      await gate;
      return new Response(JSON.stringify({ id: 'post_c' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wrapped = withIdempotency(handler, { store });

    // Owner reserves the key and parks inside the handler.
    const owner = wrapped(postRequest({ title: 'c' }, 'key-3'));
    await entered;
    // Concurrent request observes the in-flight row and is rejected with 409,
    // without invoking the handler. Only then do we let the owner finalize.
    const loser = await wrapped(postRequest({ title: 'c' }, 'key-3'));
    expect(loser.status).toBe(409);
    expect(await loser.json()).toEqual({
      error: { code: ERROR_KEY_IN_PROGRESS, message: expect.any(String) },
    });

    release();
    const resOwner = await owner;
    expect(resOwner.status).toBe(201);
    expect(await resOwner.json()).toEqual({ id: 'post_c' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 5xx response, so a retry re-runs the handler and can succeed', async () => {
    const store = new MemoryStore();
    let attempt = 0;
    const handler = vi.fn(async (): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('boom', { status: 503 });
      }
      return new Response(JSON.stringify({ id: 'post_ok' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wrapped = withIdempotency(handler, { store });

    const failed = await wrapped(postRequest({ title: 'retry' }, 'key-4'));
    expect(failed.status).toBe(503);
    expect(store.rows.size).toBe(0);

    const retried = await wrapped(postRequest({ title: 'retry' }, 'key-4'));
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual({ id: 'post_ok' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('threads the inbound trace_id into the handler context', async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    const handler = vi.fn(async (_req: Request, ctx): Promise<Response> => {
      seen.push(ctx.traceId);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const wrapped = withIdempotency(handler, { store });

    const req = postRequest({ title: 't' }, 'key-5');
    req.headers.set(TRACE_ID_HEADER, 'trace-xyz');
    await wrapped(req);

    expect(seen).toEqual(['trace-xyz']);
  });

  it('mints a trace_id on middleware-generated responses when the inbound header is absent', async () => {
    const store = new MemoryStore();
    const handler = vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 }));
    const wrapped = withIdempotency(handler, { store });

    const res = await wrapped(postRequest({ title: 'x' }, null));

    expect(res.status).toBe(400);
    expect(res.headers.get(TRACE_ID_HEADER)).toMatch(/[0-9a-f-]{36}/);
  });
});
