// Draft / Open wave, screens: the pure rules and the rendered pieces behind
// items 1 to 14 (create, Plans sheet, header menu, footer, one view of ticks,
// Approved by, keep-approval moves, day source, Also in, Remove from plan,
// deleted cards, the chat bell, the Pipeline cleanup, the 2b migration).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  MEMBER_NAME,
  PlanBody,
  PlanFooter,
  PlanHeaderMenu,
  RenameField,
  planListGroups,
} from '@/components/chat/PlanScreen';
import { RemoveFromPlanButton } from '@/components/chat/PlanMoveSheet';
import {
  DELETE_FORBIDDEN,
  OPEN_FOR_CLIENT_BODY,
  OPEN_FOR_CLIENT_TITLE,
  SEND_NEEDS_OPEN,
  alsoInLabel,
  approvedBy,
  approvedByLine,
  approvedWhen,
  approverIds,
  canDeletePlan,
  deletePlanBody,
  deletePlanErrorCopy,
  keepApprovalBody,
  keepApprovalTitle,
  moveAsksKeep,
  movedKeptToast,
  planPrimaryAction,
  planSendAction,
  renameTitle,
} from '@/components/chat/plan-card';
import { applyMove } from '@/lib/chat/plan-drag';
import {
  alsoInByPost,
  readPlanScreen,
  runPlanShare,
  type PlanBundle,
  type PlanItemRow,
} from '@/lib/chat/plans';
import { latestPlanCardId } from '@/components/chat/ChatConnected';

const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const readRoot = (name: string): string => readFileSync(`${root}${name}`, 'utf8');

function item(over: Partial<PlanItemRow> & { id: string }): PlanItemRow {
  return {
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: 'Reel',
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
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: 'creator',
    },
    items: [
      item({ id: 'p1', kind: 'post', title: null, post_id: 'post1', position: 0 }),
      item({ id: 'c1', target_date: '2026-10-14', position: 1 }),
    ],
    reviews: [
      {
        item_id: 'p1',
        side: 'client',
        status: 'approved',
        reviewed_by: 'u-client',
        reviewed_at: '2026-10-12T13:15:00Z',
      },
      { item_id: 'p1', side: 'team', status: 'approved', reviewed_by: 'u-agency' },
    ],
    postStages: { post1: 'review' },
    // 12:00 Asia/Kolkata on 13 Oct.
    postInfo: { post1: { title: 'Carousel', target_date: '2026-10-13T06:30:00Z' } },
  };
}

describe('item 1: Create plan', () => {
  it('creates without a share step (no card is ever sent)', async () => {
    const calls: string[] = [];
    const result = await runPlanShare(
      {
        create: async (d) => {
          calls.push(`create:${d.audience}`);
          return { ok: true, data: 'plan-new' };
        },
        conceptAdd: async () => ({ ok: true, data: 'c' }),
        postsAdd: async () => ({ ok: true, data: 1 }),
      },
      {
        workspaceId: 'ws',
        title: 'T',
        startsOn: '2026-10-12',
        endsOn: '2026-10-18',
        audience: 'team',
        concepts: [],
        postIds: ['p'],
      },
      { planId: null, conceptsDone: 0, postsDone: false, messageId: 'm', shared: false },
      'trace',
    );
    expect(calls).toEqual(['create:team']);
    expect(result).toMatchObject({ ok: true, progress: { planId: 'plan-new', shared: false } });
  });

  it('the chat opens the new plan screen after create', () => {
    const src = read('ChatConnected.tsx');
    expect(src).toMatch(/onCreated=\{\(planId, stale\) => \{[\s\S]*?onOpenPlan\(\{ planId/);
  });
});

describe('item 2: Plans sheet', () => {
  it('the chat wires a row to open the plan screen', () => {
    const src = read('ChatConnected.tsx');
    expect(src).toContain("onOpenPlan={(planId) => onOpenPlan({ planId, senderName: '' })}");
  });
});

describe('item 3: header menu, rename, delete, subtitle', () => {
  it('the menu: Rename always, Delete plan (danger, bin) only when allowed; 44px rows', () => {
    const noop = (): void => undefined;
    const both = renderToStaticMarkup(
      <PlanHeaderMenu open canDelete onRename={noop} onDelete={noop} onClose={noop} />,
    );
    expect(both).toContain('role="menu"');
    expect(both).toContain('Rename');
    expect(both).toMatch(/<button(?=[^>]*data-plan-menu-delete="")(?=[^>]*class="[^"]*text-bad)/);
    expect(both).toContain('Delete plan');
    expect(both.match(/min-h-\[44px\]/g)).toHaveLength(2);
    // translateY only, tokens only.
    expect(both).toMatch(/translate-y/);
    expect(both).not.toMatch(/translate-x|rotate/);
    const renameOnly = renderToStaticMarkup(
      <PlanHeaderMenu open canDelete={false} onRename={noop} onDelete={noop} onClose={noop} />,
    );
    expect(renameOnly).not.toContain('Delete plan');
    expect(
      renderToStaticMarkup(
        <PlanHeaderMenu open={false} canDelete onRename={noop} onDelete={noop} onClose={noop} />,
      ),
    ).toBe('');
  });

  it('delete is for the creator or a workspace owner/admin', () => {
    const plan = { created_by: 'creator' };
    expect(canDeletePlan(plan, 'creator', 'agency')).toBe(true);
    expect(canDeletePlan(plan, 'other', 'owner')).toBe(true);
    expect(canDeletePlan(plan, 'other', 'admin')).toBe(true);
    expect(canDeletePlan(plan, 'other', 'agency')).toBe(false);
    expect(canDeletePlan({ created_by: null }, null, null)).toBe(false);
  });

  it('rename: 1 to 200 chars, trimmed; the field has Cancel (X) and Done, 44px each', () => {
    expect(renameTitle('  New  ')).toBe('New');
    expect(renameTitle('   ')).toBeNull();
    expect(renameTitle('x'.repeat(201))).toBeNull();
    expect(renameTitle('x'.repeat(200))).toHaveLength(200);
    const noop = (): void => undefined;
    const html = renderToStaticMarkup(
      <RenameField value="Week" busy={false} onChange={noop} onCancel={noop} onDone={noop} />,
    );
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('aria-label="Cancel rename"');
    expect(html).toContain('Done');
    expect(html).toMatch(/class="[^"]*h-11 w-11[^"]*"[^>]*data-plan-rename-cancel=""/);
    const empty = renderToStaticMarkup(
      <RenameField value="  " busy={false} onChange={noop} onCancel={noop} onDone={noop} />,
    );
    expect(empty).toMatch(/data-plan-rename-done=""[^>]*disabled=""/);
  });

  it('rename calls planUpdate with the current dates; toast "Renamed"', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain('p_starts_on: bundle.plan.starts_on,');
    expect(src).toContain('p_ends_on: bundle.plan.ends_on,');
    expect(src).toContain('toast.show({ title: RENAMED_TOAST })');
  });

  it('delete copy: the Open line only on an Open plan; forbidden_role names who may', () => {
    expect(deletePlanBody('team')).toBe(
      'Cards already in chat will show Plan deleted. This cannot be undone.',
    );
    expect(deletePlanBody('client')).toBe(
      'Cards already in chat will show Plan deleted. Approvers get a notification. This cannot be undone.',
    );
    expect(deletePlanErrorCopy('P0001: forbidden_role')).toBe(DELETE_FORBIDDEN);
    expect(DELETE_FORBIDDEN).toBe("Couldn't delete the plan. You don't have access to do this.");
    expect(deletePlanErrorCopy('boom')).toBe("Couldn't delete. Try again.");
    const src = read('PlanScreen.tsx');
    expect(src).toContain('planDelete(supabase, { p_plan_id: planId, p_trace_id: traceId })');
    // At once, no confirm: the Undo strip for UNDO_MS, the write on its expiry.
    expect(src).toMatch(
      /title: PLAN_DELETED_TOAST,[\s\S]*?durationMs: UNDO_MS,[\s\S]*?kind: 'undo',[\s\S]*?onExpire: \(\) => void commitDelete\(\),/,
    );
    expect(src).not.toContain('DELETE_PLAN_TITLE');
  });

  it('a client gets a plain title (no menu button)', () => {
    const src = read('PlanScreen.tsx');
    // Edit mode takes the header first; otherwise the agency gets the menu title.
    expect(src).toMatch(/:\s*agency\s*\?\s*\{\s*titleSlot:/);
  });
});

describe('item 4: footer', () => {
  const noop = (): void => undefined;
  it('send action: none outside a chat; Go to card when the card is here; disabled on a Draft with a client', () => {
    expect(planSendAction({ side: 'agency', audience: 'team', chat: null })).toEqual({
      kind: 'none',
    });
    const chat = { name: 'Priya', hasClient: true, cardInChat: false };
    expect(planSendAction({ side: 'agency', audience: 'team', chat })).toEqual({
      kind: 'send',
      label: 'Send in Priya',
      disabled: true,
      hint: SEND_NEEDS_OPEN,
    });
    expect(planSendAction({ side: 'agency', audience: 'client', chat })).toMatchObject({
      kind: 'send',
      disabled: false,
      hint: null,
    });
    expect(
      planSendAction({ side: 'agency', audience: 'team', chat: { ...chat, cardInChat: true } }),
    ).toEqual({ kind: 'go' });
    // A client: Go to card only.
    expect(planSendAction({ side: 'client', audience: 'client', chat })).toEqual({ kind: 'none' });
    expect(
      planSendAction({ side: 'client', audience: 'client', chat: { ...chat, cardInChat: true } }),
    ).toEqual({ kind: 'go' });
    expect(SEND_NEEDS_OPEN).toBe('Open the plan for approvers to send it here.');
  });

  it('one primary button (X3): Open for approvers outside a chat, Send to approvers / Send in from one; 44px', () => {
    const open = renderToStaticMarkup(
      <PlanFooter
        action={planPrimaryAction({ side: 'agency', audience: 'team', chat: null })}
        busy={false}
        error={null}
        onPress={noop}
      />,
    );
    expect(open).toContain('Open for approvers');
    expect(open).toContain('data-plan-primary="open"');
    expect(open.match(/min-h-\[44px\]/g)?.length).toBe(1);
    expect(open.match(/<button/g)?.length).toBe(1);
    const toApprovers = renderToStaticMarkup(
      <PlanFooter
        action={planPrimaryAction({ side: 'agency', audience: 'team', chat: { name: 'Priya' } })}
        busy={false}
        error={null}
        onPress={noop}
      />,
    );
    expect(toApprovers).toContain('Send to approvers in Priya');
    expect(toApprovers).not.toContain('Open for approvers');
    expect(toApprovers).not.toContain(SEND_NEEDS_OPEN);
    const send = renderToStaticMarkup(
      <PlanFooter
        action={planPrimaryAction({ side: 'agency', audience: 'client', chat: { name: 'Priya' } })}
        busy={false}
        error={null}
        onPress={noop}
      />,
    );
    expect(send).toContain('Send in Priya');
    expect(send).not.toContain('Go to card');
    // Not from a chat and Open: no button at all.
    expect(
      renderToStaticMarkup(
        <PlanFooter
          action={planPrimaryAction({ side: 'agency', audience: 'client', chat: null })}
          busy={false}
          error={null}
          onPress={noop}
        />,
      ),
    ).toBe('');
  });

  it('Open for approvers confirm copy and write; the old banner is gone', () => {
    expect(OPEN_FOR_CLIENT_TITLE).toBe('Open this plan for approvers?');
    expect(OPEN_FOR_CLIENT_BODY).toBe(
      'Approvers can open it from any plan card in chat and tick slots. They get a notification. This cannot be undone.',
    );
    const src = read('PlanScreen.tsx');
    expect(src).toContain(
      'planShareWithClient(supabase, { p_plan_id: planId, p_trace_id: traceId })',
    );
    expect(src).toContain('toast.show({ title: OPEN_FOR_CLIENT_TOAST })');
    expect(src).not.toContain('Share with client');
  });

  it('Go to card closes the screen and the thread jumps to and highlights the card', () => {
    expect(
      latestPlanCardId(
        [
          { id: 'm1', sharedPlanIds: ['a'] },
          { id: 'm2', sharedPlanIds: ['b'] },
          { id: 'm3', sharedPlanIds: ['a'] },
          { id: 'm4' },
        ],
        'a',
      ),
    ).toBe('m3');
    expect(latestPlanCardId([{ id: 'm1' }], 'a')).toBeNull();
    const chat = read('ChatConnected.tsx');
    expect(chat).toContain('setPlanShown(false);');
    expect(chat).toContain(
      'cardJump={cardJump?.channelId === selected.channelId ? cardJump : null}',
    );
    const thread = read('MessageThread.tsx');
    expect(thread).toContain('cardJumpSeq.current = cardJump.seq;');
  });
});

describe('item 5: one view of the PLAN line', () => {
  const paint = (side: 'agency' | 'client', audience: 'team' | 'client'): string =>
    renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={bundle(audience)}
          groups={planListGroups(bundle(audience), 'Asia/Kolkata', side)}
          side={side}
          timeZone="Asia/Kolkata"
          thumbs={{}}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
          onPlanNotOk={() => undefined}
        />
      </MemoryRouter>,
    );

  it('Open: client side for everyone; the agency reads it as text; never a team answer', () => {
    const agency = paint('agency', 'client');
    expect(agency).not.toContain('data-plan-slot="team"');
    expect(agency).toMatch(
      /data-plan-slot="client"[^>]*data-plan-slot-state="approved"[^>]*data-plan-control="text"[^>]*>OK</,
    );
    expect(agency).toContain('data-plan-slot-readonly=""');
    expect(agency).not.toContain('data-plan-ok=');
    expect(agency).toContain('1/2 OK');
    const client = paint('client', 'client');
    expect(client).not.toContain('data-plan-slot-readonly');
    // The client's approved slot is the solid pill; the undecided concept the switch.
    expect(client).toMatch(
      /data-plan-slot="client" data-plan-slot-state="approved" data-plan-control="pill"/,
    );
    expect(client).toContain('data-plan-control="switch"');
    expect(client).toContain('1/2 OK');
  });

  it('Draft: the team side for the agency, writable', () => {
    const html = paint('agency', 'team');
    expect(html).toMatch(/data-plan-slot="team"[^>]*data-plan-slot-state="approved"/);
    expect(html).toContain('data-plan-control="pill"');
    expect(html).toContain('1/2 OK');
  });

  it('the screen never writes the team side on an Open plan', () => {
    const src = read('PlanScreen.tsx');
    expect(src).toContain(
      'const slot = shownBundle !== null ? slotSide(side, shownBundle.plan.audience) : null;',
    );
    expect(src).toMatch(
      /Read-only \(the agency on an Open plan\) never writes[^\n]*\n\s*if \(bundle === null \|\| slot === null \|\| editMode\) return;/,
    );
  });
});

describe('item 6: Approved by', () => {
  it('who and when, Open plans only; ids for one batched name read', () => {
    const open = bundle('client');
    const p1 = open.items[0] as PlanItemRow;
    expect(approvedBy(open, p1)).toEqual({ userId: 'u-client', at: '2026-10-12T13:15:00Z' });
    expect(approvedBy(bundle('team'), p1)).toBeNull();
    expect(approverIds(open)).toEqual(['u-client']);
    expect(approverIds(bundle('team'))).toEqual([]);
  });

  it('"today, 6:45 PM" / "yesterday, 6:45 PM" / "12 Oct, 6:45 PM" in the given zone', () => {
    const now = new Date('2026-10-12T15:00:00Z');
    expect(approvedWhen('2026-10-12T13:15:00Z', now, 'Asia/Kolkata')).toBe('today, 6:45 PM');
    expect(approvedWhen('2026-10-11T13:15:00Z', now, 'Asia/Kolkata')).toBe('yesterday, 6:45 PM');
    expect(approvedWhen('2026-10-02T13:15:00Z', now, 'Asia/Kolkata')).toBe('2 Oct, 6:45 PM');
    // 23:30 UTC on 11 Oct is 12 Oct in Kolkata: today there.
    expect(approvedWhen('2026-10-11T23:30:00Z', now, 'Asia/Kolkata')).toBe('today, 5:00 AM');
    expect(approvedByLine('Riya Shah', 'today, 6:45 PM')).toBe(
      'Approved by Riya Shah · today, 6:45 PM',
    );
  });

  it('the row shows no Approved by line any more: the PLAN line reads OK', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={bundle('client')}
          groups={planListGroups(bundle('client'), 'Asia/Kolkata', 'agency')}
          side="agency"
          timeZone="Asia/Kolkata"
          thumbs={{}}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
          onPlanNotOk={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('data-plan-row-approved-by');
    expect(html).not.toContain('Approved by Riya Shah');
    expect(html).toMatch(/data-plan-control="text"[^>]*text-good[^>]*>OK</);
    expect(MEMBER_NAME).toBe('Member');
  });

  it('reviews read reviewed_by / reviewed_at; names come from one batched read', async () => {
    const src = readRoot('src/lib/chat/plans.ts');
    expect(src).toContain(
      "const REVIEW_COLUMNS = 'item_id, side, status, reviewed_by, reviewed_at';",
    );
    const names: string[][] = [];
    // One plan_bundle_read answers the screen (the plan, items, reviews, posts).
    const answer = {
      timezone: 'Asia/Kolkata',
      plans: [bundle('client').plan],
      items: [
        { ...bundle('client').items[0], plan_id: 'plan' },
        { ...bundle('client').items[1], plan_id: 'plan' },
      ],
      draft_rows: [],
      next_cursor: null,
      reviews: bundle('client').reviews,
      posts: [{ id: 'post1', stage: 'review', title: 'Carousel', target_date: null }],
      comment_counts: {},
      thumbs: { posts: {}, concepts: {} },
      also_in: {},
      loose_posts: [],
      any_plan: true,
      last_sent_at: null,
    };
    const rpcs: string[] = [];
    const client = {
      rpc: async (fn: string) => {
        rpcs.push(fn);
        return { data: answer, error: null };
      },
    } as unknown as Parameters<typeof readPlanScreen>[0];
    const result = await readPlanScreen(client, 'plan', undefined, {
      workspaceId: 'ws',
      timeZone: 'Asia/Kolkata',
      approvers: approverIds,
      readNames: async (ids) => {
        names.push(ids);
        return { ok: true, data: ids.map((userId) => ({ userId, displayName: 'Riya Shah' })) };
      },
    });
    expect(rpcs).toEqual(['plan_bundle_read']);
    expect(names).toEqual([['u-client']]);
    expect(result.ok && result.data.names).toEqual({ 'u-client': 'Riya Shah' });
  });
});

describe('item 7: moves keep or reset the approval', () => {
  const open = bundle('client');
  const p1 = open.items[0] as PlanItemRow;

  it('asks only on an Open plan, a day change, a client-approved slot', () => {
    expect(moveAsksKeep(open, p1, '2026-10-13', '2026-10-15')).toBe(true);
    expect(moveAsksKeep(open, p1, '2026-10-13', '2026-10-13')).toBe(false);
    expect(moveAsksKeep(bundle('team'), p1, '2026-10-13', '2026-10-15')).toBe(false);
    expect(moveAsksKeep(open, open.items[1] as PlanItemRow, '2026-10-14', null)).toBe(false);
  });

  it('copy: title, body, buttons, kept toast', () => {
    expect(keepApprovalTitle('Riya Shah')).toBe('Slot approved by Riya Shah');
    expect(keepApprovalBody('Thu 15 Oct')).toBe('Moving it to Thu 15 Oct. Keep the approval?');
    expect(keepApprovalBody(null)).toBe('Moving it to No date. Keep the approval?');
    expect(movedKeptToast('Thu 15 Oct')).toBe('Moved to Thu 15 Oct.');
    // The Sheet portals into the DOM; its wiring is checked through the source.
    const src = read('PlanMoveSheet.tsx');
    expect(src).toContain('onClick={() => props.onKeep(true)}');
    expect(src).toContain('onClick={() => props.onKeep(false)}');
    expect(src).toContain('<Sheet open={props.open} onClose={props.onCancel} title={props.title}>');
  });

  it('every move carries keep_reviews; only "Yes, keep it" sends true', () => {
    // The item screen writes the 5-arg proc; the Plan screen queues a 'move'
    // op with the same fields for plan_save (X3).
    const item = read('PlanItemScreen.tsx');
    expect(item).toMatch(/planItemMove\(supabase, \{[\s\S]*?p_keep_reviews: keep,/);
    expect(item).toMatch(/moveAsksKeep\(/);
    expect(item).toContain('void moveItemTo(day, false);');
    const screen = read('PlanScreen.tsx');
    expect(screen).toMatch(/op: 'move',[\s\S]*?keep_reviews: keep,/);
    expect(screen).toMatch(/moveAsksKeep\(/);
    expect(screen).toContain('commitMove(moved, toDay, toIndex, false);');
  });

  it('the optimistic paint keeps the reviews when kept, drops them when reset', () => {
    const order = ['c1', 'p1'];
    const kept = applyMove(open, 'p1', '2026-10-15', order, 'Asia/Kolkata', true);
    expect(kept.reviews.filter((r) => r.item_id === 'p1')).toHaveLength(2);
    const reset = applyMove(open, 'p1', '2026-10-15', order, 'Asia/Kolkata', false);
    expect(reset.reviews.filter((r) => r.item_id === 'p1')).toHaveLength(0);
    // A post slot moves by its post's date (noon in the zone), not plan_items.target_date.
    expect(kept.postInfo.post1?.target_date).toBe('2026-10-15T06:30:00.000Z');
    expect(kept.items.find((i) => i.id === 'p1')?.target_date).toBeUndefined();
    // Same day: nothing reset.
    const same = applyMove(open, 'p1', '2026-10-13', ['p1', 'c1'], 'Asia/Kolkata', false);
    expect(same.reviews).toHaveLength(2);
  });
});

describe('item 8: day source', () => {
  it('post slots read posts.target_date in the zone; nothing writes plan_items.target_date for posts', () => {
    const groups = planListGroups(bundle('client'), 'Asia/Kolkata', 'agency');
    const day = groups.flatMap((w) => w.days).find((d) => d.items.some((i) => i.id === 'p1'))?.day;
    expect(day).toBe('2026-10-13');
    const plans = readRoot('src/lib/chat/plans.ts');
    expect(plans).toContain("'id, stage, title, format, target_date'");
    expect(plans).not.toContain('draftRowDay');
    expect(plans).not.toMatch(/raw\.slice\(0, 10\)/);
  });
});

describe('item 9: Also in', () => {
  it('groups other live plans by post, one read for the whole plan', () => {
    expect(
      alsoInByPost('plan', [
        { post_id: 'post1', plan_id: 'plan', plans: { title: 'This' } },
        { post_id: 'post1', plan_id: 'o1', plans: { title: 'Launch' } },
        { post_id: 'post1', plan_id: 'o1', plans: [{ title: 'Launch' }] },
        { post_id: 'post2', plan_id: 'o2', plans: { title: 'Other' } },
        { post_id: 'post2', plan_id: 'o3', plans: null },
      ]),
    ).toEqual({ post1: ['Launch'], post2: ['Other'] });
    expect(alsoInLabel([])).toBeNull();
    expect(alsoInLabel(['Launch'])).toBe('Also in Launch');
    expect(alsoInLabel(['Launch', 'Other'])).toBe('Also in 2 plans');
  });

  it('renders a small warm pill (tokens only)', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanBody
          bundle={bundle('client')}
          groups={planListGroups(bundle('client'), 'UTC', 'client')}
          side="client"
          timeZone="UTC"
          thumbs={{}}
          alsoIn={{ post1: ['Launch'] }}
          drag={null}
          onOpenItem={() => undefined}
          onPlanOk={() => undefined}
          onPlanNotOk={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(html).toMatch(
      /data-plan-row-also-in=""[^>]*bg-warn-soft text-warn[^>]*>Also in Launch</,
    );
  });
});

describe('item 10: Remove from plan', () => {
  it('a red button at the bottom of the item screen; gone from the menus', () => {
    const html = renderToStaticMarkup(
      <RemoveFromPlanButton busy={false} onClick={() => undefined} />,
    );
    expect(html).toContain('Remove from plan');
    expect(html).toContain('data-plan-remove=""');
    expect(html).toContain('min-h-[44px]');
    const sheet = read('PlanMoveSheet.tsx');
    const concept = sheet.slice(
      sheet.indexOf('export function planConceptMenuItems'),
      sheet.indexOf('export function PlanMoveSheet'),
    );
    expect(concept).not.toContain('REMOVE_ROW_LABEL');
    const post = readRoot('src/components/pages/pcs/PostActionSheet.tsx');
    expect(post).not.toContain('REMOVE_ROW_LABEL');
    expect(post).not.toContain('planRows.onRemove');
  });
});

describe('item 13: Pipeline cleanup', () => {
  it('PlanWeek and SetDateSheet are deleted; plan-week.ts stays', () => {
    for (const gone of ['PlanWeek.tsx', 'SetDateSheet.tsx', 'PlanWeek.test.tsx']) {
      expect(existsSync(`${root}src/components/pages/pipeline/${gone}`)).toBe(false);
    }
    expect(existsSync(`${root}src/lib/plan-week.ts`)).toBe(true);
  });
});

describe('item 14: the part 2b migration file', () => {
  const sql = readRoot('supabase/migrations/20261012190000_plan_part_2b.sql');
  it('header, rollback note and the 2b block', () => {
    expect(sql.split('\n')[0]).toBe(
      '-- Applied on movnexawfhsyuluspxoc after this PR merged (part 2b). No-op there once applied.',
    );
    expect(sql).toMatch(/-- Rollback:/);
    expect(sql).toContain('--BEGIN 2b\n');
    expect(sql.trimEnd().endsWith('--END 2b')).toBe(true);
  });
  it('the stated changes only', () => {
    expect(sql).toContain(
      "if v_aud = 'team' and p_event_type <> 'plan_deleted' then return; end if;",
    );
    expect(sql).toContain("jsonb_build_object('plan_id', p_plan_id, 'plan_title', v_title)");
    expect(sql).toContain(
      'insert into public.plan_items (workspace_id, plan_id, kind, position, post_id, created_by)',
    );
    expect(sql).not.toContain('-- transitional mirror');
    expect(sql).toContain('select i.plan_id, i.id, i.position, p.number, p.title, p.target_date');
    expect(sql).toContain(
      "UPDATE public.plan_items SET target_date = NULL, updated_at = now() WHERE kind = 'post' AND target_date IS NOT NULL;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_target_date_concept_only CHECK (kind = 'concept' OR target_date IS NULL);",
    );
  });
});
