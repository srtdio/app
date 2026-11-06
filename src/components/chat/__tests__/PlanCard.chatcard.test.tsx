import { describe, expect, it, vi } from 'vitest';

// The card's import graph pulls the message factory, which imports the real
// agora-chat browser SDK (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { PlanCardBody, PlanCardSkeleton } from '@/components/chat/PlanCard';
import { TEXT_ROLE } from '@/components/ui/Text';
import type { PlanBundle } from '@/lib/chat/plans';

// The chat plan card is ui/ChatCard: the card is the bubble; the plan glyph and
// title (heading role, 15) on line 1, the range on line 2, the chips, bar and
// progress, the 44 action row (Forward left, Open plan right) and the time.

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan1',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: null,
  },
  items: [],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const noop = (): void => undefined;

function render(cardMeta?: string): string {
  return renderToStaticMarkup(
    <PlanCardBody
      view={{ kind: 'plan', bundle: BUNDLE }}
      side="agency"
      onOpen={noop}
      onForward={noop}
      {...(cardMeta !== undefined ? { cardMeta } : {})}
    />,
  );
}

describe('PlanCard on ui/ChatCard', () => {
  it('renders one [data-chat-card] carrying the plan hook', () => {
    const html = render();
    expect(html.match(/data-chat-card=""/g)).toHaveLength(1);
    expect(html).toMatch(/data-plan-card="plan1"[^>]*data-chat-card=""/);
  });

  it('the title takes the heading role (15/20), not text-xl', () => {
    const html = render();
    expect(html).toContain(
      `class="${TEXT_ROLE.heading} min-w-0 flex-1 truncate"><span data-plan-title="">Week of 12 Oct`,
    );
    expect(html).not.toContain('text-xl');
  });

  it('slots: meta (the range), the action row (Forward, Open plan), the time', () => {
    const html = render('2:14 PM');
    expect(html).toMatch(/data-chat-card-meta=""[^>]*><span data-plan-range=""/);
    expect(html).toMatch(/data-chat-card-actions=""[^>]*min-h-11/);
    const actions = html.slice(html.indexOf('data-chat-card-actions'));
    expect(actions.indexOf('data-plan-forward')).toBeGreaterThan(-1);
    expect(actions.indexOf('data-plan-forward')).toBeLessThan(actions.indexOf('data-plan-open'));
    expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
    // The induction hook stays on Open plan.
    expect(html).toMatch(/data-plan-open=""[^>]*data-induction=/);
  });

  it('no time slot unless the message hands it in', () => {
    expect(render()).not.toContain('data-chat-card-time');
  });

  it('the skeleton is the same ChatCard rows, with the time when handed in', () => {
    const box = renderToStaticMarkup(<PlanCardSkeleton cardMeta="2:14 PM" />);
    expect(box).toContain('data-plan-skeleton=""');
    expect(box).toContain('data-chat-card=""');
    expect(box).toMatch(/data-chat-card-actions=""[^>]*min-h-11/);
    expect(box).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
  });
});
