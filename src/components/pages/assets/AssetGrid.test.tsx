import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// SSR to static markup (the node test env has no DOM), mirroring AssetCard.test:
// the grid's select pass-through is asserted through the rendered card
// affordances. A warm cache is never needed here (no image assets), so peek/
// resolve are inert spies.

function makeAsset(id: string, filename: string): AssetListItem {
  return {
    id,
    filename,
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-01-01T00:00:00Z',
    currentVersionId: 'av-' + id,
    rawKind: 'file',
    kind: 'file',
    mimeType: null,
    sizeBytes: 1024,
    width: null,
    height: null,
    durationMs: null,
    externalUrl: null,
    r2Key: null,
    versionNumber: 1,
    attachmentCount: 0,
  };
}

const cache = {
  peek: vi.fn(() => null),
  resolve: vi.fn(async () => ({ url: 'x', expiresAt: Date.now() + 1000 })),
} as unknown as PresignCache;

const items = [makeAsset('a1', 'one.pdf'), makeAsset('a2', 'two.pdf')];

describe('AssetGrid select mode', () => {
  it('renders selectable cards reflecting which ids are selected', () => {
    const onToggleSelect = vi.fn();
    const out = renderToStaticMarkup(
      <AssetGrid
        items={items}
        presignEnabled={false}
        cache={cache}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
        selectMode
        selectedIds={new Set(['a1'])}
        onToggleSelect={onToggleSelect}
      />,
    );
    // Both cards become select toggles; a1 is selected, a2 is not.
    expect(out).toContain('aria-label="Select one.pdf"');
    expect(out).toContain('aria-label="Select two.pdf"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).not.toContain('View one.pdf');
  });

  it('renders plain open targets when the select props are absent', () => {
    const out = renderToStaticMarkup(
      <AssetGrid
        items={items}
        presignEnabled={false}
        cache={cache}
        onOpen={vi.fn()}
        onLongPress={vi.fn()}
      />,
    );
    expect(out).toContain('aria-label="View one.pdf"');
    expect(out).not.toContain('aria-pressed');
    expect(out).not.toContain('Select one.pdf');
  });
});
