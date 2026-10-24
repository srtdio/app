// Message reminders in the chat: Remind me from the message menu, the reminder
// sheet (new and change mode with "Cancel reminder"), the writes (a NEW id on
// every set, p_trace_id explicit) and the ring toast. The bell that used to
// list them is gone: a fired reminder shows on Notifications.

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
import {
  REMINDER_CANCELLED_COPY,
  createReminderActions,
  type ReminderActionDeps,
} from '@/components/chat/ReminderContext';
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
import { isDismissOf, ringTitle } from '@/components/chat/ReminderRing';
import type { ReminderRow } from '@/lib/chat/reminders';

const EM_DASH = String.fromCharCode(0x2014);
const HEX = new RegExp(`${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`);
const DARK = new RegExp(`\\b${'da'}rk${String.fromCharCode(58)}`);
const BLUR = new RegExp(`backdrop-${'blur'}|backdrop-${'filter'}|\\b${'blur'}-`);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
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

const noop = (): void => {};

// ---------------------------------------------------------------------------
// The writes: the right RPC (with p_trace_id), then every reader reloads
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
  const deps: ReminderActionDeps = {
    client: client as unknown as ReminderActionDeps['client'],
    newTraceId: () => 'trace-x',
    newId: () => 'new-id',
    failed: (_what, _trace, _message, copy = "Couldn't do that. Try again.") => {
      if (copy !== null) toasts.push(copy);
    },
    notify: (title) => toasts.push(title),
    remindersChanged: () => events.push('reminders-changed'),
    reminderChanged: (messageId, next) =>
      changed.push([messageId, next === null ? null : { id: next.id, remindAt: next.remindAt }]),
  };
  return { actions: createReminderActions(deps), rpcs, events, toasts };
}

describe('reminder writes', () => {
  it('Set: chat_reminder_set with a NEW id on the message, toast, then every reader reloads', async () => {
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
    expect(h.events).toEqual(['rpc:chat_reminder_set', 'reminders-changed']);
  });

  it('Cancel: chat_reminder_cancel, then every reader reloads', async () => {
    const h = harness();
    await h.actions.cancelReminder(reminderRow({ id: 'r9' }));
    expect(h.rpcs[0]).toEqual({
      name: 'chat_reminder_cancel',
      args: { p_id: 'r9', p_trace_id: 'trace-x' },
    });
    expect(h.events).toEqual(['rpc:chat_reminder_cancel', 'reminders-changed']);
  });

  it('a refused set toasts the action copy; "message not found" is silent', async () => {
    const refused = harness({ message: 'boom' });
    await refused.actions.setReminderAt({ messageId: 'm1', channelId: 'c1' }, new Date());
    expect(refused.toasts).toEqual(["Couldn't do that. Try again."]);
    const gone = harness({ message: 'message not found' });
    await gone.actions.setReminderAt({ messageId: 'm1', channelId: 'c1' }, new Date());
    expect(gone.toasts).toEqual([]);
    expect(gone.events).toContain('reminders-changed');
  });
});

describe('B3: Remind me', () => {
  function held(messageId: string | null): HTMLElement {
    const row = { getAttribute: () => messageId };
    return { closest: () => (messageId === null ? null : row) } as unknown as HTMLElement;
  }

  it("the menu offers it for the held bubble's message inside the reminders", () => {
    const open = vi.fn();
    const props = remindProps({}, { canRemind: () => true, openReminderFor: open }, held('m7'));
    expect(props.canRemind).toBe(true);
    props.onRemind?.();
    expect(open).toHaveBeenCalledWith('m7');
  });

  it('not for an unrecorded message, without the reminders, or without a bubble', () => {
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
    expect(html).toMatch(/<button(?=[^>]*data-reminder-row="cancel")(?=[^>]*class="[^"]*text-bad)/);
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
    const ctx = source('../ReminderContext.tsx');
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
  it('the missed-reminders toast opens Notifications, never the old bell link', () => {
    const ring = source('../ReminderRing.tsx');
    expect(ring).toContain('navigateRef.current(ACTIVITY_PATH)');
    expect(ring).not.toContain('bell=1');
  });
});

describe('hygiene: tokens only, no blur, no em dashes, no connection wording', () => {
  const files = [
    '../ReminderContext.tsx',
    '../ReminderRing.tsx',
    '../ReminderSheet.tsx',
    '../../../lib/inbox/alerts.ts',
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
