// @vitest-environment jsdom
// From bank (PR C): the branches a picked idea takes (one / none / several /
// shared warning / past), the header "+" day, the read on open only, and the
// Plan screen's Open and send sheet path.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));

import type { PlanRow } from '@/lib/chat/plans';
import { fromBankDay, fromBankQuery, fromBankStep } from './BankPickSheet';

/** A source file next to this test (read as text). */
function here(rel: string): string {
  return resolve(process.cwd(), 'src/components/pages/plan-tab', rel);
}

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
    const src = readFileSync(here('./BankPickSheet.tsx'), 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;[\s\S]*?readFirst\(\);/);
    expect(src).toContain('PlanTabLoadMore');
    expect(src).toContain('tone="search"');
    expect(src).toContain("kind: 'undo'");
    expect(src).toContain('unplanBankIdea');
  });

  it('From bank is the third Add entry after New concept and Pick a post', () => {
    const add = readFileSync(here('../../chat/PlanAddSheet.tsx'), 'utf8');
    expect(add).toMatch(/New concept[\s\S]*Pick a post[\s\S]*From bank/);
  });
});

describe('Plan screen: a Draft plan refused for a chat with approvers', () => {
  const src = readFileSync(here('../../chat/PlanScreen.tsx'), 'utf8');

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
