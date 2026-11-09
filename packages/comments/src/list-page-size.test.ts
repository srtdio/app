// listComments pages by the caller's pageSize (the comment panel passes the
// screen's fill count); PAGE_SIZE stays the default for every other caller.
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { listComments, PAGE_SIZE } from './index';

function rangeClient(): { client: Client; ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'is', 'not', 'order']) chain[m] = () => chain;
  chain.range = (from: number, to: number) => {
    ranges.push([from, to]);
    return Promise.resolve({ data: [], error: null });
  };
  return { client: chain as unknown as Client, ranges };
}

const INPUT = { workspace_id: 'w1', entity_type: 'post' as const, entity_id: 'p1' };

describe('listComments page size', () => {
  it('defaults to PAGE_SIZE rows a page', async () => {
    const { client, ranges } = rangeClient();
    await listComments(client, { ...INPUT, page: 1 });
    expect(ranges).toEqual([[PAGE_SIZE, PAGE_SIZE * 2 - 1]]);
  });

  it('takes the caller page size (one screen) for page and range', async () => {
    const { client, ranges } = rangeClient();
    await listComments(client, { ...INPUT, page: 0, pageSize: 13 });
    await listComments(client, { ...INPUT, page: 2, pageSize: 13 });
    expect(ranges).toEqual([
      [0, 12],
      [26, 38],
    ]);
  });
});
