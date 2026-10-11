import { describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';
import {
  createRoundRunner,
  fetchStatusRound,
  mergeStatusRound,
  type OpenBriefRow,
  type StatusReads,
} from '@/lib/chat/use-status-counts';

const client = {} as Client;
const brief = (id: string): OpenBriefRow => ({
  id,
  number: 1,
  title: id,
  created_at: '2026-10-01T00:00:00Z',
});
const ok = <T>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data });
const bad = <T>(): Promise<Result<T>> =>
  Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } });

describe('fetchStatusRound', () => {
  it('runs the three reads once each; a failed read is null', async () => {
    const reads: StatusReads = {
      planIds: vi.fn(() => ok(['p1'])),
      briefs: vi.fn(() => bad<OpenBriefRow[]>()),
      briefCount: vi.fn(() => ok(3)),
    };
    const round = await fetchStatusRound(client, { workspaceId: 'w', channelId: 'c' }, reads);
    expect(round).toEqual({ planIds: ['p1'], briefs: null, briefCount: 3 });
    expect(reads.planIds).toHaveBeenCalledTimes(1);
    expect(reads.briefs).toHaveBeenCalledTimes(1);
    expect(reads.briefCount).toHaveBeenCalledTimes(1);
  });

  it('no channel: no plan read', async () => {
    const reads: StatusReads = {
      planIds: vi.fn(() => ok(['p1'])),
      briefs: vi.fn(() => ok([brief('b')])),
      briefCount: vi.fn(() => ok(1)),
    };
    const round = await fetchStatusRound(client, { workspaceId: 'w', channelId: null }, reads);
    expect(round.planIds).toEqual([]);
    expect(reads.planIds).not.toHaveBeenCalled();
  });
});

describe('mergeStatusRound', () => {
  it('a failed read keeps what was shown; with nothing before it stays failed', () => {
    const first = mergeStatusRound(null, { planIds: null, briefs: null, briefCount: 2 });
    expect(first).toEqual({ planIds: null, briefs: null, briefCount: null });
    const good = mergeStatusRound(first, {
      planIds: ['a'],
      briefs: [brief('b')],
      briefCount: 4,
    });
    expect(good).toEqual({ planIds: ['a'], briefs: [brief('b')], briefCount: 4 });
    expect(mergeStatusRound(good, { planIds: null, briefs: null, briefCount: null })).toEqual(good);
  });

  it('a failed count falls back to the rows', () => {
    expect(
      mergeStatusRound(null, { planIds: [], briefs: [brief('a'), brief('b')], briefCount: null })
        .briefCount,
    ).toBe(2);
  });
});

describe('createRoundRunner', () => {
  it('single-flight: a request mid-round runs exactly one more for the latest key', async () => {
    const resolvers: Array<() => void> = [];
    const fetch = vi.fn(
      (key: string) =>
        new Promise<string>((resolve) => {
          resolvers.push(() => resolve(key));
        }),
    );
    const settled: string[] = [];
    const runner = createRoundRunner<string, string>({
      fetch,
      onSettle: (_k, data) => settled.push(data),
      now: () => 0,
    });
    runner.request('a');
    runner.request('a');
    runner.request('a');
    expect(fetch).toHaveBeenCalledTimes(1);
    resolvers[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual(['a', 'a']);
    runner.dispose();
  });
});
