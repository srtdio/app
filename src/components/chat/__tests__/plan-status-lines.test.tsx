// The Plan row's PLAN and POST lines: the pure helpers behind them (which
// control a row gets, its state and copy, the POST stage line, the header's
// two counts), the OK | Not OK switch and the decided pill, and the 4s plan
// Undo window on both plan screens (the shared UNDO_MS).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { PlanDecidedPill, PlanSwitch } from '@/components/chat/PlanScreen';
import {
  PLAN_LINE_LABEL,
  PLAN_NOT_CHECKED_LABEL,
  PLAN_NOT_OK_LABEL,
  PLAN_OK_LABEL,
  POST_LINE_LABEL,
  POST_NOT_MADE_LABEL,
  countPercent,
  planControl,
  planControlState,
  planControlText,
  planCountLabel,
  planHeaderCounts,
  postLine,
} from '@/components/chat/plan-card';
import { UNDO_MS } from '@/lib/undo';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'post',
    position: 0,
    title: null,
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

function bundle(audience: 'team' | 'client'): PlanBundle {
  return {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: null,
    },
    items: [
      item({ id: 'wait', post_id: 'post-review' }),
      item({ id: 'ok', post_id: 'post-approved' }),
      item({ id: 'no', post_id: 'post-parked' }),
      item({ id: 'draft', post_id: 'post-draft' }),
      item({ id: 'concept', kind: 'concept', title: 'Reel' }),
    ],
    reviews: [
      { item_id: 'ok', side: 'client', status: 'approved' },
      { item_id: 'no', side: 'client', status: 'changes' },
      { item_id: 'ok', side: 'team', status: 'approved' },
      { item_id: 'no', side: 'team', status: 'changes' },
    ],
    postStages: {
      'post-review': 'review',
      'post-approved': 'approved',
      'post-parked': 'parked',
      'post-draft': 'draft',
    },
    postInfo: {},
  };
}

const at = (b: PlanBundle, id: string): PlanItemRow => b.items.find((i) => i.id === id)!;

describe('planControl: which PLAN control a row gets', () => {
  it('a client on an Open plan: switch while waiting, OK / Not OK pills once decided', () => {
    const b = bundle('client');
    expect(planControl(b, at(b, 'wait'), 'client')).toEqual({ kind: 'switch', side: 'client' });
    expect(planControl(b, at(b, 'concept'), 'client')).toEqual({ kind: 'switch', side: 'client' });
    expect(planControl(b, at(b, 'ok'), 'client')).toEqual({
      kind: 'pill',
      side: 'client',
      status: 'approved',
    });
    expect(planControl(b, at(b, 'no'), 'client')).toEqual({
      kind: 'pill',
      side: 'client',
      status: 'changes',
    });
  });

  it('a client: none on a draft locked to them, none on a Draft plan', () => {
    const b = bundle('client');
    expect(planControl(b, at(b, 'draft'), 'client')).toEqual({ kind: 'none' });
    const d = bundle('team');
    for (const id of ['wait', 'ok', 'no', 'concept']) {
      expect(planControl(d, at(d, id), 'client')).toEqual({ kind: 'none' });
    }
  });

  it('the agency on an Open plan reads the client side as text', () => {
    const b = bundle('client');
    expect(planControl(b, at(b, 'ok'), 'agency')).toEqual({
      kind: 'text',
      side: 'client',
      status: 'approved',
    });
    expect(planControl(b, at(b, 'no'), 'agency')).toEqual({
      kind: 'text',
      side: 'client',
      status: 'changes',
    });
    expect(planControl(b, at(b, 'draft'), 'agency')).toEqual({
      kind: 'text',
      side: 'client',
      status: 'waiting',
    });
  });

  it('the agency on a Draft plan writes the team side', () => {
    const d = bundle('team');
    expect(planControl(d, at(d, 'wait'), 'agency')).toEqual({ kind: 'switch', side: 'team' });
    expect(planControl(d, at(d, 'ok'), 'agency')).toEqual({
      kind: 'pill',
      side: 'team',
      status: 'approved',
    });
    expect(planControl(d, at(d, 'no'), 'agency')).toEqual({
      kind: 'pill',
      side: 'team',
      status: 'changes',
    });
  });

  it('an unknown side gets nothing yet', () => {
    const b = bundle('client');
    expect(planControl(b, at(b, 'wait'), 'unknown')).toEqual({ kind: 'none' });
  });
});

describe('PLAN state and copy', () => {
  it('data-plan-slot-state: approved, changes, else pending', () => {
    expect(planControlState('approved')).toBe('approved');
    expect(planControlState('changes')).toBe('changes');
    expect(planControlState('waiting')).toBe('pending');
  });

  it('read-only text: OK, Not OK, Not checked yet', () => {
    expect(planControlText('approved')).toBe('OK');
    expect(planControlText('changes')).toBe('Not OK');
    expect(planControlText('waiting')).toBe('Not checked yet');
  });

  it('labels, with no em-dashes', () => {
    expect(PLAN_LINE_LABEL).toBe('PLAN');
    expect(POST_LINE_LABEL).toBe('POST');
    expect(PLAN_OK_LABEL).toBe('OK');
    expect(PLAN_NOT_OK_LABEL).toBe('Not OK');
    expect(PLAN_NOT_CHECKED_LABEL).toBe('Not checked yet');
    expect(POST_NOT_MADE_LABEL).toBe('Not made yet');
    for (const s of [PLAN_NOT_CHECKED_LABEL, POST_NOT_MADE_LABEL]) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('postLine: the POST stage line', () => {
  it('each stage by name, and Not made yet for a concept or an empty slot', () => {
    const b = bundle('client');
    const stages: Record<string, string> = {
      draft: 'Draft',
      review: 'Review',
      approved: 'Approved',
      parked: 'Parked',
      rejected: 'Rejected',
    };
    for (const [stage, label] of Object.entries(stages)) {
      const x = item({ id: 'x', post_id: 'px' });
      expect(postLine({ postStages: { px: stage } }, x)).toEqual({ label, tone: stage });
    }
    expect(postLine(b, at(b, 'wait'))).toEqual({ label: 'Review', tone: 'review' });
    expect(postLine(b, at(b, 'concept'))).toEqual({ label: 'Not made yet', tone: 'none' });
    expect(postLine(b, item({ id: 'empty', post_id: null }))).toEqual({
      label: 'Not made yet',
      tone: 'none',
    });
    // An unreadable post (no stage) reads as not made.
    expect(postLine(b, item({ id: 'hidden', post_id: 'hidden' }))).toEqual({
      label: 'Not made yet',
      tone: 'none',
    });
  });
});

describe('the header counts', () => {
  it('PLAN: the viewer side OK over the items it reviews; POST: approved posts over posts', () => {
    const b = bundle('client');
    // A client: the draft locked to them is not one they review.
    expect(planHeaderCounts(b, 'client')).toEqual({
      plan: { ok: 1, n: 4 },
      post: { approved: 1, n: 4 },
    });
    expect(planHeaderCounts(b, 'agency')).toEqual({
      plan: { ok: 1, n: 5 },
      post: { approved: 1, n: 4 },
    });
    const d = bundle('team');
    expect(planHeaderCounts(d, 'agency').plan).toEqual({ ok: 1, n: 5 });
  });

  it('"3/5 OK" and "2/4 approved"; the bar width', () => {
    expect(planCountLabel(3, 5, 'OK')).toBe('3/5 OK');
    expect(planCountLabel(2, 4, 'approved')).toBe('2/4 approved');
    expect(planCountLabel(0, 0, 'OK')).toBe('0/0 OK');
    expect(countPercent(2, 4)).toBe(50);
    expect(countPercent(1, 3)).toBe(33);
    expect(countPercent(0, 0)).toBe(0);
  });
});

describe('the PLAN switch and the decided pill', () => {
  const noop = (): void => undefined;

  it('switch: OK and Not OK buttons in 44px targets, pending, nothing pressed', () => {
    const html = renderToStaticMarkup(
      <PlanSwitch side="client" title="One" current={null} onOk={noop} onNotOk={noop} />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="PLAN: One"');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).toContain('data-plan-slot-state="pending"');
    expect(html).toContain('data-plan-control="switch"');
    // Attribute order follows the primitive, so match each part of the opening tag.
    expect(html).toMatch(
      /<button(?=[^>]*aria-pressed="false")(?=[^>]*data-plan-ok="")(?=[^>]*class="[^"]*h-11)/,
    );
    expect(html).toMatch(
      /<button(?=[^>]*aria-pressed="false")(?=[^>]*data-plan-not-ok="")(?=[^>]*class="[^"]*h-11)/,
    );
    expect(html).toMatch(/data-plan-ok=""[\s\S]*?>OK<\/span><\/button>/);
    expect(html).toMatch(/data-plan-not-ok=""[\s\S]*?>Not OK<\/span><\/button>/);
    expect(html).not.toContain('role="checkbox"');
    // Tokens only.
    expect(html).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}`, 'i'));
  });

  it('switch reopened from a pill: the current answer is pressed', () => {
    const ok = renderToStaticMarkup(
      <PlanSwitch side="team" title="One" current="approved" onOk={noop} onNotOk={noop} />,
    );
    expect(ok).toContain('data-plan-slot="team"');
    expect(ok).toContain('data-plan-slot-state="approved"');
    expect(ok).toContain('aria-pressed="true" data-plan-ok=""');
    expect(ok).toContain('aria-pressed="false" data-plan-not-ok=""');
    const no = renderToStaticMarkup(
      <PlanSwitch side="team" title="One" current="changes" onOk={noop} onNotOk={noop} />,
    );
    expect(no).toContain('data-plan-slot-state="changes"');
    expect(no).toContain('aria-pressed="true" data-plan-not-ok=""');
  });

  it('pill: a button with OK or Not OK, solid fills under white text, 44px target', () => {
    const ok = renderToStaticMarkup(
      <PlanDecidedPill side="client" title="One" status="approved" onChange={noop} />,
    );
    expect(ok).toMatch(/^<button type="button"/);
    expect(ok).toContain('aria-label="PLAN OK: One"');
    expect(ok).toContain(
      'data-plan-slot="client" data-plan-slot-state="approved" data-plan-control="pill"',
    );
    expect(ok).toContain('h-11');
    expect(ok).toContain('bg-[var(--good-solid)]');
    expect(ok).toContain('text-white');
    expect(ok).toMatch(/>OK<span aria-hidden="true"/);
    const no = renderToStaticMarkup(
      <PlanDecidedPill side="client" title="One" status="changes" onChange={noop} />,
    );
    expect(no).toContain('aria-label="PLAN Not OK: One"');
    expect(no).toContain('data-plan-slot-state="changes"');
    expect(no).toContain('bg-[var(--bad-solid)]');
    expect(no).toMatch(/>Not OK<span aria-hidden="true"/);
  });

  it('the solid fills are the light values in both themes', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    // Defined in both theme blocks, with the same (light) value in each.
    for (const token of ['--good-solid', '--bad-solid']) {
      const values = [...css.matchAll(new RegExp(`${token}: ([^;]+);`, 'g'))].map((m) => m[1]);
      expect(values).toHaveLength(2);
      expect(values[0]).toBe(values[1]);
    }
  });
});

describe('the plan Undo window (4s, the shared default)', () => {
  it('UNDO_MS is 4000; plan-card no longer has its own window', async () => {
    expect(UNDO_MS).toBe(4000);
    expect(Object.keys(await import('@/components/chat/plan-card'))).not.toContain('PLAN_UNDO_MS');
    expect(read('plan-card.ts')).not.toContain('PLAN_UNDO_MS');
  });

  it('both plan screens call useUndoableAction() with no options', () => {
    for (const name of ['PlanScreen.tsx', 'PlanItemScreen.tsx']) {
      const src = read(name);
      expect(src).toContain('useUndoableAction()');
      expect(src).not.toContain('useUndoableAction({');
      expect(src).not.toContain('PLAN_UNDO_MS');
      expect(src).not.toContain('SLOT_UNDO_MS');
    }
  });
});
