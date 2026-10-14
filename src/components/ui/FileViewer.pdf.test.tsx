// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAGE_ASPECT,
  FileViewerFallback,
  FileViewerSheet,
  VIEWER_ERROR,
  remoteFileSource,
  viewerTone,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { PresignCache } from '@/lib/asset-presign';
import { loadPdfJs, type PdfDocumentLike, type PdfJsLike } from '@/lib/files/thumbnail';

// The PDF path for every caller (assets, posts, chat): no spinner, no black
// backdrop, a preview or page-shaped placeholder from the first frame, the real
// page in the same box, and an error with Retry. pdf.js is faked: jsdom has no
// canvas or worker.
vi.mock('@/lib/files/thumbnail', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/files/thumbnail')>();
  return { ...actual, loadPdfJs: vi.fn() };
});
const mockedLoad = vi.mocked(loadPdfJs);

function fakePdfJs(aspect: number, pages = 3): PdfJsLike {
  const doc: PdfDocumentLike = {
    numPages: pages,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 100 * aspect * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      cleanup: () => {},
    }),
  };
  return {
    getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }),
    AnnotationMode: { DISABLE: 0 },
  };
}

function pdfSource(over: Partial<FileViewerSource> = {}): FileViewerSource {
  return {
    pdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
    officeBytes: async () => null,
    videoLink: async () => ({ url: 'https://signed/v', release: () => {} }),
    downloadLink: async () => ({ url: 'https://signed/d', release: () => {} }),
    previewNow: () => null,
    preview: async () => null,
    ...over,
  };
}

function markup(source: FileViewerSource, theme: 'light' | 'dark'): string {
  return renderToStaticMarkup(
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <FileViewerSheet name="Launch deck.pdf" kind="pdf" source={source} onClose={() => {}} />
    </div>,
  );
}

/** Every element's class list, so a test can look for one class without substring hits. */
function classes(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/));
}

async function mount(source: FileViewerSource): Promise<{
  host: HTMLElement;
  flush: () => Promise<void>;
  unmount: () => void;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <FileViewerSheet name="Launch deck.pdf" kind="pdf" source={source} onClose={() => {}} />,
    );
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  return {
    host,
    flush,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => {
  mockedLoad.mockReset();
  vi.unstubAllGlobals();
});

describe('PDF viewer: first frame', () => {
  it('only the PDF uses the theme surface; video, office and files keep the overlay', () => {
    expect(viewerTone('pdf')).toBe('surface');
    expect(viewerTone('video')).toBe('overlay');
    expect(viewerTone('office')).toBe('overlay');
    expect(viewerTone('file')).toBe('overlay');
  });

  it('never renders a spinner or the black overlay backdrop, light and dark', () => {
    for (const theme of ['light', 'dark'] as const) {
      const html = markup(pdfSource(), theme);
      expect(html).not.toContain('aria-label="Loading"');
      expect(html).not.toContain('animate-spin');
      const all = classes(html);
      expect(all).not.toContain('bg-overlay');
      expect(all).toContain('bg-panel-2');
      expect(html).toContain('data-viewer-tone="surface"');
      // Tokens only: no hex, no dark: literals, the same markup in both themes.
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:|bg-white|bg-black/);
    }
    expect(markup(pdfSource(), 'dark').replace('<div class="dark">', '<div>')).toBe(
      markup(pdfSource(), 'light'),
    );
  });

  it('with no preview yet: a page-shaped placeholder with the file name', () => {
    const html = markup(pdfSource(), 'light');
    expect(html).toContain('data-pdf-placeholder=""');
    expect(html).toContain('Launch deck.pdf');
    expect(html).toContain(`aspect-ratio:1 / ${DEFAULT_PAGE_ASPECT}`);
    expect(html).not.toContain('data-pdf-preview');
  });

  it('with a preview at hand: the first-page preview paints on the first frame', () => {
    const html = markup(pdfSource({ previewNow: () => 'https://signed/thumb' }), 'light');
    expect(html).toContain('data-pdf-preview=""');
    expect(html).toContain('src="https://signed/thumb"');
    expect(html).not.toContain('data-pdf-placeholder');
  });

  it('a remote source reads the cached stored thumbnail synchronously', () => {
    const cache = new PresignCache({
      endpoint: 'https://asset-read',
      getAccessToken: async () => 'tok',
      fetcher: vi.fn(),
    });
    vi.spyOn(cache, 'peekThumbnail').mockReturnValue({
      url: 'https://signed/thumb-v1',
      expiresAt: Date.now() + 600_000,
    });
    expect(remoteFileSource(cache, 'v1').previewNow()).toBe('https://signed/thumb-v1');
  });

  it('the crash fallback for a PDF sits on the surface too', () => {
    const html = renderToStaticMarkup(
      <FileViewerFallback name="x.pdf" kind="pdf" source={pdfSource()} onClose={() => {}} />,
    );
    expect(classes(html)).not.toContain('bg-overlay');
    expect(classes(html)).toContain('bg-panel-2');
  });
});

describe('PDF viewer: the swap', () => {
  it('the real pages draw into the same page-1 box, no size change', async () => {
    mockedLoad.mockResolvedValue(fakePdfJs(DEFAULT_PAGE_ASPECT));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await mount(
      pdfSource({
        pdfBytes: async () => {
          await gate;
          return new Uint8Array([37, 80, 68, 70]);
        },
      }),
    );
    const scroller = view.host.querySelector('[data-pdf-scroller]');
    expect(scroller?.getAttribute('data-pdf-state')).toBe('preview');
    const before = view.host.querySelector<HTMLElement>('[data-pdf-page="1"]');
    const beforeStyle = before?.getAttribute('style');
    const beforeColumn = before?.parentElement?.getAttribute('style');
    expect(before).not.toBeNull();

    release();
    await view.flush();
    expect(scroller?.getAttribute('data-pdf-state')).toBe('ready');
    const after = view.host.querySelector<HTMLElement>('[data-pdf-page="1"]');
    // The same element, the same box: the page draws in place.
    expect(after).toBe(before);
    expect(after?.getAttribute('style')).toBe(beforeStyle);
    expect(after?.parentElement?.getAttribute('style')).toBe(beforeColumn);
    expect(after?.querySelector('canvas')).not.toBeNull();
    expect(view.host.querySelectorAll('[data-pdf-page]')).toHaveLength(3);
    expect(view.host.querySelector('[aria-label="Loading"]')).toBeNull();
    view.unmount();
  });

  it('a late preview replaces the placeholder in the same box', async () => {
    mockedLoad.mockReturnValue(new Promise<PdfJsLike>(() => {}));
    const view = await mount(
      pdfSource({ preview: async () => ({ url: 'blob:thumb', release: () => {} }) }),
    );
    await view.flush();
    const page = view.host.querySelector('[data-pdf-page="1"]');
    expect(page?.querySelector('[data-pdf-preview]')?.getAttribute('src')).toBe('blob:thumb');
    expect(page?.querySelector('[data-pdf-placeholder]')).toBeNull();
    view.unmount();
  });

  it('a failed open shows the error with Retry, never a blank sheet; Retry reopens', async () => {
    mockedLoad.mockResolvedValue(fakePdfJs(DEFAULT_PAGE_ASPECT));
    const pdfBytes = vi
      .fn<FileViewerSource['pdfBytes']>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    const view = await mount(pdfSource({ pdfBytes }));
    await view.flush();
    const error = view.host.querySelector('[data-viewer-error]');
    expect(error?.textContent).toContain(VIEWER_ERROR);
    const retry = Array.from(error?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    expect(view.host.querySelector('[aria-label="Loading"]')).toBeNull();
    await act(async () => {
      retry?.click();
    });
    await view.flush();
    expect(pdfBytes).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector('[data-pdf-scroller]')?.getAttribute('data-pdf-state')).toBe(
      'ready',
    );
    view.unmount();
  });
});
