import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ASSET_LIST_PAGE,
  AssetList,
  AssetListCard,
  assetCardRows,
  assetFacts,
  assetTabTag,
} from '@/components/pages/assets/AssetListCard';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { IconFile, IconTrash } from '@/components/ui/icons';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// Phone layout for the card's ⋮ menu (ui/ActionMenu); no matchMedia here.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

// SSR to static markup: useState initializers run (a warm cache peek shows the
// image) while effects do not. Every Assets item is ui/ListCard: the picture,
// the name, the type and size facts, then the added time and the tab tag.

const NOW = new Date('2026-01-01T03:00:00Z');

function makeAsset(overrides: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: 'a1',
    filename: 'report.pdf',
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-01-01T00:00:00Z',
    currentVersionId: 'av1',
    kind: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: null,
    versionNumber: 1,
    attachmentCount: 0,
    ...overrides,
  };
}

function makeCache(thumbUrl: string | null = null) {
  const peek = vi.fn(() => null);
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  const peekThumbnail = vi.fn(() =>
    thumbUrl !== null ? { url: thumbUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  return {
    cache: { peek, resolve, peekThumbnail } as unknown as PresignCache,
    peek,
    resolve,
    peekThumbnail,
  };
}

function card(
  item: AssetListItem,
  props: Partial<Parameters<typeof AssetListCard>[0]> = {},
  presignEnabled = false,
  cache: PresignCache = makeCache().cache,
): string {
  return renderToStaticMarkup(
    <AssetListCard
      item={item}
      cache={cache}
      presignEnabled={presignEnabled}
      now={NOW}
      onOpen={() => {}}
      {...props}
    />,
  );
}

describe('Assets item is ui/ListCard', () => {
  it('renders the part with the name on line 1, the facts on line 2, time and tag on line 3', () => {
    const out = card(makeAsset({ pageCount: 12, sizeBytes: 6_400_000 }));
    expect(out).toMatch(/^<div data-asset-card="a1"[^>]*data-list-card=""/);
    expect(out).toMatch(/data-list-card-line="1"[^]*data-asset-name="" title="report.pdf"/);
    expect(out).toMatch(/data-list-card-preview=""[^>]*data-asset-meta=""[^>]*>PDF · 12 pages · /);
    // formatAdded on the device zone: uploaded earlier the same day reads its clock time.
    expect(out).toMatch(
      /data-list-card-line="3"[^]*data-asset-uploaded=""[^>]*>\d{1,2}:\d{2} (AM|PM)</,
    );
    expect(out).toMatch(/data-asset-tag=""[^]*>PDF</);
    // The old tile frame is gone.
    expect(out).not.toContain('data-tile');
    expect(out).not.toContain('aspect-[4/3]');
  });

  it('the title is displayName, else the filename', () => {
    expect(card(makeAsset({ displayName: 'Spring lookbook' }))).toContain(
      'title="Spring lookbook"',
    );
    expect(card(makeAsset({ displayName: null }))).toContain('title="report.pdf"');
  });

  it('the whole card opens it: View for a file, Open for a link', () => {
    expect(card(makeAsset())).toMatch(/<button[^>]*aria-label="View report.pdf"/);
    const link = card(
      makeAsset({ kind: 'link', filename: 'Brand site', externalUrl: 'https://www.x.io/a' }),
    );
    expect(link).toMatch(/<button[^>]*aria-label="Open Brand site"/);
    expect(link).not.toContain('aria-pressed');
  });
});

describe('line 2 facts, only from fields the item holds', () => {
  it('a picture: type, dimensions and size', () => {
    expect(
      assetFacts(
        makeAsset({
          kind: 'image',
          mimeType: 'image/png',
          width: 2400,
          height: 2400,
          sizeBytes: 2.4 * 1024 * 1024,
        }),
      ),
    ).toBe('PNG · 2400 x 2400 · 2.4 MB');
  });

  it('a video: type, length and size', () => {
    expect(
      assetFacts(
        makeAsset({
          kind: 'video',
          mimeType: 'video/mp4',
          durationMs: 15_000,
          sizeBytes: 18 * 1024 * 1024,
        }),
      ),
    ).toBe('MP4 · 0:15 · 18 MB');
  });

  it('a PDF: kind, pages and size', () => {
    expect(assetFacts(makeAsset({ pageCount: 12, sizeBytes: 6.1 * 1024 * 1024 }))).toBe(
      'PDF · 12 pages · 6.1 MB',
    );
  });

  it('a link: its domain', () => {
    expect(assetFacts(makeAsset({ kind: 'link', externalUrl: 'https://www.example.com/x' }))).toBe(
      'example.com',
    );
  });

  it('leaves out every fact the item lacks', () => {
    expect(assetFacts(makeAsset({ kind: 'image', mimeType: 'image/png', sizeBytes: null }))).toBe(
      'PNG',
    );
    expect(assetFacts(makeAsset({ kind: 'video', mimeType: 'video/mp4', sizeBytes: null }))).toBe(
      'MP4',
    );
    expect(assetFacts(makeAsset({ sizeBytes: null }))).toBe('PDF');
  });
});

describe('line 3 tag is the tab label', () => {
  it('Media, PDF, Docs, Sheets, Links; none for an unknown kind', () => {
    expect(assetTabTag({ kind: 'image' })).toBe('Media');
    expect(assetTabTag({ kind: 'video' })).toBe('Media');
    expect(assetTabTag({ kind: 'pdf' })).toBe('PDF');
    expect(assetTabTag({ kind: 'document' })).toBe('Docs');
    expect(assetTabTag({ kind: 'spreadsheet' })).toBe('Sheets');
    expect(assetTabTag({ kind: 'link' })).toBe('Links');
    expect(assetTabTag({ kind: null })).toBeUndefined();
    expect(card(makeAsset({ kind: null }))).not.toContain('data-asset-tag');
  });
});

describe('the picture slot', () => {
  it('a picture: its small copy, never the full-size original', () => {
    const { cache, peekThumbnail } = makeCache('https://cdn.example/photo.jpg');
    const out = card(
      makeAsset({ kind: 'image', filename: 'photo.png', mimeType: 'image/png' }),
      {},
      true,
      cache,
    );
    expect(out).toMatch(/data-list-card-picture="image"[^]*<img[^>]*photo\.jpg/);
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
  });

  it('a PDF or video with a stored preview: the stored thumbnail tile, asked near the viewport', () => {
    const { cache } = makeCache();
    const pdf = card(makeAsset(), {}, true, cache);
    expect(pdf).toContain('data-list-card-picture="image"');
    expect(pdf).toContain('data-file-tile="pdf"');
    const video = card(makeAsset({ kind: 'video', mimeType: 'video/mp4' }), {}, true, cache);
    expect(video).toContain('data-file-tile="video"');
  });

  it('a file with no preview, or presign off: the file-type icon in the icon box', () => {
    const doc = card(
      makeAsset({ kind: 'document', mimeType: 'application/msword', filename: 'a.doc' }),
      {},
      true,
    );
    expect(doc).toContain('data-list-card-picture="icon"');
    expect(doc).not.toContain('data-file-tile');
    const { cache, peek, resolve } = makeCache('https://cdn.example/photo.jpg');
    const off = card(makeAsset(), {}, false, cache);
    expect(off).toContain('data-list-card-picture="icon"');
    expect(peek).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a link: the link icon', () => {
    const out = card(makeAsset({ kind: 'link', externalUrl: 'https://x.io' }), {}, true);
    expect(out).toContain('data-list-card-picture="icon"');
    expect(out).not.toContain('<img');
  });
});

describe('select mode', () => {
  it('a tap toggles: aria-pressed on the card, the 20 tick box in place of the ⋮, lit-selected', () => {
    const on = card(makeAsset(), { selectMode: true, selected: true, onToggleSelect: vi.fn() });
    expect(on).toMatch(/<button[^>]*aria-pressed="true"[^>]*aria-label="Select report.pdf"/);
    expect(on).not.toContain('View report.pdf');
    expect(on).not.toContain('data-card-menu');
    expect(on).toMatch(/data-list-card-more=""[^>]*>\s*<span[^>]*data-card-tick="on"/);
    expect(on).toMatch(/data-card-tick="on" class="[^"]*h-5 w-5[^"]*bg-accent/);
    expect(on).toContain('<svg');
    expect(on).toContain('lit-selected');
    const off = card(makeAsset(), { selectMode: true, selected: false, onToggleSelect: vi.fn() });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toMatch(/data-card-tick="off" class="[^"]*h-5 w-5[^"]*border-border-strong/);
    expect(off).not.toContain('lit-selected');
  });

  it('out of select mode: the ⋮ and no selection affordance', () => {
    const out = card(makeAsset(), { onStartSelect: vi.fn() });
    expect(out).toContain('aria-label="More actions for report.pdf"');
    expect(out).toMatch(/data-list-card-more=""[^]*?data-card-menu=""/);
    expect(out).not.toContain('aria-pressed');
    expect(out).not.toContain('data-card-tick');
  });

  it('the ⋮ menu offers Select before Delete (Delete stays last)', () => {
    const rows: ActionMenuItem[] = [
      { id: 'download', label: 'Download', icon: IconFile, onSelect: () => {} },
      { id: 'delete', label: 'Delete', icon: IconTrash, tone: 'danger', onSelect: () => {} },
    ];
    const start = vi.fn();
    const out = assetCardRows(rows, start);
    expect(out.map((row) => row.id)).toEqual(['download', 'select', 'delete']);
    out.find((row) => row.id === 'select')?.onSelect();
    expect(start).toHaveBeenCalledTimes(1);
    expect(assetCardRows(rows, undefined)).toBe(rows);
  });
});

describe('AssetList', () => {
  const items = [
    makeAsset({ id: 'a1', filename: 'one.pdf' }),
    makeAsset({ id: 'a2', filename: 'two.pdf' }),
  ];
  const { cache } = makeCache();

  it('lays the cards in LIST_CARD_GRID, phone and laptop', () => {
    const out = renderToStaticMarkup(
      <AssetList items={items} presignEnabled={false} cache={cache} onOpen={vi.fn()} />,
    );
    expect(out).toContain(`data-asset-list="" class="${LIST_CARD_GRID}"`);
    expect(out.match(/data-list-card=""/g)).toHaveLength(2);
  });

  it('passes select mode through: which ids are selected', () => {
    const out = renderToStaticMarkup(
      <AssetList
        items={items}
        presignEnabled={false}
        cache={cache}
        onOpen={vi.fn()}
        selectMode
        selectedIds={new Set(['a1'])}
        onToggleSelect={vi.fn()}
      />,
    );
    expect(out).toContain('aria-label="Select one.pdf"');
    expect(out).toContain('aria-label="Select two.pdf"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
  });

  it('draws the first page of cards only, with a marker to draw more', () => {
    const many = Array.from({ length: ASSET_LIST_PAGE + 25 }, (_, i) =>
      makeAsset({ id: `m${i}`, filename: `file-${i}.pdf` }),
    );
    const out = renderToStaticMarkup(
      <AssetList items={many} presignEnabled={false} cache={cache} onOpen={vi.fn()} />,
    );
    expect(out).toContain(`file-${ASSET_LIST_PAGE - 1}.pdf`);
    expect(out).not.toContain(`file-${ASSET_LIST_PAGE}.pdf`);
    expect(out).toContain('data-asset-list-more');
    const few = renderToStaticMarkup(
      <AssetList items={items} presignEnabled={false} cache={cache} onOpen={vi.fn()} />,
    );
    expect(few).not.toContain('data-asset-list-more');
  });
});

describe('source rules', () => {
  const src = readFileSync(fileURLToPath(new URL('./AssetListCard.tsx', import.meta.url)), 'utf8');

  it('a long-press (touch) or a right-click (laptop) opens the same ⋮ ActionMenu', () => {
    expect(src).toContain('useMenuGesture(() => setMenuOpen(true))');
    expect(src).toContain('...gesture.handlers');
  });

  it('one minute clock for the whole list, no timer per card', () => {
    expect(src.match(/useMinuteClock\(\)/g)).toHaveLength(1);
    expect(src).not.toContain('setInterval');
  });
});
