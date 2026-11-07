import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { ConceptDateField, rowSubline, screenProgressLabel } from '@/components/chat/PlanScreen';
import {
  CONCEPT_EDIT_RESET_HINT,
  canEditConcept,
  statusRows,
} from '@/components/chat/PlanItemScreen';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

function concept(over: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: 'c',
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Reel',
    description: 'Morning light',
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date: null,
    ...over,
  };
}

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: null,
  },
  items: [
    concept({ id: 'c1', target_date: '2026-10-12' }),
    { ...concept({ id: 'p1' }), kind: 'post', title: null, description: null, post_id: 'post1' },
  ],
  reviews: [
    { item_id: 'c1', side: 'team', status: 'approved' },
    { item_id: 'c1', side: 'client', status: 'changes' },
    { item_id: 'p1', side: 'client', status: 'approved' },
  ],
  postStages: { post1: 'review' },
  postInfo: { post1: { title: 'Carousel', target_date: '2026-10-13' } },
};

describe('Plan screen progress (D1)', () => {
  it('the same line for every viewer: Open "Approved X of N", Draft "Creators X of N"', () => {
    for (const side of ['agency', 'client', 'unknown'] as const) {
      expect(screenProgressLabel(BUNDLE, side)).toBe('Approved 1 of 2');
    }
    const draft = { ...BUNDLE, plan: { ...BUNDLE.plan, audience: 'team' as const } };
    expect(screenProgressLabel(draft, 'agency')).toBe('Creators 1 of 2');
  });
});

describe('rows and the item status box (D3)', () => {
  it('a row sub line is the concept description only (the date has its own line)', () => {
    expect(rowSubline(concept({}))).toBe('Morning light');
    expect(rowSubline(BUNDLE.items[1] as PlanItemRow)).toBe('');
  });

  it('the Pipeline row holds the stage only (the date row shows the day)', () => {
    const post = BUNDLE.items[1] as PlanItemRow;
    expect(statusRows(BUNDLE, post, 'client')[0]).toEqual({
      label: 'Pipeline',
      value: 'Review',
      tone: 'neutral',
    });
  });
});

describe('concept date field (D4)', () => {
  it('only the agency edits, and only a concept', () => {
    expect(canEditConcept('agency', { kind: 'concept' })).toBe(true);
    expect(canEditConcept('agency', { kind: 'post' })).toBe(false);
    expect(canEditConcept('client', { kind: 'concept' })).toBe(false);
    expect(canEditConcept('unknown', { kind: 'concept' })).toBe(false);
    expect(CONCEPT_EDIT_RESET_HINT).not.toContain(String.fromCharCode(0x2014));
  });

  it('empty by default (no Clear); a date shows a 44px ghost "Clear" text button', () => {
    const empty = renderToStaticMarkup(<ConceptDateField value="" onChange={() => undefined} />);
    // ui/DatePicker, never a native date input.
    expect(empty).not.toContain('type="date"');
    expect(empty).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-label="Date \(optional\)"/);
    expect(empty).toContain('Select a date');
    expect(empty).not.toContain('data-plan-concept-date-clear');
    const set = renderToStaticMarkup(
      <ConceptDateField value="2026-10-14" onChange={() => undefined} />,
    );
    expect(set).toContain('October 14, 2026');
    const clear =
      /<button[^>]*data-plan-concept-date-clear[^>]*>[^<]*<\/button>/.exec(set)?.[0] ?? '';
    expect(clear).toContain('h-11');
    expect(clear).toContain('min-w-11');
    expect(clear).toContain('lit-hover text-fg-2');
    expect(clear).toContain('aria-label="Clear date"');
    expect(clear).toMatch(/>Clear<\/button>$/);
  });

  it('disabled: the fieldset disables the picker trigger and Clear together', () => {
    const html = renderToStaticMarkup(
      <ConceptDateField value="2026-10-14" disabled onChange={() => undefined} />,
    );
    expect(html).toMatch(/<fieldset[^>]*data-plan-concept-date=""[^>]*disabled=""/);
  });
});
