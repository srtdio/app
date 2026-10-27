// @vitest-environment jsdom
// The pending reminders read (chat_message_reminders, workspace-wide, limit
// 1000): the shell's ReminderRing and the chat's Remind me used to read it
// separately, each on mount, on visibilitychange and on every inbox tick.
// Counted on a recording client: one shared read for both, one per return to
// the app, one per "reminders changed", only the columns the two use, and a
// reminder due while the app runs still rings on time.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

const { db, toasts } = vi.hoisted(() => {
  const queries: Array<{ table: string; select: unknown; workspaceId: unknown }> = [];
  // Answers by table; the reminders answer is set per test.
  const answers: { reminders: unknown[] } = { reminders: [] };
  const from = (table: string): unknown => {
    const query = { table, select: undefined as unknown, workspaceId: undefined as unknown };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const m of ['eq', 'is', 'in', 'gt', 'order', 'limit', 'abortSignal']) {
      builder[m] = (...args: unknown[]) => {
        if (m === 'eq' && args[0] === 'workspace_id') query.workspaceId = args[1];
        return builder;
      };
    }
    builder.select = (columns: unknown) => {
      query.select = columns;
      return builder;
    };
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: table === 'chat_message_reminders' ? answers.reminders : [],
        error: null,
      }).then(resolve);
    return builder;
  };
  return {
    db: { client: { from } as unknown, queries, answers },
    toasts: [] as string[],
  };
});

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: db.client }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => {
  const api = { show: (spec: { title: string }) => void toasts.push(spec.title) };
  return { useToast: () => api };
});
vi.mock('@/lib/chat/chime', () => ({
  createChime: () => ({ play: () => {}, stop: () => {}, dispose: () => {} }),
}));

import {
  PENDING_REMINDER_COLUMNS,
  announceRemindersChanged,
  readSharedPendingReminders,
  resetSharedPendingReminders,
} from '@/lib/chat/reminders';
import { ReminderRing } from '@/components/chat/ReminderRing';
import { ReminderProvider } from '@/components/chat/ReminderContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'u1';
const WS = 'ws-1';

function reminderReads(): Array<{ select: unknown; workspaceId: unknown }> {
  return db.queries.filter((q) => q.table === 'chat_message_reminders');
}

function pending(id: string, remindAt: string) {
  return {
    id,
    message_id: `m-${id}`,
    channel_id: 'c1',
    remind_at: remindAt,
    fired_at: null,
    cancelled_at: null,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mountBoth(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <MemoryRouter>
        <ReminderRing workspaceId={WS} userId={ME} />
        <ReminderProvider
          workspaceId={WS}
          currentUserId={ME}
          openChannelId="c1"
          messages={[]}
          nameOf={() => undefined}
        >
          <span />
        </ReminderProvider>
      </MemoryRouter>,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  db.queries.length = 0;
  db.answers.reminders = [];
  toasts.length = 0;
  resetSharedPendingReminders();
  try {
    window.localStorage.clear();
  } catch {
    // Storage off: nothing kept.
  }
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('one pending-reminders read for the ring and the chat', () => {
  it('mount: one read for both, with only the columns they use', async () => {
    mountBoth();
    await flush();
    expect(reminderReads()).toHaveLength(1);
    expect(reminderReads()[0]?.select).toBe(PENDING_REMINDER_COLUMNS);
    expect(PENDING_REMINDER_COLUMNS).toBe(
      'id, message_id, channel_id, remind_at, fired_at, cancelled_at',
    );
  });

  it('a return to the app: one read (not one per reader)', async () => {
    mountBoth();
    await flush();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(reminderReads()).toHaveLength(2);
  });

  it('reminders changed (a write, a ring, a tick with new rows): one read', async () => {
    mountBoth();
    await flush();
    act(() => announceRemindersChanged());
    await flush();
    expect(reminderReads()).toHaveLength(2);
    act(() => announceRemindersChanged());
    await flush();
    expect(reminderReads()).toHaveLength(3);
  });

  it('a reminder due while the app runs still rings on the minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
    db.answers.reminders = [pending('r1', '2026-10-27T10:01:00.000Z')];
    mountBoth();
    await flush();
    expect(toasts).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(toasts).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/^Reminder: /);
  });
});

describe('readSharedPendingReminders', () => {
  const client = (): Client => db.client as Client;

  it('one cause is one read, whoever asks; a new cause reads again', async () => {
    const cause = new Event('visibilitychange');
    await Promise.all([
      readSharedPendingReminders(client(), { userId: ME, workspaceId: WS, cause }),
      readSharedPendingReminders(client(), { userId: ME, workspaceId: WS, cause }),
      readSharedPendingReminders(client(), { userId: ME, workspaceId: WS }),
    ]);
    expect(reminderReads()).toHaveLength(1);
    await readSharedPendingReminders(client(), {
      userId: ME,
      workspaceId: WS,
      cause: new Event('visibilitychange'),
    });
    expect(reminderReads()).toHaveLength(2);
  });

  it('a late answer for the old workspace is never served after a switch', async () => {
    db.answers.reminders = [pending('a1', '2026-10-28T09:00:00.000Z')];
    const a = readSharedPendingReminders(client(), { userId: ME, workspaceId: 'ws-a' });
    const b = readSharedPendingReminders(client(), { userId: ME, workspaceId: 'ws-b' });
    expect(a).not.toBe(b);
    expect(reminderReads().map((q) => q.workspaceId)).toEqual(['ws-a', 'ws-b']);
    await Promise.all([a, b]);
    // Back on ws-b with no cause: its own read answers, not ws-a's.
    const again = readSharedPendingReminders(client(), { userId: ME, workspaceId: 'ws-b' });
    expect(again).toBe(b);
    // Another user in the same workspace never gets this user's read.
    void readSharedPendingReminders(client(), { userId: 'u2', workspaceId: 'ws-b' });
    expect(reminderReads()).toHaveLength(3);
  });
});
