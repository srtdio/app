// X5 fix 1 (FT20): the Move button leaves the thumbnail and sits at the card's
// right edge, centred on the text block. Nothing but the format/carousel labels
// overlays the thumbnail.
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

describe('X5 PostCard move button placement', () => {
  it('the carousel card keeps the Move button out of the thumbnail', () => {
    const out = card('carousel');
    const thumb = section(out, 'data-post-card-thumb');
    expect(thumb).toContain('aria-label="Carousel"');
    expect(thumb).not.toContain('data-post-card-move');
    const body = section(out, 'data-post-card-body');
    expect(body).toContain('data-post-card-move');
  });

  it('the button is 44px, secondary, centred, and never absolutely placed on the tile', () => {
    const out = card('single_image');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    expect(button).toContain('self-center');
    expect(button).toContain('border-border');
    expect(button).not.toContain('absolute');
    expect(button).not.toContain('left-1.5');
    // It comes after the text block, at the card's trailing edge.
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-post-card-title'));
  });
});
