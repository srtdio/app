import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, buttonClass } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { IconChevronRight, IconCopy, IconDownload, IconTrash, IconX } from '@/components/ui/icons';
import { IconChevronLeft, IconEdit, IconInfo } from '@/components/pages/assets/viewerIcons';
import type { PresignCache } from '@/lib/asset-presign';
import type { RenameOutcome } from '@/lib/asset-upload';
import { displayLabel, humanizeSize, type AssetListItem } from '@/lib/assets';
import { isInlineRenderable, mediaKind, typeLabel } from '@/components/pages/assets/media';
import { assetLink } from '@/components/pages/assets/assets-nav';
import { downloadFile } from '@/components/pages/assets/openExternal';
import { Highlight } from '@/components/ui/SearchHighlight';
import {
  FileViewer,
  remoteFileSource,
  VIEWER_ERROR,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { classifyFileKind, type FileKind } from '@/lib/chat/attachments';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';

/** Layout effect in the browser; a plain effect where there is no DOM (server render, tests). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const SIGN_FAIL = "Couldn't get a link for this asset. Try again.";
const SWIPE_THRESHOLD = 48;

// The top bar's 44px icon buttons on the overlay (light and dark share it).
const BAR_BUTTON =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-overlay-fg ' +
  'transition-colors duration-fast hover:bg-overlay-surface disabled:opacity-40 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg';

// The stage's previous / next arrows (laptop only): the shared IconButton in the
// overlay colours. Overlay tokens sort after the IconButton's own, so they win.
const STAGE_ARROW =
  'absolute top-1/2 hidden -translate-y-1/2 bg-overlay-surface text-overlay-fg ' +
  'hover:bg-overlay-line hover:text-overlay-fg focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg md:inline-flex';

/** Delete keeps the bar button's shape in the bad colour. */
const BAD = '!text-bad';

/**
 * A swipe's step: next (1) or previous (-1) for a horizontal swipe past the
 * threshold, else 0. Axis lock: the move must be mostly sideways (1.5x the
 * vertical), so a scroll or a pull down never changes the file. Pure.
 */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) <= SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** The type word under the name: "Image", "Video", "PDF". Pure. */
function typeWord(label: string): string {
  return label === 'PDF' ? label : `${label.slice(0, 1)}${label.slice(1).toLowerCase()}`;
}

/** The line under the name in the top bar: type, size and "2 of 5". Pure. */
export function lightboxSubtitle(
  label: string,
  sizeBytes: number | null,
  index: number,
  total: number,
): string {
  const parts = [typeWord(label), humanizeSize(sizeBytes)];
  if (total > 1) parts.push(`${index + 1} of ${total}`);
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * The Escape step for the lightbox, top layer first: an open rename closes,
 * then an open Info sheet, then the lightbox. Pure.
 */
export function lightboxEscapeStep(state: {
  editingName: boolean;
  infoOpen: boolean;
}): 'rename' | 'info' | 'close' {
  if (state.editingName) return 'rename';
  if (state.infoOpen) return 'info';
  return 'close';
}

interface AssetLightboxProps {
  /** The navigable list: the currently filtered/searched assets, links excluded. */
  items: AssetListItem[];
  index: number;
  presignEnabled: boolean;
  cache: PresignCache;
  /** Mint an attachment-disposition URL so a download saves in place, never navigating. */
  requestDownloadUrl: (item: AssetListItem) => Promise<string>;
  /** Open the Info sheet immediately (used when reached from the long-press sheet). */
  initialInfoOpen?: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /**
   * Delete: the parent closes the viewer, hides the file at once and offers
   * Undo; the delete commits after the window. No confirm step.
   */
  onDelete: (item: AssetListItem) => void;
  /** True when the current member may rename (owner/admin/agency); clients see no edit. */
  canRename: boolean;
  /** Commit a rename to the worker; resolves the mapped outcome for the toast. */
  onRename: (item: AssetListItem, name: string) => Promise<RenameOutcome>;
  onToast: (message: string) => void;
}

/**
 * The FileViewer kind an asset opens in: pdf, office or any other file, from
 * the version's mime (never the file name); null for images and video, which
 * stay inline, and for links, which open externally. Pure.
 */
export function assetViewerKind(
  item: Pick<AssetListItem, 'kind' | 'mimeType' | 'filename'>,
): FileKind | null {
  if (item.kind === 'link' || isInlineRenderable(mediaKind(item))) return null;
  return classifyFileKind(item.mimeType ?? '');
}

/**
 * Whether the asset the lightbox opened on goes straight to the FileViewer: a
 * stored pdf, office or other file, unless reached from the long-press Info.
 * Pure.
 */
export function opensOnArrival(
  item: AssetListItem,
  initialInfoOpen: boolean,
  presignEnabled: boolean,
): boolean {
  return (
    !initialInfoOpen &&
    presignEnabled &&
    item.currentVersionId !== null &&
    assetViewerKind(item) !== null
  );
}

/** An asset open in the FileViewer, with the source made for this open. */
interface Viewing {
  asset: AssetListItem;
  kind: FileKind;
  source: FileViewerSource;
}

/** The FileViewer open for a stored pdf, office or other asset, else null. */
function viewingFor(
  asset: AssetListItem,
  cache: PresignCache,
  presignEnabled: boolean,
): Viewing | null {
  const kind = assetViewerKind(asset);
  if (kind === null || !presignEnabled || asset.currentVersionId === null) return null;
  return { asset, kind, source: remoteFileSource(cache, asset.currentVersionId) };
}

/** The viewer's title: the asset's name as it is now, so a rename shows while open. Pure. */
export function viewerName(items: readonly AssetListItem[], asset: AssetListItem): string {
  return displayLabel(items.find((candidate) => candidate.id === asset.id) ?? asset);
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-fg-3">{label}</dt>
      <dd className="text-sm text-fg break-words">{value}</dd>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
  );
}

/**
 * Fullscreen, type-aware media viewer. Renders image/video inline from a
 * presigned URL; pdf, office and every other file open in the shared
 * FileViewer (the one tapped opens straight away, the rest from Open). Navigation
 * (arrows, swipe, ArrowLeft/Right) wraps around the navigable list; Esc and a tap
 * on the scrim close. Only the viewed asset (and its immediate neighbours) is
 * presigned, never the whole list.
 */
export function AssetLightbox({
  items,
  index,
  presignEnabled,
  cache,
  requestDownloadUrl,
  initialInfoOpen = false,
  onIndexChange,
  onClose,
  onDelete,
  canRename,
  onRename,
  onToast,
}: AssetLightboxProps) {
  const item = items[index];
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(initialInfoOpen);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  // The swipe in progress; null when none (two fingers, or it began on a video).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The file open in the FileViewer. Reached from the long-press sheet's Info,
  // the lightbox opens on the details instead.
  // Opened right after this lightbox has locked the page (see below), never in
  // the same commit, so the viewer's own lock always saves 'hidden'.
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const viewingRef = useRef(false);
  viewingRef.current = viewing !== null;
  // Stable callbacks, so the viewer never re-attaches its listeners or re-reports.
  const closeViewer = useCallback(() => setViewing(null), []);
  const onViewerError = useCallback(() => setOpenFailed(true), []);
  // On close, focus stays in this dialog (on Open), not on the grid behind it.
  const openRef = useRef<HTMLButtonElement>(null);
  const wasViewing = useRef(viewing !== null);
  useEffect(() => {
    if (viewing === null && wasViewing.current) openRef.current?.focus();
    wasViewing.current = viewing !== null;
  }, [viewing]);

  const kind = item !== undefined ? mediaKind(item) : 'file';
  const name = item !== undefined ? displayLabel(item) : '';

  const go = useCallback(
    (delta: number): void => {
      const n = items.length;
      if (n === 0) return;
      onIndexChange((((index + delta) % n) + n) % n);
    },
    [index, items.length, onIndexChange],
  );

  // Resolve the signed URL for the viewed asset only when it renders inline.
  useEffect(() => {
    setMediaSrc(null);
    setMediaFailed(false);
    if (item === undefined || !presignEnabled || !isInlineRenderable(kind)) return;
    if (item.currentVersionId === null) {
      setMediaFailed(true);
      return;
    }
    let live = true;
    cache
      .resolve(item.currentVersionId)
      .then((presigned) => {
        if (live) setMediaSrc(presigned.url);
      })
      .catch(() => {
        if (!live) return;
        setMediaFailed(true);
        onToast(SIGN_FAIL);
      });
    return () => {
      live = false;
    };
  }, [item, kind, presignEnabled, cache, onToast]);

  // Prefetch immediate neighbours so a swipe/arrow shows instantly, still one at
  // a time and only for inline-renderable types.
  useEffect(() => {
    if (!presignEnabled || items.length < 2) return;
    for (const offset of [-1, 1]) {
      const neighbour = items[(((index + offset) % items.length) + items.length) % items.length];
      if (neighbour === undefined || neighbour.currentVersionId === null) continue;
      if (isInlineRenderable(mediaKind(neighbour)))
        void cache.resolve(neighbour.currentVersionId).catch(() => {});
    }
  }, [index, items, presignEnabled, cache]);

  // Reset any in-progress rename when navigating to another asset, or when the
  // Info sheet closes.
  useEffect(() => {
    setEditingName(false);
    setOpenFailed(false);
  }, [index]);

  useEffect(() => {
    if (!infoOpen) setEditingName(false);
  }, [infoOpen]);

  // Lock body scroll while open, in a layout effect so it is in place before
  // the viewer mounts. When both close together (back, a route change) the
  // viewer restores its saved 'hidden' after this cleanup, so the page's own
  // value is put back once more right after.
  useBrowserLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (viewingRef.current) {
        setTimeout(() => {
          document.body.style.overflow = previousOverflow;
        }, 0);
      }
    };
  }, []);

  // The file tapped in the grid opens straight away (not when reached from
  // the long-press sheet's Info, which opens on the details).
  useBrowserLayoutEffect(() => {
    const first = items[index];
    if (first !== undefined && opensOnArrival(first, initialInfoOpen, presignEnabled)) {
      setViewing(viewingFor(first, cache, presignEnabled));
    }
    // Once, on open: later navigation never opens the viewer by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus moves in (to Close), Tab stays inside, and it goes back on close.
  useModalFocus(dialogRef, true, { initial: () => closeRef.current });

  // Escape reaches the lightbox only as the top layer (a menu or confirm above
  // it takes its own; the FileViewer stops it before the stack sees it). Inside,
  // it backs out of an open rename, then the Info sheet, then closes.
  useEscapeLayer(true, () => {
    if (viewingRef.current || savingName) return;
    const step = lightboxEscapeStep({ editingName, infoOpen });
    if (step === 'rename') setEditingName(false);
    else if (step === 'info') setInfoOpen(false);
    else onClose();
  });

  // Arrows navigate, never while typing a name or reading Info.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The FileViewer owns the keys while it is open.
      if (viewingRef.current || infoOpen) return;
      if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [go, infoOpen]);

  if (item === undefined) return null;
  const asset: AssetListItem = item;

  // Download saves the file in place via a content-disposition: attachment URL;
  // the lightbox (and the Sorted tab behind it) never navigates away.
  const handleDownload = (): void => {
    setBusy(true);
    void downloadFile(() => requestDownloadUrl(asset))
      .then(() => onToast('Download started'))
      .catch(() => onToast(SIGN_FAIL))
      .finally(() => setBusy(false));
  };

  const viewable = viewingFor(asset, cache, presignEnabled) !== null;
  const handleOpen = (): void => {
    const next = viewingFor(asset, cache, presignEnabled);
    if (next === null) return;
    setOpenFailed(false);
    setViewing(next);
  };

  // Copy the in-app link (/assets?asset=<id>): it opens for workspace members
  // and never expires, unlike a presigned storage URL.
  const handleCopy = (): void => {
    void copyText(assetLink(window.location.origin, asset.id)).then((ok) =>
      onToast(ok ? 'Link copied' : COPY_FAILED),
    );
  };

  const handleDelete = (): void => onDelete(asset);

  // Download, Copy link, Info and Delete: the same four on the lightbox bar and
  // on the FileViewer's bar for a PDF or Office file, so they are always on top.
  const renderActions = (barClass: string, onInfo: () => void) => (
    <>
      <button
        type="button"
        aria-label="Download"
        onClick={handleDownload}
        disabled={busy}
        className={barClass}
      >
        <IconDownload size={20} />
      </button>
      <button
        type="button"
        aria-label="Copy link"
        onClick={handleCopy}
        disabled={busy}
        className={barClass}
      >
        <IconCopy size={20} />
      </button>
      <button type="button" aria-label="Info" onClick={onInfo} className={barClass}>
        <IconInfo size={20} />
      </button>
      <button
        type="button"
        aria-label="Delete"
        onClick={handleDelete}
        className={cn(barClass, BAD)}
      >
        <IconTrash size={20} />
      </button>
    </>
  );
  // From the FileViewer, Info closes the viewer onto the lightbox's details.
  const viewerActions = (barClass: string) =>
    renderActions(barClass, () => {
      setViewing(null);
      setInfoOpen(true);
    });

  // Commit an inline rename. Save is gated to a non-empty, changed name; on
  // success the parent updates the shared list, so the new name flows back into
  // both this title and the grid card, and the input collapses.
  const trimmedDraft = nameDraft.trim();
  const canSaveName = trimmedDraft !== '' && trimmedDraft !== name && !savingName;
  async function saveName(): Promise<void> {
    if (!canSaveName) return;
    setSavingName(true);
    const outcome = await onRename(asset, trimmedDraft);
    setSavingName(false);
    if (outcome.ok) {
      setEditingName(false);
      onToast('Renamed');
    } else {
      onToast(outcome.message);
    }
  }

  // One-finger horizontal swipe; a touch that starts on a video (its scrubber
  // and controls) never swipes.
  const onTouchStart = (event: React.TouchEvent): void => {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      touchStart.current = null;
      return;
    }
    if (event.target instanceof HTMLVideoElement) {
      touchStart.current = null;
      return;
    }
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: React.TouchEvent): void => {
    const start = touchStart.current;
    touchStart.current = null;
    if (start === null) return;
    const end = event.changedTouches[0];
    if (end === undefined) return;
    const step = swipeStep(end.clientX - start.x, end.clientY - start.y);
    if (step !== 0) go(step);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${name}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-overlay focus:outline-none"
    >
      {/* One top bar: close on the left, the name and its type line in the
          centre, then Download, Copy link, Info and Delete. It clears the notch. */}
      <div
        data-lightbox-bar=""
        className="flex shrink-0 items-center gap-1 px-1 pb-1 pt-[max(env(safe-area-inset-top),4px)] text-overlay-fg"
      >
        <button
          ref={closeRef}
          type="button"
          aria-label="Close viewer"
          onClick={onClose}
          className={BAR_BUTTON}
        >
          <IconX size={20} />
        </button>
        <div className="min-w-0 flex-1 px-1 text-center">
          <p className="truncate text-sm font-medium">
            <Highlight text={name} />
          </p>
          <p className="truncate text-xs tabular-nums text-overlay-fg-dim">
            {lightboxSubtitle(typeLabel(kind), item.sizeBytes, index, items.length)}
          </p>
        </div>
        {renderActions(BAR_BUTTON, () => setInfoOpen(true))}
      </div>

      {/* Media stage. A tap on the empty scrim (not the media) closes. */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {items.length > 1 ? (
          <>
            <IconButton
              type="button"
              label="Previous asset"
              onClick={() => go(-1)}
              className={cn('left-2', STAGE_ARROW)}
            >
              <IconChevronLeft size={20} />
            </IconButton>
            <IconButton
              type="button"
              label="Next asset"
              onClick={() => go(1)}
              className={cn('right-2', STAGE_ARROW)}
            >
              <IconChevronRight size={20} />
            </IconButton>
          </>
        ) : null}

        {kind === 'image' && mediaSrc !== null ? (
          <img src={mediaSrc} alt={name} className="max-h-full max-w-full object-contain" />
        ) : kind === 'video' && mediaSrc !== null ? (
          <video src={mediaSrc} controls className="max-h-full max-w-full" />
        ) : isInlineRenderable(kind) && !mediaFailed && presignEnabled ? (
          <Spinner />
        ) : (
          <div
            data-file-card=""
            className="m-4 flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center text-fg shadow-xl"
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-panel-2 text-sm font-semibold tracking-wide text-fg-2">
              {typeLabel(kind)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <Highlight text={name} />
              </p>
              <p className="mt-1 text-xs text-fg-3">{humanizeSize(item.sizeBytes)}</p>
              {mediaFailed ? (
                <p className="mt-1 text-xs text-fg-3">This asset could not be loaded.</p>
              ) : null}
              {openFailed ? (
                <p role="status" className="mt-1 text-xs text-fg-3">
                  {VIEWER_ERROR}
                </p>
              ) : null}
            </div>
            {viewable ? (
              <button
                ref={openRef}
                type="button"
                onClick={handleOpen}
                className={buttonClass('primary')}
              >
                Open
              </button>
            ) : (
              <Button variant="primary" type="button" onClick={handleDownload} disabled={busy}>
                <IconDownload size={16} />
                {isInlineRenderable(kind) ? 'Download to view' : 'Download'}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Info: bottom sheet sliding up inside the lightbox. */}
      {infoOpen ? (
        <div className="absolute inset-0 z-10 flex items-end">
          <button
            type="button"
            aria-label="Close details"
            onClick={() => setInfoOpen(false)}
            className="absolute inset-0 bg-scrim"
          />
          <div
            role="dialog"
            aria-label={`Details for ${name}`}
            className="relative max-h-[80%] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-panel p-4 text-fg md:mx-auto md:mb-4 md:max-w-md md:rounded-2xl md:border"
          >
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>
              <IconButton label="Close details" onClick={() => setInfoOpen(false)}>
                <IconX size={20} />
              </IconButton>
            </div>

            <dl className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <dt className="text-[11px] uppercase tracking-wide text-fg-3">Name</dt>
                {editingName ? (
                  <div className="mt-1 flex flex-col gap-2">
                    <Input
                      aria-label="Asset name"
                      value={nameDraft}
                      autoFocus
                      disabled={savingName}
                      onChange={(event) => setNameDraft(event.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={() => setEditingName(false)}
                        disabled={savingName}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        className="flex-1"
                        disabled={!canSaveName}
                        onClick={() => void saveName()}
                      >
                        {savingName ? 'Saving' : 'Save'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <dd className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 break-words text-sm text-fg">{name}</span>
                    {canRename ? (
                      <IconButton
                        type="button"
                        label="Rename asset"
                        onClick={() => {
                          setNameDraft(name);
                          setEditingName(true);
                        }}
                        className="shrink-0"
                      >
                        <IconEdit size={20} />
                      </IconButton>
                    ) : null}
                  </dd>
                )}
              </div>
              <Field label="Type" value={item.mimeType ?? typeLabel(kind)} />
              <Field label="Size" value={humanizeSize(item.sizeBytes)} />
              <Field
                label="Version"
                value={item.versionNumber !== null ? `v${item.versionNumber}` : '-'}
              />
              <Field
                label="Attached to"
                value={`${item.attachmentCount} ${item.attachmentCount === 1 ? 'place' : 'places'}`}
              />
            </dl>

            <div className="mt-4 border-t border-border pt-4">
              <Button variant="danger" className="w-full" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* The FileViewer carries its own ErrorBoundary (fallback: close +
          Download), so a broken file never blanks the Assets page. */}
      {viewing !== null ? (
        <FileViewer
          key={viewing.asset.id}
          name={viewerName(items, viewing.asset)}
          kind={viewing.kind}
          size={viewing.asset.sizeBytes ?? undefined}
          source={viewing.source}
          onClose={closeViewer}
          onLoadError={onViewerError}
          actions={viewerActions}
          subtitle={lightboxSubtitle(
            typeLabel(mediaKind(viewing.asset)),
            viewing.asset.sizeBytes,
            0,
            1,
          )}
        />
      ) : null}
    </div>
  );
}
