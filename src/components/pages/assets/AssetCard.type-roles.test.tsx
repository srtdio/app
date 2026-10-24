// @vitest-environment jsdom
// Type roles on the asset card (design rules, 24 Oct 2026): the name is the
// card title (base/500), the size or link domain is sm fg-3 meta, and the mime
// badge is the one xs chip. Fixtures mirror AssetCard.test.tsx.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetCard } from '@/components/pages/assets/AssetCard';
import type { PresignCache } from '@/lib/asset-presign';
import { humanizeSize, mimeBadge, type AssetListItem } from '@/lib/assets';

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
    kind: 'pdf',
    mimeType: null,
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

const cache = {
  peek: vi.fn(() => null),
  resolve: vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 })),
  peekThumbnail: () => null,
} as unknown as PresignCache;

function mount(item: AssetListItem): void {
  document.body.innerHTML = renderToStaticMarkup(
    <AssetCard
      item={item}
      cache={cache}
      presignEnabled={false}
      onOpen={() => {}}
      onLongPress={() => {}}
    />,
  );
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AssetCard type roles', () => {
  it('the name is the card title: base/500', () => {
    mount(makeAsset({}));
    const title = document.querySelector<HTMLElement>('span[title="report.pdf"]');
    expect(title).not.toBeNull();
    expectRole(title as HTMLElement, ['text-base', 'font-medium']);
    expect(title?.className).not.toContain('text-xs');
  });

  it('the size line is sm fg-3 meta', () => {
    mount(makeAsset({}));
    const meta = byText(humanizeSize(2048)).parentElement as HTMLElement;
    expectRole(meta, ['text-sm', 'tabular-nums', 'text-fg-3']);
    expect(meta.className).not.toContain('text-xs');
  });

  it('a link card shows its domain as sm fg-3 meta', () => {
    mount(
      makeAsset({
        kind: 'link',
        filename: 'Brand site',
        externalUrl: 'https://example.com/brand',
        sizeBytes: null,
      }),
    );
    // The tile's fallback shows the domain too; the meta line is the one under the name.
    const line = [...document.querySelectorAll<HTMLElement>('div.pr-8')].find(
      (el) => el.textContent?.trim() === 'example.com',
    );
    expect(line).toBeDefined();
    expectRole(line as HTMLElement, ['text-sm', 'text-fg-3']);
  });

  it('the mime badge on an image is the xs chip', () => {
    mount(makeAsset({ kind: 'image', filename: 'photo.png', mimeType: 'image/png' }));
    const badge = [...document.querySelectorAll<HTMLElement>('span.shrink-0')].find(
      (el) => el.textContent?.trim() === mimeBadge('image/png'),
    );
    expect(badge).toBeDefined();
    expectRole(badge as HTMLElement, ['text-xs', 'font-medium', 'text-fg-3']);
  });
});
