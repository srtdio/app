import { afterEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
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

// Unread comments on the Pipeline card (ui/ListCard, 7 Nov 2026): line 1's
// unread dot, and the count in the ⋮ trigger's name ("Actions for {title}, 3
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
        onMove={() => undefined}
        now={new Date('2026-11-05T00:00:00Z')}
      />
    </MemoryRouter>,
  );
}

/** The ⋮ trigger's aria-label. */
const menuLabel = (html: string): string =>
  /<button[^>]*aria-label="([^"]*)"[^>]*data-post-card-move=""/.exec(html)?.[1] ??
  /<button[^>]*data-post-card-move=""[^>]*aria-label="([^"]*)"/.exec(html)?.[1] ??
  '';

afterEach(() => {
  resetUnreadEntitiesForTest();
  resetSessionReads();
});

describe('PostCard unread comments', () => {
  it('the unread dot on line 1 and the count in the ⋮ name', () => {
    const html = render({ 'post:p1': 3 });
    expect(html).toContain('data-list-card-unread=""');
    expect(html).toContain('data-post-card-unread="3"');
    expect(menuLabel(html)).toBe('Actions for Post title, 3 unread comments');
    // The count is never painted: no count pill on the card.
    expect(html).not.toContain('data-count-badge');
  });

  it('no dot and a plain ⋮ name with no unread comments, or for another post', () => {
    for (const map of [{}, { 'post:other': 2 }, { 'plan_item:p1': 2 }]) {
      const html = render(map);
      expect(html).not.toContain('data-list-card-unread');
      expect(html).not.toContain('data-post-card-unread');
      expect(menuLabel(html)).toBe('Actions for Post title');
    }
  });

  it('one unread comment reads singular', () => {
    expect(menuLabel(render({ 'post:p1': 1 }))).toBe('Actions for Post title, 1 unread comment');
  });

  it('works on a media card too', () => {
    const html = render(
      { 'post:p1': 1 },
      post({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
    );
    expect(html).toContain('data-list-card-unread=""');
    expect(menuLabel(html)).toBe('Actions for Post title, 1 unread comment');
  });
});
