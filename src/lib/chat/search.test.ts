import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  createSearchRunner,
  matchRuns,
  nextCursor,
  queryWords,
  searchArgs,
  searchCounterText,
  searchDateLabel,
  searchMessages,
  searchQueryReady,
  searchSenderPrefix,
  snippetText,
  stepSearchIndex,
  SEARCH_PAGE_SIZE,
  type SearchPageFetch,
  type SearchResult,
} from '@/lib/chat/search';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function row(id: string, createdAt: string, body = 'shoot day') {
  return {
    id,
    channel_id: 'c1',
    sender_user_id: 'u2',
    body,
    created_at: createdAt,
  };
}

/** A Supabase client fake that records each rpc call and answers with `rows`. */
function fakeClient(rows: ReturnType<typeof row>[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const answer = Promise.resolve({ data: rows, error: null });
      return { abortSignal: () => answer, then: answer.then.bind(answer) };
    },
  } as unknown as Client;
  return { client, calls };
}

describe('searchMessages (chat_message_search wrapper)', () => {
  it('sends named args and a fresh uuid_v7 p_trace_id per call', async () => {
    const { client, calls } = fakeClient([]);
    const signal = new AbortController().signal;
    await searchMessages({ client, workspaceId: 'w1', query: '  shoot ', signal });
    await searchMessages({ client, workspaceId: 'w1', query: 'shoot', signal, channelId: 'c9' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.fn).toBe('chat_message_search');
    expect(calls[0]?.args).toMatchObject({
      p_workspace_id: 'w1',
      p_query: 'shoot',
      p_limit: SEARCH_PAGE_SIZE,
    });
    expect(calls[0]?.args).not.toHaveProperty('p_channel_id');
    expect(calls[1]?.args).toMatchObject({ p_channel_id: 'c9' });
    const t0 = String(calls[0]?.args.p_trace_id);
    const t1 = String(calls[1]?.args.p_trace_id);
    expect(t0).toMatch(UUID_V7);
    expect(t1).toMatch(UUID_V7);
    expect(t0).not.toBe(t1);
    // Every key is a parameter name: never a positional array.
    for (const call of calls) {
      expect(Array.isArray(call.args)).toBe(false);
      for (const key of Object.keys(call.args)) expect(key.startsWith('p_')).toBe(true);
    }
  });

  it('builds the keyset cursor from the last row of a full page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(`m${i}`, `2026-10-0${3 - i}T10:00:00Z`));
    const { client } = fakeClient(rows);
    const res = await searchMessages({
      client,
      workspaceId: 'w1',
      query: 'sho',
      limit: 3,
      signal: new AbortController().signal,
    });
    expect(res.ok && res.data.next).toEqual({ createdAt: '2026-10-01T10:00:00Z', id: 'm2' });
    expect(nextCursor([{ id: 'a', createdAt: 'x' }], 30)).toBeNull();
    expect(
      searchArgs({
        workspaceId: 'w1',
        query: 'sho',
        traceId: 't',
        before: { createdAt: '2026-10-01T10:00:00Z', id: 'm2' },
      }),
    ).toMatchObject({ p_before_created_at: '2026-10-01T10:00:00Z', p_before_id: 'm2' });
  });

  it('reports a failure instead of throwing', async () => {
    const client = {
      rpc: () => ({ abortSignal: () => Promise.reject(new Error('boom')) }),
    } as unknown as Client;
    const res = await searchMessages({
      client,
      workspaceId: 'w1',
      query: 'sho',
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(false);
  });
});

/** A runner with manual timers and a fetch whose answers the test releases. */
function harness() {
  const timers: Array<() => void> = [];
  const requests: Array<{
    query: string;
    before: unknown;
    signal: AbortSignal;
    resolve: (r: SearchResult) => void;
  }> = [];
  const fetch: SearchPageFetch = (req) =>
    new Promise((resolve) => requests.push({ ...req, resolve }));
  const states: Array<ReturnType<ReturnType<typeof createSearchRunner>['getState']>> = [];
  const runner = createSearchRunner({
    fetch,
    onChange: (s) => states.push(s),
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: (h) => {
      timers[(h as number) - 1] = () => {};
    },
  });
  const flushTimers = (): void => {
    const run = timers.splice(0);
    for (const t of run) t();
  };
  return { runner, requests, states, flushTimers };
}

const hit = (id: string, createdAt = '2026-10-03T09:00:00Z') => ({
  id,
  channelId: 'c1',
  senderUserId: 'u2',
  body: 'shoot',
  createdAt,
});

describe('createSearchRunner', () => {
  it('makes no call under 2 characters', () => {
    const h = harness();
    h.runner.setQuery('s');
    h.runner.setQuery(' a ');
    h.flushTimers();
    expect(h.requests).toHaveLength(0);
    expect(h.runner.getState().status).toBe('idle');
  });

  it('debounces, then aborts the previous request on a new query', () => {
    const h = harness();
    h.runner.setQuery('sh');
    h.flushTimers();
    expect(h.requests).toHaveLength(1);
    h.runner.setQuery('sho');
    expect(h.requests[0]?.signal.aborted).toBe(true);
    h.flushTimers();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.query).toBe('sho');
  });

  it('drops a late answer for an old query', async () => {
    const h = harness();
    h.runner.setQuery('sh');
    h.flushTimers();
    h.runner.setQuery('sho');
    h.flushTimers();
    h.requests[1]?.resolve({ ok: true, data: { hits: [hit('new')], next: null } });
    await Promise.resolve();
    h.requests[0]?.resolve({ ok: true, data: { hits: [hit('old')], next: null } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.runner.getState()).toMatchObject({ query: 'sho', status: 'ready' });
    expect(h.runner.getState().hits.map((x) => x.id)).toEqual(['new']);
  });

  it('pages with the keyset cursor and appends', async () => {
    const h = harness();
    h.runner.setQuery('sho');
    h.flushTimers();
    const cursor = { createdAt: '2026-10-01T00:00:00Z', id: 'm30' };
    h.requests[0]?.resolve({ ok: true, data: { hits: [hit('m1')], next: cursor } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.runner.getState().hasMore).toBe(true);
    const more = h.runner.loadMore();
    expect(h.requests[1]?.before).toEqual(cursor);
    h.requests[1]?.resolve({ ok: true, data: { hits: [hit('m31')], next: null } });
    await more;
    expect(h.runner.getState().hits.map((x) => x.id)).toEqual(['m1', 'm31']);
    expect(h.runner.getState().hasMore).toBe(false);
  });

  it('a failure shows the error state and retry runs it again', async () => {
    const h = harness();
    h.runner.setQuery('sho');
    h.flushTimers();
    h.requests[0]?.resolve({ ok: false, error: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.runner.getState().status).toBe('error');
    h.runner.retry();
    expect(h.requests).toHaveLength(2);
  });

  it('dispose aborts the request and clears the debounce', () => {
    const h = harness();
    h.runner.setQuery('sh');
    h.flushTimers();
    h.runner.setQuery('sho');
    h.runner.dispose();
    h.flushTimers();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.signal.aborted).toBe(true);
  });
});

describe('matching and snippets', () => {
  it('matches word prefixes case-insensitively', () => {
    const runs = matchRuns('Shoot at 5, SHOW later. reshoot', queryWords('sho'));
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(['Shoot', 'SHOW']);
  });

  it('matches a Devanagari word by prefix', () => {
    const runs = matchRuns('कल नमस्ते बोलो', queryWords('नम'));
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(['नमस्ते']);
  });

  it('every query word is matched', () => {
    const runs = matchRuns('shoot the reel today', queryWords('reel sho'));
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(['shoot', 'reel']);
  });

  it('renders mention tokens as names, never the raw token', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const text = snippetText(`@[${id}] shoot at 5`, ['sho'], (u) =>
      u === id ? 'Priya Shah' : undefined,
    );
    expect(text).toBe('@Priya Shah shoot at 5');
    expect(text).not.toContain('@[');
  });

  it('starts near the first match and cuts with an ellipsis', () => {
    const body = `${'word '.repeat(30)}shoot ${'tail '.repeat(40)}`;
    const text = snippetText(body, ['shoot'], () => undefined, 60);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text).toContain('shoot');
    expect(snippetText('shoot now', ['shoot'], () => undefined)).toBe('shoot now');
  });

  it('only 2 to 100 trimmed characters are sendable', () => {
    expect(searchQueryReady(' s ')).toBe(false);
    expect(searchQueryReady('sh')).toBe(true);
    expect(searchQueryReady('x'.repeat(101))).toBe(false);
  });
});

describe('searchDateLabel', () => {
  const tz = 'UTC';
  const now = Date.parse('2026-10-03T15:00:00Z'); // a Saturday
  it('today is the time', () => {
    expect(searchDateLabel('2026-10-03T09:05:00Z', now, tz)).toBe('9:05 AM');
  });
  it('yesterday is "Yesterday"', () => {
    expect(searchDateLabel('2026-10-02T23:00:00Z', now, tz)).toBe('Yesterday');
  });
  it('the last 7 days are the weekday', () => {
    expect(searchDateLabel('2026-09-29T10:00:00Z', now, tz)).toBe('Tuesday');
  });
  it('older is DD/MM/YY', () => {
    expect(searchDateLabel('2026-09-20T10:00:00Z', now, tz)).toBe('20/09/26');
  });
});

describe('searchSenderPrefix', () => {
  const nameOf = (id: string) => (id === 'u2' ? 'Priya Shah' : undefined);
  it('own messages read "You: "', () => {
    expect(
      searchSenderPrefix({ senderUserId: 'me', currentUserId: 'me', isGroup: true, nameOf }),
    ).toBe('You: ');
  });
  it('group senders read their first name', () => {
    expect(
      searchSenderPrefix({ senderUserId: 'u2', currentUserId: 'me', isGroup: true, nameOf }),
    ).toBe('Priya: ');
  });
  it('a DM peer has no prefix, nor an unknown group sender', () => {
    expect(
      searchSenderPrefix({ senderUserId: 'u2', currentUserId: 'me', isGroup: false, nameOf }),
    ).toBe('');
    expect(
      searchSenderPrefix({ senderUserId: 'u9', currentUserId: 'me', isGroup: true, nameOf }),
    ).toBe('');
  });
});

describe('in-chat counter and arrows', () => {
  it('up is older (next index), down is newer (previous index)', () => {
    // Hits are newest first: index 0 is the newest match.
    expect(stepSearchIndex(0, 'older', 3)).toBe(1);
    expect(stepSearchIndex(1, 'newer', 3)).toBe(0);
    expect(stepSearchIndex(0, 'newer', 3)).toBeNull();
    expect(stepSearchIndex(2, 'older', 3)).toBeNull();
  });
  it('reads "N of M", "+" while more pages exist', () => {
    expect(searchCounterText(0, 4, false)).toBe('1 of 4');
    expect(searchCounterText(2, 30, true)).toBe('3 of 30+');
    expect(searchCounterText(0, 0, false)).toBe('0 of 0');
  });
});

describe('timers', () => {
  it('uses a 250 ms debounce by default', () => {
    vi.useFakeTimers();
    const fetch = vi.fn<SearchPageFetch>(() => new Promise(() => {}));
    const runner = createSearchRunner({ fetch, onChange: () => {} });
    runner.setQuery('shoot');
    vi.advanceTimersByTime(249);
    expect(fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    runner.dispose();
    vi.useRealTimers();
  });
});
