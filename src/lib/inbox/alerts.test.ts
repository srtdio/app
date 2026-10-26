import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  ONLY_YOU_LABEL,
  PLAN_ALERT_EVENT_TYPES,
  PLAN_DELETED_TOAST,
  alertDisplayTime,
  alertKindOf,
  chunked,
  failureInPlainWords,
  isStaleFailed,
  messagePreview,
  planAlertLine,
  planFieldsOf,
  readChatMessages,
  readScheduledRows,
  scheduledPreview,
  scheduledFailedLead,
  scheduledFailedTitle,
  scheduledSentTitle,
  taskAlertLine,
  taskFieldsOf,
  type PlanAlertFields,
} from '@/lib/inbox/alerts';
import { mentionToastFrom, splitNewRows } from '@/lib/inbox/inbox-live';
import { chatDisplayName } from '@/lib/chat/chat-name';
import type { ScheduledRow } from '@/lib/chat/scheduled';

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
    send_at: '2026-10-03T09:00:00.000Z',
    status: 'failed',
    failure_reason: null,
    sent_at: null,
    created_at: '2026-10-03T08:00:00.000Z',
    updated_at: '2026-10-03T08:00:00.000Z',
    ...over,
  };
}

describe('alert kinds', () => {
  it('reminders, scheduled sends, the four plan alerts and the task alerts are alerts', () => {
    expect(alertKindOf('reminder')).toBe('reminder');
    expect(alertKindOf('scheduled_sent')).toBe('sent');
    expect(alertKindOf('scheduled_failed')).toBe('failed');
    for (const t of PLAN_ALERT_EVENT_TYPES) expect(alertKindOf(t)).toBe('plan');
    expect(alertKindOf('task_changed')).toBe('task');
    expect(alertKindOf('task_due')).toBe('task');
  });

  it('chat mentions, plan_review and plan_comment keep their Activity rows', () => {
    for (const t of ['mention', 'plan_review', 'plan_comment', 'comment', 'stage_change']) {
      expect(alertKindOf(t)).toBeNull();
    }
  });
});

describe('payloads', () => {
  it('a plan alert maps its plan, item and change', () => {
    const f = planFieldsOf(
      inbox({
        event_type: 'plan_date_changed',
        entity_type: 'plan',
        entity_id: 'plan1',
        payload: { item_id: 'i1', post_id: 'p1', to: '2026-10-15', left_plan: true },
      }),
    );
    expect(f).toMatchObject({
      planId: 'plan1',
      itemId: 'i1',
      postId: 'p1',
      planTitle: null,
      to: '2026-10-15',
      leftPlan: true,
    });
  });

  it('a task alert maps its payload', () => {
    expect(
      taskFieldsOf(
        inbox({
          payload: {
            task_id: 't1',
            number: 12,
            title: 'Reel cut',
            kind: 'status',
            old: 'todo',
            new: 'shared',
          },
        }),
      ),
    ).toEqual({
      taskId: 't1',
      number: 12,
      title: 'Reel cut',
      kind: 'status',
      old: 'todo',
      new: 'shared',
    });
  });
});

describe('plan alert lines (the bell wording)', () => {
  const names = { who: 'Priya', plan: 'Week of 12 Oct', item: 'Carousel' };
  const fields = (over: Partial<PlanAlertFields> = {}): PlanAlertFields => ({
    planId: 'plan1',
    itemId: null,
    planTitle: 'Week of 12 Oct',
    kind: null,
    itemTitle: null,
    postId: null,
    from: null,
    to: null,
    leftPlan: false,
    ...over,
  });

  it('plan_opened per side; plan_deleted', () => {
    expect(planAlertLine('plan_opened', fields(), names, 'client')).toBe(
      'Priya shared Week of 12 Oct with you',
    );
    expect(planAlertLine('plan_opened', fields(), names, 'agency')).toBe(
      'Priya opened Week of 12 Oct for approvers',
    );
    expect(planAlertLine('plan_deleted', fields(), names, 'agency')).toBe(
      'Priya deleted Week of 12 Oct',
    );
    expect(PLAN_DELETED_TOAST).toBe('This plan was deleted');
  });

  it('plan_date_changed: moved to a day, No date, or left the plan', () => {
    expect(planAlertLine('plan_date_changed', fields({ to: '2026-10-15' }), names, 'client')).toBe(
      'Carousel moved to Thu 15 Oct',
    );
    expect(planAlertLine('plan_date_changed', fields(), names, 'client')).toBe(
      'Carousel moved to No date',
    );
    expect(planAlertLine('plan_date_changed', fields({ leftPlan: true }), names, 'client')).toBe(
      'Carousel left Week of 12 Oct',
    );
  });

  it('plan_updated kinds', () => {
    const kind = (k: string, over: Partial<PlanAlertFields> = {}) => fields({ kind: k, ...over });
    expect(planAlertLine('plan_updated', kind('edited'), names, 'agency')).toBe(
      'Priya updated Week of 12 Oct',
    );
    expect(planAlertLine('plan_updated', kind('edited'), names, 'client')).toBe(
      'Priya updated Week of 12 Oct',
    );
    expect(planAlertLine('plan_updated', kind('slot_added'), names, 'agency')).toBe(
      'Priya added to Week of 12 Oct',
    );
    expect(planAlertLine('plan_updated', kind('slot_removed'), names, 'agency')).toBe(
      'Priya removed Carousel from Week of 12 Oct',
    );
    expect(planAlertLine('plan_updated', kind('concept_changed'), names, 'agency')).toBe(
      'Priya changed Carousel',
    );
    expect(
      planAlertLine(
        'plan_updated',
        kind('renamed', { from: 'Old', to: 'New' }),
        { ...names, item: null },
        'agency',
      ),
    ).toBe('Priya renamed Old to New');
  });

  it('missing names degrade, never blank; no em dash', () => {
    const line = planAlertLine(
      'plan_deleted',
      fields({ planTitle: null }),
      { who: null, plan: null, item: null },
      'agency',
    );
    expect(line).toBe('Someone deleted a plan');
    expect(line).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('alert display time', () => {
  const created = '2026-10-26T10:00:00.000Z';
  const last = '2026-10-26T10:02:00.000Z';
  const fields = (over: Partial<PlanAlertFields> = {}): PlanAlertFields => ({
    planId: 'plan1',
    itemId: null,
    planTitle: 'Week of 12 Oct',
    kind: 'edited',
    itemTitle: null,
    postId: null,
    from: null,
    to: null,
    leftPlan: false,
    lastChangeAt: last,
    ...over,
  });

  it('an edited plan_updated card shows its latest edit', () => {
    expect(alertDisplayTime('plan_updated', created, fields())).toBe(last);
  });

  it('maps payload.last_change_at through planFieldsOf', () => {
    const f = planFieldsOf({
      entity_type: 'plan',
      entity_id: 'plan1',
      payload: { kind: 'edited', last_change_at: last },
    });
    expect(alertDisplayTime('plan_updated', created, f)).toBe(last);
  });

  it('every other kind and event keeps createdAt', () => {
    for (const kind of ['slot_added', 'slot_removed', 'concept_changed', 'renamed', null]) {
      expect(alertDisplayTime('plan_updated', created, fields({ kind }))).toBe(created);
    }
    for (const event of ['plan_opened', 'plan_deleted', 'plan_date_changed', 'comment']) {
      expect(alertDisplayTime(event, created, fields())).toBe(created);
    }
    expect(alertDisplayTime('plan_updated', created, undefined)).toBe(created);
  });

  it('a missing or invalid last_change_at keeps createdAt', () => {
    expect(alertDisplayTime('plan_updated', created, fields({ lastChangeAt: null }))).toBe(created);
    expect(alertDisplayTime('plan_updated', created, fields({ lastChangeAt: 'not a date' }))).toBe(
      created,
    );
    const f = planFieldsOf({
      entity_type: 'plan',
      entity_id: 'plan1',
      payload: { kind: 'edited' },
    });
    expect(alertDisplayTime('plan_updated', created, f)).toBe(created);
  });
});

describe('task alert lines', () => {
  it('a missed due time reads its numbered title', () => {
    const due = taskFieldsOf(inbox({ payload: { number: 4, title: 'Hook copy' } }));
    expect(taskAlertLine('task_due', due, 'Leo')).toBe(`${String.fromCharCode(35)}4 Hook copy`);
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
    expect(messagePreview({ ...base, body: null, hasPlans: true }, () => undefined)).toBe('Plan');
  });

  it('scheduled preview and the sent line', () => {
    expect(scheduledPreview(scheduledRow(), () => undefined)).toBe('See you at 5');
    expect(scheduledPreview(undefined, () => undefined)).toBe('Scheduled message');
  });
});

describe('scheduled send titles name the receiver', () => {
  const dm = chatDisplayName({ channelType: 'dm', title: 'Priya Shah' });
  const group = chatDisplayName({ channelType: 'group', title: 'Launch crew' });
  const notes = chatDisplayName({ channelType: 'notes', title: '' });
  const noDmName = chatDisplayName({ channelType: 'dm', title: '' });
  const noGroupName = chatDisplayName({ channelType: 'group', title: '' });

  it('sent: a DM names the other person, a group its name, notes "Personal notes"', () => {
    expect(scheduledSentTitle(dm)).toBe('Your scheduled message was sent to Priya Shah');
    expect(scheduledSentTitle(group)).toBe('Your scheduled message was sent to Launch crew');
    expect(scheduledSentTitle(notes)).toBe('Your scheduled message was sent to Personal notes');
  });

  it('failed: the lead names the receiver, then the reason in plain words', () => {
    expect(scheduledFailedTitle(dm, 'not a member of this chat')).toBe(
      "Couldn't send your scheduled message to Priya Shah. You're no longer in this chat",
    );
    expect(scheduledFailedTitle(group, null)).toBe(
      "Couldn't send your scheduled message to Launch crew. Something went wrong when sending",
    );
    expect(scheduledFailedTitle(notes, 'exceeds 5000')).toBe(
      "Couldn't send your scheduled message to Personal notes. The message is too long",
    );
    expect(scheduledFailedLead(dm)).toBe("Couldn't send your scheduled message to Priya Shah.");
  });

  it('a missing name falls back to chatDisplayName, never the bare word "Chat"', () => {
    expect(scheduledSentTitle(noDmName)).toBe('Your scheduled message was sent to Direct message');
    expect(scheduledFailedTitle(noGroupName, null)).toBe(
      "Couldn't send your scheduled message to Group. Something went wrong when sending",
    );
    for (const line of [
      scheduledSentTitle(noDmName),
      scheduledSentTitle(noGroupName),
      scheduledFailedTitle(noDmName, null),
    ]) {
      expect(line).not.toMatch(/\bChat\b/);
      expect(line).not.toContain('Sent in');
      expect(line).not.toContain('Not sent');
      expect(line).not.toContain('\u2014');
    }
  });

  it('the privacy chip says only the sender got the alert', () => {
    expect(ONLY_YOU_LABEL).toBe('Only you got this alert');
  });
});

describe('the live layer toasts chat mentions on their own', () => {
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

  it('the activity toast words only the old Activity rows; chat mentions toast apart', () => {
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

  it('several mentions coalesce and open Notifications (never the old bell link)', () => {
    const c = rows[2];
    if (c === undefined) throw new Error('fixture');
    const spec = mentionToastFrom([c, { ...c, id: 'c2' }], () => null);
    expect(spec?.title).toBe('Two new mentions');
    expect(spec?.href).toBe('/notifications');
    const noChat = mentionToastFrom([{ ...c, entity_id: null }], () => null);
    expect(noChat?.href).toBe('/notifications');
  });
});

// ---------------------------------------------------------------------------
// Reads: a recording fake (no database)
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: { message: string } | null };

function recordingClient(tables: Record<string, QueryResult>) {
  const reads: { table: string; ids: unknown[] }[] = [];
  const client = {
    from(table: string) {
      const self: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'order']) self[method] = () => self;
      self.in = (_col: string, ids: unknown[]) => {
        reads.push({ table, ids });
        return self;
      };
      self.then = (ok: (r: QueryResult) => unknown) =>
        Promise.resolve(tables[table] ?? { data: [], error: null }).then(ok);
      return self;
    },
  };
  return { client: client as unknown as Parameters<typeof readChatMessages>[0], reads };
}

describe('batched reads', () => {
  it('IN reads are chunked to keep request URLs short', async () => {
    expect(chunked(Array.from({ length: 250 }, (_, i) => String(i))).map((c) => c.length)).toEqual([
      100, 100, 50,
    ]);
    const { client, reads } = recordingClient({});
    await readChatMessages(
      client,
      Array.from({ length: 150 }, (_, i) => `m${i}`),
    );
    expect(reads.filter((r) => r.table === 'chat_messages')).toHaveLength(2);
    expect((await readChatMessages(client, [])).size).toBe(0);
  });

  it('no ids reads nothing; a failed failed-rows read is flagged, never mistaken for resolved', async () => {
    const quiet = recordingClient({});
    expect(await readScheduledRows(quiet.client, [])).toEqual({ rows: new Map(), ok: true });
    expect(quiet.reads).toEqual([]);

    const good = recordingClient({
      chat_scheduled_messages: {
        data: [scheduledRow({ id: 's1' }), scheduledRow({ id: 's2', status: 'sent' })],
        error: null,
      },
    });
    const read = await readScheduledRows(good.client, ['s1', 's2', 's3']);
    expect(read.ok).toBe(true);
    expect(isStaleFailed(read, 's1')).toBe(false);
    expect(isStaleFailed(read, 's2')).toBe(true);
    expect(isStaleFailed(read, 's3')).toBe(true);
    expect(isStaleFailed(read, null)).toBe(false);

    const flaky = recordingClient({
      chat_scheduled_messages: { data: null, error: { message: 'timeout' } },
    });
    const failed = await readScheduledRows(flaky.client, ['s1']);
    expect(failed.ok).toBe(false);
    expect(isStaleFailed(failed, 's1')).toBe(false);
  });
});
