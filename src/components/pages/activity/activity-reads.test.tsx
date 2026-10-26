// @vitest-environment jsdom
// Activity's reads: the first frame is the loading line, never a zero state;
// page one of each chip is a shared session read, so switching back to a chip
// within the window paints it with no request; an inbox change drops the held
// pages (the next switch reads anew); older than the window is never painted;
// and the bell press's prefetch is joined by the page's own read.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, LoadResult } from '@/components/pages/activity/data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchActivityEntries: vi.fn(),
  fetchUpcoming: vi.fn(),
  readActivityBadge: vi.fn(),
  from: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.from(table),
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
  fetchUpcoming: (...args: unknown[]) => h.fetchUpcoming(...args),
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
import {
  EMPTY_LINES,
  LOADING_NOTIFICATIONS,
  MENTION_EVENT_TYPE,
  activityPageKey,
  mentionCountKey,
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

function render(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/notifications']}>
        <NotificationsPage />
      </MemoryRouter>,
    );
  });
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
    // Storage can be unavailable; the sort falls back to its default.
  }
  h.fetchActivityEntries.mockReset().mockResolvedValue({
    ok: true,
    data: [item({ id: 'e1', title: 'Q3 Launch' })],
  } satisfies LoadResult);
  h.fetchUpcoming.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.readActivityBadge.mockReset().mockResolvedValue({ ok: true, data: { unread: 0, mentions: 0 } });
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
  it('shows the loading line while page one loads, never a zero state', async () => {
    let answer: (value: LoadResult) => void = () => undefined;
    h.fetchActivityEntries.mockReturnValue(
      new Promise<LoadResult>((resolve) => {
        answer = resolve;
      }),
    );
    render();
    const text = document.body.textContent ?? '';
    expect(text).toContain(LOADING_NOTIFICATIONS);
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

  it('an inbox change drops the held pages: the next switch reads anew', async () => {
    render();
    await settle();
    await pick('Mentions');
    act(() => {
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    });
    await pick('All');
    expect(askedStates()).toEqual(['all', 'mentions', 'all']);
  });

  it('a page older than the window is not painted: the switch shows loading and reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    render();
    await settle();
    await pick('Mentions');
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    let answer: (value: LoadResult) => void = () => undefined;
    h.fetchActivityEntries.mockReturnValueOnce(
      new Promise<LoadResult>((resolve) => {
        answer = resolve;
      }),
    );
    act(() => chip('All').click());
    expect(document.body.textContent).toContain(LOADING_NOTIFICATIONS);
    expect(document.body.textContent).not.toContain('Q3 Launch');
    await act(async () => answer({ ok: true, data: [item({ id: 'e2', title: 'Fresh one' })] }));
    await settle();
    expect(askedStates()).toEqual(['all', 'mentions', 'all']);
    expect(document.body.textContent).toContain('Fresh one');
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
});
