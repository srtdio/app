// @vitest-environment jsdom
// Approve speed (Speedy A, item 12): the approve confirm (and the on-behalf
// sheet) still waits for stage_transition: it stays open while the RPC is in
// flight, a failure keeps it open with the error, and only a landed RPC closes
// it. After success the post's stage updates in place from the known
// transition and the surface's refresh runs in the background: the confirm
// closes BEFORE that refresh settles (no full reload awaited, no optimistic
// approve).
import { act } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// The shared Sheet keeps its panel mounted through the exit transition; a
// plain open/closed stand-in makes "closed" mean gone at once.
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

function Harness(props: { role: string; reload: () => Promise<void> }): ReactElement {
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
    reload: props.reload,
  });
  handle.current = decisions;
  return (
    <>
      <span data-probe-stage="">{decisions.stage ?? ''}</span>
      {decisions.confirms}
    </>
  );
}

let root: Root | null = null;

beforeEach(() => {
  mocks.rpcStageTransition.mockReset();
  mocks.postsStageTransition.mockReset();
  handle.current = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(role: string, reload: () => Promise<void>): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness role={role} reload={reload} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

const approveConfirmOpen = (): boolean =>
  document.querySelector('[aria-label="Approve this post?"]') !== null;
const onBehalfOpen = (): boolean => document.querySelector('[data-on-behalf-approve]') !== null;
const shownStage = (): string =>
  document.querySelector('[data-probe-stage]')?.textContent ?? '';

async function click(selector: string): Promise<void> {
  const el = document.querySelector<HTMLElement>(selector);
  expect(el).toBeTruthy();
  await act(async () => {
    el?.click();
  });
}

async function openApprove(): Promise<void> {
  await act(async () => {
    handle.current?.pick('approved' as Stage);
  });
  expect(approveConfirmOpen()).toBe(true);
}

describe('approve confirm waits for stage_transition, then updates in place', () => {
  it('stays open while the RPC is in flight and closes after success without awaiting the refresh', async () => {
    const rpc = deferred<{ ok: true; data: string }>();
    mocks.rpcStageTransition.mockReturnValue(rpc.promise);
    const refresh = deferred<void>();
    const reload = vi.fn(() => refresh.promise);
    await render('client', reload);
    await openApprove();

    await click('[data-approve-confirm-button]');
    await flush();
    // In flight: still open, still the server's stage (no optimistic approve).
    expect(mocks.rpcStageTransition).toHaveBeenCalledTimes(1);
    expect(approveConfirmOpen()).toBe(true);
    expect(shownStage()).toBe('review');
    expect(reload).not.toHaveBeenCalled();

    rpc.resolve({ ok: true, data: 'p1' });
    await flush();
    // Landed: closed and approved in place while the refresh is still pending.
    expect(approveConfirmOpen()).toBe(false);
    expect(shownStage()).toBe('approved');
    expect(reload).toHaveBeenCalledTimes(1);

    refresh.resolve();
    await flush();
    expect(shownStage()).toBe('approved');
  });

  it('a refused approve keeps the confirm open with the error and never refreshes', async () => {
    mocks.rpcStageTransition.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
    const reload = vi.fn(async () => {});
    await render('client', reload);
    await openApprove();

    await click('[data-approve-confirm-button]');
    await flush();
    expect(approveConfirmOpen()).toBe(true);
    expect(document.querySelector('[data-approve-error]')).not.toBeNull();
    expect(shownStage()).toBe('review');
    expect(reload).not.toHaveBeenCalled();
  });

  it('a failed background refresh does not reopen the confirm or undo the landed stage', async () => {
    mocks.rpcStageTransition.mockResolvedValue({ ok: true, data: 'p1' });
    const reload = vi.fn(() => Promise.reject(new Error('read failed')));
    await render('client', reload);
    await openApprove();
    await click('[data-approve-confirm-button]');
    await flush();
    expect(approveConfirmOpen()).toBe(false);
    expect(shownStage()).toBe('approved');
  });
});

describe('approve on their behalf waits the same way', () => {
  async function openOnBehalf(): Promise<void> {
    const row = handle.current?.moveRows.find((r) => r.key === 'approved');
    expect(row).toBeTruthy();
    await act(async () => {
      row?.onPick();
    });
    expect(onBehalfOpen()).toBe(true);
  }

  it('stays open in flight, closes after success before the refresh settles', async () => {
    const rpc = deferred<{ ok: true; data: string }>();
    mocks.postsStageTransition.mockReturnValue(rpc.promise);
    const refresh = deferred<void>();
    const reload = vi.fn(() => refresh.promise);
    await render('agency', reload);
    await openOnBehalf();

    await click('[data-on-behalf-approve]');
    await flush();
    expect(onBehalfOpen()).toBe(true);
    expect(shownStage()).toBe('review');

    rpc.resolve({ ok: true, data: 'p1' });
    await flush();
    expect(onBehalfOpen()).toBe(false);
    expect(shownStage()).toBe('approved');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.postsStageTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStage: 'approved', onBehalfOf: 'u7' }),
    );
  });

  it('a failure keeps the sheet open with the error', async () => {
    mocks.postsStageTransition.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
    const reload = vi.fn(async () => {});
    await render('agency', reload);
    await openOnBehalf();
    await click('[data-on-behalf-approve]');
    await flush();
    expect(onBehalfOpen()).toBe(true);
    expect(document.querySelector('[data-on-behalf-error]')).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
