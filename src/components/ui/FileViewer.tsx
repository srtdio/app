// The in-app file viewer: a full-screen sheet chat files open in, so a file
// never leaves for another tab or window. It portals to document.body above
// the thread, locks body scroll, traps and restores focus, closes on X, Esc or
// a swipe down (translateY only), and renders by kind through a renderer slot:
//
//  - pdf: pdf.js canvases (eval, XFA and scripting off, no annotation layer,
//    so links are inert). Pages render only near the viewport and far ones are
//    released, so at most LIVE_PAGE_WINDOW * 2 + 1 canvases exist at once.
//    Pinch and double-tap zoom; a mono "3 / 12" counter.
//  - video: the native player on a fresh presigned URL.
//  - office: docx and xlsx are parsed on the device in a Web Worker (10 s cap,
//    20 MiB cap, terminated on close) and drawn by WordViewer (a sandboxed
//    iframe) or SheetViewer (React text nodes only); both load lazily, never
//    in the main chunk. pptx keeps "Preview not available yet" with Download.
//  - any other file: "Preview not available yet" with Download.
//
// Every open asks for fresh bytes or a fresh link (PDF, docx and xlsx bytes
// come through the asset-read Worker's stream mode, never storage CORS). A load failure shows "Couldn't open.
// Try again." with Download, never a blank sheet; a render crash is caught by
// the viewer's own ErrorBoundary. A PDF sits on a theme surface (panel tokens,
// light in light mode, dark in dark mode) and paints from its first frame: the
// first-page preview when there is one, else a page-shaped card with the file
// name, in the same box the real page then draws into. No spinner, no black
// frame. Video and the rest keep the theme-independent dark overlay.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import type { MutableRefObject, ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { IconDownload, IconFileText, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { humanizeSize } from '@/lib/assets';
import { PresignError, type PresignCache } from '@/lib/asset-presign';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import { attachmentLink, saveFromLink, type HeldLink } from '@/lib/files/download';
import {
  loadPdfJs,
  openPdf,
  releaseCanvas,
  sharedThumbnail,
  type PdfDocumentLike,
  type PdfJsLike,
  type PdfLoadingTaskLike,
  type PdfRenderTaskLike,
} from '@/lib/files/thumbnail';
import {
  OFFICE_MAX_BYTES,
  OFFICE_VIEW_TIMEOUT_MS,
  type DocxView,
  type OfficeResponse,
  type XlsxView,
} from '@/lib/files/office/types';

const WordViewer = lazy(() =>
  import('@/components/ui/viewers/WordViewer').then((m) => ({ default: m.WordViewer })),
);
const SheetViewer = lazy(() =>
  import('@/components/ui/viewers/SheetViewer').then((m) => ({ default: m.SheetViewer })),
);

/** Which renderer a file gets. */
export type ViewerKind = 'pdf' | 'video' | 'office' | 'file';

/** The viewer's error line: never connection wording. */
export const VIEWER_ERROR = "Couldn't open. Try again.";
/** Shown when Download could not save the file (the file itself may be fine). */
export const DOWNLOAD_ERROR = "Couldn't download. Try again.";
export const PREVIEW_UNAVAILABLE = 'Preview not available yet';

/** Pages rendered on each side of the current one; the rest hold no canvas. */
export const LIVE_PAGE_WINDOW = 2;
/** Swipe down past this many px (or a fast flick) closes the sheet. */
export const DISMISS_DISTANCE = 120;
const DISMISS_FLICK_VELOCITY = 0.5;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
const DOUBLE_TAP_ZOOM = 2;
const DOUBLE_TAP_MS = 300;
/** Movement under this many px between touch start and end is still a tap. */
const TAP_SLOP_PX = 10;
/**
 * Pixels per page canvas. iOS caps one canvas near 16.7M pixels and all live
 * canvases together near 224-384 MB, so with up to five live pages each
 * stays near 4M pixels (16 MB): zoomed in, pages trade sharpness for memory.
 */
const MAX_CANVAS_PIXELS = 4_000_000;
const PAGE_GAP_PX = 8;
/** Page height / width until the preview or the PDF says otherwise (US Letter). */
export const DEFAULT_PAGE_ASPECT = 1.294;

/** Layout effect in the browser; a plain effect where there is no DOM (server render, tests). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** "3 / 12": the mono page counter. Pure. */
export function pageCounter(page: number, total: number): string {
  return `${page} / ${total}`;
}

/** Clamp a zoom factor to [1, 4]. Pure. */
export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
}

/**
 * The 1-based page under the reading line (a third of the way down), given a
 * uniform page stride. Pure.
 */
export function currentPage(
  scrollTop: number,
  viewportHeight: number,
  stride: number,
  total: number,
): number {
  if (total <= 0 || stride <= 0) return 1;
  const page = Math.floor((scrollTop + viewportHeight / 3) / stride) + 1;
  return Math.min(Math.max(page, 1), total);
}

/** True for a page that holds a canvas while `current` is shown. Pure. */
export function isLivePage(page: number, current: number): boolean {
  return Math.abs(page - current) <= LIVE_PAGE_WINDOW;
}

/** The canvas pixel width for a page, bounded by the iOS canvas area cap. Pure. */
export function renderWidthPx(cssWidth: number, dpr: number, aspect: number): number {
  const wanted = Math.max(1, Math.round(cssWidth * dpr));
  const maxWidth = Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / Math.max(aspect, 0.01)));
  return Math.min(wanted, maxWidth);
}

/** Should a downward drag of `dy` px over `ms` close the sheet? Pure. */
export function shouldDismiss(dy: number, ms: number): boolean {
  return dy >= DISMISS_DISTANCE || (dy > 24 && ms > 0 && dy / ms >= DISMISS_FLICK_VELOCITY);
}

// ---------------------------------------------------------------------------
// Sources: where the bytes come from (the Worker, or the sender's own file).
// ---------------------------------------------------------------------------

/** A link the viewer holds while it is open; release() frees a local blob URL. */
export type { HeldLink };

/** An Office file's bytes and the mime the server stated (null for the sender's own file). */
export interface OfficeBytes {
  bytes: Uint8Array;
  mime: string | null;
}

/** The file is over the 20 MiB office cap: never read in full, never parsed. */
export class OfficeTooLargeError extends Error {
  constructor() {
    super('office file over the size cap');
    this.name = 'OfficeTooLargeError';
  }
}

export interface FileViewerSource {
  /** The PDF's bytes, fetched fresh on every call. */
  pdfBytes(signal: AbortSignal): Promise<Uint8Array>;
  /**
   * A docx or xlsx file's bytes, fresh on every call, at most 20 MiB; null
   * when the server has no preview for its type (pptx).
   */
  officeBytes(signal: AbortSignal): Promise<OfficeBytes | null>;
  /** A playable link for the video, fresh on every call. */
  videoLink(): Promise<HeldLink>;
  /** A link that saves the file (Content-Disposition: attachment), fresh on every call. */
  downloadLink(): Promise<HeldLink>;
  /** The PDF's first-page preview when it is already at hand (sync, for the first frame), else null. */
  previewNow(): string | null;
  /** The PDF's first-page preview; null when there is none. Never rejects. */
  preview(): Promise<HeldLink | null>;
}

const NOOP = (): void => undefined;

/**
 * Read a response body up to `max` bytes; past it (by Content-Length or as it
 * streams) the body is cancelled and OfficeTooLargeError thrown.
 */
export async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new OfficeTooLargeError();
  }
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > max) throw new OfficeTooLargeError();
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new OfficeTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** asset-read answers 400 to a stream of a type it has no preview for (pptx). */
function isNoPreview(error: unknown): boolean {
  return error instanceof PresignError && /status 400\b/.test(error.message);
}

/** A stored version: PDFs through the asset-read Worker, links presigned fresh. */
export function remoteFileSource(cache: PresignCache, versionId: string): FileViewerSource {
  return {
    async pdfBytes(signal) {
      const response = await cache.pdf(versionId, signal);
      return new Uint8Array(await response.arrayBuffer());
    },
    async officeBytes(signal) {
      let response: Response;
      try {
        // The same authorized stream read as a PDF, fresh on every open.
        response = await cache.pdf(versionId, signal);
      } catch (error) {
        if (isNoPreview(error)) return null;
        throw error;
      }
      const mime = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
      return { bytes: await readCapped(response, OFFICE_MAX_BYTES), mime };
    },
    async videoLink() {
      return { url: (await cache.freshUrl(versionId, 'inline')).url, release: NOOP };
    },
    downloadLink: attachmentLink(cache, versionId),
    previewNow() {
      return cache.peekThumbnail(versionId)?.url ?? null;
    },
    async preview() {
      // The stored thumbnail rendition: page 1 drawn at upload.
      const presigned = await cache.thumbnail(versionId).catch(() => null);
      return presigned === null ? null : { url: presigned.url, release: NOOP };
    },
  };
}

/** The sender's own picked file, before (or without) its upload. */
export function localFileSource(file: File): FileViewerSource {
  const blobLink = (): Promise<HeldLink> => {
    const url = URL.createObjectURL(file);
    return Promise.resolve({ url, release: () => URL.revokeObjectURL(url) });
  };
  return {
    async pdfBytes() {
      return new Uint8Array(await file.arrayBuffer());
    },
    async officeBytes() {
      if (file.size > OFFICE_MAX_BYTES) throw new OfficeTooLargeError();
      // No server mime yet: the Worker reads the type from the package itself.
      return { bytes: new Uint8Array(await file.arrayBuffer()), mime: null };
    },
    videoLink: blobLink,
    downloadLink: blobLink,
    previewNow: () => null,
    async preview() {
      // The same page-1 thumbnail the sending bubble and the upload share.
      const made = await sharedThumbnail(file).catch(() => null);
      if (made === null || !made.ok) return null;
      const url = URL.createObjectURL(made.blob);
      return { url, release: () => URL.revokeObjectURL(url) };
    },
  };
}

/**
 * Save a file through a same-window link with the download attribute: never a
 * new tab or window. A presigned attachment link makes the browser save it.
 */
export function downloadFile(source: FileViewerSource, name: string): Promise<boolean> {
  return saveFromLink(() => source.downloadLink(), name);
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/**
 * The sheet's colours. 'overlay' is the theme-independent dark backdrop
 * (video, office, other files); 'surface' is the theme's own panel (PDF).
 */
export type ViewerTone = 'overlay' | 'surface';

interface ToneClasses {
  backdrop: string;
  fg: string;
  fgDim: string;
  chip: string;
  /** 44x44 icon buttons. */
  bar: string;
  text: string;
}

const TONES: Record<ViewerTone, ToneClasses> = {
  overlay: {
    backdrop: 'bg-overlay',
    fg: 'text-overlay-fg',
    fgDim: 'text-overlay-fg-dim',
    chip: 'bg-overlay-surface text-overlay-fg',
    bar:
      'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-overlay-fg ' +
      'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
      'focus-visible:ring-overlay-fg disabled:opacity-40',
    text:
      'inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 text-sm font-medium ' +
      'text-overlay-fg bg-overlay-surface hover:bg-overlay-line focus-visible:outline-none ' +
      'focus-visible:ring-2 focus-visible:ring-overlay-fg',
  },
  surface: {
    backdrop: 'bg-panel-2',
    fg: 'text-fg',
    fgDim: 'text-fg-2',
    chip: 'bg-panel text-fg border border-border',
    bar:
      'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg ' +
      'hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 ' +
      'focus-visible:ring-accent disabled:opacity-40',
    text:
      'inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 text-sm font-medium ' +
      'text-fg bg-panel border border-border hover:bg-panel-3 focus-visible:outline-none ' +
      'focus-visible:ring-2 focus-visible:ring-accent',
  },
};

/** The tone a kind's sheet uses: PDF on the theme surface, the rest on the overlay. Pure. */
export function viewerTone(kind: ViewerKind): ViewerTone {
  return kind === 'pdf' ? 'surface' : 'overlay';
}

const OVERLAY = TONES.overlay;
/** No selection or iOS callout on the viewer's controls. */
const NO_SELECT = 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]';

/** The centred message with Retry and Download: a failed load is never blank. */
function ViewerError(props: {
  onRetry?: (() => void) | undefined;
  onDownload: () => void;
  tone?: ViewerTone;
}): ReactElement {
  const tone = TONES[props.tone ?? 'overlay'];
  return (
    <div
      data-viewer-error=""
      role="alert"
      className={cn('flex flex-col items-center gap-3 px-6 text-center', NO_SELECT)}
    >
      <p className={cn('text-sm', tone.fg)}>{VIEWER_ERROR}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {props.onRetry !== undefined ? (
          <button type="button" onClick={props.onRetry} className={tone.text}>
            Retry
          </button>
        ) : null}
        <button type="button" onClick={props.onDownload} className={tone.text}>
          <IconDownload size={18} />
          Download
        </button>
      </div>
    </div>
  );
}

function Spinner(): ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg"
    />
  );
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

interface RendererProps {
  name: string;
  size?: number | undefined;
  source: FileViewerSource;
  onDownload: () => void;
  /** The PDF renderer reports its page count and current page to the chrome. */
  onPages: (page: number, total: number) => void;
  /** Zoom (PDF): the sheet stops a swipe-down while zoomed in. */
  onZoom: (zoom: number) => void;
  /** The PDF scroller, so a swipe down starts only from its top. */
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  /** A load failed (the error card shows): the opener can say so after close. */
  onFailed: () => void;
}

/** "Preview not available yet": pptx and other files. */
function UnavailableRenderer(props: RendererProps): ReactElement {
  return (
    <div
      data-viewer-unavailable=""
      className={cn('flex flex-col items-center gap-3 px-6 text-center', NO_SELECT)}
    >
      <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-overlay-surface text-overlay-fg">
        <IconFileText size={30} />
      </span>
      <p className="text-base font-medium text-overlay-fg">{PREVIEW_UNAVAILABLE}</p>
      <p className="max-w-full text-sm text-overlay-fg-dim [overflow-wrap:anywhere]">
        {middleTruncate(props.name)}
        {props.size !== undefined && props.size > 0 ? (
          <>
            {' · '}
            <span className="font-mono">{humanizeSize(props.size)}</span>
          </>
        ) : null}
      </p>
      <button type="button" onClick={props.onDownload} className={OVERLAY.text}>
        <IconDownload size={18} />
        Download
      </button>
    </div>
  );
}

type VideoState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; url: string };

/** The native player on a fresh link; a failed link or decode shows the error card. */
function VideoRenderer(props: RendererProps): ReactElement {
  const [state, setState] = useState<VideoState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { source } = props;

  useEffect(() => {
    let live = true;
    let held: HeldLink | null = null;
    setState({ kind: 'loading' });
    source
      .videoLink()
      .then((link) => {
        if (!live) {
          link.release();
          return;
        }
        held = link;
        setState({ kind: 'ready', url: link.url });
      })
      .catch(() => {
        if (live) setState({ kind: 'error' });
      });
    return () => {
      live = false;
      held?.release();
    };
  }, [source, attempt]);

  const { onFailed } = props;
  useEffect(() => {
    if (state.kind === 'error') onFailed();
  }, [state.kind, onFailed]);

  if (state.kind === 'error') {
    return <ViewerError onRetry={() => setAttempt((n) => n + 1)} onDownload={props.onDownload} />;
  }
  if (state.kind === 'loading') return <Spinner />;
  return (
    <video
      data-viewer-video=""
      src={state.url}
      controls
      playsInline
      preload="metadata"
      onError={() => setState({ kind: 'error' })}
      className="max-h-full max-w-full bg-overlay"
    />
  );
}

/**
 * One PDF page: a fixed-aspect, page-shaped box on the theme surface. Page 1
 * shows the preview (or the file name) from the first frame; the canvas draws
 * over it in the same box once the document is open and the page is live.
 */
function PdfPage(props: {
  /** The open document; null while it is still opening. */
  doc: PdfDocumentLike | null;
  pdfjs: PdfJsLike | null;
  pageNumber: number;
  aspect: number;
  live: boolean;
  cssWidth: number;
  /** Page 1 only: the first-page preview URL. */
  preview?: string | null;
  /** Page 1 only: the file name shown until a preview or the page draws. */
  name?: string;
  onPreviewAspect?: (aspect: number) => void;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLImageElement | null>(null);
  const { doc, pdfjs, pageNumber, aspect, live, cssWidth, preview, name, onPreviewAspect } = props;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A preview already decoded (cached from the file tile) sizes the box before
  // the first paint; a fresh one sizes it on load.
  const reportAspect = useCallback(
    (img: HTMLImageElement | null) => {
      if (img === null || !img.complete || img.naturalWidth <= 0) return;
      onPreviewAspect?.(img.naturalHeight / img.naturalWidth);
    },
    [onPreviewAspect],
  );
  useBrowserLayoutEffect(() => reportAspect(previewRef.current), [preview, reportAspect]);
  const onPreviewLoad = (event: SyntheticEvent<HTMLImageElement>): void =>
    reportAspect(event.currentTarget);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (doc === null || pdfjs === null || !live || canvas === null || cssWidth <= 0) return;
    let task: PdfRenderTaskLike | null = null;
    let cleanupPage: (() => void) | null = null;
    let cancelled = false;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
    void doc
      .getPage(pageNumber)
      .then((page) => {
        // Cancelled before the page arrived: clean it up here, the effect's
        // cleanup has already run.
        if (cancelled) {
          page.cleanup();
          return;
        }
        cleanupPage = () => {
          page.cleanup();
        };
        const natural = page.getViewport({ scale: 1 });
        const widthPx = renderWidthPx(cssWidth, dpr, natural.height / natural.width);
        const viewport = page.getViewport({ scale: widthPx / natural.width });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        // iOS returns no context when canvas memory runs out: show the retry.
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        });
        return task.promise;
      })
      .then(() => {
        if (!cancelled) setFailed(false);
      })
      .catch(() => {
        // A cancelled render (scrolled away, closed) is not a failure.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      task?.cancel();
      cleanupPage?.();
      releaseCanvas(canvas);
    };
  }, [doc, pdfjs, pageNumber, live, cssWidth, attempt]);

  const drawing = doc !== null && live;
  return (
    <div
      data-pdf-page={pageNumber}
      className="relative w-full overflow-hidden rounded-sm border border-border bg-panel"
      style={{ aspectRatio: `1 / ${aspect}` }}
    >
      {preview !== undefined && preview !== null ? (
        <img
          ref={previewRef}
          data-pdf-preview=""
          src={preview}
          alt=""
          aria-hidden="true"
          onLoad={onPreviewLoad}
          className="absolute inset-0 h-full w-full object-contain object-top"
        />
      ) : name !== undefined ? (
        <div
          data-pdf-placeholder=""
          className={cn(
            'absolute inset-0 flex items-center justify-center px-6 text-center',
            NO_SELECT,
          )}
        >
          <span className="flex flex-col items-center gap-3 text-fg-2">
            <IconFileText size={30} />
            <span className="max-w-full text-sm font-medium [overflow-wrap:anywhere]">
              {middleTruncate(name)}
            </span>
          </span>
        </div>
      ) : null}
      {drawing ? (
        <canvas
          ref={canvasRef}
          aria-label={`Page ${pageNumber}`}
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
      {drawing && failed ? (
        <button
          type="button"
          data-pdf-page-error=""
          onClick={() => setAttempt((n) => n + 1)}
          className={cn(
            'absolute inset-0 flex min-h-[44px] items-center justify-center bg-panel text-sm text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            NO_SELECT,
          )}
        >
          {VIEWER_ERROR}
        </button>
      ) : null}
    </div>
  );
}

/** 'preview': the first page box shows the preview or the name while the PDF opens. */
type PdfState =
  | { kind: 'preview' }
  | { kind: 'error' }
  | { kind: 'ready'; pdfjs: PdfJsLike; doc: PdfDocumentLike; aspect: number };

/**
 * pdf.js pages in a vertical scroller with lazy canvases, pinch and double-tap
 * zoom. The scroller and page 1's box are there from the first frame; page 1
 * stays the same element when the document opens, so nothing jumps.
 */
function PdfRenderer(props: RendererProps): ReactElement {
  const { source, onPages, onZoom, scrollerRef } = props;
  const [state, setState] = useState<PdfState>({ kind: 'preview' });
  const [preview, setPreview] = useState<string | null>(() => source.previewNow());
  const [previewAspect, setPreviewAspect] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  // The zoom canvases are drawn at: updated when a pinch ends, not every frame.
  const [renderZoom, setRenderZoom] = useState(1);
  const [width, setWidth] = useState(0);

  // The preview arrives on its own clock; the real pages replace it when ready.
  useEffect(() => {
    let live = true;
    let held: HeldLink | null = null;
    setPreview(source.previewNow());
    void source.preview().then((link) => {
      if (link === null) return;
      if (!live) {
        link.release();
        return;
      }
      held = link;
      setPreview(link.url);
    });
    return () => {
      live = false;
      held?.release();
    };
  }, [source]);

  useEffect(() => {
    const controller = new AbortController();
    let task: PdfLoadingTaskLike | null = null;
    setState({ kind: 'preview' });
    void (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([loadPdfJs(), source.pdfBytes(controller.signal)]);
        if (controller.signal.aborted) return;
        task = openPdf(pdfjs, bytes);
        const doc = await task.promise;
        const first = await doc.getPage(1);
        const natural = first.getViewport({ scale: 1 });
        first.cleanup();
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', pdfjs, doc, aspect: natural.height / natural.width });
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    })();
    return () => {
      controller.abort();
      const held = task;
      task = null;
      if (held !== null) void held.destroy().catch(() => undefined);
    };
  }, [source, attempt]);

  const { onFailed } = props;
  useEffect(() => {
    if (state.kind === 'error') onFailed();
  }, [state.kind, onFailed]);

  const total = state.kind === 'ready' ? state.doc.numPages : 0;
  const aspect = state.kind === 'ready' ? state.aspect : (previewAspect ?? DEFAULT_PAGE_ASPECT);

  // The scroller's width sets every page's box; it follows rotation and resize.
  useBrowserLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollerRef, state.kind]);

  const pageWidth = Math.max(width - 16, 0) * zoom;
  const stride = pageWidth * aspect + PAGE_GAP_PX;

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null || total === 0) return;
    setPage(currentPage(el.scrollTop, el.clientHeight, stride, total));
  }, [scrollerRef, stride, total]);

  useEffect(() => {
    if (total > 0) onPages(page, total);
  }, [page, total, onPages]);

  useEffect(() => {
    onZoom(zoom);
  }, [zoom, onZoom]);

  // Zoom keeps the reading position: scroll offsets scale with the content.
  const applyZoom = useCallback(
    (next: number) => {
      const el = scrollerRef.current;
      setZoom((prev) => {
        const target = clampZoom(next);
        if (el !== null && prev !== target) {
          const ratio = target / prev;
          const top = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
          const left = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
          requestAnimationFrame(() => {
            el.scrollTop = Math.max(top, 0);
            el.scrollLeft = Math.max(left, 0);
          });
        }
        return target;
      });
    },
    [scrollerRef],
  );

  // Pinch (two fingers) and double-tap on the pages. Native page zoom is
  // prevented only while two fingers are down; one finger scrolls as usual.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null || state.kind !== 'ready') return;
    let pinch: { d: number; zoom: number } | null = null;
    let lastTap = 0;
    // A finger that moved (a scroll) or a pinch that just ended is not a tap.
    let tapStart: { x: number; y: number } | null = null;
    let current = zoom;
    const distance = (t: TouchList): number => {
      const a = t[0];
      const b = t[1];
      if (a === undefined || b === undefined) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onStart = (event: TouchEvent): void => {
      const first = event.touches[0];
      tapStart =
        event.touches.length === 1 && first !== undefined
          ? { x: first.clientX, y: first.clientY }
          : null;
      if (event.touches.length === 2) {
        pinch = { d: distance(event.touches), zoom: current };
        lastTap = 0;
        event.preventDefault();
      }
    };
    const onMove = (event: TouchEvent): void => {
      if (pinch === null || event.touches.length !== 2 || pinch.d <= 0) return;
      event.preventDefault();
      current = clampZoom((pinch.zoom * distance(event.touches)) / pinch.d);
      applyZoom(current);
    };
    const onEnd = (event: TouchEvent): void => {
      if (pinch !== null && event.touches.length < 2) {
        pinch = null;
        tapStart = null;
        lastTap = 0;
        setRenderZoom(current);
        return;
      }
      const lifted = event.changedTouches[0];
      const still =
        tapStart !== null &&
        lifted !== undefined &&
        Math.hypot(lifted.clientX - tapStart.x, lifted.clientY - tapStart.y) <= TAP_SLOP_PX;
      tapStart = null;
      if (!still) {
        lastTap = 0;
        return;
      }
      if (event.touches.length === 0 && event.changedTouches.length === 1) {
        const now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) {
          lastTap = 0;
          current = current > 1 ? 1 : DOUBLE_TAP_ZOOM;
          applyZoom(current);
          setRenderZoom(current);
          event.preventDefault();
        } else {
          lastTap = now;
        }
      }
    };
    const onDouble = (): void => {
      current = current > 1 ? 1 : DOUBLE_TAP_ZOOM;
      applyZoom(current);
      setRenderZoom(current);
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('dblclick', onDouble);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('dblclick', onDouble);
    };
    // `zoom` seeds the gesture once per document; the handlers track it after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerRef, state.kind, applyZoom]);

  if (state.kind === 'error') {
    return (
      <ViewerError
        tone="surface"
        onRetry={() => setAttempt((n) => n + 1)}
        onDownload={props.onDownload}
      />
    );
  }

  const doc = state.kind === 'ready' ? state.doc : null;
  const pdfjs = state.kind === 'ready' ? state.pdfjs : null;
  return (
    <div
      ref={scrollerRef}
      data-pdf-scroller=""
      data-pdf-state={state.kind}
      // Focusable so arrows, Space and Page Down scroll the pages on Safari.
      tabIndex={0}
      aria-label="Pages"
      onScroll={onScroll}
      className="absolute inset-0 overflow-auto overscroll-contain [touch-action:pan-x_pan-y]"
    >
      <div
        className="mx-auto flex flex-col px-2 py-2"
        style={{ width: `${pageWidth + 16}px`, gap: `${PAGE_GAP_PX}px` }}
      >
        {Array.from({ length: Math.max(total, 1) }, (_, i) => (
          <PdfPage
            key={i + 1}
            doc={doc}
            pdfjs={pdfjs}
            pageNumber={i + 1}
            aspect={aspect}
            live={isLivePage(i + 1, page)}
            cssWidth={(Math.max(width - 16, 0) * renderZoom) | 0}
            {...(i === 0 ? { preview, name: props.name, onPreviewAspect: setPreviewAspect } : {})}
          />
        ))}
      </div>
    </div>
  );
}

export type OfficeState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'docx'; doc: DocxView }
  | { kind: 'xlsx'; book: XlsxView };

/** Which office view a Worker answer opens; any failure is the error card. Pure. */
export function officeState(response: OfficeResponse): OfficeState {
  if (!response.ok || response.op !== 'view') return { kind: 'error' };
  const result = response.result;
  if (result.kind === 'unsupported') return { kind: 'unavailable' };
  if (result.kind === 'docx') return { kind: 'docx', doc: result };
  return result.sheets.length > 0 ? { kind: 'xlsx', book: result } : { kind: 'error' };
}

/**
 * docx and xlsx: fresh bytes, then one parse in a Web Worker (10 s cap; the
 * Worker is terminated on close or retry), then the lazy Word or Sheet view.
 * pptx (no preview from the server, or a pptx package locally) is the
 * "Preview not available yet" card; anything that fails is the error card.
 */
function OfficeRenderer(props: RendererProps): ReactElement {
  const { source, onFailed, onDownload, scrollerRef } = props;
  const [state, setState] = useState<OfficeState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const [office, runner] = await Promise.all([
          source.officeBytes(controller.signal),
          import('@/lib/files/office/run'),
        ]);
        if (controller.signal.aborted) return;
        if (office === null) {
          setState({ kind: 'unavailable' });
          return;
        }
        const response = await runner.runOffice({
          op: 'view',
          bytes: office.bytes,
          mime: office.mime,
          timeoutMs: OFFICE_VIEW_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setState(officeState(response));
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    })();
    // Aborting terminates a Worker still parsing.
    return () => controller.abort();
  }, [source, attempt]);

  useEffect(() => {
    if (state.kind === 'error') onFailed();
  }, [state.kind, onFailed]);

  if (state.kind === 'error') {
    return <ViewerError onRetry={() => setAttempt((n) => n + 1)} onDownload={onDownload} />;
  }
  if (state.kind === 'unavailable') return <UnavailableRenderer {...props} />;
  if (state.kind === 'loading') return <Spinner />;
  return (
    <Suspense fallback={<Spinner />}>
      {state.kind === 'docx' ? (
        <WordViewer name={props.name} doc={state.doc} />
      ) : (
        <SheetViewer key={attempt} book={state.book} scrollerRef={scrollerRef} />
      )}
    </Suspense>
  );
}

/** The renderer slot, keyed by kind. */
const RENDERERS: Record<ViewerKind, (props: RendererProps) => ReactElement> = {
  pdf: PdfRenderer,
  video: VideoRenderer,
  office: OfficeRenderer,
  file: UnavailableRenderer,
};

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface FileViewerProps {
  name: string;
  kind: ViewerKind;
  size?: number | undefined;
  source: FileViewerSource;
  onClose: () => void;
  /** Called when the file could not be opened (the sheet shows its error card). */
  onLoadError?: (() => void) | undefined;
  /**
   * The caller's own top-bar actions in place of the default Download (Assets
   * passes Download, Copy link, Info and Delete). Called with the bar's 44px
   * button class for this kind's tone. Omitted: Download, as before.
   */
  actions?: ((barClass: string) => ReactNode) | undefined;
  /** A line under the name in the top bar, used when `actions` is set and there is no page count. */
  subtitle?: string | undefined;
}

/** The top bar's line under the name with caller actions: "Page 3 of 12" for a PDF. Pure. */
export function viewerBarLine(
  pages: { page: number; total: number } | null,
  subtitle: string | undefined,
): string | null {
  if (pages !== null) return `Page ${pages.page} of ${pages.total}`;
  return subtitle !== undefined && subtitle !== '' ? subtitle : null;
}

/** Body scroll lock while the sheet is open, restoring the prior value. */
function useBodyScrollLock(): void {
  useEffect(() => {
    const body = document.body;
    const prior = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = prior;
    };
  }, []);
}

function TopBar(props: {
  name: string;
  tone: ToneClasses;
  onClose: () => void;
  onDownload: () => void;
  closeRef: RefObject<HTMLButtonElement>;
  actions?: ((barClass: string) => ReactNode) | undefined;
  line?: string | null;
}): ReactElement {
  const { tone } = props;
  return (
    <div
      data-viewer-bar=""
      className={cn(
        'relative z-10 flex shrink-0 items-center gap-1 px-1 pb-1 pt-[max(env(safe-area-inset-top),4px)]',
        NO_SELECT,
      )}
    >
      <button
        ref={props.closeRef}
        type="button"
        aria-label="Close"
        onClick={props.onClose}
        className={tone.bar}
      >
        <IconX size={22} />
      </button>
      {props.actions !== undefined ? (
        <div className="min-w-0 flex-1 px-1 text-center">
          <p title={props.name} className={cn('truncate text-sm font-medium', tone.fg)}>
            {middleTruncate(props.name, VIEWER_NAME_BUDGET)}
          </p>
          {props.line != null ? (
            <p data-viewer-bar-line="" className={cn('truncate text-xs', tone.fgDim)}>
              {props.line}
            </p>
          ) : null}
        </div>
      ) : (
        <p
          title={props.name}
          className={cn('min-w-0 flex-1 truncate text-center text-sm font-medium', tone.fg)}
        >
          {middleTruncate(props.name, VIEWER_NAME_BUDGET)}
        </p>
      )}
      {props.actions !== undefined ? (
        props.actions(tone.bar)
      ) : (
        <button type="button" aria-label="Download" onClick={props.onDownload} className={tone.bar}>
          <IconDownload size={20} />
        </button>
      )}
    </div>
  );
}

export function FileViewerSheet(props: FileViewerProps): ReactElement {
  const { name, kind, size, source, onLoadError, actions, subtitle } = props;
  // Callers pass a fresh onClose each render: keep the latest in a ref so the
  // key and swipe listeners are not re-attached (and a drag not dropped).
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const onClose = useCallback(() => onCloseRef.current(), []);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<{ page: number; total: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [settling, setSettling] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const zoomRef = useRef(1);

  useBodyScrollLock();

  const onDownload = useCallback(() => {
    setDownloadFailed(false);
    void downloadFile(source, name).then((ok) => {
      if (!ok) setDownloadFailed(true);
    });
  }, [source, name]);

  // Focus moves in (to Close), Tab stays inside, and the opener gets it back
  // on close. The shared modal-focus stack, so a layer opened over the viewer
  // traps for itself and the layer under it never fights the viewer for Tab.
  useModalFocus(dialogRef, true, { initial: () => closeRef.current });

  // Esc closes (laptop).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The sheet owns Esc while open: the thread underneath never sees it.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Swipe down to close: one finger, starting from the top of the content (or
  // the bar), at 1x. The sheet follows on Y only and closes past the distance;
  // otherwise it settles back.
  useEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let lastDy = 0;
    const atTop = (target: EventTarget | null): boolean => {
      const scroller = scrollerRef.current;
      if (scroller === null || !(target instanceof Node) || !scroller.contains(target)) return true;
      return scroller.scrollTop <= 0;
    };
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch === undefined) {
        start = null;
        return;
      }
      if (zoomRef.current > 1 || !atTop(event.target)) {
        start = null;
        return;
      }
      if (event.target instanceof HTMLVideoElement) {
        start = null;
        return;
      }
      start = { x: touch.clientX, y: touch.clientY, t: Date.now() };
      dragging = false;
      lastDy = 0;
    };
    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (start === null || touch === undefined || event.touches.length !== 1) return;
      const dy = touch.clientY - start.y;
      const dx = touch.clientX - start.x;
      if (!dragging) {
        if (dy > 8 && dy > Math.abs(dx) * 1.5) {
          dragging = true;
          setSettling(false);
        } else if (Math.abs(dx) > 8 || dy < -8) {
          start = null;
          return;
        } else {
          return;
        }
      }
      event.preventDefault();
      lastDy = Math.max(dy, 0);
      setDragY(lastDy);
    };
    const onEnd = (): void => {
      if (start !== null && dragging) {
        if (shouldDismiss(lastDy, Date.now() - start.t)) {
          onClose();
        } else {
          setSettling(true);
          setDragY(0);
        }
      }
      start = null;
      dragging = false;
    };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [onClose]);

  const onPages = useCallback((page: number, total: number) => setPages({ page, total }), []);
  const onZoom = useCallback((zoom: number) => {
    zoomRef.current = zoom;
  }, []);
  const onFailed = useCallback(() => onLoadError?.(), [onLoadError]);

  const Renderer = RENDERERS[kind];
  const tone = TONES[viewerTone(kind)];
  const backdrop = Math.max(0.3, 1 - dragY / 400);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-file-viewer={kind}
      data-viewer-tone={viewerTone(kind)}
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden"
    >
      <div
        aria-hidden="true"
        data-viewer-backdrop=""
        className={cn('absolute inset-0', tone.backdrop)}
        style={{ opacity: backdrop }}
      />
      <div
        data-viewer-sheet=""
        className={cn(
          'relative flex min-h-0 flex-1 flex-col',
          settling && 'transition-transform duration-base ease-exit',
        )}
        style={{ transform: `translateY(${dragY}px)` }}
        onTransitionEnd={() => setSettling(false)}
      >
        <TopBar
          name={name}
          tone={tone}
          onClose={onClose}
          onDownload={onDownload}
          closeRef={closeRef}
          actions={actions}
          line={actions !== undefined ? viewerBarLine(null, subtitle) : null}
        />
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <Renderer
            name={name}
            size={size}
            source={source}
            onDownload={onDownload}
            onPages={onPages}
            onZoom={onZoom}
            scrollerRef={scrollerRef}
            onFailed={onFailed}
          />
        </div>
        {pages !== null && kind === 'pdf' ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),12px)] flex justify-center">
            <span
              data-page-counter=""
              className={cn('rounded-full px-3 py-1 font-mono text-xs', tone.chip, NO_SELECT)}
            >
              {pageCounter(pages.page, pages.total)}
            </span>
          </div>
        ) : null}
        {downloadFailed ? (
          <p
            role="status"
            className={cn('absolute inset-x-0 bottom-14 text-center text-sm', tone.fg)}
          >
            {DOWNLOAD_ERROR}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The viewer's crash fallback: still closable, still downloadable. */
export function FileViewerFallback(props: {
  name: string;
  kind: ViewerKind;
  source: FileViewerSource;
  onClose: () => void;
}): ReactElement {
  const toneName = viewerTone(props.kind);
  const tone = TONES[toneName];
  const closeRef = useRef<HTMLButtonElement>(null);
  const { onClose } = props;
  // Still keyboard-closable: Esc closes, focus starts on Close.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.name}
      data-file-viewer-fallback=""
      className={cn('fixed inset-0 z-[80] flex flex-col', tone.backdrop, NO_SELECT)}
    >
      <div className="flex shrink-0 items-center px-1 pt-[max(env(safe-area-inset-top),4px)]">
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          className={tone.bar}
        >
          <IconX size={22} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <ViewerError
          tone={toneName}
          onDownload={() => void downloadFile(props.source, props.name)}
        />
      </div>
    </div>
  );
}

function stop(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

/**
 * The full-screen viewer, portalled to document.body inside its own error
 * boundary (fallback: close + Download).
 */
export function FileViewer(props: FileViewerProps): ReactElement | null {
  if (typeof document === 'undefined') return null;
  return createPortal(
    // React events bubble through a portal to the opener's tree: stop them here
    // so a tap or long press in the viewer never reaches the message row.
    <div
      data-file-viewer-root=""
      onClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
      onContextMenu={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
    >
      <ErrorBoundary
        name="file-viewer"
        context={{ kind: props.kind }}
        fallback={
          <FileViewerFallback
            name={props.name}
            kind={props.kind}
            source={props.source}
            onClose={props.onClose}
          />
        }
      >
        <FileViewerSheet {...props} />
      </ErrorBoundary>
    </div>,
    document.body,
  );
}
