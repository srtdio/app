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
    number: 1,
    title: 'Post title',
    platform: 'instagram',
    format: 'text',
    caption: null,
    target_date: null,
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

  it('(b) the imageless text tile shows the caption, falling back to the title when blank', () => {
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
    // The format-aware tile carries the body snippet (the caption) and the glyph
    // eyebrow, never an <img>.
    expect(withCaption).toContain('Launch day is here');
    expect(withCaption).toContain('<svg');
    expect(withCaption).not.toContain('<img');

    // A blank caption falls back to the title as the body, so the tile is never
    // a lone glyph for a titled post.
    const emptyCaption = render({
      post: makePost({
        thumbnailAssetVersionId: null,
        format: 'text',
        caption: '   ',
        title: 'Post title',
      }),
      cache,
      presignEnabled: true,
    });
    expect(emptyCaption).toContain('Post title');
    expect(emptyCaption).toContain('<svg');
    expect(emptyCaption).not.toContain('<img');
  });

  it('(c) renders the format-aware media tile for a video post with no thumbnail', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ thumbnailAssetVersionId: null, format: 'video', caption: null }),
      cache,
      presignEnabled: true,
    });
    // The video glyph tile, body falling back to the title; no <img>, no poster
    // play badge (gated on a thumbnail, which this post has none of).
    expect(out).toContain('<svg');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('aria-label="Video"');
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

  it('(structural) the meta line is a single row: platform mark + format glyph, no two-pill stack', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ platform: 'instagram', format: 'single_image', target_date: null }),
      cache,
      presignEnabled: true,
    });
    // One non-wrapping meta row replaces the old two-chip stack.
    expect(out).toContain('flex items-center gap-1.5');
    expect(out).not.toContain('flex-wrap');
    expect(out).not.toContain('min-w-0 shrink truncate');
    // The platform mark badge carries the platform as its accessible label.
    expect(out).toContain('aria-label="instagram"');
    // A format glyph (svg) sits beside it.
    expect(out).toContain('<svg');
    // The card root can shrink to its track and clips any residual overflow.
    expect(out).toContain('min-w-0');
    expect(out).toContain('overflow-hidden');
  });

  it('renders the target date on the meta line when present', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ target_date: '2026-03-15', format: 'single_image' }),
      cache,
      presignEnabled: true,
    });
    expect(out).toContain('tabular-nums');
    // The localised date string contains the year; exact format is locale-driven.
    expect(out).toContain('2026');
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

  it('shows the play badge on a video post that has a poster thumbnail', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'video', caption: null }),
      cache,
      presignEnabled: false,
    });
    expect(out).toContain('aria-label="Video"');
  });
});
