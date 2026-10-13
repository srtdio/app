import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_SOURCE_MAX_BYTES,
  makeThumbnail,
  thumbnailBox,
  thumbnailKind,
  type PdfJsLike,
  type PdfLoadingTaskLike,
  type ThumbnailDeps,
} from '@/lib/files/thumbnail';

// The PDF path runs the real pdf.js legacy build (the one the app ships) on
// PDFs generated here. Node has no canvas, so pages render into a recording
// 2D context; the JPEG encoder is a fake that reports a chosen size. A real
// video frame needs a decoder node does not have: the video path is covered
// with an injected frame grabber here and in the browser by e2e.

const require = createRequire(import.meta.url);

/** A minimal valid PDF with `pages` US Letter pages, each with one filled box. */
function makePdf(pages: number): Uint8Array {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: string[] = [];
  for (let i = 0; i < pages; i += 1) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R >>`,
    );
    const stream = `0 0 1 rg 50 50 ${100 + i} 200 re f`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function pdfFile(pages: number): File {
  return new File([makePdf(pages).slice().buffer as ArrayBuffer], 'brief.pdf', {
    type: 'application/pdf',
  });
}

async function realPdfJs(): Promise<PdfJsLike> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;
  return pdfjs as unknown as PdfJsLike;
}

interface FakeCanvas {
  canvas: HTMLCanvasElement;
  calls: string[];
}

/** A canvas whose 2D context records every call and returns harmless values. */
function fakeCanvas(): FakeCanvas {
  const calls: string[] = [];
  const box = { width: 0, height: 0 } as { width: number; height: number };
  const ctx: Record<string | symbol, unknown> = {};
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'canvas') return box;
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {
        calls.push(String(prop));
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  Object.assign(box, { getContext: () => proxy });
  return { canvas: box as unknown as HTMLCanvasElement, calls };
}

function deps(over: Partial<ThumbnailDeps> = {}): {
  deps: ThumbnailDeps;
  canvases: FakeCanvas[];
  encode: ReturnType<typeof vi.fn<ThumbnailDeps['encode']>>;
} {
  const canvases: FakeCanvas[] = [];
  const encode = vi.fn<ThumbnailDeps['encode']>(
    async () => new Blob([new Uint8Array(40 * 1024)], { type: 'image/jpeg' }),
  );
  return {
    canvases,
    encode,
    deps: {
      loadPdf: realPdfJs,
      createCanvas: () => {
        const c = fakeCanvas();
        canvases.push(c);
        return c.canvas;
      },
      encode,
      videoFrame: async () => {
        throw new Error('no video here');
      },
      readBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
      ...over,
    },
  };
}

describe('thumbnailBox: width <= 580 (never up), height <= 1160 (crop top)', () => {
  it('scales a US Letter page to 580 wide', () => {
    expect(thumbnailBox(612, 792)).toEqual({ scale: 580 / 612, width: 580, height: 751 });
  });
  it('never upscales a small source', () => {
    expect(thumbnailBox(320, 240)).toEqual({ scale: 1, width: 320, height: 240 });
  });
  it('crops a very tall page at 1160', () => {
    expect(thumbnailBox(580, 3000)).toEqual({ scale: 1, width: 580, height: 1160 });
  });
});

describe('thumbnailKind', () => {
  it('pdf and video only', () => {
    expect(thumbnailKind('application/pdf')).toBe('pdf');
    expect(thumbnailKind('video/mp4')).toBe('video');
    expect(thumbnailKind('image/png')).toBeNull();
    expect(
      thumbnailKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(null);
  });
});

describe('makeThumbnail', () => {
  it('a one-page PDF: page 1 as a 580px JPEG with pageCount 1, canvas released', async () => {
    const { deps: d, canvases, encode } = deps();
    const result = await makeThumbnail(pdfFile(1), new AbortController().signal, d);
    expect(result).toMatchObject({ ok: true, width: 580, height: 751, pageCount: 1 });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]?.[1]).toBe(0.8);
    // pdf.js really drew the page's box onto the canvas.
    expect(canvases[0]?.calls).toContain('fillRect');
    // Released in the finally: the backing store is gone.
    expect(canvases[0]?.canvas.width).toBe(0);
    expect(canvases[0]?.canvas.height).toBe(0);
  });

  it('a multi-page PDF reports its page count and draws page 1 only', async () => {
    const { deps: d, canvases } = deps();
    const result = await makeThumbnail(pdfFile(7), new AbortController().signal, d);
    expect(result).toMatchObject({ ok: true, pageCount: 7 });
    expect(canvases).toHaveLength(1);
  });

  it('steps to quality 0.6 when 0.8 is over 300 KiB', async () => {
    const encode = vi.fn<ThumbnailDeps['encode']>(
      async (_canvas, quality) =>
        new Blob([new Uint8Array(quality === 0.8 ? THUMBNAIL_MAX_BYTES + 1 : 1000)]),
    );
    const { deps: d } = deps({ encode });
    const result = await makeThumbnail(pdfFile(1), new AbortController().signal, d);
    expect(result.ok).toBe(true);
    expect(encode.mock.calls.map((c) => c[1])).toEqual([0.8, 0.6]);
  });

  it('still over 300 KiB at 0.6 is no thumbnail', async () => {
    const encode = vi.fn<ThumbnailDeps['encode']>(
      async () => new Blob([new Uint8Array(THUMBNAIL_MAX_BYTES + 1)]),
    );
    const { deps: d } = deps({ encode });
    const result = await makeThumbnail(pdfFile(1), new AbortController().signal, d);
    expect(result).toEqual({ ok: false, reason: 'oversize_output' });
  });

  it('skips a source over 60 MiB without reading it', async () => {
    const file = pdfFile(1);
    Object.defineProperty(file, 'size', { value: THUMBNAIL_SOURCE_MAX_BYTES + 1 });
    const readBytes = vi.fn<ThumbnailDeps['readBytes']>();
    const { deps: d } = deps({ readBytes });
    const result = await makeThumbnail(file, new AbortController().signal, d);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('any other kind is no thumbnail', async () => {
    const { deps: d } = deps();
    const docx = new File(['x'], 'a.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(await makeThumbnail(docx, new AbortController().signal, d)).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('a broken PDF is no thumbnail (never throws)', async () => {
    const { deps: d } = deps();
    const broken = new File(['%PDF-1.4 nope'], 'x.pdf', { type: 'application/pdf' });
    const result = await makeThumbnail(broken, new AbortController().signal, d);
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  it('times out at the cap and destroys the pdf.js task', async () => {
    const destroy = vi.fn(async () => undefined);
    const hung: PdfLoadingTaskLike = { promise: new Promise(() => undefined), destroy };
    const fakePdfJs: PdfJsLike = {
      getDocument: () => hung,
      AnnotationMode: { DISABLE: 0 },
    };
    const { deps: d } = deps({ loadPdf: async () => fakePdfJs });
    const started = Date.now();
    const result = await makeThumbnail(pdfFile(1), new AbortController().signal, d, 50);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('an abort from the caller ends it at once', async () => {
    const controller = new AbortController();
    const { deps: d } = deps({ loadPdf: () => new Promise(() => undefined) });
    const pending = makeThumbnail(pdfFile(1), controller.signal, d);
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    const already = await makeThumbnail(pdfFile(1), controller.signal, d);
    expect(already).toEqual({ ok: false, reason: 'aborted' });
  });

  it('a video frame from the grabber becomes the thumbnail, canvas released', async () => {
    const frame = fakeCanvas();
    frame.canvas.width = 580;
    frame.canvas.height = 326;
    const videoFrame = vi.fn<ThumbnailDeps['videoFrame']>(async () => frame.canvas);
    const { deps: d } = deps({ videoFrame });
    const video = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    const result = await makeThumbnail(video, new AbortController().signal, d);
    expect(result).toMatchObject({ ok: true, width: 580, height: 326 });
    expect(result.ok && result.pageCount).toBe(undefined);
    expect(frame.canvas.width).toBe(0);
  });

  it('a failing video grabber is no thumbnail', async () => {
    const { deps: d } = deps();
    const video = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    expect(await makeThumbnail(video, new AbortController().signal, d)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('with no DOM the browser defaults bail out at once', async () => {
    const result = await makeThumbnail(pdfFile(1), new AbortController().signal);
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });
});
