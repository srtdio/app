// Notifications: Activity and the chat bell on one feed. The chips (Mentions
// takes chat mentions, Plans the six plan alerts, reminders / scheduled sends /
// task alerts only under All and Unread), Mark all read (one inbox_mark_all_read
// call on All; a failed send stays), every former bell tap rule, Retry on
// a failed send, the alert cards, and the batched enrichment (one IN read per
// table, never per row).

import { beforeEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@srtdio/schemas';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import {
  alertBody,
  alertTitle,
  alertTopLine,
  fetchActivityEntries,
  filterByState,
  mapEntry,
  EMPTY_LINES,
  markAllTargets,
  unreadCount,
  openAction,
  opensNothing,
  retryFailedSend,
  type ActivityItem,
  type ActivityState,
} from '@/components/pages/activity/data';
import { PLAN_DELETED_TOAST } from '@/lib/inbox/alerts';
import { TASKS_SHEET_ONLY } from '@/lib/chat/tasks';
import { resetMentionNames } from '@/lib/chat/mentions';
import type { PresignCache } from '@/lib/asset-presign';
import { newWindowState, windowed } from '@/lib/chat/__tests__/partition-fake';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const LATER = new Date(NOW + 3_600_000).toISOString();

function row(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'comment',
    entity_type: 'post',
    entity_id: 'p1',
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    actor_user_id: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-10-20T11:00:00.000Z',
    ...over,
  };
}

const item = (over: Partial<InboxEntryRow>): ActivityItem => mapEntry(row(over));

const reminder = (over: Partial<InboxEntryRow> = {}) =>
  item({
    id: 'rem',
    event_type: 'reminder',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'people',
    payload: { message_id: 'm1', reminder_id: 'r1' },
    ...over,
  });
const sent = (over: Partial<InboxEntryRow> = {}) =>
  item({
    id: 'sent',
    event_type: 'scheduled_sent',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    payload: { scheduled_id: 's2', message_id: 'm2' },
    ...over,
  });
const failed = (over: Partial<InboxEntryRow> = {}) =>
  item({
    id: 'fail',
    event_type: 'scheduled_failed',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    tier: 'urgent',
    payload: { scheduled_id: 's1', reason: 'not a member of this chat' },
    ...over,
  });
const chatMention = (over: Partial<InboxEntryRow> = {}) =>
  item({
    id: 'cm',
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'people',
    actor_user_id: 'u2',
    payload: { message_id: 'm9' },
    ...over,
  });
const postMention = () => item({ id: 'pm', event_type: 'mention', payload: { comment_id: 'cc1' } });
const plan = (eventType: string, over: Partial<InboxEntryRow> = {}) =>
  item({
    id: eventType,
    event_type: eventType,
    entity_type: 'plan',
    entity_id: 'plan1',
    actor_user_id: 'u2',
    payload: { plan_id: 'plan1', plan_title: 'Week of 12 Oct', item_id: 'i1' },
    ...over,
  });
const planItemEvent = (eventType: 'plan_review' | 'plan_comment') =>
  item({
    id: eventType,
    event_type: eventType,
    entity_type: 'plan_item',
    entity_id: 'i1',
    actor_user_id: 'u2',
    payload: { plan_id: 'plan1', comment_id: 'pc1', side: 'client', status: 'approved' },
  });
const task = (over: Partial<InboxEntryRow> = {}) =>
  item({
    id: 'task',
    event_type: 'task_changed',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    actor_user_id: 'u2',
    payload: { task_id: 't1', number: 3, title: 'Hook', kind: 'created', new: 'Hook' },
    ...over,
  });
const taskDue = () =>
  item({
    id: 'due',
    event_type: 'task_due',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    payload: { task_id: 't2', number: 4, title: 'Hook copy' },
  });

const PLAN_TYPES = [
  'plan_opened',
  'plan_deleted',
  'plan_date_changed',
  'plan_updated',
  'plan_review',
  'plan_comment',
];

const feed: ActivityItem[] = [
  reminder(),
  sent(),
  failed(),
  chatMention(),
  postMention(),
  ...['plan_opened', 'plan_deleted', 'plan_date_changed', 'plan_updated'].map((t) => plan(t)),
  planItemEvent('plan_review'),
  planItemEvent('plan_comment'),
  task(),
  taskDue(),
  item({ id: 'comment' }),
];

const ids = (state: ActivityState, items: readonly ActivityItem[] = feed): string[] =>
  filterByState(items, state, NOW).map((i) => i.id);

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('the page', () => {
  it('is titled "Activity"; the Plans chip has a positive zero state', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("export const ACTIVITY_TITLE = 'Activity';");
    expect(src).toContain('title={ACTIVITY_TITLE}');
    expect(src).not.toContain('NOTIFICATIONS_TITLE');
    expect(src).toMatch(
      /state === 'plans' \? \(\s*<EmptyState icon=\{<IconPlan size=\{ICON_SIZE\.status\} \/>\} title=\{EMPTY_LINES\.plans\} \/>/,
    );
    expect(EMPTY_LINES.plans).toBe('Plan updates show up here.');
  });
});

describe('chips', () => {
  it('Mentions takes every mention: chat mentions and post mentions alike', () => {
    expect(ids('mentions')).toEqual(['cm', 'pm']);
  });

  it('Plans takes the six plan alert types and nothing else', () => {
    expect(ids('plans')).toEqual(PLAN_TYPES);
  });

  it('reminders, scheduled sends and task alerts show only under All and Unread', () => {
    const alertIds = ['rem', 'sent', 'fail', 'task', 'due'];
    for (const id of alertIds) {
      expect(ids('all')).toContain(id);
      expect(ids('unread')).toContain(id);
      for (const state of ['mentions', 'briefs', 'plans', 'upcoming', 'snoozed'] as const) {
        expect(ids(state)).not.toContain(id);
      }
    }
  });

  it('a snoozed alert moves to Snoozed', () => {
    const snoozed = [reminder({ snoozed_until: LATER }), task({ snoozed_until: LATER })];
    expect(ids('snoozed', snoozed)).toEqual(['rem', 'task']);
    expect(ids('all', snoozed)).toEqual([]);
    expect(ids('unread', snoozed)).toEqual([]);
  });
});

describe('Mark all read', () => {
  it('targets a failed scheduled send on All and Unread (the proc marks it read too)', () => {
    for (const state of ['all', 'unread'] as const) {
      const targets = markAllTargets(feed, state, NOW).map((i) => i.id);
      expect(targets).toContain('fail');
      expect(targets).toContain('rem');
    }
  });

  it('the All chip targets every unread row of every type (one proc call covers them)', () => {
    const targets = markAllTargets(feed, 'all', NOW).map((i) => i.id);
    for (const id of ['rem', 'sent', 'fail', 'cm', 'pm', ...PLAN_TYPES, 'task', 'due', 'comment']) {
      expect(targets).toContain(id);
    }
  });

  it('the page makes one inbox_mark_all_read call on All, never a per-row or per-type top-up', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(page).toMatch(
      /if \(!marksWholeInbox\(state\)\) \{\s*markEntriesRead\(targets\);\s*return;\s*\}/,
    );
    expect(count(page, 'markAllEntriesRead(supabase, workspaceId, traceId)')).toBe(1);
    expect(page).not.toMatch(/markAllPerRow|inbox_mark_read_events|inboxMarkReadEvents/);
  });

  it('Mark all read is a right-aligned link above the list, not in the toolbar', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    // Shown only with something unread, right-aligned; no count text (the Unread chip has it).
    expect(page).toMatch(
      /\{chipUnread > 0 \? \(\s*<div data-activity-mark-all="" className="[^"]*justify-end/,
    );
    expect(page).not.toContain('{chipUnread} unread');
    expect(page).toMatch(/<Button variant="link" onClick=\{handleMarkAll\}>\s*Mark all read/);
    // The toolbar keeps one IconButton (Sort): no ⋯ menu, no text button there.
    expect(page).not.toContain('ActionMenu');
    expect(count(page, 'onClick={handleMarkAll}')).toBe(1);
  });

  it('Upcoming has no inbox rows: nothing to mark, nothing counted', () => {
    expect(ids('upcoming')).toEqual([]);
    expect(markAllTargets(feed, 'upcoming', NOW)).toEqual([]);
    // The unread badge counts inbox rows only; the Upcoming chip adds none.
    expect(unreadCount(feed, NOW)).toBe(feed.length);
  });
});

describe('taps: every former bell row keeps its behaviour', () => {
  it('a reminder opens the chat at the message and does NOT mark it read', () => {
    expect(openAction(reminder())).toEqual({
      href: '/chat?channel=c1&message=m1',
      markRead: false,
      toast: null,
    });
  });

  it('a chat mention and a sent row mark read, then open the message', () => {
    expect(openAction(chatMention())).toEqual({
      href: '/chat?channel=c1&message=m9',
      markRead: true,
      toast: null,
    });
    expect(openAction(sent())).toEqual({
      href: '/chat?channel=c1&message=m2',
      markRead: true,
      toast: null,
    });
    // An older sent row without its message id opens through the scheduled id.
    expect(openAction(sent({ payload: { scheduled_id: 's2' } })).href).toBe(
      '/chat?channel=c1&message=s2',
    );
  });

  it('a plan alert marks read, then opens /plans/{id} with ?item= (not when the item left)', () => {
    expect(openAction(plan('plan_opened'))).toEqual({
      href: '/plans/plan1?item=i1',
      markRead: true,
      toast: null,
    });
    const left = plan('plan_date_changed', {
      payload: { plan_id: 'plan1', item_id: 'i1', left_plan: true },
    });
    expect(openAction(left).href).toBe('/plans/plan1');
    const edited = plan('plan_updated', {
      payload: { plan_id: 'plan1', plan_title: 'Week of 12 Oct', kind: 'edited' },
    });
    expect(openAction(edited)).toEqual({ href: '/plans/plan1', markRead: true, toast: null });
  });

  it('plan_deleted (or a plan alert with no id) marks read, toasts and opens nothing', () => {
    const deleted = { href: null, markRead: true, toast: PLAN_DELETED_TOAST };
    expect(openAction(plan('plan_deleted'))).toEqual(deleted);
    expect(openAction(plan('plan_updated', { entity_id: null, payload: {} }))).toEqual(deleted);
    expect(PLAN_DELETED_TOAST).toBe('This plan was deleted');
  });

  it('plan_comment and plan_review keep their Activity deep link', () => {
    expect(openAction(planItemEvent('plan_comment')).href).toBe('/plans/plan1?item=i1&comment=pc1');
    expect(openAction(planItemEvent('plan_review')).href).toBe('/plans/plan1?item=i1');
  });

  it('a task alert marks read and opens the chat with its task sheet', () => {
    expect(openAction(task())).toEqual({
      href: '/chat?channel=c1&task=t1',
      markRead: true,
      toast: null,
    });
    const batch = task({ payload: { kind: 'batch', batch_id: 'B', created: 1, changed: 2 } });
    expect(openAction(batch).href).toBe(`/chat?channel=c1&task=${TASKS_SHEET_ONLY}`);
  });

  it('a failed send has no tap (Retry and Edit instead); a deleted post neither', () => {
    expect(opensNothing(failed())).toBe(true);
    expect(openAction(failed()).href).toBeNull();
    expect(opensNothing(item({ event_type: 'post_deleted' }))).toBe(true);
    expect(opensNothing(reminder())).toBe(false);
    expect(opensNothing(plan('plan_deleted'))).toBe(false);
  });
});

describe('Retry on a failed send', () => {
  function recorder(error: { message: string } | null = null) {
    const rpcs: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        rpcs.push({ name, args });
        const result = Promise.resolve({ data: error === null ? { id: 'x' } : null, error });
        return Object.assign(result, { abortSignal: () => result });
      },
    } as unknown as Parameters<typeof retryFailedSend>[0];
    return { client, rpcs };
  }

  it('calls chat_scheduled_send_now on the scheduled id with the trace id', async () => {
    const { client, rpcs } = recorder();
    expect(await retryFailedSend(client, failed(), 'w1', 'trace-x')).toEqual({ kind: 'sent' });
    expect(rpcs).toEqual([
      { name: 'chat_scheduled_send_now', args: { p_id: 's1', p_trace_id: 'trace-x' } },
    ]);
  });

  it('a row resolved elsewhere (stale) only marks its entry read', async () => {
    const { client, rpcs } = recorder();
    const stale = failed();
    if (stale.alert != null) stale.alert.stale = true;
    expect(await retryFailedSend(client, stale, 'w1', 'trace-y')).toEqual({ kind: 'cleared' });
    expect(rpcs).toEqual([
      {
        name: 'inbox_mark_read',
        args: {
          p_entry_id: 'fail',
          p_workspace_id: 'w1',
          p_created_at: '2026-10-20T11:00:00.000Z',
          p_trace_id: 'trace-y',
        },
      },
    ]);
  });

  it('a refusal toasts the action copy; "not found" stays silent', async () => {
    const refused = await retryFailedSend(
      recorder({ message: 'not a member of this chat' }).client,
      failed(),
      'w1',
      't',
    );
    expect(refused).toMatchObject({ kind: 'failed', copy: "Couldn't do that. Try again." });
    const gone = await retryFailedSend(
      recorder({ message: 'scheduled message not found' }).client,
      failed(),
      'w1',
      't',
    );
    expect(gone).toMatchObject({ kind: 'failed', copy: null });
  });
});

describe('alert wording (the bell lines on Activity cards)', () => {
  it('top line: the actor, else the alert label', () => {
    const r = reminder();
    if (r.alert == null) throw new Error('fixture');
    expect(alertTopLine(r, r.alert)).toBe('Reminder');
    expect(alertTopLine({ actorName: 'Priya' }, r.alert)).toBe('Priya');
    const s = sent();
    if (s.alert == null) throw new Error('fixture');
    expect(alertTopLine(s, s.alert)).toBe('Scheduled');
  });

  it('titles and bodies', () => {
    const s = sent();
    const f = failed();
    const p = { ...plan('plan_opened'), actorName: 'Priya' };
    const t = { ...task(), actorName: 'Leo' };
    if (s.alert == null || f.alert == null || p.alert == null || t.alert == null) {
      throw new Error('fixture');
    }
    // An unread chat: chatDisplayName's fallback, never "Chat".
    expect(alertTitle(s, s.alert, 'agency')).toBe(
      'Your scheduled message was sent to Direct message',
    );
    expect(
      alertTitle(s, { ...s.alert, chatType: 'group', chatName: 'Launch crew' }, 'agency'),
    ).toBe('Your scheduled message was sent to Launch crew');
    expect(alertTitle(s, { ...s.alert, chatType: 'dm', chatName: 'Priya Shah' }, 'agency')).toBe(
      'Your scheduled message was sent to Priya Shah',
    );
    expect(alertTitle(s, { ...s.alert, chatType: 'notes' }, 'agency')).toBe(
      'Your scheduled message was sent to Personal notes',
    );
    expect(alertTitle(s, { ...s.alert, chatType: 'group' }, 'agency')).toBe(
      'Your scheduled message was sent to Group',
    );
    expect(alertTitle(f, f.alert, 'agency')).toBe(
      "Couldn't send your scheduled message to Direct message. You're no longer in this chat",
    );
    expect(alertTitle(f, { ...f.alert, chatType: 'dm', chatName: 'Priya Shah' }, 'agency')).toBe(
      "Couldn't send your scheduled message to Priya Shah. You're no longer in this chat",
    );
    expect(
      alertTitle(f, { ...f.alert, chatType: 'group', chatName: 'Launch crew' }, 'agency'),
    ).toBe("Couldn't send your scheduled message to Launch crew. You're no longer in this chat");
    expect(alertTitle(f, { ...f.alert, chatType: 'notes' }, 'agency')).toBe(
      "Couldn't send your scheduled message to Personal notes. You're no longer in this chat",
    );
    expect(alertTitle(p, p.alert, 'client')).toBe('Priya shared Week of 12 Oct with you');
    expect(alertTitle(p, p.alert, 'agency')).toBe('Priya opened Week of 12 Oct for approvers');
    expect(alertTitle(t, t.alert, 'agency')).toBe(`Leo · added ${String.fromCharCode(35)}3 Hook`);
    expect(alertBody(t.alert)).toBe('Chat');
    expect(alertBody({ ...p.alert, itemTitle: 'Carousel' })).toBe('Carousel');
    expect(alertBody(s.alert)).toBeNull();
  });
});

describe('alert cards: Activity cards, not the old bell panel', () => {
  const cache = {} as unknown as PresignCache;
  function card(group: ActivityItem[], extra: Partial<Parameters<typeof ActivityCard>[0]> = {}) {
    return renderToStaticMarkup(
      <ActivityCard
        group={group}
        nowMs={NOW}
        cache={cache}
        presignEnabled={false}
        onOpenGroup={() => {}}
        onOpenEntry={() => {}}
        onSnooze={() => {}}
        onMarkRead={() => {}}
        selfName={null}
        {...extra}
      />,
    );
  }

  it('a failed send: the lead in bad, the reason, Retry and Edit, and no tap', () => {
    const html = card([failed()], { onRetry: () => {}, onEdit: () => {} });
    expect(html).toContain('data-activity-event="scheduled_failed"');
    expect(html).toMatch(
      /class="text-bad">Couldn&#x27;t send your scheduled message to Direct message\.</,
    );
    expect(html).not.toContain('Not sent');
    expect(html).toContain('no longer in this chat');
    expect(html).toContain('data-activity-action="retry"');
    expect(html).toContain('data-activity-action="edit"');
    expect(html).toMatch(/class="[^"]*h-11[^"]*"[^>]*data-activity-action="retry"/);
    expect(html).not.toMatch(/role="button"[^>]*data-activity-lead/);
    expect(html).toContain('data-activity-alert-icon="failed"');
  });

  it('scheduled sends: the title names the receiver and wraps to two lines', () => {
    const named = (i: ActivityItem): ActivityItem =>
      i.alert == null ? i : { ...i, alert: { ...i.alert, chatType: 'dm', chatName: 'Priya Shah' } };
    const sentHtml = card([named(sent())]);
    const failedHtml = card([named(failed())]);
    expect(sentHtml).toContain('Your scheduled message was sent to Priya Shah');
    expect(failedHtml).toContain('Couldn&#x27;t send your scheduled message to Priya Shah.');
    for (const html of [sentHtml, failedHtml]) {
      expect(html).toContain(
        '<p class="text-base font-medium text-fg line-clamp-2 [overflow-wrap:anywhere]">',
      );
      expect(html).not.toContain('Sent in');
      expect(html).not.toMatch(/sent to Chat\b|message to Chat\b/);
    }
    // Every other card keeps its single-line title.
    expect(card([reminder()])).toContain('<p class="text-base font-medium text-fg truncate">');
  });

  it('scheduled sends never read "Sent in Chat" or name the bare "Chat", read or unread', () => {
    for (const i of [sent(), failed(), sent({ scope: 'people' }), failed({ scope: 'people' })]) {
      const html = card([i], { onRetry: () => {}, onEdit: () => {} });
      expect(html).not.toContain('Sent in Chat');
      expect(html).not.toMatch(/(sent|message) to Chat\b/);
    }
  });

  it('footer: scheduled sends show the privacy chip in place of the scope tag', () => {
    for (const i of [sent({ scope: 'people' }), failed({ scope: 'people' }), sent(), failed()]) {
      const html = card([i], { onRetry: () => {}, onEdit: () => {} });
      expect(html).toContain('data-activity-only-you');
      expect(html).toContain('Only you got this alert');
      expect(html).not.toContain('data-activity-scope-tag');
      expect(html).not.toContain('>People<');
      expect(html).not.toContain('>Groups<');
      // The icon is decoration; the text carries the meaning.
      expect(html).toMatch(/data-activity-only-you=""[^>]*><svg[^>]*aria-hidden="true"/);
    }
  });

  it('footer: every other kind keeps its scope tag and has no privacy chip', () => {
    const others: ActivityItem[] = [
      reminder(),
      plan('plan_opened', { scope: 'posts' }),
      task(),
      item({ id: 'post', event_type: 'stage_change', scope: 'posts' }),
      item({ id: 'brief', event_type: 'brief_created', entity_type: 'brief', scope: 'briefs' }),
      postMention(),
      chatMention(),
    ];
    for (const i of others) {
      const html = card([i]);
      expect(html, i.eventType).toContain('data-activity-scope-tag');
      expect(html, i.eventType).not.toContain('data-activity-only-you');
      expect(html, i.eventType).not.toContain('Only you got this alert');
    }
  });

  it('a reminder: the card frame, the menu, the unread highlight and its icon', () => {
    const html = card([reminder()]);
    expect(html).toContain('data-activity-event="reminder"');
    expect(html).toContain('data-activity-menu');
    expect(html).toContain('border-accent-line');
    expect(html).toContain('data-activity-alert-icon="reminder"');
    expect(html).toContain('>Reminder<');
    expect(html).not.toContain('data-activity-action');
  });

  it('a plan alert reads the side-aware line', () => {
    const p = { ...plan('plan_opened'), actorName: 'Priya' };
    expect(card([p], { side: 'client' })).toContain('Priya shared Week of 12 Oct with you');
    expect(card([p])).toContain('Priya opened Week of 12 Oct for approvers');
  });

  it('a merged plan edit reads "{name} updated {plan}" with the plan icon, light and dark', () => {
    const edited = {
      ...plan('plan_updated', {
        payload: {
          plan_id: 'plan1',
          plan_title: 'Week of 12 Oct',
          kind: 'edited',
          last_change_at: '2026-10-26T10:00:00.000Z',
        },
      }),
      actorName: 'Priya',
    };
    for (const theme of ['light', 'dark'] as const) {
      for (const side of ['agency', 'client'] as const) {
        const html = renderToStaticMarkup(
          <div data-theme={theme}>
            <ActivityCard
              group={[edited]}
              nowMs={NOW}
              cache={cache}
              presignEnabled={false}
              onOpenGroup={() => {}}
              onOpenEntry={() => {}}
              onSnooze={() => {}}
              onMarkRead={() => {}}
              selfName={null}
              side={side}
            />
          </div>,
        );
        expect(html).toContain('Priya updated Week of 12 Oct');
        expect(html).toContain('data-activity-event="plan_updated"');
        expect(html).toContain('data-activity-alert-icon="plan"');
        // Token classes only: the theme swaps the tokens, never the markup.
        expect(html).not.toMatch(/\bdark:|#[0-9a-f]{6}/i);
        // Approved copy: no count, no extra words, no em dash.
        expect(html).not.toMatch(/Priya updated Week of 12 Oct \(|\d+ (edits|changes)/);
        expect(html).not.toContain('\u2014');
      }
    }
  });
});

describe('fetchActivityEntries: alert enrichment is batched', () => {
  beforeEach(() => resetMentionNames());
  type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
  type FakeClient = Parameters<typeof fetchActivityEntries>[0];

  function recordingClient(tables: Record<string, QueryResult>): {
    client: FakeClient;
    ins: { table: string; vals: unknown[] }[];
  } {
    const ins: { table: string; vals: unknown[] }[] = [];
    const client = {
      from(table: string) {
        const members: QueryResult = {
          data: (tables.users?.data ?? []).map((u) => ({ user_id: u.id, role: 'agency' })),
          error: null,
        };
        const canned =
          tables[table] ?? (table === 'workspace_members' ? members : { data: [], error: null });
        // The inbox read walks partition-bounded windows: answer each with its rows only.
        const w = newWindowState();
        const range = (op: string, col: string, val: unknown): void => {
          if (col === 'created_at') w.range.push([op, String(val)]);
        };
        const self = {
          select: () => self,
          eq: () => self,
          is: () => self,
          order: (col: string, opts?: { ascending?: boolean }) => {
            w.order.push({ column: col, ascending: opts?.ascending !== false });
            return self;
          },
          limit: (n: number) => {
            w.limit = n;
            return self;
          },
          gt: (col: string, val: unknown) => (range('gt', col, val), self),
          gte: (col: string, val: unknown) => (range('gte', col, val), self),
          lt: (col: string, val: unknown) => (range('lt', col, val), self),
          lte: (col: string, val: unknown) => (range('lte', col, val), self),
          like: () => self,
          or: () => self,
          in: (_col: string, vals: readonly unknown[]) => {
            ins.push({ table, vals: [...vals] });
            return self;
          },
          then(onfulfilled?: (value: QueryResult) => unknown) {
            const result =
              table === 'inbox_entries' && canned.data !== null
                ? { ...canned, data: windowed(canned.data, w) }
                : canned;
            return Promise.resolve(result).then(onfulfilled);
          },
        };
        return self;
      },
    };
    return { client: client as unknown as FakeClient, ins };
  }
  const ok = (data: Record<string, unknown>[]): QueryResult => ({ data, error: null });
  const raw = (over: Partial<InboxEntryRow>) => row(over) as unknown as Record<string, unknown>;

  it('one IN read per table for every alert on the page; fields resolved', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) =>
        raw({
          id: `rem${i}`,
          event_type: 'reminder',
          entity_type: 'chat_channel',
          entity_id: 'g-chan',
          payload: { message_id: `m${i}` },
        }),
      ),
      raw({
        id: 'sent',
        event_type: 'scheduled_sent',
        entity_type: 'chat_channel',
        entity_id: 'dm-chan',
        payload: { scheduled_id: 's2', message_id: 'm9' },
      }),
      raw({
        id: 'fail',
        event_type: 'scheduled_failed',
        entity_type: 'chat_channel',
        entity_id: 'g-chan',
        payload: { scheduled_id: 's1' },
      }),
      raw({
        id: 'moved',
        event_type: 'plan_date_changed',
        entity_type: 'plan',
        entity_id: 'plan2',
        actor_user_id: 'u-cy',
        payload: { plan_id: 'plan2', item_id: 'i2', post_id: 'post2', to: '2026-10-15' },
      }),
      raw({
        id: 'task',
        event_type: 'task_changed',
        entity_type: 'chat_channel',
        entity_id: 'g-chan',
        actor_user_id: 'u-cy',
        payload: { kind: 'batch', batch_id: 'B' },
      }),
    ];
    const { client, ins } = recordingClient({
      inbox_entries: ok(rows),
      chat_channels: ok([
        { channel_id: 'g-chan', channel_type: 'group', entity_id: 'g1' },
        {
          channel_id: 'dm-chan',
          channel_type: 'dm',
          entity_id: null,
          dm_user_a: 'u1',
          dm_user_b: 'u-priya',
        },
      ]),
      groups: ok([{ id: 'g1', name: 'Launch crew' }]),
      chat_messages: ok([
        { id: 'm0', channel_id: 'g-chan', sender_user_id: 'u-ana', body: 'Ship the reel' },
        { id: 'm9', channel_id: 'dm-chan', sender_user_id: 'u1', body: 'See you at 5' },
      ]),
      chat_scheduled_messages: ok([
        { id: 's1', status: 'failed', failure_reason: 'exceeds 5000', body: 'Long one' },
      ]),
      plans: ok([{ id: 'plan2', title: 'Launch' }]),
      plan_items: ok([{ id: 'i2', plan_id: 'plan2', kind: 'post', title: null, post_id: 'post2' }]),
      posts: ok([{ id: 'post2', title: 'Carousel', format: 'text', caption: null, number: 2 }]),
      users: ok([
        { id: 'u-ana', display_name: 'Ana', avatar_url: null },
        { id: 'u-cy', display_name: 'Cy', avatar_url: null },
        { id: 'u-priya', display_name: 'Priya Shah', avatar_url: null },
      ]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.data.map((i) => [i.id, i]));

    const rem = byId.get('rem0');
    expect(rem?.actorName).toBe('Ana');
    expect(rem?.alert).toMatchObject({ chatName: 'Launch crew', preview: 'Ship the reel' });
    // A message that did not load still reads, never blank.
    expect(byId.get('rem1')?.alert?.preview).toBe('Message');
    // A scheduled send's direct chat names the other person (not the viewer, u1)
    // from the one batched people read; a group send names the group.
    const sentRow = byId.get('sent');
    expect(sentRow?.alert).toMatchObject({
      chatType: 'dm',
      chatName: 'Priya Shah',
      preview: 'See you at 5',
    });
    if (sentRow?.alert == null) throw new Error('fixture');
    expect(alertTitle(sentRow, sentRow.alert, 'agency')).toBe(
      'Your scheduled message was sent to Priya Shah',
    );
    const failRow = byId.get('fail');
    if (failRow?.alert == null) throw new Error('fixture');
    expect(alertTitle(failRow, failRow.alert, 'agency')).toBe(
      "Couldn't send your scheduled message to Launch crew. The message is too long",
    );
    expect(byId.get('fail')?.alert).toMatchObject({
      reason: 'exceeds 5000',
      preview: 'Long one',
      stale: false,
    });
    const moved = byId.get('moved');
    expect(moved?.actorName).toBe('Cy');
    expect(moved?.alert).toMatchObject({ planTitle: 'Launch', itemTitle: 'Carousel' });
    const t = byId.get('task');
    if (t?.alert == null) throw new Error('fixture');
    expect(alertTitle(t, t.alert, 'agency')).toBe('Cy edited tasks');
    expect(alertBody(t.alert)).toBe('Launch crew');

    const perTable = (table: string) => ins.filter((c) => c.table === table);
    for (const table of [
      'chat_channels',
      'chat_messages',
      'chat_scheduled_messages',
      'groups',
      'plans',
      'plan_items',
      'posts',
    ]) {
      expect(perTable(table), table).toHaveLength(1);
    }
    expect(perTable('chat_channels')[0]?.vals.sort()).toEqual(['dm-chan', 'g-chan']);
    expect(perTable('chat_messages')[0]?.vals.sort()).toEqual(['m0', 'm1', 'm2', 'm9']);
    expect(perTable('chat_scheduled_messages')[0]?.vals).toEqual(['s1']);
  });

  it('a failed-rows read that fails never marks a failed send stale', async () => {
    const { client } = recordingClient({
      inbox_entries: ok([
        raw({
          id: 'fail',
          event_type: 'scheduled_failed',
          entity_type: 'chat_channel',
          entity_id: 'c1',
          payload: { scheduled_id: 's1', reason: 'not a member of this chat' },
        }),
      ]),
      chat_scheduled_messages: { data: null, error: { message: 'boom' } },
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]?.alert).toMatchObject({
      stale: false,
      reason: 'not a member of this chat',
      preview: 'Scheduled message',
    });
  });

  it('a gone failed send (read ok, no row) is stale', async () => {
    const { client } = recordingClient({
      inbox_entries: ok([
        raw({
          id: 'fail',
          event_type: 'scheduled_failed',
          entity_type: 'chat_channel',
          entity_id: 'c1',
          payload: { scheduled_id: 's1' },
        }),
      ]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok && res.data[0]?.alert?.stale).toBe(true);
  });
});

// Behaviour that lives inside NotificationsPage and InboxStoreProvider (timers,
// refs, async writes) is pinned at the source level, as the tests above do.
describe('notifications fixes: page and provider wiring', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
    'utf8',
  );
  const provider = readFileSync(
    fileURLToPath(new URL('../../shell/InboxStoreProvider.tsx', import.meta.url)),
    'utf8',
  );

  it('fix 9: opening a group marks every unread entry in it, not only the lead', () => {
    expect(page).toContain(
      'const unread = group.filter((e) => e.readAt === null && openAction(e, workspaceKey).markRead);',
    );
    expect(page).toMatch(/const unread = group\.filter[^\n]*\n\s*markEntriesRead\(unread\);/);
    expect(page).not.toContain('if (lead !== undefined) handleOpenEntry(lead);');
  });

  it('fix 11: relative times tick every 60s while visible and stop on hidden or unmount', () => {
    expect(page).toContain('const TIME_TICK_MS = 60_000;');
    expect(page).toContain('window.setInterval(() => setNowMs(Date.now()), TIME_TICK_MS)');
    expect(page).toMatch(/if \(document\.hidden\) \{\s*stop\(\);\s*return;\s*\}/);
    expect(page).toMatch(/if \(!document\.hidden\) start\(\);/);
    expect(page).toMatch(
      /return \(\) => \{\s*stop\(\);\s*document\.removeEventListener\('visibilitychange', onVisibility\);/,
    );
    expect(page).toContain('if (timer !== null) window.clearInterval(timer);');
  });

  it('fix 12: the page speaks of activity, never notifications, in its loading and sort copy', () => {
    expect(page).toContain('label="Sort activity"');
    expect(page).not.toContain('Sort notifications');
    expect(page).not.toContain('Loading notifications');
    expect(count(page, '{LOADING_NOTIFICATIONS}')).toBe(2);
    expect(page).toContain('{updatesLabel(entries.length)}');
  });

  it('fix 13: each chip empty state is its one positive line', () => {
    for (const key of ['mentions', 'briefs', 'plans', 'snoozed'] as const) {
      expect(page).toContain(`title={EMPTY_LINES.${key}}`);
    }
    for (const gone of [
      'No mentions yet',
      'No brief activity yet',
      'Nothing snoozed',
      'Snoozed items wait here',
    ]) {
      expect(page).not.toContain(gone);
    }
  });

  it('fix 15: the poll tells the page (detail poll); the page merges only on that event', () => {
    expect(provider).toContain(
      'window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT, { detail: POLL_CHANGE_SOURCE }));',
    );
    expect(page).toContain(
      'if (!(event instanceof CustomEvent) || event.detail !== POLL_CHANGE_SOURCE) return;',
    );
    expect(page).toContain("void loadActivity('merge');");
    expect(page).toContain('setItems((prev) => mergeFresh(prev, result.data, sort));');
    // The provider skips a count refresh for its own poll event.
    expect(provider).toMatch(
      /if \(event instanceof CustomEvent && event\.detail === POLL_CHANGE_SOURCE\) return;/,
    );
  });

  it('fix 18: a load or load-more that went stale (seq, chip or sort moved on) is dropped', () => {
    expect(page).toContain('const activitySeqRef = useRef(0);');
    expect(page).toContain('if (seq !== activitySeqRef.current) return;');
    expect(page).toMatch(
      /seq !== activitySeqRef\.current \|\|\s*stateRef\.current !== chip \|\|\s*sortRef\.current !== direction/,
    );
    expect(page).toContain('setItems((prev) => appendUnique(prev, result.data));');
  });

  it('fix 18: only a load bumps the sequence, so the first page is never dropped on mount', () => {
    // The workspace-reset effect runs right after the first 'reset' load starts:
    // a bump there would drop page one and leave the feed empty.
    expect(count(page, 'activitySeqRef.current += 1')).toBe(1);
    expect(page).toContain("if (mode !== 'merge') activitySeqRef.current += 1;");
  });

  it('fix 19: every provider read is dropped once its workspace or user is no longer active', () => {
    expect(provider).toContain('workspaceIdRef.current === ws && userIdRef.current === uid');
    expect(count(provider, 'if (!stillActive(ws, uid)) return;')).toBeGreaterThanOrEqual(4);
    expect(provider).toContain('if (workspaceIdRef.current !== ws) return;');
  });

  it('fix 20: one poll in flight at a time, and a row is toasted once', () => {
    expect(provider).toContain('if (ws === null || uid === null || inFlightRef.current) return;');
    expect(provider).toMatch(
      /inFlightRef\.current = true;\s*void pollNew\(ws, uid\)\.finally\(\(\) => \{\s*inFlightRef\.current = false;/,
    );
    expect(provider).toContain('const fresh = unseenRows(summary.newRows, toastedRef.current);');
    expect(provider).toContain('toastedRef.current = new Set();');
  });

  it('fix 21: opening an entry marks it read through the reverting batch', () => {
    expect(page).toContain('if (open.markRead && entry.readAt === null) markEntriesRead([entry]);');
    expect(page).not.toContain('void markEntryRead(supabase, entry, workspaceId, newTrace());');
    expect(page).toMatch(
      /revertRead\(failed, stamp\);\s*toast\?\.show\(\{ title: MARK_READ_FAILED \}\);/,
    );
  });

  it('fix 22: a partial failure reverts only the rows whose save failed', () => {
    expect(page).toContain(
      'entries.flatMap((entry, i) => (results[i]?.ok === true ? [] : [entry.id])),',
    );
    expect(page).toContain(
      'ids.has(item.id) && item.readAt === stamp ? { ...item, readAt: null } : item,',
    );
    expect(page).toContain('if (failed.size < entries.length) {');
  });

  it('fix 24: a failed refresh with rows on screen keeps them and toasts', () => {
    expect(page).toContain('if (itemsRef.current.length > 0) push(REFRESH_FAILED);');
    expect(page).toContain('else setError(true);');
    expect(page).toContain(') : error && items.length === 0 ? (');
  });

  it('fix 25: a failed snooze toasts the fixed copy and logs the trace id, never the raw error', () => {
    expect(page).toMatch(
      /logger\.warn\('notifications: snooze failed', \{\s*trace_id: traceId,\s*error: result\.error\.message,\s*\}\);\s*push\(SNOOZE_FAILED\);/,
    );
    expect(page).not.toContain('push(result.error.message)');
  });

  it('fix 27: Today and Yesterday follow the workspace timezone and roll over at its midnight', () => {
    expect(page).toContain('groupDigest(filterByState(items, state, nowMs), sort, { nowMs, tz })');
    expect(page).toContain('msUntilZonedMidnight(nowMs, tz)');
    expect(page).toContain('?.timezone ?? null');
  });

  it('fix 28: the provider seeds its mark from the newest server row, never the device clock', () => {
    expect(provider).toContain('const highWaterRef = useRef<number | null>(null);');
    expect(provider).not.toContain('useRef<number>(Date.now())');
    expect(provider).not.toContain('highWaterRef.current = Date.now()');
    expect(provider).toContain(
      'const res = await fetchNewestInboxAt(supabase, { workspaceId: ws, userId: uid });',
    );
    expect(provider).toContain('void seedHighWater(workspaceId, userId);');
  });

  it('fix 29: a chat mention also speaks on the background tab', () => {
    expect(provider).toContain("pushTabAlert({ kind: 'chat', text: mentionTabText(name) });");
  });
});
