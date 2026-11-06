// @vitest-environment jsdom
// From bank (PR C): the branches a picked idea takes (one / none / several /
// shared warning / past), the header "+" day, the read on open only, the
// laptop month's trace lines, and the Plan screen's Open and send sheet path.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));

import type { PlanRow } from '@/lib/chat/plans';
import { fromBankDay, fromBankQuery, fromBankStep } from './BankPickSheet';
import { capWithTraces, traceDays } from './PlanCalendar';

const plan = (id: string, starts: string, ends: string, audience: 'team' | 'client'): PlanRow => ({
  id,
  workspace_id: 'ws',
  title: id,
  starts_on: starts,
  ends_on: ends,
  audience,
  created_by: null,
});

const draft = plan('draft', '2026-11-02', '2026-11-08', 'team');
const shared = plan('shared', '2026-11-02', '2026-11-08', 'client');
const later = plan('later', '2026-11-09', '2026-11-15', 'team');
const TODAY = '2026-11-04';

describe('From bank branches', () => {
  it('one plan on the day places at once', () => {
    expect(fromBankStep([draft, later], '2026-11-05', TODAY, { show_to_client: false })).toEqual({
      kind: 'place',
      plan: draft,
    });
  });

  it('no plan on the day offers Make plan', () => {
    expect(fromBankStep([later], '2026-11-05', TODAY, { show_to_client: false }).kind).toBe('none');
    expect(fromBankStep([], '2026-11-05', TODAY, { show_to_client: false }).kind).toBe('none');
  });

  it('several plans on the day open the plan picker', () => {
    const step = fromBankStep([draft, shared], '2026-11-05', TODAY, { show_to_client: false });
    expect(step.kind).toBe('several');
    if (step.kind === 'several')
      expect(step.plans.map((p) => p.id).sort()).toEqual(['draft', 'shared']);
  });

  it('a shared plan with a team-only idea asks first; a shown idea goes straight in', () => {
    expect(fromBankStep([shared], '2026-11-05', TODAY, { show_to_client: false })).toEqual({
      kind: 'shared',
      plan: shared,
    });
    expect(fromBankStep([shared], '2026-11-05', TODAY, { show_to_client: true })).toEqual({
      kind: 'place',
      plan: shared,
    });
  });

  it('a past day is refused', () => {
    expect(fromBankStep([draft], '2026-11-03', TODAY, { show_to_client: false }).kind).toBe('past');
  });

  it('the header "+" takes today when the plan holds it, else its nearest day', () => {
    expect(fromBankDay(draft, TODAY)).toBe(TODAY);
    expect(fromBankDay(later, TODAY)).toBe('2026-11-09');
    expect(fromBankDay(draft, '2026-11-20')).toBe('2026-11-08');
  });

  it('reads the live bank, Recently active, starred first (readBankPage)', () => {
    expect(fromBankQuery('ws')).toEqual({
      workspaceId: 'ws',
      sort: 'active',
      bucketId: null,
      archived: false,
      staleBefore: null,
    });
  });

  it('reads when it opens, never before; 12 a page with Load more', () => {
    const src = readFileSync(new URL('./BankPickSheet.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;[\s\S]*?readFirst\(\);/);
    expect(src).toContain('PlanTabLoadMore');
    expect(src).toContain('tone="search"');
    expect(src).toContain("kind: 'undo'");
    expect(src).toContain('unplanBankIdea');
  });

  it('From bank is the third Add entry after New concept and Pick a post', () => {
    const add = readFileSync(new URL('../../chat/PlanAddSheet.tsx', import.meta.url), 'utf8');
    expect(add).toMatch(/New concept[\s\S]*Pick a post[\s\S]*From bank/);
    const tab = readFileSync(new URL('./PlanTabAdd.tsx', import.meta.url), 'utf8');
    expect(tab).toContain("onFromBank={() => setStage('bank')}");
    const menu = readFileSync(new URL('./PlanDayMenu.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('data-plan-tab-menu-bank');
  });
});

describe('laptop month trace lines', () => {
  const trace = (itemId: string, planId: string, day: string) => ({
    itemId,
    planId,
    title: itemId,
    day,
    movedAt: '2026-11-03T10:00:00Z',
  });

  it('entries first, traces in the room left, the rest counted in +N more', () => {
    expect(capWithTraces(['a'], ['t1', 't2'], 3)).toEqual({
      shown: ['a'],
      traces: ['t1', 't2'],
      more: 0,
    });
    expect(capWithTraces(['a', 'b'], ['t1', 't2'], 2)).toEqual({
      shown: ['a', 'b'],
      traces: [],
      more: 2,
    });
    expect(capWithTraces(['a', 'b', 'c'], ['t1'], 2)).toEqual({
      shown: ['a', 'b'],
      traces: [],
      more: 2,
    });
  });

  it('drops traces of items back in their plan and other plans under a chip', () => {
    const bundles = [
      { plan: draft, items: [{ id: 'back' }] },
      { plan: later, items: [] },
    ] as unknown as Parameters<typeof traceDays>[1];
    const traces = new Map([
      ['draft', [trace('back', 'draft', '2026-11-04'), trace('gone', 'draft', '2026-11-04')]],
      ['later', [trace('x', 'later', '2026-11-10')]],
    ]);
    const all = traceDays(traces, bundles, null);
    expect(all.get('2026-11-04')?.map((t) => t.itemId)).toEqual(['gone']);
    expect(all.get('2026-11-10')?.map((t) => t.itemId)).toEqual(['x']);
    expect(traceDays(traces, bundles, 'later').get('2026-11-04')).toBeUndefined();
  });

  it('the line is quiet: fg-3, dashed, the bank icon, never a button; agency month only', () => {
    const src = readFileSync(new URL('./PlanCalendar.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/function MonthTrace[\s\S]*?<span\s+data-plan-tab-trace/);
    expect(src).toMatch(/data-plan-tab-trace[\s\S]*?border-dashed[\s\S]*?text-fg-3/);
    expect(src).toContain("enabled: side === 'agency' && props.data !== null && view === 'month'");
  });
});

describe('Plan screen: a Draft plan refused for a chat with approvers', () => {
  const src = readFileSync(new URL('../../chat/PlanScreen.tsx', import.meta.url), 'utf8');

  it('opens "Open this plan for approvers?" instead of the old hint', () => {
    expect(src).toMatch(
      /if \(!afterOpen && refusedForClient\(result\.message\) && bundle !== null\) \{[\s\S]*?setOpenSendAsk\(\{[\s\S]*?chatName: chat\.name/,
    );
  });

  it('Open and send runs plan_share_with_client, then chat_plan_share again', () => {
    expect(src).toMatch(
      /<PlanOpenSendSheet[\s\S]*?onOpenAndSend=\{\(\) => \{[\s\S]*?void openForClient\(true\);/,
    );
    expect(src).toMatch(
      /const openForClient = async[\s\S]*?planShareWithClient\([\s\S]*?if \(thenSend\) await sendHere\(true\);/,
    );
  });
});
