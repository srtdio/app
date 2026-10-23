import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BriefCard, briefCardLink } from '@/components/pages/BriefCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefWithThumbnail } from '@srtdio/briefs';

// The card is rendered to static markup (node SSR, no DOM): useState initializers
// run (so a warm cache.peek hit shows the image) while effects do not, which is the
// lazy/off-screen state. reference_links is jsonb (Json | null); the tests feed the
// three real-world shapes through as unknown values, exactly as the read returns.

function makeBrief(overrides: Partial<BriefWithThumbnail>): BriefWithThumbnail {
  return {
    id: 'b1',
    workspace_id: 'w1',
    number: 1,
    title: 'Spring launch',
    objective: 'Tease the spring drop across feed and stories.',
    legacy_author_name: null,
    status: 'open',
    target_date: '2026-07-01',
    reference_links: null,
    mentions: null,
    format_requested: null,
    brand_requirements: null,
    closed_at: null,
    closed_by: null,
    created_by: 'u1',
    created_via: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
    ...overrides,
  };
}

function makeCache(peekUrl: string | null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  // Tiles paint the small copy only (never the full-size original).
  const peekThumbnail = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  return {
    cache: {
      peek,
      resolve,
      peekThumbnail,
      thumbnail: async () => null,
    } as unknown as PresignCache,
    peek,
    peekThumbnail,
    resolve,
  };
}

function render(brief: BriefWithThumbnail, cache: PresignCache, presignEnabled = true): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BriefCard brief={brief} cache={cache} presignEnabled={presignEnabled} href="/briefs/b1" />
    </MemoryRouter>,
  );
}

describe('BriefCard thumbnail tile', () => {
  it('renders the small copy when thumbnailAssetVersionId is present', () => {
    const { cache, peekThumbnail } = makeCache('https://cdn.example/thumb.jpg');
    const out = render(makeBrief({ thumbnailAssetVersionId: 'av1' }), cache);
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
  });

  // One case per known reference_links shape: bare string[], [{ url }], and the ETL
  // object { drive_link, images }. Each must surface the same domain link BUTTON
  // (the dead link tile is gone), while the tile itself falls through to text.
  it('renders a link button for a string[] reference_links', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: [
          'https://www.figma.com/file/abc',
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://www.figma.com/file/abc"');
    expect(out).toContain('>figma.com<');
    expect(out).not.toContain('>https://www.figma.com/file/abc<');
  });

  it('renders a link button for an array of { url } objects', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: [
          { url: 'https://notion.so/spring-brief' },
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://notion.so/spring-brief"');
    expect(out).toContain('>notion.so<');
  });

  it('renders a link button for the ETL { drive_link, images } object', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: {
          drive_link: 'https://drive.google.com/folder/xyz',
          images: ['key/one.png'],
        } as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://drive.google.com/folder/xyz"');
    expect(out).toContain('>drive.google.com<');
  });

  it('renders at most one link button, for the first usable link', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: [
          'https://first.example/a',
          'https://second.example/b',
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    // The title link plus exactly one reference link.
    expect(out.match(/<a /g) ?? []).toHaveLength(2);
    expect(out).toContain('>first.example<');
    expect(out).not.toContain('second.example');
  });

  it('renders no link button when the brief has an image, leaving the card unchanged', () => {
    const { cache } = makeCache('https://cdn.example/thumb.jpg');
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: 'av1',
        reference_links: [
          'https://www.figma.com/file/abc',
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out).toContain('<img');
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    expect(out).not.toContain('figma.com');
  });

  it('renders no link button for a reference_links value with nothing usable', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: [
          'javascript:alert(1)',
          'not-a-url',
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    expect(out).not.toContain('javascript:');
  });

  it('shows the brief icon tile, never the objective text, when there is no image', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: ['not-a-url'] as unknown as BriefWithThumbnail['reference_links'],
        objective: 'Tease the spring drop',
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('italic');
    expect(out).toContain('data-brief-tile="icon"');
  });

  it('keeps the card fields (title, status, due date) after the thumbnail', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'open', target_date: '2026-07-01' }), cache);
    expect(out).toContain('Spring launch');
    expect(out).toContain('Open');
    expect(out).toContain('Due 1 Jul');
  });

  it('shows the Closed marker for a closed brief', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'closed' }), cache);
    expect(out).toContain('Closed');
  });

  it('Open is the accent-soft pill with an accent dot', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'open' }), cache);
    expect(out).toContain('data-brief-status="open"');
    expect(out).toContain('bg-accent-soft text-accent');
    expect(out).not.toContain('bg-good');
  });

  it('Closed is the panel-3 pill with a lock', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'closed' }), cache);
    expect(out).toContain('data-brief-status="closed"');
    expect(out).toContain('bg-panel-3 text-fg-2');
    expect(out).not.toContain('bg-accent-soft');
  });

  it('title and objective wrap instead of scrolling sideways', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({}), cache);
    expect(out).toContain('min-w-0 flex-1 break-words');
    expect(out).toContain('min-w-0 break-words text-sm text-fg-3');
  });
});

// The image-wins rule on its own, without rendering: an image brief never grows a
// link button, and a brief with no image takes its FIRST usable link.
describe('briefCardLink', () => {
  const links = [
    'https://first.example/a',
    'https://second.example/b',
  ] as unknown as BriefWithThumbnail['reference_links'];

  it('returns null when the brief has an image attachment, whatever its links', () => {
    expect(
      briefCardLink(makeBrief({ thumbnailAssetVersionId: 'av1', reference_links: links })),
    ).toBeNull();
  });

  it('returns the first usable link when there is no image', () => {
    expect(
      briefCardLink(makeBrief({ thumbnailAssetVersionId: null, reference_links: links })),
    ).toEqual({ href: 'https://first.example/a', domain: 'first.example' });
  });

  it('returns null when there is no image and nothing usable', () => {
    expect(briefCardLink(makeBrief({ thumbnailAssetVersionId: null }))).toBeNull();
    expect(
      briefCardLink(
        makeBrief({
          thumbnailAssetVersionId: null,
          reference_links: ['not-a-url'] as unknown as BriefWithThumbnail['reference_links'],
        }),
      ),
    ).toBeNull();
  });
});

describe('BriefCard tap target', () => {
  it('the card link covers the whole card and is named by the title', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ title: 'Spring launch' }), cache);
    // The one link is the card root's first child, inset-0 over the whole card.
    expect(out).toMatch(/^<div data-brief-card=""[^>]*><a /);
    const tag = /<a [^>]*>/.exec(out)?.[0] ?? '';
    expect(tag).toContain('aria-label="Spring launch"');
    expect(tag).toContain('data-brief-card-link=""');
    expect(tag).toContain('class="absolute inset-0');
    expect(tag).toContain('href="/briefs/b1"');
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    // The title is text inside the card, never a small link of its own.
    expect(out).not.toContain('after:absolute');
  });
});
