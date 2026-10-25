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
// "Now" is never the device clock: it is the server's clock, learned from the
// Date header of Supabase responses the app already makes (noteServerDate
// stores offset = serverDate - Date.now() on each response; the latest wins).
// Until the first response lands, a newest page has no upper bound (its lower
// bound is then only a starting point: a short window still widens back to
// the oldest row, so nothing is hidden whatever the device clock says).
//
// Pure apart from the injected reads and the server clock, so it is
// unit-tested with fakes.

import type { Result } from '@srtdio/rpc';

const DAY_MS = 86_400_000;

/** The first window of every page: 30 days back from the page's newest edge. */
export const HISTORY_WINDOW_MS = 30 * DAY_MS;

/**
 * Upper-bound margin over the server's now: a Date header has one-second
 * resolution (truncated) and is read a network trip after it was stamped, so
 * the server's real now can be a little ahead of the estimate.
 */
export const SERVER_NOW_MARGIN_MS = 60_000;

/** offset = server time - device time, from the latest Supabase response; null before the first. */
let serverOffsetMs: number | null = null;

/**
 * Record the server's clock from one response's Date header (an HTTP-date).
 * `receivedAtMs` is the device time it arrived. A missing or unparsable header
 * leaves the offset as it was. Called on every Supabase response.
 */
export function noteServerDate(
  dateHeader: string | null | undefined,
  receivedAtMs: number = Date.now(),
): void {
  if (dateHeader === null || dateHeader === undefined || dateHeader === '') return;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return;
  serverOffsetMs = serverMs - receivedAtMs;
}

/** The server's now (device now + the latest offset), or null before any response. */
export function serverNowMs(): number | null {
  return serverOffsetMs === null ? null : Date.now() + serverOffsetMs;
}

/** Forget the server clock (tests; a fresh session learns it again on its first response). */
export function resetServerClock(): void {
  serverOffsetMs = null;
}

/** Widening steps before the next window jumps straight to the oldest row. */
export const MAX_WIDEN_STEPS = 12;

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

export interface BoundedPageInput<Row> {
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
 * The newest-page edge: the server's now plus SERVER_NOW_MARGIN_MS, as an ISO
 * string; null while the server clock is unknown (no upper bound then).
 */
export function upperFromNow(): string | null {
  const now = serverNowMs();
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

export interface BoundedForwardInput<Row> {
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
  const ceilingMs = input.nowMs ?? serverNowMs() ?? Date.now();
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
