// @vitest-environment jsdom
// Activity's first frame (blink B3): with a page one saved for the chip and
// sort (this session, or on the device and seeded at boot) the first frame is
// the rows, never the loading line; with nothing saved it is the loading line,
// never a zero state. A cold open that mounts the page before the device's
// saved screens are seeded paints them the moment they land (before the read),
// and the read lands over them quietly. The page's own write reaches a chip
// page the device saved but this session has not read yet.
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
  markEntryRead: vi.fn(),
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
  activityPageKey,
  peekActivityPage,
} from '@/components/pages/activity/data';
import { hydrateSessionReads, resetSessionReads } from '@/lib/session-read';
import {
  appVersion,
  setDeviceCacheBackend,
  type CacheBackend,
  type CacheRecord,
} from '@/lib/device-cache';

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

const ALL_KEY = activityPageKey('u1', 'w1', 'all', 'newest');
const MENTIONS_KEY = activityPageKey('u1', 'w1', 'mentions', 'newest');

let mem: ReturnType<typeof memoryBackend>;

/** A page one this device saved in an earlier session. */
function saveOnDevice(key: string, data: ActivityItem[]): void {
  mem.rows.set(key, {
    key,
    value: { ok: true, data } satisfies LoadResult,
    savedAt: Date.now(),
    userId: 'u1',
    workspaceId: 'w1',
    appVersion: appVersion(),
    size: 1,
  });
}

/** The boot's seed of the device's saved screens. */
async function seed(): Promise<void> {
  await act(async () => {
    await hydrateSessionReads('u1');
  });
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

/** The next page one read, answered by hand. */
function heldPage(): (value: LoadResult) => void {
  let answer: (value: LoadResult) => void = () => undefined;
  h.fetchActivityEntries.mockReturnValue(
    new Promise<LoadResult>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

const text = (): string => document.body.textContent ?? '';

beforeEach(async () => {
  resetSessionReads();
  // Let the reset's queued wipe run before the fake device is in place.
  await new Promise((r) => setTimeout(r, 0));
  mem = memoryBackend();
  setDeviceCacheBackend(mem);
  try {
    window.localStorage.clear();
  } catch {
    // Storage can be unavailable; the sort falls back to its default.
  }
  h.fetchActivityEntries.mockReset();
  h.fetchUpcoming.mockReset().mockResolvedValue({ ok: true, data: [] });
  h.readActivityBadge.mockReset().mockResolvedValue({ ok: true, data: { unread: 0, mentions: 0 } });
  h.markEntryRead.mockReset().mockResolvedValue({ ok: true, data: null });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetSessionReads();
  setDeviceCacheBackend(null);
});

describe('Activity first frame: a saved page paints at once', () => {
  it('a device-saved page one is the first frame: rows, no loading line, no zero state', async () => {
    saveOnDevice(ALL_KEY, [item({ id: 'e1', title: 'Q3 Launch' })]);
    await seed();
    const answer = heldPage();
    render();
    expect(text()).toContain('Q3 Launch');
    expect(text()).not.toContain(LOADING_NOTIFICATIONS);
    expect(text()).not.toContain('shows up here');
    // The quiet refresh behind it still reads, and lands while untouched.
    expect(h.fetchActivityEntries).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, data: [item({ id: 'e2', title: 'Fresh one' })] }));
    await settle();
    expect(text()).toContain('Fresh one');
  });

  it('a failed refresh behind a saved page keeps the rows, with no error box', async () => {
    saveOnDevice(ALL_KEY, [item({ id: 'e1', title: 'Q3 Launch' })]);
    await seed();
    const answer = heldPage();
    render();
    await act(async () => answer({ ok: false, error: 'offline' }));
    await settle();
    expect(text()).toContain('Q3 Launch');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('with nothing saved the first frame is the loading line, never a zero state', async () => {
    await seed();
    const answer = heldPage();
    render();
    expect(text()).toContain(LOADING_NOTIFICATIONS);
    expect(text()).not.toContain('shows up here');
    expect(text()).not.toContain(EMPTY_LINES.mentions);
    await act(async () => answer({ ok: true, data: [item({ id: 'e1', title: 'Q3 Launch' })] }));
    await settle();
    expect(text()).toContain('Q3 Launch');
    expect(text()).not.toContain(LOADING_NOTIFICATIONS);
  });
});

describe('Activity first frame: the saved screens seed after the mount', () => {
  it('paints the saved page the moment the seed lands, before the read; the read lands over it', async () => {
    saveOnDevice(ALL_KEY, [item({ id: 'e1', title: 'Q3 Launch' })]);
    const answer = heldPage();
    render();
    expect(text()).toContain(LOADING_NOTIFICATIONS);
    await seed();
    expect(text()).toContain('Q3 Launch');
    expect(text()).not.toContain(LOADING_NOTIFICATIONS);
    expect(text()).not.toContain('shows up here');
    // No second read: the seed only paints.
    expect(h.fetchActivityEntries).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, data: [item({ id: 'e2', title: 'Fresh one' })] }));
    await settle();
    expect(text()).toContain('Fresh one');
  });

  it('a read that lands after a touch is held: the saved rows stay', async () => {
    saveOnDevice(ALL_KEY, [item({ id: 'e1', title: 'Q3 Launch' })]);
    const answer = heldPage();
    render();
    await seed();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => answer({ ok: true, data: [item({ id: 'e2', title: 'Fresh one' })] }));
    await settle();
    expect(text()).toContain('Q3 Launch');
    expect(text()).not.toContain('Fresh one');
  });

  it('a seed with nothing saved for the chip keeps the loading line, never a zero state', async () => {
    saveOnDevice(MENTIONS_KEY, [item({ id: 'm1', title: 'Mention one' })]);
    heldPage();
    render();
    await seed();
    expect(text()).toContain(LOADING_NOTIFICATIONS);
    expect(text()).not.toContain('shows up here');
  });
});

describe("Activity: the page's own write reaches device-saved chip pages", () => {
  it('a mark read edits a saved chip page this session has not read', async () => {
    const entry = item({ id: 'e1', title: 'Q3 Launch' });
    saveOnDevice(ALL_KEY, [entry]);
    saveOnDevice(MENTIONS_KEY, [entry]);
    await seed();
    h.fetchActivityEntries.mockResolvedValue({ ok: true, data: [entry] });
    render();
    await settle();
    const lead = document.querySelector<HTMLElement>('[data-activity-lead]');
    act(() => lead?.click());
    await settle();
    expect(h.markEntryRead).toHaveBeenCalledTimes(1);
    expect(peekActivityPage(MENTIONS_KEY)?.[0]?.readAt).toEqual(expect.any(String));
  });
});
