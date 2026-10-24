import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  VERSION_TEXT_CLASS,
  VERSION_THUMBS_CLASS,
  VERSION_THUMBS_MAX,
  versionHistorySheet,
  type VersionThumbs,
} from '@/components/pages/pcs/VersionHistorySheet';
import { ReadOnlyVersionView } from '@/components/pages/pcs/ReadOnlyVersionView';
import { SnapshotThumbs } from '@/components/pages/pcs/PostGallery';
import { snapshotItems } from '@/components/pages/pcs/gallery-transforms';
import type { PresignCache } from '@/lib/asset-presign';
import type { PostVersionView } from '@/lib/post-versions';
import type { GalleryItem } from '@srtdio/posts';

// #35 regression: the versions sheet shows each version's pictures
// (platform-shaped, from that version's snapshot), "Current" on the latest and
// "Compare v{a} and v{b}"; the old-version view shows its pictures under a
// neutral banner. node environment: hookless trees are walked, the view is
// rendered to static markup.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}
function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

const cache = {
  peek: () => null,
  peekThumbnail: () => null,
  resolve: () => new Promise<never>(() => {}),
} as unknown as PresignCache;

function liveItem(versionId: string): GalleryItem {
  return {
    assetAttachmentId: `aa-${versionId}`,
    assetVersionId: versionId,
    assetId: `as-${versionId}`,
    position: 0,
    filename: `${versionId}.mp4`,
    mimeType: 'video/mp4',
    kind: 'video',
    width: 1080,
    height: 1920,
    durationMs: 1000,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
  };
}

const thumbs: VersionThumbs = {
  gallery: [liveItem('ver-b')],
  cache,
  presignEnabled: false,
  ratio: 9 / 16,
};

function version(id: string, n: number, gallery: string[]): PostVersionView {
  return {
    id,
    versionNumber: n,
    snapshot: { caption: `c${n}`, gallery },
    createdBy: null,
    legacyAuthorName: 'Casey',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

const noop = (): void => {};

function sheet(
  selectedIds: string[] = [],
  versions: PostVersionView[] = [version('v1', 1, ['ver-a']), version('v2', 2, ['ver-a', 'ver-b'])],
): ReactNode {
  return versionHistorySheet({
    open: true,
    onClose: noop,
    versions,
    currentVersionNumber: 2,
    resolveAuthor: () => 'Casey',
    onSelectVersion: noop,
    onCompare: vi.fn(),
    selectedIds,
    onToggleSelect: noop,
    thumbs,
  });
}

describe('#35 versions sheet', () => {
  it("draws each version's own snapshot pictures, platform-shaped", () => {
    const tree = sheet();
    const rows = elements((tree as ReactElement<{ children?: ReactNode }>).props.children).filter(
      (el) => el.type === SnapshotThumbs,
    );
    expect(rows).toHaveLength(2);
    const ids = rows.map((el) =>
      (el.props as { items: GalleryItem[] }).items.map((item) => item.assetVersionId),
    );
    // Newest first: v2 then v1.
    expect(ids).toEqual([['ver-a', 'ver-b'], ['ver-a']]);
    expect(rows.every((el) => (el.props as { ratio: number }).ratio === 9 / 16)).toBe(true);
    const html = renderToStaticMarkup(rows[0] as ReactElement);
    expect(html).toContain('aspect-ratio:0.5625');
  });

  it('labels the latest "Current" and offers "Compare v1 and v2"', () => {
    const tree = sheet() as ReactElement<{
      children?: ReactNode;
      footer?: ReactNode;
      title?: string;
    }>;
    const html = renderToStaticMarkup(<>{tree.props.children}</>);
    expect(html.split('Current')).toHaveLength(2);
    // Read the visible text: icon path data (Heroicons) can contain "v1".
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text.indexOf('Current')).toBeLessThan(text.indexOf('v1'));
    expect(renderToStaticMarkup(<>{tree.props.footer}</>)).toContain('Compare v1 and v2');
    expect(tree.props.title).toBe('Versions');
  });

  it('a snapshot id still attached reuses its stored kind; others render as images', () => {
    const items = snapshotItems(['ver-a', 'ver-b', 'ver-b'], thumbs.gallery);
    expect(items.map((item) => item.kind)).toEqual(['image', 'video', 'video']);
    expect(new Set(items.map((item) => item.assetAttachmentId)).size).toBe(3);
  });
});

describe('versions sheet at 360px (post screen polish)', () => {
  const four = [
    version('v1', 1, ['ver-a']),
    version('v2', 2, ['ver-a', 'ver-b', 'ver-c', 'ver-d']),
  ];

  it('at most 2 thumbs per row, then "+n"', () => {
    expect(VERSION_THUMBS_MAX).toBe(2);
    const rows = elements(
      (sheet([], four) as ReactElement<{ children?: ReactNode }>).props.children,
    ).filter((el) => el.type === SnapshotThumbs);
    expect(rows.every((el) => (el.props as { max?: number }).max === 2)).toBe(true);
    expect(rows.every((el) => (el.props as { size?: string }).size === 'xs')).toBe(true);
    const html = renderToStaticMarkup(rows[0] as ReactElement);
    expect(html).toContain('h-8');
    expect(html.match(/aspect-ratio:0.5625/g)).toHaveLength(2);
    expect(html).toContain('+2');
  });

  it('thumbs are h-8 and give way first; the text column keeps about 120px', () => {
    expect(VERSION_THUMBS_CLASS).toContain('min-w-0');
    expect(VERSION_THUMBS_CLASS).toContain('overflow-hidden');
    expect(VERSION_THUMBS_CLASS).not.toContain('shrink-0');
    expect(VERSION_TEXT_CLASS).toContain('min-w-[120px]');
    const all = elements(
      (sheet([], four) as ReactElement<{ children?: ReactNode }>).props.children,
    );
    const wrappers = all.filter(
      (el) => (el.props as { className?: string }).className === VERSION_THUMBS_CLASS,
    );
    expect(wrappers).toHaveLength(2);
    const text = all.filter((el) => 'data-version-text' in (el.props as object));
    expect(text).toHaveLength(2);
    expect(
      text.every((el) => (el.props as { className: string }).className === VERSION_TEXT_CLASS),
    ).toBe(true);
  });

  it('the author truncates and the date stays', () => {
    const all = elements(
      (sheet([], four) as ReactElement<{ children?: ReactNode }>).props.children,
    );
    const author = all.find((el) => 'data-version-author' in (el.props as object));
    const date = all.find((el) => 'data-version-date' in (el.props as object));
    expect((author?.props as { className: string }).className).toContain('truncate');
    expect((author?.props as { className: string }).className).toContain('min-w-0');
    expect((date?.props as { className: string }).className).toContain('shrink-0');
  });

  it('the list clips sideways overflow so the sheet never pans on X', () => {
    const list = (sheet([], four) as ReactElement<{ children?: ReactNode }>).props
      .children as ReactElement<{ className: string }>;
    expect(list.type).toBe('ul');
    expect(list.props.className).toContain('overflow-x-hidden');
    expect(list.props.className).toContain('min-w-0');
  });
});

describe('#35 old version view', () => {
  it('shows the version pictures under a neutral banner, never warning colours', () => {
    const html = renderToStaticMarkup(
      <ReadOnlyVersionView
        versionNumber={1}
        currentVersionNumber={2}
        caption="Hello"
        imageCount={2}
        galleryVersionIds={['ver-a', 'ver-b']}
        thumbs={thumbs}
        onBack={noop}
      />,
    );
    const banner = html.slice(html.indexOf('data-version-banner'));
    expect(banner.slice(0, 200)).toContain('bg-panel-2');
    expect(banner.slice(0, 200)).toContain('text-fg-2');
    expect(html).not.toMatch(/border-warn|text-warn/);
    expect(html).toContain('data-snapshot-thumbs');
    expect(html.match(/aspect-ratio:0.5625/g)).toHaveLength(2);
    expect(html).not.toContain('2 images');
  });
});
