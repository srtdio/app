import { describe, expect, it } from 'vitest';
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS } from '@/lib/chat/search';
import {
  andOrFilters,
  createServerSearchRunner,
  escapeLike,
  ilikeAnyFilter,
  quotePostgrest,
  serverSearchQuery,
  SERVER_SEARCH_DEBOUNCE_MS,
  SERVER_SEARCH_MIN_CHARS,
  withAbort,
  type ServerSearchState,
} from '@/lib/search/server-search';

describe('serverSearchQuery: the 2-character threshold', () => {
  it('matches the chat search limits', () => {
    expect(SERVER_SEARCH_MIN_CHARS).toBe(SEARCH_MIN_CHARS);
    expect(SERVER_SEARCH_DEBOUNCE_MS).toBe(SEARCH_DEBOUNCE_MS);
    expect(SERVER_SEARCH_DEBOUNCE_MS).toBe(250);
  });

  it('is empty under 2 characters (trimmed) and over 100, else the trimmed query', () => {
    expect(serverSearchQuery('')).toBe('');
    expect(serverSearchQuery(' a ')).toBe('');
    expect(serverSearchQuery(' ab ')).toBe('ab');
    expect(serverSearchQuery('x'.repeat(101))).toBe('');
  });
});

describe('PostgREST helpers', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });

  it('quotes a value, escaping backslash and double quote', () => {
    expect(quotePostgrest('a,b.c(d)')).toBe('"a,b.c(d)"');
    expect(quotePostgrest('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('builds one ILIKE per column, empty under 2 characters', () => {
    expect(ilikeAnyFilter(['title', 'objective'], ' reel ')).toBe(
      'title.ilike."%reel%",objective.ilike."%reel%"',
    );
    expect(ilikeAnyFilter(['title'], 'r')).toBe('');
  });

  it('ANDs two or() lists inside ONE argument; a blank side is left out', () => {
    expect(andOrFilters('a.eq.1,b.eq.2', 'c.eq.3')).toBe('and(or(a.eq.1,b.eq.2),or(c.eq.3))');
    expect(andOrFilters('', 'c.eq.3')).toBe('c.eq.3');
    expect(andOrFilters('a.eq.1', '')).toBe('a.eq.1');
    expect(andOrFilters('', '')).toBe('');
  });

  it('attaches the abort signal when the builder takes one', () => {
    const seen: AbortSignal[] = [];
    const builder = {
      abortSignal(signal: AbortSignal) {
        seen.push(signal);
        return this;
      },
    };
    const signal = new AbortController().signal;
    expect(withAbort(builder, signal)).toBe(builder);
    expect(seen).toEqual([signal]);
    expect(withAbort({ plain: true }, signal)).toEqual({ plain: true });
    expect(withAbort(builder, undefined)).toBe(builder);
    expect(seen).toHaveLength(1);
  });
});

// A small evaluator of PostgREST's logic-tree syntax (or(...), and(...), and
// column.op.value with quoted values), enough to prove what a cursor + search
// filter keeps: the rows matching BOTH, never either alone.
type Row = Record<string, string | null>;
type Node = { op: 'and' | 'or'; kids: Node[] } | { col: string; op: string; value: string };

function parseList(src: string, at: number, end: string): [Node[], number] {
  const kids: Node[] = [];
  let i = at;
  while (i < src.length && src[i] !== end) {
    const [node, next] = parseNode(src, i);
    kids.push(node);
    i = next;
    if (src[i] === ',') i += 1;
  }
  return [kids, i + 1];
}

function parseNode(src: string, at: number): [Node, number] {
  for (const op of ['and', 'or'] as const) {
    if (src.startsWith(`${op}(`, at)) {
      const [kids, next] = parseList(src, at + op.length + 1, ')');
      return [{ op, kids }, next];
    }
  }
  const dot1 = src.indexOf('.', at);
  const dot2 = src.indexOf('.', dot1 + 1);
  const col = src.slice(at, dot1);
  const op = src.slice(dot1 + 1, dot2);
  let i = dot2 + 1;
  let value = '';
  if (src[i] === '"') {
    i += 1;
    while (src[i] !== '"') {
      if (src[i] === '\\') i += 1;
      value += src[i];
      i += 1;
    }
    i += 1;
  } else {
    while (i < src.length && src[i] !== ',' && src[i] !== ')') {
      value += src[i];
      i += 1;
    }
  }
  return [{ col, op, value }, i];
}

function likeRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? '';
    if (ch === '\\') {
      i += 1;
      out += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'is');
}

function holds(node: Node, row: Row): boolean {
  if ('kids' in node) {
    return node.op === 'and'
      ? node.kids.every((kid) => holds(kid, row))
      : node.kids.some((kid) => holds(kid, row));
  }
  const cell = row[node.col] ?? null;
  if (cell === null) return false;
  switch (node.op) {
    case 'lt':
      return cell < node.value;
    case 'eq':
      return cell === node.value;
    case 'ilike':
      return likeRegex(node.value).test(cell);
    default:
      throw new Error(`op ${node.op}`);
  }
}

/** The rows a top-level or=(...) argument keeps. */
function keep(filter: string, rows: Row[]): string[] {
  const [kids] = parseList(filter, 0, '\u0000');
  return rows.filter((row) => kids.some((kid) => holds(kid, row))).map((row) => row.id ?? '');
}

describe('cursor AND search (the one or() argument)', () => {
  const keyset = 'created_at.lt."2026-10-02",and(created_at.eq."2026-10-02",id.lt."m")';
  const rows: Row[] = [
    { id: 'z', created_at: '2026-10-03', title: 'Reel launch', objective: '' },
    { id: 'a', created_at: '2026-10-02', title: 'Reel teaser', objective: '' },
    { id: 'n', created_at: '2026-10-02', title: 'Reel recap', objective: '' },
    { id: 'b', created_at: '2026-10-01', title: 'Carousel', objective: 'a reel cut' },
    { id: 'c', created_at: '2026-10-01', title: 'Story', objective: 'stills' },
  ];
  const search = ilikeAnyFilter(['title', 'objective'], 'reel');

  it('each side alone keeps more than both together', () => {
    expect(keep(keyset, rows)).toEqual(['a', 'b', 'c']);
    expect(keep(search, rows)).toEqual(['z', 'a', 'n', 'b']);
  });

  it('the combined filter keeps only rows after the cursor that also match', () => {
    expect(keep(andOrFilters(keyset, search), rows)).toEqual(['a', 'b']);
  });

  it('a typed % or _ matches literally through the quoting', () => {
    const literal: Row[] = [
      { id: '1', title: '100% off', objective: '' },
      { id: '2', title: '100 days', objective: '' },
      { id: '3', title: 'snake_case', objective: '' },
      { id: '4', title: 'snakeXcase', objective: '' },
    ];
    expect(keep(ilikeAnyFilter(['title', 'objective'], '0%'), literal)).toEqual(['1']);
    expect(keep(ilikeAnyFilter(['title', 'objective'], 'e_c'), literal)).toEqual(['3']);
  });
});

/** Manual timers: the runner's debounce fires only when a test says so. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void): unknown => {
      const id = next++;
      pending.set(id, run);
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    flush: (): void => {
      const runs = [...pending.values()];
      pending.clear();
      runs.forEach((run) => run());
    },
    get size(): number {
      return pending.size;
    },
  };
}

describe('createServerSearchRunner', () => {
  function setup() {
    const timers = manualTimers();
    const calls: { query: string; signal: AbortSignal; resolve: (data: string[]) => void }[] = [];
    const states: ServerSearchState<string[]>[] = [];
    const runner = createServerSearchRunner<string[]>({
      fetch: (query, signal) =>
        new Promise((resolve) => {
          calls.push({ query, signal, resolve: (data) => resolve({ ok: true, data }) });
        }),
      onChange: (state) => states.push(state),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    return { timers, calls, states, runner };
  }

  it('sends nothing under 2 characters', () => {
    const { timers, calls, runner } = setup();
    runner.setQuery('a');
    timers.flush();
    expect(calls).toEqual([]);
    expect(timers.size).toBe(0);
  });

  it('debounces: only the settled query goes out', () => {
    const { timers, calls, runner, states } = setup();
    runner.setQuery('ab');
    runner.setQuery('abc');
    expect(calls).toEqual([]);
    expect(states.at(-1)).toMatchObject({ query: 'abc', status: 'loading' });
    timers.flush();
    expect(calls.map((c) => c.query)).toEqual(['abc']);
  });

  it('a newer query aborts the request in flight and drops its answer', async () => {
    const { timers, calls, runner, states } = setup();
    runner.setQuery('ab');
    timers.flush();
    const first = calls[0]!;
    runner.setQuery('abc');
    expect(first.signal.aborted).toBe(true);
    first.resolve(['old']);
    await Promise.resolve();
    expect(states.some((s) => s.status === 'ready' && s.query === 'ab')).toBe(false);
    timers.flush();
    calls[1]!.resolve(['new']);
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ query: 'abc', status: 'ready', data: ['new'] });
  });

  it('going under 2 characters aborts and turns idle', () => {
    const { timers, calls, runner, states } = setup();
    runner.setQuery('ab');
    timers.flush();
    runner.setQuery('a');
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(states.at(-1)).toEqual({ query: '', status: 'idle', data: null });
  });

  it('refresh asks again now; update edits the answer in place', async () => {
    const { timers, calls, runner, states } = setup();
    runner.setQuery('ab');
    timers.flush();
    calls[0]!.resolve(['x']);
    await Promise.resolve();
    await Promise.resolve();
    runner.update((data) => [...data, 'y']);
    expect(states.at(-1)?.data).toEqual(['x', 'y']);
    runner.refresh();
    timers.flush();
    expect(calls.map((c) => c.query)).toEqual(['ab', 'ab']);
  });

  it('a failure keeps the last answer and turns error; dispose drops everything', async () => {
    const timers = manualTimers();
    const states: ServerSearchState<string[]>[] = [];
    const runner = createServerSearchRunner<string[]>({
      fetch: () => Promise.resolve({ ok: false, error: 'boom' }),
      onChange: (state) => states.push(state),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    runner.setQuery('ab');
    timers.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ query: 'ab', status: 'error', data: null });
    runner.dispose();
    runner.setQuery('abc');
    expect(states.at(-1)?.query).toBe('ab');
  });
});
