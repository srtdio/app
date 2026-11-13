// @vitest-environment jsdom
// Catch up per tab (13 Nov 2026): a row renders only while its count is above
// 0 (nothing at 0); a tap opens the EXISTING stack with only that row's kind;
// Mark N as read (laptop hover key, phone swipe left) marks only that row's
// kind, no toast; the row is the ui/ListCard solid row with the tab's icon.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
  laptop: true,
  swipeLeft: [] as Array<() => void>,
  queues: [] as string[][],
}));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/use-is-laptop', () => ({
  useIsLaptop: () => h.laptop,
  usePrefersReducedMotion: () => true,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'KITE', workspaces: [] }),
}));
vi.mock('@/lib/use-current-profile', () => ({ useCurrentProfile: () => ({ profile: null }) }));
vi.mock('@/lib/chat/viewer-role', () => ({
  useViewerSide: () => ({ side: 'agency', ready: true }),
}));
vi.mock('@/components/catch-up/CatchUpScreen', () => ({
  CatchUpScreen: (props: { queue: Array<{ kind: string; key: string }> }) => {
    h.queues.push(props.queue.map((c) => c.kind));
    return <div data-test-stack="">{props.queue.map((c) => c.key).join(',')}</div>;
  },
}));
vi.mock('@/lib/chat/swipe-reply', () => ({
  createSwipeReplyController: (opts: { onReply: () => void }) => {
    h.swipeLeft.push(opts.onReply);
    return {
      handlers: {
        onPointerDown: () => undefined,
        onPointerMove: () => undefined,
        onPointerUp: () => undefined,
        onPointerCancel: () => undefined,
      },
      consumeClickSuppression: () => false,
      swiping: () => false,
      cancel: () => undefined,
      dispose: () => undefined,
    };
  },
}));

import { useTabCatchUp } from '@/components/catch-up/TabCatchUp';
import { entry } from '@/lib/catch-up/test-fixtures';
import {
  resetTabCatchUpForTest,
  seedTabCatchUpForTest,
  type TabCatchUpKind,
} from '@/lib/catch-up/tab-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;
const posts = [
  entry({ id: 'p1', entity_id: 'post1', created_at: at(9) }),
  entry({ id: 'p2', entity_id: 'post2', created_at: at(10) }),
];
const briefs = [
  entry({
    id: 'b1',
    event_type: 'brief_created',
    entity_type: 'brief',
    entity_id: 'br1',
    scope: 'briefs',
    created_at: at(8),
  }),
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Tab({ tabs }: { tabs: readonly TabCatchUpKind[] }) {
  const c = useTabCatchUp({ tabs, userId: 'u-me', workspaceId: 'w1' });
  return (
    <>
      <div data-test-rows="">{c.rows}</div>
      {c.screen}
    </>
  );
}

async function render(tabs: readonly TabCatchUpKind[], url = '/pipeline'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[url]}>
        <Tab tabs={tabs} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  h.laptop = true;
  h.swipeLeft = [];
  h.queues = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({
    addEventListener: () => undefined,
    cancel: () => undefined,
    finish: () => undefined,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetTabCatchUpForTest();
  h.rpc.mockClear();
});

const rowOf = (tab: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-tab-catch-up="${tab}"]`);

describe('a row renders only while its count is above 0', () => {
  it('nothing unread: no row, no wrapper, nothing reserved', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [] });
    await render(['post']);
    expect(document.querySelector('[data-test-rows]')?.childElementCount).toBe(0);
    expect(document.querySelector('[data-list-card-solid]')).toBeNull();
  });

  it('Plan: only the kind with unread shows (Concept at 0 is absent)', async () => {
    seedTabCatchUpForTest({
      userId: 'u-me',
      workspaceId: 'w1',
      held: [
        entry({
          id: 'pi',
          event_type: 'plan_comment',
          entity_type: 'plan_item',
          entity_id: 'i1',
          scope: 'plan',
          scope_key: 'pl1',
        }),
      ],
    });
    await render(['plan-item', 'idea'], '/plan');
    expect(rowOf('plan-item')).not.toBeNull();
    expect(rowOf('idea')).toBeNull();
  });

  it('the solid ListCard: name, "N unread", the count, the tab icon', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...posts, ...briefs] });
    await render(['post']);
    const row = rowOf('post');
    // The row is the solid ListCard itself (a direct cell of the solid group).
    expect(row?.hasAttribute('data-list-card-solid')).toBe(true);
    expect(row?.querySelector('[data-list-card-title]')?.textContent).toBe('Post catch up');
    expect(row?.querySelector('[data-list-card-preview]')?.textContent).toBe('2 unread');
    expect(row?.getAttribute('data-count')).toBe('2');
    expect(row?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Post catch up, 2 unread',
    );
    // Briefs' entries never count on Pipeline.
    expect(rowOf('brief')).toBeNull();
  });
});

describe('a tap opens the existing stack with only that kind', () => {
  it('Pipeline: the stack holds posts only, newest first', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...posts, ...briefs] });
    await render(['post']);
    await act(async () => rowOf('post')?.querySelector<HTMLButtonElement>('button')?.click());
    expect(document.querySelector('[data-test-stack]')?.textContent).toBe('post:post2,post:post1');
    expect(h.queues.at(-1)).toEqual(['post', 'post']);
  });
});

describe('Mark N as read marks only that row’s kind (no toast, no Undo)', () => {
  it('laptop: hover shows "Mark N as read"; it marks only the posts', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...posts, ...briefs] });
    await render(['post', 'brief']);
    const row = rowOf('post');
    await act(async () => {
      row?.dispatchEvent(new Event('pointerover', { bubbles: true }));
      row?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    const key = document.querySelector<HTMLButtonElement>('[data-tab-catch-up-mark="post"] button');
    expect(key?.textContent).toBe('Mark 2 as read');
    await act(async () => key?.click());
    const call = h.rpc.mock.calls.find((c) => (c as unknown[])[0] === 'inbox_mark_read_ids') as
      | unknown[]
      | undefined;
    expect((call?.[1] as { p_ids: string[] }).p_ids.sort()).toEqual(['p1', 'p2']);
    // The post row leaves at once; the brief row stays.
    expect(rowOf('post')).toBeNull();
    expect(rowOf('brief')).not.toBeNull();
    expect(document.querySelector('[role="status"], [data-toast]')).toBeNull();
  });

  it('phone: a full swipe left on the brief row marks only the brief', async () => {
    h.laptop = false;
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...posts, ...briefs] });
    await render(['post', 'brief']);
    expect(document.querySelector('[data-tab-catch-up-mark]')).toBeNull();
    // Rows mount in order: post, then brief; the brief's swipe is the second core.
    await act(async () => h.swipeLeft[1]?.());
    const call = h.rpc.mock.calls.find((c) => (c as unknown[])[0] === 'inbox_mark_read_ids') as
      | unknown[]
      | undefined;
    expect((call?.[1] as { p_ids: string[] }).p_ids).toEqual(['b1']);
    expect(rowOf('brief')).toBeNull();
    expect(rowOf('post')).not.toBeNull();
  });
});
