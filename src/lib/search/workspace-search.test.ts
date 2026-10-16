import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  chatHitPath,
  createPaletteSearchRunner,
  mapWorkspaceRow,
  searchWorkspace,
  workspaceHitPath,
  workspaceSearchArgs,
  type PaletteSearchState,
  type WorkspaceHit,
} from '@/lib/search/workspace-search';

const WS = '00000000-0000-4000-8000-000000000001';

const row = {
  kind: 'post',
  id: 'p1',
  entity_type: 'post',
  entity_id: 'p1',
  entity_number: 7,
  title: 'Diwali launch',
  snippet: 'Lights  and\nsweets',
  created_at: '2026-10-15T10:00:00Z',
};

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  return { client: { rpc } as unknown as Client, rpc };
}

describe('workspaceSearchArgs', () => {
  it('builds named args with the trimmed query and limit 20', () => {
    expect(workspaceSearchArgs({ workspaceId: WS, query: '  diwali ', traceId: 't1' })).toEqual({
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 't1',
      p_limit: 20,
    });
  });
});

describe('mapWorkspaceRow', () => {
  it('maps a row and folds snippet whitespace', () => {
    expect(mapWorkspaceRow(row)).toEqual({
      kind: 'post',
      id: 'p1',
      entityType: 'post',
      entityId: 'p1',
      entityNumber: 7,
      title: 'Diwali launch',
      snippet: 'Lights and sweets',
      createdAt: '2026-10-15T10:00:00Z',
    });
  });
  it('drops unknown kinds and parents', () => {
    expect(mapWorkspaceRow({ ...row, kind: 'asset' })).toBeNull();
    expect(mapWorkspaceRow({ ...row, kind: 'comment', entity_type: 'plan' })).toBeNull();
  });
});

describe('searchWorkspace', () => {
  it('ignores queries under 2 characters (no call)', async () => {
    const { client, rpc } = fakeClient({ data: [row], error: null });
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: ' d ',
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: true, data: [] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('calls workspace_search once and maps rows', async () => {
    const { client, rpc } = fakeClient({ data: [row], error: null });
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
      traceId: 'trace',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('workspace_search', {
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 'trace',
      p_limit: 20,
    });
    expect(res.ok && res.data.map((h) => h.id)).toEqual(['p1']);
  });
  it('returns a failure on an rpc error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});

describe('paths', () => {
  const hit = mapWorkspaceRow(row) as WorkspaceHit;
  it('posts and briefs open their short links; comments their parent', () => {
    expect(workspaceHitPath(hit, 'GBL')).toBe('/p/gbl-7');
    expect(workspaceHitPath({ ...hit, kind: 'brief', entityType: 'brief' }, 'GBL')).toBe(
      '/b/gbl-7',
    );
    expect(
      workspaceHitPath({ ...hit, kind: 'comment', entityType: 'brief', entityNumber: 3 }, 'GBL'),
    ).toBe('/b/gbl-3');
    expect(workspaceHitPath(hit, null)).toBe('/posts/p1');
  });
  it('chat hits open the chat at the message', () => {
    expect(chatHitPath({ channelId: 'group__a__b', id: 'm1' })).toBe(
      '/chat?channel=group__a__b&message=m1',
    );
  });
});

describe('createPaletteSearchRunner', () => {
  function setup() {
    const timers: Array<() => void> = [];
    const ws: Array<(r: unknown) => void> = [];
    const chat: Array<(r: unknown) => void> = [];
    const states: PaletteSearchState[] = [];
    const searchWorkspace = vi.fn(
      () => new Promise<never>((resolve) => ws.push(resolve as (r: unknown) => void)),
    );
    const searchChat = vi.fn(
      () => new Promise<never>((resolve) => chat.push(resolve as (r: unknown) => void)),
    );
    const runner = createPaletteSearchRunner({
      searchWorkspace,
      searchChat,
      onChange: (s) => states.push(s),
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    return { runner, timers, ws, chat, states, searchWorkspace, searchChat };
  }

  it('under 2 chars stays idle with no calls', () => {
    const t = setup();
    t.runner.setQuery('d');
    expect(t.timers).toHaveLength(0);
    expect(t.states.at(-1)?.status).toBe('idle');
  });

  it('fires both searches once, in parallel, after the debounce', async () => {
    const t = setup();
    t.runner.setQuery('diwali');
    expect(t.states.at(-1)?.status).toBe('loading');
    t.timers[0]?.();
    expect(t.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(t.searchChat).toHaveBeenCalledTimes(1);
    t.ws[0]?.({ ok: true, data: [mapWorkspaceRow(row)] });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.states.at(-1)).toMatchObject({ status: 'ready', query: 'diwali' });
  });

  it('drops a stale answer', async () => {
    const t = setup();
    t.runner.setQuery('diw');
    t.timers[0]?.();
    t.runner.setQuery('diwali');
    t.timers[1]?.();
    t.ws[1]?.({ ok: true, data: [] });
    t.chat[1]?.({ ok: true, data: { hits: [], next: null } });
    await new Promise((r) => setTimeout(r, 0));
    t.ws[0]?.({ ok: true, data: [mapWorkspaceRow(row)] });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.states.at(-1)).toMatchObject({ query: 'diwali', status: 'ready', workspace: [] });
  });

  it('either call failing is an error; retry runs again', async () => {
    const t = setup();
    t.runner.setQuery('diwali');
    t.timers[0]?.();
    t.ws[0]?.({ ok: false, error: 'x' });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.states.at(-1)?.status).toBe('error');
    t.runner.retry();
    expect(t.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(t.states.at(-1)?.status).toBe('loading');
  });
});
