import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PostCardProps } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

// The board card is rendered to static markup (node SSR, no DOM dependency):
// useState initializers run (so a warm cache.peek hit shows the image) while
// effects do not, which is exactly the lazy/off-screen state. The presign gate
// is asserted via the spy counts on the injected cache.

function makePost(overrides: Partial<PipelinePost>): PipelinePost {
  return {
    id: 'p1',
    title: 'Post title',
    platform: 'instagram',
    format: 'text',
    caption: null,
    target_date: null,
    stage: 'draft',
    origin: 'manual',
    bucket_id: null,
    brief_id: null,
    owner_user_id: 'u1',
    created_by: 'u1',
    workspace_id: 'w1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    stage_entered_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
    ...overrides,
  };
}

function makeCache(peekUrl: string | null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  return { cache: { peek, resolve } as unknown as PresignCache, peek, resolve };
}

function render(props: Pick<PostCardProps, 'post' | 'cache' | 'presignEnabled'>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard {...props} />
    </MemoryRouter>,
  );
}

describe('PostCard thumbnail frame', () => {
  it('(a) renders the presigned image when a thumbnail version is present and presign is enabled', () => {
    const { cache, peek } = makeCache('https://cdn.example/thumb.jpg');
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
      cache,
      presignEnabled: true,
    });
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(peek).toHaveBeenCalledWith('av1');
  });

  it('(b) renders a caption snippet for an imageless text post, and a glyph when the caption is empty', () => {
    const { cache } = makeCache(null);
    const withCaption = render({
      post: makePost({
        thumbnailAssetVersionId: null,
        format: 'text',
        caption: 'Launch day is here',
      }),
      cache,
      presignEnabled: true,
    });
    expect(withCaption).toContain('Launch day is here');
    expect(withCaption).toContain('italic');
    expect(withCaption).not.toContain('<img');

    const emptyCaption = render({
      post: makePost({ thumbnailAssetVersionId: null, format: 'text', caption: '   ' }),
      cache,
      presignEnabled: true,
    });
    expect(emptyCaption).not.toContain('italic');
    expect(emptyCaption).toContain('<svg');
    expect(emptyCaption).not.toContain('<img');
  });

  it('(c) renders the fallback glyph for a non-text post with no thumbnail', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ thumbnailAssetVersionId: null, format: 'video', caption: null }),
      cache,
      presignEnabled: true,
    });
    expect(out).toContain('<svg');
    expect(out).not.toContain('<img');
  });

  it('(d) never touches the cache and shows the fallback tile when presign is disabled', () => {
    const { cache, peek, resolve } = makeCache('https://cdn.example/thumb.jpg');
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
      cache,
      presignEnabled: false,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).toContain('<svg');
  });

  it('(structural) chip row wraps/clips and the platform + format chips carry shrink + truncate', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ platform: 'instagram', format: 'single_image', target_date: null }),
      cache,
      presignEnabled: true,
    });
    // The chip row may shrink to its grid column and wraps instead of overflowing.
    expect(out).toContain('flex min-w-0 flex-wrap items-center gap-1.5');
    // Each display chip can shrink and truncates rather than forcing the card wider.
    // Two chips (platform + format) both carry the constraint.
    const chipMatches = out.match(/min-w-0 shrink truncate/g) ?? [];
    expect(chipMatches.length).toBe(2);
    // The card root can shrink to its track and clips any residual overflow.
    expect(out).toContain('min-w-0');
    expect(out).toContain('overflow-hidden');
  });

  it('shows the carousel badge on a carousel post', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ thumbnailAssetVersionId: null, format: 'carousel', caption: null }),
      cache,
      presignEnabled: true,
    });
    expect(out).toContain('aria-label="Carousel"');
  });
});
