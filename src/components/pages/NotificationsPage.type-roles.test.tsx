// @vitest-environment jsdom
// Type roles on Notifications (design rules, 24 Oct 2026): the page head is the
// screen header (lg/600), a day bucket heading is the section label (sm/600
// uppercase tracking-[0.06em] fg-2), a card title is base/500 and the card time
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
  fetchUpcoming: vi.fn(),
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
  fetchUnreadMentionCount: async () => ({ ok: true, data: 0 }),
}));
vi.mock('@/components/pages/activity/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/activity/data')>()),
  fetchActivityEntries: (...args: unknown[]) => h.fetchActivityEntries(...args),
  fetchUpcoming: (...args: unknown[]) => h.fetchUpcoming(...args),
}));

// The filter bar measures its row; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// The card menus and the sort pick popover vs sheet by width; jsdom has no matchMedia.
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
        <NotificationsPage />
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
    // Storage can be unavailable; the sort falls back to its default.
  }
  h.fetchActivityEntries.mockReset().mockResolvedValue({
    ok: true,
    data: [item({ id: 'e1', title: 'Q3 Launch', body: 'Looks good to me' })],
  });
  h.fetchUpcoming.mockReset().mockResolvedValue({ ok: true, data: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Notifications type roles', () => {
  it('the page head is the screen header (lg/600)', async () => {
    await mount();
    const head = [...document.querySelectorAll('h1')].find(
      (el) => el.textContent?.trim() === 'Activity',
    );
    expect(head).toBeDefined();
    expectRole(head as HTMLElement, ['text-lg', 'font-semibold']);
  });

  it('the day bucket heading is the section label', async () => {
    await mount();
    const label = byText('Today');
    expect(label.tagName).toBe('H2');
    expectRole(label, ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']);
    expect(label.className).not.toContain('tracking-wide');
  });

  it('the card title is base/500', async () => {
    await mount();
    const title = byText('Q3 Launch');
    expectRole(title, ['text-base', 'font-medium', 'text-fg']);
    expect(title.className).not.toContain('font-semibold');
    expect(title.className).not.toMatch(/leading-\[/);
  });

  it('the card time and bucket count are sm fg-3 meta', async () => {
    await mount();
    const time = document.querySelector('[data-activity-time]');
    expect(time).not.toBeNull();
    expectRole(time as HTMLElement, ['text-sm', 'text-fg-3']);
    const count = document.querySelector('[data-bucket-count]');
    expect(count?.textContent).toBe('1 update');
    expectRole(count as HTMLElement, ['text-sm', 'text-fg-3']);
  });
});
