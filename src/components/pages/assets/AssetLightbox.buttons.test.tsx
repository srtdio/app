import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// Button system regression: every visual control in the lightbox is 44 tall
// with the 8px radius, and none keeps an old height, radius or weight.

vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, FileViewer: () => <div data-test-file-viewer="" /> };
});

function asset(n: number): AssetListItem {
  return {
    id: `as-${n}`,
    filename: `asset-${n}`,
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-10-01T00:00:00Z',
    currentVersionId: `ver-${n}`,
    kind: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 240_000,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: `r2/${n}`,
    versionNumber: 1,
    attachmentCount: 0,
  };
}

const cache = new PresignCache({
  endpoint: 'https://asset-read.test',
  getAccessToken: async () => 'token',
  fetcher: async () => new Response(null, { status: 500 }),
});

function mount(): string {
  return renderToStaticMarkup(
    <AssetLightbox
      items={[asset(0), asset(1)]}
      index={0}
      presignEnabled={false}
      cache={cache}
      requestDownloadUrl={async () => 'https://signed/d'}
      initialInfoOpen
      onIndexChange={() => {}}
      onClose={() => {}}
      onDelete={() => {}}
      canRename
      onRename={async () => ({ ok: true })}
      onToast={() => {}}
    />,
  );
}

/** The class of the first <button> carrying `marker` in its opening tag. */
function buttonClassOf(html: string, marker: string): string {
  for (const tag of html.match(/<button\b[^>]*>/g) ?? []) {
    if (tag.includes(marker)) return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
  }
  throw new Error(`no button with ${marker}`);
}

describe('AssetLightbox buttons', () => {
  const html = mount();

  it.each([
    'aria-label="Close viewer"',
    'aria-label="Download"',
    'aria-label="Previous asset"',
    'aria-label="Next asset"',
    'aria-label="Rename asset"',
  ])('%s is a 44px, 8px-radius control', (marker) => {
    const cls = buttonClassOf(html, marker);
    expect(cls).toContain('h-11');
    expect(cls).toContain('rounded-lg');
    expect(cls).not.toMatch(/\b(h-9|h-12|rounded-md|rounded-xl|rounded-full|font-semibold)\b/);
  });

  it('every visual button avoids the old heights, radii and weights', () => {
    for (const tag of html.match(/<button\b[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/\b(h-9|h-12|rounded-md|rounded-xl|font-semibold)\b/);
      expect(tag).not.toMatch(/text-\[\d+px\]/);
    }
  });
});
