// X5 fix 1 (FT20), revised by Pipeline polish and ui/ListCard: the move button
// is a plain ⋮ glyph at the right end of line 3 (a 44px tap area that never
// grows the line), off the picture.
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

/** The markup of the first element carrying `attr`, through its closing tag. */
function section(markup: string, attr: string, tag = 'span'): string {
  const at = markup.indexOf(attr);
  if (at === -1) return '';
  const open = markup.lastIndexOf(`<${tag}`, at);
  let depth = 0;
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'g');
  re.lastIndex = open;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    if (!m[0].endsWith('/>')) depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return markup.slice(open, m.index + m[0].length);
  }
  return markup.slice(open);
}

describe('X5 PostCard move button placement (the ⋮ at the right end of line 3)', () => {
  it('the carousel card keeps the move button off the picture; the badge stays on it', () => {
    const out = card('carousel');
    const picture = section(out, 'data-list-card-picture');
    expect(picture).toContain('data-post-card-thumb');
    expect(picture).toContain('aria-label="Carousel"');
    expect(picture).not.toContain('data-post-card-move');
    // The ⋮ lives on line 3.
    const line3 = section(out, 'data-list-card-line="3"', 'div');
    expect(line3).toContain('data-post-card-move');
  });

  it('the button is a plain 20px ⋮ in a 44px tap area that keeps the line height', () => {
    const out = card('single_image');
    const button = /<button[^>]*data-post-card-move=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(button).toContain('h-11');
    expect(button).toContain('w-11');
    // ListCard's trailing slot keeps the 44px target in the line (-my-3) above
    // the press surface (z-raised); the trigger takes the trailing rule (-mr-3).
    expect(out).toMatch(/data-list-card-more="" class="[^"]*z-raised[^"]*-my-3/);
    expect(button).toContain('-mr-3');
    expect(button).toContain('text-fg-3');
    // No resting fill (the shared IconButton only tints on hover).
    expect(button).not.toMatch(/[\s"]bg-/);
    expect(button).toContain('aria-label="Actions for Post title"');
    const glyph = /<button[^>]*data-post-card-move=""[^>]*>(<svg[^>]*>)/.exec(out)?.[1] ?? '';
    expect(glyph).toContain('width="20"');
    expect(glyph).toContain('height="20"');
    // It sits after the picture and the time, at the end of the card.
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(
      out.indexOf('data-list-card-line="3"'),
    );
    expect(out.indexOf('data-post-card-move')).toBeGreaterThan(out.indexOf('data-post-card-thumb'));
  });
});
