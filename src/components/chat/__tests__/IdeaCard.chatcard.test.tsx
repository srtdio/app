import { describe, expect, it, vi } from 'vitest';

// The card's import graph pulls the message factory, which imports the real
// agora-chat browser SDK (mirrors PlanItemCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { IdeaCardSkeleton, PlanItemCardBody } from '@/components/chat/PlanItemCard';
import { TEXT_ROLE } from '@/components/ui/Text';
import type { IdeaCardView } from '@/lib/chat/idea-cards';

// The chat idea card is ui/ChatCard: the card is the bubble; the bank glyph
// and the idea title (heading role) on line 1, "{where} · {n} comments" on
// line 2, a tap opens the idea, and the message time bottom-trailing.

const IDEA: IdeaCardView = {
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
};

function render(view: IdeaCardView, cardMeta?: string): string {
  return renderToStaticMarkup(
    <PlanItemCardBody
      view={view}
      onOpen={() => undefined}
      {...(cardMeta !== undefined ? { cardMeta } : {})}
    />,
  );
}

describe('Idea card on ui/ChatCard', () => {
  it('renders one [data-chat-card] carrying the idea hook', () => {
    const html = render(IDEA);
    expect(html.match(/data-chat-card=""/g)).toHaveLength(1);
    expect(html).toMatch(/data-idea-card="i1"[^>]*data-chat-card=""/);
  });

  it('the title takes the heading role', () => {
    expect(render(IDEA)).toContain(
      `class="${TEXT_ROLE.heading} min-w-0 flex-1 truncate"><span data-idea-title="">Behind the scenes reel`,
    );
  });

  it('slots: meta (where and comments), the open tap, the time; no action row', () => {
    const html = render(IDEA, '2:14 PM');
    expect(html).toMatch(
      /data-chat-card-meta=""[^>]*><span data-idea-line=""[^>]*>Bank · 2 comments</,
    );
    expect(html).toMatch(/<button[^>]*aria-label="Open idea Behind the scenes reel"/);
    expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
    expect(html).not.toContain('data-chat-card-actions');
  });

  it('no access: muted, no tap, still the ChatCard with its time', () => {
    const html = render({ kind: 'none', id: 'i1' }, '2:14 PM');
    expect(html).toContain('data-idea-card="none"');
    expect(html).not.toContain('<button');
    expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
  });

  it('the skeleton is the ChatCard with bones', () => {
    const html = renderToStaticMarkup(<IdeaCardSkeleton cardMeta="2:14 PM" />);
    expect(html).toContain('data-idea-skeleton=""');
    expect(html).toContain('data-chat-card=""');
    expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
  });
});
