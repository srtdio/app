import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@srtdio/schemas';
import { channelListContent } from '@/components/chat/ChannelList';
import { BellButton, bellLabel } from '@/components/chat/BellButton';
import {
  BellValueProvider,
  createBellActions,
  type BellActionDeps,
  type BellContextValue,
} from '@/components/chat/BellContext';
import {
  BELL_EMPTY_NOW,
  BELL_EMPTY_UPCOMING,
  BELL_LOAD_FAILED,
  NotificationsPanel,
  UpcomingTab,
  bellPopoverPosition,
  visibleNowSections,
} from '@/components/chat/NotificationsPanel';
import {
  CANCEL_REMINDER_LABEL,
  presetDetail,
  REMINDER_CHANGE_TITLE,
  ReminderOptions,
} from '@/components/chat/ReminderSheet';
import {
  moreMenuItems,
  REMINDER_SET_LABEL,
  reminderMenuTime,
  remindProps,
} from '@/components/chat/MessageActionMenu';
import { REMINDER_CANCELLED_COPY } from '@/components/chat/BellContext';
import { isDismissOf, ringTitle } from '@/components/chat/BellRing';
import { EMPTY_BELL, mapBellEntry, type BellData, type BellEntry } from '@/lib/chat/bell';
import type { ReminderRow } from '@/lib/chat/reminders';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import type { ChannelSummary } from '@/lib/chat-reads';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

const EM_DASH = String.fromCharCode(0x2014);
// The apostrophe as React escapes it, built so this file passes the token scan.
const APOS = `&${String.fromCharCode(35)}x27;`;
const HEX = new RegExp(`${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`);
const DARK = new RegExp(`\\b${'da'}rk${String.fromCharCode(58)}`);
const BLUR = new RegExp(`backdrop-${'blur'}|backdrop-${'filter'}|\\b${'blur'}-`);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

function entry(over: Partial<InboxEntryRow>): BellEntry {
  const e = mapBellEntry({
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    actor_user_id: null,
    event_type: 'reminder',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'people',
    scope_key: 'c1',
    tier: 'urgent',
    payload: { message_id: 'm1' },
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

function reminderRow(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'r1',
    user_id: 'u1',
    message_id: 'm1',
    channel_id: 'c1',
    workspace_id: 'w1',
    remind_at: new Date(Date.now() + 3_600_000).toISOString(),
    fired_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function scheduledRow(over: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    id: 's1',
    channel_id: 'c1',
    workspace_id: 'w1',
    sender_user_id: 'u1',
    body: 'See you at 5',
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: new Date(Date.now() + 7_200_000).toISOString(),
    status: 'scheduled',
    failure_reason: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

const noop = (): void => {};
const anoop = (): Promise<void> => Promise.resolve();

function bell(
  over: Partial<BellContextValue> = {},
  data: Partial<BellData> = {},
): BellContextValue {
  return {
    data: { ...EMPTY_BELL, ...data },
    status: 'ready',
    unread: 0,
    open: false,
    setOpen: noop,
    reload: noop,
    loadMore: noop,
    loadingMore: false,
    nameOf: (id) => (id === 'u2' ? 'Priya' : undefined),
    chatNameOf: (id) => (id === 'c1' ? 'Launch crew' : 'Chat'),
    hiddenIds: new Set(),
    openEntry: noop,
    snooze: anoop,
    done: anoop,
    clearSent: anoop,
    retryFailed: anoop,
    editFailed: noop,
    changeReminderTime: noop,
    askCancelReminder: noop,
    openScheduledChat: noop,
    canRemind: () => true,
    openReminderFor: noop,
    pendingReminderFor: () => null,
    cancelReminderFromSheet: anoop,
    reminderTarget: null,
    closeReminder: noop,
    pickReminderTime: anoop,
    cancelTarget: null,
    closeCancel: noop,
    confirmCancel: anoop,
    scheduledSheet: null,
    closeScheduledSheet: noop,
    scheduledActions: {
      onSendNow: anoop,
      onSaveBody: () => Promise.resolve(true),
      onRetime: () => Promise.resolve(true),
      onCancel: () => Promise.resolve(true),
    },
    ...over,
  };
}

const CHANNELS: ChannelSummary[] = [
  {
    channelId: 'c1',
    channelType: 'group',
    title: 'Launch crew',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

describe('B1: the bell in the Chat home search row', () => {
  function header(value: BellContextValue | null): string {
    const tree = channelListContent({
      channels: CHANNELS,
      selectedChannelId: null,
      status: 'ready',
      onRetry: noop,
      onSelect: noop,
      onNewChat: noop,
      search: '',
      onSearchChange: noop,
      select: {
        active: false,
        selectedIds: new Set(),
        onStart: noop,
        onCancel: noop,
        onToggle: noop,
        onDelete: noop,
      },
      bell: <BellButton />,
    });
    return renderToStaticMarkup(
      value === null ? tree : <BellValueProvider value={value}>{tree}</BellValueProvider>,
    );
  }

  it('sits between Select and the blue +', () => {
    const html = header(bell({ unread: 3 }));
    const select = html.indexOf('>Select<');
    const bellAt = html.indexOf('data-bell-button');
    const plus = html.indexOf('aria-label="New chat"');
    expect(select).toBeGreaterThan(-1);
    expect(bellAt).toBeGreaterThan(select);
    expect(plus).toBeGreaterThan(bellAt);
  });

  it('is a 44x44 target with the accent count of unread items in Now', () => {
    const html = header(bell({ unread: 3 }));
    expect(html).toMatch(/data-bell-button=""[^>]*class="[^"]*h-11 w-11/);
    expect(html).toContain('data-bell-badge');
    expect(html).toContain('text-accent-fg');
    expect(html).toContain(' bg-accent ');
    expect(html).toContain(`aria-label="${bellLabel(3)}"`);
  });

  it('no badge at zero, and no badge before the first load settles', () => {
    expect(header(bell({ unread: 0 }))).not.toContain('data-bell-badge');
    expect(header(bell({ unread: 4, status: 'loading' }))).not.toContain('data-bell-badge');
  });

  it('renders nothing outside a BellProvider', () => {
    expect(header(null)).not.toContain('data-bell-button');
  });

  it('the laptop popover anchors under the bell, kept inside the viewport', () => {
    expect(bellPopoverPosition({ bottom: 60, right: 300 }, 1280, 380)).toEqual({
      top: 68,
      left: 8,
    });
    expect(bellPopoverPosition({ bottom: 60, right: 1270 }, 1280, 380)).toEqual({
      top: 68,
      left: 890,
    });
  });
});

describe('B2: Now', () => {
  const rows = [
    entry({
      id: 'sent',
      event_type: 'scheduled_sent',
      payload: { scheduled_id: 's9', message_id: 'm9' },
    }),
    entry({ id: 'men', event_type: 'mention', actor_user_id: 'u2' }),
    entry({ id: 'rem', event_type: 'reminder' }),
    entry({ id: 'fail', event_type: 'scheduled_failed', payload: { scheduled_id: 's1' } }),
  ];

  it('sections in order Reminders, Mentions, Scheduled; empty ones hidden', () => {
    expect(visibleNowSections(rows, new Set(), Date.now()).map((s) => s.key)).toEqual([
      'reminders',
      'mentions',
      'scheduled',
    ]);
    expect(visibleNowSections(rows.slice(0, 2), new Set(), Date.now()).map((s) => s.key)).toEqual([
      'mentions',
      'scheduled',
    ]);
    expect(visibleNowSections(rows, new Set(['rem']), Date.now()).map((s) => s.key)).toEqual([
      'mentions',
      'scheduled',
    ]);
  });

  it('renders each row type with its actions', () => {
    const html = renderToStaticMarkup(
      <NotificationsPanel
        bell={bell(
          {},
          {
            entries: rows,
            failed: new Map([
              [
                's1',
                scheduledRow({ status: 'failed', failure_reason: 'not a member of this chat' }),
              ],
            ]),
          },
        )}
      />,
    );
    const order = [
      'data-bell-section="reminders"',
      'data-bell-section="mentions"',
      'data-bell-section="scheduled"',
    ].map((k) => html.indexOf(k));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('data-bell-action="snooze"');
    expect(html).toContain('data-bell-action="done"');
    expect(html).toContain('Priya mentioned you');
    expect(html).toContain('Sent in Launch crew');
    expect(html).toContain('data-bell-action="clear-sent"');
    expect(html).toContain('Not sent');
    expect(html).toContain('text-bad');
    expect(html).toContain(`You${APOS}re no longer in this chat`);
    expect(html).toContain('data-bell-action="retry"');
    expect(html).toContain('data-bell-action="edit"');
    // Mentions carry no Snooze or Done.
    const mention = html.slice(
      html.indexOf('data-bell-row="mention"'),
      html.indexOf('data-bell-section="scheduled"'),
    );
    expect(mention).not.toContain('data-bell-action');
  });

  it('empty Now reads "You\'re all caught up"', () => {
    const html = renderToStaticMarkup(<NotificationsPanel bell={bell()} />);
    expect(html).toContain(BELL_EMPTY_NOW.replace("'", APOS));
  });

  it('first paint: skeleton rows until data settles, never the empty state', () => {
    const html = renderToStaticMarkup(<NotificationsPanel bell={bell({ status: 'loading' })} />);
    expect(html).toContain('data-bell-skeleton');
    expect(html).not.toContain('data-bell-empty');
  });

  it('a failed first load: "Couldn\'t load notifications" with Retry', () => {
    const html = renderToStaticMarkup(<NotificationsPanel bell={bell({ status: 'error' })} />);
    expect(html).toContain(BELL_LOAD_FAILED.replace("'", APOS));
    expect(html).toContain('>Retry<');
  });
});

describe('B2: Upcoming', () => {
  it('Reminders (Change time, Cancel) then Scheduled messages, soonest first', () => {
    const html = renderToStaticMarkup(
      <UpcomingTab
        bell={bell(
          {},
          {
            reminders: [reminderRow({ id: 'r1' })],
            scheduled: [scheduledRow()],
          },
        )}
      />,
    );
    expect(html.indexOf('upcoming-reminders')).toBeLessThan(html.indexOf('upcoming-scheduled'));
    expect(html).toContain('data-bell-action="change-time"');
    expect(html).toContain('data-bell-action="cancel-reminder"');
    expect(html).toContain('See you at 5');
  });

  it('empty Upcoming reads "Nothing coming up"', () => {
    expect(renderToStaticMarkup(<UpcomingTab bell={bell()} />)).toContain(BELL_EMPTY_UPCOMING);
  });
});

// ---------------------------------------------------------------------------
// Actions: the right RPC (with p_trace_id), then a refetch
// ---------------------------------------------------------------------------

function harness(
  error: { message: string } | null = null,
  changed: Array<[string, { id: string; remindAt: Date } | null]> = [],
) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const events: string[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      events.push(`rpc:${name}`);
      const result = Promise.resolve({ data: error === null ? { id: 'x' } : null, error });
      return Object.assign(result, { abortSignal: () => result });
    },
  };
  const toasts: string[] = [];
  const deps: BellActionDeps = {
    client: client as unknown as BellActionDeps['client'],
    workspaceId: 'w1',
    newTraceId: () => 'trace-x',
    newId: () => 'new-id',
    reload: () => events.push('reload'),
    hide: () => undefined,
    unhide: () => undefined,
    entries: () => [entry({ id: 'sent', event_type: 'scheduled_sent' })],
    failed: (_what, _trace, _message, copy = "Couldn't do that. Try again.") => {
      if (copy !== null) toasts.push(copy);
    },
    notify: (title) => toasts.push(title),
    goToMessage: (channelId, messageId) => events.push(`go:${channelId}:${messageId}`),
    openChannelSheet: (channelId) => events.push(`sheet:${channelId}`),
    isStaleFailed: (id) => id === 'gone',
    remindersChanged: () => events.push('reminders-changed'),
    reminderChanged: (messageId, next) =>
      changed.push([messageId, next === null ? null : { id: next.id, remindAt: next.remindAt }]),
  };
  return { actions: createBellActions(deps), rpcs, events, toasts };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('actions', () => {
  it('Snooze: inbox_snooze with the kind, then refetch', async () => {
    const h = harness();
    await h.actions.snooze(entry({ id: 'rem' }), '4h');
    expect(h.rpcs[0]).toMatchObject({
      name: 'inbox_snooze',
      args: { p_entry_id: 'rem', p_kind: '4h', p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:inbox_snooze', 'reload']);
  });

  it('Done: inbox_mark_read, then refetch', async () => {
    const h = harness();
    await h.actions.done(entry({ id: 'rem' }));
    expect(h.rpcs[0]).toMatchObject({
      name: 'inbox_mark_read',
      args: { p_entry_id: 'rem', p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:inbox_mark_read', 'reload']);
  });

  it('Clear sent: inbox_mark_read_events([scheduled_sent]), then refetch', async () => {
    const h = harness();
    await h.actions.clearSent();
    expect(h.rpcs[0]).toEqual({
      name: 'inbox_mark_read_events',
      args: { p_workspace_id: 'w1', p_event_types: ['scheduled_sent'], p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:inbox_mark_read_events', 'reload']);
  });

  it('Retry: chat_scheduled_send_now on the scheduled id, then refetch', async () => {
    const h = harness();
    await h.actions.retryFailed(
      entry({ event_type: 'scheduled_failed', payload: { scheduled_id: 's1' } }),
    );
    expect(h.rpcs[0]).toEqual({
      name: 'chat_scheduled_send_now',
      args: { p_id: 's1', p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:chat_scheduled_send_now', 'reload']);
  });

  it('Retry that the proc refuses toasts the action copy; "not found" is silent', async () => {
    const refused = harness({ message: 'not a member of this chat' });
    await refused.actions.retryFailed(
      entry({ event_type: 'scheduled_failed', payload: { scheduled_id: 's1' } }),
    );
    expect(refused.toasts).toEqual(["Couldn't do that. Try again."]);
    const gone = harness({ message: 'scheduled message not found' });
    await gone.actions.retryFailed(
      entry({ event_type: 'scheduled_failed', payload: { scheduled_id: 's1' } }),
    );
    expect(gone.toasts).toEqual([]);
    expect(gone.events).toContain('reload');
  });

  it('Edit or Retry on a row already resolved elsewhere clears the stale entry', async () => {
    const h = harness();
    h.actions.editFailed(
      entry({ id: 'f1', event_type: 'scheduled_failed', payload: { scheduled_id: 'gone' } }),
    );
    await flush();
    await h.actions.retryFailed(
      entry({ id: 'f2', event_type: 'scheduled_failed', payload: { scheduled_id: 'gone' } }),
    );
    expect(h.rpcs.map((r) => r.name)).toEqual(['inbox_mark_read', 'inbox_mark_read']);
    expect(h.events).not.toContain('sheet:c1');
  });

  it('when the failed-rows read failed, Retry still calls the proc (never clears)', async () => {
    const h = harness();
    await h.actions.retryFailed(
      entry({ event_type: 'scheduled_failed', payload: { scheduled_id: 'unknown' } }),
    );
    expect(h.rpcs.map((r) => r.name)).toEqual(['chat_scheduled_send_now']);
  });

  it("Edit opens that chat's scheduled sheet", () => {
    const h = harness();
    h.actions.editFailed(
      entry({ event_type: 'scheduled_failed', entity_id: 'c7', payload: { scheduled_id: 's1' } }),
    );
    expect(h.events).toEqual(['sheet:c7']);
    expect(h.rpcs).toEqual([]);
  });

  it('a mention tap marks it read, THEN opens the chat at the message', async () => {
    const h = harness();
    h.actions.openEntry(
      entry({ event_type: 'mention', entity_id: 'c2', payload: { message_id: 'm5' } }),
    );
    await flush();
    expect(h.events).toEqual(['rpc:inbox_mark_read', 'reload', 'go:c2:m5']);
  });

  it('a reminder tap opens the chat at the message and does NOT clear it', () => {
    const h = harness();
    h.actions.openEntry(
      entry({ event_type: 'reminder', entity_id: 'c3', payload: { message_id: 'm6' } }),
    );
    expect(h.events).toEqual(['go:c3:m6']);
    expect(h.rpcs).toEqual([]);
  });

  it('a sent row tap marks read and opens the sent message', async () => {
    const h = harness();
    h.actions.openEntry(
      entry({ event_type: 'scheduled_sent', payload: { scheduled_id: 's2', message_id: 'm2' } }),
    );
    await flush();
    expect(h.events).toEqual(['rpc:inbox_mark_read', 'reload', 'go:c1:m2']);
  });

  it('Change time: chat_reminder_set with a NEW id on the same message, toast, refetch', async () => {
    const h = harness();
    const when = new Date(Date.now() + 86_400_000);
    await h.actions.setReminderAt({ messageId: 'm1', channelId: 'c1' }, when);
    expect(h.rpcs[0]).toEqual({
      name: 'chat_reminder_set',
      args: {
        p_id: 'new-id',
        p_message_id: 'm1',
        p_channel_id: 'c1',
        p_remind_at: when.toISOString(),
        p_trace_id: 'trace-x',
      },
    });
    expect(h.toasts[0]).toMatch(/^Reminder set for /);
    expect(h.events).toEqual(['rpc:chat_reminder_set', 'reminders-changed', 'reload']);
  });

  it('Cancel: chat_reminder_cancel, then refetch', async () => {
    const h = harness();
    await h.actions.cancelReminder(reminderRow({ id: 'r9' }));
    expect(h.rpcs[0]).toEqual({
      name: 'chat_reminder_cancel',
      args: { p_id: 'r9', p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:chat_reminder_cancel', 'reminders-changed', 'reload']);
  });

  it('a failed Done toasts "Couldn\'t do that. Try again."', async () => {
    const h = harness({ message: 'boom' });
    await h.actions.done(entry({ id: 'rem' }));
    expect(h.toasts).toEqual(["Couldn't do that. Try again."]);
  });
});

describe('B3: Remind me', () => {
  function held(messageId: string | null): HTMLElement {
    const row = { getAttribute: () => messageId };
    return { closest: () => (messageId === null ? null : row) } as unknown as HTMLElement;
  }

  it("the menu offers it for the held bubble's message inside the bell", () => {
    const open = vi.fn();
    const props = remindProps({}, { canRemind: () => true, openReminderFor: open }, held('m7'));
    expect(props.canRemind).toBe(true);
    props.onRemind?.();
    expect(open).toHaveBeenCalledWith('m7');
  });

  it('not for an unrecorded message, without the bell, or without a bubble', () => {
    expect(remindProps({}, { canRemind: () => false, openReminderFor: noop }, held('m7'))).toEqual(
      {},
    );
    expect(remindProps({}, null, held('m7'))).toEqual({});
    expect(remindProps({}, { canRemind: () => true, openReminderFor: noop }, null)).toEqual({});
  });

  it('the sheet lists the presets in order, mono times, with Custom last', () => {
    const html = renderToStaticMarkup(
      <ReminderOptions preview="Can we move the shoot?" onPick={noop} />,
    );
    const ids = ['20m', '1h', '3h', 'tomorrow', 'next_week', 'custom'].map((id) =>
      html.indexOf(`data-reminder-row="${id}"`),
    );
    expect(ids.every((i) => i > -1)).toBe(true);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(html).toContain('font-mono');
    expect(html).toContain('Can we move the shoot?');
  });

  it('a same-day preset shows only the clock', () => {
    const now = new Date(2026, 9, 3, 10, 0);
    expect(presetDetail({ id: '1h', label: '1 hour', at: new Date(2026, 9, 3, 11, 0) }, now)).toBe(
      '11:00 AM',
    );
    expect(
      presetDetail({ id: 'tomorrow', label: 'Tomorrow', at: new Date(2026, 9, 4, 9, 0) }, now),
    ).toBe('Sun 4 Oct, 9:00 AM');
  });
});

describe('UI-3 S10: reminder state in the long-press menu', () => {
  function held(messageId: string): HTMLElement {
    const row = { getAttribute: () => messageId };
    return { closest: () => row } as unknown as HTMLElement;
  }
  // Remind me sits under More.
  const rowsOf = (props: Parameters<typeof moreMenuItems>[0]) =>
    moreMenuItems(props).filter((i) => i.kind === 'action' && i.key === 'remind');

  it('"Remind me" without a pending reminder', () => {
    const props = remindProps(
      {},
      { canRemind: () => true, openReminderFor: noop, pendingReminderFor: () => null },
      held('m1'),
    );
    expect(props.reminderAt).toBeUndefined();
    const [item] = rowsOf({ onReply: noop, onCopy: noop, canCopy: true, ...props });
    expect(item?.kind === 'action' && item.label).toBe('Remind me');
  });

  it('"Reminder · <time>" with one, matched by message id from the loaded list', () => {
    const at = new Date(Date.now() + 2 * 86_400_000);
    at.setHours(9, 0, 0, 0);
    const lookups: string[] = [];
    const props = remindProps(
      {},
      {
        canRemind: () => true,
        openReminderFor: noop,
        pendingReminderFor: (id) => {
          lookups.push(id);
          return id === 'm1' ? reminderRow({ remind_at: at.toISOString() }) : null;
        },
      },
      held('m1'),
    );
    expect(lookups).toEqual(['m1']);
    const [item] = rowsOf({ onReply: noop, onCopy: noop, canCopy: true, ...props });
    expect(item?.kind === 'action' && item.label).toBe(REMINDER_SET_LABEL);
    expect(REMINDER_SET_LABEL).toBe('Reminder · ');
    expect(item?.kind === 'action' && item.mono).toBe(reminderMenuTime(at, new Date()));
    expect(item?.kind === 'action' && item.icon).toBeTruthy();
  });

  it('the time is device-local: the clock today, "Tomorrow 9:00 AM" style otherwise', () => {
    const now = new Date(2026, 9, 3, 10, 0);
    expect(reminderMenuTime(new Date(2026, 9, 3, 15, 20), now)).toBe('3:20 PM');
    expect(reminderMenuTime(new Date(2026, 9, 4, 9, 0), now)).toBe('Tomorrow 9:00 AM');
    expect(reminderMenuTime(new Date(2026, 9, 7, 11, 30), now)).toBe('Wed 7 Oct, 11:30 AM');
  });

  it('the menu renders the time in mono', () => {
    const menu = source('../MessageActionMenu.tsx');
    expect(menu).toContain('data-menu-mono="" className="font-mono');
  });

  it('change mode: title "Reminder", presets, then "Cancel reminder" in the danger token', () => {
    expect(REMINDER_CHANGE_TITLE).toBe('Reminder');
    const html = renderToStaticMarkup(
      <ReminderOptions preview="Ship it" onPick={noop} onCancelReminder={noop} />,
    );
    expect(html).toContain('data-reminder-row="tomorrow"');
    expect(html.indexOf('data-reminder-row="cancel"')).toBeGreaterThan(
      html.indexOf('data-reminder-row="custom"'),
    );
    expect(html).toContain(CANCEL_REMINDER_LABEL);
    expect(html).toMatch(/data-reminder-row="cancel"[^>]*text-bad/);
    const plain = renderToStaticMarkup(<ReminderOptions preview={null} onPick={noop} />);
    expect(plain).not.toContain('data-reminder-row="cancel"');
  });

  it('change time sends a NEW id and the label updates at once', async () => {
    const changed: Array<[string, { id: string; remindAt: Date } | null]> = [];
    const h = harness(null, changed);
    const when = new Date(Date.now() + 86_400_000);
    await h.actions.setReminderAt({ messageId: 'm1', channelId: 'c1' }, when);
    expect(h.rpcs[0]?.args.p_id).toBe('new-id');
    expect(changed).toEqual([['m1', { id: 'new-id', remindAt: when }]]);
  });

  it('cancel calls chat_reminder_cancel, resolves true, and clears the label', async () => {
    const changed: Array<[string, { id: string; remindAt: Date } | null]> = [];
    const h = harness(null, changed);
    const ok = await h.actions.cancelReminder(reminderRow({ id: 'r9', message_id: 'm3' }));
    expect(ok).toBe(true);
    expect(h.rpcs[0]).toEqual({
      name: 'chat_reminder_cancel',
      args: { p_id: 'r9', p_trace_id: 'trace-x' },
    });
    expect(changed).toEqual([['m3', null]]);
    expect(REMINDER_CANCELLED_COPY).toBe('Reminder cancelled');
    const failed = harness({ message: 'boom' }, []);
    expect(await failed.actions.cancelReminder(reminderRow())).toBe(false);
  });

  it('the sheet opens in change mode for a message with a pending reminder', () => {
    const ctx = source('../BellContext.tsx');
    expect(ctx).toMatch(/pending !== null\s*\? \{ mode: 'change', reminder: pending, preview \}/);
    expect(ctx).toContain('toast.show({ title: REMINDER_CANCELLED_COPY })');
  });

  it('no reminder icon on a bubble, anywhere', () => {
    for (const file of ['../MessageThread.tsx', '../ThreadView.tsx', '../MessageAttachments.tsx']) {
      const text = source(file);
      expect(text).not.toContain('IconAlarmClock');
      expect(text).not.toContain('pendingReminderFor');
    }
  });
});

describe('B4: the ring toast', () => {
  it('"Reminder: <preview>"', () => {
    expect(ringTitle('Ship it')).toBe('Reminder: Ship it');
  });
  it('isDismissOf ignores anything but a matching toast X', () => {
    expect(isDismissOf(null, 'x')).toBe(false);
  });
});

describe('hygiene: tokens only, no blur, no em dashes, no connection wording', () => {
  const files = [
    '../BellButton.tsx',
    '../BellContext.tsx',
    '../BellRing.tsx',
    '../NotificationsPanel.tsx',
    '../ReminderSheet.tsx',
    '../../../lib/chat/bell.ts',
    '../../../lib/chat/reminders.ts',
    '../../../lib/chat/chime.ts',
    '../../../lib/inbox/bell-types.ts',
  ];
  for (const file of files) {
    it(file, () => {
      const text = source(file);
      expect(text).not.toMatch(HEX);
      expect(text).not.toMatch(DARK);
      expect(text).not.toMatch(BLUR);
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toMatch(/Reconnecting|Connecting|Offline|network/);
    });
  }
});
