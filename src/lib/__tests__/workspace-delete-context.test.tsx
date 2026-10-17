// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockList, mockFinish, mockRefresh, newTrace } = vi.hoisted(() => ({
  newTrace: () => 'trace-1',
  mockList: vi.fn(),
  mockFinish: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('@srtdio/workspace', () => ({ listWorkspaces: mockList }));
vi.mock('@/components/induction/induction-data', () => ({ finishInduction: mockFinish }));
vi.mock('@/lib/induction', () => ({ dispatchInductionRefresh: mockRefresh }));
vi.mock('@/lib/workspace-context-platform', () => ({ primeWorkspacePlatforms: vi.fn() }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me', user_metadata: {} } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@/lib/supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { supabase: { from: () => query } };
});

import {
  nextActiveId,
  useWorkspace,
  WorkspaceProvider,
  type WorkspaceRow,
} from '@/lib/workspace-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, name: string): WorkspaceRow {
  return { id, name, platform: 'instagram', owner_user_id: 'me', deleted_at: null } as WorkspaceRow;
}

let root: Root | null = null;
let ctx: ReturnType<typeof useWorkspace> | null = null;

function Probe() {
  ctx = useWorkspace();
  return null;
}

async function render(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  ctx = null;
  document.body.innerHTML = '';
  mockList.mockReset();
  mockFinish.mockReset();
  mockRefresh.mockReset();
});

describe('workspaceDeleted', () => {
  it('skips induction, drops the row, moves to the remaining workspace and sets deletedWorkspace', async () => {
    mockList.mockResolvedValue({ ok: true, data: [row('a', 'Acme'), row('b', 'Beta')] });
    mockFinish.mockResolvedValue({ ok: true, data: null });
    await render();
    expect(ctx!.workspaceId).toBe('a');
    expect(ctx!.deletedWorkspace).toBeNull();

    await act(async () => ctx!.workspaceDeleted('a', 'Acme'));
    expect(mockFinish).toHaveBeenCalledWith(expect.anything(), 'trace-1');
    expect(mockRefresh).toHaveBeenCalledOnce();
    expect(ctx!.workspaces.map((w) => w.id)).toEqual(['b']);
    expect(ctx!.workspaceId).toBe('b');
    expect(ctx!.deletedWorkspace).toEqual({ name: 'Acme' });

    act(() => ctx!.clearDeletedWorkspace());
    expect(ctx!.deletedWorkspace).toBeNull();
  });

  it('lands on no workspace when it was the only one, even if the induction skip fails', async () => {
    mockList.mockResolvedValue({ ok: true, data: [row('a', 'Acme')] });
    mockFinish.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'nope' } });
    await render();
    await act(async () => ctx!.workspaceDeleted('a', 'Acme'));
    expect(ctx!.workspaces).toEqual([]);
    expect(ctx!.workspaceId).toBeNull();
    expect(ctx!.deletedWorkspace).toEqual({ name: 'Acme' });
    expect(ctx!.error).toBeNull();
  });
});

describe('another member deleted the active workspace', () => {
  it('re-lists quietly on focus and moves to the remaining workspace, with no error', async () => {
    mockList.mockResolvedValue({ ok: true, data: [row('a', 'Acme'), row('b', 'Beta')] });
    await render();
    expect(ctx!.workspaceId).toBe('a');
    mockList.mockResolvedValue({ ok: true, data: [row('b', 'Beta')] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(ctx!.workspaceId).toBe('b');
    expect(ctx!.error).toBeNull();
    expect(ctx!.loading).toBe(false);
    expect(ctx!.deletedWorkspace).toBeNull();
  });

  it('a failed re-list keeps what is shown', async () => {
    mockList.mockResolvedValue({ ok: true, data: [row('a', 'Acme')] });
    await render();
    mockList.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'down' } });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(ctx!.workspaceId).toBe('a');
    expect(ctx!.error).toBeNull();
  });
});

describe('nextActiveId', () => {
  it('keeps a listed id, else the first row, else null', () => {
    const rows = [row('a', 'A'), row('b', 'B')];
    expect(nextActiveId('b', rows)).toBe('b');
    expect(nextActiveId('gone', rows)).toBe('a');
    expect(nextActiveId(null, [])).toBeNull();
  });
});
