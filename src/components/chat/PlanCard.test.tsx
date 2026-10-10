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
import { PlanCardBody, type PlanCardView } from '@/components/chat/PlanCard';
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
    reviews: [{ item_id: 'c1', side: 'client', status: 'changes' }],
    postStages: { post1: 'approved' },
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
  it('agency: eyebrow, title, mono range, counts, progress, Open plan only', () => {
    const html = render({ kind: 'plan', bundle: bundle('client') }, 'agency');
    expect(html).toContain('PLAN');
    expect(html).toContain('Week of 12 Oct');
    expect(html).toContain('12 Oct - 18 Oct');
    expect(html).toContain('1 concept');
    expect(html).toContain('1 post');
    expect(html).toContain('1 of 2 approved by client · 1 change asked');
    expect(html).toContain('width:50%');
    expect(html).toContain('Open plan');
    expect(html).not.toContain('Forward');
    expect(html).not.toContain('Team only');
  });

  it('client on a client plan also gets Forward', () => {
    const html = render({ kind: 'plan', bundle: bundle('client') }, 'client');
    expect(html).toContain('data-plan-forward');
    expect(html).toContain('Forward');
  });

  it('a team plan shows the warn "Team only" chip (tokens only) and no Forward', () => {
    const html = render({ kind: 'plan', bundle: bundle('team') }, 'agency');
    const chip = /<span[^>]*data-plan-chip="warn"[^>]*>[^<]*<\/span>/.exec(html)?.[0] ?? '';
    expect(chip).toContain('Team only');
    expect(chip).toContain('bg-warn-soft');
    expect(chip).toContain('border-warn');
    expect(chip).toContain('text-warn');
    expect(render({ kind: 'plan', bundle: bundle('team') }, 'client')).not.toContain('Forward');
  });

  it('a plan the viewer cannot read renders the neutral not-visible card', () => {
    const html = render({ kind: 'unavailable' }, 'client');
    expect(html).toContain('Plan not available');
    expect(html).toContain('data-plan-card="unavailable"');
    expect(html).toContain('bg-panel-2');
    expect(html).not.toContain('Open plan');
  });
});

describe('Item screen rules', () => {
  it('agency reviews as team; a post item also opens in Pipeline', () => {
    expect(itemActions('agency', { kind: 'concept' }, 'client')).toMatchObject({
      kind: 'review',
      side: 'team',
      approveLabel: 'Team approve',
      openInPipeline: false,
    });
    expect(itemActions('agency', { kind: 'post' }, 'client')).toMatchObject({
      side: 'team',
      openInPipeline: true,
    });
  });

  it('agency on a post item: "Open in pipeline" and "Team approve" only (no Ask changes)', () => {
    expect(actionLabels(itemActions('agency', { kind: 'post' }, 'client'))).toEqual([
      'Open in pipeline',
      'Team approve',
    ]);
    expect(actionLabels(itemActions('agency', { kind: 'concept' }, 'client'))).toEqual([
      'Ask changes',
      'Team approve',
    ]);
    expect(actionLabels(itemActions('client', { kind: 'post' }, 'client'))).toEqual(['Open post']);
    const src = readFileSync(
      fileURLToPath(new URL('./PlanItemScreen.tsx', import.meta.url)),
      'utf8',
    );
    expect(src.match(/data-plan-ask=""/g)).toHaveLength(1);
  });

  it('client approves a concept on a client plan; on a post only "Open post"', () => {
    expect(itemActions('client', { kind: 'concept' }, 'client')).toMatchObject({
      kind: 'review',
      side: 'client',
      approveLabel: 'Approve',
    });
    expect(itemActions('client', { kind: 'post' }, 'client')).toEqual({ kind: 'open-post' });
    expect(itemActions('unknown', { kind: 'concept' }, 'client')).toEqual({ kind: 'none' });
  });

  it('status rows: Pipeline for a post, Team only for the agency, Client always', () => {
    const b = bundle('client');
    const post = b.items[1];
    const concept = b.items[0];
    if (post === undefined || concept === undefined) throw new Error('fixture');
    expect(statusRows(b, post, 'agency').map((r) => r.label)).toEqual([
      'Pipeline',
      'Team',
      'Client',
    ]);
    expect(statusRows(b, post, 'client').map((r) => r.label)).toEqual(['Pipeline', 'Client']);
    expect(statusRows(b, concept, 'client')).toEqual([
      { label: 'Client', value: 'Changes asked', tone: 'review' },
    ]);
    // A saved review shows at once (before the re-read lands).
    expect(statusRows(b, concept, 'agency', { team: 'approved' })[0]).toEqual({
      label: 'Team',
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
