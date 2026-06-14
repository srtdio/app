import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BriefCard } from '@/components/pages/BriefCard';
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
    title: 'Spring launch',
    objective: 'Tease the spring drop across feed and stories.',
    status: 'open',
    target_date: '2026-07-01',
    reference_links: null,
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
  // object { drive_link, images }. Each must surface the same domain link fallback.
  it('falls back to the link domain for a string[] reference_links', () => {
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
    expect(out).toContain('figma.com');
  });

  it('falls back to the link domain for an array of { url } objects', () => {
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
    expect(out).toContain('notion.so');
  });

  it('falls back to the link domain for the ETL { drive_link, images } object', () => {
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
    expect(out).toContain('drive.google.com');
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
