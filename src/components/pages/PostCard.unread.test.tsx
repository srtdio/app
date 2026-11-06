import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Unread comment marker on the Pipeline card (5 Nov 2026): the foot meta line
// shows the comment glyph and the shared CountBadge after the due reading and
// before the ⋯, only when the viewer has unread comments on that post.

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

const meta = (html: string): string => {
  const at = html.indexOf('data-card-header');
  return at < 0 ? '' : html.slice(at);
};

afterEach(() => {
  resetUnreadEntitiesForTest();
  resetSessionReads();
});

describe('PostCard unread comment marker', () => {
  it('shows the glyph and the count pill in the Card footer, after the ⋯ and the due', () => {
    const line = meta(render({ 'post:p1': 3 }));
    expect(line).toContain('data-post-card-unread="3"');
    expect(line).toContain('aria-label="3 unread comments"');
    expect(line).toContain('data-count-badge=""');
    expect(line.indexOf('data-post-card-due')).toBeLessThan(line.indexOf('data-post-card-unread'));
    expect(line.indexOf('data-post-card-move')).toBeLessThan(line.indexOf('data-post-card-due'));
    expect(line.indexOf('data-card-footer')).toBeLessThan(line.indexOf('data-post-card-unread'));
  });

  it('nothing renders with no unread comments, or for another post', () => {
    expect(render({})).not.toContain('data-post-card-unread');
    expect(render({ 'post:other': 2 })).not.toContain('data-post-card-unread');
    expect(render({ 'plan_item:p1': 2 })).not.toContain('data-post-card-unread');
  });

  it('caps at 99+ through the shared badge', () => {
    expect(render({ 'post:p1': 140 })).toContain('99+');
  });

  it('works on a media card too', () => {
    const html = render(
      { 'post:p1': 1 },
      post({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
    );
    expect(html).toContain('aria-label="1 unread comment"');
  });

  it('the marker sits in the Card footer trailing slot (never shrinks)', () => {
    const src = readFileSync(fileURLToPath(new URL('./PostCard.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('footerTrailing: unread');
    expect(src).toContain('className="inline-flex items-center gap-1 text-fg"');
  });
});
