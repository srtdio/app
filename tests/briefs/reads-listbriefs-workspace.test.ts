// W5 FT25: listBriefs filters by workspace_id on the server (RLS alone spans
// every workspace the caller belongs to) and pages with limit/offset. Pure
// unit, not gated on BRIEFS_SUITE.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/briefs/src/index';
import { listBriefs } from '../../packages/briefs/src/index';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

function makeClient() {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    calls.push({ table, method: 'from', args: [table] });
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'like', 'order', 'range']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, calls };
}

const briefCalls = (calls: Call[], method: string) =>
  calls.filter((c) => c.table === 'briefs' && c.method === method);

describe('listBriefs workspace filter', () => {
  it('adds eq(workspace_id) when a workspace is given', async () => {
    const { client, calls } = makeClient();
    await listBriefs(client, { workspaceId: 'w1' });
    expect(briefCalls(calls, 'eq')).toContainEqual({
      table: 'briefs',
      method: 'eq',
      args: ['workspace_id', 'w1'],
    });
  });

  it('adds no workspace filter when none is given (existing callers unchanged)', async () => {
    const { client, calls } = makeClient();
    await listBriefs(client);
    expect(briefCalls(calls, 'eq').some((c) => c.args[0] === 'workspace_id')).toBe(false);
  });

  it('pages with limit and offset', async () => {
    const { client, calls } = makeClient();
    await listBriefs(client, { workspaceId: 'w1', limit: 50, offset: 100 });
    expect(briefCalls(calls, 'range')).toEqual([
      { table: 'briefs', method: 'range', args: [100, 149] },
    ]);
  });
});
