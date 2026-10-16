import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DRAFT_LABEL,
  DRAFT_NOT_READY,
  HAS_CLIENT_TAG,
  IN_THIS_CHAT_LABEL,
  OPEN_FOR_CLIENT_FIRST,
  TEAM_APPROVE_CONFIRM,
  TEAM_ONLY_LABEL,
  draftLocked,
  forwardBlocked,
  isDraftPost,
  itemPills,
  pickerChips,
  planProgress,
  summaryHasClient,
} from '@/components/chat/plan-card';
import { pickerRows } from '@/components/chat/PlanPickerSheet';
import { AGENCY_ROW, CONCEPT_EDIT_RESET_HINT } from '@/components/chat/PlanItemScreen';
import { rowTitle } from '@/components/chat/PlanScreen';
import {
  TEAM_PLAN_CLIENT_CHAT,
  assembleBundles,
  mergeDraftRows,
  readUpcomingPlans,
  refusedForClient,
  shareFailureCopy,
  type PlanBundle,
  type PlanDraftRow,
  type PlanItemRow,
  type PlanRow,
} from '@/lib/chat/plans';
import { SEGMENT_PILL, openPlans } from '@/lib/chat/status-bar';

function plan(id: string, over: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    workspace_id: 'ws',
    title: id,
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: null,
    ...over,
  };
}

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'a',
    kind: 'concept',
    position: 0,
    title: 'C',
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    ...over,
  };
}

function bundleOf(items: PlanItemRow[], stages: Record<string, string> = {}): PlanBundle {
  return assembleBundles(
    [plan('a')],
    items,
    [],
    Object.entries(stages).map(([id, stage]) => ({
      id,
      stage,
      title: `T ${id}`,
      target_date: null,
    })),
  ).get('a') as PlanBundle;
}

const DRAFT: PlanDraftRow = {
  plan_id: 'a',
  item_id: 'd1',
  item_position: 2,
  post_number: 288,
  title: 'Soil health',
  target_date: '2026-10-14',
};

describe('forward rule (item 4)', () => {
  it('a Draft plan into a chat known to have a client is refused before any write', () => {
    expect(forwardBlocked('team', true)).toBe(true);
    expect(forwardBlocked('team', false)).toBe(false);
    // Former members: sent, and the server's refusal says the same.
    expect(forwardBlocked('team', null)).toBe(false);
    expect(forwardBlocked('client', true)).toBe(false);
    expect(OPEN_FOR_CLIENT_FIRST).toBe('Open the plan for approvers first.');
  });

  it('the refusal is plan_not_shared_with_client and reads "Open the plan for approvers first."', () => {
    expect(refusedForClient('P0001: plan_not_shared_with_client')).toBe(true);
    expect(refusedForClient('plan not available')).toBe(false);
    expect(shareFailureCopy('plan_not_shared_with_client')).toBe(TEAM_PLAN_CLIENT_CHAT);
    expect(TEAM_PLAN_CLIENT_CHAT).toBe(OPEN_FOR_CLIENT_FIRST);
  });

  it('Forward never opens a share-first confirm: PlanShareConfirm is gone', () => {
    expect(existsSync(fileURLToPath(new URL('./PlanShareConfirm.tsx', import.meta.url)))).toBe(
      false,
    );
    const card = readFileSync(fileURLToPath(new URL('./PlanCard.tsx', import.meta.url)), 'utf8');
    expect(card).not.toMatch(/ShareFirstFlow|PlanShareConfirm|planShareWithClient/);
    expect(card).toContain('toast.show({ title: OPEN_FOR_CLIENT_FIRST })');
  });

  it('a chat has a client when known from loaded data: a DM with a client', () => {
    expect(summaryHasClient({ channelType: 'dm', role: 'client' })).toBe(true);
    expect(summaryHasClient({ channelType: 'dm', role: 'agency' })).toBe(false);
    expect(summaryHasClient({ channelType: 'dm', role: null })).toBeNull();
    expect(summaryHasClient({ channelType: 'dm' })).toBeNull();
    expect(summaryHasClient({ channelType: 'group', role: null })).toBeNull();
    expect(HAS_CLIENT_TAG).toBe('Has approvers');
  });
});

describe('draft rows', () => {
  it('merges rows not already present as post items at stage draft, no duplicates', () => {
    const items = [item({ id: 'c1' }), item({ id: 'p1', kind: 'post', post_id: 'post1' })];
    const merged = mergeDraftRows(items, [DRAFT, { ...DRAFT, item_id: 'p1' }, { ...DRAFT }]);
    expect(merged.map((i) => i.id)).toEqual(['c1', 'p1', 'd1']);
    expect(merged[2]).toMatchObject({
      kind: 'post',
      post_id: null,
      title: 'Soil health',
      target_date: '2026-10-14',
      position: 2,
      draft_row: true,
      post_number: 288,
    });
  });

  it('draft rows count in N everywhere and sort by their own date', () => {
    const b = bundleOf(
      mergeDraftRows(
        [
          item({ id: 'c1', target_date: '2026-10-13' }),
          item({ id: 'c2', target_date: '2026-10-15' }),
        ],
        [DRAFT],
      ),
    );
    expect(b.items.map((i) => i.id)).toEqual(['c1', 'd1', 'c2']);
    expect(planProgress(b).total).toBe(3);
    expect(b.items.filter((i) => isDraftPost(b, i))).toHaveLength(1);
    expect(rowTitle(b, b.items[1] as PlanItemRow)).toBe('Soil health');
  });

  it("a client's draft row is inert; the agency's draft post opens and gets a grey pill", () => {
    const b = bundleOf(
      mergeDraftRows([item({ id: 'p1', kind: 'post', post_id: 'post1' })], [DRAFT]),
      { post1: 'draft' },
    );
    const own = b.items.find((i) => i.id === 'p1') as PlanItemRow;
    const row = b.items.find((i) => i.id === 'd1') as PlanItemRow;
    expect(isDraftPost(b, own)).toBe(true);
    expect(isDraftPost(b, row)).toBe(true);
    expect(draftLocked(b, row, 'client')).toBe(true);
    expect(draftLocked(b, row, 'unknown')).toBe(true);
    expect(draftLocked(b, own, 'agency')).toBe(false);
    expect(isDraftPost(bundleOf([own], { post1: 'review' }), own)).toBe(false);
    expect(isDraftPost(b, item({ id: 'c' }))).toBe(false);
    expect(DRAFT_LABEL).toBe('Draft');
    expect(DRAFT_NOT_READY).toBe('Not ready to view yet');
    const src = readFileSync(fileURLToPath(new URL('./PlanScreen.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('aria-disabled="true"');
    expect(src).toContain('data-plan-row-draft="locked"');
  });
});

describe('readPlanBundles with draft rows', () => {
  it('one plan_draft_rows call per 100 plan ids after the items read', async () => {
    const rpc = vi.fn(async (_name: string, args: { p_plan_ids: string[] }) => ({
      data: args.p_plan_ids.includes('p0') ? [{ ...DRAFT, plan_id: 'p0' }] : [],
      error: null,
    }));
    const tables: Record<string, (ids: string[]) => unknown[]> = {
      plans: (ids) => ids.map((id) => plan(id, { ends_on: '2026-10-20' })),
    };
    const from = vi.fn((table: string) => {
      let ids: string[] = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = (_c: string, values: string[]) => {
        ids = values;
        return q;
      };
      for (const m of ['is', 'eq', 'gte', 'order', 'limit', 'abortSignal']) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === 'plans' && ids.length === 0
              ? Array.from({ length: 150 }, (_, i) => plan(`p${i}`, { ends_on: '2026-10-20' }))
              : (tables[table]?.(ids) ?? []),
          error: null,
        }).then(resolve);
      return q;
    });
    const client = { from, rpc } as unknown as Parameters<typeof readUpcomingPlans>[0];
    const result = await readUpcomingPlans(client, 'ws', '2026-10-11');
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['plan_draft_rows', 'plan_draft_rows']);
    expect(rpc.mock.calls.map((c) => c[1].p_plan_ids.length)).toEqual([100, 50]);
    if (!result.ok) return;
    expect(result.data.find((b) => b.plan.id === 'p0')?.items.map((i) => i.id)).toEqual(['d1']);
  });

  it('never calls the retired plan_draft_items', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../lib/chat/plans.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('plan_draft_items');
    expect(src).not.toContain('planDraftItems');
  });
});

describe('Plans sheet (item 2)', () => {
  it('drops plans ended before today in the workspace zone; ending soonest first', () => {
    const bundles = assembleBundles(
      [
        plan('later', { ends_on: '2026-10-30' }),
        plan('ended', { ends_on: '2026-10-10' }),
        plan('today', { ends_on: '2026-10-11' }),
        plan('soon', { ends_on: '2026-10-14', starts_on: '2026-10-01' }),
      ],
      [],
      [],
      [],
    );
    expect(openPlans(bundles.values(), '2026-10-11').map((b) => b.plan.id)).toEqual([
      'today',
      'soon',
      'later',
    ]);
  });

  it('chips: counts, "Draft" (warn) on a Draft plan, "In this chat" (accent) when here', () => {
    const team = assembleBundles([plan('t', { audience: 'team' })], [], [], []).get(
      't',
    ) as PlanBundle;
    const client = assembleBundles([plan('c')], [], [], []).get('c') as PlanBundle;
    const rows = pickerRows([team, client], new Set(['c']));
    expect(rows.map((r) => r.chips)).toEqual([
      [
        { label: '0 concepts', tone: 'neutral' },
        { label: '0 posts', tone: 'neutral' },
        { label: 'Draft', tone: 'warn' },
      ],
      [
        { label: '0 concepts', tone: 'neutral' },
        { label: '0 posts', tone: 'neutral' },
        { label: 'In this chat', tone: 'accent' },
      ],
    ]);
    expect(pickerChips(client, false).map((c) => c.label)).not.toContain(IN_THIS_CHAT_LABEL);
  });

  it('titled "Plans"; a row opens the plan, never sends', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PlanPickerSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("export const PICKER_TITLE = 'Plans';");
    expect(src).toContain('props.onOpenPlan(bundle.plan.id)');
    expect(src).not.toMatch(/chatPlanShare|sharePlanToChannel|ShareFirstFlow|onSent/);
    expect(src).toContain('pickerChips(bundle, inChat.has(bundle.plan.id))');
  });

  it('the upcoming read: workspace, not deleted, ends today or later, ends_on asc, 100', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'gte', 'order', 'limit', 'in', 'abortSignal']) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    const client = { from: () => q, rpc: vi.fn() } as unknown as Parameters<
      typeof readUpcomingPlans
    >[0];
    await readUpcomingPlans(client, 'ws1', '2026-10-11');
    expect(calls.filter(([m]) => m !== 'select')).toEqual([
      ['eq', ['workspace_id', 'ws1']],
      ['is', ['deleted_at', null]],
      ['gte', ['ends_on', '2026-10-11']],
      ['order', ['ends_on', { ascending: true }]],
      ['limit', [100]],
    ]);
  });
});

describe('Team is Agency in every plan string', () => {
  it('chips, hints, pills, rows and buttons', () => {
    expect(TEAM_ONLY_LABEL).toBe('Creators only');
    expect(TEAM_APPROVE_CONFIRM).toBe(
      'Mark as checked? Only creators see this. Approvers still approve separately.',
    );
    expect(SEGMENT_PILL.team).toBe('Checked by creators');
    expect(AGENCY_ROW).toBe('Creators');
    expect(CONCEPT_EDIT_RESET_HINT).toBe(
      'Saving sends this back to waiting for creators and approvers.',
    );
    const draft = assembleBundles(
      [plan('a', { audience: 'team' })],
      [item({ id: 'c1' })],
      [],
      [],
    ).get('a') as PlanBundle;
    expect(itemPills(draft, draft.items[0] as PlanItemRow, 'agency')[0]?.label).toBe(
      'Creators · Waiting',
    );
    const itemScreen = readFileSync(
      fileURLToPath(new URL('./PlanItemScreen.tsx', import.meta.url)),
      'utf8',
    );
    expect(itemScreen).toContain("'Mark checked'");
    expect(itemScreen).not.toContain("'Team approve'");
    const screen = readFileSync(
      fileURLToPath(new URL('./PlanScreen.tsx', import.meta.url)),
      'utf8',
    );
    // The old banner and its Share with client button are gone.
    expect(screen).not.toContain('Creators only. The client can&apos;t see it yet.');
    expect(screen).not.toContain('data-plan-share-client');
    expect(screen).not.toContain('plan_has_drafts');
  });
});
