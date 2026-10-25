// Notifications' Upcoming chip: the viewer's scheduled messages not yet sent
// and pending reminders, soonest first, rebuilt from the bell's Upcoming tab
// (same reads, same procs, same words). Never inbox rows: never counted, never
// marked read. Edit and Cancel make the bell's writes with an explicit trace id.

import { beforeEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHANGE_TIME_LABEL,
  UpcomingCard,
  upcomingEditLabel,
} from '@/components/pages/activity/ActivityCard';
import {
  CANCEL_REMINDER_TITLE,
  UPCOMING_EMPTY,
  buildUpcoming,
  createUpcomingScheduledWrites,
  fetchUpcoming,
  upcomingChat,
  upcomingHref,
  upcomingTag,
  type ChatRowChannel,
  type UpcomingItem,
} from '@/components/pages/activity/data';
import type { ChatMessagePreview } from '@/lib/inbox/alerts';
import type { ReminderRow } from '@/lib/chat/reminders';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import { resetMentionNames, type NameOf } from '@/lib/chat/mentions';

const NOW = new Date('2026-10-22T09:00:00.000Z');
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function reminderRow(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'r1',
    user_id: 'u1',
    workspace_id: 'w1',
    channel_id: 'g-chan',
    message_id: 'm1',
    remind_at: at(30),
    fired_at: null,
    cancelled_at: null,
    created_at: at(-60),
    ...over,
  };
}

function scheduledRow(over: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    id: 's1',
    workspace_id: 'w1',
    channel_id: 'dm-chan',
    sender_user_id: 'u1',
    body: 'Morning team',
    mentions: [],
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: at(10),
    sent_at: null,
    status: 'scheduled',
    failure_reason: null,
    created_at: at(-60),
    updated_at: at(-60),
    ...over,
  };
}

const nameOf: NameOf = () => undefined;
const channels = new Map<string, ChatRowChannel>([
  ['g-chan', { type: 'group', groupId: 'g1' }],
  ['dm-chan', { type: 'dm', groupId: null }],
]);
const messages = new Map<string, ChatMessagePreview>([
  [
    'm1',
    {
      id: 'm1',
      channelId: 'g-chan',
      senderUserId: 'u2',
      body: 'Ship the reel\nsecond line',
      hasAttachments: false,
      hasPosts: false,
      hasBriefs: false,
    },
  ],
]);
const sources = { channels, groupNames: new Map([['g1', 'Launch crew']]), messages, nameOf };

describe('buildUpcoming: scheduled not yet sent and pending reminders, soonest first', () => {
  it('mixes both kinds by due time and joins the chat and the preview', () => {
    const items = buildUpcoming(
      [reminderRow(), reminderRow({ id: 'r2', message_id: 'gone', remind_at: at(90) })],
      [scheduledRow(), scheduledRow({ id: 's2', channel_id: 'g-chan', send_at: at(60) })],
      sources,
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'scheduled:s1',
      'reminder:r1',
      'scheduled:s2',
      'reminder:r2',
    ]);
    const [s1, r1, , r2] = items;
    expect(r1?.chatName).toBe('Launch crew');
    expect(r1?.channelType).toBe('group');
    expect(r1?.preview).toBe('Ship the reel');
    // A message that did not load reads "Message"; a direct chat reads "Chat".
    expect(r2?.preview).toBe('Message');
    expect(s1?.chatName).toBeNull();
    expect(s1 !== undefined ? upcomingChat(s1) : '').toBe('Chat');
    expect(s1?.preview).toBe('Morning team');
  });

  it('leaves out fired and cancelled reminders and anything no longer scheduled', () => {
    const items = buildUpcoming(
      [
        reminderRow({ id: 'fired', fired_at: at(-1) }),
        reminderRow({ id: 'cancelled', cancelled_at: at(-1) }),
      ],
      [
        scheduledRow({ id: 'sent', status: 'sent' }),
        scheduledRow({ id: 'failed', status: 'failed' }),
      ],
      sources,
    );
    expect(items).toEqual([]);
  });

  it('a tie keeps reminders first', () => {
    const items = buildUpcoming([reminderRow({ remind_at: at(10) })], [scheduledRow()], sources);
    expect(items.map((i) => i.kind)).toEqual(['reminder', 'scheduled']);
  });
});

describe('the row: tag, link and the bell words', () => {
  const [scheduled, reminder] = buildUpcoming([reminderRow()], [scheduledRow()], sources);

  it('tags Reminder or Scheduled', () => {
    expect(reminder !== undefined ? upcomingTag(reminder) : '').toBe('Reminder');
    expect(scheduled !== undefined ? upcomingTag(scheduled) : '').toBe('Scheduled');
  });

  it('a tap opens the chat at the reminded message; a scheduled one opens its chat', () => {
    expect(reminder !== undefined ? upcomingHref(reminder) : '').toBe(
      '/chat?channel=g-chan&message=m1',
    );
    expect(scheduled !== undefined ? upcomingHref(scheduled) : '').toBe('/chat?channel=dm-chan');
  });

  it("keeps the bell's strings", () => {
    expect(UPCOMING_EMPTY).toBe('Reminders and scheduled messages show up here.');
    expect(CANCEL_REMINDER_TITLE).toBe('Cancel this reminder?');
    expect(CHANGE_TIME_LABEL).toBe('Change time');
    expect(upcomingEditLabel({ kind: 'reminder' })).toBe('Change time');
    expect(upcomingEditLabel({ kind: 'scheduled' })).toBe('Edit');
  });
});

/** Every element in a rendered tree (function components are not expanded). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe('UpcomingCard: the Notifications card, with Edit and Cancel', () => {
  const [scheduled, reminder] = buildUpcoming([reminderRow()], [scheduledRow()], sources);

  function wired(item: UpcomingItem) {
    const calls: string[] = [];
    const tree = UpcomingCard({
      item,
      now: NOW,
      onOpen: (i) => calls.push(`open:${i.id}`),
      onEdit: (i) => calls.push(`edit:${i.id}`),
      onCancel: (i) => calls.push(`cancel:${i.id}`),
    });
    const all = elements(tree);
    const click = (attr: string, value = ''): void => {
      const el = all.find((e) => e.props[attr] === value);
      (el?.props.onClick as (() => void) | undefined)?.();
    };
    return { calls, click, html: renderToStaticMarkup(tree) };
  }

  it('Edit, Cancel and the tap reach their handlers for a reminder', () => {
    if (reminder === undefined) throw new Error('no reminder');
    const card = wired(reminder);
    card.click('data-upcoming-open');
    card.click('data-upcoming-action', 'edit');
    card.click('data-upcoming-action', 'cancel');
    expect(card.calls).toEqual(['open:r1', 'edit:r1', 'cancel:r1']);
    expect(card.html).toContain('Change time');
    expect(card.html).toContain('Cancel');
    expect(card.html).toContain('Reminder');
    expect(card.html).toContain('Launch crew');
    expect(card.html).toContain('Ship the reel');
  });

  it('a scheduled message reads Scheduled, its chat, its preview and its send time', () => {
    if (scheduled === undefined) throw new Error('no scheduled');
    const card = wired(scheduled);
    card.click('data-upcoming-action', 'edit');
    card.click('data-upcoming-action', 'cancel');
    expect(card.calls).toEqual(['edit:s1', 'cancel:s1']);
    expect(card.html).toContain('Scheduled');
    expect(card.html).toContain('Morning team');
    expect(card.html).toContain('data-upcoming-due');
    expect(card.html).toMatch(/>Edit</);
  });

  it('is never unread: no dot, no accent border; 44px actions; tokens only', () => {
    if (reminder === undefined) throw new Error('no reminder');
    const { html } = wired(reminder);
    expect(html).not.toContain('aria-label="Unread"');
    expect(html).not.toContain('border-accent-line');
    expect(html).toContain('h-11');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\bdark:/);
  });
});

describe('the scheduled writes Edit and Cancel make (as the bell made them)', () => {
  function recorder(error: { message: string } | null = null) {
    const rpcs: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        rpcs.push({ name, args });
        const result = Promise.resolve({
          data: error === null ? { id: 'x', channel_id: 'dm-chan' } : null,
          error,
        });
        return Object.assign(result, { abortSignal: () => result });
      },
    } as unknown as Parameters<typeof createUpcomingScheduledWrites>[0]['client'];
    const events: string[] = [];
    const writes = createUpcomingScheduledWrites({
      client,
      newTraceId: () => 'trace-x',
      reload: () => events.push('reload'),
      failed: (what, _trace, _message, copy) => events.push(`failed:${what}:${copy ?? 'silent'}`),
      channelTypeOf: () => 'group',
    });
    return { writes, rpcs, events };
  }

  it('Cancel: chat_scheduled_cancel with the trace id, then a reload', async () => {
    const h = recorder();
    expect(await h.writes.onCancel(scheduledRow())).toBe(true);
    expect(h.rpcs).toEqual([
      { name: 'chat_scheduled_cancel', args: { p_id: 's1', p_trace_id: 'trace-x' } },
    ]);
    expect(h.events).toEqual(['reload']);
  });

  it('Edit: a new body at the same time, its mentions derived; a new time keeps the body', async () => {
    const h = recorder();
    const row = scheduledRow({ mentions: ['u9'] });
    await h.writes.onSaveBody(row, 'New words');
    const later = new Date(NOW.getTime() + 7_200_000);
    await h.writes.onRetime(row, later);
    expect(h.rpcs).toEqual([
      {
        name: 'chat_scheduled_update',
        args: {
          p_id: 's1',
          p_send_at: row.send_at,
          p_body: 'New words',
          p_mentions: [],
          p_trace_id: 'trace-x',
        },
      },
      {
        name: 'chat_scheduled_update',
        args: {
          p_id: 's1',
          p_send_at: later.toISOString(),
          p_body: 'Morning team',
          p_mentions: ['u9'],
          p_trace_id: 'trace-x',
        },
      },
    ]);
  });

  it('Send now: chat_scheduled_send_now with the trace id', async () => {
    const h = recorder();
    await h.writes.onSendNow(scheduledRow());
    expect(h.rpcs[0]).toEqual({
      name: 'chat_scheduled_send_now',
      args: { p_id: 's1', p_trace_id: 'trace-x' },
    });
  });

  it('a refusal reloads and reports; the row stays', async () => {
    const h = recorder({ message: 'boom' });
    expect(await h.writes.onCancel(scheduledRow())).toBe(false);
    expect(h.events[0]).toBe('reload');
    expect(h.events[1]).toMatch(/^failed:scheduled cancel:/);
  });
});

describe('fetchUpcoming: batched reads, never one per row', () => {
  beforeEach(() => resetMentionNames());
  type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
  type FakeClient = Parameters<typeof fetchUpcoming>[0];

  function recordingClient(tables: Record<string, QueryResult>) {
    const reads: string[] = [];
    const ins: { table: string; vals: unknown[] }[] = [];
    const limits: { table: string; n: number }[] = [];
    const client = {
      from(table: string) {
        reads.push(table);
        const result = tables[table] ?? { data: [], error: null };
        const self = {
          select: () => self,
          eq: () => self,
          is: () => self,
          order: () => self,
          limit: (n: number) => {
            limits.push({ table, n });
            return self;
          },
          in: (_col: string, vals: readonly unknown[]) => {
            ins.push({ table, vals: [...vals] });
            return self;
          },
          then(onfulfilled?: (value: QueryResult) => unknown) {
            return Promise.resolve(result).then(onfulfilled);
          },
        };
        return self;
      },
    };
    return { client: client as unknown as FakeClient, reads, ins, limits };
  }
  const ok = (data: unknown[]): QueryResult => ({
    data: data as Record<string, unknown>[],
    error: null,
  });

  it('two list reads (a page of 1000 each), then one IN read per table', async () => {
    const reminders = Array.from({ length: 5 }, (_, i) =>
      reminderRow({ id: `r${i}`, message_id: `m${i}`, remind_at: at(20 + i) }),
    );
    const { client, reads, ins, limits } = recordingClient({
      chat_message_reminders: ok(reminders),
      chat_scheduled_messages: ok([scheduledRow(), scheduledRow({ id: 's2', send_at: at(5) })]),
      chat_channels: ok([
        { channel_id: 'g-chan', channel_type: 'group', entity_id: 'g1' },
        { channel_id: 'dm-chan', channel_type: 'dm', entity_id: null },
      ]),
      chat_messages: ok([{ id: 'm0', channel_id: 'g-chan', sender_user_id: 'u2', body: 'Hi' }]),
      groups: ok([{ id: 'g1', name: 'Launch crew' }]),
    });
    const res = await fetchUpcoming(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((i) => i.id)).toEqual(['s2', 's1', 'r0', 'r1', 'r2', 'r3', 'r4']);
    expect(res.data.find((i) => i.id === 'r0')?.chatName).toBe('Launch crew');
    expect(limits).toEqual([
      { table: 'chat_message_reminders', n: 1000 },
      { table: 'chat_scheduled_messages', n: 1000 },
    ]);
    // No inbox read: Upcoming never touches inbox_entries.
    expect(reads).not.toContain('inbox_entries');
    for (const table of ['chat_channels', 'chat_messages', 'groups']) {
      expect(ins.filter((r) => r.table === table)).toHaveLength(1);
    }
    expect(ins.find((r) => r.table === 'chat_messages')?.vals).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('either list read failing fails the load', async () => {
    const { client } = recordingClient({
      chat_scheduled_messages: { data: null, error: { message: 'nope' } },
    });
    expect((await fetchUpcoming(client, 'w1')).ok).toBe(false);
  });
});

describe('the page wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
    'utf8',
  );

  it('Upcoming loads its own rows, never the inbox feed', () => {
    expect(src).toMatch(
      /if \(state === 'upcoming'\) void loadUpcoming\(\);\s*else void loadActivity\('reset'\);/,
    );
  });

  it("a reminder's Edit is the change-mode reminder sheet; a scheduled one's the chat's sheet", () => {
    expect(src).toMatch(/if \(item\.kind === 'reminder'\) setReminderEdit\(item\);/);
    expect(src).toMatch(/else setScheduledChat\(item\.channelId\);/);
    expect(src).toContain('change={{ onCancelReminder: cancelFromReminderSheet }}');
  });

  it('Cancel confirms, then cancels through the reminder or scheduled proc', () => {
    expect(src).toContain('await reminderActions.cancelReminder(item.row)');
    expect(src).toContain('await scheduledWrites.onCancel(item.row)');
    expect(src).toContain('CANCEL_REMINDER_TITLE');
    expect(src).toContain('CANCEL_CONFIRM_TITLE');
  });
});
