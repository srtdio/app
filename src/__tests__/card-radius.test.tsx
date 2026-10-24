import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
import { CARD_SKELETON, CouldntLoadCard, POST_CARD, SHARED_CARD } from '@/components/chat/PostCard';
import { PLAN_CARD, PLAN_CARD_SKELETON } from '@/components/chat/PlanCard';

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
    expect(html).toMatch(/class="flex overflow-hidden rounded-xl border/);
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

  it('chat post card: the frame, the shared row, the skeleton and the retry card', () => {
    for (const cls of [POST_CARD, SHARED_CARD, CARD_SKELETON]) {
      expect(cls.split(' ')).toContain('rounded-xl');
      expect(cls.split(' ')).not.toContain('rounded-lg');
    }
    const retry = renderToStaticMarkup(<CouldntLoadCard onRetry={() => {}} />);
    expect(outer(retry)).toContain('rounded-xl');
    expect(outer(retry)).not.toContain('rounded-lg');
  });

  it('chat plan card and its skeleton', () => {
    for (const cls of [PLAN_CARD, PLAN_CARD_SKELETON]) {
      expect(cls.split(' ')).toContain('rounded-xl');
      expect(cls.split(' ')).not.toContain('rounded-lg');
    }
  });
});
