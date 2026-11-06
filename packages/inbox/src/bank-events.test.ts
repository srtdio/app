import { describe, expect, it } from 'vitest';
import {
  BANK_EVENT_TYPES,
  bankEventInBank,
  bankEventLine,
  bankEventOpens,
  bankFieldsOf,
  isBankEvent,
  isTeamOnlyBankEvent,
  type BankEventFields,
} from './bank-events';

const Q = (t: string): string => `“${t}”`;
const day = (civil: string): string => (civil === '2026-11-12' ? '12 Nov' : civil);
const fields: BankEventFields = {
  title: 'Reels week',
  planTitle: 'November plan',
  fromPlanTitle: 'October plan',
  targetDate: '2026-11-12',
};

describe('bankEventLine: the shared Activity and email words', () => {
  it('bank_idea_added (team)', () => {
    expect(bankEventLine('bank_idea_added', fields, 'Asha', 'team', day)).toBe(
      `Asha added ${Q('Reels week')} to the bank`,
    );
  });

  it('bank_idea_moved: team names the plan it left; a client reads it without a name', () => {
    expect(bankEventLine('bank_idea_moved', fields, 'Asha', 'team', day)).toBe(
      `Asha moved ${Q('Reels week')} from October plan to the bank`,
    );
    expect(bankEventLine('bank_idea_moved', fields, 'Asha', 'client', day)).toBe(
      `${Q('Reels week')} was moved to the agency's idea bank`,
    );
  });

  it('bank_idea_planned names the plan and the day', () => {
    expect(bankEventLine('bank_idea_planned', fields, 'Asha', 'team', day)).toBe(
      `Asha planned ${Q('Reels week')} in November plan, 12 Nov`,
    );
    expect(
      bankEventLine('bank_idea_planned', { ...fields, targetDate: null }, 'Asha', 'team', day),
    ).toBe(`Asha planned ${Q('Reels week')} in November plan`);
  });

  it('bank_idea_shown: client and team words', () => {
    expect(bankEventLine('bank_idea_shown', fields, 'Asha', 'client', day)).toBe(
      `Asha shared an idea with you: ${Q('Reels week')}`,
    );
    expect(bankEventLine('bank_idea_shown', fields, 'Asha', 'team', day)).toBe(
      `Asha showed ${Q('Reels week')} to the client`,
    );
  });

  it('bank_idea_hidden (team)', () => {
    expect(bankEventLine('bank_idea_hidden', fields, 'Asha', 'team', day)).toBe(
      `Asha hid ${Q('Reels week')} from the client`,
    );
  });

  it('missing names and titles degrade, never blank, never an em-dash', () => {
    const empty = bankFieldsOf({});
    for (const t of BANK_EVENT_TYPES) {
      for (const viewer of ['team', 'client'] as const) {
        const line = bankEventLine(t, empty, null, viewer, day);
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toContain('undefined');
        expect(line).not.toContain('null');
        expect(line).not.toContain('—');
      }
    }
    expect(bankEventLine('bank_idea_added', empty, null, 'team', day)).toBe(
      'Someone added an idea to the bank',
    );
  });
});

describe('bank event helpers', () => {
  it('maps the payload', () => {
    expect(
      bankFieldsOf({
        title: 'A',
        plan_title: 'P',
        from_plan_title: 'F',
        target_date: '2026-11-12',
      }),
    ).toEqual({ title: 'A', planTitle: 'P', fromPlanTitle: 'F', targetDate: '2026-11-12' });
    expect(bankFieldsOf(null).title).toBeNull();
  });

  it('team-only: added, planned, hidden', () => {
    expect(BANK_EVENT_TYPES.filter(isTeamOnlyBankEvent)).toEqual([
      'bank_idea_added',
      'bank_idea_planned',
      'bank_idea_hidden',
    ]);
  });

  it('a moved idea opens nothing for a client; every other row opens', () => {
    for (const t of BANK_EVENT_TYPES) {
      expect(bankEventOpens(t, 'team')).toBe(true);
      expect(bankEventOpens(t, 'client')).toBe(t !== 'bank_idea_moved');
    }
  });

  it('a planned idea opens in its plan; the rest in the bank', () => {
    expect(BANK_EVENT_TYPES.filter((t) => !bankEventInBank(t))).toEqual(['bank_idea_planned']);
  });

  it('isBankEvent', () => {
    expect(isBankEvent('bank_idea_shown')).toBe(true);
    expect(isBankEvent('plan_comment')).toBe(false);
  });
});
