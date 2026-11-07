// X5 fix 7: stage chips fade at the scroll edge (FN12); a card shows its
// caption in the secondary role (fg-2) with no "Caption:" prefix (FN14, post
// flow C fix 5), on ListCard's line 2; loading is ListCardBox skeletons (N12).
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
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

  it('a card shows its caption on line 2 in the secondary role (fg-2), with no "Caption" label', () => {
    for (const thumbnailAssetVersionId of [null, 'av1']) {
      const out = renderToStaticMarkup(
        <MemoryRouter>
          <PostCard
            post={x5Post({ format: 'text', caption: 'Diwali offer copy', thumbnailAssetVersionId })}
            cache={cache}
            presignEnabled={false}
          />
        </MemoryRouter>,
      );
      const caption =
        /<span[^>]*data-post-card-caption=""[^>]*>.*?<\/span>/.exec(out)?.[0] ?? '';
      expect(caption).toContain('data-list-card-preview=""');
      expect(caption).toContain('text-fg-2');
      expect(caption).not.toContain('Caption');
      expect(caption).toContain('Diwali offer copy');
    }
  });

  it('loading renders ListCardBox skeletons in the list grid, not a bare "Loading posts" line', () => {
    const out = renderToStaticMarkup(postsSkeleton());
    expect(out).toContain('data-posts-skeleton');
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/data-list-card-box=""/g)?.length ?? 0).toBeGreaterThan(1);
    expect(out).toContain('md:grid-cols-list-cards');
    // The words stay for screen readers only.
    expect(out).toContain('<span class="sr-only">Loading posts</span>');
  });
});
