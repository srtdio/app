// Notifications: Activity and the chat bell on one feed. The chips (All,
// Unread, Mentions: Mentions takes chat mentions; plan, brief and task alerts
// only under All and Unread), Mark all read (the top bar's primary; one
// inbox_mark_all_read call on All), Newest first order (no sort control), every
// former bell tap rule, the alert cards, and the batched enrichment (one IN
// read per table, never per row). Reminders and scheduled sends are retired:
// their rows map to no alert and the feed read leaves them out.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  openAction,
  opensNothing,
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
  it('is titled "Activity"; no Briefs or Plans chip, so no zero state of theirs', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("export const ACTIVITY_TITLE = 'Activity';");
    // The h1 is focusable from script (tabIndex -1) so a route change can move focus to it.
    expect(src).toMatch(/<h1 tabIndex=\{-1\} className="sr-only">\s*\{ACTIVITY_TITLE\}\s*<\/h1>/);
    expect(src).not.toContain('NOTIFICATIONS_TITLE');
    expect(src).not.toContain("state === 'plans'");
    expect(src).not.toContain("state === 'briefs'");
    expect(src).not.toContain('IconPlan');
    expect(src).not.toContain('IconBriefs');
    expect(Object.keys(EMPTY_LINES).sort()).toEqual(['mentions', 'unread']);
  });

  it('has no visible title bar: no PageHead, it starts with the chip row', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('PageHead');
    expect(src).not.toContain('@/components/shell/PageHead');
    expect(src.indexOf('<h1 tabIndex={-1} className="sr-only">')).toBeLessThan(
      src.indexOf('<ActivityFilterBar'),
    );
  });
});

describe('chips', () => {
  it('Mentions takes every mention: chat mentions and post mentions alike', () => {
    expect(ids('mentions')).toEqual(['cm', 'pm']);
  });

  it('the six plan alert types show under All and Unread (no Plans chip)', () => {
    for (const id of PLAN_TYPES) {
      expect(ids('all')).toContain(id);
      expect(ids('unread')).toContain(id);
      expect(ids('mentions')).not.toContain(id);
    }
  });

  it('task alerts show only under All and Unread', () => {
    const alertIds = ['task', 'due'];
    for (const id of alertIds) {
      expect(ids('all')).toContain(id);
      expect(ids('unread')).toContain(id);
      expect(ids('mentions')).not.toContain(id);
    }
  });

  it('a row snoozed until later stays hidden from All and Unread (the read filter keeps it out)', () => {
    const snoozed = [plan('plan_opened', { snoozed_until: LATER }), task({ snoozed_until: LATER })];
    expect(ids('all', snoozed)).toEqual([]);
    expect(ids('unread', snoozed)).toEqual([]);
  });
});

describe('Mark all read', () => {
  it('the All chip targets every unread row of every type (one proc call covers them)', () => {
    const targets = markAllTargets(feed, 'all', NOW).map((i) => i.id);
    for (const id of ['cm', 'pm', ...PLAN_TYPES, 'task', 'due', 'comment']) {
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

  it("Mark all read is the top bar's primary (IconTickDouble), hidden at 0 unread", () => {
    const page = readFileSync(
      fileURLToPath(new URL('../NotificationsPage.tsx', import.meta.url)),
      'utf8',
    );
    // The top bar's primary slot: an IconButton, gone (undefined) with nothing unread
    // (the slot keeps its width); no sort beside it.
    expect(page).toContain("export const MARK_ALL_READ_LABEL = 'Mark all read';");
    expect(page).toMatch(
      /hasUnread \? \(\s*<IconButton\s+label=\{MARK_ALL_READ_LABEL\}[\s\S]{0,160}?<IconTickDouble size=\{ICON_SIZE\.control\} \/>[\s\S]{0,80}?\) : undefined/,
    );
    expect(page).toContain('const hasUnread = chipUnread > 0;');
    expect(page).toContain('useTopbarActions({ primary: markAllNode });');
    // Moved up from the day line: no link there any more, no count text.
    expect(page).not.toContain('<Button variant="link" onClick={handleMarkAll}>');
    expect(page).not.toContain('bucketIndex === 0 && chipUnread > 0');
    expect(page).not.toContain('{chipUnread} unread');
    expect(page).not.toContain('ActionMenu');
    expect(count(page, 'markAllRef.current()')).toBe(1);
  });
});

describe('taps: every former bell row keeps its behaviour', () => {
  it('a chat mention marks read, then opens the message', () => {
    expect(openAction(chatMention())).toEqual({
      href: '/chat?channel=c1&message=m9',
      markRead: true,
      toast: null,
    });
  });

  it('a plan alert marks read, then opens /plan/{id} with ?item= (not when the item left)', () => {
    expect(openAction(plan('plan_opened'))).toEqual({
      href: '/plan/plan1?item=i1',
      markRead: true,
      toast: null,
    });
    const left = plan('plan_date_changed', {
      payload: { plan_id: 'plan1', item_id: 'i1', left_plan: true },
    });
    expect(openAction(left).href).toBe('/plan/plan1');
    const edited = plan('plan_updated', {
      payload: { plan_id: 'plan1', plan_title: 'Week of 12 Oct', kind: 'edited' },
    });
    expect(openAction(edited)).toEqual({ href: '/plan/plan1', markRead: true, toast: null });
  });

  it('plan_deleted (or a plan alert with no id) marks read, toasts and opens nothing', () => {
    const deleted = { href: null, markRead: true, toast: PLAN_DELETED_TOAST };
    expect(openAction(plan('plan_deleted'))).toEqual(deleted);
    expect(openAction(plan('plan_updated', { entity_id: null, payload: {} }))).toEqual(deleted);
    expect(PLAN_DELETED_TOAST).toBe('This plan was deleted');
  });

  it('plan_comment and plan_review keep their Activity deep link', () => {
    expect(openAction(planItemEvent('plan_comment')).href).toBe('/plan/plan1?item=i1&comment=pc1');
    expect(openAction(planItemEvent('plan_review')).href).toBe('/plan/plan1?item=i1');
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

  it('a deleted post has no tap; every alert keeps one', () => {
    expect(opensNothing(item({ event_type: 'post_deleted' }))).toBe(true);
    expect(opensNothing(task())).toBe(false);
    expect(opensNothing(plan('plan_deleted'))).toBe(false);
  });
});

describe('retired rows: reminders and scheduled sends', () => {
  it('map to no alert card (the feed read leaves them out)', () => {
    for (const eventType of ['reminder', 'scheduled_sent', 'scheduled_failed']) {
      const retired = item({
        id: eventType,
        event_type: eventType,
        entity_type: 'chat_channel',
        entity_id: 'c1',
        payload: { message_id: 'm1', scheduled_id: 's1' },
      });
      expect(retired.alert ?? null, eventType).toBeNull();
    }
  });
});

describe('alert wording (the bell lines on Activity cards)', () => {
  it('top line: the actor, else the alert label', () => {
    const t = task();
    if (t.alert == null) throw new Error('fixture');
    expect(alertTopLine(t, t.alert)).toBe('Tasks');
    expect(alertTopLine({ actorName: 'Priya' }, t.alert)).toBe('Priya');
    const p = plan('plan_opened');
    if (p.alert == null) throw new Error('fixture');
    expect(alertTopLine(p, p.alert)).toBe('Plan');
  });

  it('titles and bodies', () => {
    const p = { ...plan('plan_opened'), actorName: 'Priya' };
    const t = { ...task(), actorName: 'Leo' };
    if (p.alert == null || t.alert == null) throw new Error('fixture');
    expect(alertTitle(p, p.alert, 'client')).toBe('Priya shared Week of 12 Oct with you');
    expect(alertTitle(p, p.alert, 'agency')).toBe('Priya opened Week of 12 Oct for approvers');
    expect(alertTitle(t, t.alert, 'agency')).toBe(`Leo · added ${String.fromCharCode(35)}3 Hook`);
    expect(alertBody(t.alert)).toBe('Chat');
    expect(alertBody({ ...p.alert, itemTitle: 'Carousel' })).toBe('Carousel');
    expect(alertBody(p.alert)).toBeNull();
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
        selfName={null}
        {...extra}
      />,
    );
  }

  it('footer: every kind names its kind in the one tag', () => {
    const others: [ActivityItem, string][] = [
      [taskDue(), 'Reminder'],
      [plan('plan_opened', { scope: 'posts' }), 'Plan'],
      [item({ id: 'post', event_type: 'stage_change', scope: 'posts' }), 'Post'],
      [
        item({ id: 'brief', event_type: 'brief_created', entity_type: 'brief', scope: 'briefs' }),
        'Brief',
      ],
      [postMention(), 'Mention'],
      [chatMention(), 'Mention'],
    ];
    for (const [i, kind] of others) {
      const html = card([i]);
      expect(html, i.eventType).toMatch(
        new RegExp(`data-activity-scope-tag=""[^>]*>[^]*?">${kind}<`),
      );
    }
    // A chat task change is none of those kinds: no tag at all.
    expect(card([task()])).not.toContain('data-list-card-tag');
  });

  it('a missed task due time: the card frame, the bad time, the unread dot and its icon', () => {
    const html = card([taskDue()]);
    expect(html).toContain('data-activity-event="task_due"');
    expect(html).toContain('data-list-card=""');
    expect(html).not.toContain('data-activity-menu');
    expect(html).toContain('data-list-card-time-bad=""');
    expect(html).toContain('data-list-card-unread');
    expect(html).toContain('data-activity-alert-icon="task"');
    // The one tag names the kind: a missed due time reads Reminder.
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
          not: () => self,
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
      chat_channels: ok([{ channel_id: 'g-chan', channel_type: 'group', entity_id: 'g1' }]),
      groups: ok([{ id: 'g1', name: 'Launch crew' }]),
      plans: ok([{ id: 'plan2', title: 'Launch' }]),
      plan_items: ok([{ id: 'i2', plan_id: 'plan2', kind: 'post', title: null, post_id: 'post2' }]),
      posts: ok([{ id: 'post2', title: 'Carousel', format: 'text', caption: null, number: 2 }]),
      users: ok([{ id: 'u-cy', display_name: 'Cy', avatar_url: null }]),
    });
    const res = await fetchActivityEntries(client, 'w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.data.map((i) => [i.id, i]));

    const moved = byId.get('moved');
    expect(moved?.actorName).toBe('Cy');
    expect(moved?.alert).toMatchObject({ planTitle: 'Launch', itemTitle: 'Carousel' });
    const t = byId.get('task');
    if (t?.alert == null) throw new Error('fixture');
    expect(alertTitle(t, t.alert, 'agency')).toBe('Cy edited tasks');
    expect(alertBody(t.alert)).toBe('Launch crew');

    const perTable = (table: string) => ins.filter((c) => c.table === table);
    for (const table of ['chat_channels', 'groups', 'plans', 'plan_items', 'posts']) {
      expect(perTable(table), table).toHaveLength(1);
    }
    expect(perTable('chat_channels')[0]?.vals).toEqual(['g-chan']);
    // No alert previews a message or reads a scheduled row any more.
    expect(perTable('chat_messages')).toHaveLength(0);
    expect(perTable('chat_scheduled_messages')).toHaveLength(0);
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

  it('no search on Activity: no search box, no ?q=, no activity_search read', () => {
    expect(page).not.toContain('SectionHeader');
    expect(page).not.toContain('Search activity');
    expect(page).not.toContain('SEARCH_PARAM');
    expect(page).not.toContain('useServerSearch');
    expect(page).not.toContain('searchActivityEntries');
    expect(page).not.toContain('useSearchParams');
    expect(page).not.toContain('NoResults');
    expect(page).not.toContain('searching');
  });

  it('sort: no sort control in the top bar (decided 7 Nov); Newest first, read in that order', () => {
    expect(page).not.toContain('SortMenu');
    expect(page).not.toContain('useSort');
    expect(page).not.toMatch(/useTopbarActions\(\{[^}]*sort:/);
    expect(page).toContain('const sort: ActivityDirection = ACTIVITY_SORT_DEFAULT;');
    // Page one and every next page are read server-side in the chosen direction
    // (fetchActivityEntries' ascending keyset), each order with its own kept page.
    expect(page).toContain('direction: sort,');
    expect(page).toContain('activityPageKey(userId, workspaceId, state, sort)');
    expect(page).toMatch(
      /fetchActivityEntries\(supabase, workspaceId, \{\s*state: chip,\s*direction,\s*cursor,/,
    );
    // A load more that started under another sort is dropped.
    expect(page).toContain('sortRef.current !== direction');
    // No new RPC: the feed read is the only list read.
    expect(page).not.toMatch(/\.rpc\(|callRpc\(/);
  });

  it('fix 9 (catch up): opening a group opens catch up at its newest entry, the others follow', () => {
    expect(page).toContain('const head = groupHeadEntry(group);');
    expect(page).toMatch(
      /openCatchUp\(\s*head,\s*group\.filter\(\(e\) => e\.id !== head\.id\),?\s*\);/,
    );
    // A tap no longer marks the group read: catch up decides per card.
    expect(page).not.toContain('markEntriesRead(unread);');
  });

  it('fix 11: relative times age on the shared minute clock, never a page timer of its own', () => {
    expect(page).toContain('const clockMs = useMinuteClock();');
    expect(page).toContain('const nowMs = Math.max(clockMs, loadedMs);');
    expect(page).not.toContain('TIME_TICK_MS');
    expect(page).not.toContain('window.setInterval(');
    // Back on a hidden tab, the page re-stamps its clock at once.
    expect(page).toContain('if (!document.hidden) setNowMs(Date.now());');
  });

  it('fix 12: the page speaks of activity, never notifications, in its loading copy', () => {
    expect(page).not.toContain('Sort notifications');
    expect(page).not.toContain('Loading notifications');
    // Loading is the card-shaped boxes (ActivityBoxes), labelled "Loading activity".
    expect(page).toContain('<ActivityBoxes />');
    expect(page).not.toContain('Upcoming');
    expect(page).toContain('{updatesLabel(entries.length)}');
  });

  it('fix 13: each chip empty state is its one positive line', () => {
    for (const key of ['unread', 'mentions'] as const) {
      expect(page).toContain(`title={EMPTY_LINES.${key}}`);
    }
    expect(page).not.toContain('EMPTY_LINES.briefs');
    expect(page).not.toContain('EMPTY_LINES.plans');
    // The Unread chip's own line; All keeps its line word for word; no Snoozed line.
    expect(EMPTY_LINES.unread).toBe('New updates show up here.');
    expect(page).toContain('title="Activity across posts, briefs and people shows up here."');
    expect(page).not.toContain('EMPTY_LINES.snoozed');
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

  it('fix 18: a load or load-more that went stale (seq or chip moved on) is dropped', () => {
    expect(page).toContain('const activitySeqRef = useRef(0);');
    expect(page).toContain('if (seq !== activitySeqRef.current) return;');
    expect(page).toMatch(/seq !== activitySeqRef\.current \|\|\s*stateRef\.current !== chip \|\|/);
    expect(page).toContain('setItems((prev) => appendUnique(prev, result.data));');
  });

  it('fix 18: only a load bumps the sequence, so the first page is never dropped on mount', () => {
    // A bump anywhere but the load itself would drop page one and leave the feed empty.
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

  it('fix 21 (catch up): a row tap opens catch up with that entry first, never a direct navigate', () => {
    expect(page).toContain('(entry: ActivityItem) => openCatchUp(entry)');
    expect(page).not.toContain('if (open.href !== null) navigate(open.href);');
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
    expect(page).toContain(
      "if (itemsRef.current.length > 0) push(errorText('refresh', result.error));",
    );
    expect(page).toContain('else setError(true);');
    expect(page).toContain('{error && items.length === 0 ? (');
  });

  it('no snooze and no row menu: Activity has no per-row actions beyond the tap', () => {
    expect(page).not.toMatch(/snoozeEntry|handleSnooze|onSnooze|SnoozeKind|onMarkRead=/);
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
