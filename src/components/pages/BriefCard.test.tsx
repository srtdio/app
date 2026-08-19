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
  return { cache: { peek, resolve } as unknown as PresignCache, peek, resolve };
}

function render(brief: BriefWithThumbnail, cache: PresignCache, presignEnabled = true): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BriefCard
        brief={brief}
        cache={cache}
        presignEnabled={presignEnabled}
        closing={false}
        closeError={null}
        onConfirmClose={() => {}}
        onOpen={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('BriefCard thumbnail tile', () => {
  it('renders the presigned image when thumbnailAssetVersionId is present', () => {
    const { cache, peek } = makeCache('https://cdn.example/thumb.jpg');
    const out = render(makeBrief({ thumbnailAssetVersionId: 'av1' }), cache);
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(peek).toHaveBeenCalledWith('av1');
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
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
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
    expect(out).not.toContain('<a ');
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
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('javascript:');
  });

  it('falls back to the objective text when there is no thumbnail and no usable link', () => {
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
    expect(out).toContain('italic');
    expect(out).toContain('Tease the spring drop');
  });

  it('falls back to the glyph when there is no thumbnail, no link and no text', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: null,
        objective: '   ',
        title: '   ',
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('italic');
    expect(out).toContain('<svg');
  });

  it('keeps the existing card fields (title, status, date, Close) after the thumbnail', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'open', target_date: '2026-07-01' }), cache);
    expect(out).toContain('Spring launch');
    expect(out).toContain('Open');
    expect(out).toContain('Close');
    // The target date is rendered (month-name format), proving the meta row survives.
    expect(out).toMatch(/Jul|2026/);
  });

  it('shows the Closed marker and hides the Close action for a closed brief', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'closed' }), cache);
    expect(out).toContain('Closed');
    expect(out).not.toContain('>Close<');
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
