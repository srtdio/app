import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
// The chat cards' import graph reaches the agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors MessageThread.test).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { PipelinePost } from '@srtdio/posts';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import type { PresignCache } from '@/lib/asset-presign';
import { PostCard as PipelineCard } from '@/components/pages/PostCard';
import { BriefCard } from '@/components/pages/BriefCard';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { BriefCardItem } from '@/components/chat/BriefCard';
import {
  CouldntLoadCard,
  NotVisibleCard,
  PostCardSkeleton,
  SharedPostCardList,
} from '@/components/chat/PostCard';
import { PlanCardBody, PlanCardSkeleton } from '@/components/chat/PlanCard';
import { IconPipeline } from '@/components/ui/icons';

// Radius roles (CLAUDE.md): every card's outer box is 12px (rounded-xl);
// thumbnails inside a card stay 8px (rounded-lg).

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

/** The class list of the first element in the markup. */
function outer(html: string): string[] {
  return (/^<[a-z]+[^>]*?class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
}

const post: PipelinePost = {
  id: 'p1',
  number: 1,
  title: 'Monsoon drop',
  platform: 'instagram',
  format: 'text',
  caption: 'Linen that breathes.',
  target_date: '2026-11-02',
  stage: 'draft',
  origin: 'manual',
  legacy_author_name: null,
  bucket_id: null,
  brief_id: null,
  owner_user_id: 'u1',
  created_by: 'u1',
  workspace_id: 'w1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  stage_entered_at: '2026-01-01T00:00:00Z',
  approved_by: null,
  approved_on_behalf_of: null,
  approved_at: null,
  deleted_at: null,
  row_version: 1,
  thumbnailAssetVersionId: null,
};

const brief: BriefWithThumbnail = {
  id: 'b1',
  workspace_id: 'w1',
  number: 1,
  title: 'Spring launch',
  objective: 'Tease the spring drop.',
  legacy_author_name: null,
  status: 'open',
  target_date: '2026-07-01',
  reference_links: null,
  mentions: null,
  format_requested: null,
  brand_requirements: null,
  closed_at: null,
  closed_by: null,
  created_by: 'u1',
  created_via: 'manual',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  row_version: 1,
  thumbnailAssetVersionId: null,
};

describe('cards use the 12px card radius', () => {
  it('Pipeline post card', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineCard
          post={post}
          cache={cache}
          presignEnabled={false}
          now={new Date('2026-10-23T12:00:00Z')}
        />
      </MemoryRouter>,
    );
    expect(outer(html)).toContain('rounded-xl');
    expect(outer(html)).not.toContain('rounded-lg');
  });

  it('Briefs list card', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief} cache={cache} presignEnabled={false} href="/briefs/b1" />
      </MemoryRouter>,
    );
    expect(outer(html)).toContain('rounded-xl');
  });

  it('Activity card', () => {
    const html = renderToStaticMarkup(
      <ActivityCard
        group={[
          {
            id: 'e1',
            workspaceId: 'w1',
            number: null,
            eventType: 'mention',
            entityType: 'chat_channel',
            entityId: 'chan-1',
            scope: 'groups',
            tier: 'active',
            createdAt: '2026-06-14T00:00:00.000Z',
            readAt: null,
            snoozedUntil: null,
            commentId: null,
            assetId: null,
            toStage: null,
            fromStage: null,
            title: 'Launch crew',
            actorId: null,
            actorName: 'Bob',
            actorAvatarUrl: null,
            body: 'hello',
            format: null,
            caption: null,
            thumbnailAssetVersionId: null,
            pointsAdded: null,
            checkpointTotal: null,
            batchId: null,
            messageId: null,
            channelType: 'group',
          },
        ]}
        nowMs={Date.parse('2026-06-14T00:05:00.000Z')}
        cache={cache}
        presignEnabled={false}
        onOpenGroup={() => {}}
        onOpenEntry={() => {}}
        onSnooze={() => {}}
        onMarkRead={() => {}}
        selfName={null}
      />,
    );
    // Unread: the picked line (lit-selected); read: lit-card. Same 12px radius.
    expect(html).toMatch(
      /class="flex overflow-hidden rounded-xl border bg-panel[^"]*lit-(card|selected)/,
    );
  });

  it('chat brief card, tappable and unavailable', () => {
    const live = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCardItem view={{ kind: 'brief', briefId: 'b1', title: 'Spring', status: 'open' }} />
      </MemoryRouter>,
    );
    expect(outer(live)).toContain('rounded-xl');
    expect(outer(live)).not.toContain('rounded-lg');
    const gone = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCardItem view={{ kind: 'unavailable', briefId: 'b1' }} />
      </MemoryRouter>,
    );
    expect(outer(gone)).toContain('rounded-xl');
  });

  // Chat cards are ui/ChatCard: the card is the bubble, so it takes the
  // bubble radius (12 on laptop, mocked above; 18 on touch, chat-type).
  it('chat post card: the live card, not visible, the skeleton and the retry card', () => {
    const live = renderToStaticMarkup(
      <MemoryRouter>
        <SharedPostCardList
          views={[
            {
              kind: 'post',
              postId: 'p1',
              post: {
                id: 'p1',
                number: 1,
                title: 'Monsoon drop',
                platform: 'instagram',
                format: 'single_image',
                stage: 'review',
                target_date: null,
                stage_entered_at: '2026-01-01T00:00:00Z',
                approved_by: null,
                approved_at: null,
                thumbnailAssetVersionId: null,
                firstMedia: null,
                mediaCount: 0,
                hasVideo: false,
              } as never,
              approverName: null,
            },
          ]}
          side="agency"
          timeZone="UTC"
        />
      </MemoryRouter>,
    );
    const cards = [
      // The list's first element is its group; the card is its first child.
      live.replace(/^<div[^>]*>/, ''),
      renderToStaticMarkup(<NotVisibleCard />),
      renderToStaticMarkup(<PostCardSkeleton platform="instagram" />),
      renderToStaticMarkup(<CouldntLoadCard onRetry={() => {}} icon={IconPipeline} />),
    ];
    for (const html of cards) {
      expect(html).toContain('data-chat-card=""');
      expect(outer(html)).toContain('rounded-xl');
      expect(outer(html)).not.toContain('rounded-lg');
    }
  });

  it('chat plan card and its skeleton', () => {
    const plan = renderToStaticMarkup(
      <PlanCardBody
        view={{ kind: 'unavailable' }}
        side="agency"
        onOpen={() => {}}
        onForward={() => {}}
      />,
    );
    const box = renderToStaticMarkup(<PlanCardSkeleton />);
    for (const html of [plan, box]) {
      expect(outer(html)).toContain('rounded-xl');
      expect(outer(html)).not.toContain('rounded-lg');
    }
  });
});
