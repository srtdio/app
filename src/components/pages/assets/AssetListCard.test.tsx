import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ASSET_LIST_PAGE,
  AssetList,
  AssetListCard,
  assetFacts,
  assetTypeTag,
} from '@/components/pages/assets/AssetListCard';
import { LIST_CARD_GRID, type ListCardSelect } from '@/components/ui/ListCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// SSR to static markup: useState initializers run (a warm cache peek shows the
// image) while effects do not. Every Assets item is ui/ListCard: the picture;
// line 1 the name and the added time; line 2 the type and size facts and the
// type tag (PDF, Doc, Sheet, Image, Video). No ⋮: long-press / right-click selects.

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
  it('renders the part: name and time on line 1, facts and tag on line 2', () => {
    const out = card(makeAsset({ pageCount: 12, sizeBytes: 6_400_000 }));
    expect(out).toMatch(/^<div data-asset-card="a1"[^>]*data-list-card=""/);
    expect(out).toMatch(/data-list-card-line="1"[^]*data-asset-name="" title="report.pdf"/);
    expect(out).toMatch(/data-list-card-preview=""[^>]*data-asset-meta=""[^>]*>PDF · 12 pages · /);
    // formatAdded on the device zone: uploaded earlier the same day reads its clock time.
    expect(out).toMatch(
      /data-list-card-line="1"[^]*data-asset-uploaded=""[^>]*>\d{1,2}:\d{2} (AM|PM)<[^]*data-list-card-line="2"/,
    );
    expect(out).toMatch(/data-list-card-line="2"[^]*data-asset-tag=""[^]*>PDF</);
    expect(out).not.toContain('data-list-card-line="3"');
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

describe('line 2 tag is the file type', () => {
  it('PDF, Doc, Sheet, Image, Video from the stored kind', () => {
    const tag = (kind: AssetListItem['kind']) => assetTypeTag({ kind, mimeType: null });
    expect(tag('pdf')).toBe('PDF');
    expect(tag('document')).toBe('Doc');
    expect(tag('presentation')).toBe('Doc');
    expect(tag('spreadsheet')).toBe('Sheet');
    expect(tag('image')).toBe('Image');
    expect(tag('video')).toBe('Video');
    expect(tag('audio')).toBe('Audio');
    expect(tag('link')).toBe('Link');
  });

  it('an unknown kind reads its MIME type; none when that says nothing either', () => {
    const tag = (mimeType: string | null) => assetTypeTag({ kind: null, mimeType });
    expect(tag('application/pdf')).toBe('PDF');
    expect(tag('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'Doc',
    );
    expect(tag('application/msword')).toBe('Doc');
    expect(tag('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('Sheet');
    expect(tag('text/csv')).toBe('Sheet');
    expect(tag('image/heic')).toBe('Image');
    expect(tag('video/quicktime')).toBe('Video');
    expect(tag('application/zip')).toBeUndefined();
    expect(tag(null)).toBeUndefined();
    expect(card(makeAsset({ kind: null, mimeType: null }))).not.toContain('data-asset-tag');
  });

  it('the card shows the one grey tag on line 2, never a tab name', () => {
    expect(card(makeAsset({ kind: 'spreadsheet', mimeType: null }))).toMatch(
      /data-list-card-line="2"[^]*data-asset-tag=""[^]*>Sheet</,
    );
    const video = card(makeAsset({ kind: 'video', mimeType: 'video/mp4' }));
    expect(video).toMatch(/data-asset-tag=""[^]*>Video</);
    expect(video).not.toMatch(/>(Media|Docs|Sheets|Links)</);
  });
});

describe('a video picture: the play badge and its length', () => {
  it('the stored frame with the play badge and the stored length', () => {
    const { cache, peekThumbnail } = makeCache('https://cdn.example/frame.jpg');
    const out = card(
      makeAsset({ kind: 'video', mimeType: 'video/mp4', durationMs: 15_000 }),
      {},
      true,
      cache,
    );
    expect(out).toContain('data-list-card-picture="image"');
    expect(out).toMatch(/data-asset-video-thumb=""[^]*<img[^>]*frame\.jpg/);
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
    expect(out).toMatch(/data-asset-play-badge=""[^]*<svg[^]*data-asset-duration=""[^>]*>0:15</);
    // One play mark: not the file tile's centre play disc as well.
    expect(out).not.toContain('data-file-tile');
  });

  it('no stored length: the play badge alone', () => {
    const out = card(makeAsset({ kind: 'video', mimeType: 'video/mp4', durationMs: null }));
    expect(out).toContain('data-asset-play-badge=""');
    expect(out).not.toContain('data-asset-duration');
  });

  it('no frame (presign off): the video glyph under the badge, nothing asked', () => {
    const { cache, peekThumbnail } = makeCache('https://cdn.example/frame.jpg');
    const out = card(
      makeAsset({ kind: 'video', mimeType: 'video/mp4', durationMs: 4_000 }),
      {},
      false,
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('data-asset-play-badge=""');
    expect(out).toContain('>0:04<');
    expect(peekThumbnail).not.toHaveBeenCalled();
  });

  it('tokens only on the badge: overlay scrim and ink, no hex, no px, no dark:', () => {
    const out = card(makeAsset({ kind: 'video', mimeType: 'video/mp4', durationMs: 4_000 }));
    const badge = (out.match(/<span data-asset-play-badge=""[^>]*>/) ?? [''])[0];
    expect(badge).toContain('bg-overlay');
    expect(badge).toContain('text-overlay-fg');
    expect(badge).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\[\d+px\]|dark:/);
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

  it('a PDF with a stored preview: the stored thumbnail tile, asked near the viewport', () => {
    const { cache } = makeCache();
    const pdf = card(makeAsset(), {}, true, cache);
    expect(pdf).toContain('data-list-card-picture="image"');
    expect(pdf).toContain('data-file-tile="pdf"');
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

function selectState(active: boolean, chosen: boolean): ListCardSelect {
  return { active, chosen, onEnter: vi.fn(), onToggle: vi.fn() };
}

describe('select mode (ListCard select)', () => {
  it('no ⋮ ever: no menu trigger, no More actions', () => {
    for (const out of [
      card(makeAsset()),
      card(makeAsset(), { select: selectState(false, false) }),
    ]) {
      expect(out).not.toContain('data-card-menu');
      expect(out).not.toContain('More actions');
      expect(out).not.toContain('data-list-card-more');
    }
  });

  it('selecting: aria-pressed on the card, the tick on the picture, lit-selected when chosen', () => {
    const on = card(makeAsset(), { select: selectState(true, true) });
    expect(on).toMatch(/<button[^>]*aria-label="View report.pdf"[^>]*aria-pressed="true"/);
    expect(on).toContain('data-list-card-tick="on"');
    expect(on).toContain('lit-selected');
    const off = card(makeAsset(), { select: selectState(true, false) });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('data-list-card-tick="off"');
    expect(off).not.toContain('lit-selected');
  });

  it('out of select mode: no pressed state, the tick hidden, no text callout on a hold', () => {
    const out = card(makeAsset(), { select: selectState(false, false) });
    expect(out).not.toContain('aria-pressed');
    expect(out).toContain('data-list-card-tick="hidden"');
    expect(out).toContain('select-none');
  });

  it('without select the card has no tick at all', () => {
    expect(card(makeAsset())).not.toContain('data-list-card-tick');
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

  it('passes select mode through: each card gets its own select state', () => {
    const selectFor = vi.fn((item: AssetListItem) => selectState(true, item.id === 'a1'));
    const out = renderToStaticMarkup(
      <AssetList
        items={items}
        presignEnabled={false}
        cache={cache}
        onOpen={vi.fn()}
        selectFor={selectFor}
      />,
    );
    expect(selectFor).toHaveBeenCalledTimes(2);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
    expect(out.match(/data-list-card-tick="on"/g)).toHaveLength(1);
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

  it('no ⋮ menu or menu gesture: ListCard select owns long-press and right-click', () => {
    expect(src).not.toContain('ActionMenu');
    expect(src).not.toContain('useMenuGesture');
    expect(src).toContain('select={select}');
  });

  it('one minute clock for the whole list, no timer per card', () => {
    expect(src.match(/useMinuteClock\(\)/g)).toHaveLength(1);
    expect(src).not.toContain('setInterval');
  });
});
