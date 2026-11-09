// @vitest-environment jsdom
// Bug: a bank idea kept its old title / description after Edit > Save until
// the viewer left the screen. The save marks the kept read stale
// (invalidateReads) and dispatches PLAN_CHANGED_EVENT; the route must re-read
// the idea (a real network read through the shared session read) and hand the
// fresh item to the Item screen, which seeds Edit from it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({
  calls: 0,
  description: 'Line one\nLine two',
}));

vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me-1' } } }),
}));
vi.mock('@/lib/chat/viewer-role', () => ({ useViewerSide: () => ({ side: 'team' }) }));
vi.mock('@/components/chat/PlanScreen', () => ({
  PlanScreen: () => null,
  PlanPage: () => <div data-frame="" />,
}));
vi.mock('@/components/chat/PlanItemScreen', async () => {
  const { sharedRead, readKey } = await import('@/lib/session-read');
  const { bankItemReadWhat } = await import('@/lib/chat/plans');
  return {
    BANK_BACK_LABEL: 'Bank',
    BANK_ITEM_TITLE: 'Idea',
    BANK_LABEL: 'Bank',
    // The real shared read, over a counted fake network read.
    sharedBankItemRead: (userId: string, workspaceId: string, itemId: string) =>
      sharedRead(
        readKey(userId, workspaceId, bankItemReadWhat(itemId)),
        async () => {
          net.calls += 1;
          return {
            ok: true as const,
            data: {
              item: { id: itemId, title: 'Idea', description: net.description },
              postStages: {},
              postInfo: {},
            },
          };
        },
        { isOk: (r: { ok: boolean }) => r.ok },
      ),
    PlanItemScreen: (props: { item: { title: string; description: string } }) => (
      <div data-item="">
        <h1>{props.item.title}</h1>
        {/* What the Edit sheet opens with: the item the route hands over. */}
        <pre data-desc="">{props.item.description}</pre>
      </div>
    ),
  };
});

import { PlanBankItemPage } from '@/components/pages/PlanPage';
import { dispatchPlanChanged, bankItemReadWhat } from '@/lib/chat/plans';
import { invalidateReads, readKey } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('PlanBankItemPage re-reads after a save', () => {
  it('shows the saved description without navigating, and Edit starts from it', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[`/plan/bank?item=${ITEM}`]}>
          <Routes>
            <Route path="/plan/bank" element={<PlanBankItemPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await flush();
    const desc = (): string => host?.querySelector('[data-desc]')?.textContent ?? '';
    expect(desc()).toBe('Line one\nLine two');
    expect(net.calls).toBe(1);

    // Edit > Save: a blank line in the middle. The DB now holds the new text;
    // saveEdit's tellBank marks the read stale, then dispatches.
    net.description = 'Line one\n\nLine two';
    act(() => {
      invalidateReads(readKey('me-1', 'ws-1', bankItemReadWhat(ITEM)));
      dispatchPlanChanged(window, '');
    });
    // The old idea stays on screen while the read runs (no box flash).
    expect(host.querySelector('[data-item]')).not.toBeNull();
    expect(host.querySelector('[data-frame]')).toBeNull();
    await flush();

    // The re-read went to the network, not the kept value.
    expect(net.calls).toBe(2);
    expect(desc()).toBe('Line one\n\nLine two');
  });

  it('stops listening once unmounted', async () => {
    const before = net.calls;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[`/plan/bank?item=${ITEM}`]}>
          <Routes>
            <Route path="/plan/bank" element={<PlanBankItemPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await flush();
    const mounted = net.calls;
    act(() => root?.unmount());
    root = null;
    act(() => {
      invalidateReads(readKey('me-1', 'ws-1', bankItemReadWhat(ITEM)));
      dispatchPlanChanged(window, '');
    });
    await flush();
    expect(net.calls).toBe(mounted);
    expect(mounted).toBeGreaterThanOrEqual(before);
  });
});
