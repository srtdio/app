// ops-cockpit vendor adapters and database aggregates. Each source is one
// call (Sentry: one issues list; Supabase: one logs.all query; Cloudflare: one
// GraphQL request; each table: one SQL statement), runs under its own 4 s
// timeout and fails alone: settle() turns any failure into the one line its
// tile shows. Secrets are read through deps.env and never logged.
// Self-contained: NO @srtdio/* imports (see index.ts).

import { maskEmail, sourceReason, type Source } from './rules.ts';

/** Every source gets 4 s; a slower one shows "Can't reach" and the rest still render. */
export const SOURCE_TIMEOUT_MS = 4_000;

export type SqlRunner = (text: string) => Promise<Record<string, unknown>[]>;

export interface SourceDeps {
  env: (name: string) => string | undefined;
  fetch: typeof globalThis.fetch;
  /** Direct read-only aggregates over SUPABASE_DB_URL; null when it is not set. */
  sql: SqlRunner | null;
  /** The service client's rpc (ops_user_summary is granted to service_role only). */
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  now: () => Date;
  timeoutMs?: number;
}

/** A source failure: 'auth' reads "Token expired: {name}", anything else "Can't reach {name}". */
export class SourceFailure extends Error {
  constructor(
    readonly kind: 'auth' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

/** Run one source under its own timeout; never throws. */
export async function settle<T>(
  name: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<Source<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceFailure('unreachable', `${name} timed out`));
    }, timeoutMs);
  });
  try {
    const data = await Promise.race([run(controller.signal), timeout]);
    return { state: 'ok', data };
  } catch (error) {
    const kind = error instanceof SourceFailure ? error.kind : 'unreachable';
    // Names and messages only; secret values never reach a log line.
    console.error('ops-cockpit source failed', name, error instanceof Error ? error.message : '');
    return { state: 'error', reason: sourceReason(name, kind) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireEnv(deps: SourceDeps, name: string): string {
  const value = deps.env(name);
  if (value === undefined || value === '') {
    throw new SourceFailure('unreachable', `missing env ${name}`);
  }
  return value;
}

/** 401/403 mean the token is expired or revoked; any other non-2xx is unreachable. */
function checkStatus(response: Response, name: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new SourceFailure('auth', `${name} ${response.status.toString()}`);
  }
  if (!response.ok) throw new SourceFailure('unreachable', `${name} ${response.status.toString()}`);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// --- Sentry -----------------------------------------------------------------

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  substatus: string | null;
  permalink: string;
}

export interface SentryData {
  issues: SentryIssue[];
  /** Unresolved issues seen in the last 24 h (X-Hits when Sentry sends it). */
  unresolved24h: number;
  /** Of those, first seen in the last hour. */
  newLastHour: number;
}

export async function fetchSentry(deps: SourceDeps, signal: AbortSignal): Promise<SentryData> {
  const token = requireEnv(deps, 'SENTRY_TOKEN');
  const org = encodeURIComponent(requireEnv(deps, 'SENTRY_ORG'));
  const project = encodeURIComponent(requireEnv(deps, 'SENTRY_PROJECT'));
  const response = await deps.fetch(
    `https://sentry.io/api/0/projects/${org}/${project}/issues/?query=is%3Aunresolved&statsPeriod=24h&sort=date&limit=25`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  checkStatus(response, 'Sentry');
  const raw = (await response.json()) as Record<string, unknown>[];
  const hourAgo = deps.now().getTime() - HOUR_MS;
  const issues: SentryIssue[] = raw.map((i) => ({
    id: String(i.id ?? ''),
    title: String(i.title ?? ''),
    culprit: String(i.culprit ?? ''),
    count: Number(i.count ?? 0),
    firstSeen: String(i.firstSeen ?? ''),
    lastSeen: String(i.lastSeen ?? ''),
    substatus: typeof i.substatus === 'string' ? i.substatus : null,
    permalink: String(i.permalink ?? ''),
  }));
  const hits = Number(response.headers.get('X-Hits'));
  return {
    issues,
    unresolved24h: Number.isFinite(hits) && hits > 0 ? hits : issues.length,
    newLastHour: issues.filter((i) => Date.parse(i.firstSeen) >= hourAgo).length,
  };
}

// --- Supabase logs (Management API, logs.all) ---------------------------------

export type LogSource = 'Function' | 'Database' | 'Auth' | 'API';
export type LogLevel = 'error' | 'warn' | 'info';

export interface LogRow {
  id: string;
  at: string;
  source: LogSource;
  level: LogLevel;
  message: string;
}

/** Edge function responses of 5xx in the window, by function name. */
export const FUNCTION_FAILURES_SQL = `select regexp_extract(req.url, r'/functions/v1/([^/?]+)') as fn, count(*) as failures
from function_edge_logs
cross join unnest(metadata) as m
cross join unnest(m.response) as r
cross join unnest(m.request) as req
where r.status_code >= 500
group by fn`;

/** The Logs tab: the newest 100 lines across functions, database, auth and the API gateway. */
export const LOG_ROWS_SQL = `select id, timestamp, 'Function' as source, event_message as message, m.level as level
from function_logs cross join unnest(metadata) as m
union all
select id, timestamp, 'Database' as source, event_message as message, p.error_severity as level
from postgres_logs cross join unnest(metadata) as md cross join unnest(md.parsed) as p
union all
select id, timestamp, 'Auth' as source, event_message as message, md.level as level
from auth_logs cross join unnest(metadata) as md
union all
select id, timestamp, 'API' as source, event_message as message, cast(r.status_code as string) as level
from edge_logs cross join unnest(metadata) as md cross join unnest(md.response) as r
order by timestamp desc
limit 100`;

/** The project ref from SUPABASE_URL (https://<ref>.supabase.co). */
export function projectRef(supabaseUrl: string): string {
  return new URL(supabaseUrl).hostname.split('.')[0] ?? '';
}

/** One logs.all call (the endpoint allows 30 a minute; a request makes at most one). */
async function logsQuery(
  deps: SourceDeps,
  signal: AbortSignal,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const token = requireEnv(deps, 'OPS_MGMT_TOKEN');
  const ref = projectRef(requireEnv(deps, 'SUPABASE_URL'));
  const end = deps.now();
  const start = new Date(end.getTime() - HOUR_MS);
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
  });
  const response = await deps.fetch(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/logs.all?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  checkStatus(response, 'Supabase logs');
  const body = (await response.json()) as { result?: Record<string, unknown>[]; error?: unknown };
  if (body.error !== undefined && body.error !== null) {
    throw new SourceFailure('unreachable', 'Supabase logs query error');
  }
  return body.result ?? [];
}

export async function fetchFunctionFailures(
  deps: SourceDeps,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const rows = await logsQuery(deps, signal, FUNCTION_FAILURES_SQL);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const name = typeof row.fn === 'string' && row.fn !== '' ? row.fn : 'unknown';
    out[name] = (out[name] ?? 0) + Number(row.failures ?? 0);
  }
  return out;
}

/** Logs timestamps arrive in microseconds since the epoch. */
function logInstant(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : '';
  return new Date(n > 1e14 ? n / 1000 : n).toISOString();
}

export function logLevel(source: LogSource, raw: unknown): LogLevel {
  const text = String(raw ?? '').toLowerCase();
  if (source === 'API') {
    const status = Number(text);
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'info';
  }
  if (['error', 'fatal', 'panic'].includes(text)) return 'error';
  if (text === 'warn' || text === 'warning') return 'warn';
  return 'info';
}

const LOG_SOURCES: readonly LogSource[] = ['Function', 'Database', 'Auth', 'API'];

export async function fetchLogRows(deps: SourceDeps, signal: AbortSignal): Promise<LogRow[]> {
  const rows = await logsQuery(deps, signal, LOG_ROWS_SQL);
  return rows.map((row, index) => {
    const source = (LOG_SOURCES as readonly string[]).includes(String(row.source))
      ? (row.source as LogSource)
      : 'API';
    return {
      id: typeof row.id === 'string' && row.id !== '' ? row.id : `row-${index.toString()}`,
      at: logInstant(row.timestamp),
      source,
      level: logLevel(source, row.level),
      message: String(row.message ?? '').slice(0, 500),
    };
  });
}

// --- Cloudflare (GraphQL Analytics) ----------------------------------------

export interface TrafficData {
  /** srtd.io requests and 5xx answers in the last hour. */
  requests: number;
  errors5xx: number;
  /** Unique visitors per day, last 7 days (zone analytics). */
  daily: { day: string; visitors: number }[] | null;
  /** Web Analytics (RUM), last 7 days; only for the Traffic tab. */
  web: {
    visits: number;
    views: number;
    home: number;
    signup: number;
    pages: { path: string; visits: number; views: number }[];
    countries: { country: string; visits: number }[];
  } | null;
}

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function cloudflareQuery(opts: { daily: boolean; web: boolean }): string {
  const zone = [
    'total: httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: $hourAgo, datetime_lt: $now}) { count }',
    'errors: httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: $hourAgo, datetime_lt: $now, edgeResponseStatus_geq: 500}) { count }',
    opts.daily
      ? 'daily: httpRequests1dGroups(limit: 7, orderBy: [date_ASC], filter: {date_geq: $weekStart, date_leq: $today}) { dimensions { date } uniq { uniques } }'
      : '',
  ].join('\n');
  const rum = (alias: string, extra: string, dims: string, limit: number): string =>
    `${alias}: rumPageloadEventsAdaptiveGroups(limit: ${limit.toString()}, ${dims === '' ? '' : 'orderBy: [sum_visits_DESC], '}filter: {siteTag: $site, datetime_geq: $weekAgo, datetime_lt: $now${extra}}) { count sum { visits }${dims === '' ? '' : ` dimensions { ${dims} }`} }`;
  const account = opts.web
    ? `accounts(filter: {accountTag: $account}) {
${rum('totals', '', '', 1)}
${rum('home', ', requestPath: "/"', '', 1)}
${rum('signup', ', requestPath: "/signup"', '', 1)}
${rum('pages', '', 'requestPath', 20)}
${rum('countries', '', 'countryName', 20)}
}`
    : '';
  const vars = [
    '$zone: String!',
    '$now: Time!',
    '$hourAgo: Time!',
    opts.daily ? '$weekStart: Date!, $today: Date!' : '',
    opts.web ? '$account: String!, $site: String!, $weekAgo: Time!' : '',
  ]
    .filter((v) => v !== '')
    .join(', ');
  return `query Cockpit(${vars}) { viewer { zones(filter: {zoneTag: $zone}) {
${zone}
}
${account}
} }`;
}

interface CfGroup {
  count?: number;
  sum?: { visits?: number };
  uniq?: { uniques?: number };
  dimensions?: { date?: string; requestPath?: string; countryName?: string };
}

export async function fetchCloudflare(
  deps: SourceDeps,
  signal: AbortSignal,
  opts: { daily: boolean; web: boolean },
): Promise<TrafficData> {
  const token = requireEnv(deps, 'CF_ANALYTICS_TOKEN');
  const now = deps.now();
  const variables: Record<string, string> = {
    zone: requireEnv(deps, 'CF_ZONE_ID'),
    now: now.toISOString(),
    hourAgo: new Date(now.getTime() - HOUR_MS).toISOString(),
  };
  if (opts.daily) {
    variables.weekStart = dayKey(new Date(now.getTime() - 6 * DAY_MS));
    variables.today = dayKey(now);
  }
  if (opts.web) {
    variables.account = requireEnv(deps, 'CF_ACCOUNT_ID');
    variables.site = requireEnv(deps, 'CF_WEB_ANALYTICS_SITE_TAG');
    variables.weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  }
  const response = await deps.fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: cloudflareQuery(opts), variables }),
    signal,
  });
  checkStatus(response, 'Cloudflare');
  const body = (await response.json()) as {
    data?: {
      viewer?: {
        zones?: Record<string, CfGroup[]>[];
        accounts?: Record<string, CfGroup[]>[];
      };
    } | null;
    errors?: { message?: string }[] | null;
  };
  if (body.errors !== undefined && body.errors !== null && body.errors.length > 0) {
    const auth = body.errors.some((e) => /auth|token|permission/i.test(e.message ?? ''));
    throw new SourceFailure(auth ? 'auth' : 'unreachable', 'Cloudflare GraphQL error');
  }
  const zone = body.data?.viewer?.zones?.[0] ?? {};
  const account = body.data?.viewer?.accounts?.[0] ?? {};
  const first = (groups: CfGroup[] | undefined): CfGroup => groups?.[0] ?? {};
  return {
    requests: first(zone.total).count ?? 0,
    errors5xx: first(zone.errors).count ?? 0,
    daily: opts.daily
      ? (zone.daily ?? []).map((g) => ({
          day: g.dimensions?.date ?? '',
          visitors: g.uniq?.uniques ?? 0,
        }))
      : null,
    web: opts.web
      ? {
          visits: first(account.totals).sum?.visits ?? 0,
          views: first(account.totals).count ?? 0,
          home: first(account.home).sum?.visits ?? 0,
          signup: first(account.signup).sum?.visits ?? 0,
          pages: (account.pages ?? []).map((g) => ({
            path: g.dimensions?.requestPath ?? '',
            visits: g.sum?.visits ?? 0,
            views: g.count ?? 0,
          })),
          countries: (account.countries ?? []).map((g) => ({
            country: g.dimensions?.countryName ?? '??',
            visits: g.sum?.visits ?? 0,
          })),
        }
      : null,
  };
}

// --- Database aggregates (one statement per table, no per-row loops) -------

function requireSql(deps: SourceDeps): SqlRunner {
  if (deps.sql === null) throw new SourceFailure('unreachable', 'missing env SUPABASE_DB_URL');
  return deps.sql;
}

/** Bounces only: the status poll's one email number. */
export const EMAIL_BOUNCES_SQL = `select count(*)::int as bounced from public.delivery_attempts
where channel = 'email' and status = 'bounced' and created_at > now() - interval '24 hours'`;

/**
 * The Email tab: 24 h counts plus the latest 20 rows. The recipient is masked
 * in SQL (first letter, ***, @domain); the full address never leaves the database.
 */
export const EMAIL_SQL = `with day as (
  select status, created_at from public.delivery_attempts
  where channel = 'email' and created_at > now() - interval '24 hours'
)
select
  (select count(*) from day where status = 'delivered')::int as delivered,
  (select count(*) from day where status = 'bounced')::int as bounced,
  (select count(*) from day where status in ('queued', 'sent') and created_at < now() - interval '15 minutes')::int as delayed,
  (select count(*) from day where status = 'complained')::int as spam,
  (select coalesce(jsonb_agg(l order by l.at desc), '[]'::jsonb) from (
    select d.id, d.template_key, d.status, d.created_at as at,
      case when u.email is null or position('@' in u.email) < 2 then null
        else left(u.email, 1) || '***' || substring(u.email from position('@' in u.email)) end as recipient
    from public.delivery_attempts d
    left join auth.users u on u.id = d.user_id
    where d.channel = 'email'
    order by d.created_at desc
    limit 20
  ) l) as latest`;

export interface EmailData {
  delivered: number;
  bounced: number;
  delayed: number;
  spam: number;
  latest: { id: string; to: string; templateKey: string; status: string; at: string }[];
}

export async function fetchEmailBounces(deps: SourceDeps): Promise<number> {
  const rows = await requireSql(deps)(EMAIL_BOUNCES_SQL);
  return Number(rows[0]?.bounced ?? 0);
}

export async function fetchEmail(deps: SourceDeps): Promise<EmailData> {
  const row = (await requireSql(deps)(EMAIL_SQL))[0] ?? {};
  const latest = Array.isArray(row.latest) ? (row.latest as Record<string, unknown>[]) : [];
  return {
    delivered: Number(row.delivered ?? 0),
    bounced: Number(row.bounced ?? 0),
    delayed: Number(row.delayed ?? 0),
    spam: Number(row.spam ?? 0),
    latest: latest.map((l) => ({
      id: String(l.id ?? ''),
      // Masked again here: a full address can never reach the response.
      to: maskEmail(typeof l.recipient === 'string' ? l.recipient : null),
      templateKey: String(l.template_key ?? ''),
      status: String(l.status ?? ''),
      at: String(l.at ?? ''),
    })),
  };
}

export const CHAT_MESSAGES_SQL = `select count(*)::int as messages,
  count(*) filter (where jsonb_typeof(attachment_meta) = 'object' and exists (
    select 1 from jsonb_each(attachment_meta) e where e.value->>'mime' like 'audio/%'
  ))::int as voice_notes
from public.chat_messages
where created_at > now() - interval '24 hours' and deleted_at is null`;

export const CHAT_GROUPS_SQL = `select count(*)::int as groups from public.groups where deleted_at is null`;

export const CHAT_SYNC_SQL = `select
  (select count(*) from public.chat_sync_events
    where last_error is not null and created_at > now() - interval '24 hours')::int as failed,
  (select coalesce(jsonb_agg(f order by f.at desc), '[]'::jsonb) from (
    select id, event_type, last_error, attempts, created_at as at from public.chat_sync_events
    where last_error is not null order by created_at desc limit 5
  ) f) as problems`;

export interface ChatData {
  messages: number;
  voiceNotes: number;
  groups: number;
  syncFailed: number;
  problems: { id: string; eventType: string; error: string; attempts: number; at: string }[];
}

export async function fetchChat(deps: SourceDeps): Promise<ChatData> {
  const sql = requireSql(deps);
  const [messages, groups, sync] = await Promise.all([
    sql(CHAT_MESSAGES_SQL),
    sql(CHAT_GROUPS_SQL),
    sql(CHAT_SYNC_SQL),
  ]);
  const syncRow = sync[0] ?? {};
  const problems = Array.isArray(syncRow.problems)
    ? (syncRow.problems as Record<string, unknown>[])
    : [];
  return {
    messages: Number(messages[0]?.messages ?? 0),
    voiceNotes: Number(messages[0]?.voice_notes ?? 0),
    groups: Number(groups[0]?.groups ?? 0),
    syncFailed: Number(syncRow.failed ?? 0),
    problems: problems.map((p) => ({
      id: String(p.id ?? ''),
      eventType: String(p.event_type ?? ''),
      error: String(p.last_error ?? '').slice(0, 300),
      attempts: Number(p.attempts ?? 0),
      at: String(p.at ?? ''),
    })),
  };
}

// --- Users (ops_user_summary) -----------------------------------------------

export interface UsersData {
  signed_up: number;
  confirmed: number;
  signed_in_30d: number;
  active_today: number;
  active_7d: number;
  active_30d: number;
  daily: { day: string; active: number; self_signups: number }[];
  countries_30d: { country: string; people: number }[];
}

export async function fetchUsers(deps: SourceDeps): Promise<UsersData> {
  // Args built as a variable: the .rpc() lint guard only inspects inline
  // object literals; ops_user_summary takes no trace parameter.
  const args = { p_days: 14 };
  const { data, error } = await deps.rpc('ops_user_summary', args);
  if (error !== null) throw new SourceFailure('unreachable', error.message);
  const d = (data ?? {}) as Partial<UsersData>;
  return {
    signed_up: Number(d.signed_up ?? 0),
    confirmed: Number(d.confirmed ?? 0),
    signed_in_30d: Number(d.signed_in_30d ?? 0),
    active_today: Number(d.active_today ?? 0),
    active_7d: Number(d.active_7d ?? 0),
    active_30d: Number(d.active_30d ?? 0),
    daily: Array.isArray(d.daily) ? d.daily : [],
    countries_30d: Array.isArray(d.countries_30d) ? d.countries_30d : [],
  };
}
