import { describe, expect, it, vi } from 'vitest';

// The card never navigates: a tap opens its sheet.
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PostCardRow } from '../../../../packages/posts/src/reads';
import {
  CouldntLoadCard,
  NotVisibleCard,
  PostCouldntLoadCard,
  SharedPostCardList,
} from '@/components/chat/PostCard';
import { indexPostsById, sharedPostViews } from '@/components/chat/post-card';
import { TEXT_ROLE } from '@/components/ui/Text';
import { IconBriefs } from '@/components/ui/icons';

// The chat post card is ui/ChatCard: the card is the bubble and one press
// target; the post glyph and title (heading role) on line 1, the stage Tag and
// due date on line 2, the media box as the preview, the footer words in the 44
// action row (state left, action right) and the message time bottom-trailing.

const POST: PostCardRow = {
  id: 'p1',
  number: 12,
  title: 'Launch teaser',
  platform: 'instagram',
  format: 'single_image',
  stage: 'review',
  target_date: '2026-10-02',
  stage_entered_at: '2026-09-20T10:00:00Z',
  approved_by: null,
  approved_at: null,
  thumbnailAssetVersionId: null,
  firstMedia: null,
  mediaCount: 0,
  hasVideo: false,
};

function render(cardMeta?: string): string {
  const views = sharedPostViews(['p1'], indexPostsById([POST]), new Map());
  return renderToStaticMarkup(
    <MemoryRouter>
      <SharedPostCardList
        views={views}
        side="client"
        timeZone="UTC"
        workspaceZone="UTC"
        {...(cardMeta !== undefined ? { cardMeta, inBubble: false } : {})}
      />
    </MemoryRouter>,
  );
}

describe('PostCard on ui/ChatCard', () => {
  it('renders one [data-chat-card], the whole card one press target', () => {
    const html = render();
    expect(html.match(/data-chat-card=""/g)).toHaveLength(1);
    expect(html).toMatch(/role="button"[^>]*data-msg-link=""[^>]*data-chat-card=""/);
  });

  it('the title takes the heading role, one line', () => {
    expect(render()).toContain(
      `class="${TEXT_ROLE.heading} min-w-0 flex-1 truncate"><span data-card-title="" title="Launch teaser">Launch teaser`,
    );
  });

  it('slots: meta (stage, due date), preview (media box), actions (footer), time', () => {
    const html = render('2:14 PM');
    expect(html).toMatch(/data-chat-card-meta=""[\s\S]*?Review[\s\S]*?data-card-target="">2 Oct/);
    expect(html).toMatch(/data-chat-card-preview=""><div[^>]*data-card-media=""/);
    expect(html).toMatch(/data-chat-card-actions=""[^>]*min-h-11[\s\S]*?data-card-footer=""/);
    expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
  });

  it('the time only on a card-only message (handed in)', () => {
    expect(render()).not.toContain('data-chat-card-time');
  });

  it('not visible, couldn’t load and the shared retry card are ChatCards too', () => {
    for (const html of [
      renderToStaticMarkup(<NotVisibleCard platform="instagram" cardMeta="2:14 PM" />),
      renderToStaticMarkup(
        <PostCouldntLoadCard platform="instagram" onRetry={() => {}} cardMeta="2:14 PM" />,
      ),
      renderToStaticMarkup(
        <CouldntLoadCard onRetry={() => {}} icon={IconBriefs} cardMeta="2:14 PM" />,
      ),
    ]) {
      expect(html).toContain('data-chat-card=""');
      expect(html).toContain(TEXT_ROLE.heading);
      expect(html).toMatch(/data-chat-card-time=""[^>]*>2:14 PM</);
    }
  });
});
