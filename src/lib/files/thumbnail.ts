// Sender-side thumbnails for chat files (decision 149: new uploads only). A PDF
// gets page 1 drawn by pdf.js plus its page count; a video gets one frame near
// its start. Everything else has no thumbnail. The result is a JPEG at most
// 580px wide (never upscaled) and 1160px tall (cropped from the top), quality
// 0.8, stepped to 0.6 when over 300 KiB; still over that is no thumbnail.
//
// makeThumbnail never throws and never runs past THUMBNAIL_TIMEOUT_MS: any
// error, timeout or abort is NoThumbnail, so an upload never waits on it or
// fails because of it. pdf.js is loaded with a dynamic import only (never in
// the main chunk), its worker through a Vite asset URL. Every pdf.js task,
// canvas, blob URL and timer is released in a finally.

/** Files larger than this are never decoded for a thumbnail. */
export const THUMBNAIL_SOURCE_MAX_BYTES = 60 * 1024 * 1024;
/** Hard cap on one thumbnail attempt; past it the attempt is NoThumbnail. */
export const THUMBNAIL_TIMEOUT_MS = 4000;
export const THUMBNAIL_MAX_WIDTH = 580;
export const THUMBNAIL_MAX_HEIGHT = 1160;
export const THUMBNAIL_MAX_BYTES = 300 * 1024;
const QUALITY_FIRST = 0.8;
const QUALITY_SECOND = 0.6;

export interface Thumbnail {
  ok: true;
  blob: Blob;
  width: number;
  height: number;
  /** PDFs only: the document's page count. */
  pageCount?: number;
}

export interface NoThumbnail {
  ok: false;
  reason: 'unsupported' | 'too_large' | 'timeout' | 'aborted' | 'failed' | 'oversize_output';
}

export type ThumbnailResult = Thumbnail | NoThumbnail;

/** Which thumbnail path a mime takes, or null for none. */
export function thumbnailKind(mime: string): 'pdf' | 'video' | null {
  const m = mime.toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  return null;
}

/**
 * The output box for a source of `width` x `height`: scaled down to at most
 * THUMBNAIL_MAX_WIDTH wide (never up), then cropped to THUMBNAIL_MAX_HEIGHT
 * from the top. `scale` maps source units to output pixels. Pure.
 */
export function thumbnailBox(
  width: number,
  height: number,
): { scale: number; width: number; height: number } {
  const scale = width > THUMBNAIL_MAX_WIDTH ? THUMBNAIL_MAX_WIDTH / width : 1;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.min(Math.round(height * scale), THUMBNAIL_MAX_HEIGHT));
  return { scale, width: outWidth, height: outHeight };
}

// ---------------------------------------------------------------------------
// pdf.js: the narrow surface used here and by the viewer.
// ---------------------------------------------------------------------------

export interface PdfViewportLike {
  width: number;
  height: number;
}

export interface PdfRenderTaskLike {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    viewport: PdfViewportLike;
    annotationMode?: number;
  }): PdfRenderTaskLike;
  cleanup(): boolean | void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}

export interface PdfJsLike {
  getDocument(params: {
    data: Uint8Array;
    isEvalSupported: false;
    enableXfa: false;
    disableFontFace?: boolean;
    stopAtErrors?: boolean;
  }): PdfLoadingTaskLike;
  /** pdf.js AnnotationMode; DISABLE keeps link and form annotations off the canvas. */
  AnnotationMode: { DISABLE: number };
}

let pdfJsPromise: Promise<PdfJsLike> | null = null;

/**
 * Load pdf.js (legacy build, for iOS Safari 16) and point it at its worker,
 * once per session. Dynamic imports only, so neither file joins the main chunk.
 */
export function loadPdfJs(): Promise<PdfJsLike> {
  pdfJsPromise ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url'),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs as unknown as PdfJsLike;
    })
    .catch((error: unknown) => {
      pdfJsPromise = null;
      throw error;
    });
  return pdfJsPromise;
}

/** Open a PDF from bytes with scripting, eval and XFA off. */
export function openPdf(pdfjs: PdfJsLike, data: Uint8Array): PdfLoadingTaskLike {
  return pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false });
}

// ---------------------------------------------------------------------------
// Canvas and video seams (injected by tests; the browser defaults below).
// ---------------------------------------------------------------------------

export interface ThumbnailDeps {
  loadPdf: () => Promise<PdfJsLike>;
  createCanvas: () => HTMLCanvasElement;
  /** JPEG-encode a canvas; null when the browser cannot. */
  encode: (canvas: HTMLCanvasElement, quality: number) => Promise<Blob | null>;
  /** Draw one early frame of a video file onto a fresh canvas; see grabVideoFrame. */
  videoFrame: (file: File, signal: AbortSignal) => Promise<HTMLCanvasElement>;
  readBytes: (file: File) => Promise<Uint8Array>;
}

function createBrowserCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('no document');
  return document.createElement('canvas');
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/** Free a canvas's backing store now (iOS Safari keeps it until GC otherwise). */
export function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (canvas === null) return;
  canvas.width = 0;
  canvas.height = 0;
}

function once(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      target.removeEventListener(type, done);
      target.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
      resolve();
    };
    const fail = (): void => {
      target.removeEventListener(type, done);
      target.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
      reject(new Error(`video ${type} failed`));
    };
    target.addEventListener(type, done);
    target.addEventListener('error', fail);
    signal.addEventListener('abort', fail);
  });
}

/**
 * One frame of a video, muted and inline (no fullscreen on iOS), seeked to
 * min(1 s, 10% of its length). The blob URL is revoked and the element emptied
 * in a finally, whatever happens.
 */
async function grabVideoFrame(file: File, signal: AbortSignal): Promise<HTMLCanvasElement> {
  if (typeof document === 'undefined') throw new Error('no document');
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  try {
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    // iOS Safari may skip preloading a paused blob, so loadeddata can never
    // fire: wait for metadata only, then always seek, which decodes a frame.
    const loaded = once(video, 'loadedmetadata', signal);
    video.src = url;
    await loaded;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const at = Math.max(Math.min(1, duration * 0.1), 0.001);
    const seeked = once(video, 'seeked', signal);
    video.currentTime = at;
    await seeked;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) throw new Error('video has no frame size');
    const box = thumbnailBox(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      releaseCanvas(canvas);
      throw new Error('no 2d context');
    }
    ctx.drawImage(video, 0, 0, Math.round(width * box.scale), Math.round(height * box.scale));
    return canvas;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export const browserThumbnailDeps: ThumbnailDeps = {
  loadPdf: loadPdfJs,
  createCanvas: createBrowserCanvas,
  encode: encodeJpeg,
  videoFrame: grabVideoFrame,
  readBytes: readFileBytes,
};

// ---------------------------------------------------------------------------
// makeThumbnail
// ---------------------------------------------------------------------------

/**
 * Render page 1 into a fresh canvas held in `held` (the caller releases it).
 * The loading task lives in `held` too, so the caller destroys it however this
 * ends; a late step after an abort throws instead of starting more work.
 */
async function renderPdfPage1(
  deps: ThumbnailDeps,
  file: File,
  signal: AbortSignal,
  held: Held,
): Promise<{ canvas: HTMLCanvasElement; pageCount: number }> {
  const pdfjs = await deps.loadPdf();
  const bytes = await deps.readBytes(file);
  if (signal.aborted) throw new Error('aborted');
  held.task = openPdf(pdfjs, bytes);
  const doc = await held.task.promise;
  const page = await doc.getPage(1);
  if (signal.aborted) throw new Error('aborted');
  const natural = page.getViewport({ scale: 1 });
  const box = thumbnailBox(natural.width, natural.height);
  const viewport = page.getViewport({ scale: box.scale });
  const canvas = deps.createCanvas();
  held.canvas = canvas;
  canvas.width = box.width;
  canvas.height = box.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  // A white page under the drawing: a transparent PDF must not encode black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, box.width, box.height);
  await page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    annotationMode: pdfjs.AnnotationMode.DISABLE,
  }).promise;
  page.cleanup();
  return { canvas, pageCount: doc.numPages };
}

/** What one attempt holds until its finally: the pdf.js task and the canvas. */
interface Held {
  task: PdfLoadingTaskLike | null;
  canvas: HTMLCanvasElement | null;
}

/** Destroy the task and free the canvas; safe to call twice. */
function releaseHeld(held: Held): void {
  const task = held.task;
  held.task = null;
  if (task !== null) void task.destroy().catch(() => undefined);
  releaseCanvas(held.canvas);
  held.canvas = null;
}

/** Encode at 0.8, then 0.6 when over the byte cap; null when still over or unencodable. */
async function encodeWithinCap(
  deps: ThumbnailDeps,
  canvas: HTMLCanvasElement,
): Promise<Blob | null> {
  const first = await deps.encode(canvas, QUALITY_FIRST);
  if (first === null) return null;
  if (first.size <= THUMBNAIL_MAX_BYTES) return first;
  const second = await deps.encode(canvas, QUALITY_SECOND);
  if (second === null || second.size > THUMBNAIL_MAX_BYTES) return null;
  return second;
}

/**
 * Make the thumbnail for one picked file. Never throws; NoThumbnail for any
 * other kind, an oversize source, an error, the caller's abort or the time cap.
 */
export async function makeThumbnail(
  file: File,
  signal: AbortSignal,
  deps: ThumbnailDeps = browserThumbnailDeps,
  timeoutMs: number = THUMBNAIL_TIMEOUT_MS,
): Promise<ThumbnailResult> {
  const kind = thumbnailKind(file.type);
  if (kind === null) return { ok: false, reason: 'unsupported' };
  if (file.size > THUMBNAIL_SOURCE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  if (signal.aborted) return { ok: false, reason: 'aborted' };
  // No DOM (a Worker or a unit test runtime): nothing to draw on.
  if (deps === browserThumbnailDeps && typeof document === 'undefined') {
    return { ok: false, reason: 'unsupported' };
  }

  const local = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: ((result: NoThumbnail) => void) | undefined;
  const stop = new Promise<NoThumbnail>((resolve) => {
    stopped = resolve;
  });
  const onAbort = (): void => {
    local.abort();
    stopped?.({ ok: false, reason: 'aborted' });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => {
    local.abort();
    stopped?.({ ok: false, reason: 'timeout' });
  }, timeoutMs);

  // The work owns its task and canvas: they are released in its own finally,
  // so a render that outlives the cap still frees them when it settles.
  const work = async (): Promise<ThumbnailResult> => {
    const held: Held = { task: null, canvas: null };
    // Past the cap or on abort the pdf.js task is torn down at once, which
    // rejects a render still in flight.
    const onStop = (): void => {
      const task = held.task;
      held.task = null;
      if (task !== null) void task.destroy().catch(() => undefined);
    };
    local.signal.addEventListener('abort', onStop, { once: true });
    try {
      let pageCount: number | undefined;
      if (kind === 'pdf') {
        pageCount = (await renderPdfPage1(deps, file, local.signal, held)).pageCount;
      } else {
        held.canvas = await deps.videoFrame(file, local.signal);
      }
      const canvas = held.canvas;
      if (canvas === null || local.signal.aborted) return { ok: false, reason: 'aborted' };
      const blob = await encodeWithinCap(deps, canvas);
      if (blob === null) return { ok: false, reason: 'oversize_output' };
      return {
        ok: true,
        blob,
        width: canvas.width,
        height: canvas.height,
        ...(pageCount !== undefined ? { pageCount } : {}),
      };
    } catch {
      return { ok: false, reason: 'failed' };
    } finally {
      local.signal.removeEventListener('abort', onStop);
      releaseHeld(held);
    }
  };

  try {
    return await Promise.race([work(), stop]);
  } finally {
    clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener('abort', onAbort);
    // Stops a late step of the work; its finally then frees what it holds.
    local.abort();
  }
}

/** One thumbnail attempt per picked File for the session (bubble and upload share it). */
const shared = new WeakMap<File, Promise<ThumbnailResult>>();

/**
 * The thumbnail for a picked file, made once: the sending bubble shows it and
 * the upload sends it. Bounded by THUMBNAIL_TIMEOUT_MS like makeThumbnail.
 */
export function sharedThumbnail(file: File): Promise<ThumbnailResult> {
  const known = shared.get(file);
  if (known !== undefined) return known;
  const promise = makeThumbnail(file, new AbortController().signal);
  shared.set(file, promise);
  return promise;
}
