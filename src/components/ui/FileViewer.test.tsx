// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISMISS_DISTANCE,
  FileViewerFallback,
  FileViewerSheet,
  LIVE_PAGE_WINDOW,
  OfficeTooLargeError,
  PREVIEW_UNAVAILABLE,
  VIEWER_ERROR,
  clampZoom,
  currentPage,
  downloadFile,
  isLivePage,
  localFileSource,
  officeState,
  pageCounter,
  remoteFileSource,
  renderWidthPx,
  shouldDismiss,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { runOffice } from '@/lib/files/office/run';
import {
  DOCX_MIME,
  OFFICE_MAX_BYTES,
  XLSX_MIME,
  type OfficeResponse,
} from '@/lib/files/office/types';

// The office runner is replaced: jsdom has no Worker (its own tests cover it).
vi.mock('@/lib/files/office/run', () => ({ runOffice: vi.fn() }));
const mockedRun = vi.mocked(runOffice);

const source: FileViewerSource = {
  pdfBytes: async () => new Uint8Array(),
  officeBytes: async () => ({ bytes: new Uint8Array([1]), mime: DOCX_MIME }),
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

  it('a canvas stays near 4M pixels (five live pages fit iOS canvas memory)', () => {
    expect(renderWidthPx(390, 3, 1.294)).toBe(1170);
    const huge = renderWidthPx(390 * 4, 3, 1.294);
    expect(huge * huge * 1.294).toBeLessThanOrEqual(4_000_000);
  });

  it('swipe down closes past the distance or on a quick flick', () => {
    expect(shouldDismiss(DISMISS_DISTANCE, 1000)).toBe(true);
    expect(shouldDismiss(60, 50)).toBe(true);
    expect(shouldDismiss(60, 1000)).toBe(false);
    expect(shouldDismiss(10, 5)).toBe(false);
  });
});

describe('the sheet by kind', () => {
  it('any other file: "Preview not available yet", name, size and Download', () => {
    const html = sheet('file', 'light');
    expect(html).toContain(PREVIEW_UNAVAILABLE);
    expect(html).toContain('Brief for the Q3 launch.docx');
    expect(html).toContain('<span class="font-mono">47 KB</span>');
    expect(html.match(/Download/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-viewer-unavailable=""');
  });

  it('pdf, video and office start on a spinner, never blank', () => {
    expect(sheet('pdf', 'light')).toContain('aria-label="Loading"');
    expect(sheet('video', 'light')).toContain('aria-label="Loading"');
    expect(sheet('office', 'light')).toContain('aria-label="Loading"');
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
    for (const file of ['FileViewer.tsx', 'viewers/WordViewer.tsx', 'viewers/SheetViewer.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/components/ui', file), 'utf8');
      expect(src).not.toMatch(/translateX|translate3d|rotate\(|backdrop-filter|backdrop-blur/);
    }
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
      if (body.stream === true) {
        return new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }
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

describe('office: docx and xlsx open in place, pptx keeps the fallback', () => {
  const DOC: OfficeResponse = {
    ok: true,
    op: 'view',
    result: {
      kind: 'docx',
      pages: ['<p>Hello page one</p>'],
      pageCount: null,
      aspect: 1.29,
      margins: [0.1, 0.1, 0.1, 0.1],
    },
  };
  const BOOK: OfficeResponse = {
    ok: true,
    op: 'view',
    result: {
      kind: 'xlsx',
      sheets: [
        {
          name: 'Calendar',
          totalRows: 1,
          shownRows: 1,
          shownCols: 1,
          totalCols: 1,
          colWidths: [64],
          merges: [],
          cells: [{ r: 0, c: 0, text: 'Reel', kind: 's' }],
        },
      ],
    },
  };

  it('officeState routes each Worker answer', () => {
    expect(officeState(DOC).kind).toBe('docx');
    expect(officeState(BOOK).kind).toBe('xlsx');
    expect(officeState({ ok: true, op: 'view', result: { kind: 'unsupported' } })).toEqual({
      kind: 'unavailable',
    });
    for (const reason of ['too_large', 'locked', 'corrupt', 'timeout', 'failed'] as const) {
      expect(officeState({ ok: false, reason })).toEqual({ kind: 'error' });
    }
  });

  async function mount(
    officeSource: FileViewerSource,
  ): Promise<{ root: HTMLElement; unmount: () => void }> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <FileViewerSheet name="file.docx" kind="office" source={officeSource} onClose={() => {}} />,
      );
    });
    // Let the lazy viewer chunk resolve and render.
    for (
      let i = 0;
      i < 20 &&
      host.querySelector(
        '[data-word-frame], [data-sheet-viewer], [data-viewer-error], [data-viewer-unavailable]',
      ) === null;
      i++
    ) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    return {
      root: host,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  it('docx routes to the Word viewer: sandbox="" iframe with the CSP in srcdoc', async () => {
    mockedRun.mockResolvedValueOnce(DOC);
    const { root, unmount } = await mount(source);
    const frame = root.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame?.getAttribute('srcdoc')).toContain('Hello page one');
    expect(mockedRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: 'view', mime: DOCX_MIME, timeoutMs: 10_000 }),
    );
    // Closing aborts the parse (the runner terminates its Worker on abort).
    const signal = mockedRun.mock.lastCall?.[0].signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('xlsx routes to the Sheet viewer', async () => {
    mockedRun.mockResolvedValueOnce(BOOK);
    const { root, unmount } = await mount({
      ...source,
      officeBytes: async () => ({ bytes: new Uint8Array([1]), mime: XLSX_MIME }),
    });
    expect(root.querySelector('[data-sheet-viewer]')).not.toBeNull();
    expect(root.textContent).toContain('Reel');
    expect(root.querySelector('[data-word-frame]')).toBeNull();
    unmount();
  });

  it('pptx (no preview from the server) still shows "Preview not available yet" and Download', async () => {
    mockedRun.mockClear();
    const { root, unmount } = await mount({ ...source, officeBytes: async () => null });
    expect(root.textContent).toContain(PREVIEW_UNAVAILABLE);
    expect(root.querySelector('[data-viewer-unavailable] button')?.textContent).toContain(
      'Download',
    );
    expect(mockedRun).not.toHaveBeenCalled();
    unmount();
  });

  it('a timeout, a locked or corrupt file, or a byte failure is the error card with Download', async () => {
    mockedRun.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const first = await mount(source);
    expect(first.root.querySelector('[data-viewer-error]')?.textContent).toContain(VIEWER_ERROR);
    expect(first.root.textContent).toContain('Download');
    first.unmount();
    const second = await mount({
      ...source,
      officeBytes: async () => {
        throw new OfficeTooLargeError();
      },
    });
    expect(second.root.querySelector('[data-viewer-error]')).not.toBeNull();
    second.unmount();
  });

  it('remote: a fresh stream read per open; 400 (pptx) is no preview; over 20 MiB is refused', async () => {
    const statuses: Array<{ status: number; type?: string; length?: number }> = [
      { status: 200, type: DOCX_MIME },
      { status: 200, type: XLSX_MIME },
      { status: 400 },
      { status: 200, type: DOCX_MIME, length: OFFICE_MAX_BYTES + 1 },
    ];
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => {
      const next = statuses.shift();
      if (next === undefined || next.status !== 200)
        return new Response('{}', { status: next?.status ?? 500 });
      const headers: Record<string, string> = { 'Content-Type': next.type ?? '' };
      if (next.length !== undefined) headers['Content-Length'] = String(next.length);
      return new Response(new Uint8Array([80, 75, 3, 4]), { headers });
    });
    const remote = remoteFileSource(
      new PresignCache({
        endpoint: 'https://asset-read',
        getAccessToken: async () => 'tok',
        fetcher,
      }),
      'v9',
    );
    const signal = new AbortController().signal;
    expect(await remote.officeBytes(signal)).toEqual({
      bytes: new Uint8Array([80, 75, 3, 4]),
      mime: DOCX_MIME,
    });
    expect((await remote.officeBytes(signal))?.mime).toBe(XLSX_MIME);
    expect(await remote.officeBytes(signal)).toBeNull();
    await expect(remote.officeBytes(signal)).rejects.toBeInstanceOf(OfficeTooLargeError);
    const bodies = fetcher.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as unknown);
    expect(bodies).toEqual(
      Array.from({ length: 4 }, () => ({ asset_version_id: 'v9', stream: true })),
    );
  });

  it("local: the sender's own file, refused over 20 MiB before reading", async () => {
    const small = localFileSource(
      new File([new Uint8Array([1, 2])], 'a.docx', { type: DOCX_MIME }),
    );
    expect(await small.officeBytes(new AbortController().signal)).toEqual({
      bytes: new Uint8Array([1, 2]),
      mime: null,
    });
    const big = localFileSource(
      new File([new Uint8Array(OFFICE_MAX_BYTES + 1)], 'b.docx', { type: DOCX_MIME }),
    );
    await expect(big.officeBytes(new AbortController().signal)).rejects.toBeInstanceOf(
      OfficeTooLargeError,
    );
  });
});
