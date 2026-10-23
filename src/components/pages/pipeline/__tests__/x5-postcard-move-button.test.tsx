// X5 fix 1 (FT20), revised by post flow C fix 3: the move button is a ⋯ circle
// on the picture's top-right corner (a 44px tap area outside the thumbnail
// tile and outside the text body), so the title gets the full card width.
import { describe, expect, it, vi } from 'vitest';
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
        post={x5Post({ format, thumbnailAssetVersionId: null })}
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

describe('X5 PostCard move button placement (post flow C fix 3: the ⋯ on the picture corner)', () => {
  it('the carousel card keeps the move button out of the thumbnail and the text body', () => {
    const out = card('carousel');
    const thumb = section(out, 'data-post-card-thumb');
    expect(thumb).toContain('aria-label="Carousel"');
    expect(thumb).not.toContain('data-post-card-move');
    // The carousel badge moves to the left corner, clear of the ⋯.
    const badge = /<span[^>]*aria-label="Carousel"[^>]*>/.exec(out)?.[0] ?? '';
    expect(badge).toContain('left-1.5');
    expect(badge).not.toContain('right-1.5');
    // The text body no longer holds the button: the title gets the full width.
    const body = section(out, 'data-post-card-body');
    expect(body).not.toContain('data-post-card-move');
    expect(out).toContain('data-post-card-move');
  });

  it('the button is a 44px tap area pinned to the top-right corner above the open overlay', () => {
    const out = card('single_image');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    expect(button).toContain('absolute');
    expect(button).toContain('right-0');
    expect(button).toContain('top-0');
    expect(button).toContain('z-10');
    expect(button).toContain('rounded-full');
    expect(button).toContain('aria-label="Move post Post title"');
    // It sits between the picture and the text block, never inside the body.
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-post-card-thumb'));
    expect(out.indexOf('data-post-card-move')).toBeLessThan(out.indexOf('data-post-card-body'));
  });
});
