import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetCard } from '@/components/pages/assets/AssetCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// SSR to static markup: useState initializers run (a warm cache.peek hit shows the
// image) while effects do not. The presign gate is asserted via the cache spies.
// Assets must look identical after the shared-module refactor, so these assert the
// same observable output as before: the image, the link domain, the file extension.

function makeAsset(overrides: Partial<AssetListItem>): AssetListItem {
  return {
    id: 'a1',
    filename: 'report.pdf',
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-01-01T00:00:00Z',
    currentVersionId: 'av1',
    rawKind: 'file',
    kind: 'file',
    mimeType: null,
    sizeBytes: 2048,
    width: null,
    height: null,
    durationMs: null,
    externalUrl: null,
    r2Key: null,
    versionNumber: 1,
    attachmentCount: 0,
    ...overrides,
  };
}

function makeCache(peekUrl: string | null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  return {
    cache: { peek, resolve, peekThumbnail: () => null } as unknown as PresignCache,
    peek,
    resolve,
  };
}

function render(item: AssetListItem, cache: PresignCache, presignEnabled: boolean): string {
  return renderToStaticMarkup(
    <AssetCard
      item={item}
      cache={cache}
      presignEnabled={presignEnabled}
      onOpen={() => {}}
      onLongPress={() => {}}
    />,
  );
}

describe('AssetCard thumbnail', () => {
  it('renders the presigned image for an image asset', () => {
    const { cache, peek } = makeCache('https://cdn.example/photo.jpg');
    const out = render(
      makeAsset({ kind: 'image', rawKind: 'image', filename: 'photo.png', mimeType: 'image/png' }),
      cache,
      true,
    );
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/photo.jpg');
    expect(out).toContain('object-cover');
    expect(peek).toHaveBeenCalledWith('av1');
  });

  it('renders the link domain fallback for a link asset', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeAsset({
        kind: 'link',
        rawKind: 'link',
        currentVersionId: 'av1',
        externalUrl: 'https://www.example.com/path',
      }),
      cache,
      true,
    );
    expect(out).toContain('example.com');
    expect(out).not.toContain('<img');
  });

  // Was: 'renders the file extension fallback for a doc asset'. File assets now
  // show the shared file tile, whose kind comes from the server mime, never the name.
  it('renders the file tile for a file asset, its kind from the mime, never the extension', () => {
    const { cache } = makeCache(null);
    const pdf = render(
      makeAsset({ filename: 'spec.docx', mimeType: 'application/pdf' }),
      cache,
      true,
    );
    expect(pdf).toContain('data-file-tile="pdf"');
    expect(pdf).toMatch(/data-file-meta[^>]*><span><span>PDF</);
    // First paint, before the tile nears the viewport: the icon card, no request.
    expect(pdf).toContain('data-file-tile-icon');
    expect(pdf).not.toContain('<img');
    const unknown = render(makeAsset({ filename: 'spec.PDF', mimeType: null }), cache, true);
    expect(unknown).toContain('data-file-tile="file"');
    expect(unknown).toMatch(/data-file-meta[^>]*><span><span>File</);
  });

  it('a file card keeps a fixed height: a 4/3 thumbnail box and two name lines', () => {
    const { cache } = makeCache(null);
    const out = render(makeAsset({ mimeType: 'video/mp4' }), cache, true);
    expect(out).toContain('aspect-[4/3]');
    expect(out).toContain('h-8');
  });

  it('shows the fallback and never touches the cache when presign is disabled', () => {
    const { cache, peek, resolve } = makeCache('https://cdn.example/photo.jpg');
    const out = render(
      makeAsset({ kind: 'image', rawKind: 'image', filename: 'photo.png' }),
      cache,
      false,
    );
    expect(peek).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(out).not.toContain('<img');
    expect(out).toContain('<svg');
  });
});

// Select mode swaps the tap target onto onToggleSelect and overlays a tick. The
// node test env has no DOM, so the wiring is asserted through the rendered
// affordances: the select aria-label + aria-pressed (which replace the open
// label and carry the toggle), the selected outline, and the tick. A vi.fn for
// onToggleSelect/onOpen is passed so the SSR render exercises the select branch.
describe('AssetCard select mode', () => {
  function renderSelect(selected: boolean): string {
    const { cache } = makeCache(null);
    return renderToStaticMarkup(
      <AssetCard
        item={makeAsset({ filename: 'report.pdf' })}
        cache={cache}
        presignEnabled={false}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
        selectMode
        selected={selected}
        onToggleSelect={vi.fn()}
      />,
    );
  }

  it('renders a selection toggle (not an open target) with the tick when selected', () => {
    const out = renderSelect(true);
    expect(out).toContain('aria-label="Select report.pdf"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).not.toContain('View report.pdf');
    // Selected outline + filled tick (white check on the accent circle).
    expect(out).toContain('border-accent');
    expect(out).toContain('bg-accent');
    expect(out).toContain('<svg');
  });

  it('shows a translucent ring and no check when not selected', () => {
    const out = renderSelect(false);
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('border-2 border-white');
    expect(out).toContain('bg-black/40');
  });

  it('keeps the open behaviour and no selection affordance out of select mode', () => {
    const { cache } = makeCache(null);
    const out = renderToStaticMarkup(
      <AssetCard
        item={makeAsset({ filename: 'report.pdf' })}
        cache={cache}
        presignEnabled={false}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );
    expect(out).toContain('aria-label="View report.pdf"');
    expect(out).not.toContain('aria-pressed');
    expect(out).not.toContain('Select report.pdf');
  });
});
