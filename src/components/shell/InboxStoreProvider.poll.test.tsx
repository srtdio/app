// @vitest-environment jsdom
// The shell's inbox poll, counted on fake reads. A hidden tab polls every
// 60 s (the background tab alert and tone need it); the return to visible
// ticks once. A visible, idle tab reads once per 30 s.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { counts, next } = vi.hoisted(() => ({
  counts: { badge: 0, seed: 0, since: 0 },
  next: { rows: [] as unknown[] },
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/components/ui/toast', () => {
  const api = { show: () => {} };
  return { useToast: () => api };
});
vi.mock('@/components/pages/activity/data', () => ({
  entityHref: () => null,
  mapEntry: (row: unknown) => row,
}));
vi.mock('@/lib/chat/notify-sound', () => ({ playToneShared: () => {} }));
vi.mock('@/lib/tab-alert', () => ({ pushTabAlert: () => {} }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/inbox/inbox-reads', () => ({
  readActivityBadge: async () => {
    counts.badge += 1;
    return { ok: true, data: { unread: 0 } };
  },
  fetchNewestInboxAt: async () => {
    counts.seed += 1;
    return { ok: true, data: '2026-10-27T10:00:00.000Z' };
  },
  fetchInboxSince: async () => {
    counts.since += 1;
    const rows = next.rows;
    next.rows = [];
    return { ok: true, data: { rows, activityCount: rows.length } };
  },
  enrichNewRows: async () => ({ count: 0, lead: null }),
}));

import { InboxStoreProvider } from '@/components/shell/InboxStoreProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POLL_MS = 30_000;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hidden = false;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

function setHidden(value: boolean): void {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T10:10:00.000Z'));
  counts.badge = 0;
  counts.seed = 0;
  counts.since = 0;
  next.rows = [];
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <InboxStoreProvider>
          <span />
        </InboxStoreProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

describe('inbox poll', () => {
  it('a hidden tab polls every 60 s; the return reads once', async () => {
    await mount();
    expect(counts).toMatchObject({ badge: 1, seed: 1, since: 0 });
    setHidden(true);
    for (let i = 0; i < 10; i += 1) await advance(POLL_MS);
    expect(counts).toMatchObject({ badge: 6, seed: 1, since: 5 });
    setHidden(false);
    await flush();
    expect(counts).toMatchObject({ badge: 7, since: 6 });
  });

  it('5 min visible and idle: one read per 30 s', async () => {
    await mount();
    for (let i = 0; i < 10; i += 1) await advance(POLL_MS);
    expect(counts.since).toBe(10);
    expect(counts.badge).toBe(11);
  });
});
