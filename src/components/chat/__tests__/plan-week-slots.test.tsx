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
  SlotCheckbox,
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

  it('the checkbox is a 22px box in a 44x44 target, with tokens only', () => {
    const html = renderToStaticMarkup(
      <SlotCheckbox side="client" checked title="One" onToggle={() => undefined} />,
    );
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('h-[22px] w-[22px]');
    expect(html).toContain('rounded-[6px]');
    // Top-aligned with the thumbnail; the day block's 5px right padding puts the box 16px in.
    expect(html).toContain('self-start');
    expect(html).toContain('data-plan-slot="client"');
    // Client ticked: success fill, white tick.
    expect(html).toContain('bg-good');
    expect(html).toContain('text-accent-fg');
    const team = renderToStaticMarkup(
      <SlotCheckbox side="team" checked title="One" onToggle={() => undefined} />,
    );
    expect(team).toContain('bg-accent');
    expect(team).not.toContain('bg-good');
    expect(html).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}`, 'i'));
    const off = renderToStaticMarkup(
      <SlotCheckbox side="team" checked={false} title="One" onToggle={() => undefined} />,
    );
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('data-plan-slot-state="pending"');
    expect(off).toContain('border-[1.5px] border-border-strong');
  });
});

describe('optimistic counts and toasts (W4, W6)', () => {
  it('an override moves the pills, the counts and the bar together', () => {
    const b = bundle('client');
    expect(planProgress(b)).toMatchObject({ approved: 1, total: 4, changes: 1 });
    const ticked = withReviewOverrides(b, 'client', { p2: 'approved', c1: 'approved' });
    expect(planProgress(ticked)).toMatchObject({ approved: 3, changes: 0 });
    expect(progressPercent(planProgress(ticked))).toBe(75);
    expect(screenProgressLabel(ticked, 'client')).toBe('Client 3 of 4');
    expect(screenProgressLabel(ticked, 'agency')).toBe('Client 3 of 4');
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

  it('the screen wires the write through runSlotWrite, dispatches on success, Undo restores', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('await runSlotWrite({');
    expect(src).toContain('p_trace_id: traceId');
    expect(src).toContain('dispatchPlanChanged(window, planId);');
    expect(src).toMatch(
      /void writeSlot\(\s*item,\s*reviewSide,\s*slotUndoStatus\(previous\),\s*'approved',\s*'undo',/,
    );
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
  it('day column: 48x44, weekday over the digits centred; today both accent; empty faint; No date', () => {
    const today = renderToStaticMarkup(
      <DayColumn day="2026-10-14" today="2026-10-14" empty={false} />,
    );
    expect(today).toContain('flex h-11 w-12 shrink-0 flex-col items-center justify-center gap-0.5');
    expect(today).toContain('data-plan-today=""');
    expect(today).toMatch(
      /text-\[11px\] font-semibold uppercase leading-\[14px\] tracking-\[\.06em\] text-accent">Wed</,
    );
    expect(today).toMatch(
      /text-\[22px\] font-semibold leading-7 tracking-\[-\.01em\] tabular-nums text-accent">14</,
    );
    const empty = renderToStaticMarkup(<DayColumn day="2026-10-15" today="2026-10-14" empty />);
    expect(empty).toMatch(/text-fg-3">Thu</);
    expect(empty).toMatch(/tabular-nums text-border-strong">15</);
    const busy = renderToStaticMarkup(
      <DayColumn day="2026-10-15" today="2026-10-14" empty={false} />,
    );
    expect(busy).toMatch(/tabular-nums text-fg">15</);
    const none = renderToStaticMarkup(<DayColumn day={null} today="2026-10-14" empty={false} />);
    expect(none).toContain('No date');
    expect(none).not.toContain('data-plan-day-number');
  });

  it('meta line: format and stage for a post, the description for a concept', () => {
    const b = bundle('client');
    b.postInfo.post1 = { title: 'One', target_date: null, format: 'carousel' };
    expect(rowMeta(b, at(b, 'p1'))).toMatch(/ · In review$/);
    expect(rowMeta(b, at(b, 'p2'))).toBe('Approved');
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
          onToggleSlot={() => undefined}
          {...(side === 'agency' ? { onAdd: () => undefined, onDragStart: () => undefined } : {})}
        />
      </MemoryRouter>,
    );
  }

  function paintCounts(side: 'client' | 'agency', counts: Record<string, number>): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={bundle('client')}
          groups={planListGroups(bundle('client'), 'UTC', side)}
          side={side}
          timeZone="UTC"
          thumbs={{}}
          counts={counts}
          drag={null}
          onOpenItem={() => undefined}
          onToggleSlot={() => undefined}
        />
      </MemoryRouter>,
    );
  }

  it('B3 comments: agency at the end of the status line, muted; client as the third line', () => {
    const rowOf = (html: string): string =>
      /<div data-plan-row-wrap="p1"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    const agency = rowOf(paintCounts('agency', { p1: 3 }));
    expect(agency).toMatch(
      /data-plan-row-status=""[^>]*class="flex min-w-0 items-center text-xs leading-4">[\s\S]*?<span data-plan-row-comments="" class="truncate text-fg-3"> · 3 comments<\/span><\/span>/,
    );
    const client = rowOf(paintCounts('client', { p1: 1 }));
    expect(client).not.toContain('data-plan-row-status');
    expect(client).toContain(
      '<span data-plan-row-comments="" class="truncate text-xs leading-4 text-fg-3">1 comment</span>',
    );
    // None when zero, on either side.
    expect(rowOf(paintCounts('agency', { p1: 0 }))).not.toContain('data-plan-row-comments');
    expect(rowOf(paintCounts('client', {}))).not.toContain('data-plan-row-comments');
    expect(commentsLabel(0)).toBeNull();
    expect(commentsLabel(2)).toBe('2 comments');
  });

  it('each row: the open area first, the checkbox last; Nothing planned 36px; day blocks bordered', () => {
    const html = paint('client', 'client');
    const wrap = /<div data-plan-row-wrap="p1"[^>]*>([\s\S]*?)<\/button><\/div>/.exec(html);
    expect(wrap).not.toBeNull();
    const row = wrap![0];
    expect(row.indexOf('data-plan-row="p1"')).toBeLessThan(row.indexOf('data-plan-slot='));
    // The checkbox is the row's last element.
    expect(row.trimEnd().endsWith('</span></button></div>')).toBe(true);
    expect(html).toMatch(
      /data-plan-day-empty="" class="flex min-h-\[44px\] items-center text-\[13px\] text-fg-3">Nothing planned/,
    );
    // Day block: 16px top/bottom/left, 5px right, a 1px line between days.
    expect(html).toContain('flex gap-3 border-t border-border py-4 pl-4 pr-[5px]');
    // Items 16px apart; title, type line and status 2px apart.
    expect(html).toContain('flex min-w-0 flex-1 flex-col gap-4');
    expect(html).toContain('flex min-w-0 flex-1 flex-col gap-0.5');
    // A client sees no Add, no status line, no drag.
    expect(html).not.toContain('data-plan-add=');
    expect(html).not.toContain('data-plan-row-status');
    // Day column left of items.
    const day = html.slice(html.indexOf('data-plan-day="2026-10-13"'));
    expect(day.indexOf('data-plan-day-col')).toBeLessThan(day.indexOf('data-plan-row'));
    // Tiles: the first image, the text tile, the dashed concept outline.
    expect(html).toContain('data-plan-row-tile="image"');
    expect(html).toContain('data-plan-row-tile="text"');
    expect(html).toContain('data-plan-row-tile="concept"');
    expect(html).toMatch(/data-plan-row-kind="Post 1 of 3"[^>]*>Post</);
    // A client: no team state; the locked draft has no checkbox.
    expect(html).not.toContain('data-plan-slot="team"');
    expect(html).not.toContain('data-plan-row-wrap="d1"');
    expect(html).toContain('data-plan-row-draft="locked"');
  });

  it('agency on an Open plan: read-only client checkboxes, the client status line, Add rows, No date kept', () => {
    const html = paint('agency', 'client');
    // Team reviews are never shown on an Open plan: the client side, read-only.
    expect(html).not.toContain('data-plan-slot="team"');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).toContain('data-plan-slot-readonly=""');
    expect(html).toMatch(/data-plan-slot="client"[^>]*disabled=""/);
    expect(html).toContain('Client 1 of 4');
    expect(html).toMatch(/data-plan-row-status=""[^>]*>.*Client approved</);
    expect(html).not.toContain('Client · Approved');
    expect(html).not.toContain('data-plan-pill="draft"');
    expect(html).toContain('data-plan-row-wrap="d1"');
    expect(html).toContain('data-plan-add="2026-10-12"');
    expect(html).toContain('data-plan-add="none"');
    expect(html).toContain('data-plan-day="none"');
  });

  it('agency on a Draft plan: writable team checkboxes and "Team X of N"', () => {
    const html = paint('agency', 'team');
    expect(html).toContain('data-plan-slot="team"');
    expect(html).not.toContain('data-plan-slot="client"');
    expect(html).not.toContain('data-plan-slot-readonly');
    expect(html).toContain('Team 1 of 4');
    expect(html).toContain('data-plan-progress-bar="accent"');
  });

  it('a client on an Open plan ticks the client side (writable)', () => {
    const html = paint('client', 'client');
    expect(html).toContain('data-plan-slot="client"');
    expect(html).not.toContain('data-plan-slot-readonly');
    expect(html).toContain('Client 1 of 4');
  });
});
