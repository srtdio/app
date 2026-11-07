// @vitest-environment jsdom
// Loading boxes (sweepBoxes, docs/motion.md) render ONLY when the device or
// the session holds nothing for the screen. Activity: with nothing saved the
// first frame is the card boxes ("Loading activity"); with a page one saved on
// the device (seeded at boot) or read this session, the first frame is the
// rows and no box. Plan tab (phone): the first visit's frame is the plan-card
// boxes; a return to the tab paints the kept read at once, with no box.
import { ToastProvider } from '@/components/ui/toast';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import type { ActivityItem, LoadResult } from '@/components/pages/activity/data';
import type { PlanTabData } from '@/lib/plan-tab-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchActivityEntries: vi.fn(),
  fetchUpcoming: vi.fn(),
  readActivityBadge: vi.fn(),
  markEntryRead: vi.fn(),
  readPlanTab: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
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
vi.mock('@/lib/prefetch-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prefetch-context')>()),
  getPrefetchContext: () => ({ userId: 'u1', workspaceId: 'w1' }),
}));
vi.mock('@/components/induction/InductionProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/induction/InductionProvider')>()),
  useInduction: () => null,
}));
vi.mock('@/lib/inbox/inbox-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/inbox-reads')>()),
  readActivityBadge: (...args: unknown[]) => h.readActivityBadge(...args),
}));
vi.mock('@/components/pages/activity/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/activity/data')>()),
  fetchActivityEntries: (...args: unknown[]) => h.fetchActivityEntries(...args),
  fetchUpcoming: (...args: unknown[]) => h.fetchUpcoming(...args),
  markEntryRead: (...args: unknown[]) => h.markEntryRead(...args),
}));
vi.mock('@/lib/plan-tab-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan-tab-read')>()),
  readPlanTab: (...args: unknown[]) => h.readPlanTab(...args),
}));

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

globalThis.IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
} as unknown as typeof IntersectionObserver;

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
import { PlanTabPage } from '@/components/pages/PlanTabPage';
import { LOADING_NOTIFICATIONS, activityPageKey } from '@/components/pages/activity/data';
import { hydrateSessionReads, resetSessionReads } from '@/lib/session-read';
import {
  appVersion,
  setDeviceCacheBackend,
  type CacheBackend,
  type CacheRecord,
} from '@/lib/device-cache';

// ---------------------------------------------------------------------------
// Shared

let root: Root | null = null;

function render(path: string, page: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </ToastProvider>,
    );
  });
}

function unmount(): void {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

/** Any loading boxes on screen (the shared BoxSkeleton). */
const anyBoxes = (): Element | null => document.querySelector('[data-box-skeleton]');
const text = (): string => document.body.textContent ?? '';

/** An in-memory stand-in for IndexedDB (the device cache). */
function memoryBackend(): CacheBackend & { rows: Map<string, CacheRecord> } {
  const rows = new Map<string, CacheRecord>();
  return {
    rows,
    getAll: async () => [...rows.values()],
    putMany: async (records) => {
      for (const r of records) rows.set(r.key, r);
    },
    deleteKeys: async (keys) => {
      for (const k of keys) rows.delete(k);
    },
    deletePrefix: async (prefix) => {
      for (const k of [...rows.keys()]) if (k.startsWith(prefix)) rows.delete(k);
    },
    clear: async () => rows.clear(),
  };
}

let mem: ReturnType<typeof memoryBackend>;

beforeEach(async () => {
  resetSessionReads();
  // Let the reset's queued wipe run before the fake device is in place.
  await new Promise((r) => setTimeout(r, 0));
  mem = memoryBackend();
  setDeviceCacheBackend(mem);
  try {
    window.localStorage.clear();
  } catch {
    // Storage can be unavailable; sorts fall back to their defaults.
  }
  h.fetchActivityEntries.mockReset();
  h.fetchUpcoming.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.readActivityBadge.mockReset().mockResolvedValue({ ok: true, data: { unread: 0, mentions: 0 } });
  h.markEntryRead.mockReset().mockResolvedValue({ ok: true, data: null });
  h.readPlanTab.mockReset();
});

afterEach(() => {
  unmount();
  resetSessionReads();
  setDeviceCacheBackend(null);
});

// ---------------------------------------------------------------------------
// Activity

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

const ALL_KEY = activityPageKey('u1', 'w1', 'all', 'newest');

const activityBoxes = (): Element | null =>
  document.querySelector(`[data-box-skeleton][aria-label="${LOADING_NOTIFICATIONS}"]`);

/** The next page one read, answered by hand (never, unless the test answers). */
function heldPage(): (value: LoadResult) => void {
  let answer: (value: LoadResult) => void = () => undefined;
  h.fetchActivityEntries.mockReturnValue(
    new Promise<LoadResult>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

describe('Activity: boxes only when nothing is held', () => {
  it('nothing saved: the first frame is the card boxes, never a zero state', () => {
    heldPage();
    render('/notifications', <NotificationsPage />);
    expect(activityBoxes()).not.toBeNull();
    expect(document.querySelectorAll('[data-activity-box]').length).toBeGreaterThan(0);
    expect(text()).not.toContain('shows up here');
    // The boxes sweep (the shared Bone); nothing pulses or fades.
    expect(document.body.innerHTML).toContain('mv-bone');
    expect(document.body.innerHTML).not.toMatch(/animate-pulse|transition-opacity/);
  });

  it('a page one saved on the device: the first frame is the rows, no box', async () => {
    mem.rows.set(ALL_KEY, {
      key: ALL_KEY,
      value: { ok: true, data: [item({ id: 'e1', title: 'Q3 Launch' })] } satisfies LoadResult,
      savedAt: Date.now(),
      userId: 'u1',
      workspaceId: 'w1',
      appVersion: appVersion(),
      size: 1,
    });
    await act(async () => {
      await hydrateSessionReads('u1');
    });
    heldPage();
    render('/notifications', <NotificationsPage />);
    expect(text()).toContain('Q3 Launch');
    expect(activityBoxes()).toBeNull();
    expect(anyBoxes()).toBeNull();
  });

  it('a page one read this session: a return paints the rows at once, no box', async () => {
    h.fetchActivityEntries.mockResolvedValue({
      ok: true,
      data: [item({ id: 'e1', title: 'Q3 Launch' })],
    });
    render('/notifications', <NotificationsPage />);
    await settle();
    expect(text()).toContain('Q3 Launch');
    unmount();
    heldPage();
    render('/notifications', <NotificationsPage />);
    expect(text()).toContain('Q3 Launch');
    expect(activityBoxes()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plan tab (phone: useIsLaptop is false under jsdom's matchMedia)

function planData(): PlanTabData {
  return {
    bundles: [],
    posts: [],
    thumbs: { posts: {}, concepts: {} },
    anyPlan: true,
    timeZone: 'UTC',
    nextCursor: null,
  };
}

const planBoxes = (): Element | null =>
  document.querySelector('[data-box-skeleton][data-plan-tab-loading]');

describe('Plan tab: boxes only when nothing is held', () => {
  it('the first visit with nothing held: the plan-card boxes', () => {
    h.readPlanTab.mockReturnValue(new Promise<Result<PlanTabData>>(() => undefined));
    render('/plan', <PlanTabPage />);
    expect(planBoxes()).not.toBeNull();
    expect(document.querySelectorAll('[data-plan-tab-box]').length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toContain('min-h-80');
  });

  it('a return to the tab paints the kept read at once: no box', async () => {
    h.readPlanTab.mockResolvedValue({ ok: true, data: planData() });
    render('/plan', <PlanTabPage />);
    await settle();
    expect(planBoxes()).toBeNull();
    unmount();
    // The refresh behind the kept read never answers: the kept read still paints.
    h.readPlanTab.mockReturnValue(new Promise<Result<PlanTabData>>(() => undefined));
    render('/plan', <PlanTabPage />);
    expect(planBoxes()).toBeNull();
    expect(anyBoxes()).toBeNull();
  });
});
