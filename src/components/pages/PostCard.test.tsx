import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard, cardDue, postCardHref } from '@/components/pages/PostCard';
import type { PostCardProps } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

// The Pipeline card (ui/ListCard) is rendered to static markup (node SSR, no DOM dependency):
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

function renderWith(props: Partial<PostCardProps> & Pick<PostCardProps, 'post'>): string {
  const { cache } = makeCache(null);
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard cache={cache} presignEnabled={false} {...props} />
    </MemoryRouter>,
  );
}

/** The opening tag of the first element carrying `hook`. */
function tag(out: string, hook: string): string {
  return new RegExp(`<[a-z]+[^>]*${hook}[^>]*>`).exec(out)?.[0] ?? '';
}

/** The text of the first element carrying `hook` (no nested tags). */
function textOf(out: string, hook: string): string | undefined {
  return new RegExp(`<[a-z]+[^>]*${hook}[^>]*>([^<]*)<`).exec(out)?.[1];
}

const NOW = new Date('2026-10-23T12:00:00Z');

describe('PostCard is ui/ListCard', () => {
  it('renders the ListCard frame with the post hooks on its root, no hand-built frame', () => {
    const out = renderWith({ post: makePost({}) });
    const root = tag(out, 'data-list-card=""');
    expect(root).toContain('data-post-id="p1"');
    // The induction anchors stay on the card root.
    expect(root).toContain('data-induction="pipeline-post-row"');
    expect(root).toContain('data-induction-post="p1"');
    expect(out).not.toContain('data-card=""');
    // The whole card is one button that opens the post.
    expect(out).toContain('aria-label="Open post Post title"');
    expect(tag(out, 'data-list-card-press=""')).toContain('<button');
  });

  it('never shows a KEY-N code, in every stage and format', () => {
    for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected']) {
      for (const format of ['text', 'carousel', 'reel']) {
        const out = renderWith({
          post: makePost({ number: 12, stage, format, title: 'Launch teaser' }),
          workspaceKey: 'gbl',
          viewer: { role: 'agency', approverFirstNames: ['Maya'] },
        });
        expect(out).toContain('Launch teaser');
        expect(out).not.toContain('GBL-12');
        expect(out.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
        expect(out).not.toMatch(/aria-label="[^"]*\b[A-Z]{2,}-\d+\b/);
      }
    }
  });
});

describe('PostCard picture', () => {
  it('renders the small copy when a thumbnail version is present and presign is enabled', () => {
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
    expect(tag(out, 'data-list-card-picture="image"')).toContain('data-post-card-thumb=""');
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).not.toContain('full.jpg');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
  });

  it('a text post (or a photo post with no upload yet) shows the "Aa" placeholder', () => {
    for (const format of ['text', 'single_image']) {
      const out = renderWith({ post: makePost({ thumbnailAssetVersionId: null, format }) });
      expect(out).toContain('data-list-card-picture="placeholder"');
      expect(out).toContain('data-post-placeholder="text"');
      expect(out).toContain('>Aa<');
      expect(out).not.toContain('data-post-card-thumb');
      expect(out).not.toContain('<img');
    }
  });

  it('a video with no poster shows the play placeholder', () => {
    for (const format of ['video', 'reel']) {
      const out = renderWith({ post: makePost({ thumbnailAssetVersionId: null, format }) });
      expect(tag(out, 'data-list-card-picture="placeholder"')).toContain('data-post-card-play=""');
      expect(out).toContain('data-post-placeholder="video"');
      expect(out).not.toContain('<img');
    }
    // A text-format post whose first media is a video reads as video too.
    const fromCover = renderWith({
      post: makePost({ format: 'text' }),
      cover: { assetVersionId: 'av2', kind: 'video', width: 1080, height: 1920 },
    });
    expect(fromCover).toContain('data-post-placeholder="video"');
  });

  it('never touches the cache and shows the placeholder tile when presign is disabled', () => {
    const { cache, peek, resolve } = makeCache('https://cdn.example/thumb.jpg');
    const out = render({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'single_image' }),
      cache,
      presignEnabled: false,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).toContain('data-post-placeholder="text"');
  });

  it('keeps the carousel badge and the play badge on a poster', () => {
    expect(
      renderWith({ post: makePost({ thumbnailAssetVersionId: 'av1', format: 'carousel' }) }),
    ).toContain('aria-label="Carousel"');
    const video = renderWith({
      post: makePost({ thumbnailAssetVersionId: 'av1', format: 'video' }),
    });
    expect(video).toContain('data-post-card-thumb');
    expect(video).not.toContain('data-post-card-play');
    expect(video).toContain('aria-label="Video"');
  });
});

describe('PostCard lines', () => {
  it('line 1 is the title; line 2 carries the stage tag (grey, with its stage dot)', () => {
    for (const [stage, label] of [
      ['draft', 'Draft'],
      ['review', 'Review'],
      ['approved', 'Approved'],
      ['parked', 'Parked'],
      ['rejected', 'Rejected'],
    ] as const) {
      const out = renderWith({ post: makePost({ stage }) });
      expect(textOf(out, 'data-list-card-title=""')).toBe('Post title');
      expect(tag(out, 'data-list-card-tag=""')).toContain(`data-post-card-stage="${stage}"`);
      const line2 = out.slice(out.indexOf('data-list-card-line="2"'));
      expect(line2).toContain(`>${label}<`);
      expect(out).not.toContain('data-list-card-line="3"');
    }
  });

  it('with no status line the caption is line 2 (one line, plain text)', () => {
    const out = renderWith({ post: makePost({ caption: 'Launch day is **here**' }) });
    const preview = tag(out, 'data-list-card-preview=""');
    expect(preview).toContain('data-post-card-caption=""');
    expect(preview).toContain('truncate');
    expect(preview).not.toContain('line-clamp-2');
    // Captions never format: the stars stay as typed.
    expect(textOf(out, 'data-list-card-preview=""')).toBe('Launch day is **here**');
    // A blank caption leaves the preview empty.
    expect(renderWith({ post: makePost({ caption: '  ' }) })).not.toContain(
      'data-post-card-caption',
    );
  });

  it('a review card reads "With <name> · <ago> · caption" on one line', () => {
    const out = renderWith({
      post: makePost({
        stage: 'review',
        caption: 'Linen that breathes.',
        stage_entered_at: '2026-10-23T09:00:00Z',
      }),
      viewer: { role: 'agency', approverFirstNames: ['Maya'] },
      now: NOW,
    });
    const preview = out.slice(out.indexOf('data-list-card-preview'));
    expect(textOf(preview, 'data-post-card-status="with"')).toBe('With Maya · 3h');
    expect(textOf(preview, 'data-post-card-caption=""')).toBe('Linen that breathes.');
    const text = preview.slice(0, preview.indexOf('</span></span>')).replace(/<[^>]*>/g, '');
    expect(text).toContain('With Maya · 3h · Linen that breathes.');
    // Inline spans in the one truncated preview line, never stacked blocks.
    expect(out).not.toContain('block truncate');
    // An approver: "Waiting on you".
    const mine = renderWith({
      post: makePost({ stage: 'review' }),
      viewer: { role: 'client', approverFirstNames: [] },
      now: NOW,
    });
    expect(textOf(mine, 'data-post-card-status="you"')).toBe('Waiting on you');
    // While the role loads there is no status line yet: the caption alone.
    const pending = renderWith({
      post: makePost({ stage: 'review', caption: 'Hello' }),
      viewer: { role: null, approverFirstNames: [], pending: true },
      now: NOW,
    });
    expect(pending).not.toContain('data-post-card-status');
    expect(textOf(pending, 'data-list-card-preview=""')).toBe('Hello');
  });

  it('line 1 time: the due words (formatDue) on the ListCard time slot, never "Due"', () => {
    const out = renderWith({ post: makePost({ target_date: '2026-11-02' }), now: NOW });
    const due = tag(out, 'data-post-card-due=""');
    expect(due).toContain('data-list-card-time=""');
    expect(due).toContain('font-mono');
    expect(due).not.toContain('text-bad');
    expect(textOf(out, 'data-post-card-due=""')).toBe('2 Nov');
    expect(out).not.toMatch(/>Due /);
    // The time sits on line 1 with the title.
    const line1 = out.slice(
      out.indexOf('data-list-card-line="1"'),
      out.indexOf('data-list-card-line="2"'),
    );
    expect(line1).toContain('data-post-card-due');
    // No due date: no time.
    expect(renderWith({ post: makePost({}), now: NOW })).not.toContain('data-list-card-time');
  });

  it('due words: Today, Tomorrow, a weekday, then the date', () => {
    expect(cardDue('2026-10-23', 'review', 'UTC', NOW)).toEqual({ text: 'Today', overdue: false });
    expect(cardDue('2026-10-24', 'review', 'UTC', NOW)).toEqual({
      text: 'Tomorrow',
      overdue: false,
    });
    // Monday 2 Nov 2026: Friday 6 Nov reads its weekday.
    expect(cardDue('2026-11-06', 'draft', 'UTC', new Date('2026-11-02T12:00:00Z'))).toEqual({
      text: 'Fri',
      overdue: false,
    });
    expect(cardDue('2026-11-12', 'review', 'UTC', NOW)).toEqual({
      text: '12 Nov',
      overdue: false,
    });
    expect(cardDue('2026-12-12', 'review', 'UTC', NOW)).toEqual({
      text: '12 Dec',
      overdue: false,
    });
  });

  it('a past due date reads late in the bad tone; approved is never late', () => {
    expect(cardDue('2026-10-22', 'review', 'UTC', NOW)).toEqual({
      text: '1d late',
      overdue: true,
    });
    expect(cardDue('2026-10-21', 'review', 'UTC', NOW)).toEqual({
      text: '2d late',
      overdue: true,
    });
    expect(cardDue('2026-10-12', 'draft', 'UTC', NOW)).toEqual({
      text: '1w late',
      overdue: true,
    });
    expect(cardDue('2026-05-20', 'draft', 'UTC', NOW)).toEqual({
      text: '5mo late',
      overdue: true,
    });
    expect(cardDue('2026-10-12', 'approved', 'UTC', NOW)).toEqual({
      text: '12 Oct',
      overdue: false,
    });
    expect(cardDue('not a date', 'review', 'UTC', NOW)).toEqual({ text: '', overdue: false });

    const out = renderWith({
      post: makePost({ stage: 'review', target_date: '2026-10-12' }),
      timeZone: 'UTC',
      now: NOW,
    });
    const due = tag(out, 'data-post-card-due="overdue"');
    expect(due).toContain('text-bad');
    expect(due).toContain('data-list-card-time-bad=""');
    expect(textOf(out, 'data-post-card-due="overdue"')).toBe('1w late');
    expect(out).not.toContain('Overdue');
    // Approved: the date, never the bad tone.
    const approved = renderWith({
      post: makePost({ stage: 'approved', target_date: '2026-10-12' }),
      timeZone: 'UTC',
      now: NOW,
    });
    expect(approved).not.toContain('data-list-card-time-bad');
    expect(textOf(approved, 'data-post-card-due=""')).toBe('12 Oct');
  });
});

describe('PostCard has no ⋮', () => {
  it('no menu trigger, no ActionMenu, no menu gesture', () => {
    const out = renderWith({
      post: makePost({}),
      viewer: { role: 'agency', approverFirstNames: [] },
    });
    expect(out).not.toContain('data-post-card-move');
    expect(out).not.toContain('data-post-card-menu');
    expect(out).not.toContain('data-list-card-more');
    expect(out).not.toContain('Actions for');
    const src = readFileSync(fileURLToPath(new URL('./PostCard.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/ActionMenu|useMenuGesture|onMove/);
  });

  it('select mode: the tick shows on the picture and the chosen card is lit-selected', () => {
    const select = { active: true, chosen: true, onEnter: () => {}, onToggle: () => {} };
    const out = renderWith({ post: makePost({}), select });
    expect(out).toContain('data-list-card-selecting=""');
    expect(out).toContain('data-list-card-tick="on"');
    expect(tag(out, 'data-list-card=""')).toContain('lit-selected');
    // Without select mode: no tick at all.
    expect(renderWith({ post: makePost({}) })).not.toContain('data-list-card-tick');
  });

  it('the open link: /p/KEY-N, else /posts/:id', () => {
    expect(postCardHref({ id: 'p1', number: 7 }, 'gbl')).toBe('/p/gbl-7');
    expect(postCardHref({ id: 'p1', number: 7 }, null)).toBe('/posts/p1');
  });

  it('PostCard hands its slots to ListCard and builds no frame of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('./PostCard.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('<ListCard');
    expect(src).not.toMatch(/rounded-xl|lit-card|\bborder\b|<Card\b/);
  });
});
