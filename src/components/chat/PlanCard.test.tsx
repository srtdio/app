import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The card's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing in node never touches browser
// globals (mirrors MessageThread.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import {
  PLAN_CARD,
  PLAN_CARD_SKELETON,
  PlanCardBody,
  type PlanCardView,
} from '@/components/chat/PlanCard';
import {
  actionLabels,
  isLiveItem,
  itemActions,
  statusRows,
} from '@/components/chat/PlanItemScreen';
import { postChangedId } from '@/components/chat/PlanCardsProvider';
import { droppedLayer, planHeaderTitle } from '@/components/chat/PlanScreen';
import { PlanSharedNotice, composerFormIn, noticeShown } from '@/components/chat/PlanComposeScreen';
import { isPlanMessage, selectionForwardable } from '@/components/chat/MessageActionMenu';
import { threadCardIds } from '@/components/chat/MessageThread';
import {
  PaintLogOverlay,
  createPaintLog,
  formatPaintLog,
  paintLogOn,
  paintLogWanted,
} from '@/components/chat/PaintLog';
import { PLAN_CHANGED_EVENT, dispatchPlanChanged, planChangedId } from '@/lib/chat/plans';
import type { PlanBundle } from '@/lib/chat/plans';
import type { ThreadMessage } from '@/lib/chat/thread';

function bundle(audience: 'team' | 'client'): PlanBundle {
  return {
    plan: {
      id: 'plan1',
      workspace_id: 'ws',
      title: 'Week of 12 Oct',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
      audience,
      created_by: null,
    },
    items: [
      {
        id: 'c1',
        plan_id: 'plan1',
        kind: 'concept',
        position: 0,
        title: 'Reel',
        description: null,
        post_id: null,
        created_at: '1',
      },
      {
        id: 'p1',
        plan_id: 'plan1',
        kind: 'post',
        position: 1,
        title: null,
        description: null,
        post_id: 'post1',
        created_at: '1',
      },
    ],
    reviews: [
      { item_id: 'c1', side: 'client', status: 'changes' },
      // Client progress on a post item is its slot review (not posts.stage).
      { item_id: 'p1', side: 'client', status: 'approved' },
    ],
    postStages: { post1: 'review' },
    postInfo: { post1: { title: 'Carousel', target_date: '2026-10-13' } },
  };
}

const noop = (): void => undefined;

function render(view: PlanCardView, side: 'agency' | 'client' | 'unknown'): string {
  return renderToStaticMarkup(
    <PlanCardBody view={view} side={side} onOpen={noop} onForward={noop} />,
  );
}

describe('PlanCardBody', () => {
  it('the skeleton is exactly the card height; every card line is one line', () => {
    const height = (cls: string): string | undefined => /(?:^| )(h-\[\d+px\])/.exec(cls)?.[1];
    expect(height(PLAN_CARD)).toBeDefined();
    expect(height(PLAN_CARD_SKELETON)).toBe(height(PLAN_CARD));
    const long = bundle('team');
    const html = render(
      {
        kind: 'plan',
        bundle: { ...long, plan: { ...long.plan, title: 'A very long plan title '.repeat(6) } },
      },
      'agency',
    );
    expect(html).not.toContain('flex-wrap');
    expect(html).toMatch(/class="truncate text-\[17px\][^"]*leading-\[22px\]/);
    expect(html).toMatch(/data-plan-progress="" class="truncate text-xs leading-4/);
    expect(html).toMatch(/data-plan-range="" class="truncate font-mono text-\[13px\] leading-5/);
  });

  it('agency: eyebrow, title, mono range, counts, progress, Open plan and Forward', () => {
    const html = render({ kind: 'plan', bundle: bundle('client') }, 'agency');
    expect(html).toContain('PLAN');
    expect(html).toContain('Week of 12 Oct');
    expect(html).toContain('12 Oct - 18 Oct');
    expect(html).toContain('1 concept');
    expect(html).toContain('1 post');
    // An Open plan: the client side for everyone, never the team count.
    expect(html).toContain('Client 1 of 2');
    expect(html).not.toContain('Agency 0 of 2');
    expect(html).toContain('width:50%');
    expect(html).toContain('data-plan-card-bar="client"');
    expect(html).toContain('Open plan');
    expect(html).toContain('data-plan-forward');
    expect(html).not.toContain('Agency only');
    expect(html).not.toContain('Team');
  });

  it('client on a client plan also gets Forward', () => {
    const html = render({ kind: 'plan', bundle: bundle('client') }, 'client');
    expect(html).toContain('data-plan-forward');
    expect(html).toContain('Forward');
  });

  it('a Draft plan shows the warn "Draft" chip and "Team X of N" (tokens only); Forward for the agency only', () => {
    const html = render({ kind: 'plan', bundle: bundle('team') }, 'agency');
    const chip = /<span[^>]*data-plan-chip="warn"[^>]*>[^<]*<\/span>/.exec(html)?.[0] ?? '';
    expect(chip).toContain('Draft');
    expect(html).not.toContain('Agency only');
    expect(html).toContain('Team 0 of 2');
    expect(html).toContain('data-plan-card-bar="team"');
    expect(html).toContain('data-plan-forward');
    expect(chip).toContain('bg-warn-soft');
    expect(chip).toContain('border-warn');
    expect(chip).toContain('text-warn');
    expect(render({ kind: 'plan', bundle: bundle('team') }, 'client')).not.toContain('Forward');
  });

  it('a plan the viewer can no longer read (deleted) renders "Plan deleted"', () => {
    const html = render({ kind: 'unavailable' }, 'client');
    expect(html).toContain('Plan deleted');
    expect(html).not.toContain('Plan not available');
    expect(html).toContain('data-plan-card="unavailable"');
    expect(html).toContain('bg-panel-2');
    expect(html).not.toContain('Open plan');
  });
});

describe('Item screen rules', () => {
  it('agency reviews a concept as team on a Draft plan only; a post item has no actions', () => {
    expect(itemActions('agency', { kind: 'concept' }, 'team')).toEqual({
      kind: 'review',
      side: 'team',
      approveLabel: 'Agency approve',
    });
    // No team writes on an Open plan.
    expect(itemActions('agency', { kind: 'concept' }, 'client')).toEqual({ kind: 'none' });
    expect(itemActions('agency', { kind: 'post' }, 'client')).toEqual({ kind: 'none' });
    expect(itemActions('agency', { kind: 'post' }, 'team')).toEqual({ kind: 'none' });
  });

  it('labels: "Ask changes" then the approve on a concept; none on a post', () => {
    expect(actionLabels(itemActions('agency', { kind: 'post' }, 'client'))).toEqual([]);
    expect(actionLabels(itemActions('agency', { kind: 'concept' }, 'team'))).toEqual([
      'Ask changes',
      'Agency approve',
    ]);
    expect(actionLabels(itemActions('client', { kind: 'post' }, 'client'))).toEqual([]);
    const src = readFileSync(
      fileURLToPath(new URL('./PlanItemScreen.tsx', import.meta.url)),
      'utf8',
    );
    expect(src.match(/data-plan-ask=""/g)).toHaveLength(1);
  });

  it('a post item embeds the pipeline post view; its overflow opens the post view sheet', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PlanItemScreen.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('<PostDetailPage');
    expect(src).toMatch(/postId=\{item\.post_id\}\s+embedded/);
    expect(src).toContain('onNavigateAway={props.onClose}');
    expect(src).toContain('<IconMore');
    expect(src).toContain('actionsOpen={props.open && moreOpen}');
    expect(src).toContain('onActionsOpenChange={setMoreOpen}');
    expect(src).toContain('onOpenInPipeline={() => {');
    expect(src).toContain('navigate(postRoute(item.post_id))');
    // The overflow is THE post view's sheet: no sheet of its own, no absolute button.
    expect(src).not.toContain('OverflowSheet');
    expect(src).not.toContain("from '@/components/ui/Sheet'");
    expect(src).not.toContain('absolute right-3');
    for (const gone of [
      'data-plan-pipeline',
      'data-plan-open-post',
      'data-plan-media="post"',
      'ItemPostSheet',
      'SharedPostCards',
    ]) {
      expect(src).not.toContain(gone);
    }
  });

  it('client approves a concept on a client plan; a post item has no actions', () => {
    expect(itemActions('client', { kind: 'concept' }, 'client')).toEqual({
      kind: 'review',
      side: 'client',
      approveLabel: 'Approve',
    });
    expect(itemActions('client', { kind: 'post' }, 'client')).toEqual({ kind: 'none' });
    expect(itemActions('client', { kind: 'concept' }, 'team')).toEqual({ kind: 'none' });
    expect(itemActions('unknown', { kind: 'concept' }, 'client')).toEqual({ kind: 'none' });
  });

  it('status rows: Pipeline for a post, Agency for the agency on a Draft plan only, Client always', () => {
    const b = bundle('client');
    const post = b.items[1];
    const concept = b.items[0];
    if (post === undefined || concept === undefined) throw new Error('fixture');
    // Open plan: team reviews are never shown.
    expect(statusRows(b, post, 'agency').map((r) => r.label)).toEqual(['Pipeline', 'Client']);
    const d = bundle('team');
    expect(statusRows(d, post, 'agency').map((r) => r.label)).toEqual([
      'Pipeline',
      'Agency',
      'Client',
    ]);
    expect(statusRows(b, post, 'client').map((r) => r.label)).toEqual(['Pipeline', 'Client']);
    expect(statusRows(b, concept, 'client')).toEqual([
      { label: 'Client', value: 'Changes asked', tone: 'review' },
    ]);
    // A saved review shows at once (before the re-read lands).
    expect(statusRows(d, concept, 'agency', { team: 'approved' })[0]).toEqual({
      label: 'Agency',
      value: 'Approved',
      tone: 'good',
    });
  });
});

describe('plan message plumbing', () => {
  const msg = (over: Partial<ThreadMessage>): ThreadMessage =>
    ({
      id: 'm',
      senderUserId: 'u',
      body: '',
      createdAt: '2026-10-09T10:00:00Z',
      time: 0,
      provisionalTime: false,
      mine: false,
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      state: 'sent',
      status: 'sent',
      reactions: [],
      ...over,
    }) as ThreadMessage;

  it('threadCardIds collects distinct plan ids, skipping deleted messages', () => {
    const ids = threadCardIds([
      msg({ id: 'a', sharedPlanIds: ['p1'] }),
      msg({ id: 'b', sharedPlanIds: ['p1', 'p2'] }),
      msg({ id: 'c', sharedPlanIds: ['p3'], deleted: true }),
    ]);
    expect(ids.planIds).toEqual(['p1', 'p2']);
  });

  it('a plan message is recognised for the menu (Forward, Save to notes and Edit hidden)', () => {
    expect(isPlanMessage(msg({ sharedPlanIds: ['p1'] }))).toBe(true);
    expect(isPlanMessage(msg({}))).toBe(false);
  });

  it('plan-changed and post-changed events carry their ids', () => {
    const seen: Array<string | null> = [];
    const target = new EventTarget();
    target.addEventListener(PLAN_CHANGED_EVENT, (e) => seen.push(planChangedId(e)));
    dispatchPlanChanged(target as unknown as Window, 'plan1');
    expect(seen).toEqual(['plan1']);
    expect(postChangedId(new CustomEvent('x', { detail: { postId: 'post1' } }))).toBe('post1');
    expect(postChangedId(new CustomEvent('x', { detail: {} }))).toBeNull();
  });
});

describe('Plan screen header (F3)', () => {
  it('first paint uses the cached title; "Plan" only when nothing is cached', () => {
    expect(planHeaderTitle('loading', null, 'Week of 12 Oct')).toBe('Week of 12 Oct');
    expect(planHeaderTitle('loading', null, null)).toBe('Plan');
    expect(planHeaderTitle('error', null, 'Week of 12 Oct')).toBe('Week of 12 Oct');
    expect(planHeaderTitle('ready', 'Renamed', 'Week of 12 Oct')).toBe('Renamed');
    expect(planHeaderTitle('ready', null, 'Week of 12 Oct')).toBe('Plan not available');
  });
});

describe('Plan shared notice (F6)', () => {
  it('sits in the chat (absolute, below plan pages), opacity only, hidden until a share', () => {
    const html = renderToStaticMarkup(<PlanSharedNotice shareCount={0} text="Plan shared" />);
    expect(html).toContain('absolute');
    expect(html).toContain('z-30');
    expect(html).not.toContain('fixed');
    expect(html).not.toContain('translate');
    expect(html).toContain('data-plan-shared-notice="hidden"');
    expect(html).not.toContain('Plan shared');
  });
});

describe('round 3 fixes', () => {
  const m = (id: string, plan: boolean) => ({ id, ...(plan ? { sharedPlanIds: ['p1'] } : {}) });

  it('MAJ-1: a selection holding a plan card cannot be forwarded', () => {
    const messages = [m('a', false), m('b', true), m('c', false)];
    expect(selectionForwardable(new Set(['a', 'c']), messages)).toBe(true);
    expect(selectionForwardable(new Set(['a', 'b']), messages)).toBe(false);
    expect(selectionForwardable(new Set(['b']), messages)).toBe(false);
    const src = readFileSync(
      fileURLToPath(new URL('./MessageThread.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('canForwardHere && selectionForwardable(selected, selectable)');
  });

  it('MAJ-2: the notice hides at once in another chat (count 0) and after its time', () => {
    expect(noticeShown(1, 0)).toBe(true);
    expect(noticeShown(0, 0)).toBe(false);
    // Switched chat before the timer ran out: the count reads 0, hidden.
    expect(noticeShown(0, 0)).toBe(false);
    // Time ran out for share 1; share 2 shows again.
    expect(noticeShown(1, 1)).toBe(false);
    expect(noticeShown(2, 1)).toBe(true);
    const src = readFileSync(
      fileURLToPath(new URL('./ChatConnected.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('planShares.channelId === selectedChannelId');
    expect(src).not.toContain('setPlanShares(0)');
  });

  it('MIN-1: a late write on another item (or a closed screen) is dropped', () => {
    expect(isLiveItem({ itemId: 'i1', open: true }, 'i1')).toBe(true);
    expect(isLiveItem({ itemId: 'i2', open: true }, 'i1')).toBe(false);
    expect(isLiveItem({ itemId: 'i1', open: false }, 'i1')).toBe(false);
  });
});

describe('fix round 2', () => {
  it('G1: the composer form is found by walking elements, no has-selector anywhere', () => {
    const form = (textareas: number) => ({
      getElementsByTagName: (tag: string) => (tag === 'textarea' ? new Array(textareas) : []),
    });
    const search = form(0);
    const composer = form(1);
    const host = {
      getElementsByTagName: (tag: string) =>
        (tag === 'form' ? [composer, search] : []) as unknown as HTMLCollectionOf<Element>,
    } as unknown as Element;
    expect(composerFormIn(host)).toBe(composer);
    const empty = { getElementsByTagName: () => [] } as unknown as Element;
    expect(composerFormIn(empty)).toBeNull();
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const name of [
      'PlanComposeScreen.tsx',
      'PlanScreen.tsx',
      'PlanItemScreen.tsx',
      'PlanCard.tsx',
    ]) {
      expect(readFileSync(`${dir}${name}`, 'utf8')).not.toContain(':' + 'has(');
    }
  });

  it('G2: a re-read that drops the open item or a readable plan closes that layer', () => {
    const b = { items: [{ id: 'i1' }] } as unknown as Parameters<typeof droppedLayer>[0]['bundle'];
    expect(droppedLayer({ status: 'ready', bundle: b, itemId: 'i1', hadPlan: true })).toBeNull();
    expect(droppedLayer({ status: 'ready', bundle: b, itemId: 'gone', hadPlan: true })).toBe(
      'item',
    );
    expect(droppedLayer({ status: 'ready', bundle: null, itemId: 'i1', hadPlan: true })).toBe(
      'plan',
    );
    // Never readable: the screen keeps its "Plan not available" body.
    expect(
      droppedLayer({ status: 'ready', bundle: null, itemId: null, hadPlan: false }),
    ).toBeNull();
    // An unsettled read never closes anything.
    expect(
      droppedLayer({ status: 'loading', bundle: null, itemId: 'i1', hadPlan: true }),
    ).toBeNull();
    expect(droppedLayer({ status: 'error', bundle: null, itemId: 'i1', hadPlan: true })).toBeNull();
  });
});

describe('the opt-in paint log (?paintlog=1)', () => {
  it('is on only for ?paintlog=1, or a tab that turned it on, and ?paintlog=0 turns it off', () => {
    expect(paintLogWanted('', null)).toBe(false);
    expect(paintLogWanted('?paintlog=1', null)).toBe(true);
    expect(paintLogWanted('?x=2&paintlog=1', null)).toBe(true);
    expect(paintLogWanted('', '1')).toBe(true);
    expect(paintLogWanted('?paintlog=0', '1')).toBe(false);
    expect(paintLogWanted('?paintlog=true', null)).toBe(false);
  });

  it('is off by default: no entries, no notifications, no overlay', () => {
    expect(paintLogOn()).toBe(false);
    const log = createPaintLog({ enabled: false, now: () => 1 });
    const listener = vi.fn();
    log.subscribe(listener);
    log.push('plan card mount');
    expect(log.entries()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<PaintLogOverlay />)).toBe('');
  });

  it('keeps the newest entries with their times, oldest first, and formats one per line', () => {
    let t = 0;
    const log = createPaintLog({ enabled: true, now: () => (t += 1.25), limit: 2 });
    const listener = vi.fn();
    log.subscribe(listener);
    log.push('a');
    log.push('b');
    log.push('c');
    expect(log.entries().map((e) => e.what)).toEqual(['b', 'c']);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(formatPaintLog(log.entries(), ['head'])).toBe('head\n2.5 b\n3.8 c');
    log.clear();
    expect(log.entries()).toEqual([]);
  });

  it('is wired into the card, the ticker and the thread', () => {
    const src = (f: string): string =>
      readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8');
    expect(src('PlanCard.tsx')).toContain('usePaintLogCommit(');
    expect(src('StatusTicker.tsx')).toContain('paintLog(`ticker ${logState}`)');
    expect(src('MessageThread.tsx')).toContain('<PaintLogOverlay />');
  });
});
