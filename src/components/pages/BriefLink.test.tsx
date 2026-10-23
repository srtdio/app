import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { BriefLink, briefLinkShowsCard } from '@/components/pages/BriefLink';
import type { LinkPreview, PreviewClient } from '@/lib/links/preview';

const base = {
  domain: 'figma.com',
  path: '/file/abc',
  letter: 'F',
  finalDomain: null,
  viaShortener: null,
};
const full: LinkPreview = {
  type: 'full',
  ...base,
  title: 'Moodboard',
  description: null,
  siteName: null,
  video: false,
  durationSeconds: null,
};

function client(preview: LinkPreview | null, imageUrl: string | null): PreviewClient {
  return {
    peek: () => preview,
    request: async () => preview ?? { type: 'bare', ...base },
    imageUrl: () => imageUrl,
  };
}

const URL_ = 'https://figma.com/file/abc';

describe('briefLinkShowsCard', () => {
  it('only a full preview whose image loaded earns the card', () => {
    expect(briefLinkShowsCard(full, true)).toBe(true);
    expect(briefLinkShowsCard(full, false)).toBe(false);
    expect(briefLinkShowsCard({ type: 'bare', ...base }, true)).toBe(false);
    expect(briefLinkShowsCard({ ...full, type: 'text' }, true)).toBe(false);
    expect(briefLinkShowsCard(null, true)).toBe(false);
  });
});

describe('BriefLink', () => {
  it('a link without an OG image renders as the one-line pill, never the letter card', () => {
    const out = renderToStaticMarkup(
      <BriefLink url={URL_} domain="figma.com" client={client({ type: 'bare', ...base }, null)} />,
    );
    expect(out).toContain('aria-label="Open figma.com in a new tab"');
    expect(out).toContain('min-h-[44px]');
    expect(out).not.toContain('data-link-card');
    expect(out).not.toContain('data-brief-link-probe');
  });

  it('a full preview stays the pill until its image loads (probed off screen)', () => {
    const out = renderToStaticMarkup(
      <BriefLink url={URL_} domain="figma.com" client={client(full, 'https://p.test/image')} />,
    );
    expect(out).toContain('aria-label="Open figma.com in a new tab"');
    expect(out).not.toContain('data-link-card');
    expect(out).toContain('data-brief-link-probe=""');
    expect(out).toContain('class="hidden"');
  });

  it('a full preview with no image endpoint stays the pill with no probe', () => {
    const out = renderToStaticMarkup(
      <BriefLink url={URL_} domain="figma.com" client={client(full, null)} />,
    );
    expect(out).not.toContain('data-link-card');
    expect(out).not.toContain('data-brief-link-probe');
  });
});
