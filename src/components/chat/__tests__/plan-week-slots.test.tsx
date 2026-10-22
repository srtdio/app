import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import {
  DayColumn,
  PlanBody,
  planListGroups,
  rowMeta,
  screenProgressLabel,
} from '@/components/chat/PlanScreen';
import { runSlotWrite } from '@/lib/chat/plans';
import { MemoryRouter } from 'react-router-dom';
import {
  SLOT_FAILED,
  SLOT_POST_NOT_READY,
  SLOT_REMOVED_TOAST,
  commentsLabel,
  itemPills,
  itemSlotSubtitle,
  planProgress,
  progressPercent,
  slotApprovedToast,
  slotCheckboxShown,
  slotSide,
  slotTicked,
  slotView,
  slotToastSpec,
  slotUndoStatus,
  withReviewOverrides,
} from '@/components/chat/plan-card';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

function item(over: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: 'i',
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
      item({ id: 'p1', post_id: 'post1', target_date: '2026-10-13' }),
      item({ id: 'p2', post_id: 'post2' }),
      item({ id: 'd1', post_id: 'draft1' }),
      item({ id: 'c1', kind: 'concept', title: 'Reel' }),
    ],
    reviews: [
      { item_id: 'p1', side: 'client', status: 'approved' },
      { item_id: 'p2', side: 'team', status: 'approved' },
      { item_id: 'c1', side: 'client', status: 'changes' },
    ],
    postStages: { post1: 'review', post2: 'approved', draft1: 'draft' },
    postInfo: {
      post1: { title: 'One', target_date: '2026-10-13T06:00:00Z' },
      post2: { title: 'Two', target_date: null },
      draft1: { title: 'Draft', target_date: null },
    },
  };
}

const at = (b: PlanBundle, id: string): PlanItemRow => b.items.find((i) => i.id === id)!;

describe('checkbox per role (W4)', () => {
  it('writes: a client the client side on an Open plan; the agency the team side on a Draft only', () => {
    expect(slotSide('client', 'client')).toBe('client');
    expect(slotSide('client', 'team')).toBeNull();
    // No team writes on an Open plan: the agency's boxes are read-only.
    expect(slotSide('agency', 'client')).toBeNull();
    expect(slotSide('agency', 'team')).toBe('team');
    expect(slotSide('unknown', 'client')).toBeNull();
  });

  it('one view of ticks (item 5): Draft team side for the agency; Open client side for everyone', () => {
    expect(slotView('agency', 'team')).toEqual({ side: 'team', writable: true });
    expect(slotView('client', 'team')).toBeNull();
    expect(slotView('agency', 'client')).toEqual({ side: 'client', writable: false });
    expect(slotView('client', 'client')).toEqual({ side: 'client', writable: true });
    // Unknown side: no box until the side is known (no flash of the wrong side).
    expect(slotView('unknown', 'client')).toBeNull();
    expect(slotView('unknown', 'team')).toBeNull();
  });

  it('a draft locked to a client has no checkbox; the agency keeps a read-only one on it', () => {
    const b = bundle('client');
    expect(slotCheckboxShown(b, at(b, 'd1'), 'client')).toBeNull();
    expect(slotCheckboxShown(b, at(b, 'd1'), 'agency')).toEqual({
      side: 'client',
      writable: false,
    });
    expect(slotCheckboxShown(b, at(b, 'p1'), 'client')).toEqual({
      side: 'client',
      writable: true,
    });
    const d = bundle('team');
    expect(slotCheckboxShown(d, at(d, 'p1'), 'agency')).toEqual({ side: 'team', writable: true });
  });

  it('ticked reads the side the viewer writes: a client never sees team state', () => {
    const b = bundle('client');
    // p2 is team approved: the client's box stays empty, the agency's is ticked.
    expect(slotTicked(b, 'p2', 'client')).toBe(false);
    expect(slotTicked(b, 'p2', 'team')).toBe(true);
    // A post at stage approved with no client review is not a ticked slot.
    expect(slotTicked(b, 'p2', 'client')).toBe(false);
    // Concept 'changes' shows unticked.
    expect(slotTicked(b, 'c1', 'client')).toBe(false);
    expect(itemPills(b, at(b, 'p2'), 'client').map((p) => p.side)).toEqual(['client']);
  });
});

describe('optimistic counts and toasts (W4, W6)', () => {
  it('an override moves the pills, the counts and the bar together', () => {
    const b = bundle('client');
    expect(planProgress(b)).toMatchObject({ approved: 1, total: 4, changes: 1 });
    const ticked = withReviewOverrides(b, 'client', { p2: 'approved', c1: 'approved' });
    expect(planProgress(ticked)).toMatchObject({ approved: 3, changes: 0 });
    expect(progressPercent(planProgress(ticked))).toBe(75);
    expect(screenProgressLabel(ticked, 'client')).toBe('Approved 3 of 4');
    expect(screenProgressLabel(ticked, 'agency')).toBe('Approved 3 of 4');
    // Reverting is laying the previous status back.
    const reverted = withReviewOverrides(ticked, 'client', { p2: 'waiting', c1: 'changes' });
    expect(planProgress(reverted)).toMatchObject({ approved: 1, changes: 1 });
    // No override: the very same bundle.
    expect(withReviewOverrides(b, 'client', {})).toBe(b);
    // Team overrides never touch the client count.
    expect(planProgress(withReviewOverrides(b, 'team', { p1: 'approved' }))).toMatchObject({
      approved: 1,
      teamApproved: 2,
    });
  });

  it('tick: "Slot approved · Tue 14 Oct" with Undo; untick: removed, no Undo; undo: silent', () => {
    expect(slotApprovedToast('Tue 14 Oct')).toBe('Slot approved · Tue 14 Oct');
    expect(slotToastSpec('tick', { ok: true }, 'Tue 14 Oct')).toEqual({
      title: 'Slot approved · Tue 14 Oct',
      undo: true,
    });
    expect(slotToastSpec('tick', { ok: true }, null)).toEqual({
      title: 'Slot approved',
      undo: true,
    });
    expect(slotToastSpec('untick', { ok: true }, 'Tue 14 Oct')).toEqual({
      title: SLOT_REMOVED_TOAST,
      undo: false,
    });
    expect(slotToastSpec('undo', { ok: true }, 'Tue 14 Oct')).toBeNull();
  });

  it('failure copy: the draft refusal, else the generic one', () => {
    expect(slotToastSpec('tick', { ok: false, message: 'post_not_ready' }, null)).toEqual({
      title: SLOT_POST_NOT_READY,
      undo: false,
    });
    expect(SLOT_POST_NOT_READY).toBe("This post isn't ready yet.");
    expect(slotToastSpec('undo', { ok: false, message: 'forbidden_role' }, null)?.title).toBe(
      SLOT_FAILED,
    );
    expect(SLOT_FAILED).toBe("Couldn't update this slot. Try again.");
  });

  it('the screen: OK waits behind the Undo toast (X3); there is no untick, Not OK opens the item', () => {
    const src = read('PlanScreen.tsx');
    expect(src).not.toContain('await runSlotWrite({');
    expect(src).not.toContain('untickSlot');
    expect(src).toMatch(
      /const planOk = [\s\S]*?if \(previous === 'approved'\) return;[\s\S]*?tickSlot\(item, slot, previous, dayHeader\);/,
    );
    expect(src).toContain('p_trace_id: traceId');
    expect(src).toContain('dispatchPlanChanged(window, planId);');
    // Undo means the write never goes (useUndoableAction), so no write-back.
    expect(src).toContain('undoable.run({');
    expect(src).not.toContain('slotUndoStatus(');
    // A slot write never touches posts.stage (no stage transition on this screen).
    expect(src).not.toContain('stageTransition');
    expect(src).not.toContain('data-plan-tab');
  });
});

describe('post item header (W7, W8)', () => {
  it('subtitle matrix: client reads client; agency client on a client plan, team on a team plan', () => {
    const c = bundle('client');
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'client')).toBe('Slot approved');
    expect(itemSlotSubtitle(c, at(c, 'p2'), 'client')).toBe('Slot pending');
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'agency')).toBe('Slot approved');
    expect(itemSlotSubtitle(c, at(c, 'p2'), 'agency')).toBe('Slot pending');
    const t = bundle('team');
    expect(itemSlotSubtitle(t, at(t, 'p2'), 'agency')).toBe('Slot approved');
    expect(itemSlotSubtitle(t, at(t, 'p1'), 'agency')).toBe('Slot pending');
    expect(itemSlotSubtitle(c, at(c, 'c1'), 'client')).toBeNull();
    expect(itemSlotSubtitle(c, at(c, 'p1'), 'unknown')).toBeNull();
  });

  it('PlanPage renders the action after a flex-1 min-w-0 title column with truncation', () => {
    const src = read('PlanScreen.tsx');
    const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
    expect(header).toMatch(/className="flex min-w-0 flex-1 flex-col[^"]*"/);
    expect(header).toContain('<h2 className="truncate');
    expect(header.indexOf('{props.action}')).toBeGreaterThan(header.indexOf('</h2>'));
    // 16px on both sides for every header (no pl-1 with a back button).
    expect(header).toContain('border-b border-border bg-panel pl-4 pr-4');
    expect(header).not.toContain("showBack ? 'pl-1'");
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain('action: (');
    expect(item).toContain('data-plan-more=""');
    expect(item).not.toContain('absolute right-3');
  });
});

describe('Undo restores the exact previous status (A3)', () => {
  it('from changes -> changes; from waiting or no row -> waiting', () => {
    expect(slotUndoStatus('changes')).toBe('changes');
    expect(slotUndoStatus('waiting')).toBe('waiting');
  });

  for (const previous of ['changes', 'waiting'] as const) {
    it(`Undo after a tick from ${previous}: writes ${previous}, reverts to approved on failure`, async () => {
      const writes: string[] = [];
      const applied: string[] = [];
      const ok = await runSlotWrite({
        status: slotUndoStatus(previous),
        previous: 'approved',
        apply: (s) => applied.push(s),
        write: (s) => {
          writes.push(s);
          return Promise.resolve({ ok: true, data: null });
        },
      });
      expect(ok.ok).toBe(true);
      expect(writes).toEqual([previous]);
      expect(applied).toEqual([previous]);
      applied.length = 0;
      const failed = await runSlotWrite({
        status: slotUndoStatus(previous),
        previous: 'approved',
        apply: (s) => applied.push(s),
        write: () => Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } }),
      });
      expect(failed.ok).toBe(false);
      expect(applied).toEqual([previous, 'approved']);
    });
  }
});

describe('week list layout (L1-L4)', () => {
  it('date tile: 56x56, weekday strip over the number; today accent strip and border; No date', () => {
    const today = renderToStaticMarkup(<DayColumn day="2026-10-14" today="2026-10-14" />);
    expect(today).toContain(
      'flex h-14 w-14 shrink-0 flex-col overflow-hidden rounded-[10px] border',
    );
    expect(today).toContain('data-plan-today=""');
    expect(today).toContain('border-accent');
    expect(today).toMatch(/data-plan-day-weekday=""[^>]*bg-accent text-accent-fg">Wed</);
    expect(today).toMatch(/data-plan-day-number=""[^>]*font-mono[^>]*tabular-nums text-fg">14</);
    // The weekday is no longer accent text on the panel.
    expect(today).not.toMatch(/ text-accent">/);
    const other = renderToStaticMarkup(<DayColumn day="2026-10-15" today="2026-10-14" />);
    expect(other).not.toContain('data-plan-today');
    expect(other).toContain('border-border-strong');
    expect(other).toMatch(/data-plan-day-weekday=""[^>]*bg-panel-2 text-fg-2">Thu</);
    expect(other).toMatch(/tabular-nums text-fg">15</);
    // `empty` is optional and no longer changes the tile.
    expect(renderToStaticMarkup(<DayColumn day="2026-10-15" today="2026-10-14" empty />)).toBe(
      other,
    );
    const none = renderToStaticMarkup(<DayColumn day={null} today="2026-10-14" />);
    expect(none).toMatch(/data-plan-day-weekday=""[^>]*bg-panel-2[^>]*><\/span>/);
    expect(none).toMatch(/data-plan-day-number=""[^>]*>No date<\/span>/);
    expect(none).not.toContain('data-plan-today');
  });

  it('No date tile: blank strip, "No date" in the body in Inter, never today (regression)', () => {
    const none = renderToStaticMarkup(<DayColumn day={null} today="2026-10-14" />);
    const weekday = none.match(/<span data-plan-day-weekday="" class="([^"]*)">([^<]*)<\/span>/);
    expect(weekday?.[2]).toBe('');
    expect(weekday?.[1]).toContain('bg-panel-2');
    expect(weekday?.[1]).not.toContain('bg-accent');
    const number = none.match(/<span data-plan-day-number="" class="([^"]*)">([^<]*)<\/span>/);
    expect(number?.[2]).toBe('No date');
    const numberClasses = number?.[1].split(' ') ?? [];
    expect(numberClasses).not.toContain('font-mono');
    expect(numberClasses).not.toContain('tabular-nums');
    expect(numberClasses).not.toContain('uppercase');
    expect(numberClasses).toEqual(
      expect.arrayContaining([
        'whitespace-nowrap',
        'text-[11px]',
        'leading-[14px]',
        'font-semibold',
        'text-fg-2',
      ]),
    );
    expect(none).not.toContain('data-plan-today');
    expect(none).not.toContain('border-accent');
    expect(none).toContain('border-border-strong');
  });

  it('dated tile: weekday in the strip, day number in mono', () => {
    const html = renderToStaticMarkup(<DayColumn day="2026-10-15" today="2026-10-14" />);
    const weekday = html.match(/<span data-plan-day-weekday="" class="([^"]*)">([^<]*)<\/span>/);
    expect(weekday?.[2]).toBe('Thu');
    expect(weekday?.[1]).toContain('uppercase');
    const number = html.match(/<span data-plan-day-number="" class="([^"]*)">([^<]*)<\/span>/);
    expect(number?.[2]).toBe('15');
    expect(number?.[1].split(' ')).toEqual(
      expect.arrayContaining(['font-mono', 'text-[20px]', 'tabular-nums', 'text-fg']),
    );
  });

  it('format line: the format label alone for a post (no stage), the description for a concept', () => {
    const b = bundle('client');
    b.postInfo.post1 = { title: 'One', target_date: null, format: 'carousel' };
    expect(rowMeta(b, at(b, 'p1'))).toBe('Carousel');
    // No format: nothing (the stage lives on the POST line).
    expect(rowMeta(b, at(b, 'p2'))).toBe('');
    expect(rowMeta(b, item({ id: 'x', post_id: null }))).toBe('');
    expect(rowMeta({ ...b }, { ...at(b, 'c1'), description: 'Morning light' })).toBe(
      'Morning light',
    );
  });

  function paint(side: 'client' | 'agency', audience: 'client' | 'team'): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={bundle(audience)}
          groups={planListGroups(bundle(audience), 'UTC', side)}
          side={side}
          timeZone="UTC"
          thumbs={{ post1: 'v1' }}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
          onPlanNotOk={() => undefined}
          {...(side === 'agency' ? { onAdd: () => undefined, onDragStart: () => undefined } : {})}
        />
      </MemoryRouter>,
    );
  }

  it('a row carries no kind tag, status, comments or Approved by line, and no checkbox', () => {
    for (const side of ['client', 'agency'] as const) {
      const html = paint(side, 'client');
      for (const gone of [
        'data-plan-row-kind',
        'data-plan-row-status',
        'data-plan-row-comments',
        'data-plan-row-approved-by',
        'role="checkbox"',
        'aria-checked',
      ]) {
        expect(html).not.toContain(gone);
      }
    }
    expect(commentsLabel(0)).toBeNull();
    expect(commentsLabel(2)).toBe('2 comments');
  });

  it('each row: date tile, title block, thumbnail on the right, then PLAN and POST; day blocks bordered', () => {
    const html = paint('client', 'client');
    const row = html.slice(
      html.indexOf('data-plan-row-wrap="p1"'),
      html.indexOf('data-plan-day="2026-10-14"'),
    );
    const order = [
      'data-plan-day-col',
      'data-plan-row="p1"',
      'data-plan-row-title',
      'data-plan-row-tile="image"',
      'data-plan-line="plan"',
      'data-plan-line="post"',
    ].map((k) => row.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The thumbnail: 56x56, radius 10, inside the row button after the title.
    expect(row).toContain('h-14 w-14 shrink-0 overflow-hidden rounded-[10px]');
    // The title wraps to two lines.
    expect(row).toMatch(/data-plan-row-title=""[^>]*line-clamp-2/);
    // PLAN: the client's approved slot is the OK pill; POST: the stage.
    expect(row).toMatch(/data-plan-line="plan"[\s\S]*?>PLAN<[\s\S]*?data-plan-control="pill"/);
    expect(row).toMatch(/data-plan-post-status="review"[\s\S]*?>Review</);
    expect(html).toMatch(
      /data-plan-day-empty="" class="flex min-h-\[44px\] items-center text-\[13px\] text-fg-3">Nothing planned/,
    );
    // Day block: 16px all round, a 1px line between days, rows 16px apart.
    expect(html).toContain('flex flex-col gap-4 border-t border-border px-4 py-4');
    expect(html).toContain('flex min-w-0 flex-1 flex-col gap-0.5');
    // A client sees no Add, no drag.
    expect(html).not.toContain('data-plan-add=');
    // One date tile per day: the No date day has three rows and one tile.
    const none = html.slice(html.indexOf('data-plan-day="none"'));
    expect(none.match(/data-plan-day-col=""/g)).toHaveLength(1);
    expect(none.match(/data-plan-row-wrap=/g)).toHaveLength(3);
    // Rows under the first keep the 56px column with a spacer.
    expect(none).toContain('<span aria-hidden="true" class="w-14 shrink-0"></span>');
    // Tiles: the first image, the text tile, the dashed concept outline.
    expect(html).toContain('data-plan-row-tile="image"');
    expect(html).toContain('data-plan-row-tile="text"');
    expect(html).toContain('data-plan-row-tile="concept"');
    // A client: no team state; the locked draft has no PLAN line and no switch.
    expect(html).not.toContain('data-plan-slot="team"');
    expect(html).toContain('data-plan-row-draft="locked"');
    const draft = html.slice(html.indexOf('data-plan-row-wrap="d1"'));
    const draftRow = draft.slice(0, draft.indexOf('data-plan-row-wrap=', 1));
    expect(draftRow).not.toContain('data-plan-line');
    expect(draftRow).not.toContain('data-plan-control');
  });

  it('agency on an Open plan: the client PLAN as read-only text, Add rows, No date kept', () => {
    const html = paint('agency', 'client');
    // Team reviews are never shown on an Open plan: the client side, read-only text.
    expect(html).not.toContain('data-plan-slot="team"');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).toContain('data-plan-slot-readonly=""');
    expect(html).not.toContain('data-plan-control="switch"');
    expect(html).not.toContain('data-plan-control="pill"');
    expect(html).not.toContain('data-plan-ok=');
    expect(html).toMatch(/data-plan-slot-state="approved"[^>]*data-plan-control="text"[^>]*>OK</);
    expect(html).toMatch(
      /data-plan-slot-state="changes"[^>]*data-plan-control="text"[^>]*>Not OK</,
    );
    expect(html).toMatch(
      /data-plan-slot-state="pending"[^>]*data-plan-control="text"[^>]*>Not checked yet</,
    );
    // Header: PLAN over every item, POST over the post items.
    expect(html).toContain('1/4 OK');
    expect(html).toContain('1/3 approved');
    expect(html).not.toContain('data-plan-row-status');
    expect(html).not.toContain('Approvers · Approved');
    expect(html).not.toContain('data-plan-pill="draft"');
    expect(html).toContain('data-plan-row-wrap="d1"');
    expect(html).toContain('data-plan-add="2026-10-12"');
    expect(html).toContain('data-plan-add="none"');
    expect(html).toContain('data-plan-day="none"');
  });

  it('agency on a Draft plan: the writable team switch and pill, "1/4 OK"', () => {
    const html = paint('agency', 'team');
    expect(html).toContain('data-plan-slot="team"');
    expect(html).not.toContain('data-plan-slot="client"');
    expect(html).not.toContain('data-plan-slot-readonly');
    expect(html).toMatch(
      /data-plan-slot="team" data-plan-slot-state="approved" data-plan-control="pill"/,
    );
    expect(html).toMatch(
      /data-plan-slot="team" data-plan-slot-state="pending" data-plan-control="switch"/,
    );
    expect(html).toContain('1/4 OK');
    expect(html).toContain('data-plan-screen-progress="plan"');
    expect(html).toContain('data-plan-screen-progress="post"');
    expect(html).toContain('data-plan-progress-bar="good"');
    expect(html).toContain('data-plan-progress-bar="accent"');
  });

  it('a client on an Open plan answers the client side (writable)', () => {
    const html = paint('client', 'client');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).not.toContain('data-plan-slot-readonly');
    // p2 is undecided: the OK | Not OK switch.
    expect(html).toMatch(
      /data-plan-control="switch"[\s\S]*?data-plan-ok=""[\s\S]*?data-plan-not-ok=""/,
    );
    // c1 asked changes: the Not OK pill.
    expect(html).toMatch(/data-plan-slot-state="changes" data-plan-control="pill"/);
    // The locked draft is not one the client checks: 1 of 3.
    expect(html).toContain('1/3 OK');
    expect(html).toContain('1/3 approved');
  });
});
