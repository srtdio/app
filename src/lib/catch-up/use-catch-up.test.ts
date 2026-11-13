// @vitest-environment jsdom
// Catch up's kept-unread count (the end screen's "See you later." line): Keep
// unread counts, Mark as read does not, Undo of a keep pops it, a skipped card
// never counts, and Mark all after a keep keeps the earlier count.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/catch-up/writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catch-up/writes')>()),
  markCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  undoCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  markAllCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  markCatchUpSkipped: vi.fn(async () => ({ ok: true as const })),
  markThreadsCatchUpRead: vi.fn(async () => ({ ok: true as const })),
}));

import { useCatchUp, type CatchUpState } from '@/lib/catch-up/use-catch-up';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';
import type { CatchUpItem } from '@/lib/catch-up/queue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(id: string): CatchUpItem {
  return cardOf(entry({ id: `${id}-1`, entity_id: id }, { title: `Post ${id}` }));
}

let root: Root | null = null;

function mount(queue: CatchUpItem[]): { state: () => CatchUpState } {
  let latest: CatchUpState | null = null;
  const hooks = {
    workspaceId: 'w1',
    onRead: vi.fn(),
    onUnread: vi.fn(),
    onFailed: vi.fn(),
    onAllRead: vi.fn(),
  };
  function Probe(): null {
    latest = useCatchUp(queue, hooks);
    return null;
  }
  const host = document.createElement('div');
  root = createRoot(host);
  act(() => root?.render(createElement(Probe)));
  return {
    state: () => {
      if (latest === null) throw new Error('not mounted');
      return latest;
    },
  };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useCatchUp keptUnread', () => {
  const q = (): CatchUpItem[] => [card('p1'), card('p2'), card('p3')];

  it('counts a keep, never a read', () => {
    const { state } = mount(q());
    expect(state().keptUnread).toBe(0);
    act(() => state().decide(false));
    expect(state().keptUnread).toBe(1);
    act(() => state().decide(true));
    expect(state().keptUnread).toBe(1);
    expect(state().wentThrough).toBe(2);
  });

  it('Undo of a keep pops it', () => {
    const { state } = mount(q());
    act(() => state().decide(false));
    expect(state().keptUnread).toBe(1);
    act(() => state().undo());
    expect(state().keptUnread).toBe(0);
  });

  it('a skipped card never counts', () => {
    const { state } = mount(q());
    act(() => state().skip('post:p1'));
    expect(state().keptUnread).toBe(0);
  });

  it('Mark all after a keep keeps the earlier count', () => {
    const { state } = mount(q());
    act(() => state().decide(false));
    act(() => state().markAll());
    expect(state().done).toBe(true);
    expect(state().keptUnread).toBe(1);
  });
});
