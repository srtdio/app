// @vitest-environment jsdom
// The shell's inbox poll, counted on fake reads. A hidden tab polls every
// 60 s (the background tab alert and tone need it), never asking the
// reminder readers to reload; the return to visible ticks once. A tick that
// finds no new rows asks the reminder readers for nothing (it used to make
// both reload the workspace's reminders every 30 s); a tick with a new row
// asks once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { counts, next } = vi.hoisted(() => ({
  counts: { badge: 0, seed: 0, since: 0, announce: 0 },
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
vi.mock('@/components/chat/ReminderRing', () => ({ ReminderRing: () => null }));
vi.mock('@/lib/chat/notify-sound', () => ({ playToneShared: () => {} }));
vi.mock('@/lib/tab-alert', () => ({ pushTabAlert: () => {} }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/chat/reminders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/reminders')>()),
  announceRemindersChanged: () => {
    counts.announce += 1;
  },
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
  counts.announce = 0;
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
  it('a hidden tab polls every 60 s, no reminder reload; the return reads once', async () => {
    await mount();
    expect(counts).toMatchObject({ badge: 1, seed: 1, since: 0 });
    setHidden(true);
    for (let i = 0; i < 10; i += 1) await advance(POLL_MS);
    expect(counts).toMatchObject({ badge: 6, seed: 1, since: 5, announce: 0 });
    setHidden(false);
    await flush();
    expect(counts).toMatchObject({ badge: 7, since: 6, announce: 0 });
  });

  it('a tick with no new rows asks the reminders nothing; a new row asks once', async () => {
    await mount();
    await advance(POLL_MS);
    expect(counts.since).toBe(1);
    await advance(POLL_MS);
    expect(counts.since).toBe(2);
    expect(counts.announce).toBe(0);
    next.rows = [
      {
        id: 'e1',
        workspace_id: 'ws-1',
        user_id: 'u1',
        actor_user_id: 'u1',
        event_type: 'reminder',
        entity_type: 'chat_message',
        entity_id: 'm1',
        payload: {},
        read_at: '2026-10-27T10:05:00.000Z',
        deleted_at: null,
        created_at: '2026-10-27T10:05:00.000Z',
      },
    ];
    await advance(POLL_MS);
    expect(counts.since).toBe(3);
    expect(counts.announce).toBe(1);
  });

  it('5 min visible and idle: one read per 30 s, never a reminder reload', async () => {
    await mount();
    for (let i = 0; i < 10; i += 1) await advance(POLL_MS);
    expect(counts.since).toBe(10);
    expect(counts.badge).toBe(11);
    expect(counts.announce).toBe(0);
  });
});
