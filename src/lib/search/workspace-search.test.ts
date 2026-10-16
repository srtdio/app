import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  chatHitPath,
  countsArgs,
  createPaletteSearchRunner,
  groupedArgs,
  mapCounts,
  mapWorkspaceRow,
  searchWorkspace,
  workspaceHitTarget,
  type PaletteSearchState,
  type WorkspaceHit,
  type WorkspaceSearchResult,
} from '@/lib/search/workspace-search';

const WS = '00000000-0000-4000-8000-000000000001';
const U = '00000000-0000-4000-8000-0000000000aa';

const row = {
  kind: 'post',
  id: 'p1',
  parent_id: '',
  channel_id: '',
  entity_type: 'post',
  number: 7,
  title: 'Diwali launch',
  snippet: 'Lights  and\nsweets',
  actor_user_id: U,
  actor_is_member: true,
  created_at: '2026-10-15T10:00:00Z',
};

function fakeClient(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const rpc = vi.fn((name: string, _args?: unknown) => {
    void _args;
    return Promise.resolve(results[name]);
  });
  return { client: { rpc } as unknown as Client, rpc };
}

describe('args', () => {
  it('builds named grouped and counts args with the trimmed query', () => {
    expect(groupedArgs({ workspaceId: WS, query: ' diwali ', traceId: 't', perKind: 5 })).toEqual({
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 't',
      p_per_kind: 5,
    });
    expect(countsArgs({ workspaceId: WS, query: ' diwali ', traceId: 't' })).toEqual({
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 't',
    });
  });
});

describe('mapWorkspaceRow', () => {
  it('maps a row and folds snippet whitespace', () => {
    expect(mapWorkspaceRow(row)).toEqual({
      kind: 'post',
      id: 'p1',
      parentId: null,
      channelId: null,
      entityType: 'post',
      number: 7,
      title: 'Diwali launch',
      snippet: 'Lights and sweets',
      actorUserId: U,
      actorIsMember: true,
      createdAt: '2026-10-15T10:00:00Z',
    });
  });
  it('drops unknown kinds', () => {
    expect(mapWorkspaceRow({ ...row, kind: 'invoice' })).toBeNull();
  });
  it('never keeps a mention token cut mid-way', () => {
    const hit = mapWorkspaceRow({ ...row, snippet: `hello @[${U}] and @[00000000-0000-40` });
    expect(hit?.snippet).toBe(`hello @[${U}] and`);
  });
  it('maps counts per known kind', () => {
    expect(
      mapCounts([
        { kind: 'post', total: 12 },
        { kind: 'nope', total: 3 },
      ]),
    ).toEqual({ post: 12 });
  });
});

describe('searchWorkspace', () => {
  const ok = {
    workspace_search_grouped: { data: [row], error: null },
    workspace_search_counts: { data: [{ kind: 'post', total: 9 }], error: null },
  };

  it('ignores queries under 2 characters (no call)', async () => {
    const { client, rpc } = fakeClient(ok);
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: ' d ',
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: true, data: { hits: [], counts: {} } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls grouped and counts once each, in parallel, with one trace id', async () => {
    const { client, rpc } = fakeClient(ok);
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
      traceId: 'trace',
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('workspace_search_grouped', {
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 'trace',
      p_per_kind: 5,
    });
    expect(rpc).toHaveBeenCalledWith('workspace_search_counts', {
      p_workspace_id: WS,
      p_query: 'diwali',
      p_trace_id: 'trace',
    });
    expect(res.ok && res.data.hits.map((h) => h.id)).toEqual(['p1']);
    expect(res.ok && res.data.counts).toEqual({ post: 9 });
  });

  it('mints a uuid_v7 trace id when none is passed', async () => {
    const { client, rpc } = fakeClient(ok);
    await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
    });
    const args = rpc.mock.calls.map((c) => (c as unknown[])[1] as { p_trace_id: string });
    expect(args[0]?.p_trace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(args[1]?.p_trace_id).toBe(args[0]?.p_trace_id);
  });

  it('a Show all refetch asks 20 per kind and skips counts', async () => {
    const { client, rpc } = fakeClient(ok);
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
      perKind: 20,
      counts: false,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_per_kind: 20 });
    expect(res.ok && res.data.counts).toBeNull();
  });

  it('either call failing is a failure', async () => {
    const { client } = fakeClient({
      ...ok,
      workspace_search_counts: { data: null, error: { message: 'boom' } },
    });
    const res = await searchWorkspace({
      client,
      workspaceId: WS,
      query: 'diwali',
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});

describe('workspaceHitTarget', () => {
  const base = mapWorkspaceRow(row) as WorkspaceHit;
  const hit = (extra: Partial<WorkspaceHit>): WorkspaceHit => ({ ...base, ...extra });

  it('opens each kind through its existing route', () => {
    expect(workspaceHitTarget(base, 'GBL')).toEqual({ path: '/p/gbl-7' });
    expect(workspaceHitTarget(base, null)).toEqual({ path: '/posts/p1' });
    expect(workspaceHitTarget(hit({ kind: 'brief', entityType: 'brief' }), 'GBL')).toEqual({
      path: '/b/gbl-7',
    });
    expect(
      workspaceHitTarget(
        hit({ kind: 'comment', id: 'c1', entityType: 'brief', parentId: 'b1', number: 3 }),
        'GBL',
      ),
    ).toEqual({ path: '/b/gbl-3?comment=c1' });
    expect(workspaceHitTarget(hit({ kind: 'file', id: 'a1' }), 'GBL')).toEqual({
      path: '/assets?asset=a1',
    });
    expect(workspaceHitTarget(hit({ kind: 'plan', id: 'pl1' }), 'GBL')).toEqual({
      path: '/plans/pl1',
    });
    expect(
      workspaceHitTarget(hit({ kind: 'plan_item', id: 'i1', parentId: 'pl1' }), 'GBL'),
    ).toEqual({ path: '/plans/pl1?at=i1' });
    expect(
      workspaceHitTarget(hit({ kind: 'task', id: 't1', channelId: 'group__w__g' }), 'GBL'),
    ).toEqual({ path: '/chat?channel=group__w__g&task=t1' });
    expect(
      workspaceHitTarget(hit({ kind: 'chat_group', id: 'g', channelId: 'group__w__g' }), 'GBL'),
    ).toEqual({ path: '/chat?channel=group__w__g' });
    expect(workspaceHitTarget(hit({ kind: 'person', id: U }), 'GBL')).toEqual({ person: U });
  });

  it('chat hits open the chat at the message', () => {
    expect(chatHitPath({ channelId: 'group__a__b', id: 'm1' })).toBe(
      '/chat?channel=group__a__b&message=m1',
    );
  });

  it('every kind but a person carries the searched words through the one jump helper', () => {
    expect(workspaceHitTarget(base, 'GBL', ' Launch ')).toEqual({ path: '/p/gbl-7?q=Launch' });
    expect(
      workspaceHitTarget(
        hit({ kind: 'comment', id: 'c1', entityType: 'post', parentId: 'p1', number: 3 }),
        'GBL',
        'hello',
      ),
    ).toEqual({ path: '/p/gbl-3?comment=c1&q=hello' });
    expect(
      workspaceHitTarget(hit({ kind: 'plan_item', id: 'i1', parentId: 'pl1' }), 'GBL', 'reel'),
    ).toEqual({ path: '/plans/pl1?q=reel&at=i1' });
    expect(
      workspaceHitTarget(hit({ kind: 'task', id: 't1', channelId: 'group__w__g' }), 'GBL', 'fix'),
    ).toEqual({ path: '/chat?channel=group__w__g&task=t1&q=fix' });
    expect(workspaceHitTarget(hit({ kind: 'file', id: 'a1' }), 'GBL', 'logo')).toEqual({
      path: '/assets?asset=a1&q=logo',
    });
    expect(workspaceHitTarget(hit({ kind: 'person', id: U }), 'GBL', 'ana')).toEqual({ person: U });
    expect(chatHitPath({ channelId: 'group__a__b', id: 'm1' }, 'see you')).toBe(
      '/chat?channel=group__a__b&message=m1&q=see+you',
    );
  });
});

describe('createPaletteSearchRunner', () => {
  function setup(prepare?: () => Promise<void>) {
    const timers: Array<() => void> = [];
    const ws: Array<(r: WorkspaceSearchResult) => void> = [];
    const chat: Array<(r: unknown) => void> = [];
    const states: PaletteSearchState[] = [];
    const searchWorkspace = vi.fn<
      (query: string, signal: AbortSignal, full: boolean) => Promise<WorkspaceSearchResult>
    >(() => new Promise<WorkspaceSearchResult>((resolve) => ws.push(resolve)));
    const searchChat = vi.fn(
      () => new Promise<never>((resolve) => chat.push(resolve as (r: unknown) => void)),
    );
    const runner = createPaletteSearchRunner({
      searchWorkspace,
      searchChat,
      ...(prepare !== undefined ? { prepare } : {}),
      onChange: (s) => states.push(s),
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    return { runner, timers, ws, chat, states, searchWorkspace, searchChat };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const hit = mapWorkspaceRow(row) as WorkspaceHit;

  it('under 2 chars stays idle with no calls', () => {
    const t = setup();
    t.runner.setQuery('d');
    expect(t.timers).toHaveLength(0);
    expect(t.states.at(-1)?.status).toBe('idle');
  });

  it('fires both searches once, in parallel, after the debounce, and names before ready', async () => {
    let prepared = 0;
    const t = setup(async () => {
      prepared += 1;
    });
    t.runner.setQuery('diwali');
    expect(t.states.at(-1)?.status).toBe('loading');
    t.timers[0]?.();
    expect(t.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(t.searchChat).toHaveBeenCalledTimes(1);
    t.ws[0]?.({ ok: true, data: { hits: [hit], counts: { post: 8 } } });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await flush();
    expect(prepared).toBe(1);
    expect(t.states.at(-1)).toMatchObject({
      status: 'ready',
      query: 'diwali',
      counts: { post: 8 },
    });
  });

  it('drops a stale answer', async () => {
    const t = setup();
    t.runner.setQuery('diw');
    t.timers[0]?.();
    t.runner.setQuery('diwali');
    t.timers[1]?.();
    t.ws[1]?.({ ok: true, data: { hits: [], counts: {} } });
    t.chat[1]?.({ ok: true, data: { hits: [], next: null } });
    await flush();
    t.ws[0]?.({ ok: true, data: { hits: [hit], counts: {} } });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await flush();
    expect(t.states.at(-1)).toMatchObject({ query: 'diwali', status: 'ready', workspace: [] });
  });

  it('either call failing is an error; retry runs again', async () => {
    const t = setup();
    t.runner.setQuery('diwali');
    t.timers[0]?.();
    t.ws[0]?.({ ok: false, error: 'x' });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await flush();
    expect(t.states.at(-1)?.status).toBe('error');
    t.runner.retry();
    expect(t.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(t.states.at(-1)?.status).toBe('loading');
  });

  it('expand refetches at 20 and replaces only that kind', async () => {
    const t = setup();
    t.runner.setQuery('diwali');
    t.timers[0]?.();
    const brief = { ...hit, kind: 'brief' as const, id: 'b1' };
    t.ws[0]?.({ ok: true, data: { hits: [hit, brief], counts: { post: 9 } } });
    t.chat[0]?.({ ok: true, data: { hits: [], next: null } });
    await flush();
    t.runner.expand('post');
    expect(t.searchWorkspace).toHaveBeenLastCalledWith('diwali', expect.anything(), true);
    const more = Array.from({ length: 9 }, (_, i) => ({ ...hit, id: `p${i + 1}` }));
    t.ws[1]?.({ ok: true, data: { hits: [...more, { ...brief, id: 'b2' }], counts: null } });
    await flush();
    const last = t.states.at(-1);
    expect(last?.full).toEqual(['post']);
    expect(last?.workspace.filter((h) => h.kind === 'post')).toHaveLength(9);
    expect(last?.workspace.filter((h) => h.kind === 'brief').map((h) => h.id)).toEqual(['b1']);
  });
});
