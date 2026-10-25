// A tiny in-memory PostgREST fake for the partition-bounded paging tests: it
// really evaluates eq / is / in / gt / gte / lt / lte, the keyset and snooze
// .or() filters, order and limit over seeded rows, and logs every query it
// answers (table + the filters used), so a test can check both that paging
// returns every row exactly once and that each history read carried a lower
// AND an upper created_at bound. Test-only; imported by *.test.ts files.

import type { Client } from '@srtdio/rpc';

export interface FakeRow {
  id: string;
  created_at: string;
  [column: string]: unknown;
}

export interface FakeQuery {
  table: string;
  /** Every filter as "op:column" (e.g. "gte:created_at"), in call order. */
  filters: string[];
  /** The created_at range values: [op, value]. */
  range: Array<[string, string]>;
  order: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
  rows: number;
}

type Predicate = (row: FakeRow) => boolean;

function compare(column: string, a: unknown, b: string): number {
  if (typeof a !== 'string') return Number.NaN;
  if (column.endsWith('_at') || column.endsWith('_until')) {
    return Date.parse(a) - Date.parse(b);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** Split on top-level commas (outside quotes and parentheses). */
function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth += 1;
    else if (!quoted && ch === ')') depth -= 1;
    else if (!quoted && depth === 0 && ch === ',') {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function opPredicate(column: string, op: string, raw: string): Predicate {
  const value = unquote(raw);
  switch (op) {
    case 'eq':
      return (row) => compare(column, row[column], value) === 0;
    case 'neq':
      return (row) => compare(column, row[column], value) !== 0;
    case 'is':
      return (row) => (value === 'null' ? row[column] === null || row[column] === undefined : true);
    case 'gt':
      return (row) => compare(column, row[column], value) > 0;
    case 'gte':
      return (row) => compare(column, row[column], value) >= 0;
    case 'lt':
      return (row) => compare(column, row[column], value) < 0;
    case 'lte':
      return (row) => compare(column, row[column], value) <= 0;
    default:
      throw new Error(`partition-fake: unsupported op ${op}`);
  }
}

function parseTerm(term: string): Predicate {
  if (term.startsWith('and(') && term.endsWith(')')) {
    const all = splitTop(term.slice(4, -1)).map(parseTerm);
    return (row) => all.every((p) => p(row));
  }
  const first = term.indexOf('.');
  const second = term.indexOf('.', first + 1);
  return opPredicate(term.slice(0, first), term.slice(first + 1, second), term.slice(second + 1));
}

function parseOr(expr: string): Predicate {
  const any = splitTop(expr).map(parseTerm);
  return (row) => any.some((p) => p(row));
}

/** A client over `tables`; unseeded tables answer with no rows. rpc answers []. */
export function partitionFake(tables: Record<string, FakeRow[]>): {
  client: Client;
  queries: FakeQuery[];
} {
  const queries: FakeQuery[] = [];
  const from = (table: string) => {
    const predicates: Predicate[] = [];
    const log: FakeQuery = { table, filters: [], range: [], order: [], limit: null, rows: 0 };
    let head = false;
    let single = false;
    const filter = (op: string, column: string, value: unknown): void => {
      log.filters.push(`${op}:${column}`);
      if (column === 'created_at') log.range.push([op, String(value)]);
      if (op === 'is') {
        predicates.push(
          (row) => row[column] === value || (value === null && row[column] === undefined),
        );
      } else {
        predicates.push(opPredicate(column, op, String(value)));
      }
    };
    const builder: Record<string, unknown> = {};
    const self = (): Record<string, unknown> => builder;
    builder.select = (_cols?: string, opts?: { head?: boolean }) => {
      head = opts?.head === true;
      return self();
    };
    for (const op of ['eq', 'is', 'gt', 'gte', 'lt', 'lte']) {
      builder[op] = (column: string, value: unknown) => {
        filter(op, column, value);
        return self();
      };
    }
    builder.in = (column: string, values: readonly unknown[]) => {
      log.filters.push(`in:${column}`);
      predicates.push((row) => values.includes(row[column]));
      return self();
    };
    builder.or = (expr: string) => {
      log.filters.push('or');
      predicates.push(parseOr(expr));
      return self();
    };
    builder.order = (column: string, opts?: { ascending?: boolean }) => {
      log.order.push({ column, ascending: opts?.ascending !== false });
      return self();
    };
    builder.limit = (n: number) => {
      log.limit = n;
      return self();
    };
    // Filters the paging specs never depend on: logged, not evaluated.
    for (const op of ['not', 'like', 'ilike', 'neq', 'contains', 'match', 'filter']) {
      builder[op] = (column?: unknown) => {
        log.filters.push(`${op}:${String(column)}`);
        return self();
      };
    }
    builder.abortSignal = () => self();
    builder.maybeSingle = () => {
      single = true;
      return self();
    };
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const matched = (tables[table] ?? []).filter((row) => predicates.every((p) => p(row)));
      const sorted = [...matched].sort((a, b) => {
        for (const { column, ascending } of log.order) {
          const c = compare(column, a[column], String(b[column]));
          if (c !== 0 && !Number.isNaN(c)) return ascending ? c : -c;
        }
        return 0;
      });
      const rows = log.limit !== null ? sorted.slice(0, log.limit) : sorted;
      log.rows = rows.length;
      queries.push(log);
      const result = head
        ? { data: null, error: null, count: matched.length }
        : single
          ? { data: rows[0] ?? null, error: null }
          : { data: rows, error: null, count: matched.length };
      return Promise.resolve(result).then(resolve, reject);
    };
    return builder;
  };
  const rpc = () => Promise.resolve({ data: [], error: null });
  return { client: { from, rpc } as unknown as Client, queries };
}

/** Whole calendar months (UTC) a [from, to] created_at range touches: the partitions it opens. */
export function monthsTouched(query: FakeQuery): number {
  const lower = query.range.find(([op]) => op === 'gte' || op === 'gt');
  const upper = query.range.find(([op]) => op === 'lt' || op === 'lte');
  if (lower === undefined || upper === undefined) return Number.POSITIVE_INFINITY;
  const a = new Date(lower[1]);
  const b = new Date(upper[1]);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

/** `count` rows spread evenly between `fromIso` and `toIso`, ids zero-padded in time order. */
export function spreadRows(
  count: number,
  fromIso: string,
  toIso: string,
  extra: (i: number) => Record<string, unknown>,
  idPrefix = 'm',
): FakeRow[] {
  const from = Date.parse(fromIso);
  const step = (Date.parse(toIso) - from) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(4, '0')}`,
    created_at: new Date(from + Math.round(step * i)).toISOString(),
    ...extra(i),
  }));
}

/**
 * For canned-result fakes: the created_at range, order and limit one query
 * asked for, so a fake can answer each bounded window (and the paging floor
 * probe) with only the rows that window really holds.
 */
export interface WindowState {
  range: Array<[string, string]>;
  order: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
}

export function newWindowState(): WindowState {
  return { range: [], order: [], limit: null };
}

/** `rows` narrowed to a query's created_at range, sorted and limited as asked. Rows without created_at pass through. */
export function windowed<R extends Record<string, unknown>>(
  rows: readonly R[],
  w: WindowState,
): R[] {
  const inRange = rows.filter((row) => {
    const at = row.created_at;
    if (typeof at !== 'string') return true;
    return w.range.every(([op, value]) =>
      opPredicate('created_at', op, value)(row as unknown as FakeRow),
    );
  });
  const byTime = w.order.find((o) => o.column === 'created_at');
  const sorted =
    byTime === undefined
      ? inRange
      : [...inRange].sort((a, b) => {
          const c = compare('created_at', a.created_at, String(b.created_at));
          return Number.isNaN(c) ? 0 : byTime.ascending ? c : -c;
        });
  return w.limit !== null && byTime !== undefined ? sorted.slice(0, w.limit) : sorted;
}

/** Record one builder call (order / limit / a created_at range op) into a WindowState. */
export function trackWindow(w: WindowState, method: string, args: readonly unknown[]): void {
  const [column, value] = args;
  if (method === 'order' && typeof column === 'string') {
    const ascending = (value as { ascending?: boolean } | undefined)?.ascending !== false;
    w.order.push({ column, ascending });
  } else if (method === 'limit' && typeof column === 'number') {
    w.limit = column;
  } else if (['gt', 'gte', 'lt', 'lte'].includes(method) && column === 'created_at') {
    w.range.push([method, String(value)]);
  }
}
