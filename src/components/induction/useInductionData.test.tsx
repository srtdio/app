// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InductionState } from '@/lib/induction';

const { reads } = vi.hoisted(() => ({
  reads: { count: 0, next: null as InductionState | null, failOpen: false },
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => {
  const newTrace = () => 'trace-1';
  return { useNewTrace: () => newTrace };
});
vi.mock('./induction-data', async () => {
  const { FAIL_OPEN_STATE } = await import('@/lib/induction');
  return {
    readInductionState: async () => {
      reads.count += 1;
      if (reads.failOpen || reads.next === null) return FAIL_OPEN_STATE;
      return reads.next;
    },
    storeInductionStep: async () => ({ ok: true, data: null }),
    finishInduction: async () => ({ ok: true, data: null }),
  };
});

import { FAIL_OPEN_STATE, dispatchInductionRefresh } from '@/lib/induction';
import { readsOnRouteChange, useInductionData } from './useInductionData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DONE: InductionState = {
  step: null,
  done: true,
  role: 'owner',
  postId: 'p1',
  clientInvited: true,
  teamInvited: true,
};
const TOURING: InductionState = { ...DONE, done: false, step: 'c_workspace' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let navigate: NavigateFunction | null = null;

function Probe() {
  useInductionData('ws-1');
  navigate = useNavigate();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(at: string): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={[at]}>
        <Probe />
      </MemoryRouter>,
    );
  });
  await flush();
}

async function go(to: string): Promise<void> {
  act(() => {
    navigate?.(to);
  });
  await flush();
}

beforeEach(() => {
  reads.count = 0;
  reads.next = null;
  reads.failOpen = false;
  try {
    window.sessionStorage.clear();
  } catch {
    // No storage: no replay mark to clear.
  }
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  navigate = null;
});

describe('readsOnRouteChange', () => {
  it('reads on a route change only while the guide is live', () => {
    expect(readsOnRouteChange(null, true)).toBe(false);
    expect(readsOnRouteChange(DONE, true)).toBe(false);
    expect(readsOnRouteChange(TOURING, true)).toBe(true);
    // A role with no route: the guide never shows.
    expect(readsOnRouteChange({ ...TOURING, role: 'viewer' }, true)).toBe(false);
    // A failed read heals on the next route change.
    expect(readsOnRouteChange(FAIL_OPEN_STATE, true)).toBe(true);
  });
});

describe('useInductionData reads', () => {
  it('a finished tour reads once on mount, not on route changes between pages', async () => {
    reads.next = DONE;
    await mount('/pipeline');
    expect(reads.count).toBe(1);

    await go('/briefs');
    await go('/assets');
    await go('/chat?channel=c1');
    await go('/pipeline');
    expect(reads.count).toBe(1);
  });

  it('the explicit refresh event still reads (success sites)', async () => {
    reads.next = DONE;
    await mount('/pipeline');
    act(() => dispatchInductionRefresh());
    await flush();
    expect(reads.count).toBe(2);
  });

  it('while the tour runs, a route change reads again (the guide is on screen)', async () => {
    reads.next = TOURING;
    await mount('/pipeline');
    expect(reads.count).toBe(1);

    await go('/settings');
    expect(reads.count).toBe(2);
  });

  it('a failed read heals on the next route change, then stops once done', async () => {
    reads.failOpen = true;
    await mount('/pipeline');
    expect(reads.count).toBe(1);

    reads.failOpen = false;
    reads.next = DONE;
    await go('/briefs');
    expect(reads.count).toBe(2);

    await go('/assets');
    expect(reads.count).toBe(2);
  });
});
