import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { IconChevronRight, IconCopy, IconDownload, IconX } from '@/components/ui/icons';
import { IconChevronLeft, IconEdit, IconInfo } from '@/components/pages/assets/viewerIcons';
import type { PresignCache } from '@/lib/asset-presign';
import type { RenameOutcome } from '@/lib/asset-upload';
import {
  DELETE_CONFIRM_MESSAGE,
  displayLabel,
  humanizeSize,
  type AssetDeleteOutcome,
  type AssetListItem,
} from '@/lib/assets';
import {
  isInlineRenderable,
  mediaKind,
  resolveAssetUrl,
  typeLabel,
} from '@/components/pages/assets/media';
import { downloadFile } from '@/components/pages/assets/openExternal';
import { Highlight } from '@/components/ui/SearchHighlight';
import {
  FileViewer,
  remoteFileSource,
  VIEWER_ERROR,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { classifyFileKind, type FileKind } from '@/lib/chat/attachments';

// The file card's action: a 44px target, colour change only on press (the
// shared Button's height and press scale do not fit this rule).
const CARD_BUTTON =
  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-md bg-accent px-4 ' +
  'text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Layout effect in the browser; a plain effect where there is no DOM (server render, tests). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const SIGN_FAIL = "Couldn't get a link for this asset. Try again.";
const SWIPE_THRESHOLD = 48;

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
   * Soft-delete. 'deleted' closes the viewer onto the new list; 'in_use' is
   * handled by the parent (it closes the viewer and explains), 'failed' toasts.
   */
  onDelete: (item: AssetListItem) => Promise<AssetDeleteOutcome>;
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
    <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
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
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const touchStartX = useRef<number | null>(null);
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

  // Reset the delete confirm and any in-progress rename when navigating to
  // another asset, or when the Info sheet closes.
  useEffect(() => {
    setConfirming(false);
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

  // Esc closes; arrows navigate.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The FileViewer owns the keys while it is open.
      if (viewingRef.current) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [go, onClose]);

  if (item === undefined) return null;
  const asset: AssetListItem = item;

  async function withUrl(apply: (url: string) => void | Promise<void>): Promise<void> {
    setBusy(true);
    try {
      const url = await resolveAssetUrl(asset, cache);
      await apply(url);
    } catch {
      onToast(SIGN_FAIL);
    } finally {
      setBusy(false);
    }
  }

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

  const handleCopy = (): void => {
    void withUrl(async (url) => {
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
    });
  };

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    const outcome = await onDelete(asset);
    if (outcome === 'deleted') {
      onClose();
      onToast('Moved to Recently deleted');
      return;
    }
    setDeleting(false);
    setConfirming(false);
    if (outcome === 'failed') onToast("Couldn't delete this asset. Try again.");
  }

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

  const onTouchStart = (event: React.TouchEvent): void => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: React.TouchEvent): void => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) > SWIPE_THRESHOLD) go(delta < 0 ? 1 : -1);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
    >
      {/* Top bar: name, counter, close. */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-3 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          <Highlight text={name} />
        </span>
        <span className="shrink-0 text-xs tabular-nums text-white/70">
          {index + 1} / {items.length}
        </span>
        <button
          type="button"
          aria-label="Close viewer"
          onClick={onClose}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <IconX size={20} />
        </button>
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
            <button
              type="button"
              aria-label="Previous asset"
              onClick={() => go(-1)}
              className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 md:inline-flex"
            >
              <IconChevronLeft size={22} />
            </button>
            <button
              type="button"
              aria-label="Next asset"
              onClick={() => go(1)}
              className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 md:inline-flex"
            >
              <IconChevronRight size={22} />
            </button>
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
              <button ref={openRef} type="button" onClick={handleOpen} className={CARD_BUTTON}>
                Open
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDownload}
                disabled={busy}
                className={CARD_BUTTON}
              >
                <IconDownload size={16} />
                {isInlineRenderable(kind) ? 'Download to view' : 'Download'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom frosted action bar. */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-white/10 bg-black/40 px-3 py-2 backdrop-blur">
        <BarButton
          icon={<IconDownload size={18} />}
          label="Download"
          onClick={handleDownload}
          disabled={busy}
        />
        <BarButton
          icon={<IconCopy size={18} />}
          label="Copy link"
          onClick={handleCopy}
          disabled={busy}
        />
        <BarButton icon={<IconInfo size={18} />} label="Info" onClick={() => setInfoOpen(true)} />
      </div>

      {/* Info: bottom sheet sliding up inside the lightbox. */}
      {infoOpen ? (
        <div className="absolute inset-0 z-10 flex items-end">
          <button
            type="button"
            aria-label="Close details"
            onClick={() => setInfoOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div
            role="dialog"
            aria-label={`Details for ${name}`}
            className="relative max-h-[80%] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-panel p-4 text-fg md:mx-auto md:mb-4 md:max-w-md md:rounded-2xl md:border"
          >
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>
              <IconButton label="Close details" onClick={() => setInfoOpen(false)}>
                <IconX size={18} />
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
                        size="lg"
                        className="flex-1"
                        onClick={() => setEditingName(false)}
                        disabled={savingName}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        size="lg"
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
                      <button
                        type="button"
                        aria-label="Rename asset"
                        onClick={() => {
                          setNameDraft(name);
                          setEditingName(true);
                        }}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      >
                        <IconEdit size={16} />
                      </button>
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
              {confirming ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-sm font-semibold text-fg [overflow-wrap:anywhere]">
                      Delete {name}?
                    </p>
                    <p className="mt-1 text-sm text-fg-2">{DELETE_CONFIRM_MESSAGE}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="lg"
                      className="flex-1"
                      onClick={() => setConfirming(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      size="lg"
                      className="flex-1"
                      onClick={() => void confirmDelete()}
                      disabled={deleting}
                    >
                      {deleting ? 'Deleting' : 'Delete'}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="danger"
                  size="lg"
                  className="w-full"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </Button>
              )}
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
        />
      ) : null}
    </div>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-lg px-3 text-sm text-white/90 hover:bg-white/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
