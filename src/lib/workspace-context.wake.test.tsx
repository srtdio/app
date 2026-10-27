// @vitest-environment jsdom
// The workspace recheck on a wake: focus and visibilitychange fire together,
// and each used to re-list. Counted on a fake listWorkspaces: a wake while the
// boot bootstrap is still out reads nothing (that list is the fresh one), and
// a wake after it reads exactly once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lists } = vi.hoisted(() => ({
  lists: [] as Array<(rows: unknown[]) => void>,
}));

vi.mock('@srtdio/workspace', () => ({
  listWorkspaces: () =>
    new Promise((resolve) => {
      lists.push((rows) => resolve({ ok: true, data: rows }));
    }),
}));
vi.mock('@/lib/supabase', () => {
  // platform_operators: no row (the operator read), answered at once.
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return { supabase: { from: () => chain } };
});
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1', user_metadata: {} } } }),
}));
vi.mock('@/lib/trace-context', () => {
  const newTrace = () => 'trace-1';
  return { useNewTrace: () => newTrace };
});
vi.mock('@/components/induction/induction-data', () => ({
  finishInduction: async () => ({ ok: true, data: null }),
}));
vi.mock('@/lib/workspace-context-platform', () => ({ primeWorkspacePlatforms: () => {} }));

import { primeRead, resetSessionReads } from '@/lib/session-read';
import { WorkspaceProvider, useWorkspace, workspacesReadKey } from '@/lib/workspace-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = {
  id: 'ws-1',
  name: 'Brand',
  platform: 'instagram',
  key: 'BRD',
  owner_user_id: 'u1',
  deleted_at: null,
  created_at: '2026-10-01T00:00:00Z',
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const seen: Array<string | null> = [];

function Probe() {
  seen.push(useWorkspace().workspaceId);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function wake(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  lists.length = 0;
  seen.length = 0;
  resetSessionReads();
  // The device holds the list: the shell paints it while the bootstrap runs.
  primeRead(workspacesReadKey('u1'), [ROW]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('workspace recheck on a wake', () => {
  it('reads nothing while the boot bootstrap is out, then exactly once per wake', async () => {
    act(() => {
      root?.render(
        <WorkspaceProvider>
          <Probe />
        </WorkspaceProvider>,
      );
    });
    await flush();
    expect(seen.at(-1)).toBe('ws-1');
    // The bootstrap's list.
    expect(lists).toHaveLength(1);
    wake();
    expect(lists).toHaveLength(1);

    lists[0]?.([ROW]);
    await flush();
    wake();
    // focus + visibilitychange together: one recheck.
    expect(lists).toHaveLength(2);
    lists[1]?.([ROW]);
    await flush();
    expect(seen.at(-1)).toBe('ws-1');
  });
});
