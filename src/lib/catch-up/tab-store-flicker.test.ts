// @vitest-environment jsdom
// Catch up rows never flicker (22 Nov 2026): a read that started before a
// local drop never brings the dropped entry back for a moment, and an inbox
// change that lands while a read runs reads again once it settles (never
// left on the older answer).

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, LoadResult } from '@/components/pages/activity/data';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/pages/activity/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/activity/data')>()),
  fetchActivityEntries: h.fetch,
}));

import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { entry } from '@/lib/catch-up/test-fixtures';
import { dropHeldEntries, resetTabCatchUpForTest, useHeldUnread } from '@/lib/catch-up/tab-store';
import { resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const a = entry({ id: 'a', entity_id: 'p1' });
const b = entry({ id: 'b', entity_id: 'p2' });

/** Each fetch waits until the test answers it. */
function deferredReads(): Array<(items: ActivityItem[]) => void> {
  const answers: Array<(items: ActivityItem[]) => void> = [];
  h.fetch.mockImplementation(
    () =>
      new Promise<LoadResult>((resolve) => {
        answers.push((items) => resolve({ ok: true, data: items }));
      }),
  );
  return answers;
}

let root: Root | null = null;

function mount(): { held: () => readonly ActivityItem[] } {
  let latest: readonly ActivityItem[] = [];
  function Probe(): null {
    latest = useHeldUnread('u-flicker', 'w-flicker');
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root?.render(createElement(Probe)));
  return { held: () => latest };
}

async function answer(fn: ((items: ActivityItem[]) => void) | undefined, items: ActivityItem[]) {
  if (fn === undefined) throw new Error('no read running');
  await act(async () => {
    fn(items);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  resetTabCatchUpForTest();
  resetSessionReads();
  h.fetch.mockReset();
});

describe('catch up rows never flicker', () => {
  it('a read that started before a drop never brings the dropped entry back', async () => {
    const answers = deferredReads();
    const view = mount();
    await answer(answers[0], [a, b]);
    expect(view.held().map((x) => x.id)).toEqual(['a', 'b']);

    // A change starts a read; the person reads "a" here while it runs.
    act(() => window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT)));
    act(() => dropHeldEntries(['a']));
    expect(view.held().map((x) => x.id)).toEqual(['b']);

    // The older read still carries "a": it must not come back.
    await answer(answers[1], [a, b]);
    expect(view.held().map((x) => x.id)).toEqual(['b']);
  });

  it('a change during a running read reads again once it lands', async () => {
    const answers = deferredReads();
    mount();
    await answer(answers[0], [a, b]);
    act(() => window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT)));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    act(() => window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT)));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await answer(answers[1], [a, b]);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
});
