// @vitest-environment jsdom
// Motion law for decisions (docs/motion.md): Approve, Reject and Park move
// nothing until the save is confirmed (no optimistic approve). Only after the
// stage RPC resolves does the decision row show the landed mark, and the tick
// (approve) or cross (reject) draws through drawTick (stroke-dashoffset, the
// fill axis). A refused save never draws. Park never draws.
import { act } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMotionPreferenceForTests, resetPlayerForTests } from '@/lib/motion';

const mocks = vi.hoisted(() => ({
  rpcStageTransition: vi.fn(),
  postsStageTransition: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), auth: { getSession: vi.fn() } } }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/induction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/induction')>()),
  dispatchInductionRefresh: vi.fn(),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  stageTransition: mocks.rpcStageTransition,
}));
vi.mock('@srtdio/posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/posts')>()),
  stageTransition: mocks.postsStageTransition,
}));
vi.mock('@/components/pages/pcs/use-approvers', () => ({
  useWorkspaceApprovers: () => [{ userId: 'u7', name: 'Asha' }],
}));
// A plain open/closed Sheet: this test is about the decision row's draw only.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        {props.children}
        {props.footer}
      </div>
    ) : null,
}));

import { usePostDecisions } from '@/components/pages/pcs/use-post-decisions';
import { PostDecisionBar } from '@/components/pages/pcs/PostDecisionBar';
import type { Stage } from '@srtdio/posts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Decisions = ReturnType<typeof usePostDecisions>;
const handle: { current: Decisions | null } = { current: null };

function Harness(props: { role: string }): ReactElement {
  const decisions = usePostDecisions({
    postId: 'p1',
    stage: 'review',
    role: props.role,
    enabled: true,
    workspaceId: 'ws-1',
    brand: 'Zomato',
    postTitle: 'Launch',
    creatorName: null,
    mediaCount: null,
    approveDay: '',
    openCount: 0,
    reload: async () => {},
  });
  handle.current = decisions;
  return (
    <>
      <span data-probe-stage="">{decisions.stage ?? ''}</span>
      <PostDecisionBar model={decisions.model} busy={decisions.busy} error={decisions.error} />
      {decisions.confirms}
    </>
  );
}

// Web Animations stand-in: jsdom has none, so play() would be instant. Every
// element (paths included) gets a recording animate().
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
  finish: vi.fn(),
  addEventListener: vi.fn(),
}));
const originalAnimate = (Element.prototype as { animate?: unknown }).animate;

let root: Root | null = null;

beforeEach(() => {
  mocks.rpcStageTransition.mockReset();
  mocks.postsStageTransition.mockReset();
  handle.current = null;
  animate.mockClear();
  (Element.prototype as { animate?: unknown }).animate = animate;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  (Element.prototype as { animate?: unknown }).animate = originalAnimate;
  resetMotionPreferenceForTests();
  resetPlayerForTests();
});

async function render(role: string): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness role={role} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function click(selector: string): Promise<void> {
  const el = document.querySelector<HTMLElement>(selector);
  expect(el).toBeTruthy();
  await act(async () => {
    el?.click();
  });
}

const landed = (): string | null =>
  document.querySelector('[data-decision-landed]')?.getAttribute('data-decision-landed') ?? null;
const drawCalls = () =>
  animate.mock.calls.filter(([frames]) => frames.some((f) => 'strokeDashoffset' in f));

describe('approve: no motion before the save resolves; the tick draws after', () => {
  it('nothing animates on the tap, the confirm or while the RPC is in flight', async () => {
    const rpc = deferred<{ ok: true; data: string }>();
    mocks.rpcStageTransition.mockReturnValue(rpc.promise);
    await render('client');

    await act(async () => {
      handle.current?.pick('approved' as Stage);
    });
    await click('[data-approve-confirm-button]');
    await flush();
    expect(mocks.rpcStageTransition).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
    expect(landed()).toBeNull();

    rpc.resolve({ ok: true, data: 'p1' });
    await flush();
    expect(landed()).toBe('approved');
    const draws = drawCalls();
    expect(draws).toHaveLength(1);
    const call = draws[0];
    if (call === undefined) throw new Error('no draw');
    const [frames, options] = call;
    expect(frames).toEqual([{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }]);
    expect(options.duration).toBe(220);
    // Never a fade.
    expect(animate.mock.calls.some(([f]) => f.some((k) => 'opacity' in k))).toBe(false);
  });

  it('a refused approve never draws', async () => {
    mocks.rpcStageTransition.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
    await render('client');
    await act(async () => {
      handle.current?.pick('approved' as Stage);
    });
    await click('[data-approve-confirm-button]');
    await flush();
    expect(landed()).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('final state first: with motion off the tick shows fully drawn and nothing animates', async () => {
    window.history.replaceState(null, '', '?motion=0');
    resetMotionPreferenceForTests();
    try {
      mocks.rpcStageTransition.mockResolvedValue({ ok: true, data: 'p1' });
      await render('client');
      await act(async () => {
        handle.current?.pick('approved' as Stage);
      });
      await click('[data-approve-confirm-button]');
      await flush();
      expect(landed()).toBe('approved');
      expect(animate).not.toHaveBeenCalled();
      const path = document.querySelector('[data-decision-landed] [data-draw]');
      expect(path?.getAttribute('stroke-dashoffset')).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
      try {
        window.sessionStorage.clear();
      } catch {
        // ignore
      }
    }
  });
});

describe('reject: the cross draws only once the move is saved', () => {
  it('in flight the stage shows (Undo design) but nothing draws; saved, the cross draws', async () => {
    const rpc = deferred<{ ok: true; data: string }>();
    mocks.rpcStageTransition.mockReturnValue(rpc.promise);
    await render('client');
    await act(async () => {
      handle.current?.pick('rejected' as Stage);
    });
    // No toast surface in this harness: the commit starts straight away.
    await click('[data-stage-confirm]');
    await flush();
    expect(mocks.rpcStageTransition).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
    expect(landed()).toBeNull();

    rpc.resolve({ ok: true, data: 'p1' });
    await flush();
    expect(landed()).toBe('rejected');
    expect(drawCalls()).toHaveLength(2);
  });

  it('park draws nothing, before or after the save', async () => {
    mocks.rpcStageTransition.mockResolvedValue({ ok: true, data: 'p1' });
    await render('agency');
    const parkRow = handle.current?.moveRows.find((r) => r.key === 'parked');
    if (parkRow === undefined) return;
    await act(async () => {
      parkRow.onPick();
    });
    await click('[data-stage-confirm]');
    await flush();
    expect(landed()).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
});
