import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import { resetSessionReads } from '@/lib/session-read';
import {
  resetUnreadEntitiesForTest,
  seedUnreadEntitiesForTest,
  type UnreadEntities,
} from '@/lib/inbox/unread-entities';
import type { PipelinePost } from '@srtdio/posts';

// Unread comments on the Pipeline card (ui/ListCard, two lines): line 2's
// unread dot, and the count in the card's open name ("Open post {title}, 3
// unread comments"), only when the viewer has unread comments on that post.

const CACHE = {
  peek: () => null,
  resolve: async () => ({ url: 'x', expiresAt: Date.now() + 3_600_000 }),
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

function post(over: Partial<PipelinePost> = {}): PipelinePost {
  return {
    id: 'p1',
    number: 1,
    title: 'Post title',
    platform: 'instagram',
    format: 'text',
    caption: null,
    target_date: '2026-11-08T00:00:00Z',
    stage: 'review',
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
    ...over,
  };
}

function render(map: UnreadEntities, p: PipelinePost = post()): string {
  seedUnreadEntitiesForTest({ userId: 'u1', workspaceId: 'w1', map });
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard
        post={p}
        cache={CACHE}
        presignEnabled={false}
        now={new Date('2026-11-05T00:00:00Z')}
      />
    </MemoryRouter>,
  );
}

/** The whole-card open button's aria-label. */
const openLabel = (html: string): string =>
  /<button[^>]*aria-label="([^"]*)"[^>]*data-list-card-press=""/.exec(html)?.[1] ??
  /<button[^>]*data-list-card-press=""[^>]*aria-label="([^"]*)"/.exec(html)?.[1] ??
  '';

afterEach(() => {
  resetUnreadEntitiesForTest();
  resetSessionReads();
});

describe('PostCard unread comments', () => {
  it('the unread dot on line 2 and the count in the open name', () => {
    const html = render({ 'post:p1': 3 });
    expect(html).toContain('data-list-card-unread=""');
    expect(html).toContain('data-post-card-unread="3"');
    expect(openLabel(html)).toBe('Open post Post title, 3 unread comments');
    const line2 = html.slice(html.indexOf('data-list-card-line="2"'));
    expect(line2).toContain('data-list-card-unread=""');
    // The count is never painted: no count pill on the card.
    expect(html).not.toContain('data-count-badge');
  });

  it('no dot and a plain open name with no unread comments, or for another post', () => {
    for (const map of [{}, { 'post:other': 2 }, { 'plan_item:p1': 2 }]) {
      const html = render(map);
      expect(html).not.toContain('data-list-card-unread');
      expect(html).not.toContain('data-post-card-unread');
      expect(openLabel(html)).toBe('Open post Post title');
    }
  });

  it('one unread comment reads singular', () => {
    expect(openLabel(render({ 'post:p1': 1 }))).toBe('Open post Post title, 1 unread comment');
  });

  it('works on a media card too', () => {
    const html = render(
      { 'post:p1': 1 },
      post({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
    );
    expect(html).toContain('data-list-card-unread=""');
    expect(openLabel(html)).toBe('Open post Post title, 1 unread comment');
  });
});
