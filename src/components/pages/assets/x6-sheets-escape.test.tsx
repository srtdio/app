// @vitest-environment jsdom
// X6 unsaved-work and Escape guards on the Assets sheets and the lightbox,
// rendered for real in jsdom.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { assetMenuItems, type AssetMenuDeps } from '@/components/pages/assets/AssetActionSheet';
import { AssetRenameSheet } from '@/components/pages/assets/AssetRenameSheet';
import { AddLinkSheet, addLinkDirty } from '@/components/pages/assets/AddLinkSheet';
import {
  AssetLightbox,
  lightboxEscapeStep,
  swipeStep,
} from '@/components/pages/assets/AssetLightbox';
import { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import { resetHistorySteps, stepMarkerOf } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Phone: the ⋯ menu is a Sheet (Escape goes through the escape stack).
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => false }));

vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, FileViewer: () => <div data-test-file-viewer="" /> };
});

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

async function mount(node: ReactElement): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(node));
  await settle();
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
const guarded = () => stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY) !== null;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function escape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('X6 rename sheets open clean', () => {
  it('a rename sheet opened on a name is not dirty until the name changes', async () => {
    await mount(
      <AssetRenameSheet
        open
        initialName="Hero shot"
        onClose={() => {}}
        onSubmit={async () => ({ ok: true })}
        onToast={() => {}}
      />,
    );
    expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('Hero shot');
    expect(guarded()).toBe(false);
    const input = document.querySelector<HTMLInputElement>('input');
    if (input === null) throw new Error('no input');
    await type(input, 'Hero shot 2');
    expect(guarded()).toBe(true);
  });

  it('Add link is dirty as soon as anything is typed', async () => {
    expect(addLinkDirty('', '')).toBe(false);
    expect(addLinkDirty('h', '')).toBe(true);
    expect(addLinkDirty('', 'Deck')).toBe(true);
    await mount(
      <AddLinkSheet
        open
        onClose={() => {}}
        onSubmit={async () => ({ ok: true, assetId: 'a' })}
        onToast={() => {}}
        onAdded={() => {}}
      />,
    );
    expect(guarded()).toBe(false);
  });
});

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

const baseDeps: AssetMenuDeps = {
  presignEnabled: true,
  requestDownloadUrl: async () => 'https://signed/d',
  onInfo: () => {},
  onToast: () => {},
};

/** A card's ⋯ menu, open, as AssetCard renders it (ui/ActionMenu). */
function fileMenu(
  item: AssetListItem,
  deps: Partial<AssetMenuDeps> = {},
  onOpenChange: (open: boolean) => void = () => {},
) {
  return (
    <ActionMenu
      title="photo.png"
      items={assetMenuItems(item, { ...baseDeps, ...deps })}
      trigger={null}
      open
      onOpenChange={onOpenChange}
    />
  );
}

describe('X6 Escape on the action sheets', () => {
  it('the file menu closes on Escape', async () => {
    const onOpenChange = vi.fn();
    await mount(fileMenu(asset(), {}, onOpenChange));
    await escape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('file menu has no Move to folder', () => {
  it('renders Copy link, Download, Rename, Info and Delete only, Delete last in the bad tone', async () => {
    await mount(fileMenu(asset(), { canRename: true, onRename: () => {}, onDelete: () => {} }));
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((b) =>
      b.textContent?.trim(),
    );
    expect(rows).toEqual(['Copy link', 'Download', 'Rename', 'Info', 'Delete']);
    expect(button('Delete')?.className).toContain('text-bad');
    expect(button('Move to folder')).toBeUndefined();
    expect(document.body.textContent).not.toContain('Move to folder');
  });

  it('hides Download when the file cannot be downloaded (never disabled)', async () => {
    await mount(fileMenu(asset(), { presignEnabled: false, onDelete: () => {} }));
    expect(button('Download')).toBeUndefined();
    expect(button('Copy link')).toBeDefined();
  });

  it('a link menu opens the link first and has no Move to folder either', async () => {
    await mount(
      fileMenu(asset({ kind: 'link', externalUrl: 'https://example.com/deck', mimeType: null }), {
        onDelete: () => {},
      }),
    );
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((b) =>
      b.textContent?.trim(),
    );
    expect(rows[0]).toMatch(/^Open /);
    expect(rows[1]).toBe('Copy link');
    expect(rows[rows.length - 1]).toBe('Delete');
    expect(document.body.textContent).not.toContain('Move to folder');
  });
});

describe('X6 lightbox', () => {
  function lightbox(onClose: () => void, onDelete: (item: AssetListItem) => void = () => {}) {
    return (
      <AssetLightbox
        items={[asset(), asset({ id: 'a2', filename: 'second.png' })]}
        index={0}
        presignEnabled={false}
        cache={cache}
        requestDownloadUrl={async () => 'https://signed/d'}
        onIndexChange={() => {}}
        onClose={onClose}
        onDelete={onDelete}
        canRename
        onRename={async () => ({ ok: true })}
        onToast={() => {}}
      />
    );
  }

  it('has one top bar with Download, Copy link, Info and Delete, and no bottom bar', async () => {
    const onDelete = vi.fn();
    await mount(lightbox(() => {}, onDelete));
    const bar = document.querySelector<HTMLElement>('[data-lightbox-bar]');
    for (const label of ['Close viewer', 'Download', 'Copy link', 'Info', 'Delete']) {
      const control = bar?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      expect(control, label).not.toBeNull();
      expect(control?.className).toContain('h-11 w-11');
    }
    expect(bar?.querySelector('[aria-label="Delete"]')?.className).toContain('text-bad');
    expect(bar?.className).toContain('safe-area-inset-top');
    expect(bar?.textContent).toContain('1 of 2');
    await act(async () => bar?.querySelector<HTMLButtonElement>('[aria-label="Delete"]')?.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('moves focus to Close on open', async () => {
    await mount(lightbox(() => {}));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close viewer');
  });

  it('Escape closes an open rename, then Info, then the lightbox', async () => {
    const onClose = vi.fn();
    await mount(lightbox(onClose));
    const bar = document.querySelector<HTMLElement>('[data-lightbox-bar]');
    await act(async () => bar?.querySelector<HTMLButtonElement>('[aria-label="Info"]')?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Rename file"]')?.click(),
    );
    expect(document.querySelector('[aria-label="File name"]')).not.toBeNull();

    await escape();
    expect(document.querySelector('[aria-label="File name"]')).toBeNull();
    expect(document.querySelector('[aria-label^="Details for"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await escape();
    expect(document.querySelector('[aria-label^="Details for"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a menu over the lightbox takes Escape for itself', async () => {
    const onCloseLightbox = vi.fn();
    const onCloseMenu = vi.fn();
    await mount(
      <>
        {lightbox(onCloseLightbox)}
        {fileMenu(asset(), {}, onCloseMenu)}
      </>,
    );
    await escape();
    expect(onCloseMenu).toHaveBeenCalledWith(false);
    expect(onCloseLightbox).not.toHaveBeenCalled();
  });

  it('swipes only on a mostly horizontal move past the threshold', () => {
    expect(swipeStep(-80, 10)).toBe(1);
    expect(swipeStep(80, -10)).toBe(-1);
    expect(swipeStep(-80, 70)).toBe(0);
    expect(swipeStep(30, 0)).toBe(0);
    expect(swipeStep(0, 200)).toBe(0);
  });

  it('a swipe that starts on a video never changes the file', async () => {
    const onIndexChange = vi.fn();
    await mount(
      <AssetLightbox
        items={[
          asset({ kind: 'video', mimeType: 'video/mp4' }),
          asset({ id: 'a2', filename: 'second.png' }),
        ]}
        index={0}
        presignEnabled={false}
        cache={cache}
        requestDownloadUrl={async () => 'https://signed/d'}
        onIndexChange={onIndexChange}
        onClose={() => {}}
        onDelete={() => {}}
        canRename={false}
        onRename={async () => ({ ok: true })}
        onToast={() => {}}
      />,
    );
    // The stage holds a video element once a source resolves; stand one in.
    const stage = document.querySelector<HTMLElement>('[data-file-card]')?.parentElement;
    const video = document.createElement('video');
    stage?.appendChild(video);
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y }) as unknown as Touch;
    await act(async () => {
      video.dispatchEvent(
        Object.assign(new Event('touchstart', { bubbles: true }), {
          touches: [touch(200, 100)],
          changedTouches: [touch(200, 100)],
        }),
      );
      video.dispatchEvent(
        Object.assign(new Event('touchend', { bubbles: true }), {
          touches: [],
          changedTouches: [touch(40, 100)],
        }),
      );
    });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('the Escape order is rename, then Info, then close', () => {
    expect(lightboxEscapeStep({ editingName: true, infoOpen: true })).toBe('rename');
    expect(lightboxEscapeStep({ editingName: false, infoOpen: true })).toBe('info');
    expect(lightboxEscapeStep({ editingName: false, infoOpen: false })).toBe('close');
  });
});
