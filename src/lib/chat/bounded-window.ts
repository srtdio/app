// Partition-bounded paging for the two monthly RANGE (created_at) partitioned
// tables: public.chat_messages and public.inbox_entries. A list query with only
// a keyset cursor (or none) makes Postgres open every partition (32 months plus
// the default); one with a lower AND an upper created_at bound opens only the
// months the window covers. So every list page here is read as a sequence of
// bounded windows walking back from the page's newest edge:
//
//   1. [edge - 30 days, edge] (the edge is the cursor, or the SERVER's now
//      for the newest page), limit = page size.
//   2. A short window widens backwards: the next window is the span just
//      before it, twice as long, limit = what the page still needs. Windows
//      are disjoint ([from, to) after the first), so no row is read twice.
//   3. The source's oldest created_at is read once (cheap: an ordered LIMIT 1,
//      one index probe per partition), the first time a window comes back
//      short, and cached. A window reaching the oldest row ends the page, so
//      the loop always terminates and never hides an older row: scrolling
//      back always reaches the first message or inbox entry.
//
// Upper bounds use ceilingNowMs(): the later of the device clock and the
// server's clock. The server's clock is learned from the
// iat claim of each freshly issued access token (noteAuthToken, called from the
// one auth subscription on SIGNED_IN and TOKEN_REFRESHED, stores offset =
// iat*1000 - Date.now() at receipt; the latest wins). A token read back from
// storage (INITIAL_SESSION, or a SIGNED_IN replaying it after one) is skipped:
// its iat can be up to an hour old. One can still slip through (a SIGNED_IN
// replay before INITIAL_SESSION, another tab's older token), so the estimate
// can run low; the max() with the device clock keeps that from hiding rows.
// Until the first fresh token lands, a newest page
// has no upper bound (its lower bound is then only a starting point: a short
// window still widens back to the oldest row, so nothing is hidden whatever
// the device clock says).
//
// Pure apart from the injected reads and the server clock, so it is
// unit-tested with fakes.

import type { Result } from '@srtdio/rpc';

const DAY_MS = 86_400_000;

/** The first window of every page: 30 days back from the page's newest edge. */
export const HISTORY_WINDOW_MS = 30 * DAY_MS;

/**
 * Upper-bound margin over the server's now: iat has one-second resolution
 * (truncated) and the token is read a network trip after it was issued, so the
 * server's real now can be a little ahead of the estimate.
 */
export const SERVER_NOW_MARGIN_MS = 60_000;

/** offset = server time - device time, from the latest fresh access token; null before the first. */
let serverOffsetMs: number | null = null;
/** The newest iat seen on any token, fresh or stored: a token at or below it is not fresh. */
let newestIat: number | null = null;

/** Auth events that carry a token the server has just issued. */
const FRESH_TOKEN_EVENTS: ReadonlySet<string> = new Set(['SIGNED_IN', 'TOKEN_REFRESHED']);

/** The iat claim (seconds) of a JWT, or null when the token is missing or unreadable. */
function tokenIat(accessToken: string | null | undefined): number | null {
  const payload = accessToken?.split('.')[1];
  if (payload === undefined || payload === '') return null;
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims !== 'object' || claims === null || !('iat' in claims)) return null;
    const iat = claims.iat;
    return typeof iat === 'number' && Number.isFinite(iat) ? iat : null;
  } catch {
    return null;
  }
}

/**
 * Record the server's clock from one auth event's access token. Only a
 * freshly issued token (SIGNED_IN, TOKEN_REFRESHED, newer than any token seen
 * before) sets the offset; INITIAL_SESSION and a stored token replayed under
 * SIGNED_IN only mark their iat as seen. `receivedAtMs` is the device time
 * the event arrived.
 */
export function noteAuthToken(
  event: string,
  accessToken: string | null | undefined,
  receivedAtMs: number = Date.now(),
): void {
  const iat = tokenIat(accessToken);
  if (iat === null) return;
  const fresh = FRESH_TOKEN_EVENTS.has(event) && (newestIat === null || iat > newestIat);
  if (newestIat === null || iat > newestIat) newestIat = iat;
  if (fresh) serverOffsetMs = iat * 1000 - receivedAtMs;
}

/** The server's now (device now + the latest offset), or null before the first fresh token. */
export function serverNowMs(): number | null {
  return serverOffsetMs === null ? null : Date.now() + serverOffsetMs;
}

/**
 * The "now" every upper bound is built from: the later of the device clock and
 * the server estimate, or null before the first fresh token (no upper bound).
 * A server estimate that is wrong low (a stored token taken as fresh: a
 * SIGNED_IN replaying it before INITIAL_SESSION, or another tab's older token)
 * can never pull a ceiling below the device clock, and a slow device is still
 * lifted by a fresh token, so rows hide only if both clocks are low at once.
 */
export function ceilingNowMs(): number | null {
  const server = serverNowMs();
  return server === null ? null : Math.max(Date.now(), server);
}

/** Forget the server clock (tests; a fresh session learns it again from its first fresh token). */
export function resetServerClock(): void {
  serverOffsetMs = null;
  newestIat = null;
}

/** Widening steps before the next window jumps straight to the oldest row. */
const MAX_WIDEN_STEPS = 12;

/**
 * One window's created_at bounds: `from` is inclusive (gte); `to` is
 * inclusive (lte) on a page's first window when it is a cursor, exclusive (lt)
 * otherwise; null on a newest page before the server clock is known, on the
 * last forward window, and on the fallback re-read (see readBoundedPage).
 */
export interface TimeBounds {
  from: string;
  to: string | null;
  toInclusive: boolean;
}

interface BoundedPageInput<Row> {
  /** Rows a full page holds. */
  pageSize: number;
  /**
   * The page's newest edge: the cursor's created_at, or upperFromNow() (null
   * before the server clock is known: the first window then has no upper bound).
   */
  upper: string | null;
  /** True when `upper` is a cursor (the keyset or-filter then excludes the cursor row itself). */
  upperInclusive: boolean;
  /** One bounded window, newest first, at most `limit` rows. */
  read: (bounds: TimeBounds, limit: number) => Promise<Result<Row[]>>;
  /** The source's oldest created_at (null when it has no rows). Called at most once. */
  oldest: () => Promise<Result<string | null>>;
  /**
   * When the edge is a clock (the newest page), a window that finds nothing
   * although the oldest row is newer than the edge (a slow device clock)
   * re-reads from the oldest row with no upper bound, so nothing is hidden.
   */
  openEnded?: boolean;
  /** First window length (default 30 days). */
  windowMs?: number;
}

/**
 * The newest-page edge: ceilingNowMs() (the later of device and server now)
 * plus SERVER_NOW_MARGIN_MS, as an ISO string; null while the server clock is
 * unknown (no upper bound then).
 */
export function upperFromNow(): string | null {
  const now = ceilingNowMs();
  return now === null ? null : new Date(now + SERVER_NOW_MARGIN_MS).toISOString();
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Read one newest-first page through bounded windows (see the file comment).
 * Rows come back newest first, at most `pageSize`, in exactly the order one
 * unbounded ORDER BY created_at DESC, id DESC LIMIT pageSize read would give.
 * The first failed read fails the page. Never throws on its own.
 */
export async function readBoundedPage<Row>(input: BoundedPageInput<Row>): Promise<Result<Row[]>> {
  const rows: Row[] = [];
  // No known server clock: the first window is open above and starts its
  // lower bound from the device clock (a starting point only, see above).
  const upperMs = input.upper !== null ? Date.parse(input.upper) : Date.now();
  if (Number.isNaN(upperMs)) {
    return { ok: false, error: { code: 'unknown', message: 'readBoundedPage: bad upper bound' } };
  }
  let to: string | null = input.upper;
  let toMs = upperMs;
  let toInclusive = input.upperInclusive;
  let span = input.windowMs ?? HISTORY_WINDOW_MS;
  let oldest: { iso: string; ms: number } | null | undefined;
  for (let step = 0; ; step += 1) {
    let from = isoAt(toMs - span);
    let reachesOldest = false;
    if (oldest !== undefined && oldest !== null && toMs - span <= oldest.ms) {
      from = oldest.iso;
      reachesOldest = true;
    }
    const res = await input.read({ from, to, toInclusive }, input.pageSize - rows.length);
    if (!res.ok) return res;
    rows.push(...res.data);
    if (rows.length >= input.pageSize || reachesOldest) break;
    if (oldest === undefined) {
      const found = await input.oldest();
      if (!found.ok) return found;
      const ms = found.data === null ? Number.NaN : Date.parse(found.data);
      oldest = found.data === null || Number.isNaN(ms) ? null : { iso: found.data, ms };
    }
    // Nothing at all, or this window already started at or before the oldest row.
    if (oldest === null || oldest.ms >= toMs - span) break;
    to = from;
    toMs -= span;
    toInclusive = false;
    span = step + 1 >= MAX_WIDEN_STEPS ? Math.max(toMs - oldest.ms, 1) : span * 2;
  }
  if (
    rows.length === 0 &&
    input.openEnded === true &&
    input.upper !== null &&
    oldest != null &&
    oldest.ms > upperMs
  ) {
    return input.read({ from: oldest.iso, to: null, toInclusive: false }, input.pageSize);
  }
  return { ok: true, data: rows };
}

interface BoundedForwardInput<Row> {
  pageSize: number;
  /** The page's oldest edge (inclusive): the cursor's created_at, or the source's oldest row. */
  lower: string;
  /** One bounded window, oldest first, at most `limit` rows. */
  read: (bounds: TimeBounds, limit: number) => Promise<Result<Row[]>>;
  windowMs?: number;
  nowMs?: number;
}

/**
 * The oldest-first mirror of readBoundedPage: windows walk forward from
 * `lower`, doubling, until the page is full or a window reaches the server's
 * now (the device's until the server clock is known); that last window has no
 * upper bound, so a clock estimate never cuts a row. `from` here is the window's lower
 * edge: inclusive on the first window, and each later window starts where the
 * previous one ended (`to` exclusive there, `from` inclusive here), so windows
 * are disjoint.
 */
export async function readBoundedForward<Row>(
  input: BoundedForwardInput<Row>,
): Promise<Result<Row[]>> {
  const rows: Row[] = [];
  let fromMs = Date.parse(input.lower);
  if (Number.isNaN(fromMs)) {
    return {
      ok: false,
      error: { code: 'unknown', message: 'readBoundedForward: bad lower bound' },
    };
  }
  const ceilingMs = input.nowMs ?? ceilingNowMs() ?? Date.now();
  let from = input.lower;
  let span = input.windowMs ?? HISTORY_WINDOW_MS;
  for (;;) {
    const last = fromMs + span >= ceilingMs;
    const to = last ? null : isoAt(fromMs + span);
    const res = await input.read({ from, to, toInclusive: false }, input.pageSize - rows.length);
    if (!res.ok) return res;
    rows.push(...res.data);
    if (rows.length >= input.pageSize || to === null) return { ok: true, data: rows };
    from = to;
    fromMs += span;
    span *= 2;
  }
}

/**
 * A per-source cache of the oldest created_at (chat channel, inbox owner).
 * Only a found value is kept: the oldest row of a source never gets newer
 * (deletes keep the row as a tombstone), while an empty source can gain rows.
 */
export class OldestCache<K> {
  private readonly values = new Map<K, string>();

  get(key: K): string | undefined {
    return this.values.get(key);
  }

  async read(key: K, load: () => Promise<Result<string | null>>): Promise<Result<string | null>> {
    const hit = this.values.get(key);
    if (hit !== undefined) return { ok: true, data: hit };
    const res = await load();
    if (res.ok && res.data !== null) this.values.set(key, res.data);
    return res;
  }

  clear(): void {
    this.values.clear();
  }
}
