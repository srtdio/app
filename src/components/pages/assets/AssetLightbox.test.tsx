import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetLightbox,
  assetViewerKind,
  opensOnArrival,
  viewerName,
} from '@/components/pages/assets/AssetLightbox';
import { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';

// The FileViewer portals to document.body, which this DOM-less environment has
// none of: a marker stands in for it so a mount shows up in the markup.
vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    FileViewer: (p: { kind: string; name: string }) => (
      <div data-test-file-viewer={p.kind} data-test-name={p.name} />
    ),
  };
});

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function asset(
  n: number,
  mimeType: string | null,
  overrides: Partial<AssetListItem> = {},
): AssetListItem {
  return {
    id: `as-${n}`,
    filename: `asset-${n}`,
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-10-01T00:00:00Z',
    currentVersionId: `ver-${n}`,
    kind: 'pdf',
    mimeType,
    sizeBytes: 240_000,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: `r2/${n}`,
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

function mount(
  items: AssetListItem[],
  index = 0,
  opts: { presignEnabled?: boolean; initialInfoOpen?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <AssetLightbox
      items={items}
      index={index}
      presignEnabled={opts.presignEnabled ?? true}
      cache={cache}
      requestDownloadUrl={async () => 'https://signed/d'}
      initialInfoOpen={opts.initialInfoOpen ?? false}
      onIndexChange={() => {}}
      onClose={() => {}}
      onDelete={async () => 'deleted' as const}
      canRename={false}
      onRename={async () => ({ ok: true })}
      onToast={() => {}}
    />,
  );
}

describe('assetViewerKind', () => {
  it('routes pdf, office and other files by mime; images, video and links are not routed', () => {
    expect(assetViewerKind(asset(0, PDF_MIME))).toBe('pdf');
    expect(assetViewerKind(asset(0, DOCX_MIME))).toBe('office');
    expect(assetViewerKind(asset(0, 'application/zip'))).toBe('file');
    expect(assetViewerKind(asset(0, null))).toBe('file');
    expect(assetViewerKind(asset(0, 'image/png', { kind: 'image' }))).toBeNull();
    expect(assetViewerKind(asset(0, 'video/mp4'))).toBeNull();
    expect(assetViewerKind(asset(0, null, { kind: 'link' }))).toBeNull();
  });

  it('never classifies a file kind by file name', () => {
    expect(assetViewerKind(asset(0, null, { filename: 'deck.pdf' }))).toBe('file');
    expect(assetViewerKind(asset(0, 'application/octet-stream', { filename: 'x.docx' }))).toBe(
      'file',
    );
    expect(assetViewerKind(asset(0, PDF_MIME, { filename: 'notes.txt' }))).toBe('pdf');
  });
});

describe('AssetLightbox opens files in the FileViewer', () => {
  // The viewer opens in a layout effect right after the lightbox locks the
  // page (never in its first commit), so the arrival rule is tested directly
  // and the first paint never holds a viewer.
  it.each([PDF_MIME, DOCX_MIME, 'application/zip'])(
    'a tapped %s asset opens straight in the FileViewer',
    (mime) => {
      expect(opensOnArrival(asset(1, mime), false, true)).toBe(true);
    },
  );

  it('a tapped image or video opens no FileViewer', () => {
    expect(opensOnArrival(asset(0, 'image/png', { kind: 'image' }), false, true)).toBe(false);
    expect(opensOnArrival(asset(0, 'video/mp4'), false, true)).toBe(false);
  });

  it('reached from the long-press Info, it opens on the details, not the viewer', () => {
    expect(opensOnArrival(asset(0, PDF_MIME), true, true)).toBe(false);
  });

  it('opens no FileViewer without presign or a stored version', () => {
    expect(opensOnArrival(asset(0, PDF_MIME), false, false)).toBe(false);
    expect(opensOnArrival(asset(0, PDF_MIME, { currentVersionId: null }), false, true)).toBe(false);
  });

  // Regression: the viewer mounted with the lightbox and saved the page's
  // scroll value before the lightbox locked it (overflow: hidden left behind).
  it('the first paint holds no viewer: it opens after the lightbox has locked the page', () => {
    expect(mount([asset(0, PDF_MIME)])).not.toContain('data-test-file-viewer');
  });

  it('the file card offers Open, never "Download to view"', () => {
    const html = mount([asset(0, PDF_MIME)], 0, { initialInfoOpen: true });
    expect(html).not.toContain('Download to view');
    expect(html).toContain('data-file-card');
    expect(html).toMatch(/<button[^>]*>Open<\/button>/);
  });

  // The card's actions use the shared Button recipe: 44 tall, 8px radius.
  it.each([
    ['Open', { presignEnabled: true }],
    ['Download', { presignEnabled: false }],
  ] as const)('the card %s button is the shared 44px, 8px-radius button', (label, opts) => {
    const html = mount([asset(0, PDF_MIME)], 0, { ...opts, initialInfoOpen: true });
    const card = html.slice(html.indexOf('data-file-card'));
    const button = new RegExp(
      `<button[^>]*class="([^"]*)"[^>]*>(?:<svg.*?</svg>)?${label}</button>`,
    ).exec(card);
    if (button === null) throw new Error(`no ${label} button`);
    expect(button[1]).toContain('min-h-[44px]');
    expect(button[1]).toContain('h-11');
    expect(button[1]).toContain('rounded-lg');
    expect(button[1]).not.toContain('rounded-md');
  });
});

describe('viewer wiring regressions', () => {
  // Regression: the viewer's title was a snapshot taken at open.
  it('the viewer title follows a rename made while it is open', () => {
    const before = asset(0, PDF_MIME);
    const renamed = { ...before, displayName: 'Launch deck' };
    expect(viewerName([renamed], before)).toBe('Launch deck');
    expect(viewerName([], before)).toBe('asset-0');
  });

  // Regression: inline callbacks re-attached the viewer's listeners every render.
  it('passes the FileViewer stable callbacks, never inline arrows', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./AssetLightbox.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).toMatch(/onClose=\{closeViewer\}/);
    expect(source).toMatch(/onLoadError=\{onViewerError\}/);
  });
});

describe('audit pass 2 regressions', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./AssetLightbox.tsx', import.meta.url)),
    'utf8',
  );

  // The viewer locked the body before the lightbox did, so closing both left
  // overflow: hidden behind. The lightbox now locks in a layout effect.
  it('takes its body scroll lock in a layout effect, ahead of the viewer', () => {
    expect(source).toMatch(
      /useBrowserLayoutEffect\(\(\) => \{\s*const previousOverflow = document\.body\.style\.overflow;/,
    );
  });

  // The image or video failure card keeps its old wording.
  it('a failed image keeps "Download to view"; a file without a version says Download', () => {
    const image = mount([asset(0, 'image/png', { kind: 'image' })], 0, { presignEnabled: false });
    expect(image).toContain('Download to view');
    const file = mount([asset(0, PDF_MIME, { currentVersionId: null })]);
    expect(file).not.toContain('Download to view');
    expect(file).toMatch(/<\/svg>Download<\/button>/);
  });
});

describe('a broken file never blanks the Assets page', () => {
  it('mounts the boundary-wrapped FileViewer, never the bare sheet', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./AssetLightbox.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).toMatch(/<FileViewer\b/);
    expect(source).not.toMatch(/FileViewerSheet/);
  });
});
