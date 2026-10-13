import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISMISS_DISTANCE,
  FileViewerFallback,
  FileViewerSheet,
  LIVE_PAGE_WINDOW,
  PREVIEW_UNAVAILABLE,
  VIEWER_ERROR,
  clampZoom,
  currentPage,
  downloadFile,
  isLivePage,
  localFileSource,
  pageCounter,
  remoteFileSource,
  renderWidthPx,
  shouldDismiss,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';

const source: FileViewerSource = {
  pdfBytes: async () => new Uint8Array(),
  videoLink: async () => ({ url: 'https://signed/v', release: () => {} }),
  downloadLink: async () => ({ url: 'https://signed/d', release: () => {} }),
};

function sheet(kind: 'pdf' | 'video' | 'office' | 'file', theme: 'light' | 'dark'): string {
  return renderToStaticMarkup(
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <FileViewerSheet
        name="Brief for the Q3 launch.docx"
        kind={kind}
        size={48_000}
        source={source}
        onClose={() => {}}
      />
    </div>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pure helpers', () => {
  it('the counter reads "3 / 12"', () => {
    expect(pageCounter(3, 12)).toBe('3 / 12');
  });

  it('zoom stays within 1..4', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.2)).toBe(2.2);
    expect(clampZoom(9)).toBe(4);
  });

  it('the current page is the one under the reading line, clamped', () => {
    expect(currentPage(0, 900, 1000, 12)).toBe(1);
    expect(currentPage(2000, 900, 1000, 12)).toBe(3);
    expect(currentPage(99_999, 900, 1000, 12)).toBe(12);
    expect(currentPage(0, 900, 0, 0)).toBe(1);
  });

  it('only pages near the current one hold a canvas (cap on live canvases)', () => {
    const live = Array.from({ length: 200 }, (_, i) => i + 1).filter((p) => isLivePage(p, 100));
    expect(live).toHaveLength(LIVE_PAGE_WINDOW * 2 + 1);
    expect(live).toEqual([98, 99, 100, 101, 102]);
  });

  it('a canvas stays under the iOS pixel cap', () => {
    expect(renderWidthPx(390, 3, 1.294)).toBe(1170);
    const huge = renderWidthPx(390 * 4, 3, 1.294);
    expect(huge * huge * 1.294).toBeLessThanOrEqual(16_000_000);
  });

  it('swipe down closes past the distance or on a quick flick', () => {
    expect(shouldDismiss(DISMISS_DISTANCE, 1000)).toBe(true);
    expect(shouldDismiss(60, 50)).toBe(true);
    expect(shouldDismiss(60, 1000)).toBe(false);
    expect(shouldDismiss(10, 5)).toBe(false);
  });
});

describe('the sheet by kind', () => {
  it('office: "Preview not available yet", name, size and Download', () => {
    const html = sheet('office', 'light');
    expect(html).toContain(PREVIEW_UNAVAILABLE);
    expect(html).toContain('Brief for the Q3 launch.docx');
    expect(html).toContain('<span class="font-mono">47 KB</span>');
    expect(html.match(/Download/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-viewer-unavailable=""');
  });

  it('any other file gets the same slot as office', () => {
    expect(sheet('file', 'light')).toContain(PREVIEW_UNAVAILABLE);
  });

  it('pdf and video start on a spinner, never blank', () => {
    expect(sheet('pdf', 'light')).toContain('aria-label="Loading"');
    expect(sheet('video', 'light')).toContain('aria-label="Loading"');
  });

  it('top bar: close X, the name, Download; 44px buttons, no selection on chrome', () => {
    const html = sheet('pdf', 'light');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('aria-label="Download"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('[-webkit-touch-callout:none]');
    expect(html).toContain('role="dialog" aria-modal="true"');
  });

  it('motion is translateY only (no X, no rotate)', () => {
    expect(sheet('pdf', 'light')).toContain('transform:translateY(0px)');
    const src = readFileSync(fileURLToPath(new URL('./FileViewer.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/translateX|translate3d|rotate\(|backdrop-filter|backdrop-blur/);
  });

  it('light and dark: the same overlay-token markup, no hex, no dark: variants', () => {
    for (const kind of ['pdf', 'video', 'office'] as const) {
      const light = sheet(kind, 'light');
      const dark = sheet(kind, 'dark');
      expect(dark.replace('<div class="dark">', '<div>')).toBe(light);
      expect(light).not.toMatch(/#[0-9a-fA-F]{3,8}\b|dark:|bg-white|bg-black/);
    }
  });

  it('the crash fallback can still close and download', () => {
    const html = renderToStaticMarkup(
      <FileViewerFallback name="x.pdf" source={source} onClose={() => {}} />,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain(VIEWER_ERROR.replace("'", '&#x27;'));
    expect(html).toContain('Download');
  });
});

describe('sources: a fresh read on every open', () => {
  function deps(): {
    deps: PresignDeps;
    fetcher: ReturnType<typeof vi.fn<PresignDeps['fetcher']>>;
  } {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream === true) return new Response(new Uint8Array([37, 80, 68, 70]));
      return new Response(
        JSON.stringify({ url: 'https://signed/x', expires_at: '2999-01-01T00:00:00Z' }),
      );
    });
    return {
      fetcher,
      deps: { endpoint: 'https://asset-read', getAccessToken: async () => 'tok', fetcher },
    };
  }

  it('remote: PDF bytes through the Worker stream, links presigned fresh each time', async () => {
    const { deps: d, fetcher } = deps();
    const remote = remoteFileSource(new PresignCache(d), 'v1');
    expect(Array.from(await remote.pdfBytes(new AbortController().signal))).toEqual([
      37, 80, 68, 70,
    ]);
    await remote.videoLink();
    await remote.videoLink();
    await remote.downloadLink();
    const bodies = fetcher.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as unknown);
    expect(bodies).toEqual([
      { asset_version_id: 'v1', stream: true },
      { asset_version_id: 'v1' },
      { asset_version_id: 'v1' },
      { asset_version_id: 'v1', disposition: 'attachment' },
    ]);
  });

  it('local: the picked file opens before its upload; blob links are released', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        created.push('blob:1');
        return 'blob:1';
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    const local = localFileSource(new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));
    expect((await local.pdfBytes(new AbortController().signal)).byteLength).toBe(4);
    const link = await local.videoLink();
    link.release();
    expect(created).toEqual(['blob:1']);
    expect(revoked).toEqual(['blob:1']);
  });

  it('Download saves through a same-window link: never a new tab', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      target: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    });
    expect(await downloadFile(source, 'deck.pdf')).toBe(true);
    expect(anchor.href).toBe('https://signed/d');
    expect(anchor.download).toBe('deck.pdf');
    expect(anchor.target).toBe('');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    const failing: FileViewerSource = {
      ...source,
      downloadLink: async () => {
        throw new Error('nope');
      },
    };
    expect(await downloadFile(failing, 'deck.pdf')).toBe(false);
  });
});
