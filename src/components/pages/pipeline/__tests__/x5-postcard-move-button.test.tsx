// X5 fix 1 (FT20), revised by Pipeline polish: the move button is a plain ⋯
// glyph at the right end of the due row (a 44px tap area that never grows the
// row), off the picture.
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import { x5Post } from './x5-fixtures';

const cache = { peek: vi.fn(() => null), resolve: vi.fn() } as unknown as PresignCache;

function card(format: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PostCard
        post={x5Post({ format, thumbnailAssetVersionId: 'av1' })}
        cache={cache}
        presignEnabled={false}
        onMove={() => {}}
      />
    </MemoryRouter>,
  );
}

function section(markup: string, attr: string): string {
  const doc = new DOMParserLike(markup);
  return doc.outerOf(attr);
}

/** A tiny attribute-scoped slicer: the markup of the first element carrying `attr`. */
class DOMParserLike {
  constructor(private readonly markup: string) {}
  outerOf(attr: string): string {
    const at = this.markup.indexOf(attr);
    if (at === -1) return '';
    const open = this.markup.lastIndexOf('<div', at);
    let depth = 0;
    const re = /<\/?div\b[^>]*>/g;
    re.lastIndex = open;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.markup)) !== null) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) return this.markup.slice(open, m.index + m[0].length);
    }
    return this.markup.slice(open);
  }
}

describe('X5 PostCard move button placement (the ⋯ at the right end of the title line)', () => {
  it('the carousel card keeps the move button off the picture; the badge stays on it', () => {
    const out = card('carousel');
    const thumb = section(out, 'data-post-card-thumb');
    expect(thumb).toContain('aria-label="Carousel"');
    expect(thumb).not.toContain('data-post-card-move');
    const badge = /<span[^>]*aria-label="Carousel"[^>]*>/.exec(out)?.[0] ?? '';
    expect(badge).toContain('left-2');
    // The ⋯ lives in the Card header (the title line).
    const header = section(out, 'data-card-header');
    expect(header).toContain('data-post-card-move');
  });

  it('the button is a plain 18px ⋯ in a 44px tap area that keeps the row height', () => {
    const out = card('single_image');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    // The Card more slot keeps the 44px target in the line (-my-3) above the
    // press surface (z-raised); the trigger takes the trailing rule (-mr-3).
    expect(out).toMatch(/data-card-more="" class="[^"]*-my-3[^"]*z-raised/);
    expect(button).toContain('-mr-3');
    expect(button).toContain('text-fg-3');
    // No resting fill (the shared IconButton only tints on hover).
    expect(button).not.toMatch(/[\s"]bg-/);
    expect(button).toContain('aria-label="More actions for Post title"');
    const glyph = /<button[^>]*data-post-card-move=""[^>]*>(<svg[^>]*>)/.exec(out)?.[1] ?? '';
    expect(glyph).toContain('width="20"');
    expect(glyph).toContain('height="20"');
    // It sits after the picture, in the card header.
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-card-header'));
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-post-card-thumb'));
  });
});
