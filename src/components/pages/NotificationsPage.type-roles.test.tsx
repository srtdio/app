// @vitest-environment jsdom
// Type roles on Notifications (design rules, 24 Oct 2026): the page has no visible
// title (sr-only h1), a day bucket heading is the section label (sm/600
// uppercase tracking-label fg-2), a card title is base/500 and the card time
// and bucket count are sm fg-3 meta. Rendered for real in jsdom with the reads
// mocked; the item fixture mirrors activity/ActivityCard.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '@/components/pages/activity/data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchActivityEntries: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
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
  readActivityBadge: async () => ({ ok: true, data: { unread: 0, mentions: 0 } }),
}));
vi.mock('@/components/pages/activity/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/activity/data')>()),
  fetchActivityEntries: (...args: unknown[]) => h.fetchActivityEntries(...args),
}));

// The filter bar measures its row; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// Shared parts read media queries (laptop vs phone); jsdom has no matchMedia.
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
import { resetSessionReads } from '@/lib/session-read';
import { TopbarActionsProvider, useTopbarActionsValue } from '@/components/shell/topbar-actions';

// NotificationsPage reads the one unread count from the shell's inbox store
// (Part 6, 10 Nov 2026); these renders have no shell, so the store is a stub.
const inboxUnread = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/shell/InboxStoreProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInboxStore: () => ({ unreadCount: inboxUnread.count }),
}));

/** Stands in for Topbar: renders what the page published into its two slots. */
function TopbarProbe() {
  const { sort, primary } = useTopbarActionsValue();
  return (
    <div data-test-topbar="">
      <span data-test-topbar-sort="">{sort}</span>
      <span data-test-topbar-primary="">{primary}</span>
    </div>
  );
}

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

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/notifications']}>
        <TopbarActionsProvider>
          <TopbarProbe />
          <NotificationsPage />
        </TopbarActionsProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

beforeEach(() => {
  // Page one is a shared session read: each test starts with none held.
  resetSessionReads();
  try {
    window.localStorage.clear();
  } catch {
    // Storage can be unavailable.
  }
  h.fetchActivityEntries.mockReset().mockResolvedValue({
    ok: true,
    data: [item({ id: 'e1', title: 'Q3 Launch', body: 'Looks good to me' })],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Notifications type roles', () => {
  it('has no visible title bar: the h1 is screen-reader only', async () => {
    await mount();
    const head = [...document.querySelectorAll('h1')].find(
      (el) => el.textContent?.trim() === 'Activity',
    );
    expect(head).toBeDefined();
    expectRole(head as HTMLElement, ['sr-only']);
    expect(document.querySelector('.lit-header.h-14')).toBeNull();
  });

  it('the day bucket heading is the section label', async () => {
    await mount();
    const label = byText('Today');
    expect(label.tagName).toBe('H2');
    expectRole(label, ['text-sm', 'font-semibold', 'uppercase', 'tracking-label', 'text-fg-2']);
    expect(label.className).not.toContain('tracking-wide');
  });

  it('the card title is the ListCard heading role (unread: the bold heading)', async () => {
    await mount();
    const title = document.querySelector('[data-list-card-title]');
    expect(title?.textContent).toContain('Q3 Launch');
    expectRole(title as HTMLElement, ['text-lg', 'font-semibold', 'truncate']);
    expect(title?.className).not.toContain('font-normal');
    expect(title?.className).not.toMatch(/leading-\[/);
  });

  it('the card time is sm fg-3 meta; a section heading carries no count', async () => {
    await mount();
    const time = document.querySelector('[data-activity-time]');
    expect(time).not.toBeNull();
    expectRole(time as HTMLElement, ['text-sm', 'text-fg-3']);
    expect(document.querySelector('[data-bucket-count]')).toBeNull();
    const heading = document.querySelector('[data-activity-section] > h2');
    expect(heading?.textContent).toMatch(/^(Today|Yesterday|Earlier)$/);
  });
});

describe('Activity header, order and the Unread zero state', () => {
  it('no search field and no sort (decided 7 Nov); no catch-up rows even with unread (13 Nov 2026)', async () => {
    // Unread in the inbox: catch up lives on each tab, never on Activity.
    inboxUnread.count = 3;
    await mount();
    inboxUnread.count = 0;
    expect(document.querySelector('input[aria-label="Search activity"]')).toBeNull();
    expect(document.querySelector('[data-search-group]')).toBeNull();
    expect(document.querySelector('[aria-label="Sort activity"]')).toBeNull();
    expect(document.querySelector('[data-test-topbar-sort]')?.childElementCount).toBe(0);
    expect(document.querySelector('[data-shell="lead"]')).toBeNull();
    expect(document.querySelector('[data-shell="catch-up"]')).toBeNull();
    expect(document.querySelector('[data-list-card-solid]')).toBeNull();
    expect(document.querySelector('[data-topbar-catch-up], [data-topbar-threads]')).toBeNull();
    expect(document.querySelector('[data-activity-mark-all]')).toBeNull();
  });

  it('nothing unread: no Catch up row, no lead slot, no double tick', async () => {
    h.fetchActivityEntries.mockReset().mockResolvedValue({
      ok: true,
      data: [item({ id: 'e1', title: 'Q3 Launch', readAt: new Date().toISOString() })],
    });
    await mount();
    expect(document.querySelector('[data-activity-mark-all]')).toBeNull();
    expect(document.querySelector('[data-topbar-catch-up]')).toBeNull();
    expect(document.querySelector('[data-activity-solid-rows]')).toBeNull();
    expect(document.querySelector('[data-shell="lead"]')).toBeNull();
  });

  it('reads newest first even when an old Oldest first is stored on the device', async () => {
    try {
      window.localStorage.setItem('sorted:sort:activity', 'oldest');
    } catch {
      // Storage can be unavailable.
    }
    await mount();
    const directions = h.fetchActivityEntries.mock.calls.map(
      (call) => (call[2] as { direction?: string } | undefined)?.direction,
    );
    expect(directions.length).toBeGreaterThan(0);
    for (const direction of directions) expect(direction).toBe('newest');
  });

  it('reads newest first when nothing is stored', async () => {
    await mount();
    const directions = h.fetchActivityEntries.mock.calls.map(
      (call) => (call[2] as { direction?: string } | undefined)?.direction,
    );
    expect(directions.length).toBeGreaterThan(0);
    for (const direction of directions) expect(direction).toBe('newest');
  });

  it('the Unread chip with nothing unread says "New updates show up here."', async () => {
    h.fetchActivityEntries.mockReset().mockResolvedValue({ ok: true, data: [] });
    await mount();
    const unread = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim().startsWith('Unread'),
    );
    expect(unread).toBeDefined();
    await act(async () => unread?.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(document.body.textContent).toContain('New updates show up here.');
    expect(document.body.textContent).not.toContain(
      'Activity across posts, briefs and people shows up here.',
    );
  });

  it('the chips are All, Unread, Mentions only (no Snoozed, Briefs or Plans)', async () => {
    await mount();
    const chips = [...document.querySelectorAll('[data-activity-chips] button')].map((b) =>
      (b.textContent ?? '').replace(/\d+/g, '').trim(),
    );
    expect(chips).toEqual(['All', 'Unread', 'Mentions']);
  });
});
