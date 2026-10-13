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
//  - office and any other file: "Preview not available yet" with Download
//    (Office gets real renderers in the next PR, in the same slot).
//
// Every open asks for fresh bytes or a fresh link (PDFs come through the
// asset-read Worker, never storage CORS). A load failure shows "Couldn't open.
// Try again." with Download, never a blank sheet; a render crash is caught by
// the viewer's own ErrorBoundary. Colours come from the theme-independent
// overlay tokens, the same dark backdrop in light and dark mode.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactElement, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { IconDownload, IconFileText, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import {
  loadPdfJs,
  openPdf,
  releaseCanvas,
  type PdfDocumentLike,
  type PdfJsLike,
  type PdfLoadingTaskLike,
  type PdfRenderTaskLike,
} from '@/lib/files/thumbnail';

/** Which renderer a file gets. */
export type ViewerKind = 'pdf' | 'video' | 'office' | 'file';

/** The viewer's error line: never connection wording. */
export const VIEWER_ERROR = "Couldn't open. Try again.";
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
/** iOS caps a canvas at about 16.7M pixels; stay under it. */
const MAX_CANVAS_PIXELS = 16_000_000;
const PAGE_GAP_PX = 8;

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
export interface HeldLink {
  url: string;
  release: () => void;
}

export interface FileViewerSource {
  /** The PDF's bytes, fetched fresh on every call. */
  pdfBytes(signal: AbortSignal): Promise<Uint8Array>;
  /** A playable link for the video, fresh on every call. */
  videoLink(): Promise<HeldLink>;
  /** A link that saves the file (Content-Disposition: attachment), fresh on every call. */
  downloadLink(): Promise<HeldLink>;
}

const NOOP = (): void => undefined;

/** A stored version: PDFs through the asset-read Worker, links presigned fresh. */
export function remoteFileSource(cache: PresignCache, versionId: string): FileViewerSource {
  return {
    async pdfBytes(signal) {
      const response = await cache.pdf(versionId, signal);
      return new Uint8Array(await response.arrayBuffer());
    },
    async videoLink() {
      return { url: (await cache.freshUrl(versionId, 'inline')).url, release: NOOP };
    },
    async downloadLink() {
      return { url: (await cache.freshUrl(versionId, 'attachment')).url, release: NOOP };
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
    videoLink: blobLink,
    downloadLink: blobLink,
  };
}

/**
 * Save a file through a same-window link with the download attribute: never a
 * new tab or window. A presigned attachment link makes the browser save it.
 */
export async function downloadFile(source: FileViewerSource, name: string): Promise<boolean> {
  let link: HeldLink | null = null;
  try {
    link = await source.downloadLink();
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    // A blob link must outlive the click a moment; a presigned one needs nothing.
    const held = link;
    if (held !== null) setTimeout(held.release, 30_000);
  }
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/** 44x44 icon buttons on the overlay backdrop. */
const BAR_BUTTON =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-overlay-fg/70 disabled:opacity-40';
const TEXT_BUTTON =
  'inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 text-sm font-medium ' +
  'text-overlay-fg bg-overlay-surface hover:bg-overlay-line focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';
/** No selection or iOS callout on the viewer's controls. */
const NO_SELECT = 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]';

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], video[controls]'),
  );
}

/** The centred message with Try again and Download: a failed load is never blank. */
function ViewerError(props: {
  onRetry?: (() => void) | undefined;
  onDownload: () => void;
}): ReactElement {
  return (
    <div
      data-viewer-error=""
      role="alert"
      className={cn('flex flex-col items-center gap-3 px-6 text-center', NO_SELECT)}
    >
      <p className="text-sm text-overlay-fg">{VIEWER_ERROR}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {props.onRetry !== undefined ? (
          <button type="button" onClick={props.onRetry} className={TEXT_BUTTON}>
            Try again
          </button>
        ) : null}
        <button type="button" onClick={props.onDownload} className={TEXT_BUTTON}>
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

/** "Preview not available yet": Office (until its renderer lands) and other files. */
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
      <button type="button" onClick={props.onDownload} className={TEXT_BUTTON}>
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

/** One PDF page: a fixed-aspect box; a canvas only while the page is live. */
function PdfPage(props: {
  doc: PdfDocumentLike;
  pdfjs: PdfJsLike;
  pageNumber: number;
  aspect: number;
  live: boolean;
  cssWidth: number;
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { doc, pdfjs, pageNumber, aspect, live, cssWidth } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!live || canvas === null || cssWidth <= 0) return;
    let task: PdfRenderTaskLike | null = null;
    let cleanupPage: (() => void) | null = null;
    let cancelled = false;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
    void doc
      .getPage(pageNumber)
      .then((page) => {
        cleanupPage = () => {
          page.cleanup();
        };
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        const widthPx = renderWidthPx(cssWidth, dpr, natural.height / natural.width);
        const viewport = page.getViewport({ scale: widthPx / natural.width });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        });
        return task.promise;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      cleanupPage?.();
      releaseCanvas(canvas);
    };
  }, [doc, pdfjs, pageNumber, live, cssWidth]);

  return (
    <div
      data-pdf-page={pageNumber}
      className="relative w-full bg-overlay-fg"
      style={{ aspectRatio: `1 / ${aspect}` }}
    >
      {live ? (
        <canvas
          ref={canvasRef}
          aria-label={`Page ${pageNumber}`}
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
    </div>
  );
}

type PdfState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; pdfjs: PdfJsLike; doc: PdfDocumentLike; aspect: number };

/** pdf.js pages in a vertical scroller with lazy canvases, pinch and double-tap zoom. */
function PdfRenderer(props: RendererProps): ReactElement {
  const { source, onPages, onZoom, scrollerRef } = props;
  const [state, setState] = useState<PdfState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  // The zoom canvases are drawn at: updated when a pinch ends, not every frame.
  const [renderZoom, setRenderZoom] = useState(1);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let task: PdfLoadingTaskLike | null = null;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([loadPdfJs(), source.pdfBytes(controller.signal)]);
        if (controller.signal.aborted) return;
        task = openPdf(pdfjs, bytes);
        const doc = await task.promise;
        const first = await doc.getPage(1);
        const natural = first.getViewport({ scale: 1 });
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
  const aspect = state.kind === 'ready' ? state.aspect : 1.294;

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
    let current = zoom;
    const distance = (t: TouchList): number => {
      const a = t[0];
      const b = t[1];
      if (a === undefined || b === undefined) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onStart = (event: TouchEvent): void => {
      if (event.touches.length === 2) {
        pinch = { d: distance(event.touches), zoom: current };
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
        setRenderZoom(current);
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
    return <ViewerError onRetry={() => setAttempt((n) => n + 1)} onDownload={props.onDownload} />;
  }

  return (
    <div
      ref={scrollerRef}
      data-pdf-scroller=""
      onScroll={onScroll}
      className="absolute inset-0 overflow-auto overscroll-contain [touch-action:pan-x_pan-y]"
    >
      {state.kind === 'loading' ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div
          className="mx-auto flex flex-col px-2 py-2"
          style={{ width: `${pageWidth + 16}px`, gap: `${PAGE_GAP_PX}px` }}
        >
          {Array.from({ length: total }, (_, i) => (
            <PdfPage
              key={i + 1}
              doc={state.doc}
              pdfjs={state.pdfjs}
              pageNumber={i + 1}
              aspect={state.aspect}
              live={isLivePage(i + 1, page)}
              cssWidth={(Math.max(width - 16, 0) * renderZoom) | 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The renderer slot, keyed by kind. Office gets its own renderer in the next PR. */
const RENDERERS: Record<ViewerKind, (props: RendererProps) => ReactElement> = {
  pdf: PdfRenderer,
  video: VideoRenderer,
  office: UnavailableRenderer,
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
  onClose: () => void;
  onDownload: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}): ReactElement {
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
        className={BAR_BUTTON}
      >
        <IconX size={22} />
      </button>
      <p
        title={props.name}
        className="min-w-0 flex-1 truncate text-center text-sm font-medium text-overlay-fg"
      >
        {middleTruncate(props.name, VIEWER_NAME_BUDGET)}
      </p>
      <button type="button" aria-label="Download" onClick={props.onDownload} className={BAR_BUTTON}>
        <IconDownload size={20} />
      </button>
    </div>
  );
}

export function FileViewerSheet(props: FileViewerProps): ReactElement {
  const { name, kind, size, source, onClose, onLoadError } = props;
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

  // Focus the close button on open; give focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  // Esc closes (laptop); Tab cycles inside the sheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // The sheet owns Esc while open: the thread underneath never sees it.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const controls = focusable(root);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
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
  const backdrop = Math.max(0.3, 1 - dragY / 400);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-file-viewer={kind}
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay"
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
        <TopBar name={name} onClose={onClose} onDownload={onDownload} closeRef={closeRef} />
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
              className={cn(
                'rounded-full bg-overlay-surface px-3 py-1 font-mono text-xs text-overlay-fg',
                NO_SELECT,
              )}
            >
              {pageCounter(pages.page, pages.total)}
            </span>
          </div>
        ) : null}
        {downloadFailed ? (
          <p
            role="status"
            className="absolute inset-x-0 bottom-14 text-center text-sm text-overlay-fg"
          >
            {VIEWER_ERROR}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The viewer's crash fallback: still closable, still downloadable. */
export function FileViewerFallback(props: {
  name: string;
  source: FileViewerSource;
  onClose: () => void;
}): ReactElement {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.name}
      data-file-viewer-fallback=""
      className={cn('fixed inset-0 z-[80] flex flex-col bg-overlay', NO_SELECT)}
    >
      <div className="flex shrink-0 items-center px-1 pt-[max(env(safe-area-inset-top),4px)]">
        <button type="button" aria-label="Close" onClick={props.onClose} className={BAR_BUTTON}>
          <IconX size={22} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <ViewerError onDownload={() => void downloadFile(props.source, props.name)} />
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
          <FileViewerFallback name={props.name} source={props.source} onClose={props.onClose} />
        }
      >
        <FileViewerSheet {...props} />
      </ErrorBoundary>
    </div>,
    document.body,
  );
}
