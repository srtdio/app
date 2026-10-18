import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssetCard } from '@/components/pages/assets/AssetCard';
import { FolderCard } from '@/components/pages/assets/FolderCard';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { assetMenuRows, copyLinkTarget } from '@/components/pages/assets/AssetActionSheet';
import { folderMenuRows } from '@/components/pages/assets/FolderActionSheet';
import { uploadBusyLabel, uploadSummary } from '@/components/pages/assets/AssetUploadSheet';
import {
  ROOT_LABEL,
  assetLink,
  deleteToastLabel,
  folderFromParams,
  folderLink,
  folderStackOf,
  folderStep,
  selectAllIds,
  selectedLabel,
  withFolderParam,
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

describe('1. the open folder lives in the URL; Back goes up one folder', () => {
  it('reads and writes ?folder=', () => {
    expect(folderFromParams(new URLSearchParams('folder=f1'))).toBe('f1');
    expect(folderFromParams(new URLSearchParams(''))).toBeNull();
    expect(withFolderParam(new URLSearchParams('type=image'), 'f2').toString()).toBe(
      'type=image&folder=f2',
    );
    expect(withFolderParam(new URLSearchParams('folder=f2'), null).toString()).toBe('');
  });

  it('a child is a new entry; an ancestor steps Back; a deep link replaces', () => {
    expect(folderStep([], 'a', 0)).toEqual({ kind: 'push', stack: 1 });
    expect(folderStep(['a'], 'b', 1)).toEqual({ kind: 'push', stack: 2 });
    expect(folderStep(['a', 'b'], 'a', 2)).toEqual({ kind: 'back', delta: 1 });
    expect(folderStep(['a', 'b'], null, 2)).toEqual({ kind: 'back', delta: 2 });
    expect(folderStep(['a', 'b'], null, 0)).toEqual({ kind: 'replace', stack: 0 });
    expect(folderStackOf({ assetsFolderStack: 2 })).toBe(2);
    expect(folderStackOf(null)).toBe(0);
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
    expect(assetLink('https://v2.srtd.io/', 'a1')).toBe('https://v2.srtd.io/assets?asset=a1');
    expect(folderLink('https://v2.srtd.io', 'f1')).toBe('https://v2.srtd.io/assets?folder=f1');
    expect(copyLinkTarget(asset(), 'https://v2.srtd.io')).toBe(
      'https://v2.srtd.io/assets?asset=a1',
    );
    for (const path of [
      'src/components/pages/assets/AssetActionSheet.tsx',
      'src/components/pages/assets/AssetLightbox.tsx',
    ]) {
      expect(read(path)).not.toContain('resolveAssetUrl');
    }
  });
});

describe('4. every card shows a visible 44px ⋯ button', () => {
  it('on asset cards (hidden in select mode) and folder cards', () => {
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
    expect(card).toMatch(/data-card-menu=""[^>]*h-11 w-11/);
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
    const folder = renderToStaticMarkup(
      <FolderCard name="Brand" count={2} onOpen={() => {}} onManage={() => {}} />,
    );
    expect(folder).toContain('aria-label="More actions for Brand"');
  });
});

describe('5. menu rows in order, Delete last', () => {
  it('file, link and folder menus', () => {
    expect(assetMenuRows(false, true)).toEqual([
      'primary',
      'copy',
      'move',
      'rename',
      'info',
      'delete',
    ]);
    expect(assetMenuRows(true, false)).toEqual(['primary', 'copy', 'move', 'delete']);
    expect(folderMenuRows(true)).toEqual(['open', 'copy', 'rename', 'delete']);
    expect(folderMenuRows(false)).toEqual(['open', 'copy']);
  });
});

describe('6. delete hides now and commits after the Undo window', () => {
  it('uses useUndoableAction with the File deleted copy', () => {
    expect(deleteToastLabel(1)).toBe('File deleted');
    expect(deleteToastLabel(3)).toBe('3 files deleted');
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
  it('is labelled Select with Select all, a count, and Move, Delete, Done', () => {
    expect(selectedLabel(2)).toBe('2 selected');
    expect(selectAllIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2)).toEqual(['a', 'b']);
    const menu = read('src/components/pages/assets/AssetAddMenu.tsx');
    expect(menu).toContain('<span>Select</span>');
    expect(menu).not.toContain('Select files to move');
    for (const label of ['Select all', 'Move', 'Delete', 'Done']) {
      expect(pageSource).toContain(label);
    }
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
  it('root is All assets, crumbs are 44px, empty folders offer Upload, names wrap to 2 lines', () => {
    expect(ROOT_LABEL).toBe('All assets');
    expect(pageSource).toContain('{ROOT_LABEL}');
    expect(pageSource).toMatch(
      /onClick=\{\(\) => openFolder\(null\)\}\s*className="inline-flex min-h-\[44px\]/,
    );
    expect(pageSource).toMatch(/data-empty-folder=""[\s\S]{0,400}Upload/);
    const folder = renderToStaticMarkup(<FolderCard name="Brand" count={0} onOpen={() => {}} />);
    expect(folder).toContain('line-clamp-2');
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
