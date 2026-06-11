import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronRight, IconCopy, IconDownload, IconX } from '@/components/ui/icons';
import { IconChevronLeft, IconInfo } from '@/components/pages/assets/viewerIcons';
import type { PresignCache } from '@/lib/asset-presign';
import { displayLabel, humanizeSize, type AssetListItem } from '@/lib/assets';
import {
  isInlineRenderable,
  mediaKind,
  resolveAssetUrl,
  typeLabel,
} from '@/components/pages/assets/media';

const SIGN_FAIL = "Couldn't get a link for this asset. Try again.";
const SWIPE_THRESHOLD = 48;

interface AssetLightboxProps {
  /** The navigable list: the currently filtered/searched assets, links excluded. */
  items: AssetListItem[];
  index: number;
  presignEnabled: boolean;
  cache: PresignCache;
  /** Open the Info sheet immediately (used when reached from the long-press sheet). */
  initialInfoOpen?: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Soft-delete; resolves true on success so the viewer can close onto the new list. */
  onDelete: (item: AssetListItem) => Promise<boolean>;
  onToast: (message: string) => void;
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
 * presigned URL and shows a download-only panel for every other type. Navigation
 * (arrows, swipe, ArrowLeft/Right) wraps around the navigable list; Esc and a tap
 * on the scrim close. Only the viewed asset (and its immediate neighbours) is
 * presigned, never the whole list.
 */
export function AssetLightbox({
  items,
  index,
  presignEnabled,
  cache,
  initialInfoOpen = false,
  onIndexChange,
  onClose,
  onDelete,
  onToast,
}: AssetLightboxProps) {
  const item = items[index];
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(initialInfoOpen);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const touchStartX = useRef<number | null>(null);

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

  // Reset the delete confirm when navigating to another asset.
  useEffect(() => setConfirming(false), [index]);

  // Esc closes; arrows navigate. Lock body scroll while open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
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

  const handleDownload = (): void => {
    void withUrl((url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      onToast('Download started');
    });
  };

  const handleCopy = (): void => {
    void withUrl(async (url) => {
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
    });
  };

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    const ok = await onDelete(asset);
    if (ok) {
      onClose();
      onToast('Moved to Recently deleted');
      return;
    }
    setDeleting(false);
    setConfirming(false);
    onToast("Couldn't delete this asset. Try again.");
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
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
          <div className="m-4 flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center text-fg shadow-xl">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-panel-2 text-sm font-semibold tracking-wide text-fg-2">
              {typeLabel(kind)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="mt-1 text-xs text-fg-3">{humanizeSize(item.sizeBytes)}</p>
              {mediaFailed ? (
                <p className="mt-1 text-xs text-fg-3">This asset could not be loaded.</p>
              ) : null}
            </div>
            <Button variant="primary" className="h-11" onClick={handleDownload} disabled={busy}>
              <IconDownload size={16} />
              Download to view
            </Button>
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
              <Field label="Name" value={name} />
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
                  <p className="text-sm text-fg">
                    Delete {name}? It&apos;s attached in {item.attachmentCount}{' '}
                    {item.attachmentCount === 1 ? 'place' : 'places'}.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      className="h-11 flex-1"
                      onClick={() => setConfirming(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      className="h-11 flex-1"
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
                  className="h-11 w-full"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        </div>
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
