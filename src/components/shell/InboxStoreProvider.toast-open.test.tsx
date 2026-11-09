// @vitest-environment jsdom
// A toast tap opens the real place (9 Nov 2026): the same deep link an
// Activity line opens (openAction), at the comment, never catch up.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { shown, next } = vi.hoisted(() => ({
  shown: [] as { title: string; onPress?: () => void }[],
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
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: null }),
  workspaceDisplayName: (name: string) => name,
}));
vi.mock('@/components/ui/toast', () => {
  const api = {
    show: (spec: { title: string; onPress?: () => void }) => {
      shown.push(spec);
    },
  };
  return { useToast: () => api };
});
vi.mock('@/lib/chat/notify-sound', () => ({ playToneShared: () => {} }));
vi.mock('@/lib/tab-alert', () => ({ pushTabAlert: () => {} }));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/inbox/inbox-reads', () => ({
  readActivityBadge: async () => ({ ok: true, data: { unread: 0 } }),
  fetchNewestInboxAt: async () => ({ ok: true, data: '2026-11-09T10:00:00.000Z' }),
  fetchInboxSince: async () => {
    const rows = next.rows;
    next.rows = [];
    return { ok: true, data: { rows, activityCount: rows.length } };
  },
  enrichNewRows: async () => ({ count: 1, lead: null }),
}));

import { InboxStoreProvider } from '@/components/shell/InboxStoreProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const where = { path: '' };

function Where(): null {
  const location = useLocation();
  where.path = `${location.pathname}${location.search}`;
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T10:10:00.000Z'));
  shown.length = 0;
  next.rows = [];
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

describe('toast tap opens the real place', () => {
  it('a comment toast goes to the comment, not catch up', async () => {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <InboxStoreProvider>
            <Where />
          </InboxStoreProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    next.rows = [
      {
        id: 'e1',
        workspace_id: 'ws-1',
        user_id: 'u1',
        event_type: 'comment',
        entity_type: 'post',
        entity_id: 'p1',
        scope: 'posts',
        tier: 'normal',
        created_at: '2026-11-09T10:05:00.000Z',
        read_at: null,
        snoozed_until: null,
        payload: { comment_id: 'c1' },
        actor_user_id: 'u2',
        scope_key: null,
      },
    ];
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    const toast = shown.at(-1);
    expect(toast).toBeDefined();
    act(() => toast?.onPress?.());
    expect(where.path).toContain('comment=c1');
    expect(where.path).toContain('p1');
    expect(where.path).not.toMatch(/catchup/i);
  });
});
