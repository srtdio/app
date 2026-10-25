// A small in-memory PostgREST stand-in for the harness. It answers the read
// shapes the app sends (eq/neq/in/is/lt/lte/gt/gte/like, nested or/and, filters
// on an embed's column (`embed.column`), order,
// limit, single-object Accept, exact counts) from fixture tables. Projection is
// not applied: rows carry their full column set, which supabase-js tolerates.

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Predicate = (row: Row) => boolean;

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function compare(a: unknown, b: string): number {
  if (typeof a === 'number') return a - Number(b);
  const left = String(a);
  // ISO timestamps with offsets compare by instant, not by string.
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(b);
  if (/^\d{4}-\d{2}-\d{2}T/.test(left) && !Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return leftTime - rightTime;
  }
  return left < b ? -1 : left > b ? 1 : 0;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') parts.push(current);
  return parts;
}

// A dotted column filters an embedded resource (`current_version.kind`): rows
// carry their embeds as nested objects, so walk the path. A missing or null
// embed has no value, so the filter drops the row, as an !inner embed does.
function valueAt(row: Row, column: string): unknown {
  if (!column.includes('.')) return row[column];
  let value: unknown = row;
  for (const key of column.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Row)[key];
  }
  return value;
}

function operatorPredicate(column: string, expression: string): Predicate {
  const get = (row: Row): unknown => valueAt(row, column);
  let negate = false;
  let expr = expression;
  if (expr.startsWith('not.')) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  let base: Predicate;
  switch (op) {
    case 'eq':
      base = (row) =>
        get(row) !== null && get(row) !== undefined && compare(get(row), unquote(raw)) === 0;
      break;
    case 'neq':
      base = (row) => get(row) === null || compare(get(row), unquote(raw)) !== 0;
      break;
    case 'lt':
      base = (row) => get(row) != null && compare(get(row), unquote(raw)) < 0;
      break;
    case 'lte':
      base = (row) => get(row) != null && compare(get(row), unquote(raw)) <= 0;
      break;
    case 'gt':
      base = (row) => get(row) != null && compare(get(row), unquote(raw)) > 0;
      break;
    case 'gte':
      base = (row) => get(row) != null && compare(get(row), unquote(raw)) >= 0;
      break;
    case 'is':
      base = (row) => {
        const value = get(row);
        if (raw === 'null') return value === null || value === undefined;
        if (raw === 'true') return value === true;
        if (raw === 'false') return value === false;
        return false;
      };
      break;
    case 'in': {
      const list = splitTopLevel(raw.slice(1, -1)).map(unquote);
      base = (row) => get(row) != null && list.includes(String(get(row)));
      break;
    }
    case 'cs': {
      const list = splitTopLevel(raw.slice(1, -1)).map(unquote);
      base = (row) => {
        const value = get(row);
        return Array.isArray(value) && list.every((item) => value.map(String).includes(item));
      };
      break;
    }
    case 'like':
    case 'ilike': {
      const pattern = new RegExp(
        `^${unquote(raw)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/%/g, '.*')}$`,
        op === 'ilike' ? 'i' : '',
      );
      base = (row) => get(row) != null && pattern.test(String(get(row)));
      break;
    }
    default:
      base = () => true;
  }
  return negate ? (row) => !base(row) : base;
}

function logicalPredicate(kind: 'or' | 'and', body: string): Predicate {
  const parts = splitTopLevel(body).map(termPredicate);
  return kind === 'or' ? (row) => parts.some((p) => p(row)) : (row) => parts.every((p) => p(row));
}

function termPredicate(term: string): Predicate {
  const nested = /^(not\.)?(or|and)\((.*)\)$/.exec(term);
  if (nested) {
    const inner = logicalPredicate(nested[2] as 'or' | 'and', nested[3] ?? '');
    return nested[1] ? (row) => !inner(row) : inner;
  }
  const dot = term.indexOf('.');
  return operatorPredicate(term.slice(0, dot), term.slice(dot + 1));
}

export interface QueryResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/** Answer one PostgREST GET/HEAD against `tables`. */
export function answerRest(
  tables: Tables,
  table: string,
  params: URLSearchParams,
  method: string,
  headers: Record<string, string>,
): QueryResult {
  let rows = [...(tables[table] ?? [])];
  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key)) continue;
    if (key === 'or' || key === 'and') {
      const predicate = logicalPredicate(key, value.slice(1, -1));
      rows = rows.filter(predicate);
      continue;
    }
    rows = rows.filter(operatorPredicate(key, value));
  }
  const order = params.get('order');
  if (order) {
    const keys = order.split(',').map((part) => {
      const [column = '', direction = 'asc'] = part.split('.');
      return { column, desc: direction === 'desc' };
    });
    rows.sort((a, b) => {
      for (const key of keys) {
        const left = a[key.column];
        const right = b[key.column];
        if (left === right) continue;
        if (left == null) return 1;
        if (right == null) return -1;
        const diff = compare(left, String(right));
        if (diff !== 0) return key.desc ? -diff : diff;
      }
      return 0;
    });
  }
  const total = rows.length;
  const offset = Number(params.get('offset') ?? '0');
  const limit = params.get('limit');
  rows = rows.slice(offset, limit === null ? undefined : offset + Number(limit));

  const responseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'content-range': `${rows.length === 0 ? '*' : `${offset}-${offset + rows.length - 1}`}/${total}`,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range',
  };
  if (method === 'HEAD') return { status: 200, headers: responseHeaders, body: '' };
  const accept = headers.accept ?? '';
  if (accept.includes('vnd.pgrst.object')) {
    if (rows.length === 0) {
      return {
        status: 406,
        headers: responseHeaders,
        body: JSON.stringify({ code: 'PGRST116', message: 'no rows', details: null, hint: null }),
      };
    }
    return { status: 200, headers: responseHeaders, body: JSON.stringify(rows[0]) };
  }
  return { status: 200, headers: responseHeaders, body: JSON.stringify(rows) };
}
