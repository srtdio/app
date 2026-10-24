import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssetCard } from '@/components/pages/assets/AssetCard';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { assetMenuRows, copyLinkTarget } from '@/components/pages/assets/AssetActionSheet';
import { uploadBusyLabel, uploadSummary } from '@/components/pages/assets/AssetUploadSheet';
import {
  ROOT_LABEL,
  assetLink,
  deleteToastLabel,
  selectAllIds,
  selectedLabel,
} from '@/components/pages/assets/assets-nav';
import { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// W6 Assets regressions, one block per fix. Node environment (no DOM): pure
// helpers are driven directly and components are rendered to static markup.

vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, FileViewer: () => <div data-test-file-viewer="" /> };
});

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const pageSource = read('src/components/pages/AssetsPage.tsx');

function asset(overrides: Partial<AssetListItem> = {}): AssetListItem {
  return {
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
    ...overrides,
  };
}

const cache = new PresignCache({
  endpoint: 'https://asset-read.test',
  getAccessToken: async () => 'token',
  fetcher: async () => new Response(null, { status: 500 }),
});

describe('1. Assets has no folder navigation', () => {
  it('the page reads no ?folder= and renders no Folders breadcrumb', () => {
    const navSource = read('src/components/pages/assets/assets-nav.ts');
    expect(navSource).not.toContain('FOLDER_PARAM');
    expect(navSource).not.toContain('folderFromParams');
    expect(navSource).not.toContain('folderLink');
    expect(pageSource).not.toContain('aria-label="Folders"');
    expect(pageSource).not.toContain('fetchFolders');
    expect(pageSource).not.toContain('MoveToFolderSheet');
    expect(pageSource).not.toContain('No files in this folder yet');
  });
});

describe('2. upload sheet is busy while uploading', () => {
  it('labels the run "Uploading 2 of 5…" and blocks close via Sheet busy', () => {
    expect(uploadBusyLabel(2, 5)).toBe('Uploading 2 of 5…');
    expect(uploadBusyLabel(0, 5)).toBe('Uploading 1 of 5…');
    const source = read('src/components/pages/assets/AssetUploadSheet.tsx');
    expect(source).toMatch(/busy=\{running\}/);
  });
});

describe('3. Copy link copies a lasting in-app link', () => {
  it('is /assets?asset=<id>, never a presigned URL', () => {
    expect(assetLink('https://srtd.io/', 'a1')).toBe('https://srtd.io/assets?asset=a1');
    expect(copyLinkTarget(asset(), 'https://srtd.io')).toBe('https://srtd.io/assets?asset=a1');
    for (const path of [
      'src/components/pages/assets/AssetActionSheet.tsx',
      'src/components/pages/assets/AssetLightbox.tsx',
    ]) {
      expect(read(path)).not.toContain('resolveAssetUrl');
    }
  });
});

describe('4. every card shows a visible 44px ⋯ button', () => {
  it('on asset cards, hidden in select mode', () => {
    const card = renderToStaticMarkup(
      <AssetCard
        item={asset()}
        cache={cache}
        presignEnabled={false}
        onOpen={() => {}}
        onLongPress={() => {}}
      />,
    );
    expect(card).toContain('aria-label="More actions for photo.png"');
    expect(card).toMatch(/class="[^"]*h-11 w-11[^"]*"[^>]*data-card-menu=""/);
    const selecting = renderToStaticMarkup(
      <AssetCard
        item={asset()}
        cache={cache}
        presignEnabled={false}
        onOpen={() => {}}
        onLongPress={() => {}}
        selectMode
      />,
    );
    expect(selecting).not.toContain('data-card-menu');
  });
});

describe('5. menu rows in order, Delete last', () => {
  it('file and link menus, with no Move to folder row', () => {
    expect(assetMenuRows(false, true)).toEqual(['primary', 'copy', 'rename', 'info', 'delete']);
    expect(assetMenuRows(false, false)).toEqual(['primary', 'copy', 'info', 'delete']);
    expect(assetMenuRows(true, true)).toEqual(['primary', 'copy', 'rename', 'delete']);
    expect(assetMenuRows(true, false)).toEqual(['primary', 'copy', 'delete']);
    for (const isLink of [false, true]) {
      for (const canRename of [false, true]) {
        expect(assetMenuRows(isLink, canRename)).not.toContain('move');
      }
    }
  });
});

describe('6. delete hides now and commits after the Undo window', () => {
  it('uses useUndoableAction with the File deleted copy', () => {
    expect(deleteToastLabel(1)).toBe('File deleted. Undo or find it in Recently deleted.');
    expect(deleteToastLabel(3)).toBe('3 files deleted. Undo or find them in Recently deleted.');
    expect(pageSource).toContain('useUndoableAction');
    expect(pageSource).not.toContain('ConfirmDialog');
  });

  it('the viewer bottom bar has a Delete button', () => {
    const html = renderToStaticMarkup(
      <AssetLightbox
        items={[asset()]}
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
    expect(html).toContain('aria-label="Delete"');
  });
});

describe('7. select mode', () => {
  it('starts from the card box, with Cancel, a count and Select all up top and Delete below', () => {
    expect(selectedLabel(2)).toBe('2 selected');
    expect(selectAllIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2)).toEqual(['a', 'b']);
    const menu = read('src/components/pages/assets/AssetAddMenu.tsx');
    expect(menu).not.toContain('<span>Select</span>');
    expect(pageSource).toContain('onStartSelect={startSelectWith}');
    for (const label of ['Cancel', 'Select all', 'Delete']) {
      expect(pageSource).toContain(label);
    }
    expect(pageSource).not.toMatch(/>\s*Move\s*</);
    expect(pageSource).toContain('data-select-actions');
    expect(pageSource).not.toContain('Done\n');
  });
});

describe('7b. the "New asset" add menu', () => {
  it('is a "New asset" text button offering upload and link only; no New folder sheet', () => {
    const menu = read('src/components/pages/assets/AssetAddMenu.tsx');
    expect(menu).toContain('New asset');
    expect(menu).not.toContain('aria-label="Add asset"');
    expect(menu).not.toContain('New folder');
    expect(menu).toContain('<span>Upload files</span>');
    expect(menu).toContain('<span>Add link</span>');
    expect(pageSource).not.toContain('NewFolderSheet');
  });
});

describe('8. one upload summary toast; failures stay', () => {
  it('summarises the run and keeps a failure sticky', () => {
    expect(uploadSummary({ uploaded: 5, reused: 0, failed: 0 })).toEqual({
      title: 'Uploaded 5 files',
      sticky: false,
    });
    expect(uploadSummary({ uploaded: 3, reused: 0, failed: 2 })).toEqual({
      title: 'Uploaded 3 of 5. 2 failed.',
      sticky: true,
    });
    expect(uploadSummary({ uploaded: 0, reused: 0, failed: 1 })?.sticky).toBe(true);
    expect(uploadSummary({ uploaded: 0, reused: 0, failed: 0 })).toBeNull();
  });

  it('the Assets page uses ui/toast, not the local queue', () => {
    expect(pageSource).toContain("from '@/components/ui/toast'");
    expect(pageSource).not.toContain('pages/assets/useToasts');
    expect(pageSource).toContain('durationMs: null');
  });
});

describe('9. small fixes', () => {
  it('the library is All assets and names wrap to 2 lines', () => {
    expect(ROOT_LABEL).toBe('All assets');
    expect(read('src/components/pages/assets/AssetUploadSheet.tsx')).toContain('{ROOT_LABEL}');
    const card = renderToStaticMarkup(
      <AssetCard
        item={asset()}
        cache={cache}
        presignEnabled={false}
        onOpen={() => {}}
        onLongPress={() => {}}
      />,
    );
    expect(card).toContain('line-clamp-2');
  });
});
