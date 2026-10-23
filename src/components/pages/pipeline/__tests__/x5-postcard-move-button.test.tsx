// X5 fix 1 (FT20), revised by Pipeline polish: the move button is a plain ⋯
// glyph at the right end of the due row (a 44px tap area that never grows the
// row), off the picture.
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

describe('X5 PostCard move button placement (the ⋯ at the right end of the due row)', () => {
  it('the carousel card keeps the move button off the picture; the badge stays on it', () => {
    const out = card('carousel');
    const thumb = section(out, 'data-post-card-thumb');
    expect(thumb).toContain('aria-label="Carousel"');
    expect(thumb).not.toContain('data-post-card-move');
    const badge = /<span[^>]*aria-label="Carousel"[^>]*>/.exec(out)?.[0] ?? '';
    expect(badge).toContain('left-1.5');
    // The ⋯ lives in the meta (due) row of the body.
    const meta = section(out, 'data-post-card-meta');
    expect(meta).toContain('data-post-card-move');
  });

  it('the button is a plain 18px ⋯ in a 44px tap area that keeps the row height', () => {
    const out = card('single_image');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    // Negative margins: the 44px target overflows a 20px row without growing it.
    expect(button).toContain('-my-3');
    expect(button).toContain('ml-auto');
    expect(button).toContain('z-10');
    expect(button).toContain('text-fg-3');
    expect(button).not.toContain('bg-');
    expect(button).toContain('aria-label="Move post Post title"');
    const meta = /<div[^>]*data-post-card-meta=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(meta).toContain('h-5');
    const glyph = /<button[^>]*data-post-card-move=""[^>]*>(<svg[^>]*>)/.exec(out)?.[1] ?? '';
    expect(glyph).toContain('width="18"');
    expect(glyph).toContain('height="18"');
    // It sits after the picture, inside the body.
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-post-card-body'));
  });
});
