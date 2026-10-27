// ops-cockpit request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with injected deps.
// Self-contained: NO @srtdio/* imports (see index.ts for why).
//
// GET ?mode=status            the dot: Sentry new issues, function failures,
//                             bounces, Cloudflare error rate -> { level, alerts }
// GET ?mode=full&tab=<tab>    that tab's data plus every tile number;
//     &open=1                 also writes one cockpit_access_log row (an open
//                             or a tab pick, never a poll)
//
// Only the platform operator (a platform_operators row with revoked_at null,
// read with the service client) gets an answer. Everyone else, signed in or
// not, gets 404 with an empty body: the endpoint does not exist for them.

import type { createClient } from '@supabase/supabase-js';
import {
  buildAlerts,
  errorRate,
  ERROR_RATE_AMBER,
  ERROR_RATE_RED,
  FUNCTION_FAILURES_RED,
  isTab,
  worstLevel,
  type Alert,
  type Level,
  type Source,
  type Tab,
} from './rules.ts';
import {
  fetchChat,
  fetchCloudflare,
  fetchEmail,
  fetchEmailBounces,
  fetchFunctionFailures,
  fetchLogRows,
  fetchSentry,
  fetchUsers,
  settle,
  type ChatData,
  type EmailData,
  type LogRow,
  type SentryData,
  type SourceDeps,
  type SqlRunner,
  type TrafficData,
  type UsersData,
} from './sources.ts';

const TRACE_ID_HEADER = 'X-Trace-Id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface OpsCockpitDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
  fetch: typeof globalThis.fetch;
  sql: SqlRunner | null;
  now?: () => Date;
  timeoutMs?: number;
}

// Time-ordered UUID v7, generated inline (no dependency).
function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin.replace(/\/$/, ''),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, apikey, x-client-info, content-type, x-trace-id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, origin: string, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      [TRACE_ID_HEADER]: traceId,
      ...corsHeaders(origin),
    },
  });
}

/** 404, empty body: for anyone who is not the operator the endpoint is not there. */
function notFound(origin: string, traceId: string): Response {
  return new Response(null, {
    status: 404,
    headers: { [TRACE_ID_HEADER]: traceId, ...corsHeaders(origin) },
  });
}

/** The session_id claim of an already-verified JWT (null when absent). */
export function sessionIdOf(jwt: string): string | null {
  const part = jwt.split('.')[1];
  if (part === undefined) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      session_id?: unknown;
    };
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

export type Tile =
  | { state: 'ok'; value: number; level: Level }
  | { state: 'error'; reason: string };

export interface CockpitTiles {
  errors: Tile;
  backend: Tile;
  email: Tile;
  chat: Tile;
  traffic: Tile;
  users: Tile;
}

function tile<T>(source: Source<T>, read: (data: T) => { value: number; level: Level }): Tile {
  return source.state === 'ok' ? { state: 'ok', ...read(source.data) } : source;
}

function rateLevel(rate: number): Level {
  if (rate > ERROR_RATE_RED) return 'red';
  if (rate > ERROR_RATE_AMBER) return 'amber';
  return 'green';
}

/** Function failures from loaded Logs rows (the Logs tab's one log call). */
function failuresFromRows(rows: LogRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.source !== 'Function' || row.level !== 'error') continue;
    out['Edge functions'] = (out['Edge functions'] ?? 0) + 1;
  }
  return out;
}

function failedSources(
  list: { name: string; tab: Tab; source: Source<unknown> }[],
): { name: string; reason: string; tab: Tab }[] {
  return list.flatMap(({ name, tab, source }) =>
    source.state === 'error' ? [{ name, reason: source.reason, tab }] : [],
  );
}

export async function handleOpsCockpit(req: Request, deps: OpsCockpitDeps): Promise<Response> {
  const headerTrace = req.headers.get(TRACE_ID_HEADER);
  const traceId = headerTrace !== null && UUID_RE.test(headerTrace) ? headerTrace : uuidv7();
  // Reflect the caller's Origin, as the other functions do; the operator check is the boundary.
  const origin = req.headers.get('Origin') ?? deps.env('APP_BASE_URL') ?? 'https://srtd.io';
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET') return notFound(origin, traceId);

  const supabaseUrl = deps.env('SUPABASE_URL');
  const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  const jwt = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]?.trim() ?? '';
  if (!supabaseUrl || !serviceKey || jwt === '') return notFound(origin, traceId);

  const service = deps.createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Verify the caller's own token, then the operator row, both server side.
  const caller = await service.auth.getUser(jwt);
  const userId = caller.data.user?.id;
  if (caller.error !== null || userId === undefined) return notFound(origin, traceId);
  const operator = await service
    .from('platform_operators')
    .select('user_id')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle();
  if (operator.error !== null || operator.data === null) return notFound(origin, traceId);

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode');
  const now = deps.now ?? (() => new Date());
  const sourceDeps: SourceDeps = {
    env: deps.env,
    fetch: deps.fetch,
    sql: deps.sql,
    rpc: (name, args) => service.rpc(name, args),
    now,
  };
  const ms = deps.timeoutMs;

  if (mode === 'status') {
    const [sentry, functions, bounces, traffic] = await Promise.all([
      settle<SentryData>('Sentry', (s) => fetchSentry(sourceDeps, s), ms),
      settle<Record<string, number>>(
        'Supabase logs',
        (s) => fetchFunctionFailures(sourceDeps, s),
        ms,
      ),
      settle<number>('Database', () => fetchEmailBounces(sourceDeps), ms),
      settle<TrafficData>(
        'Cloudflare',
        (s) => fetchCloudflare(sourceDeps, s, { daily: false, web: false }),
        ms,
      ),
    ]);
    const alerts = buildAlerts({
      sentryNewLastHour: sentry.state === 'ok' ? sentry.data.newLastHour : null,
      functionFailures: functions.state === 'ok' ? functions.data : null,
      bounces24h: bounces.state === 'ok' ? bounces.data : null,
      traffic: traffic.state === 'ok' ? traffic.data : null,
      failed: failedSources([
        { name: 'Sentry', tab: 'errors', source: sentry },
        { name: 'Supabase logs', tab: 'logs', source: functions },
        { name: 'Database', tab: 'email', source: bounces },
        { name: 'Cloudflare', tab: 'traffic', source: traffic },
      ]),
    });
    return json(
      { checked_at: now().toISOString(), level: worstLevel(alerts), alerts },
      origin,
      traceId,
    );
  }

  const tabParam = url.searchParams.get('tab');
  if (mode !== 'full' || !isTab(tabParam)) return json({ error: 'bad_request' }, origin, traceId);
  const tab: Tab = tabParam;
  const logsTab = tab === 'logs';

  // Every source in parallel, each under its own timeout; the access log
  // (opens only) rides alongside and never blocks the answer on failure.
  const accessLog =
    url.searchParams.get('open') === '1'
      ? Promise.resolve(
          service
            .from('cockpit_access_log')
            .insert({
              operator_user_id: userId,
              route: `cockpit/${tab}`,
              session_id: sessionIdOf(jwt),
              trace_id: traceId,
            })
            .then(({ error }) => {
              if (error !== null) {
                console.error(traceId, 'cockpit_access_log insert failed', error.message);
              }
            }),
        ).catch(() => {
          console.error(traceId, 'cockpit_access_log insert failed');
        })
      : Promise.resolve();
  const [sentry, logs, traffic, email, chat, users] = await Promise.all([
    settle<SentryData>('Sentry', (s) => fetchSentry(sourceDeps, s), ms),
    // One log call per request: the Logs tab loads rows, every other tab the failure counts.
    settle<{ failures: Record<string, number>; rows: LogRow[] | null }>(
      'Supabase logs',
      async (s) => {
        if (!logsTab) return { failures: await fetchFunctionFailures(sourceDeps, s), rows: null };
        const rows = await fetchLogRows(sourceDeps, s);
        return { failures: failuresFromRows(rows), rows };
      },
      ms,
    ),
    settle<TrafficData>(
      'Cloudflare',
      (s) => fetchCloudflare(sourceDeps, s, { daily: true, web: tab === 'traffic' }),
      ms,
    ),
    settle<EmailData>('Database', () => fetchEmail(sourceDeps), ms),
    settle<ChatData>('Database', () => fetchChat(sourceDeps), ms),
    settle<UsersData>('Users', () => fetchUsers(sourceDeps), ms),
    accessLog,
  ]);

  const alerts: Alert[] = buildAlerts({
    sentryNewLastHour: sentry.state === 'ok' ? sentry.data.newLastHour : null,
    functionFailures: logs.state === 'ok' ? logs.data.failures : null,
    bounces24h: email.state === 'ok' ? email.data.bounced : null,
    traffic: traffic.state === 'ok' ? traffic.data : null,
    failed: failedSources([
      { name: 'Sentry', tab: 'errors', source: sentry },
      { name: 'Supabase logs', tab: 'logs', source: logs },
      { name: 'Cloudflare', tab: 'traffic', source: traffic },
      { name: 'Database', tab: 'email', source: email },
      { name: 'Database', tab: 'chat', source: chat },
      { name: 'Users', tab: 'users', source: users },
    ]),
  });

  const tiles: CockpitTiles = {
    errors: tile(sentry, (d) => ({
      value: d.unresolved24h,
      level: d.newLastHour > 0 ? 'amber' : 'green',
    })),
    backend: tile(logs, (d) => {
      const counts = Object.values(d.failures);
      return {
        value: counts.reduce((a, b) => a + b, 0),
        level: counts.some((c) => c >= FUNCTION_FAILURES_RED) ? 'red' : 'green',
      };
    }),
    email: tile(email, (d) => ({ value: d.delivered, level: d.bounced > 0 ? 'amber' : 'green' })),
    chat: tile(chat, (d) => ({ value: d.messages, level: d.syncFailed > 0 ? 'amber' : 'green' })),
    traffic: tile(traffic, (d) => ({
      value: (d.daily ?? []).reduce((a, b) => a + b.visitors, 0),
      level: rateLevel(errorRate(d)),
    })),
    users: tile(users, (d) => ({ value: d.active_today, level: 'green' })),
  };

  const data = ((): unknown => {
    switch (tab) {
      case 'needs':
        return null;
      case 'users':
        return users;
      case 'errors':
        return sentry.state === 'ok'
          ? { state: 'ok', data: { issues: sentry.data.issues } }
          : sentry;
      case 'logs':
        return logs.state === 'ok' ? { state: 'ok', data: { rows: logs.data.rows ?? [] } } : logs;
      case 'email':
        return email;
      case 'chat':
        return chat;
      case 'traffic':
        // "Signed up themselves": self sign-ups over the same 7 days, from ops_user_summary.
        return traffic.state === 'ok'
          ? {
              state: 'ok',
              data: {
                ...traffic.data,
                selfSignups7d:
                  users.state === 'ok'
                    ? users.data.daily.slice(-7).reduce((a, b) => a + Number(b.self_signups), 0)
                    : null,
              },
            }
          : traffic;
    }
  })();

  return json(
    { checked_at: now().toISOString(), level: worstLevel(alerts), alerts, tiles, tab, data },
    origin,
    traceId,
  );
}
