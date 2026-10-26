// @vitest-environment jsdom
// Plan tab kept view: a return to the tab paints the last read on its first
// frame with no loading state, even past the freshness window, and refreshes
// quietly behind it; the refresh is applied while the person has not touched
// the screen and held once they have; a plan write's re-read becomes the kept
// read the next visit paints.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import type { PlanTabData } from '@/lib/plan-tab-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ readPlanTab: vi.fn() }));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/prefetch-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prefetch-context')>()),
  getPrefetchContext: () => ({ userId: 'u1', workspaceId: 'ws' }),
}));
vi.mock('@/lib/plan-tab-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan-tab-read')>()),
  readPlanTab: (...args: unknown[]) => h.readPlanTab(...args),
}));

import { usePlanTabData, type PlanTabLoad } from './use-plan-tab-data';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

function data(anyPlan: boolean, timeZone: string): PlanTabData {
  return {
    bundles: [],
    posts: [],
    thumbs: { posts: {}, concepts: {} },
    anyPlan,
    timeZone,
    nextCursor: null,
  };
}

const FIRST = data(true, 'UTC');
const NEWER = data(true, 'Asia/Kolkata');

/** Every load the hook rendered, in order. */
let loads: PlanTabLoad[] = [];
let root: Root | null = null;

function Probe(): null {
  const { load } = usePlanTabData({
    workspaceId: 'ws',
    range: null,
    onlyShared: false,
    enabled: true,
  });
  loads.push(load);
  return null;
}

function mount(): void {
  loads = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Probe />));
}

function unmount(): void {
  act(() => root?.unmount());
  root = null;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function shown(): PlanTabData | null {
  return loads[loads.length - 1]?.data ?? null;
}

/** A read the test answers by hand. */
function heldRead(): (value: Result<PlanTabData>) => void {
  let answer: (value: Result<PlanTabData>) => void = () => undefined;
  h.readPlanTab.mockReturnValueOnce(
    new Promise<Result<PlanTabData>>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

/** First visit, then leave, then come back past the freshness window. */
async function visitThenReturnLater(): Promise<void> {
  mount();
  await settle();
  expect(shown()).toBe(FIRST);
  unmount();
  vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
}

beforeEach(() => {
  resetSessionReads();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
  h.readPlanTab.mockReset().mockResolvedValue({ ok: true, data: FIRST });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = '';
  resetSessionReads();
  vi.useRealTimers();
});

describe('Plan tab: a return paints the kept read', () => {
  it('the first visit shows loading; a return past the window paints at once, never loading', async () => {
    mount();
    expect(loads[0]?.status).toBe('loading');
    await settle();
    unmount();
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    const answer = heldRead();
    mount();
    expect(loads.every((load) => load.status === 'ready')).toBe(true);
    expect(shown()).toBe(FIRST);
    // The quiet refresh went to the server (the kept read was past its window);
    // the bounded read starts it a microtask later.
    await act(async () => {});
    expect(h.readPlanTab).toHaveBeenCalledTimes(2);
    await act(async () => answer({ ok: true, data: NEWER }));
    await settle();
    expect(loads.every((load) => load.status === 'ready')).toBe(true);
    expect(shown()).toBe(NEWER);
  });

  it('a refresh landing after a touch is held: the kept read stays, the next visit paints the new one', async () => {
    await visitThenReturnLater();
    const answer = heldRead();
    mount();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => answer({ ok: true, data: NEWER }));
    await settle();
    expect(shown()).toBe(FIRST);
    unmount();
    mount();
    expect(loads[0]?.data).toBe(NEWER);
  });

  it('a failed quiet refresh keeps the kept read on screen', async () => {
    await visitThenReturnLater();
    const answer = heldRead();
    mount();
    await act(async () => answer({ ok: false, error: { code: 'unknown', message: 'boom' } }));
    await settle();
    expect(loads.every((load) => load.status === 'ready')).toBe(true);
    expect(shown()).toBe(FIRST);
  });

  it("a plan write's re-read is shown at once and is what the next visit paints", async () => {
    mount();
    await settle();
    h.readPlanTab.mockResolvedValue({ ok: true, data: NEWER });
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
    });
    await settle();
    expect(shown()).toBe(NEWER);
    unmount();
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    heldRead();
    mount();
    expect(loads[0]).toEqual({ status: 'ready', data: NEWER });
  });
});
