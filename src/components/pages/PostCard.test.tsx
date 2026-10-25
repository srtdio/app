import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard, cardDue } from '@/components/pages/PostCard';
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

  it('(b) a text-only post has no cover box: the card starts at the title', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({
        thumbnailAssetVersionId: null,
        format: 'text',
        caption: 'Launch day is here',
      }),
      cache,
      presignEnabled: true,
    });
    expect(out).not.toContain('data-post-card-thumb');
    expect(out).not.toContain('data-post-card-play');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('bg-panel-3');
    // The title is the card's first content; the caption reads under it.
    expect(out.indexOf('data-post-card-title')).toBeLessThan(out.indexOf('data-post-card-caption'));
    expect(out).toContain('Launch day is here');
    // A single image post with no upload yet is no-media too: no grey box.
    const noUpload = render({
      post: makePost({ thumbnailAssetVersionId: null, format: 'single_image' }),
      cache,
      presignEnabled: true,
    });
    expect(noUpload).not.toContain('data-post-card-thumb');
  });

  it('(c) a video with no poster shows a centred play glyph on bg-panel-3 at the fixed ratio', () => {
    const { cache } = makeCache(null);
    for (const format of ['video', 'reel']) {
      const out = render({
        post: makePost({ thumbnailAssetVersionId: null, format, caption: null }),
        cache,
        presignEnabled: true,
      });
      const box = /<div[^>]*data-post-card-play=""[^>]*>/.exec(out)?.[0] ?? '';
      expect(box).toContain('bg-panel-3');
      expect(box).toContain('items-center justify-center');
      // Instagram's one fixed box (4:5), the same for a reel as for a photo.
      expect(box).toContain('aspect-ratio:0.8');
      expect(out).toContain('aria-label="Video"');
      expect(out).not.toContain('<img');
    }
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

  it('(structural) the meta line is a single fixed-height row with no format glyph and no platform mark', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ platform: 'instagram', format: 'single_image', target_date: null }),
      cache,
      presignEnabled: true,
    });
    // One non-wrapping meta row replaces the old two-chip stack.
    const meta = /<div[^>]*data-post-card-meta=""[^>]*>(.*?)<\/div>/.exec(out);
    expect(meta?.[0]).toContain('flex h-5 min-w-0 items-center gap-1.5');
    expect(out).not.toContain('flex-wrap');
    expect(out).not.toContain('min-w-0 shrink truncate');
    // The workspace has one platform: the card carries no platform mark.
    expect(out).not.toContain('aria-label="instagram"');
    // The format shows once, on the picture: the meta row holds no glyph.
    expect(meta?.[1] ?? '').not.toContain('<svg');
    // The card root can shrink to its track. It does not clip (the laptop ⋯
    // popover opens past its edge); the picture clips to the top corners itself.
    expect(out).toContain('min-w-0');
    expect(out).toContain('class="relative flex h-full min-w-0 flex-col rounded-xl');
  });

  it('renders the target date on the meta line when present', () => {
    const { cache } = makeCache(null);
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <PostCard
          post={makePost({ target_date: '2026-03-15', format: 'single_image' })}
          cache={cache}
          presignEnabled
          now={new Date('2026-03-01T00:00:00Z')}
        />
      </MemoryRouter>,
    );
    expect(out).toContain('tabular-nums');
    // The due line reads "Due {d MMM}", day first, no year.
    expect(out).toContain('Due 15 Mar');
    expect(out).toContain('data-post-card-due');
  });

  it('shows the carousel badge on a carousel post', () => {
    const { cache } = makeCache(null);
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'carousel', caption: null }),
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
    expect(out).toContain(
      '<div data-post-card-thumb="" class="pointer-events-none overflow-hidden rounded-t-xl"><div',
    );
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

  it('fix 1: a card with onMove carries a 44x44 ⋯ (the ActionMenu trigger) above the open overlay', () => {
    const out = renderWith({ post: makePost({}), onMove: () => {} });
    expect(out).toContain('aria-label="More actions for Post title"');
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

describe('E: Pipeline card polish', () => {
  function renderWith(props: Partial<PostCardProps> & Pick<PostCardProps, 'post'>): string {
    const { cache } = makeCache(null);
    return renderToStaticMarkup(
      <MemoryRouter>
        <PostCard cache={cache} presignEnabled={false} {...props} />
      </MemoryRouter>,
    );
  }
  const NOW = new Date('2026-10-23T12:00:00Z');

  it('the ⋯ is a plain glyph at the right end of the due row, never on the picture', () => {
    const out = renderWith({
      post: makePost({
        target_date: '2026-11-02',
        format: 'carousel',
        thumbnailAssetVersionId: 'av1',
      }),
      onMove: () => {},
      now: NOW,
    });
    const metaAt = out.indexOf('data-post-card-meta');
    const dueAt = out.indexOf('data-post-card-due');
    const moveAt = out.indexOf('data-post-card-move');
    expect(metaAt).toBeGreaterThan(-1);
    expect(dueAt).toBeGreaterThan(metaAt);
    // The ⋯ comes after the due text, pushed to the row's right end.
    expect(moveAt).toBeGreaterThan(dueAt);
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    const menu = /<div[^>]*data-post-card-menu=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(menu).toContain('ml-auto');
    expect(button).toContain('h-11 w-11');
    expect(button).toContain('-my-3');
    expect(button).toContain('text-fg-3');
    // No resting fill (the shared IconButton only tints on hover).
    expect(button).not.toMatch(/[\s"]bg-/);
    // Nothing of it on the picture; the carousel badge stays there.
    const thumb = out.slice(
      out.indexOf('data-post-card-thumb'),
      out.indexOf('data-post-card-body'),
    );
    expect(thumb).not.toContain('data-post-card-move');
    expect(thumb).toContain('aria-label="Carousel"');
  });

  it('a past due date reads overdue in the bad tone, on one line that never wraps', () => {
    expect(cardDue('2026-10-12', 'review', 'UTC', NOW)).toEqual({
      text: 'Overdue · 12 Oct',
      overdue: true,
    });
    expect(cardDue('2026-05-20', 'draft', 'UTC', NOW)).toEqual({
      text: 'Overdue 5 months',
      overdue: true,
    });
    // Today and ahead stay a due line; an approved post is done, never overdue.
    expect(cardDue('2026-10-23', 'review', 'UTC', NOW)).toEqual({
      text: 'Due 23 Oct',
      overdue: false,
    });
    expect(cardDue('2026-11-02', 'review', 'UTC', NOW)).toEqual({
      text: 'Due 2 Nov',
      overdue: false,
    });
    expect(cardDue('2026-10-12', 'approved', 'UTC', NOW).overdue).toBe(false);

    const out = renderWith({
      post: makePost({ stage: 'review', target_date: '2026-10-12' }),
      now: NOW,
    });
    const due = /<span[^>]*data-post-card-due="overdue"[^>]*>([^<]*)<\/span>/.exec(out);
    expect(due?.[1]).toBe('Overdue · 12 Oct');
    expect(due?.[0]).toContain('text-bad');
    expect(due?.[0]).toContain('truncate');
    expect(due?.[0]).toContain('whitespace-nowrap');
    const upcoming = renderWith({ post: makePost({ target_date: '2026-11-02' }), now: NOW });
    expect(upcoming).not.toContain('text-bad');
  });

  it('the review status line shows the dot and "4 months ago" only; the full phrase is its title and aria-label', () => {
    const out = renderWith({
      post: makePost({ stage: 'review', stage_entered_at: '2026-06-15T12:00:00Z' }),
      viewer: { role: 'agency', approverFirstNames: ['Meera', 'Arjun'] },
      now: NOW,
    });
    const line = /<div[^>]*data-post-card-status="with"[^>]*>(.*?)<\/div>/.exec(out);
    expect(line?.[0]).toContain('title="With approvers · 4 months ago"');
    expect(line?.[0]).toContain('aria-label="With approvers · 4 months ago"');
    expect(line?.[1]).toContain('bg-stage-review');
    expect(line?.[1]).toContain('>4 months ago</span>');
    expect(line?.[1]).not.toContain('With approvers');
  });

  it('every card fills its grid cell and the title holds two lines', () => {
    const out = renderWith({ post: makePost({}) });
    expect(out).toContain('relative flex h-full min-w-0 flex-col');
    const title = /<div[^>]*data-post-card-title=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(title).toContain('line-clamp-2');
    expect(title).toContain('min-h-[2.75em]');
    const body = /<div[^>]*data-post-card-body=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(body).toContain('flex-1');
  });

  it('in a kanban column the card never repeats the stage name or its dot', () => {
    const viewer = { role: 'agency', approverFirstNames: [] };
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected']) {
      const out = renderWith({
        post: makePost({ stage }),
        inColumn: true,
        showStage: true,
        viewer,
      });
      expect(out).not.toContain('data-post-card-stage');
      expect(out).not.toContain(`bg-stage-${stage}`);
    }
    // Outside a column the review status line keeps its dot.
    const free = renderWith({ post: makePost({ stage: 'review' }), viewer });
    expect(free).toContain('bg-stage-review');
  });

  it('a review card holds its status line height while the role loads', () => {
    const pending = renderWith({
      post: makePost({ stage: 'review' }),
      viewer: { role: null, approverFirstNames: [], pending: true },
    });
    expect(pending).toMatch(
      /<div aria-hidden="true" data-post-card-status-pending="" class="h-4"><\/div>/,
    );
    const status = renderWith({
      post: makePost({ stage: 'review' }),
      viewer: { role: 'agency', approverFirstNames: [] },
    });
    expect(status).toContain('data-post-card-status="with"');
    expect(status).not.toContain('data-post-card-status-pending');
    // Only review cards carry a status line, so only they reserve one.
    const draft = renderWith({
      post: makePost({ stage: 'draft' }),
      viewer: { role: null, approverFirstNames: [], pending: true },
    });
    expect(draft).not.toContain('data-post-card-status-pending');
  });
});

describe('Pipeline polish: one fixed cover box per platform', () => {
  function renderWith(props: Partial<PostCardProps> & Pick<PostCardProps, 'post'>): string {
    const { cache } = makeCache(null);
    return renderToStaticMarkup(
      <MemoryRouter>
        <PostCard cache={cache} presignEnabled={false} {...props} />
      </MemoryRouter>,
    );
  }
  function box(out: string): string {
    const at = out.indexOf('data-post-card-thumb');
    return /<div[^>]*>/.exec(out.slice(out.indexOf('<div', at + 1)))?.[0] ?? '';
  }

  it('portrait and landscape media get the same cover box', () => {
    const post = makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' });
    const portrait = renderWith({
      post,
      cover: { assetVersionId: 'av1', kind: 'image', width: 1080, height: 1350 },
    });
    const landscape = renderWith({
      post,
      cover: { assetVersionId: 'av1', kind: 'image', width: 3000, height: 1000 },
    });
    const video = renderWith({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'reel' }),
      cover: { assetVersionId: 'av2', kind: 'video', width: 1080, height: 1920 },
    });
    expect(box(portrait)).toContain('aspect-ratio:0.8');
    expect(box(landscape)).toBe(box(portrait));
    expect(box(video)).toBe(box(portrait));
  });

  it('a video post with a poster keeps the picture and its play badge', () => {
    const out = renderWith({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'video' }),
    });
    expect(out).toContain('data-post-card-thumb');
    expect(out).not.toContain('data-post-card-play');
    expect(out).toContain('aria-label="Video"');
  });
});
