import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  BRIEF_COUNT_FILTERS,
  briefTitlePattern,
  countBriefs,
  countBriefsByFilter,
  escapeLikePattern,
} from '@/lib/brief-counts';

interface Call {
  method: string;
  args: unknown[];
}

interface CountReply {
  count: number | null;
  error: { message: string } | null;
}

// A chainable stand-in for the supabase query builder: every from() starts one
// recorded query; awaiting it resolves to the reply chosen for that query.
function makeClient(reply: (calls: Call[]) => CountReply = () => ({ count: 0, error: null })) {
  const queries: Call[][] = [];
  const from = (table: string) => {
    const calls: Call[] = [{ method: 'from', args: [table] }];
    queries.push(calls);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'is', 'eq', 'ilike']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (resolve: (value: CountReply) => unknown) =>
      Promise.resolve(reply(calls)).then(resolve);
    return builder;
  };
  return { client: { from } as unknown as Client, queries };
}

const statusOf = (calls: Call[]): unknown =>
  calls.find((c) => c.method === 'eq' && c.args[0] === 'status')?.args[1];

describe('escapeLikePattern / briefTitlePattern', () => {
  it('escapes backslash, percent and underscore so they match literally', () => {
    expect(escapeLikePattern('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });

  it('wraps the trimmed query as a substring; blank is no filter', () => {
    expect(briefTitlePattern('  Launch ')).toBe('%Launch%');
    expect(briefTitlePattern('   ')).toBeNull();
    expect(briefTitlePattern('')).toBeNull();
  });
});

describe('countBriefs', () => {
  it('is one HEAD exact count over live briefs of the workspace', async () => {
    const { client, queries } = makeClient(() => ({ count: 7, error: null }));
    const result = await countBriefs(client, 'w1', 'all', '');
    expect(result).toEqual({ ok: true, data: 7 });
    expect(queries).toHaveLength(1);
    const calls = queries[0] ?? [];
    expect(calls).toContainEqual({ method: 'from', args: ['briefs'] });
    expect(calls).toContainEqual({
      method: 'select',
      args: ['id', { count: 'exact', head: true }],
    });
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', 'w1'] });
    expect(statusOf(calls)).toBeUndefined();
    expect(calls.some((c) => c.method === 'ilike')).toBe(false);
  });

  it('adds the chip status and the escaped title search', async () => {
    const { client, queries } = makeClient();
    await countBriefs(client, 'w1', 'closed', ' 100%_ ');
    const calls = queries[0] ?? [];
    expect(statusOf(calls)).toBe('closed');
    expect(calls).toContainEqual({ method: 'ilike', args: ['title', '%100\\%\\_%'] });
  });

  it('reads a null count as 0', async () => {
    const { client } = makeClient(() => ({ count: null, error: null }));
    expect(await countBriefs(client, 'w1', 'open', '')).toEqual({ ok: true, data: 0 });
  });

  it('returns an error result on a read error or a thrown client', async () => {
    const { client } = makeClient(() => ({ count: null, error: { message: 'boom' } }));
    expect((await countBriefs(client, 'w1', 'open', '')).ok).toBe(false);
    const broken = {} as unknown as Client;
    expect((await countBriefs(broken, 'w1', 'open', '')).ok).toBe(false);
  });
});

describe('countBriefsByFilter', () => {
  it('reads every chip in parallel, one count each, with the same base filters', async () => {
    const totals: Record<string, number> = { all: 250, open: 200, closed: 50 };
    const { client, queries } = makeClient((calls) => {
      const status = statusOf(calls);
      return { count: totals[typeof status === 'string' ? status : 'all'] ?? 0, error: null };
    });
    const result = await countBriefsByFilter(client, 'w1', 'reel');
    expect(result).toEqual({ ok: true, data: { all: 250, open: 200, closed: 50 } });
    expect(queries).toHaveLength(BRIEF_COUNT_FILTERS.length);
    for (const calls of queries) {
      expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
      expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', 'w1'] });
      expect(calls).toContainEqual({ method: 'ilike', args: ['title', '%reel%'] });
    }
    expect(queries.map(statusOf)).toEqual([undefined, 'open', 'closed']);
  });

  it('fails the whole set when any one count fails', async () => {
    const { client } = makeClient((calls) =>
      statusOf(calls) === 'closed'
        ? { count: null, error: { message: 'boom' } }
        : { count: 3, error: null },
    );
    const result = await countBriefsByFilter(client, 'w1', '');
    expect(result.ok).toBe(false);
  });

  it('starts all three reads before any resolves', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const from = () => {
      started += 1;
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'is', 'eq', 'ilike']) builder[method] = () => builder;
      builder.then = (resolve: (value: CountReply) => unknown) =>
        gate.then(() => resolve({ count: 1, error: null }));
      return builder;
    };
    const pending = countBriefsByFilter({ from } as unknown as Client, 'w1', '');
    await Promise.resolve();
    expect(started).toBe(3);
    release();
    expect(await pending).toEqual({ ok: true, data: { all: 1, open: 1, closed: 1 } });
  });
});
