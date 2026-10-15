// The chat bell's plan rows (item 12): plan_opened, plan_deleted,
// plan_date_changed, plan_updated, plan_review and plan_comment are bell-only
// rows with their own copy; a tap marks the row read and opens the plan.

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
  type BellActionDeps,
  type BellContextValue,
} from '@/components/chat/BellContext';
import { NowTab, visibleNowSections } from '@/components/chat/NotificationsPanel';
import {
  EMPTY_BELL,
  PLAN_DELETED_BELL_TOAST,
  bellUnreadCount,
  mapBellEntry,
  planBellLine,
  readPlanRowTitles,
  type BellData,
  type BellEntry,
} from '@/lib/chat/bell';

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

const names = { who: 'Priya', plan: 'Week of 12 Oct', item: 'Carousel' };

describe('mapping and sections', () => {
  it('every plan alert maps to a bell row with its plan fields', () => {
    for (const event_type of [
      'plan_opened',
      'plan_deleted',
      'plan_date_changed',
      'plan_updated',
    ] as const) {
      expect(entry({ event_type }).plan).toMatchObject({
        planId: 'plan1',
        planTitle: 'Week of 12 Oct',
      });
    }
    const review = entry({
      event_type: 'plan_review',
      entity_type: 'plan_item',
      entity_id: 'item9',
      payload: { plan_id: 'plan1', side: 'client', status: 'approved' },
    });
    expect(review.plan).toMatchObject({
      planId: 'plan1',
      itemId: 'item9',
      planTitle: null,
      reviewSide: 'client',
      reviewStatus: 'approved',
    });
    expect(review.channelId).toBeNull();
  });

  it('plan rows form the Plans section and count in the dot', () => {
    const rows = [
      entry({ id: 'a' }),
      entry({ id: 'b', event_type: 'plan_comment', entity_type: 'plan_item', entity_id: 'i' }),
    ];
    const sections = visibleNowSections(rows, new Set(), Date.now());
    expect(sections.map((s) => s.key)).toEqual(['plans']);
    expect(sections[0]?.title).toBe('Plans');
    expect(bellUnreadCount(rows, Date.now())).toBe(2);
  });
});

describe('row copy', () => {
  it('plan_opened per side; plan_deleted', () => {
    const opened = entry({});
    expect(planBellLine(opened, names, 'client')).toBe('Priya shared Week of 12 Oct with you');
    expect(planBellLine(opened, names, 'agency')).toBe('Priya opened Week of 12 Oct for approvers');
    expect(planBellLine(entry({ event_type: 'plan_deleted' }), names, 'agency')).toBe(
      'Priya deleted Week of 12 Oct',
    );
  });

  it('plan_date_changed: moved to a day, No date, or left the plan', () => {
    const moved = entry({
      event_type: 'plan_date_changed',
      payload: { plan_id: 'plan1', item_id: 'i', to: '2026-10-15', left_plan: false },
    });
    expect(planBellLine(moved, names, 'client')).toBe('Carousel moved to Thu 15 Oct');
    const undated = entry({
      event_type: 'plan_date_changed',
      payload: { plan_id: 'plan1', item_id: 'i', to: null, left_plan: false },
    });
    expect(planBellLine(undated, names, 'client')).toBe('Carousel moved to No date');
    const left = entry({
      event_type: 'plan_date_changed',
      payload: { plan_id: 'plan1', item_id: 'i', to: '2026-11-02', left_plan: true },
    });
    expect(planBellLine(left, names, 'client')).toBe('Carousel left Week of 12 Oct');
  });

  it('plan_updated kinds', () => {
    const kind = (k: string, extra: Record<string, unknown> = {}): BellEntry =>
      entry({ event_type: 'plan_updated', payload: { plan_id: 'plan1', kind: k, ...extra } });
    expect(planBellLine(kind('slot_added'), names, 'agency')).toBe('Priya added to Week of 12 Oct');
    expect(planBellLine(kind('slot_removed'), names, 'agency')).toBe(
      'Priya removed Carousel from Week of 12 Oct',
    );
    expect(planBellLine(kind('concept_changed'), names, 'agency')).toBe('Priya changed Carousel');
    expect(
      planBellLine(kind('renamed', { from: 'Old', to: 'New' }), { ...names, item: null }, 'agency'),
    ).toBe('Priya renamed Old to New');
  });

  it('plan_review and plan_comment reuse the Activity wording', () => {
    const review = entry({
      event_type: 'plan_review',
      entity_type: 'plan_item',
      entity_id: 'i',
      payload: { plan_id: 'plan1', side: 'client', status: 'approved' },
    });
    expect(planBellLine(review, names, 'agency')).toBe('Priya approved a plan item');
    const comment = entry({ event_type: 'plan_comment', entity_type: 'plan_item', entity_id: 'i' });
    expect(planBellLine(comment, names, 'agency')).toBe('Priya commented on a plan item');
  });

  it('missing names degrade, never blank; no em-dash', () => {
    const line = planBellLine(
      entry({ event_type: 'plan_deleted', payload: { plan_id: 'plan1' } }),
      { who: null, plan: null, item: null },
      'agency',
    );
    expect(line).toBe('Someone deleted a plan');
    expect(line).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('tap', () => {
  function harness() {
    const events: string[] = [];
    const toasts: string[] = [];
    const client = {
      rpc(name: string) {
        events.push(`rpc:${name}`);
        const result = Promise.resolve({ data: null, error: null });
        return Object.assign(result, { abortSignal: () => result });
      },
    };
    const deps: BellActionDeps = {
      client: client as unknown as BellActionDeps['client'],
      workspaceId: 'w1',
      newTraceId: () => 'trace-x',
      newId: () => 'id',
      reload: () => events.push('reload'),
      hide: () => undefined,
      unhide: () => undefined,
      entries: () => [],
      failed: () => undefined,
      notify: (title) => toasts.push(title),
      goToMessage: () => events.push('go-message'),
      goToPlan: (href) => events.push(`plan:${href}`),
      openChannelSheet: () => undefined,
      isStaleFailed: () => false,
      remindersChanged: () => undefined,
    };
    return { actions: createBellActions(deps), events, toasts };
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('marks read (the existing proc), then opens /plans/{id}?item=', async () => {
    const h = harness();
    h.actions.openEntry(
      entry({ event_type: 'plan_comment', entity_type: 'plan_item', entity_id: 'item9' }),
    );
    await flush();
    expect(h.events).toEqual(['rpc:inbox_mark_read', 'reload', 'plan:/plans/plan1?item=item9']);
  });

  it('a slot that left the plan opens the plan alone', async () => {
    const h = harness();
    h.actions.openEntry(
      entry({
        event_type: 'plan_date_changed',
        payload: { plan_id: 'plan1', item_id: 'i', left_plan: true },
      }),
    );
    await flush();
    expect(h.events.at(-1)).toBe('plan:/plans/plan1');
  });

  it('plan_deleted opens nothing and toasts "This plan was deleted"', async () => {
    const h = harness();
    h.actions.openEntry(entry({ event_type: 'plan_deleted' }));
    await flush();
    expect(h.events).toEqual(['rpc:inbox_mark_read', 'reload']);
    expect(h.toasts).toEqual([PLAN_DELETED_BELL_TOAST]);
    expect(PLAN_DELETED_BELL_TOAST).toBe('This plan was deleted');
  });
});

describe('the row (reuses the bell row component)', () => {
  it('renders in the Plans section with the line, the plan title and a 44px target', () => {
    const noop = (): void => undefined;
    const anoop = async (): Promise<void> => undefined;
    const data: BellData = { ...EMPTY_BELL, entries: [entry({})] };
    const bell = {
      data,
      status: 'ready',
      hiddenIds: new Set<string>(),
      nameOf: (id: string) => (id === 'u2' ? 'Priya' : undefined),
      chatNameOf: () => 'Chat',
      openEntry: noop,
      clearSent: anoop,
      loadMore: noop,
      loadingMore: false,
    } as unknown as BellContextValue;
    const html = renderToStaticMarkup(<NowTab bell={bell} />);
    expect(html).toContain('data-bell-section="plans"');
    expect(html).toContain('data-bell-row="plan"');
    expect(html).toContain('Priya opened Week of 12 Oct for approvers');
    expect(html).toMatch(/data-bell-open="e1"[^>]*min-h-\[44px\]/);
  });
});

describe('titles: one batched read per table, never per row', () => {
  it('reads plan titles only for rows without plan_title; items, then their posts', async () => {
    const reads: Array<[string, string[]]> = [];
    const data: Record<string, unknown[]> = {
      plans: [{ id: 'plan2', title: 'Launch' }],
      plan_items: [
        { id: 'i1', title: 'Reel', post_id: null },
        { id: 'i2', title: null, post_id: 'post2' },
      ],
      posts: [{ id: 'post2', title: 'Carousel' }],
    };
    const client = {
      from: (table: string) => ({
        select: () => ({
          in: (_c: string, ids: string[]) => {
            reads.push([table, ids]);
            return Promise.resolve({ data: data[table] ?? [], error: null });
          },
        }),
      }),
    } as unknown as Parameters<typeof readPlanRowTitles>[0];
    const rows = [
      entry({ id: 'a', payload: { plan_id: 'plan1', plan_title: 'Week' } }),
      entry({
        id: 'b',
        event_type: 'plan_updated',
        entity_id: 'plan2',
        payload: { plan_id: 'plan2', kind: 'concept_changed', item_id: 'i1' },
      }),
      entry({
        id: 'c',
        event_type: 'plan_date_changed',
        entity_id: 'plan2',
        payload: { plan_id: 'plan2', item_id: 'i2', post_id: 'post2', to: '2026-10-15' },
      }),
    ];
    const out = await readPlanRowTitles(client, rows);
    expect(reads.map(([t]) => t)).toEqual(['plans', 'plan_items', 'posts']);
    expect(reads[0]?.[1]).toEqual(['plan2']);
    expect(out.plans.get('plan2')).toBe('Launch');
    expect(out.items.get('i1')).toBe('Reel');
    expect(out.items.get('i2')).toBe('Carousel');
  });
});
