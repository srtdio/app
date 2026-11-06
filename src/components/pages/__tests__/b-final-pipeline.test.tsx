// Layout B-final, Pipeline + post screen: the board card renders ui/Card
// (slots, the trailing rule on its ⋯, content height), the one post
// placeholder, the post screen's top bar is ui/HeaderBar, and a running
// decision keeps its button width (Button busy).
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PostCardProps } from '@/components/pages/PostCard';
import { Card } from '@/components/ui/Card';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { PostDecisionRow, type DecisionModel } from '@/components/pages/pcs/PostDecisionBar';
import { TRAILING_PULL } from '@/components/ui/layout';
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

describe('Pipeline card is ui/Card', () => {
  it('renders the part: surface, 16 inset, content height, press surface behind the content', () => {
    const out = card({ onMove: () => {} });
    expect(out).toContain('data-card=""');
    expect(out).toContain('lit-card');
    expect(out).toContain('self-start');
    expect(out).toContain('p-4');
    expect(out).not.toContain('h-full');
    expect(out).toContain('data-card-press=""');
    expect(out).toContain('aria-label="Open post Post title"');
    expect(out.indexOf('data-card-press')).toBeLessThan(out.indexOf('data-card-header'));
  });

  it('the ⋯ is the Card more slot with the trailing rule (glyph on the content edge)', () => {
    const out = card({ onMove: () => {} });
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain(TRAILING_PULL);
    expect(out).toMatch(/data-card-more="" class="[^"]*-my-3[^"]*pointer-events-auto/);
  });

  it('a text-only card has no media box; the stage badge is ui/Tag in the footer', () => {
    const out = card({ showStage: true, post: post({ stage: 'draft' }) });
    expect(out).not.toContain('data-card-media');
    expect(out).toContain('data-card-footer');
    expect(out).toMatch(/data-post-card-stage=""[^>]*><span class="lit-pill/);
  });

  it('keeps the status line height while the role loads, and the same line once known', () => {
    const pending = card({ viewer: { role: null, approverFirstNames: [], pending: true } });
    expect(pending).toContain('data-post-card-status-pending="" class="h-4"');
    const known = card({ viewer: { role: 'agency', approverFirstNames: ['Meera'] } });
    expect(known).toMatch(/data-post-card-status="with"[^>]*class="[^"]*\bh-4\b/);
  });

  it('a video with no poster shows the one post placeholder (play glyph)', () => {
    const out = card({ post: post({ format: 'reel' }) });
    expect(out).toContain('data-post-placeholder="video"');
    expect(out).toContain('data-card-media="bleed"');
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
