import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard, cardDue, cardMenuLabel } from '@/components/pages/PostCard';
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
          onMove: () => {},
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
  it('line 1 is the title; the tag on line 3 is the stage label, grey', () => {
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
      const line3 = out.slice(out.indexOf('data-list-card-line="3"'));
      expect(line3).toContain(`>${label}<`);
    }
  });

  it('with no status line the caption takes line 2 (two lines, plain text)', () => {
    const out = renderWith({ post: makePost({ caption: 'Launch day is **here**' }) });
    const preview = tag(out, 'data-list-card-preview=""');
    expect(preview).toContain('data-post-card-caption=""');
    expect(preview).toContain('line-clamp-2');
    // Captions never format: the stars stay as typed.
    expect(textOf(out, 'data-list-card-preview=""')).toBe('Launch day is **here**');
    // A blank caption leaves line 2 empty.
    expect(renderWith({ post: makePost({ caption: '  ' }) })).not.toContain(
      'data-post-card-caption',
    );
  });

  it('a review card leads line 2 with the status line, then the caption on one line', () => {
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
    expect(textOf(preview, 'data-post-card-status="with"')).toBe('With Maya · 3 hours ago');
    expect(textOf(preview, 'data-post-card-caption=""')).toBe('Linen that breathes.');
    expect(tag(preview, 'data-post-card-caption=""')).toContain('truncate');
    expect(preview.indexOf('data-post-card-status')).toBeLessThan(
      preview.indexOf('data-post-card-caption'),
    );
    // An approver: "Waiting on you".
    const mine = renderWith({
      post: makePost({ stage: 'review' }),
      viewer: { role: 'client', approverFirstNames: [] },
      now: NOW,
    });
    expect(textOf(mine, 'data-post-card-status="you"')).toBe('Waiting on you');
    // While the role loads there is no status line yet; the card keeps its height.
    const pending = renderWith({
      post: makePost({ stage: 'review', caption: 'Hello' }),
      viewer: { role: null, approverFirstNames: [], pending: true },
      now: NOW,
    });
    expect(pending).not.toContain('data-post-card-status');
    expect(tag(pending, 'data-list-card-preview=""')).toContain('min-h-9');
  });

  it('line 3: the due time (formatDue) on the ListCard time slot', () => {
    const out = renderWith({ post: makePost({ target_date: '2026-11-02' }), now: NOW });
    const due = tag(out, 'data-post-card-due=""');
    expect(due).toContain('data-list-card-time=""');
    expect(due).toContain('font-mono');
    expect(due).not.toContain('text-bad');
    expect(textOf(out, 'data-post-card-due=""')).toBe('Due in 10 days');
    // No due date: no time.
    expect(renderWith({ post: makePost({}), now: NOW })).not.toContain('data-list-card-time');
  });

  it('a past due date reads overdue in the bad tone; approved is never overdue', () => {
    expect(cardDue('2026-10-22', 'review', 'UTC', NOW)).toEqual({
      text: 'Overdue 1 day',
      overdue: true,
    });
    expect(cardDue('2026-10-12', 'draft', 'UTC', NOW)).toEqual({
      text: 'Overdue 11 days',
      overdue: true,
    });
    expect(cardDue('2026-05-20', 'draft', 'UTC', NOW)).toEqual({
      text: 'Overdue 5 months',
      overdue: true,
    });
    expect(cardDue('2026-10-23', 'review', 'UTC', NOW)).toEqual({
      text: 'Due today',
      overdue: false,
    });
    expect(cardDue('2026-10-24', 'review', 'UTC', NOW)).toEqual({
      text: 'Due tomorrow',
      overdue: false,
    });
    expect(cardDue('2026-12-12', 'review', 'UTC', NOW)).toEqual({
      text: 'Due 12 Dec',
      overdue: false,
    });
    expect(cardDue('2026-10-12', 'approved', 'UTC', NOW)).toEqual({
      text: 'Due 12 Oct',
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
    expect(textOf(out, 'data-post-card-due="overdue"')).toBe('Overdue 11 days');
  });
});

describe('PostCard ⋮', () => {
  it('a card with onMove carries the ActionMenu trigger on line 3, named with the title', () => {
    const out = renderWith({ post: makePost({}), onMove: () => {} });
    const button = tag(out, 'data-post-card-move=""');
    expect(button).toContain('aria-label="Actions for Post title"');
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    // The trailing rule (ActionMenuTrigger) puts the glyph on the content edge.
    expect(button).toContain('-mr-3');
    expect(button).toContain('text-fg-3');
    const line3 = out.slice(out.indexOf('data-list-card-line="3"'));
    expect(line3).toContain('data-list-card-more=""');
    expect(line3).toContain('data-post-card-move');
    // No onMove, no ⋮.
    expect(renderWith({ post: makePost({}) })).not.toContain('data-post-card-move');
  });

  it('the ⋮ name carries the unread comment count', () => {
    expect(cardMenuLabel('X', 0)).toBe('Actions for X');
    expect(cardMenuLabel('X', 1)).toBe('Actions for X, 1 unread comment');
    expect(cardMenuLabel('X', 3)).toBe('Actions for X, 3 unread comments');
  });

  it('PostCard hands its slots to ListCard and builds no frame of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('./PostCard.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('<ListCard');
    expect(src).not.toMatch(/rounded-xl|lit-card|\bborder\b|<Card\b/);
  });
});

describe('menu gesture', () => {
  it('a long-press (touch) or a right-click (laptop) opens the same ⋯ ActionMenu', () => {
    const src = readFileSync(fileURLToPath(new URL('./PostCard.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('useMenuGesture(() => setMenuOpen(true))');
    expect(src).toContain('...gesture.handlers');
    expect(src).toContain('open={menuOpen}');
    expect(src).toContain('onOpenChange={setMenuOpen}');
  });
});

describe('PostCard ⋯ menu: every move the move sheet offers', () => {
  it('lists each moveActions row for the role, in order, after Open and Copy link', async () => {
    const { cardMenuItems } = await import('@/components/pages/PostCard');
    const { moveActions } = await import('@/components/pages/pipeline/MoveSheet');
    const noop = (): void => {};
    for (const role of ['client', 'agency', 'creator', null]) {
      for (const stage of ['draft', 'review', 'approved', 'parked', 'rejected'] as const) {
        const moves = moveActions(role, stage);
        const items = cardMenuItems({
          onOpen: noop,
          onCopyLink: noop,
          onMove: noop,
          moves: moves.map((m) => ({ ...m, onSelect: noop })),
        });
        const labels = items.map((i) => i.label);
        expect(labels.slice(0, 2)).toEqual(['Open', 'Copy link']);
        if (moves.length > 0) {
          expect(labels.slice(2)).toEqual(moves.map((m) => m.label));
          expect(labels).not.toContain('Move');
        } else {
          expect(labels.slice(2)).toEqual(['Move']);
        }
      }
    }
  });

  it('Reject is the danger row; icons: review arrow, approve check, park pause, reject X', async () => {
    const { cardMenuItems } = await import('@/components/pages/PostCard');
    const icons = await import('@/components/ui/icons');
    const noop = (): void => {};
    const items = cardMenuItems({
      onOpen: noop,
      onCopyLink: noop,
      moves: [
        { to: 'review', label: 'Send for review', tone: 'default', onSelect: noop },
        { to: 'approved', label: 'Approve', tone: 'default', onSelect: noop },
        { to: 'parked', label: 'Park', tone: 'default', onSelect: noop },
        { to: 'rejected', label: 'Reject', tone: 'bad', onSelect: noop },
      ],
    });
    const byLabel = new Map(items.map((i) => [i.label, i]));
    expect(byLabel.get('Send for review')?.icon).toBe(icons.IconArrowUpRight);
    expect(byLabel.get('Approve')?.icon).toBe(icons.IconCheck);
    expect(byLabel.get('Park')?.icon).toBe(icons.IconPause);
    expect(byLabel.get('Reject')?.icon).toBe(icons.IconX);
    expect(byLabel.get('Reject')?.tone).toBe('danger');
    expect(byLabel.get('Park')?.tone).toBeUndefined();
  });
});
