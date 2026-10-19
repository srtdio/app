// @vitest-environment jsdom
// X6 honest copy and the small rules behind it: in-use copy by parent, the
// bulk delete split, delete and select toasts, role copy, Recently deleted,
// Move to folder marking, and the FileViewer top bar Assets passes actions into.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assetInUseMessage,
  inUseKeptLabel,
  inUseTitle,
  splitFreeAssets,
  type FolderItem,
} from '@/lib/assets';
import { renameErrorMessage } from '@/lib/asset-upload';
import {
  ASSET_GONE_TOAST,
  FOLDER_DELETED_LABEL,
  ROOT_LABEL,
  assetParamIsGone,
  deleteToastLabel,
  selectAllCapLabel,
  selectCapLabel,
} from '@/components/pages/assets/assets-nav';
import {
  MoveToFolderSheet,
  isCurrentDestination,
} from '@/components/pages/assets/MoveToFolderSheet';
import { MEMBER_PURGE_NOTE, RecentlyDeletedView } from '@/components/pages/RecentlyDeletedPage';
import {
  DOWNLOAD_ERROR,
  FileViewerSheet,
  viewerBarLine,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { RETRY_BUTTON } from '@/components/pages/assets/AssetUploadSheet';

vi.mock('@/lib/files/office/run', () => ({ runOffice: vi.fn() }));

const source: FileViewerSource = {
  pdfBytes: async () => new Uint8Array(),
  officeBytes: async () => ({ bytes: new Uint8Array([1]), mime: null }),
  videoLink: async () => ({ url: 'https://signed/v', release: () => {} }),
  downloadLink: async () => ({ url: 'https://signed/d', release: () => {} }),
  previewNow: () => null,
  preview: async () => null,
};

describe('X6 in-use copy follows where the file is used', () => {
  it('names the post, brief or comment and never says to delete a brief', () => {
    expect(assetInUseMessage('hero.png', 0, 'post')).toBe(
      'hero.png is part of a post. Delete the post first, then the file.',
    );
    expect(assetInUseMessage('hero.png', 2, 'comment')).toBe(
      'hero.png and 2 more are attached to a comment. Delete the comment first, then the file.',
    );
    const brief = assetInUseMessage('hero.png', 0, 'brief');
    expect(brief).toContain('attached to a brief');
    expect(brief.toLowerCase()).not.toContain('delete the brief');
    expect(assetInUseMessage('hero.png', 0, null)).toBe(
      "hero.png is still in use, so it can't be deleted.",
    );
    expect(inUseTitle('brief')).toBe('Used in a brief');
    expect(inUseTitle('comment')).toBe('Used in a comment');
    expect(inUseTitle('post')).toBe('Used in a post');
    expect(inUseTitle(null)).toBe('File in use');
  });
});

describe('X6 bulk delete split', () => {
  it('deletes the free files and reports the kept ones', () => {
    expect(splitFreeAssets(['a', 'b', 'c'], [{ assetId: 'b' }])).toEqual({
      free: ['a', 'c'],
      kept: ['b'],
    });
    expect(inUseKeptLabel(1)).toBe('1 file is in use and was kept.');
    expect(inUseKeptLabel(3)).toBe('3 files are in use and were kept.');
  });
});

describe('X6 delete, folder and deep link toasts', () => {
  it('says where a deleted file goes', () => {
    expect(deleteToastLabel(1)).toBe('File deleted. Undo or find it in Recently deleted.');
    expect(FOLDER_DELETED_LABEL).toBe('Folder deleted');
    expect(ASSET_GONE_TOAST).toBe('This file was deleted.');
  });

  it('?asset= is gone only once the library loaded, an empty library included', () => {
    expect(assetParamIsGone(false, [], 'x')).toBe(false);
    expect(assetParamIsGone(true, [], 'x')).toBe(true);
    expect(assetParamIsGone(true, [{ id: 'x' }], 'x')).toBe(false);
  });

  it('states the 200 cap for select, not move', () => {
    expect(selectCapLabel(200)).toBe('You can select up to 200 files at once.');
    expect(selectAllCapLabel(200)).toBe(
      'Selected the first 200. You can select up to 200 files at once.',
    );
  });
});

describe('X6 role and Recently deleted copy', () => {
  it('names creators and admins for rename', () => {
    expect(renameErrorMessage(403)).toBe('Only creators and admins can rename files.');
  });

  it('tells a member who can restore and who can delete early (asset_purge_request is owner only)', () => {
    const out = renderToStaticMarkup(
      <RecentlyDeletedView
        items={[
          {
            id: 'd1',
            name: 'old.png',
            sizeBytes: 1024,
            deletedAt: '2026-10-10T00:00:00Z',
          } as never,
        ]}
        now={Date.parse('2026-10-11T00:00:00Z')}
        isOwner={false}
        loading={false}
        failed={false}
        busyId={null}
        onRetry={() => {}}
        onRestore={() => {}}
        onDeleteNow={() => {}}
        onEmpty={() => {}}
      />,
    );
    expect(out).toContain(MEMBER_PURGE_NOTE);
    expect(MEMBER_PURGE_NOTE).toContain('Anyone in this workspace can restore');
  });
});

describe('X6 per-file Retry', () => {
  it('is a 44px target', () => {
    expect(RETRY_BUTTON).toContain('min-h-[44px]');
    expect(RETRY_BUTTON).toContain('min-w-[44px]');
  });
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X6 Move to folder marks the current folder', () => {
  const folders: FolderItem[] = [
    { id: 'f1', name: 'Brand', parentId: null },
    { id: 'f2', name: 'Shoots', parentId: null },
  ];

  it('marks and disables the folder the files are in; All assets is the root name', async () => {
    expect(isCurrentDestination('f1', 'f1')).toBe(true);
    expect(isCurrentDestination(null, null)).toBe(true);
    expect(isCurrentDestination('f1', undefined)).toBe(false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <MoveToFolderSheet
          open
          count={1}
          folders={folders}
          currentFolderId="f1"
          onClose={() => {}}
          onMove={async () => ({ ok: true, moved: 1 })}
          onToast={() => {}}
          onMoved={() => {}}
        />,
      ),
    );
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const brand = rows.find((b) => b.textContent?.includes('Brand'));
    expect(brand?.getAttribute('aria-current')).toBe('true');
    expect(brand?.disabled).toBe(true);
    expect(brand?.textContent).toContain('Current');
    expect(rows.find((b) => b.textContent?.includes('Shoots'))?.disabled).toBe(false);
    expect(rows.some((b) => b.textContent?.includes(ROOT_LABEL))).toBe(true);
  });
});

describe('X6 FileViewer top bar from Assets', () => {
  it('other callers keep the default Download', () => {
    const html = renderToStaticMarkup(
      <FileViewerSheet name="deck.zip" kind="file" source={source} onClose={() => {}} />,
    );
    expect(html).toContain('aria-label="Download"');
  });

  it('Assets passes its own actions, with a type line under the name', () => {
    const html = renderToStaticMarkup(
      <FileViewerSheet
        name="brief.docx"
        kind="office"
        source={source}
        onClose={() => {}}
        subtitle="Doc · 12 KB"
        actions={(barClass) => (
          <>
            <button type="button" aria-label="Copy link" className={barClass} />
            <button type="button" aria-label="Delete" className={barClass} />
          </>
        )}
      />,
    );
    expect(html).toContain('aria-label="Copy link"');
    expect(html).toContain('aria-label="Delete"');
    expect(html).not.toContain('aria-label="Download"');
    expect(html).toContain('Doc · 12 KB');
    expect(html).toContain('h-11 w-11');
  });

  it('a PDF shows "Page x of y" under the name; a failed download says so', () => {
    expect(viewerBarLine({ page: 2, total: 9 }, 'PDF')).toBe('Page 2 of 9');
    expect(viewerBarLine(null, 'PDF · 1 MB')).toBe('PDF · 1 MB');
    expect(viewerBarLine(null, undefined)).toBeNull();
    expect(DOWNLOAD_ERROR).toBe("Couldn't download. Try again.");
  });
});
