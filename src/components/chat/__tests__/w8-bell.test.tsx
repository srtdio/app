// W8 regressions for the bell and the chat home: the panel header (subtitle and
// Mark all read), plan rows naming the item, shared snooze labels, "Hide chat"
// and the notes tile's last note.

import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: null, workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));

import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@srtdio/schemas';
import {
  createBellActions,
  markAllReadRows,
  type BellActionDeps,
  type BellContextValue,
} from '@/components/chat/BellContext';
import {
  NOTIFICATIONS_SUBTITLE,
  NotificationsPanel,
  planRowPreview,
} from '@/components/chat/NotificationsPanel';
import { hideChatsTitle, notesLastLine } from '@/components/chat/ChannelList';
import {
  BELL_SNOOZE_OPTIONS,
  EMPTY_BELL,
  mapBellEntry,
  type BellData,
  type BellEntry,
} from '@/lib/chat/bell';
import { SNOOZE_OPTIONS } from '@/components/pages/activity/data';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

function entry(over: Partial<InboxEntryRow>): BellEntry {
  const e = mapBellEntry({
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    actor_user_id: 'u2',
    event_type: 'plan_opened',
    entity_type: 'plan',
    entity_id: 'plan1',
    scope: 'posts',
    scope_key: 'plan1',
    tier: 'active',
    payload: { plan_id: 'plan1', plan_title: 'Week of 12 Oct' },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    ...over,
  });
  if (e === null) throw new Error('not a bell row');
  return e;
}

function panel(over: Partial<BellContextValue>): string {
  const data: BellData = { ...EMPTY_BELL, entries: [] };
  const bell = {
    data,
    status: 'ready',
    unread: 0,
    hiddenIds: new Set<string>(),
    nameOf: () => undefined,
    chatNameOf: () => 'Chat',
    markAllRead: async () => undefined,
    ...over,
  } as unknown as BellContextValue;
  return renderToStaticMarkup(<NotificationsPanel bell={bell} />);
}

describe('W8 fix 2: the bell panel header', () => {
  it('reads the subtitle on every open', () => {
    expect(NOTIFICATIONS_SUBTITLE).toBe('Your reminders, mentions and task alerts');
    expect(panel({})).toContain(NOTIFICATIONS_SUBTITLE);
  });

  it('offers a 44px "Mark all read" only while something is unread', () => {
    const on = panel({ unread: 3 });
    expect(on).toContain('data-bell-action="mark-all-read"');
    expect(on).toMatch(/class="h-11[^"]*"[^>]*>Mark all read</);
    expect(panel({ unread: 0 })).not.toContain('data-bell-action="mark-all-read"');
  });

  it('marks every unread Now row read and leaves a failed send', async () => {
    const calls: string[] = [];
    const client = {
      rpc(name: string, args: { p_entry_id?: string }) {
        calls.push(`${name}:${args.p_entry_id ?? ''}`);
        const result = Promise.resolve({ data: null, error: null });
        return Object.assign(result, { abortSignal: () => result });
      },
    };
    const rows = [
      entry({ id: 'p1' }),
      entry({
        id: 'f1',
        event_type: 'scheduled_failed',
        entity_type: 'chat_message',
        payload: { scheduled_id: 's1', channel_id: 'c1' },
      }),
    ];
    expect(markAllReadRows(rows, Date.now()).map((e) => e.id)).not.toContain('f1');
    const deps: BellActionDeps = {
      client: client as unknown as BellActionDeps['client'],
      workspaceId: 'w1',
      newTraceId: () => 't',
      newId: () => 'id',
      reload: () => calls.push('reload'),
      hide: () => undefined,
      unhide: () => undefined,
      entries: () => rows,
      failed: () => undefined,
      notify: () => undefined,
      goToMessage: () => undefined,
      openChannelSheet: () => undefined,
      isStaleFailed: () => false,
      remindersChanged: () => undefined,
    };
    await createBellActions(deps).markAllRead();
    expect(calls).toEqual(['inbox_mark_read:p1', 'reload']);
  });
});

describe('W8 fix 7: small fixes', () => {
  it('a plan row previews the item title, never the plan name again', () => {
    expect(planRowPreview('Carousel')).toBe('Carousel');
    expect(planRowPreview(null)).toBe('');
  });

  it('the bell and Activity share one set of snooze labels', () => {
    expect(BELL_SNOOZE_OPTIONS).toBe(SNOOZE_OPTIONS);
  });

  it('"Delete chat" is now "Hide chat" with matching confirm copy', () => {
    expect(hideChatsTitle(1)).toBe('Hide this chat?');
    expect(hideChatsTitle(3)).toBe('Hide 3 chats?');
  });

  it('the notes tile shows the last note and its time', () => {
    const now = Date.parse('2026-06-14T12:00:00.000Z');
    const line = notesLastLine(
      { lastMessageText: 'Buy film', lastMessageTs: now - 5 * 60_000, unread: 0 },
      now,
      'UTC',
    );
    expect(line?.preview).toBe('Buy film');
    expect(line?.time).not.toBe('');
    expect(notesLastLine(undefined, now, 'UTC')).toBeNull();
    expect(
      notesLastLine({ lastMessageText: '', lastMessageTs: 0, unread: 0 }, now, 'UTC'),
    ).toBeNull();
  });
});
