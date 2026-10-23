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
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
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
  return {
    cache: {
      peek,
      resolve,
      peekThumbnail: () => null,
      thumbnail: async () => null,
    } as unknown as PresignCache,
    peek,
    resolve,
  };
}

function render(props: Pick<PostCardProps, 'post' | 'cache' | 'presignEnabled'>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard {...props} />
    </MemoryRouter>,
  );
}

describe('PostCard thumbnail frame', () => {
  it('(a) renders the small copy when a thumbnail version is present and presign is enabled', () => {
    const { cache: base } = makeCache('https://cdn.example/full.jpg');
    const peekThumbnail = vi.fn(() => ({
      url: 'https://cdn.example/thumb.jpg',
      expiresAt: Date.now() + 3_600_000,
    }));
    const cache = { ...base, peekThumbnail } as unknown as PresignCache;
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
      cache,
      presignEnabled: true,
    });
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).not.toContain('full.jpg');
    expect(out).toContain('object-cover');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
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
    // The plain format tile carries the body snippet (the caption) and the
    // format icon, never an <img> and never an uppercase format label.
    expect(withCaption).toContain('Launch day is here');
    expect(withCaption).toContain('<svg');
    expect(withCaption).not.toContain('<img');
    expect(withCaption).not.toContain('uppercase');
    expect(withCaption).not.toContain('bg-gradient-to-br');

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

  it('(structural) the meta line is a single row: format glyph only, no platform mark, no two-pill stack', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ platform: 'instagram', format: 'single_image', target_date: null }),
      cache,
      presignEnabled: true,
    });
    // One non-wrapping meta row replaces the old two-chip stack.
    expect(out).toContain('flex min-w-0 items-center gap-1.5');
    expect(out).not.toContain('flex-wrap');
    expect(out).not.toContain('min-w-0 shrink truncate');
    // The workspace has one platform: the card carries no platform mark.
    expect(out).not.toContain('aria-label="instagram"');
    // A format glyph (svg) sits on the row.
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
    // The due line reads "Due {d MMM}", day first, no year.
    expect(out).toContain('Due 15 Mar');
    expect(out).toContain('data-post-card-due');
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

  it('lets a tap on the thumbnail reach the Open post button underneath', () => {
    const { cache } = makeCache('https://cdn.example/thumb.jpg');
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
      cache,
      presignEnabled: true,
    });
    // The relative tile sits inside a pointer-events-none wrapper, after the
    // full-bleed absolute button, so the button still takes the tap.
    expect(out).toContain('<div data-post-card-thumb="" class="pointer-events-none"><div');
    expect(out.indexOf('aria-label="Open post Post title"')).toBeLessThan(
      out.indexOf('data-post-card-thumb'),
    );
    // The induction anchors stay on the card root.
    expect(out).toContain('data-induction="pipeline-post-row" data-induction-post="p1"');
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

describe('W4 PostCard fixes', () => {
  function renderWith(props: Partial<PostCardProps> & Pick<PostCardProps, 'post'>): string {
    const { cache } = makeCache(null);
    return renderToStaticMarkup(
      <MemoryRouter>
        <PostCard cache={cache} presignEnabled={false} {...props} />
      </MemoryRouter>,
    );
  }

  it('fix 1: a card with onMove carries a 44x44 move button (the ⋯) above the open overlay', () => {
    const out = renderWith({ post: makePost({}), onMove: () => {} });
    expect(out).toContain('aria-label="Move post Post title"');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    expect(button).toContain('z-10');
    // No onMove, no button.
    expect(renderWith({ post: makePost({}) })).not.toContain('data-post-card-move');
  });

  it('fix 5: showStage leads the meta line with the stage dot and label', () => {
    const out = renderWith({ post: makePost({ stage: 'review' }), showStage: true });
    expect(out).toContain('data-post-card-stage');
    expect(out).toContain('bg-stage-review');
    expect(out).toContain('Review');
    expect(renderWith({ post: makePost({ stage: 'review' }) })).not.toContain(
      'data-post-card-stage',
    );
  });

  it('fix 9: the title wraps to two lines instead of truncating', () => {
    const out = renderWith({ post: makePost({}) });
    const title = /<div[^>]*data-post-card-title=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(title).toContain('line-clamp-2');
    expect(title).not.toContain('truncate');
  });
});

describe('pipeline card shows no KEY-N code', () => {
  it('names the post by title only, with the workspace key known, in every stage and format', () => {
    const { cache } = makeCache(null);
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected']) {
      for (const format of ['text', 'carousel', 'reel']) {
        const out = renderToStaticMarkup(
          <MemoryRouter>
            <PostCard
              post={makePost({ number: 12, stage, format, title: 'Launch teaser' })}
              cache={cache}
              presignEnabled={false}
              workspaceKey="gbl"
              showStage
              onMove={() => {}}
            />
          </MemoryRouter>,
        );
        expect(out).toContain('Launch teaser');
        expect(out).not.toContain('GBL-12');
        expect(out.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
        expect(out).not.toMatch(/aria-label="[^"]*\b[A-Z]{2,}-\d+\b/);
      }
    }
  });
});
