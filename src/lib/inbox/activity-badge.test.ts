// @vitest-environment jsdom
// The activity badge: one activity_badge_read gives the unread badge and the
// Mentions count; consumers of one refresh share one rpc within the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchActivityBadge,
  mapActivityBadge,
  readActivityBadge,
} from '@/lib/inbox/inbox-reads';
import { POLL_CHANGE_SOURCE } from '@/lib/inbox/inbox-live';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { resetSessionReads } from '@/lib/session-read';

type RpcResult = { data: unknown; error: { message: string } | null };
type Client = Parameters<typeof fetchActivityBadge>[0];

const TRACE = '01920000-0000-7000-8000-000000000001';

// A client whose rpc() records every call and answers from a queue (the last
// answer repeats). Nothing else is reachable: the badge is one rpc, no table read.
function rpcClient(answers: RpcResult[]): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) => {
    const answer = answers[Math.min(i, answers.length - 1)] ?? { data: [], error: null };
    i += 1;
    return Promise.resolve(answer);
  });
  return { client: { rpc } as unknown as Client, rpc };
}

const ok = (unread: number, mentions: number): RpcResult => ({
  data: [{ unread, mentions }],
  error: null,
});

/** Let the queued microtasks run (the end of the current task). */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetSessionReads());
afterEach(() => resetSessionReads());

describe('mapActivityBadge', () => {
  it('maps the one row to both counts', () => {
    expect(mapActivityBadge([{ unread: 7, mentions: 2 }])).toEqual({ unread: 7, mentions: 2 });
  });

  it('reads an empty answer as zero for both', () => {
    expect(mapActivityBadge([])).toEqual({ unread: 0, mentions: 0 });
    expect(mapActivityBadge(null)).toEqual({ unread: 0, mentions: 0 });
  });

  it('reads a missing or bad field as zero', () => {
    expect(mapActivityBadge([{ unread: 4 }])).toEqual({ unread: 4, mentions: 0 });
    expect(mapActivityBadge([{ unread: 'x', mentions: -1 }])).toEqual({ unread: 0, mentions: 0 });
  });
});

describe('fetchActivityBadge', () => {
  it('is one activity_badge_read rpc with the explicit trace id and no user id', async () => {
    const { client, rpc } = rpcClient([ok(5, 1)]);
    const res = await fetchActivityBadge(client, { workspaceId: 'w1', traceId: TRACE });
    expect(res).toEqual({ ok: true, data: { unread: 5, mentions: 1 } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('activity_badge_read', {
      p_trace_id: TRACE,
      p_workspace_id: 'w1',
    });
  });

  it('fails as a Result on an rpc error (never throws)', async () => {
    const { client } = rpcClient([{ data: null, error: { message: 'boom' } }]);
    const res = await fetchActivityBadge(client, { workspaceId: 'w1', traceId: TRACE });
    expect(res.ok).toBe(false);
  });

  it('fails as a Result when the transport rejects', async () => {
    const rpc = vi.fn(() => Promise.reject(new Error('down')));
    const client = { rpc } as unknown as Client;
    const res = await fetchActivityBadge(client, { workspaceId: 'w1', traceId: TRACE });
    expect(res.ok).toBe(false);
  });
});

describe('readActivityBadge: one request per refresh, shared within the session', () => {
  const base = { userId: 'u1', workspaceId: 'w1', traceId: TRACE };

  it('two consumers of the same refresh (the shell badge and the Mentions count) cost one rpc', async () => {
    const { client, rpc } = rpcClient([ok(9, 3)]);
    const shell = readActivityBadge(client, { ...base, refresh: true });
    const page = readActivityBadge(client, { ...base, refresh: true });
    const [a, b] = await Promise.all([shell, page]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ok: true, data: { unread: 9, mentions: 3 } });
    expect(b).toEqual(a);
  });

  it("a write's refresh and the change event it dispatches are one rpc", async () => {
    const { client, rpc } = rpcClient([ok(1, 0)]);
    void readActivityBadge(client, { ...base, refresh: true });
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    await readActivityBadge(client, { ...base, refresh: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a join takes the fresh settled read without a request', async () => {
    const { client, rpc } = rpcClient([ok(2, 1)]);
    await readActivityBadge(client, { ...base, refresh: true });
    const joined = await readActivityBadge(client, { ...base, refresh: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(joined).toEqual({ ok: true, data: { unread: 2, mentions: 1 } });
  });

  it("the shell poll's own change event keeps the tick's read for joiners", async () => {
    const { client, rpc } = rpcClient([ok(2, 1)]);
    await readActivityBadge(client, { ...base, refresh: true });
    await nextTask();
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT, { detail: POLL_CHANGE_SOURCE }));
    await readActivityBadge(client, { ...base, refresh: false });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a later refresh reads anew', async () => {
    const { client, rpc } = rpcClient([ok(2, 1), ok(4, 2)]);
    await readActivityBadge(client, { ...base, refresh: true });
    await nextTask();
    const res = await readActivityBadge(client, { ...base, refresh: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ ok: true, data: { unread: 4, mentions: 2 } });
  });

  it('an inbox change drops the held read, so the next join reads anew', async () => {
    const { client, rpc } = rpcClient([ok(2, 1), ok(0, 0)]);
    await readActivityBadge(client, { ...base, refresh: true });
    await nextTask();
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    const res = await readActivityBadge(client, { ...base, refresh: false });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ ok: true, data: { unread: 0, mentions: 0 } });
  });

  it('a failed read is never kept: the next join retries', async () => {
    const { client, rpc } = rpcClient([{ data: null, error: { message: 'boom' } }, ok(3, 0)]);
    const first = await readActivityBadge(client, { ...base, refresh: false });
    expect(first.ok).toBe(false);
    const second = await readActivityBadge(client, { ...base, refresh: false });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ ok: true, data: { unread: 3, mentions: 0 } });
  });

  it('keys per user and workspace: another workspace is its own read', async () => {
    const { client, rpc } = rpcClient([ok(1, 1)]);
    await readActivityBadge(client, { ...base, refresh: false });
    await readActivityBadge(client, { ...base, workspaceId: 'w2', refresh: false });
    await readActivityBadge(client, { ...base, userId: 'u2', refresh: false });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
