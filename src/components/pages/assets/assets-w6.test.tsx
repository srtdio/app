import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssetListCard } from '@/components/pages/assets/AssetListCard';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { visibleSelectActions } from '@/components/ui/SelectBar';
import {
  assetMenuRows,
  assetSelectActions,
  copyLinkTarget,
} from '@/components/pages/assets/AssetActionSheet';
import { uploadBusyLabel, uploadSummary } from '@/components/pages/assets/AssetUploadSheet';
import {
  ROOT_LABEL,
  assetLink,
  deleteToastLabel,
  selectAllIds,
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

const NOW = new Date('2026-10-01T03:00:00Z');

describe('4. no card ⋯: long-press / right-click selects', () => {
  it('asset cards carry no menu trigger; select mode ticks the picture', () => {
    const card = renderToStaticMarkup(
      <AssetListCard
        item={asset()}
        cache={cache}
        presignEnabled={false}
        now={NOW}
        onOpen={() => {}}
      />,
    );
    expect(card).not.toContain('More actions');
    expect(card).not.toContain('data-card-menu');
    const selecting = renderToStaticMarkup(
      <AssetListCard
        item={asset()}
        cache={cache}
        presignEnabled={false}
        now={NOW}
        onOpen={() => {}}
        select={{ active: true, chosen: false, onEnter: () => {}, onToggle: () => {} }}
      />,
    );
    expect(selecting).not.toContain('data-card-menu');
    expect(selecting).toContain('data-list-card-tick="off"');
  });
});

describe('5. action rows in order: Open, Copy link, the rest, Delete last', () => {
  it('file and link menus, with no Move to folder row', () => {
    expect(assetMenuRows(false, true)).toEqual(['copy', 'primary', 'rename', 'info', 'delete']);
    expect(assetMenuRows(false, false)).toEqual(['copy', 'primary', 'info', 'delete']);
    expect(assetMenuRows(true, true)).toEqual(['primary', 'copy', 'rename', 'delete']);
    expect(assetMenuRows(true, false)).toEqual(['primary', 'copy', 'delete']);
    // A row the member cannot use is hidden, never disabled.
    expect(assetMenuRows(false, false, false)).toEqual(['copy', 'info', 'delete']);
    expect(assetMenuRows(true, false, false, false)).toEqual(['delete']);
    for (const isLink of [false, true]) {
      for (const canRename of [false, true]) {
        expect(assetMenuRows(isLink, canRename)).not.toContain('move');
      }
    }
  });
});

describe('5b. the old card ⋮ rows are the select bar actions', () => {
  const deps = {
    presignEnabled: true,
    requestDownloadUrl: async () => 'https://signed/d',
    canRename: true,
    onInfo: () => {},
    onRename: () => {},
    onDelete: () => {},
    onToast: () => {},
  };

  it('keeps the one order, Delete last in the bad tone; every other row is single-only', () => {
    expect(assetSelectActions(asset(), deps).map((row) => row.id)).toEqual([
      'copy-link',
      'download',
      'rename',
      'info',
      'delete',
    ]);
    const link = asset({ kind: 'link', externalUrl: 'https://x.io/a' });
    for (const item of [asset(), link]) {
      const rows = assetSelectActions(item, deps);
      expect(rows[rows.length - 1]).toMatchObject({ id: 'delete', tone: 'bad' });
      expect(rows.filter((row) => row.tone === 'bad')).toHaveLength(1);
      expect(rows.filter((row) => row.id !== 'delete').every((row) => row.single === true)).toBe(
        true,
      );
      expect(rows.find((row) => row.id === 'delete')?.single).toBeUndefined();
    }
    expect(assetSelectActions(link, deps)[0]?.id).toBe('open-link');
    expect(assetSelectActions(link, deps)[0]?.label).toBe('Open x.io');
  });

  it('several files ticked: Delete only', () => {
    expect(assetSelectActions(undefined, deps).map((row) => row.id)).toEqual(['delete']);
    expect(visibleSelectActions(assetSelectActions(asset(), deps), 2).map((row) => row.id)).toEqual(
      ['delete'],
    );
  });

  it('Delete runs the page delete at once (Undo strip, no dialog)', () => {
    const onDelete = vi.fn();
    assetSelectActions(asset(), { ...deps, onDelete })
      .find((row) => row.id === 'delete')
      ?.onSelect();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('Rename and Info hand the one file to the page', () => {
    const onRename = vi.fn();
    const onInfo = vi.fn();
    const item = asset();
    const rows = assetSelectActions(item, { ...deps, onRename, onInfo });
    rows.find((row) => row.id === 'rename')?.onSelect();
    rows.find((row) => row.id === 'info')?.onSelect();
    expect(onRename).toHaveBeenCalledWith(item);
    expect(onInfo).toHaveBeenCalledWith(item);
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
  it('a long-press or right-click selects (ListCard select); the bar is ui/SelectBar with Select all', () => {
    expect(selectAllIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2)).toEqual(['a', 'b']);
    const menu = read('src/components/pages/assets/AssetAddMenu.tsx');
    expect(menu).not.toContain('<span>Select</span>');
    expect(pageSource).toContain('useListSelection()');
    expect(pageSource).toContain('<SelectBar');
    expect(pageSource).toContain('selection.selectFor(item.id)');
    expect(pageSource).toContain('Select all');
    expect(pageSource).not.toContain('onStartSelect');
    expect(pageSource).not.toContain('startSelectWith');
    expect(pageSource).not.toMatch(/>\s*Move\s*</);
    expect(pageSource).toContain('data-select-actions');
    // The old hand-built bars are gone: SelectBar owns the inset and the count.
    expect(pageSource).not.toContain('useBottomInset');
    expect(pageSource).not.toContain('selectedLabel');
    expect(pageSource).not.toContain('Done\n');
  });
});

describe('7b. the "New file" add menu', () => {
  it('is the top bar "+" named "New file", offering upload and link only; no New folder sheet', () => {
    const menu = read('src/components/pages/assets/AssetAddMenu.tsx');
    expect(menu).toContain('<TopbarPlus');
    expect(menu).toContain('label="New file"');
    expect(menu).toContain('aria-haspopup="menu"');
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
      title: "Uploaded 3 of 5. Couldn't upload 2. Try again.",
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
  it('the library is All files; a name is the ui/ListCard one-line title with the full name kept', () => {
    expect(ROOT_LABEL).toBe('All files');
    expect(read('src/components/pages/assets/AssetUploadSheet.tsx')).toContain('{ROOT_LABEL}');
    const item = asset();
    const card = renderToStaticMarkup(
      <AssetListCard
        item={item}
        cache={cache}
        presignEnabled={false}
        now={NOW}
        onOpen={() => {}}
      />,
    );
    // Every list card is the same height: the title is one line, the facts line under it.
    expect(card).toContain('data-list-card=""');
    expect(card).toMatch(/data-list-card-title=""[^>]*><span data-asset-name="" title="photo.png"/);
    expect(card).toContain('data-asset-meta=""');
  });
});
