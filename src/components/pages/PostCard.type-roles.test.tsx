// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PostCard } from '@/components/pages/PostCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

// Type roles on the Pipeline card (ui/ListCard): the title is the heading
// role, the caption preview the secondary role, the due words the meta role.

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

function classes(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

describe('PostCard type roles', () => {
  it('card title: the ListCard heading role (text-lg font-semibold)', () => {
    const host = paint(makePost());
    const title = classes(host.querySelector('[data-list-card-title]'));
    expect(title).toEqual(expect.arrayContaining(['text-lg', 'font-semibold']));
  });

  it('caption preview is the secondary role: text-md text-fg-2, one line', () => {
    const host = paint(makePost());
    const preview = host.querySelector('[data-post-card-caption]');
    expect(preview?.textContent).toBe('Linen that breathes.');
    expect(classes(preview)).toEqual(expect.arrayContaining(['text-md', 'text-fg-2', 'truncate']));
    expect(classes(preview)).not.toContain('line-clamp-2');
  });

  it('due line is the ListCard meta role: text-sm text-fg-3 mono', () => {
    const host = paint(makePost());
    const due = host.querySelector('[data-post-card-due]');
    expect(due?.textContent).toBe('2 Nov');
    expect(classes(due)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-3', 'font-mono']));
  });

  it('renders no off-scale type classes', () => {
    const html = paint(makePost()).innerHTML;
    expect(html).not.toMatch(/text-legacy-|text-\[\d|leading-\[\d|font-bold|font-\[/);
  });
});
