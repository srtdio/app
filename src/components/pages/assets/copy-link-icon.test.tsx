import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { assetMenuItems } from '@/components/pages/assets/AssetActionSheet';
import { ICON_SIZE, IconCopy, IconLink } from '@/components/ui/icons';
import { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// Regression: Copy link is IconLink everywhere, in the file menu and on the
// lightbox bar. IconCopy is never used for Copy link.

vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, FileViewer: () => <div data-test-file-viewer="" /> };
});

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const item: AssetListItem = {
  id: 'a1',
  filename: 'photo.png',
  displayName: null,
  folderPath: '/',
  folderId: null,
  tags: [],
  uploadedAt: '2026-10-01T00:00:00Z',
  currentVersionId: 'v1',
  kind: 'image',
  mimeType: 'image/png',
  sizeBytes: 1024,
  width: null,
  height: null,
  durationMs: null,
  pageCount: null,
  externalUrl: null,
  r2Key: 'r2/a1',
  versionNumber: 1,
  attachmentCount: 0,
};

const cache = new PresignCache({
  endpoint: 'https://asset-read.test',
  getAccessToken: async () => 'token',
  fetcher: async () => new Response(null, { status: 500 }),
});

describe('asset Copy link uses IconLink', () => {
  it('the file menu Copy link row uses IconLink', () => {
    const items = assetMenuItems(item, {
      presignEnabled: true,
      requestDownloadUrl: async () => 'https://signed/d',
      onInfo: () => {},
      onDelete: () => {},
      onToast: () => {},
    });
    const copy = items.find((i) => i.id === 'copy-link');
    expect(copy?.label).toBe('Copy link');
    expect(copy?.icon).toBe(IconLink);
  });

  it('the lightbox Copy link button renders IconLink', () => {
    const html = renderToStaticMarkup(
      <AssetLightbox
        items={[item]}
        index={0}
        presignEnabled={false}
        cache={cache}
        requestDownloadUrl={async () => 'https://signed/d'}
        onIndexChange={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        canRename={false}
        onRename={async () => ({ ok: true })}
        onToast={() => {}}
      />,
    );
    const button = /<button\b[^>]*aria-label="Copy link"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(button).not.toBeNull();
    const inner = button?.[1] ?? '';
    expect(inner).toContain(renderToStaticMarkup(<IconLink size={ICON_SIZE.control} />));
    expect(inner).not.toContain(renderToStaticMarkup(<IconCopy size={ICON_SIZE.control} />));
  });

  it('neither source imports IconCopy', () => {
    expect(read('src/components/pages/assets/AssetActionSheet.tsx')).not.toContain('IconCopy');
    expect(read('src/components/pages/assets/AssetLightbox.tsx')).not.toContain('IconCopy');
  });
});
