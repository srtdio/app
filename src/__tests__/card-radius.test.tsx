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
// thumbnails inside a card stay 8px (rounded-lg). List rows (ui/ListCard:
// Pipeline, Briefs, Activity) are the flat look (7 Nov 2026): no radius, no
// border, the density row (72 Cozy, 60 Compact, 80 Calm) bled 16 each side;
// their picture is rounded-picture (10).

/** A flat list row: no radius and no border on the frame; the h-18 row (compact:h-15, calm:h-20) bled -mx-4 / px-4. */
function expectFlatRow(cls: string[]): void {
  expect(cls).toEqual(expect.arrayContaining(['h-18', 'compact:h-15', 'calm:h-20']));
  expect(cls).toEqual(expect.arrayContaining(['-mx-4', 'px-4']));
  expect(cls.filter((c) => /^rounded/.test(c))).toEqual([]);
  expect(cls.filter((c) => /^border/.test(c))).toEqual([]);
  expect(cls.filter((c) => /^lit-/.test(c))).toEqual([]);
}

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

describe('cards use the 12px card radius; list rows are flat', () => {
  it('Pipeline post row (flat)', () => {
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
    expectFlatRow(outer(html));
  });

  it('Briefs list row (flat; its non-person picture is the rounded-picture squircle)', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief} cache={cache} presignEnabled={false} href="/briefs/b1" />
      </MemoryRouter>,
    );
    expectFlatRow(outer(html));
    expect(html).toMatch(/data-list-card-picture-box=""[^>]*class="[^"]*\brounded-picture\b/);
    expect(html).not.toMatch(/data-list-card-picture-box=""[^>]*class="[^"]*\brounded-lg\b/);
  });

  it('Activity row (flat)', () => {
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
        selfName={null}
      />,
    );
    // ui/ListCard: the flat row whether unread or read.
    const row = (/data-list-card="" class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
    expectFlatRow(row);
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
