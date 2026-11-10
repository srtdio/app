// @vitest-environment jsdom
// Activity's reads: the first frame is the loading line, never a zero state;
// page one of each chip is a shared session read, so switching back to a chip
// within the window paints it with no request; an inbox change marks the kept
// pages stale (the next switch reads anew); a kept page paints at any age and
// refreshes quietly; a return to Activity lands on the same chip with its kept
// rows and no loading line, applies the refresh while untouched and holds it
// after a touch; the page's own writes edit the kept pages; the bell
// press's prefetch is joined by the page's own read; the top bar carries the
// sort (each order read server-side) and Mark all read (only while unread).
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, LoadResult } from '@/components/pages/activity/data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchActivityEntries: vi.fn(),
  readActivityBadge: vi.fn(),
  markEntryRead: vi.fn(),
  rpc: vi.fn<(...args: unknown[]) => Promise<{ data: null; error: null }>>(async () => ({
    data: null,
    error: null,
  })),
  from: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.from(table),
    rpc: (...args: unknown[]) => h.rpc(...args),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-context')>()),
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'ACME',
    workspaces: [{ id: 'w1', timezone: 'UTC', week_start_day: 1 }],
  }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/use-current-profile', () => ({ useCurrentProfile: () => ({ profile: null }) }));
vi.mock('@/lib/chat/viewer-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/viewer-role')>()),
  useViewerSide: () => ({ side: 'agency', ready: true }),
}));
vi.mock('@/lib/use-workspace-data-changed', () => ({ useWorkspaceDataChanged: () => {} }));
vi.mock('@/lib/inbox/inbox-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/inbox-reads')>()),
  readActivityBadge: (...args: unknown[]) => h.readActivityBadge(...args),
}));
vi.mock('@/components/pages/activity/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/activity/data')>()),
  fetchActivityEntries: (...args: unknown[]) => h.fetchActivityEntries(...args),
  markEntryRead: (...args: unknown[]) => h.markEntryRead(...args),
}));

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

import { NotificationsPage } from '@/components/pages/NotificationsPage';
import { TopbarActionsProvider, useTopbarActionsValue } from '@/components/shell/topbar-actions';
import {
  EMPTY_LINES,
  LOADING_NOTIFICATIONS,
  MENTION_EVENT_TYPE,
  activityPageKey,
  mentionCountKey,
  peekActivityPage,
  prefetchActivityData,
  sharedActivityPage,
  sharedMentionCount,
} from '@/components/pages/activity/data';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';
import { INBOX_CHANGED_EVENT } from '@/lib/events';

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    number: null,
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: new Date().toISOString(),
    readAt: null,
    snoozedUntil: null,
    commentId: null,
    assetId: null,
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    pointsAdded: null,
    checkpointTotal: null,
    batchId: null,
    messageId: null,
    channelType: null,
    ...over,
  };
}

let root: Root | null = null;

/** The app top bar's two slots and Activity's pair, as Topbar reads them. */
function TopbarProbe(): ReactElement {
  const { sort, primary, pair } = useTopbarActionsValue();
  return (
    <div data-probe-topbar="">
      <div data-probe-sort="">{sort}</div>
      <div data-probe-primary="">{primary}</div>
      <div data-probe-pair="">{pair}</div>
    </div>
  );
}

function render(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/notifications']}>
        <TopbarActionsProvider>
          <TopbarProbe />
          <NotificationsPage />
        </TopbarActionsProvider>
      </MemoryRouter>,
    );
  });
}

/** The directions each fetchActivityEntries call asked for, in order. */
function askedDirections(): string[] {
  return h.fetchActivityEntries.mock.calls.map(
    (call) => (call[2] as { direction?: string } | undefined)?.direction ?? 'newest',
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function chip(label: string): HTMLElement {
  const hit = [...document.querySelectorAll<HTMLElement>('[data-activity-chips] button')].find(
    (el) => el.textContent?.trim().startsWith(label),
  );
  if (hit === undefined) throw new Error(`no chip ${label}`);
  return hit;
}

async function pick(label: string): Promise<void> {
  act(() => chip(label).click());
  await settle();
}

/** The next page one read, answered by hand. */
function heldPage(): (value: LoadResult) => void {
  let answer: (value: LoadResult) => void = () => undefined;
  h.fetchActivityEntries.mockReturnValueOnce(
    new Promise<LoadResult>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

/** The chips each fetchActivityEntries call asked for, in order. */
function askedStates(): string[] {
  return h.fetchActivityEntries.mock.calls.map(
    (call) => (call[2] as { state?: string } | undefined)?.state ?? 'all',
  );
}

beforeEach(() => {
  resetSessionReads();
  try {
    window.localStorage.clear();
  } catch {
    // Storage can be unavailable.
  }
  h.fetchActivityEntries.mockReset().mockResolvedValue({
    ok: true,
    data: [item({ id: 'e1', title: 'Q3 Launch' })],
  } satisfies LoadResult);
  h.readActivityBadge.mockReset().mockResolvedValue({ ok: true, data: { unread: 0, mentions: 0 } });
  h.markEntryRead.mockReset().mockResolvedValue({ ok: true, data: null });
  h.from.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetSessionReads();
  vi.useRealTimers();
});

describe('Activity: first paint', () => {
  it('shows the loading boxes while page one loads, never a zero state', async () => {
    let answer: (value: LoadResult) => void = () => undefined;
    h.fetchActivityEntries.mockReturnValue(
      new Promise<LoadResult>((resolve) => {
        answer = resolve;
      }),
    );
    render();
    const text = document.body.textContent ?? '';
    // The loading boxes, labelled with the loading copy (never a line of text).
    expect(
      document.querySelector(`[data-box-skeleton][aria-label="${LOADING_NOTIFICATIONS}"]`),
    ).not.toBeNull();
    expect(text).not.toContain('shows up here');
    expect(text).not.toContain(EMPTY_LINES.mentions);
    await act(async () => answer({ ok: true, data: [item({ id: 'e1', title: 'Q3 Launch' })] }));
    await settle();
    expect(document.body.textContent).toContain('Q3 Launch');
  });
});

describe('Activity: chip pages are shared within the window', () => {
  it('switching back to a chip within the window reads nothing again', async () => {
    // The Mentions chip shows mention entries only: its page holds one.
    h.fetchActivityEntries.mockImplementation(async (...args: unknown[]) => {
      const state = (args[2] as { state?: string } | undefined)?.state;
      return state === 'mentions'
        ? {
            ok: true,
            data: [item({ id: 'm1', eventType: MENTION_EVENT_TYPE, title: 'Q3 Launch' })],
          }
        : { ok: true, data: [item({ id: 'e1', title: 'Q3 Launch' })] };
    });
    render();
    await settle();
    await pick('Mentions');
    await pick('All');
    await pick('Mentions');
    expect(askedStates()).toEqual(['all', 'mentions']);
    expect(document.body.textContent).toContain('Q3 Launch');
  });

  it('an inbox change marks the kept pages stale: the next switch reads anew', async () => {
    render();
    await settle();
    await pick('Mentions');
    act(() => {
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    });
    await pick('All');
    expect(askedStates()).toEqual(['all', 'mentions', 'all']);
  });

  it('a page older than the window still paints on a switch, then the quiet refresh lands', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    render();
    await settle();
    await pick('Mentions');
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    const answer = heldPage();
    act(() => chip('All').click());
    expect(document.body.textContent).not.toContain(LOADING_NOTIFICATIONS);
    expect(document.body.textContent).toContain('Q3 Launch');
    await act(async () => answer({ ok: true, data: [item({ id: 'e2', title: 'Fresh one' })] }));
    await settle();
    expect(askedStates()).toEqual(['all', 'mentions', 'all']);
    expect(document.body.textContent).toContain('Fresh one');
  });
});

describe('Activity: a return paints the kept view', () => {
  /** A first visit that leaves on the Mentions chip, then a return past the window. */
  async function visitMentionsThenReturnLater(): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    h.fetchActivityEntries.mockImplementation(async (...args: unknown[]) => {
      const state = (args[2] as { state?: string } | undefined)?.state;
      return state === 'mentions'
        ? {
            ok: true,
            data: [item({ id: 'm1', eventType: MENTION_EVENT_TYPE, title: 'Mention one' })],
          }
        : { ok: true, data: [item({ id: 'e1', title: 'Q3 Launch' })] };
    });
    render();
    await settle();
    await pick('Mentions');
    act(() => root?.unmount());
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
  }

  it('lands on the same chip with its kept rows and no loading line, then applies the refresh', async () => {
    await visitMentionsThenReturnLater();
    const answer = heldPage();
    render();
    expect(document.body.textContent).not.toContain(LOADING_NOTIFICATIONS);
    expect(document.body.textContent).toContain('Mention one');
    expect(askedStates()).toEqual(['all', 'mentions', 'mentions']);
    await act(async () =>
      answer({
        ok: true,
        data: [item({ id: 'm2', eventType: MENTION_EVENT_TYPE, title: 'Mention two' })],
      }),
    );
    await settle();
    expect(document.body.textContent).toContain('Mention two');
  });

  it('a refresh landing after a touch is held; the next return paints it', async () => {
    await visitMentionsThenReturnLater();
    const answer = heldPage();
    render();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () =>
      answer({
        ok: true,
        data: [item({ id: 'm2', eventType: MENTION_EVENT_TYPE, title: 'Mention two' })],
      }),
    );
    await settle();
    expect(document.body.textContent).toContain('Mention one');
    expect(document.body.textContent).not.toContain('Mention two');
    act(() => root?.unmount());
    heldPage();
    render();
    expect(document.body.textContent).toContain('Mention two');
  });

  it("the page's own mark read edits the kept page, so a return paints it read", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    render();
    await settle();
    const lead = document.querySelector<HTMLElement>('[data-activity-lead]');
    // A tap opens the real place (9 Nov 2026: catch-up cards live only in
    // Catch up) and marks the row read: the page's own write (optimistic,
    // every kept page edited).
    act(() => lead?.click());
    await settle();
    expect(document.querySelector('[data-catch-up-card]')).toBeNull();
    expect(h.markEntryRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'e1' }),
      'w1',
      expect.any(String),
    );
    act(() => root?.unmount());
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    const kept = peekActivityPage(activityPageKey('u1', 'w1', 'all', 'newest'));
    expect(kept?.[0]?.readAt).toEqual(expect.any(String));
    heldPage();
    render();
    expect(document.body.textContent).not.toContain(LOADING_NOTIFICATIONS);
    expect(document.body.textContent).toContain('Q3 Launch');
  });
});

describe('Activity: the bell press prefetch', () => {
  it('starts page one of All and the Mentions count on the keys the page joins', async () => {
    // A recording client: every from() answers empty (the joins read nothing).
    const tables: string[] = [];
    h.from.mockImplementation((table: string) => {
      tables.push(table);
      const builder: object = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
            }
            return () => builder;
          },
        },
      );
      return builder;
    });
    prefetchActivityData({ userId: 'u1', workspaceId: 'w1' });
    await settle();
    expect(tables).toContain('inbox_entries');
    // The page's own reads join them: neither load runs.
    const page = vi.fn(async (): Promise<LoadResult> => ({ ok: true, data: [] }));
    const count = vi.fn(async () => ({ ok: true as const, data: 0 }));
    await sharedActivityPage(activityPageKey('u1', 'w1', 'all', 'newest'), page);
    await sharedMentionCount(mentionCountKey('u1', 'w1'), count);
    expect(page).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('reads in the order stored on the device (Oldest first), on the key the page joins', async () => {
    window.localStorage.setItem('sorted:sort:activity', 'oldest');
    h.from.mockImplementation(() => {
      const builder: object = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
            }
            return () => builder;
          },
        },
      );
      return builder;
    });
    prefetchActivityData({ userId: 'u1', workspaceId: 'w1' });
    await settle();
    // The page (Oldest first, the stored sort) joins the prefetch: no second read.
    const page = vi.fn(async (): Promise<LoadResult> => ({ ok: true, data: [] }));
    await sharedActivityPage(activityPageKey('u1', 'w1', 'all', 'oldest'), page);
    expect(page).not.toHaveBeenCalled();
  });
});

describe('Activity: the top bar', () => {
  const catchUp = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-probe-pair] [data-topbar-catch-up]');
  const threads = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-probe-pair] [data-topbar-threads]');

  it('Threads then Catch up in place of the slots; no sort, no Mark all read double tick', async () => {
    render();
    await settle();
    expect(threads()).not.toBeNull();
    expect(catchUp()).not.toBeNull();
    expect(catchUp()?.getAttribute('aria-label')).toMatch(/^Catch up, \d+ unread$/);
    // Threads first, then Catch up; nothing in the sort and "+" slots.
    const order = [...document.querySelectorAll('[data-probe-pair] button')].map((b) =>
      b.hasAttribute('data-topbar-threads') ? 'threads' : 'catch-up',
    );
    expect(order).toEqual(['threads', 'catch-up']);
    expect(document.querySelector('[data-probe-sort]')?.childElementCount).toBe(0);
    expect(document.querySelector('[data-probe-primary]')?.childElementCount).toBe(0);
    expect(document.querySelector('[data-activity-mark-all]')).toBeNull();
    expect(document.querySelector('[data-activity-bucket-head] button')).toBeNull();
  });

  it('at 0 unread Catch up stays, outlined, named "Catch up"', async () => {
    h.fetchActivityEntries.mockResolvedValue({
      ok: true,
      data: [item({ id: 'e1', title: 'Q3 Launch', readAt: new Date().toISOString() })],
    } satisfies LoadResult);
    render();
    await settle();
    expect(document.body.textContent).toContain('Q3 Launch');
    expect(catchUp()?.getAttribute('aria-label')).toBe('Catch up');
    expect(catchUp()?.className).toContain('border-border-strong');
    expect(threads()?.getAttribute('aria-label')).toBe('Threads');
  });

  it('reads the workspace threads once, after the first paint', async () => {
    h.rpc.mockClear();
    render();
    await settle();
    const calls = h.rpc.mock.calls.filter((c) => c[0] === 'chat_threads_for_me_all');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ p_workspace_id: 'w1' });
  });

  it('reads newest first, also when an old Oldest first is stored', async () => {
    render();
    await settle();
    expect(askedDirections()).toEqual(['newest']);
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    resetSessionReads();
    h.fetchActivityEntries.mockClear();
    window.localStorage.setItem('sorted:sort:activity', 'oldest');
    render();
    await settle();
    expect(askedDirections()).toEqual(['newest']);
  });

  it('only All, Unread and Mentions chips', async () => {
    render();
    await settle();
    const labels = [...document.querySelectorAll('[data-activity-chips] button')].map((b) =>
      (b.textContent ?? '').replace(/\d+/g, '').trim(),
    );
    expect(labels).toEqual(['All', 'Unread', 'Mentions']);
  });
});
