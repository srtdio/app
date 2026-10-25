// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

// Type roles on the board card (design rules, 24 Oct 2026): the card title is
// base/500, the caption preview and the due line are meta (sm, fg-3).

const NOW = new Date('2026-10-23T12:00:00Z');

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

function makePost(overrides: Partial<PipelinePost> = {}): PipelinePost {
  return {
    id: 'p1',
    number: 1,
    title: 'Monsoon drop: linen in rain',
    platform: 'instagram',
    format: 'text',
    caption: 'Linen that breathes.',
    target_date: '2026-11-02',
    stage: 'draft',
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

function paint(post: PipelinePost): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <PostCard post={post} cache={cache} presignEnabled={false} now={NOW} />
    </MemoryRouter>,
  );
  return host;
}

/** The deepest element whose trimmed text is exactly `text`. */
function byText(scope: Element, text: string): HTMLElement {
  const matches = [...scope.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const el = matches[matches.length - 1];
  if (el === undefined) throw new Error(`no element with text "${text}"`);
  return el;
}

function classes(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

describe('PostCard type roles', () => {
  it('card title: text-base font-medium', () => {
    const host = paint(makePost());
    const title = classes(byText(host, 'Monsoon drop: linen in rain'));
    expect(title).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    expect(title).not.toContain('font-semibold');
  });

  it('caption preview is meta: text-sm text-fg-3', () => {
    const host = paint(makePost());
    expect(classes(byText(host, 'Linen that breathes.'))).toEqual(
      expect.arrayContaining(['text-sm', 'text-fg-3']),
    );
  });

  it('due line is meta: text-sm text-fg-3', () => {
    const host = paint(makePost());
    const due = host.querySelector('[data-post-card-due]');
    expect(due?.textContent).toContain('Due');
    expect(classes(due)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3']));
  });

  it('renders no off-scale type classes', () => {
    const html = paint(makePost()).innerHTML;
    expect(html).not.toMatch(/text-legacy-|text-\[\d|leading-\[\d|font-bold|font-\[/);
  });
});
