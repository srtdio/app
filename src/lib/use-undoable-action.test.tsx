// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A fake toast surface: records each show() so the test can press Undo, the X
// (onExpire), or let it expire by hand. `mode.real` swaps in the real provider
// (set before mount) for the timing tests.
const shown: ToastOptions[] = [];
const dismiss = vi.fn();
const mode = vi.hoisted(() => ({ real: false }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return {
    ...actual,
    useOptionalToast: () =>
      mode.real
        ? actual.useOptionalToast()
        : {
            show: (options: ToastOptions) => {
              shown.push(options);
              return String(shown.length);
            },
            dismiss,
          },
  };
});

import { ToastProvider } from '@/components/ui/toast';
import {
  UNDO_WINDOW_MS,
  undoFailureTitle,
  useUndoableAction,
  type UndoableAction,
} from '@/lib/use-undoable-action';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let api: ReturnType<typeof useUndoableAction> | null = null;

function Probe(): ReactElement {
  api = useUndoableAction();
  return <div />;
}

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe />));
}

function run(action: UndoableAction): ToastOptions {
  act(() => api?.run(action));
  return shown[shown.length - 1]!;
}

const flushPromises = () => act(async () => {});

beforeEach(async () => {
  shown.length = 0;
  dismiss.mockClear();
  await mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
  document.body.innerHTML = '';
});

describe('useUndoableAction', () => {
  it('shows an Undo strip (kind undo) over UNDO_WINDOW_MS (4000), no countdown', () => {
    const toast = run({ label: 'Post deleted', commit: vi.fn() });
    expect(UNDO_WINDOW_MS).toBe(4000);
    expect(toast.title).toBe('Post deleted');
    expect(toast.action?.label).toBe('Undo');
    expect(toast.durationMs).toBe(UNDO_WINDOW_MS);
    expect(toast.kind).toBe('undo');
    expect('countdown' in toast).toBe(false);
    expect('countdownMs' in toast).toBe(false);
  });

  it('takes no options: every caller gets the same 4000ms window', () => {
    expect(useUndoableAction.length).toBe(0);
    expect(run({ label: 'Slot approved', commit: vi.fn() }).durationMs).toBe(4000);
    expect(run({ label: 'Moved to Review', commit: vi.fn() }).kind).toBe('undo');
  });

  it('the commit waits for the toast to end', async () => {
    const commit = vi.fn();
    const toast = run({ label: 'Slot approved', commit });
    expect(commit).not.toHaveBeenCalled();
    act(() => toast.onExpire?.());
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('Undo reverts and commit never runs', async () => {
    const commit = vi.fn();
    const revert = vi.fn();
    const toast = run({ label: 'Post deleted', commit, revert });
    toast.action?.onPress();
    toast.onExpire?.();
    await flushPromises();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('expire (timer or X) commits exactly once', async () => {
    const commit = vi.fn();
    const toast = run({ label: 'Post deleted', commit });
    toast.onExpire?.();
    toast.onExpire?.();
    act(() => api?.flush());
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('a failed commit reverts and shows the failure toast, never the raw error', async () => {
    const revert = vi.fn();
    const toast = run({
      label: 'Delete post',
      commit: async () => {
        throw new Error('rpc 500 internal');
      },
      revert,
    });
    toast.onExpire?.();
    await flushPromises();
    expect(revert).toHaveBeenCalledTimes(1);
    const last = shown[shown.length - 1]!;
    expect(last.title).toBe("Couldn't delete post. Try again.");
    expect(last.title).not.toContain('rpc');
    expect(undoFailureTitle('Archive Brief')).toBe("Couldn't archive brief. Try again.");
  });

  it('a commit that throws synchronously also reverts', async () => {
    const revert = vi.fn();
    const toast = run({
      label: 'Park post',
      commit: () => {
        throw new Error('boom');
      },
      revert,
    });
    toast.onExpire?.();
    await flushPromises();
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('flushes pending commits on unmount', async () => {
    const commit = vi.fn();
    run({ label: 'Post deleted', commit });
    act(() => root?.unmount());
    root = null;
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('1');
  });

  it('flushes on visibilitychange to hidden', async () => {
    const commit = vi.fn();
    const toast = run({ label: 'Post deleted', commit });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    // The toast ending later never commits again.
    toast.onExpire?.();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flushes on pagehide', async () => {
    const commit = vi.fn();
    run({ label: 'Post deleted', commit });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('an undone action is not committed by a later flush', async () => {
    const commit = vi.fn();
    const toast = run({ label: 'Post deleted', commit });
    toast.action?.onPress();
    act(() => api?.flush());
    act(() => root?.unmount());
    root = null;
    await flushPromises();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('useUndoableAction with the real toast store', () => {
  beforeEach(async () => {
    act(() => root?.unmount());
    root = null;
    mode.real = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <ToastProvider>
          <Probe />
        </ToastProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    mode.real = false;
  });

  it('commits at 4000ms, not before', async () => {
    const commit = vi.fn();
    act(() => api?.run({ label: 'Post deleted', commit }));
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flushPromises();
    expect(commit).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('a second action commits the first at once (one strip at a time)', async () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => api?.run({ label: 'Post deleted', commit: first }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => api?.run({ label: 'Moved to Parked', commit: second }));
    await flushPromises();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    expect(second).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flushPromises();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
});
