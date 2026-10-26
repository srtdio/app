// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
  listMembers: vi.fn(),
  readProfiles: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@srtdio/workspace', () => ({
  listMembers: (...args: unknown[]) => h.listMembers(...args),
}));
vi.mock('@/lib/chat-reads', () => ({
  readProfiles: (...args: unknown[]) => h.readProfiles(...args),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({
    session: h.userId === null ? null : { user: { id: h.userId } },
    loading: false,
  }),
}));

import {
  MEMBERS_LOAD_FAILED,
  activeMemberIds,
  currentMembers,
  loadWorkspaceMembers,
  mentionCandidates,
  resetWorkspaceMembersCache,
  useWorkspaceMembers,
  withMembersLoadCopy,
  type WorkspaceMemberRow,
  type WorkspaceMembersState,
} from '@/lib/workspace-members';
import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import { resetSessionReads } from '@/lib/session-read';

function row(userId: string, extra: Partial<WorkspaceMemberRow> = {}): WorkspaceMemberRow {
  return {
    accepted_at: '2026-09-01T00:00:00Z',
    active: true,
    id: `m-${userId}`,
    invited_at: '2026-09-01T00:00:00Z',
    invited_by: null,
    join_default_group: false,
    rejoined_at: null,
    removed_at: null,
    role: 'agency',
    user_id: userId,
    workspace_id: 'ws-1',
    ...extra,
  };
}

const ROWS = [row('u1', { role: 'owner' }), row('u2', { role: 'client' })];
const PROFILES = [
  { userId: 'u1', displayName: 'Zara', avatarUrl: null, username: 'zara' },
  { userId: 'u2', displayName: 'Asha', avatarUrl: null, username: null },
];

const seen: WorkspaceMembersState[][] = [];
let roots: Root[] = [];

function Probe({ slot, workspaceId }: { slot: number; workspaceId: string | null }): ReactElement {
  const state = useWorkspaceMembers(workspaceId);
  (seen[slot] ??= []).push(state);
  return createElement('span');
}

function latest(slot: number): WorkspaceMembersState {
  const list = seen[slot] ?? [];
  const last = list[list.length - 1];
  if (last === undefined) throw new Error(`slot ${slot} never rendered`);
  return last;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function mount(slot: number, workspaceId: string | null): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(createElement(Probe, { slot, workspaceId })));
}

function unmountAll(): void {
  for (const root of roots) act(() => root.unmount());
  roots = [];
}

beforeEach(() => {
  h.userId = 'user-a';
  h.listMembers.mockReset();
  h.readProfiles.mockReset();
  h.listMembers.mockImplementation(async () => ({ ok: true, data: ROWS }));
  h.readProfiles.mockImplementation(async () => ({ ok: true, data: PROFILES }));
  resetWorkspaceMembersCache();
  // Each read is also a session read: none is kept between tests.
  resetSessionReads();
  seen.length = 0;
});

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

describe('useWorkspaceMembers shared cache', () => {
  it('three callers mounted together share one listMembers and one readProfiles', async () => {
    mount(0, 'ws-1');
    mount(1, 'ws-1');
    mount(2, 'ws-1');
    expect(latest(0).loading).toBe(true);
    await flush();

    expect(h.listMembers).toHaveBeenCalledTimes(1);
    expect(h.readProfiles).toHaveBeenCalledTimes(1);
    expect(h.readProfiles.mock.calls[0]?.[1]).toEqual(['u1', 'u2']);
    for (const slot of [0, 1, 2]) {
      expect(latest(slot).loading).toBe(false);
      expect(latest(slot).error).toBeNull();
      expect(latest(slot).options.map((o) => o.displayName)).toEqual(['Asha', 'Zara']);
      expect(latest(slot).rows).toHaveLength(2);
      expect(latest(slot).profiles.get('u1')?.displayName).toBe('Zara');
    }

    // A later mount is served from the cache.
    mount(3, 'ws-1');
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(1);
    expect(latest(3).options).toHaveLength(2);
  });

  it('a different user on the same workspace reads again (never served user A rows)', async () => {
    mount(0, 'ws-1');
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(1);
    unmountAll();

    h.userId = 'user-b';
    h.listMembers.mockImplementation(async () => ({ ok: true, data: [row('u9')] }));
    h.readProfiles.mockImplementation(async () => ({
      ok: true,
      data: [{ userId: 'u9', displayName: 'Bea', avatarUrl: null }],
    }));
    mount(1, 'ws-1');
    // Before user B's read lands, nothing of user A's list is shown.
    expect(latest(1).options).toEqual([]);
    expect(latest(1).loading).toBe(true);
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    expect(latest(1).options.map((o) => o.userId)).toEqual(['u9']);
  });

  it('sorted:signout clears the cache: the next mount reads again', async () => {
    mount(0, 'ws-1');
    await flush();
    unmountAll();
    act(() => {
      window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    });
    mount(1, 'ws-1');
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    expect(h.readProfiles).toHaveBeenCalledTimes(2);
  });

  it('refetch re-reads for every subscriber', async () => {
    mount(0, 'ws-1');
    mount(1, 'ws-1');
    await flush();
    h.listMembers.mockImplementation(async () => ({ ok: true, data: [row('u1')] }));
    act(() => latest(0).refetch());
    expect(latest(1).loading).toBe(true);
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    expect(latest(1).options.map((o) => o.userId)).toEqual(['u1']);
    expect(latest(0).options.map((o) => o.userId)).toEqual(['u1']);
  });

  it('workspace-data-changed re-reads without a loading flash', async () => {
    mount(0, 'ws-1');
    await flush();
    act(() => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_DATA_CHANGED_EVENT));
    });
    expect(latest(0).loading).toBe(false);
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(2);
  });

  it('a null workspace (or no session) issues no read and is not loading', async () => {
    mount(0, null);
    await flush();
    expect(latest(0)).toMatchObject({ loading: false, error: null, options: [], rows: [] });
    h.userId = null;
    mount(1, 'ws-1');
    await flush();
    expect(latest(1).loading).toBe(false);
    expect(h.listMembers).not.toHaveBeenCalled();
    expect(h.readProfiles).not.toHaveBeenCalled();
  });

  it('a failed load is not cached: the next mount retries', async () => {
    h.listMembers.mockImplementation(async () => ({
      ok: false,
      error: { code: 'unknown', message: 'listMembers failed: boom' },
    }));
    mount(0, 'ws-1');
    await flush();
    expect(latest(0).error).toBe('listMembers failed: boom');
    unmountAll();
    h.listMembers.mockImplementation(async () => ({ ok: true, data: ROWS }));
    mount(1, 'ws-1');
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    expect(latest(1).error).toBeNull();
  });
});

describe('activeMemberIds', () => {
  it('keeps only active members', () => {
    expect(
      activeMemberIds([
        { user_id: 'u1', active: true },
        { user_id: 'removed', active: false },
        { user_id: 'u2', active: true },
      ]),
    ).toEqual(['u1', 'u2']);
  });

  it('de-duplicates by user_id (an owner with an inactive and an active row lists once)', () => {
    expect(
      activeMemberIds([
        { user_id: 'owner', active: false },
        { user_id: 'owner', active: true },
        { user_id: 'u1', active: true },
        { user_id: 'u1', active: true },
      ]),
    ).toEqual(['owner', 'u1']);
  });
});

describe('currentMembers', () => {
  it('keeps active, not-removed rows, one per person', () => {
    const rows = [
      { user_id: 'a', active: true, removed_at: null, role: 'owner' },
      { user_id: 'b', active: false, removed_at: '2026-09-01T00:00:00Z', role: 'agency' },
      { user_id: 'c', active: false, removed_at: null, role: 'client' },
      { user_id: 'd', active: true, removed_at: null, role: 'client' },
      { user_id: 'd', active: true, removed_at: null, role: 'client' },
    ];
    expect(currentMembers(rows).map((r) => r.user_id)).toEqual(['a', 'd']);
  });
});

describe('mentionCandidates', () => {
  it('current members only, with role, sorted by name', () => {
    const rows = [...ROWS, row('gone', { active: false, removed_at: '2026-09-02T00:00:00Z' })];
    const profiles = new Map(PROFILES.map((p) => [p.userId, p]));
    expect(mentionCandidates(rows, profiles)).toEqual([
      { id: 'u2', name: 'Asha', username: null, role: 'client', avatarUrl: null },
      { id: 'u1', name: 'Zara', username: 'zara', role: 'owner', avatarUrl: null },
    ]);
  });
});

describe('R9: a chat members load failure never shows raw error text', () => {
  const rawError = { code: 'unknown' as const, message: 'permission denied for table users' };

  it('the membership read failing maps to the fixed copy', async () => {
    const state = withMembersLoadCopy(
      await loadWorkspaceMembers({
        members: () => Promise.resolve({ ok: false, error: rawError }),
        profiles: () => Promise.resolve({ ok: true, data: [] }),
      }),
    );
    expect(state.options).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBe(MEMBERS_LOAD_FAILED);
    expect(MEMBERS_LOAD_FAILED).toBe("Couldn't load members. Try again.");
  });

  it('the profile read failing maps to the fixed copy', async () => {
    const state = withMembersLoadCopy(
      await loadWorkspaceMembers({
        members: () => Promise.resolve({ ok: true, data: [row('u1')] }),
        profiles: () => Promise.resolve({ ok: false, error: rawError }),
      }),
    );
    expect(state.error).toBe(MEMBERS_LOAD_FAILED);
    expect(state.options).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('permission denied');
  });
});
