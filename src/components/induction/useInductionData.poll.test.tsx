// @vitest-environment jsdom
// The gated-step poll (every 4 s) counted on a fake induction_state read: a
// hidden tab reads nothing, the return to visible reads once, then the poll
// goes on.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InductionState } from '@/lib/induction';

const { reads } = vi.hoisted(() => ({ reads: { count: 0 } }));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => {
  const newTrace = () => 'trace-1';
  return { useNewTrace: () => newTrace };
});
vi.mock('./induction-data', () => ({
  readInductionState: async (): Promise<InductionState> => {
    reads.count += 1;
    return {
      step: 'c_invite_wait',
      done: false,
      role: 'owner',
      postId: 'p1',
      clientInvited: false,
      teamInvited: false,
    };
  },
  storeInductionStep: async () => ({ ok: true, data: null }),
  finishInduction: async () => ({ ok: true, data: null }),
}));

import { INDUCTION_POLL_MS } from '@/lib/induction';
import { useInductionData } from './useInductionData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hidden = false;

function Probe() {
  const { setPolling } = useInductionData('ws-1');
  useEffect(() => setPolling(true), [setPolling]);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

function setHidden(value: boolean): void {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reads.count = 0;
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('induction poll', () => {
  it('reads every 4 s while visible, nothing while hidden, once on the return', async () => {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <Probe />
        </MemoryRouter>,
      );
    });
    await flush();
    expect(reads.count).toBe(1);
    await advance(INDUCTION_POLL_MS);
    expect(reads.count).toBe(2);
    setHidden(true);
    await advance(INDUCTION_POLL_MS * 10);
    expect(reads.count).toBe(2);
    setHidden(false);
    await flush();
    expect(reads.count).toBe(3);
    await advance(INDUCTION_POLL_MS);
    expect(reads.count).toBe(4);
  });
});
