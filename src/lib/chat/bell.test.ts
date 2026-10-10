import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  bellBadgeText,
  bellSections,
  bellUnreadCount,
  failureInPlainWords,
  loadBell,
  mapBellEntry,
  markBellEventsRead,
  markBellRead,
  mergeOlder,
  messagePreview,
  rowTime,
  snoozeBellEntry,
  type BellEntry,
} from '@/lib/chat/bell';
import { mentionToastFrom, splitNewRows } from '@/lib/inbox/inbox-live';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

function inbox(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
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
    payload: {},
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-10-03T09:00:00.000Z',
    ...over,
  };
}

function entry(over: Partial<InboxEntryRow>): BellEntry {
  const e = mapBellEntry(inbox(over));
  if (e === null) throw new Error('not a bell row');
  return e;
}

const NOW = Date.parse('2026-10-03T10:00:00.000Z');

describe('mapBellEntry', () => {
  it('maps the payload ids and drops non-bell rows', () => {
    const e = entry({ payload: { message_id: 'm1', reminder_id: 'r1' } });
    expect(e).toMatchObject({ channelId: 'c1', messageId: 'm1', reminderId: 'r1' });
    expect(mapBellEntry(inbox({ event_type: 'mention', entity_type: 'post' }))).toBeNull();
    expect(mapBellEntry(inbox({ event_type: 'comment' }))).toBeNull();
    const failed = entry({
      event_type: 'scheduled_failed',
      payload: { scheduled_id: 's1', reason: 'not a member of this chat' },
    });
    expect(failed).toMatchObject({ scheduledId: 's1', reason: 'not a member of this chat' });
  });
});

describe('Now sections', () => {
  const rows = [
    entry({ id: 'rem', event_type: 'reminder' }),
    entry({ id: 'snoozed', event_type: 'reminder', snoozed_until: '2026-10-03T11:00:00Z' }),
    entry({ id: 'woke', event_type: 'reminder', snoozed_until: '2026-10-03T09:30:00Z' }),
    entry({ id: 'men', event_type: 'mention', actor_user_id: 'u2' }),
    entry({ id: 'sent', event_type: 'scheduled_sent' }),
    entry({ id: 'fail', event_type: 'scheduled_failed' }),
    entry({ id: 'read', event_type: 'mention', read_at: '2026-10-03T09:10:00Z' }),
  ];

  it('splits unread, unsnoozed rows into Reminders, Mentions, Scheduled', () => {
    const s = bellSections(rows, NOW);
    expect(s.reminders.map((e) => e.id)).toEqual(['rem', 'woke']);
    expect(s.mentions.map((e) => e.id)).toEqual(['men']);
    expect(s.scheduled.map((e) => e.id)).toEqual(['sent', 'fail']);
  });

  it('the dot counts unread items in Now', () => {
    expect(bellUnreadCount(rows, NOW)).toBe(5);
    expect(bellUnreadCount([], NOW)).toBe(0);
    expect(bellBadgeText(4)).toBe('4');
    expect(bellBadgeText(12)).toBe('9+');
  });
});

describe('copy', () => {
  it('failure reasons read as plain words, never the raw proc text', () => {
    expect(failureInPlainWords('not a member of this chat')).toBe("You're no longer in this chat");
    expect(failureInPlainWords('attachment not available')).toBe(
      'An attachment is no longer available',
    );
    expect(failureInPlainWords('XX000 something odd')).toBe('Something went wrong when sending');
    expect(failureInPlainWords(null)).toBe('Something went wrong when sending');
  });

  it('message preview: first line, names resolved, else what it carries', () => {
    const base = {
      id: 'm1',
      channelId: 'c1',
      senderUserId: 'u2',
      hasAttachments: false,
      hasPosts: false,
      hasBriefs: false,
    };
    const ana = '11111111-1111-4111-8111-111111111111';
    expect(
      messagePreview({ ...base, body: `hey @[${ana}]\nsecond` }, (id) =>
        id === ana ? 'Ana' : undefined,
      ),
    ).toBe('hey @Ana');
    expect(messagePreview({ ...base, body: '', hasAttachments: true }, () => undefined)).toBe(
      'Attachment',
    );
    expect(messagePreview(undefined, () => undefined)).toBe('Message');
  });

  it('row time: clock today, day otherwise', () => {
    const now = new Date(2026, 9, 3, 18, 0);
    expect(rowTime(new Date(2026, 9, 3, 15, 5).toISOString(), now)).toBe('3:05 PM');
    expect(rowTime(new Date(2026, 9, 1, 15, 5).toISOString(), now)).toBe('Thu 1 Oct');
  });
});

describe('the live layer hands chat mentions to the bell toast', () => {
  const rows = [
    inbox({ id: 'a', event_type: 'comment', entity_type: 'post' }),
    inbox({ id: 'b', event_type: 'mention', entity_type: 'post' }),
    inbox({
      id: 'c',
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: 'c9',
      actor_user_id: 'u2',
      payload: { message_id: 'm9' },
    }),
    inbox({ id: 'd', event_type: 'reminder' }),
    inbox({ id: 'e', event_type: 'scheduled_sent' }),
  ];

  it('Activity toasts only non-bell rows (post mention kept); chat mentions go to the bell', () => {
    const split = splitNewRows(rows);
    expect(split.activity.map((r) => r.id)).toEqual(['a', 'b']);
    expect(split.chatMentions.map((r) => r.id)).toEqual(['c']);
  });

  it('"<name> mentioned you" opens the message', () => {
    const spec = mentionToastFrom(splitNewRows(rows).chatMentions, (id) =>
      id === 'u2' ? 'Priya' : null,
    );
    expect(spec).toEqual({
      title: 'Priya mentioned you',
      description: 'Open',
      href: '/chat?channel=c9&message=m9',
      actorId: 'u2',
    });
  });

  it('several mentions coalesce and open the bell', () => {
    const c = rows[2];
    if (c === undefined) throw new Error('fixture');
    const spec = mentionToastFrom([c, { ...c, id: 'c2' }], () => null);
    expect(spec?.title).toBe('Two new mentions');
    expect(spec?.href).toBe('/chat?bell=1');
  });
});

// ---------------------------------------------------------------------------
// Network: a recording fake (no database)
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: { message: string } | null };

function recordingClient(tables: Record<string, unknown[]>) {
  const reads: { table: string; calls: { method: string; args: unknown[] }[] }[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      const read = { table, calls: [] as { method: string; args: unknown[] }[] };
      reads.push(read);
      const self: Record<string, unknown> = {};
      for (const method of [
        'select',
        'eq',
        'is',
        'in',
        'or',
        'not',
        'lt',
        'gt',
        'order',
        'limit',
      ]) {
        self[method] = (...args: unknown[]) => {
          read.calls.push({ method, args });
          return self;
        };
      }
      self.abortSignal = () => self;
      self.then = (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, bad);
      return self;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      const result = Promise.resolve({ data: null, error: null });
      return Object.assign(result, { abortSignal: () => result });
    },
  };
  return { client: client as unknown as Parameters<typeof loadBell>[0], reads, rpcs };
}

describe('loadBell: batched, no N+1', () => {
  it('one inbox read, one reminders read, one scheduled read, then one IN read per table', async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      inbox({
        id: `e${i}`,
        event_type: i % 3 === 0 ? 'scheduled_failed' : i % 3 === 1 ? 'mention' : 'reminder',
        actor_user_id: `u${i}`,
        payload:
          i % 3 === 0 ? { scheduled_id: `s${i}` } : { message_id: `m${i}`, reminder_id: `r${i}` },
      }),
    );
    const { client, reads } = recordingClient({
      inbox_entries: entries,
      chat_message_reminders: [
        {
          id: 'r-up',
          message_id: 'm-up',
          channel_id: 'c1',
          remind_at: '2026-10-04T09:00:00Z',
          fired_at: null,
          cancelled_at: null,
        },
      ],
      chat_scheduled_messages: [],
      chat_messages: [
        {
          id: 'm1',
          channel_id: 'c1',
          sender_user_id: 'u9',
          body: 'hi',
          attachment_asset_ids: null,
          shared_post_ids: null,
          shared_brief_ids: null,
        },
      ],
      users: [],
      workspace_members: [],
    });
    const res = await loadBell(client, { workspaceId: 'w1', userId: 'u1' });
    expect(res.ok).toBe(true);
    const count = (t: string) => reads.filter((r) => r.table === t).length;
    expect(count('inbox_entries')).toBe(1);
    expect(count('chat_message_reminders')).toBe(1);
    // Upcoming scheduled + the failed rows by id.
    expect(count('chat_scheduled_messages')).toBe(2);
    expect(count('chat_messages')).toBe(1);
    const inboxRead = reads.find((r) => r.table === 'inbox_entries');
    expect(inboxRead?.calls).toContainEqual({ method: 'is', args: ['read_at', null] });
    expect(inboxRead?.calls).toContainEqual({ method: 'limit', args: [50] });
    expect(inboxRead?.calls.some((c) => c.method === 'or')).toBe(true);
    const messagesRead = reads.find((r) => r.table === 'chat_messages');
    const inCall = messagesRead?.calls.find((c) => c.method === 'in');
    expect(inCall?.args[0]).toBe('id');
    expect(inCall?.args[1]).toContain('m-up');
  });

  it('a refetch re-reads the rows already shown (capped), and skips snoozed rows server-side', async () => {
    const { client, reads } = recordingClient({});
    await loadBell(client, { workspaceId: 'w1', userId: 'u1', limit: 120 });
    await loadBell(client, { workspaceId: 'w1', userId: 'u1', limit: 5000 });
    const inbox = reads.filter((r) => r.table === 'inbox_entries');
    expect(inbox[0]?.calls).toContainEqual({ method: 'limit', args: [120] });
    expect(inbox[1]?.calls).toContainEqual({ method: 'limit', args: [200] });
    expect(
      inbox[0]?.calls.some(
        (c) => c.method === 'or' && String(c.args[0]).startsWith('snoozed_until.is.null'),
      ),
    ).toBe(true);
  });

  it('IN reads are chunked to keep request URLs short', async () => {
    const { chunked, readBellMessages } = await import('@/lib/chat/bell');
    expect(chunked(Array.from({ length: 250 }, (_, i) => String(i))).map((c) => c.length)).toEqual([
      100, 100, 50,
    ]);
    const { client, reads } = recordingClient({});
    await readBellMessages(
      client,
      Array.from({ length: 150 }, (_, i) => `m${i}`),
    );
    expect(reads.filter((r) => r.table === 'chat_messages')).toHaveLength(2);
  });

  it('a failed failed-rows read is flagged, never mistaken for resolved rows', async () => {
    const { client } = recordingClient({
      inbox_entries: [inbox({ event_type: 'scheduled_failed', payload: { scheduled_id: 's1' } })],
    });
    const flaky = {
      ...client,
      from: (table: string) => {
        const q = client.from(table as 'inbox_entries') as unknown as Record<string, unknown>;
        if (table !== 'chat_scheduled_messages') return q;
        const inner = q.in as (...a: unknown[]) => Record<string, unknown>;
        q.in = (...a: unknown[]) => {
          const r = inner(...a);
          r.then = (ok: (v: Result) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok);
          return r;
        };
        return q;
      },
    } as unknown as Parameters<typeof loadBell>[0];
    const res = await loadBell(flaky, { workspaceId: 'w1', userId: 'u1' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.failedReadOk).toBe(false);
    const good = await loadBell(client, { workspaceId: 'w1', userId: 'u1' });
    if (good.ok) expect(good.data.failedReadOk).toBe(true);
  });

  it('a failed primary read fails the load', async () => {
    const { client } = recordingClient({});
    const broken = {
      ...client,
      from: (table: string) => {
        const q = client.from(table as 'inbox_entries') as unknown as Record<string, unknown>;
        if (table === 'inbox_entries') {
          q.then = (ok: (r: Result) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'nope' } }).then(ok);
        }
        return q;
      },
    } as unknown as Parameters<typeof loadBell>[0];
    const res = await loadBell(broken, { workspaceId: 'w1', userId: 'u1' });
    expect(res.ok).toBe(false);
  });

  it('mergeOlder appends unseen rows only', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    const base = {
      entries: [a],
      hasMore: true,
      reminders: [],
      scheduled: [],
      failed: new Map(),
      failedReadOk: true,
      messages: new Map(),
      names: new Map(),
    };
    const merged = mergeOlder(base, { ...base, entries: [a, b], hasMore: false });
    expect(merged.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(merged.hasMore).toBe(false);
  });
});

describe('bell writes send p_trace_id', () => {
  const e = entry({ id: 'e1', created_at: '2026-10-03T09:00:00.000Z' });

  it('Done: inbox_mark_read', async () => {
    const { client, rpcs } = recordingClient({});
    await markBellRead(client, e, 't1');
    expect(rpcs).toEqual([
      {
        name: 'inbox_mark_read',
        args: {
          p_entry_id: 'e1',
          p_workspace_id: 'w1',
          p_created_at: '2026-10-03T09:00:00.000Z',
          p_trace_id: 't1',
        },
      },
    ]);
  });

  it('Snooze: inbox_snooze with the kind', async () => {
    const { client, rpcs } = recordingClient({});
    await snoozeBellEntry(client, e, 'tomorrow_9', 't2');
    expect(rpcs[0]).toEqual({
      name: 'inbox_snooze',
      args: {
        p_entry_id: 'e1',
        p_workspace_id: 'w1',
        p_created_at: '2026-10-03T09:00:00.000Z',
        p_kind: 'tomorrow_9',
        p_trace_id: 't2',
      },
    });
  });

  it('Clear sent: inbox_mark_read_events', async () => {
    const { client, rpcs } = recordingClient({});
    const res = await markBellEventsRead(client, {
      workspaceId: 'w1',
      eventTypes: ['scheduled_sent'],
      traceId: 't3',
    });
    expect(res.ok).toBe(true);
    expect(rpcs[0]).toEqual({
      name: 'inbox_mark_read_events',
      args: { p_workspace_id: 'w1', p_event_types: ['scheduled_sent'], p_trace_id: 't3' },
    });
  });
});

describe('plan previews', () => {
  it('a bodyless plan message previews as "Plan"', () => {
    const base = {
      id: 'm',
      channelId: 'c',
      senderUserId: 'u',
      body: null,
      hasAttachments: false,
      hasPosts: false,
      hasBriefs: false,
    };
    expect(messagePreview({ ...base, hasPlans: true }, () => undefined)).toBe('Plan');
    expect(messagePreview(base, () => undefined)).toBe('Message');
    expect(messagePreview({ ...base, body: 'see plan', hasPlans: true }, () => undefined)).toBe(
      'see plan',
    );
  });
});
