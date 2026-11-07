// Layout B-final, Pipeline + post screen: the Pipeline card renders
// ui/ListCard (slots, no ⋮, the one 60 height, select mode), the list is
// LIST_CARD_GRID on phone and laptop, the one post placeholder, the post
// screen's top bar is ui/HeaderBar, and a running decision keeps its button
// width (Button busy).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import type { PostCardProps } from '@/components/pages/PostCard';
import { Card } from '@/components/ui/Card';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { PostDecisionRow, type DecisionModel } from '@/components/pages/pcs/PostDecisionBar';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

function post(overrides: Partial<PipelinePost> = {}): PipelinePost {
  return {
    id: 'p1',
    number: 1,
    title: 'Post title',
    platform: 'instagram',
    format: 'text',
    caption: null,
    target_date: null,
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
    ...overrides,
  };
}

function card(props: Partial<PostCardProps> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard post={post()} cache={cache} presignEnabled={false} {...props} />
    </MemoryRouter>,
  );
}

describe('Pipeline card is ui/ListCard', () => {
  it('renders the part: the flat row frame, 16 sides, one press surface behind the content', () => {
    const out = card({ viewer: { role: 'agency', approverFirstNames: [] } });
    expect(out).toContain('data-list-card=""');
    expect(out).toMatch(/data-list-card=""[^>]*class="relative -mx-4 flex h-15 min-w-0 px-4\b/);
    expect(out).not.toContain('lit-card');
    expect(out).not.toContain('rounded-xl');
    expect(out).not.toMatch(/data-list-card-body=""[^>]*class="[^"]*\bp-3\b/);
    expect(out).not.toMatch(/\bp-4\b/);
    expect(out).not.toContain('data-card=""');
    expect(out).toContain('data-list-card-press=""');
    expect(out).toContain('aria-label="Open post Post title"');
    expect(out.indexOf('data-list-card-press')).toBeLessThan(out.indexOf('data-list-card-body'));
  });

  it('no ⋮ on the card: its rows live on the Pipeline select bar', () => {
    const out = card({ viewer: { role: 'agency', approverFirstNames: [] } });
    expect(out).not.toContain('data-post-card-move');
    expect(out).not.toContain('data-list-card-more');
    expect(out).not.toContain('Actions for');
  });

  it('a text post shows "Aa"; the stage is the one grey ui/Tag with its dot on line 2', () => {
    const out = card({ post: post({ stage: 'draft' }) });
    expect(out).toContain('data-post-placeholder="text"');
    expect(out).toMatch(/data-post-card-stage="draft"[^>]*><span class="[^"]*lit-pill/);
    expect(out).not.toContain('bg-stage-draft');
    const review = card({ post: post({ stage: 'review' }) });
    expect(review).toMatch(/data-post-card-stage="review"[^>]*><span class="[^"]*bg-panel-2/);
    expect(review).toContain('bg-stage-review');
    const line2 = review.slice(review.indexOf('data-list-card-line="2"'));
    expect(line2).toContain('data-post-card-stage="review"');
    expect(review).not.toContain('data-list-card-line="3"');
  });

  it('two lines whether the role is loading or known; no line-clamp-2, no min-h-9', () => {
    const pending = card({ viewer: { role: null, approverFirstNames: [], pending: true } });
    expect(pending).not.toContain('data-post-card-status');
    const known = card({ viewer: { role: 'agency', approverFirstNames: ['Meera'] } });
    expect(known).toContain('data-post-card-status="with"');
    for (const out of [pending, known]) {
      expect(out).toContain('data-list-card-line="1"');
      expect(out).toContain('data-list-card-line="2"');
      expect(out).not.toContain('line-clamp-2');
      expect(out).not.toMatch(/\bmin-h-9\b/);
    }
  });

  it('a video with no poster shows the one post placeholder (play glyph)', () => {
    const out = card({ post: post({ format: 'reel' }) });
    expect(out).toContain('data-post-placeholder="video"');
    expect(out).toContain('data-list-card-picture="placeholder"');
  });
});

describe('Pipeline list is LIST_CARD_GRID', () => {
  it('the cards sit in the ListCard page grid (one column on phone, auto-fill on laptop)', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineFeed
          posts={[post({ id: 'a' }), post({ id: 'b' })]}
          activeStage="all"
          cache={cache}
          presignEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(out).toContain(`data-pipeline-list="" class="${LIST_CARD_GRID}"`);
    expect(out.match(/data-list-card=""/g)?.length).toBe(2);
    expect(out).not.toContain('data-board');
    expect(out).not.toContain('grid-cols-2');
    // No select mode wired: no ticks.
    expect(out).not.toContain('data-list-card-tick');
  });

  it('selectFor threads select mode to every card', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineFeed
          posts={[post({ id: 'a' }), post({ id: 'b' })]}
          activeStage="all"
          cache={cache}
          presignEnabled={false}
          selectFor={(id) => ({
            active: true,
            chosen: id === 'a',
            onEnter: () => {},
            onToggle: () => {},
          })}
        />
      </MemoryRouter>,
    );
    expect(out.match(/data-list-card-selecting=""/g)?.length).toBe(2);
    expect(out.match(/data-list-card-tick="on"/g)?.length).toBe(1);
    expect(out.match(/data-list-card-tick="off"/g)?.length).toBe(1);
  });
});

describe('Card press and title slots', () => {
  it('press, rootRef and surface are additive: a plain Card renders as before', () => {
    const plain = renderToStaticMarkup(<Card title="x" />);
    expect(plain).not.toContain('data-card-press');
    expect(plain).not.toContain('pointer-events-none');
    expect(plain).toContain('truncate');
    const two = renderToStaticMarkup(<Card title="x" titleLines={2} />);
    expect(two).toContain('line-clamp-2');
  });
});

describe('PostPlaceholder', () => {
  it('"Aa" for a text post, the play glyph for a video', () => {
    expect(postPlaceholderKind('text')).toBe('text');
    expect(postPlaceholderKind('single_image')).toBe('text');
    expect(postPlaceholderKind(null)).toBe('text');
    expect(postPlaceholderKind('reel')).toBe('video');
    const text = renderToStaticMarkup(<PostPlaceholder kind="text" />);
    expect(text).toContain('>Aa<');
    expect(text).toContain('aria-hidden="true"');
    const video = renderToStaticMarkup(<PostPlaceholder kind="video" fill label="Video" />);
    expect(video).toContain('<svg');
    expect(video).toContain('bg-panel-3');
    expect(video).toContain('role="img"');
  });
});

describe('Post screen top bar', () => {
  it('HeaderBar with a title slot renders no second h1, and Back takes the leading pull', () => {
    const out = renderToStaticMarkup(
      <HeaderBar title="In review" titleSlot={<span>In review</span>} onBack={() => {}} compact />,
    );
    expect(out).not.toContain('<h1');
    expect(out).toMatch(/aria-label="Back"[^>]*-ml-3|-ml-3[^>]*aria-label="Back"/);
    expect(out).toContain('px-4 md:px-6');
  });
});

describe('Post screen decision keeps its width while busy', () => {
  const model: DecisionModel = {
    kind: 'approver',
    actions: [
      { to: 'rejected', label: 'Reject', variant: 'default' },
      { to: 'approved', label: 'Approve', variant: 'primary' },
    ],
    onPick: () => {},
  };
  it('the running move shows Button busy; the other is only disabled', () => {
    const out = renderToStaticMarkup(
      <PostDecisionRow model={model} busy pending="approved" error={null} />,
    );
    const approve = out.slice(out.indexOf('Approve') - 400, out.indexOf('Approve'));
    expect(approve).toContain('data-busy');
    expect((out.match(/aria-busy="true"/g) ?? []).length).toBe(1);
    expect((out.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
