// Idempotency-Key middleware for mutating HTTP endpoints (Cloudflare Workers).
//
// Every mutating request (POST/PUT/PATCH/DELETE) MUST carry a client-supplied
// `Idempotency-Key` header. The same key + same body replays the cached
// response within a 24h TTL; the same key + different body is a 409; a missing
// key is a 400. GET/HEAD/OPTIONS bypass the middleware entirely.
//
// Concurrency uses a reserve-then-finalize pattern over a unique constraint on
// (key, workspace_id, user_id): the first request to INSERT a pending row owns
// handler execution; concurrent requests hit the unique violation, read the
// row, and either replay (if the owner already finalized) or get a 409
// IN_PROGRESS (owner still running). This guarantees a single handler
// invocation without taking a row-level lock. See the PR description.
//
// Storage is server-side only via the Supabase service role key. The backing
// table `idempotency_keys` now exists, applied via migration
// supabase/migrations/20260607065302_idempotency_keys.sql; this module
// depends only on the IdempotencyStore interface, so tests run without a DB.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { v7 as uuidv7 } from 'uuid';
import { TRACE_ID_HEADER, extractTraceId } from '@/server/trace';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const ERROR_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED';
export const ERROR_KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH';
export const ERROR_KEY_IN_PROGRESS = 'IDEMPOTENCY_KEY_IN_PROGRESS';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Request-scoped context handed to the wrapped handler. */
export interface IdempotencyContext {
  traceId: string;
}

export type Handler = (request: Request, context: IdempotencyContext) => Promise<Response>;

/** Tenancy scope for a key. Both null = a global (unauthenticated) key. */
export interface IdempotencyScope {
  workspaceId: string | null;
  userId: string | null;
}

/** A pending-row reservation written before the handler runs. */
export interface Reservation extends IdempotencyScope {
  key: string;
  requestHash: string;
  traceId: string;
  expiresAt: Date;
}

/** The persisted record as seen by a concurrent or retrying request. */
export interface StoredRecord {
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
}

export type ReserveResult = { outcome: 'reserved' } | { outcome: 'existing'; record: StoredRecord };

/**
 * Persistence boundary. Domain errors are modelled in the return shape;
 * system errors (DB unreachable) are thrown and propagate out of the
 * middleware. Implementations must keep `reserve` atomic per scope.
 */
export interface IdempotencyStore {
  reserve(reservation: Reservation): Promise<ReserveResult>;
  finalize(input: {
    key: string;
    scope: IdempotencyScope;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void>;
  release(input: { key: string; scope: IdempotencyScope }): Promise<void>;
  cleanup(now: Date): Promise<number>;
}

export interface IdempotencyOptions {
  /** A shared store (tests, long-lived runtimes). */
  store?: IdempotencyStore;
  /** A per-request store factory; `dispose` runs in a finally block. */
  createStore?: () => { store: IdempotencyStore; dispose: () => Promise<void> | void };
  /** Resolves tenancy scope from the request; defaults to a global key. */
  resolveScope?: (
    request: Request,
    context: IdempotencyContext,
  ) => IdempotencyScope | Promise<IdempotencyScope>;
  ttlMs?: number;
  now?: () => number;
}

function jsonResponse(
  status: number,
  body: unknown,
  traceId: string,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json');
  headers.set(TRACE_ID_HEADER, traceId);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, code: string, message: string, traceId: string): Response {
  return jsonResponse(status, { error: { code, message } }, traceId);
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizeBody(raw: string): string {
  if (raw.trim() === '') {
    return '';
  }
  try {
    return stableStringify(JSON.parse(raw) as unknown);
  } catch {
    // Non-JSON body (e.g. multipart): hash the raw bytes verbatim.
    return raw;
  }
}

async function hashRequest(request: Request): Promise<string> {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  const raw = await request.clone().text();
  const payload = `${method}\n${path}\n${normalizeBody(raw)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function replay(record: StoredRecord, traceId: string): Response {
  const status = record.responseStatus ?? 200;
  const body = record.responseBody === null ? null : JSON.stringify(record.responseBody);
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set(TRACE_ID_HEADER, traceId);
  headers.set('Idempotent-Replayed', 'true');
  return new Response(body, { status, headers });
}

function resolveProvider(
  options: IdempotencyOptions,
): () => { store: IdempotencyStore; dispose: () => Promise<void> | void } {
  if (options.createStore) {
    return options.createStore;
  }
  const store = options.store;
  if (!store) {
    throw new Error('withIdempotency requires either `store` or `createStore`');
  }
  return () => ({ store, dispose: () => undefined });
}

/**
 * Wrap a handler with Idempotency-Key enforcement. Returns a handler that the
 * caller invokes with the inbound Request; the trace_id is read from the
 * X-Trace-Id header (or minted as uuid_v7) and threaded into the context.
 */
export function withIdempotency(
  handler: Handler,
  options: IdempotencyOptions,
): (request: Request) => Promise<Response> {
  const provider = resolveProvider(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());

  return async (request: Request): Promise<Response> => {
    const traceId = extractTraceId(request);
    const context: IdempotencyContext = { traceId };

    if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
      return handler(request, context);
    }

    const key = request.headers.get(IDEMPOTENCY_HEADER);
    if (!key) {
      return errorResponse(
        400,
        ERROR_KEY_REQUIRED,
        `Mutating requests require an ${IDEMPOTENCY_HEADER} header.`,
        traceId,
      );
    }

    const scope: IdempotencyScope = options.resolveScope
      ? await options.resolveScope(request, context)
      : { workspaceId: null, userId: null };
    const requestHash = await hashRequest(request);

    const { store, dispose } = provider();
    try {
      const reservation: Reservation = {
        key,
        requestHash,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        traceId,
        expiresAt: new Date(now() + ttlMs),
      };

      const reserved = await store.reserve(reservation);
      if (reserved.outcome === 'existing') {
        const record = reserved.record;
        if (record.requestHash !== requestHash) {
          return errorResponse(
            409,
            ERROR_KEY_MISMATCH,
            'Idempotency-Key was reused with a different request body.',
            traceId,
          );
        }
        if (record.responseStatus === null) {
          return errorResponse(
            409,
            ERROR_KEY_IN_PROGRESS,
            'A request with this Idempotency-Key is still in progress.',
            traceId,
          );
        }
        return replay(record, traceId);
      }

      // We own execution for this key.
      let response: Response;
      try {
        response = await handler(request, context);
      } catch (err) {
        // Handler threw: free the reservation so the client can retry.
        await store.release({ key, scope });
        throw err;
      }

      if (response.status >= 200 && response.status < 300) {
        await store.finalize({
          key,
          scope,
          responseStatus: response.status,
          responseBody: await readBody(response),
        });
        return response;
      }

      // Non-2xx: do not cache. Free the reservation so a retry can proceed.
      await store.release({ key, scope });
      return response;
    } finally {
      await dispose();
    }
  };
}

// ---------------------------------------------------------------------------
// Supabase-backed store (service role key, server-side only).
// ---------------------------------------------------------------------------

export interface SupabaseStoreEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}

const TABLE = 'idempotency_keys';
const UNIQUE_VIOLATION = '23505';

interface IdempotencyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

function scopedQuery<T>(builder: T, scope: IdempotencyScope): T {
  // `eq`/`is` narrow by tenancy; null columns must use `is` (SQL NULL).
  const b = builder as unknown as {
    eq: (col: string, val: string) => typeof b;
    is: (col: string, val: null) => typeof b;
  };
  const withWorkspace =
    scope.workspaceId === null
      ? b.is('workspace_id', null)
      : b.eq('workspace_id', scope.workspaceId);
  const withUser =
    scope.userId === null
      ? withWorkspace.is('user_id', null)
      : withWorkspace.eq('user_id', scope.userId);
  return withUser as unknown as T;
}

/**
 * Build a per-request Supabase store using the service role key. The returned
 * `dispose` releases the realtime socket (none here) and exists so callers can
 * close the client in a finally block per the connection-lifecycle rule.
 */
export function createSupabaseIdempotencyStore(env: SupabaseStoreEnv): {
  store: IdempotencyStore;
  dispose: () => Promise<void>;
} {
  const client: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const store: IdempotencyStore = {
    async reserve(reservation: Reservation): Promise<ReserveResult> {
      const insert = await client.from(TABLE).insert({
        id: uuidv7(),
        key: reservation.key,
        request_hash: reservation.requestHash,
        response_status: null,
        response_body: null,
        status: 'in_flight',
        workspace_id: reservation.workspaceId,
        user_id: reservation.userId,
        trace_id: reservation.traceId,
        expires_at: reservation.expiresAt.toISOString(),
      });

      if (!insert.error) {
        return { outcome: 'reserved' };
      }
      if (insert.error.code !== UNIQUE_VIOLATION) {
        throw insert.error; // system error
      }

      const existing = await scopedQuery(
        client
          .from(TABLE)
          .select('request_hash,response_status,response_body')
          .eq('key', reservation.key),
        { workspaceId: reservation.workspaceId, userId: reservation.userId },
      ).maybeSingle();

      if (existing.error) {
        throw existing.error;
      }
      const row = existing.data as IdempotencyRow | null;
      if (!row) {
        // Row vanished between insert and select (e.g. cleanup race): treat as
        // a fresh reservation by retrying once.
        return store.reserve(reservation);
      }
      return {
        outcome: 'existing',
        record: {
          requestHash: row.request_hash,
          responseStatus: row.response_status,
          responseBody: row.response_body,
        },
      };
    },

    async finalize(input): Promise<void> {
      const update = await scopedQuery(
        client
          .from(TABLE)
          .update({
            response_status: input.responseStatus,
            response_body: input.responseBody,
            status: 'completed',
          })
          .eq('key', input.key),
        input.scope,
      );
      if (update.error) {
        throw update.error;
      }
    },

    async release(input): Promise<void> {
      const del = await scopedQuery(client.from(TABLE).delete().eq('key', input.key), input.scope);
      if (del.error) {
        throw del.error;
      }
    },

    async cleanup(at: Date): Promise<number> {
      const del = await client
        .from(TABLE)
        .delete({ count: 'exact' })
        .lt('expires_at', at.toISOString());
      if (del.error) {
        throw del.error;
      }
      return del.count ?? 0;
    },
  };

  return {
    store,
    dispose: async (): Promise<void> => {
      await client.removeAllChannels();
    },
  };
}
