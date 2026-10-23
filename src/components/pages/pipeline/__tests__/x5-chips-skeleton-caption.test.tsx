// X5 fix 7: stage chips fade at the scroll edge (FN12); a no-media card shows
// its caption in fg-3 with no "Caption:" prefix (FN14, post flow C fix 5);
// loading is card skeletons (N12).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { chipRowMask } from '@/components/pages/pipeline/StageChips';
import { postsSkeleton } from '@/components/pages/PipelinePage';
import { PostCard } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import { x5Post } from './x5-fixtures';

const cache = { peek: vi.fn(() => null), resolve: vi.fn() } as unknown as PresignCache;

describe('X5 chips fade, caption preview, skeletons', () => {
  it('the chip row fades only at an edge with chips past it', () => {
    expect(chipRowMask(false, false)).toBe('none');
    expect(chipRowMask(false, true)).toContain('transparent 100%');
    expect(chipRowMask(false, true)).not.toContain('transparent 0');
    expect(chipRowMask(true, false)).toContain('transparent 0');
    expect(chipRowMask(true, true)).toMatch(/transparent 0.*transparent 100%/);
    expect(chipRowMask(true, true)).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
  });

  it('a no-media card shows its caption in fg-3, with no "Caption" label', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <PostCard
          post={x5Post({ format: 'text', caption: 'Diwali offer copy' })}
          cache={cache}
          presignEnabled={false}
        />
      </MemoryRouter>,
    );
    const caption = /<p[^>]*data-post-card-caption=""[^>]*>.*?<\/p>/.exec(out)?.[0] ?? '';
    expect(caption).toContain('text-fg-3');
    expect(caption).not.toContain('Caption');
    expect(caption).toContain('Diwali offer copy');
  });

  it('a media card shows no caption preview line', () => {
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <PostCard
          post={x5Post({ caption: 'Has media', thumbnailAssetVersionId: 'av1' })}
          cache={cache}
          presignEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(out).not.toContain('data-post-card-caption');
  });

  it('loading renders card skeletons, not a bare "Loading posts" line', () => {
    const out = renderToStaticMarkup(postsSkeleton(false));
    expect(out).toContain('data-posts-skeleton');
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/aspect-square/g)?.length ?? 0).toBeGreaterThan(1);
    // The words stay for screen readers only.
    expect(out).toContain('<span class="sr-only">Loading posts</span>');
  });
});
