// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

const { auth, listWorkspaces, newTrace, loggerError } = vi.hoisted(() => ({
  auth: { listener: null as AuthListener | null, initial: null as Session | null },
  listWorkspaces: vi.fn(),
  newTrace: () => 'trace-1',
  loggerError: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: auth.initial } }),
        onAuthStateChange: (cb: AuthListener) => {
          auth.listener = cb;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
        signOut: async () => ({ error: null }),
      },
      from: () => chain,
    },
  };
});
vi.mock('@srtdio/workspace', () => ({ listWorkspaces }));
vi.mock('@srtdio/rpc', () => ({ workspaceCreate: vi.fn() }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { SessionProvider, useSession } from '@/lib/session-context';
import { WorkspaceProvider, useWorkspace, workspacesReadKey } from '@/lib/workspace-context';
import { peekKept, primeRead, readKey, resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(userId: string, token: string): Session {
  return { user: { id: userId }, access_token: token, refresh_token: 'r' } as unknown as Session;
}

function ws(id: string) {
  return { id, name: id, platform: 'linkedin', key: id.toUpperCase(), owner_user_id: 'x' };
}

interface Snapshot {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  ids: string[];
  token: string | null;
  active: string | null;
}

const history: Snapshot[] = [];
let refresh: (() => Promise<void>) | null = null;
let retry: (() => void) | null = null;

function Probe() {
  const { session: s } = useSession();
  const w = useWorkspace();
  refresh = w.refreshWorkspaces;
  retry = w.retryWorkspaces;
  history.push({
    loading: w.loading,
    loaded: w.loaded,
    error: w.error,
    ids: w.workspaces.map((r) => r.id),
    token: s?.access_token ?? null,
    active: w.workspaceId,
  });
  return null;
}

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <SessionProvider>
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>
      </SessionProvider>,
    );
  });
  await flush();
}

async function emit(event: AuthChangeEvent, next: Session | null): Promise<void> {
  act(() => auth.listener?.(event, next));
  await flush();
}

const last = (): Snapshot => history[history.length - 1] as Snapshot;

beforeEach(() => {
  resetSessionReads();
  history.length = 0;
  refresh = null;
  auth.listener = null;
  auth.initial = session('u1', 't0');
  listWorkspaces.mockReset();
  listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-1')] });
  loggerError.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('WorkspaceProvider across auth events', () => {
  it.each<AuthChangeEvent>(['TOKEN_REFRESHED', 'SIGNED_IN'])(
    '%s for the same user never re-lists or flips loading, and hands over the fresh token',
    async (event) => {
      await mount();
      expect(last()).toMatchObject({ loading: false, loaded: true, ids: ['ws-1'] });
      const settledAt = history.length;

      await emit(event, session('u1', 't1'));
      await emit(event, session('u1', 't2'));

      expect(listWorkspaces).toHaveBeenCalledTimes(1);
      expect(history.slice(settledAt).every((h) => !h.loading && h.loaded)).toBe(true);
      expect(last()).toMatchObject({ token: 't2', ids: ['ws-1'] });
    },
  );

  it('a different user resets and re-bootstraps the workspace state', async () => {
    await mount();
    const settledAt = history.length;
    listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-2')] });

    await emit('SIGNED_IN', session('u2', 't9'));

    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(history.slice(settledAt).some((h) => h.loading && !h.loaded)).toBe(true);
    expect(last()).toMatchObject({ loading: false, loaded: true, ids: ['ws-2'], token: 't9' });
  });

  it('sign out then sign in re-bootstraps as before', async () => {
    await mount();
    await emit('SIGNED_OUT', null);
    expect(last().token).toBeNull();
    const signedOutAt = history.length;

    await emit('SIGNED_IN', session('u1', 't5'));

    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(history.slice(signedOutAt).some((h) => h.loading && !h.loaded)).toBe(true);
    expect(last()).toMatchObject({ loading: false, loaded: true, ids: ['ws-1'] });
  });

  it('a failed re-list after the initial load keeps the rows and logs with the trace id', async () => {
    await mount();
    listWorkspaces.mockResolvedValue({ ok: false, error: { message: 'network down' } });

    await act(async () => {
      await refresh?.();
    });

    expect(last()).toMatchObject({ loading: false, loaded: true, error: null, ids: ['ws-1'] });
    expect(loggerError).toHaveBeenCalledWith(
      'workspace refresh failed',
      expect.objectContaining({ error: 'network down', trace_id: expect.any(String) }),
    );
  });

  it('a failed initial list still reports the error (not loaded)', async () => {
    listWorkspaces.mockResolvedValue({ ok: false, error: { message: 'network down' } });
    await mount();
    expect(last()).toMatchObject({ loading: false, loaded: false, error: 'network down', ids: [] });
  });

  it('Try again re-runs the first list in place after a failure or timeout', async () => {
    listWorkspaces.mockResolvedValue({ ok: false, error: { message: 'TimeoutError' } });
    await mount();
    expect(last()).toMatchObject({ loaded: false, error: 'TimeoutError' });
    const failedAt = history.length;
    listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-1')] });

    act(() => retry?.());
    await flush();

    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(history.slice(failedAt).some((h) => h.loading && h.error === null)).toBe(true);
    expect(last()).toMatchObject({ loading: false, loaded: true, error: null, ids: ['ws-1'] });
  });

  it('a late answer from the read Try again replaced is dropped', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    listWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerFirst = resolve;
        }),
    );
    await mount();
    listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-2')] });

    act(() => retry?.());
    await flush();
    expect(last()).toMatchObject({ loaded: true, ids: ['ws-2'] });

    act(() => answerFirst({ ok: false, error: { message: 'late' } }));
    await flush();
    expect(last()).toMatchObject({ loading: false, loaded: true, error: null, ids: ['ws-2'] });
  });
});

describe('WorkspaceProvider from the device cache (cold open)', () => {
  it('paints the saved list at once, without waiting for the network', async () => {
    primeRead(workspacesReadKey('u1'), [ws('ws-1'), ws('ws-2')]);
    listWorkspaces.mockReturnValue(new Promise(() => undefined));
    await mount();
    const firstSignedIn = history.find((h) => h.token !== null);
    expect(firstSignedIn).toMatchObject({ loaded: true, ids: ['ws-1', 'ws-2'], active: 'ws-1' });
    expect(last()).toMatchObject({ loading: true, loaded: true, error: null });
  });

  it('a fresh list without the saved active workspace drops its reads and moves to the next row', async () => {
    primeRead(workspacesReadKey('u1'), [ws('ws-1'), ws('ws-2')]);
    primeRead(readKey('u1', 'ws-1', 'pipeline-posts'), ['kept']);
    primeRead(readKey('u1', 'ws-2', 'pipeline-posts'), ['other']);
    listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-2')] });
    await mount();
    expect(last()).toMatchObject({ loading: false, loaded: true, ids: ['ws-2'], active: 'ws-2' });
    expect(peekKept(readKey('u1', 'ws-1', 'pipeline-posts'))).toBeUndefined();
    expect(peekKept(readKey('u1', 'ws-2', 'pipeline-posts'))).toEqual(['other']);
    expect(peekKept(workspacesReadKey('u1'))).toEqual([ws('ws-2')]);
  });

  it('a failed fresh list keeps the saved rows on screen', async () => {
    primeRead(workspacesReadKey('u1'), [ws('ws-1')]);
    listWorkspaces.mockResolvedValue({ ok: false, error: { message: 'down' } });
    await mount();
    expect(last()).toMatchObject({ loading: false, loaded: true, error: null, ids: ['ws-1'] });
  });

  it('an account switch wipes the previous user before anything is seeded', async () => {
    await mount();
    expect(peekKept(workspacesReadKey('u1'))).toEqual([ws('ws-1')]);
    listWorkspaces.mockResolvedValue({ ok: true, data: [ws('ws-9')] });
    await emit('SIGNED_IN', session('u2', 't9'));
    expect(peekKept(workspacesReadKey('u1'))).toBeUndefined();
    expect(last()).toMatchObject({ loaded: true, ids: ['ws-9'] });
  });
});
