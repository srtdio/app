// @vitest-environment jsdom
// Move to bank (PR C): the row leaves at once, plan_item_to_bank fires only
// when the Undo strip ends (UNDO_MS), never after Undo; a refused write brings
// the row back with "Couldn't move to bank. Approved posts are locked.".
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const rpc = vi.hoisted(() => ({
  toBank: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return { ...actual, planItemToBank: (...args: unknown[]) => rpc.toBank(...args) };
});

const shown: ToastOptions[] = [];
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return {
    ...actual,
    useOptionalToast: () => ({
      show: (options: ToastOptions) => {
        shown.push(options);
        return String(shown.length);
      },
      dismiss: vi.fn(),
    }),
  };
});

import type { Client } from '@srtdio/rpc';
import { UNDO_MS } from '@/lib/undo';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { moveToBankAction } from '@/lib/chat/plan-bank-extras';
import { MOVED_TO_BANK_LABEL, MOVE_TO_BANK_LOCKED } from '@/lib/chat/bank-plan-copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let api: ReturnType<typeof useUndoableAction> | null = null;

function Probe(): ReactElement {
  api = useUndoableAction();
  return <div />;
}

beforeEach(async () => {
  shown.length = 0;
  rpc.toBank.mockReset();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

function deps() {
  return {
    client: {} as Client,
    itemId: 'item-1',
    hide: vi.fn(),
    show: vi.fn(),
    onMoved: vi.fn(),
    onError: vi.fn(),
  };
}

describe('Move to bank behind Undo', () => {
  it('hides the row at once; no write until the strip ends after UNDO_MS', async () => {
    rpc.toBank.mockResolvedValue({ ok: true, data: null });
    const d = deps();
    act(() => api?.run(moveToBankAction(d)));
    expect(d.hide).toHaveBeenCalledTimes(1);
    expect(rpc.toBank).not.toHaveBeenCalled();
    const strip = shown.at(-1);
    expect(strip?.title).toBe(MOVED_TO_BANK_LABEL);
    expect(strip?.durationMs).toBe(UNDO_MS);
    await act(async () => {
      strip?.onExpire?.();
      await Promise.resolve();
    });
    expect(rpc.toBank).toHaveBeenCalledTimes(1);
    expect(rpc.toBank.mock.calls[0]?.[1]).toMatchObject({ p_item_id: 'item-1' });
    expect(d.onMoved).toHaveBeenCalledTimes(1);
    expect(d.show).not.toHaveBeenCalled();
  });

  it('Undo shows the row again and never writes', async () => {
    const d = deps();
    act(() => api?.run(moveToBankAction(d)));
    const strip = shown.at(-1);
    await act(async () => strip?.action?.onPress());
    await act(async () => strip?.onExpire?.());
    expect(d.show).toHaveBeenCalledTimes(1);
    expect(rpc.toBank).not.toHaveBeenCalled();
  });

  it('post_approved: the row comes back with the locked copy', async () => {
    rpc.toBank.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'post_approved' },
    });
    const d = deps();
    act(() => api?.run(moveToBankAction(d)));
    await act(async () => {
      shown.at(-1)?.onExpire?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(d.show).toHaveBeenCalledTimes(1);
    expect(d.onError).toHaveBeenCalledWith(MOVE_TO_BANK_LOCKED);
    expect(d.onMoved).not.toHaveBeenCalled();
  });

  it('the Plan screen offers Move to bank on concept rows only, before Remove from plan', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../components/chat/PlanScreen.tsx', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(
      /id: 'move',[\s\S]*?props\.item\.kind === 'concept' && menu\.onToBank !== undefined[\s\S]*?id: 'to-bank'[\s\S]*?id: 'remove'/,
    );
    expect(src).toContain('onToBank: moveRowToBank');
    // The row closes upward at once (itemOut), the RPC waits for the strip.
    expect(src).toMatch(/const out = itemOut\(row\)/);
  });
});
