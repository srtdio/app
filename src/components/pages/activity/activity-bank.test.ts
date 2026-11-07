// The idea bank's Activity rows: each event's line for team and client
// viewers, its tap (the bank idea, the plan it joined, or nothing for a client
// reading a moved idea), the Plans chip, the live alert tier, and that none
// of them combine into one card.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Database } from '@srtdio/schemas';
import {
  alertBody,
  alertTitle,
  alertTopLine,
  entityKey,
  filterByState,
  mapEntry,
  openAction,
  opensNothing,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { isLiveActivityRow } from '@/lib/inbox/bell-types';
import { BANK_LABEL, bankAlertLine } from '@/lib/inbox/alerts';
import { eventLabel, eventVerb } from '@/lib/inbox/inbox-live';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const Q = (t: string): string => `“${t}”`;

// The planned day reads without a year in the current year: pin the clock.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

function row(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'bank_idea_added',
    entity_type: 'plan_item',
    entity_id: 'i1',
    scope: 'posts',
    scope_key: 'bank',
    tier: 'active',
    payload: { title: 'Reels week', plan_id: null },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-11-06T10:00:00.000Z',
    actor_user_id: 'u2',
    ...over,
  };
}

function item(over: Partial<InboxEntryRow>): ActivityItem {
  return { ...mapEntry(row(over)), actorName: 'Asha' };
}

const added = (): ActivityItem => item({});
const moved = (): ActivityItem =>
  item({
    id: 'e2',
    event_type: 'bank_idea_moved',
    scope_key: 'p1',
    payload: {
      title: 'Reels week',
      from_plan_id: 'p1',
      from_plan_title: 'October plan',
      target_date: '2026-10-28',
      plan_id: 'p1',
    },
  });
const planned = (): ActivityItem =>
  item({
    id: 'e3',
    event_type: 'bank_idea_planned',
    scope_key: 'p2',
    payload: {
      title: 'Reels week',
      plan_title: 'November plan',
      target_date: '2026-11-12',
      plan_id: 'p2',
    },
  });
const shown = (): ActivityItem => item({ id: 'e4', event_type: 'bank_idea_shown' });
const hidden = (): ActivityItem => item({ id: 'e5', event_type: 'bank_idea_hidden' });

const title = (i: ActivityItem, side: 'agency' | 'client'): string => {
  if (i.alert == null) throw new Error('not an alert');
  return alertTitle(i, i.alert, side);
};

describe('idea bank rows: copy for team and client viewers', () => {
  it('bank_idea_added', () => {
    expect(title(added(), 'agency')).toBe(`Asha added ${Q('Reels week')} to the bank`);
  });

  it('bank_idea_moved: team and client', () => {
    expect(title(moved(), 'agency')).toBe(
      `Asha moved ${Q('Reels week')} from October plan to the bank`,
    );
    expect(title(moved(), 'client')).toBe(`${Q('Reels week')} was moved to the agency's idea bank`);
  });

  it('bank_idea_planned names the plan and the day (no year in the current year)', () => {
    expect(title(planned(), 'agency')).toBe(
      `Asha planned ${Q('Reels week')} in November plan, 12 Nov`,
    );
    const nextYear = bankAlertLine(
      'bank_idea_planned',
      { title: 'X', planTitle: 'P', fromPlanTitle: null, targetDate: '2027-01-04' },
      'Asha',
      'agency',
      new Date(NOW),
    );
    expect(nextYear).toBe(`Asha planned ${Q('X')} in P, 4 Jan 2027`);
  });

  it('bank_idea_shown: client and team', () => {
    expect(title(shown(), 'client')).toBe(`Asha shared an idea with you: ${Q('Reels week')}`);
    expect(title(shown(), 'agency')).toBe(`Asha showed ${Q('Reels week')} to the client`);
  });

  it('bank_idea_hidden', () => {
    expect(title(hidden(), 'agency')).toBe(`Asha hid ${Q('Reels week')} from the client`);
  });

  it('the card top line is the actor, else "Idea bank"; no second line', () => {
    const i = added();
    if (i.alert == null) throw new Error('not an alert');
    expect(alertTopLine(i, i.alert)).toBe('Asha');
    expect(alertTopLine({ actorName: null }, i.alert)).toBe(BANK_LABEL);
    expect(alertBody(i.alert)).toBeNull();
  });

  it('renders from the payload alone (title, plan_title, target_date): no item read needed', () => {
    const p = planned();
    expect(p.alert?.bank).toEqual({
      title: 'Reels week',
      planTitle: 'November plan',
      fromPlanTitle: null,
      targetDate: '2026-11-12',
    });
  });
});

describe('idea bank rows: where a tap goes', () => {
  it('added, shown and hidden open the idea in the bank', () => {
    for (const i of [added(), shown(), hidden()]) {
      expect(openAction(i, null, 'agency')).toEqual({
        href: '/plan/bank?item=i1',
        markRead: true,
        toast: null,
      });
    }
    expect(openAction(shown(), null, 'client').href).toBe('/plan/bank?item=i1');
  });

  it('a moved idea opens the bank for the team and nothing for a client', () => {
    expect(openAction(moved(), null, 'agency').href).toBe('/plan/bank?item=i1');
    expect(openAction(moved(), null, 'client')).toEqual({
      href: null,
      markRead: true,
      toast: null,
    });
    expect(opensNothing(moved(), 'client')).toBe(true);
    expect(opensNothing(moved(), 'agency')).toBe(false);
    // An unknown side (the shell's live toast) never sends anyone to the bank for a move.
    expect(openAction(moved()).href).toBeNull();
  });

  it('a planned idea opens in the plan it joined', () => {
    expect(openAction(planned(), null, 'agency').href).toBe('/plan/p2?item=i1');
  });

  it('a comment and a mention on a bank idea open the idea, at the comment when known', () => {
    const comment = item({
      id: 'c1',
      event_type: 'plan_comment',
      payload: { comment_id: 'pc1', visibility: 'everyone', plan_id: null },
    });
    expect(openAction(comment, null, 'agency').href).toBe('/plan/bank?item=i1&comment=pc1');
    const mention = item({
      id: 'c2',
      event_type: 'mention',
      tier: 'urgent',
      payload: { comment_id: 'pc2', plan_id: null },
    });
    expect(openAction(mention, null, 'client').href).toBe('/plan/bank?item=i1&comment=pc2');
    const noComment = item({ id: 'c3', event_type: 'plan_comment', payload: { plan_id: null } });
    expect(openAction(noComment, null, 'agency').href).toBe('/plan/bank?item=i1');
  });

  it('a plan comment in a plan keeps its Plan tab link', () => {
    const inPlan = item({
      id: 'c4',
      event_type: 'plan_comment',
      scope_key: 'p1',
      payload: { comment_id: 'pc4', plan_id: 'p1' },
    });
    expect(openAction(inPlan, null, 'agency').href).toBe('/plan/p1?item=i1&comment=pc4');
  });
});

describe('idea bank rows: chip, tier, grouping', () => {
  const all = (): ActivityItem[] => [added(), moved(), planned(), shown(), hidden()];

  it('All shows every bank event (no Plans chip)', () => {
    expect(filterByState(all(), 'all', NOW).map((i) => i.eventType)).toEqual([
      'bank_idea_added',
      'bank_idea_moved',
      'bank_idea_planned',
      'bank_idea_shown',
      'bank_idea_hidden',
    ]);
  });

  it('every bank event is tier active: pop-up, sound and tab blink like a plan comment', () => {
    for (const t of [
      'bank_idea_added',
      'bank_idea_moved',
      'bank_idea_planned',
      'bank_idea_shown',
      'bank_idea_hidden',
    ]) {
      expect(isLiveActivityRow({ event_type: t, entity_type: 'plan_item' })).toBe(true);
      expect(isLiveActivityRow({ event_type: 'plan_comment', entity_type: 'plan_item' })).toBe(
        true,
      );
      expect(eventLabel(t)).toBe('Idea bank');
      expect(eventVerb({ eventType: t })).not.toBeNull();
    }
  });

  it('none combine: each bank row is its own card, even on the same idea', () => {
    const keys = all().map(entityKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
