import { describe, expect, it, vi } from 'vitest';

// The card's import graph pulls the message factory, which imports the real
// agora-chat browser SDK (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { IdeaCardSkeleton, PlanItemCardBody } from '@/components/chat/PlanItemCard';
import {
  isIdeaMessage,
  isPlanMessage,
  selectionForwardable,
} from '@/components/chat/MessageActionMenu';
import { metaPlacement } from '@/components/chat/MessageThread';
import type { IdeaCardView } from '@/lib/chat/idea-cards';

type Idea = Extract<IdeaCardView, { kind: 'idea' }>;

function idea(over: Partial<Idea> = {}): Idea {
  return {
    kind: 'idea',
    id: 'i1',
    title: 'Behind the scenes reel',
    planId: null,
    planTitle: null,
    day: null,
    archived: false,
    showToClient: false,
    starred: false,
    comments: 2,
    ...over,
  };
}

const render = (view: IdeaCardView): string =>
  renderToStaticMarkup(<PlanItemCardBody view={view} onOpen={() => undefined} />);

describe('PlanItemCard states', () => {
  it('bank: eyebrow Idea, title, "Bank · 2 comments", lit-card, tappable', () => {
    const html = render(idea());
    expect(html).toContain('Idea');
    expect(html).toContain('Behind the scenes reel');
    expect(html).toContain('Bank · 2 comments');
    expect(html).toContain('lit-card');
    expect(html).toContain('<button');
    expect(html).toContain('data-idea-card="i1"');
  });

  it('planned: "{plan} · {date}"', () => {
    const html = render(idea({ planId: 'p1', planTitle: 'Week of 9 Nov', day: '2026-11-12' }));
    expect(html).toContain('Week of 9 Nov · 12 Nov · 2 comments');
  });

  it('archived: "Bank · archived"', () => {
    expect(render(idea({ archived: true }))).toContain('Bank · archived · 2 comments');
  });

  it('no access: the line, muted, no tap', () => {
    const html = render({ kind: 'none', id: 'i1' });
    expect(html).toContain('You don&#x27;t have access to this idea.');
    expect(html).toContain('data-idea-card="none"');
    expect(html).toContain('lit-card-muted');
    expect(html).not.toContain('<button');
  });

  it('loading: the card frame with bones', () => {
    const html = renderToStaticMarkup(<IdeaCardSkeleton />);
    expect(html).toContain('data-idea-skeleton');
    expect(html).toContain('lit-card-muted');
  });
});

describe('idea message rules (same as a plan card)', () => {
  it('an idea message is not forwardable and takes the card meta row', () => {
    const m = {
      id: 'm1',
      body: '',
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      sharedPlanItemIds: ['i1'],
    };
    expect(isIdeaMessage(m)).toBe(true);
    expect(isPlanMessage(m)).toBe(false);
    expect(selectionForwardable(new Set(['m1']), [m])).toBe(false);
    expect(selectionForwardable(new Set(['m2']), [m])).toBe(true);
    expect(metaPlacement(m)).toBe('row');
  });
});
