// The Pipeline list's first slice and Show more step are the screen's fill
// count (lib/use-fill-count); a kept depth on return wins when larger.
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/use-fill-count', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-fill-count')>()),
  useFillCount: () => 9,
}));
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import type { PresignCache } from '@/lib/asset-presign';
import { x5Post } from './x5-fixtures';

const posts = Array.from({ length: 30 }, (_unused, i) =>
  x5Post({ id: `p${i}`, number: i + 1, title: `Post ${i + 1}` }),
);

function render(shownKey?: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PipelineFeed
        posts={posts}
        activeStage="all"
        cache={{} as unknown as PresignCache}
        presignEnabled={false}
        {...(shownKey !== undefined ? { shownKey } : {})}
      />
    </MemoryRouter>,
  );
}

/** The rendered text with tags and React's text separators removed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '');

const rows = (html: string): number => (html.match(/data-list-card=""/g) ?? []).length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PipelineFeed fills the first screen, then shows the same count more', () => {
  it('the first slice is the fill count', () => {
    expect(rows(render())).toBe(9);
  });

  it('"Load more" (ui/LoadMore, no count) offers the next screen', () => {
    expect(text(render())).toContain('Load more');
    expect(text(render())).not.toMatch(/Show \d+ more/);
  });

  it('the last step offers only what is left', () => {
    const store = new Map([['k', '27']]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    const html = render('k');
    expect(rows(html)).toBe(27);
    expect(text(html)).toContain('Load more');
  });

  it('a kept depth larger than the fill count wins on return', () => {
    const store = new Map([['k', '18']]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(rows(render('k'))).toBe(18);
  });

  it('a kept depth smaller than the fill count falls back to the fill count', () => {
    const store = new Map([['k', '4']]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    expect(rows(render('k'))).toBe(9);
  });
});
