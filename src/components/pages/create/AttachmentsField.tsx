// A functional attachments block for the create sheet, replacing the old
// non-functional dropzone. Three add actions: Photo, Document, Link. Photo and
// Document run the SAME upload path the comment composer uses (precheck +
// uploadChatAttachment over the asset-upload worker, returning an asset VERSION
// id); Link reuses addAssetLink (POSTs the worker /links route) then resolves the
// new asset's current_version_id with a plain RLS-scoped select, mirroring
// src/lib/buckets.ts. The parent owns the ordered completed list via value +
// onChange; only completed items carry a versionId. The list/version helpers and
// the upload/link runners are pure so they unit-test with a fake uploader.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import { platformLabel } from '@srtdio/posts';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { IconFile, IconImagePlus, IconLink, IconX } from '@/components/ui/icons';
import { frameFor, type Frame, type FrameMedia } from '@/lib/platform-specs';
import {
  COMPOSER_FRAME_MAX_HEIGHT,
  frameCutText,
  frameMediaClass,
  PlatformFrame,
  PlatformFrameUpload,
} from '@/components/media/PlatformFrame';
import { frameMap } from '@/components/pages/pcs/pin-annotations';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { FileTiles, type PendingTile } from '@/components/pages/create/FileTiles';
import { RemoveButton } from '@/components/pages/create/RemoveButton';
import { createLimiter, UPLOAD_CONCURRENCY } from '@/components/pages/create/limiter';
import { moveWithin } from '@/components/pages/create/reorder';
import { useNewTrace } from '@/lib/trace-context';
import {
  addAssetLink,
  isValidLinkUrl,
  linkErrorMessage,
  precheckFile,
  UPLOAD_ACCEPT,
  type LinkOutcome,
} from '@/lib/asset-upload';
import {
  IMAGE_ACCEPT,
  precheckImage,
  uploadChatAttachment,
  type ChatAttachmentUpload,
} from '@/lib/chat/attachments';

/** Photos and videos from the upload allowlist: what a post's creative is. */
export const MEDIA_ACCEPT = ALLOWED_MIME_TYPES.filter(
  (mime) => isImageMime(mime) || mime.startsWith('video/'),
).join(',');

/** One completed attachment: a stable asset VERSION id, its render branch, the
 *  display name, and (for images) a local object-URL preview. */
export interface AttachmentItem {
  versionId: string;
  kind: 'image' | 'file' | 'link';
  name: string;
  previewUrl?: string;
  /** The picked file's MIME type (files only), for the format's soft file check. */
  mime?: string;
  /**
   * Not uploaded yet (the first post's sample photo): versionId is a local
   * placeholder until the sheet uploads this at Send and binds the real one.
   */
  localFile?: File;
}

/** The ordered asset VERSION ids the parent binds via gallery_set. */
export function attachmentVersionIds(items: readonly AttachmentItem[]): string[] {
  return items.map((item) => item.versionId);
}

/** Remove the item at index, preserving the order of the rest. */
export function removeAttachmentAt(
  items: readonly AttachmentItem[],
  index: number,
): AttachmentItem[] {
  return items.filter((_item, i) => i !== index);
}

export type AttachmentResult = { ok: true; item: AttachmentItem } | { ok: false; message: string };

/**
 * Pre-check then upload one picked file through the shared chat upload runner
 * (the comment composer's path). Photo runs the image-only pre-check; Document
 * runs the full allowlist pre-check. Returns the completed item with its VERSION
 * id, never throws.
 */
export async function runFileAttachment(
  file: File,
  isPhoto: boolean,
  uploadFile: (file: File) => Promise<ChatAttachmentUpload>,
): Promise<AttachmentResult> {
  const check = isPhoto ? precheckImage(file) : precheckFile(file);
  if (!check.ok) return { ok: false, message: check.message };
  const outcome = await uploadFile(file);
  if (!outcome.ok) return { ok: false, message: outcome.message };
  return {
    ok: true,
    item: {
      versionId: outcome.versionId,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      name: file.name,
      ...(file.type !== '' ? { mime: file.type } : {}),
    },
  };
}

export interface LinkAttachmentDeps {
  url: string;
  name: string;
  /** POST {workspace_id, url, name} to the worker /links route. */
  addLink: (url: string, name: string) => Promise<LinkOutcome>;
  /** Resolve the new asset's current_version_id via a plain RLS-scoped select. */
  resolveVersionId: (assetId: string) => Promise<string | null>;
}

/**
 * Add a link asset then resolve its current version id. Validates the url
 * client-side before any request (same gate as AddLinkSheet). Returns the
 * completed link item with its VERSION id, never throws.
 */
export async function runLinkAttachment(deps: LinkAttachmentDeps): Promise<AttachmentResult> {
  if (!isValidLinkUrl(deps.url)) return { ok: false, message: linkErrorMessage('invalid_url') };
  const outcome = await deps.addLink(deps.url, deps.name);
  if (!outcome.ok) return { ok: false, message: outcome.message };
  const versionId = await deps.resolveVersionId(outcome.assetId);
  if (versionId === null || versionId === '') {
    return { ok: false, message: linkErrorMessage('network') };
  }
  return { ok: true, item: { versionId, kind: 'link', name: deps.name.trim() } };
}

/**
 * Render the completed items: images as removable square thumbnail tiles, files
 * and links as removable rows (icon + name + remove). Pure so render + remove
 * wiring are unit-testable; ordering follows the items array. A framed composer
 * passes only its non-media items here (media sit in ComposerMediaFrame).
 */
export function attachmentItemList(
  items: readonly AttachmentItem[],
  onRemove: (index: number) => void,
): ReactElement[] {
  return items.map((item, index) => {
    if (isMediaItem(item)) {
      return (
        <li
          key={`${item.versionId}-${index}`}
          className="relative aspect-square h-20 shrink-0 overflow-hidden rounded-md border border-border bg-panel-3"
        >
          {item.previewUrl === undefined ? (
            <span className="flex h-full w-full items-center justify-center text-fg-3">
              <IconFile size={20} />
            </span>
          ) : item.kind === 'image' ? (
            <img src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
          ) : (
            <video
              src={item.previewUrl}
              muted
              playsInline
              preload="metadata"
              aria-label={item.name}
              className="h-full w-full object-cover"
            />
          )}
          <RemoveButton label={`Remove ${item.name}`} onRemove={() => onRemove(index)} />
        </li>
      );
    }
    return (
      <li
        key={`${item.versionId}-${index}`}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2"
      >
        <span className="shrink-0 text-fg-3">
          {item.kind === 'link' ? <IconLink size={16} /> : <IconFile size={16} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={item.name}>
          {item.name}
        </span>
        <IconButton label={`Remove ${item.name}`} onClick={() => onRemove(index)}>
          <IconX size={16} />
        </IconButton>
      </li>
    );
  });
}

/**
 * The create sheet's frame cap: the dropzone and the media in it keep the
 * platform ratio but never grow past this (a 4:5 frame on a tall laptop no
 * longer runs to 870px).
 */
export const CREATE_FRAME_MAX_HEIGHT = 'min(60vh, 440px)';

/** True for a photo, or a video with a local preview: what a frame can show. */
export function isMediaItem(item: AttachmentItem): boolean {
  return item.kind === 'image' || item.mime?.startsWith('video/') === true;
}

/** One local photo or video drawn in the post's platform frame. */
function FramedMediaTile({
  item,
  frame,
  removeLabel,
  onRemove,
  onMeasure,
  maxHeight = COMPOSER_FRAME_MAX_HEIGHT,
}: {
  item: AttachmentItem;
  frame: Frame;
  maxHeight?: string;
  removeLabel: string;
  /** Absent: no remove on the frame (the tile row carries it). */
  onRemove?: () => void;
  onMeasure: (versionId: string, w: number, h: number) => void;
}): ReactElement {
  const video = item.mime?.startsWith('video/') === true;
  const src = item.previewUrl;
  return (
    <PlatformFrame
      frame={frame}
      maxHeight={maxHeight}
      className="rounded-xl"
      backdrop={
        src !== undefined && !video ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : undefined
      }
    >
      {src === undefined ? (
        <span className="relative flex h-full w-full items-center justify-center text-fg-3">
          <IconFile size={22} />
        </span>
      ) : video ? (
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          aria-label={item.name}
          className={cn('relative', frameMediaClass(frame))}
          onLoadedMetadata={(event) =>
            onMeasure(
              item.versionId,
              event.currentTarget.videoWidth,
              event.currentTarget.videoHeight,
            )
          }
        />
      ) : (
        <img
          src={src}
          alt={item.name}
          className={cn('relative', frameMediaClass(frame))}
          onLoad={(event) =>
            onMeasure(
              item.versionId,
              event.currentTarget.naturalWidth,
              event.currentTarget.naturalHeight,
            )
          }
        />
      )}
      {onRemove !== undefined ? <RemoveButton label={removeLabel} onRemove={onRemove} /> : null}
    </PlatformFrame>
  );
}

/** The frame's slide counter: "1/3". Pure. */
export function slideCounterText(index: number, count: number): string {
  return `${index + 1}/${count}`;
}

/** The slide a carousel scrolled to, from its scroll offset and slide width (gap included). Pure. */
export function slideFromScroll(scrollLeft: number, slideWidth: number, count: number): number {
  if (slideWidth <= 0 || count <= 0) return 0;
  return Math.min(Math.max(Math.round(scrollLeft / slideWidth), 0), count - 1);
}

/** Gap between slides (Tailwind gap-2). */
const SLIDE_GAP = 8;

/**
 * The composer's media in the post's platform frame. No media yet: the empty
 * frame at the format's shape is the upload target. With media: each photo or
 * video fills the same frame (slides swipe on the X axis, as on the post page),
 * and the line under it says how much of the first photo the platform cuts.
 * With nav, the frame shows a "1/3" counter top-right and dots at the bottom,
 * follows the index it is given, reports swipes, and takes arrow keys. With
 * dropzone (the create sheet), the empty frame holds those add buttons instead
 * of being one big button, and the frame keeps the create sheet's cap.
 */
export function ComposerMediaFrame({
  frame,
  platform,
  items,
  measured,
  onMeasure,
  onRemove,
  removeLabel,
  pickLabel,
  pickDisabled = false,
  onPick,
  nav,
  dropzone,
}: {
  frame: Frame;
  platform: string;
  /** Every attachment; only photos and videos are drawn. onRemove gets the index here. */
  items: readonly AttachmentItem[];
  measured: Record<string, { w: number; h: number }>;
  onMeasure: (versionId: string, w: number, h: number) => void;
  onRemove: (index: number) => void;
  removeLabel: (item: AttachmentItem) => string;
  pickLabel: string;
  pickDisabled?: boolean;
  onPick: () => void;
  /** The create sheet: counter, dots, swipe and arrow keys; removes live on the tiles. */
  nav?: { index: number; onIndexChange: (index: number) => void };
  /** The add buttons drawn inside the empty frame (the create sheet). */
  dropzone?: ReactNode;
}): ReactElement {
  const media = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isMediaItem(item));
  const listRef = useRef<HTMLUListElement>(null);
  // The slide a programmatic scroll is heading to: swipe reports wait for it.
  const scrollTarget = useRef<number | null>(null);
  const count = media.length;
  const hasNav = nav !== undefined;
  const navIndex = nav === undefined ? 0 : Math.min(nav.index, Math.max(count - 1, 0));

  // Follow the index given (a tile tap, an arrow key): scroll that slide in.
  useEffect(() => {
    const list = listRef.current;
    if (!hasNav || list === null) return;
    const width = list.clientWidth + SLIDE_GAP;
    if (slideFromScroll(list.scrollLeft, width, count) === navIndex) return;
    const target = list.children[navIndex] as HTMLElement | undefined;
    if (target !== undefined && typeof list.scrollTo === 'function') {
      scrollTarget.current = navIndex;
      list.scrollTo({ left: target.offsetLeft - list.offsetLeft, behavior: 'smooth' });
    }
  }, [hasNav, navIndex, count]);

  const maxHeight = dropzone !== undefined ? CREATE_FRAME_MAX_HEIGHT : COMPOSER_FRAME_MAX_HEIGHT;
  const first = media[0]?.item;
  if (first === undefined && dropzone !== undefined) {
    return (
      <div className="flex justify-center">
        <PlatformFrame frame={frame} maxHeight={maxHeight} empty className="rounded-xl">
          <div
            data-dropzone=""
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-3"
          >
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-panel-3 text-accent"
            >
              <IconImagePlus size={22} />
            </span>
            {dropzone}
          </div>
        </PlatformFrame>
      </div>
    );
  }
  if (first === undefined) {
    return (
      <div className="flex justify-center">
        <PlatformFrameUpload
          frame={frame}
          maxHeight={COMPOSER_FRAME_MAX_HEIGHT}
          label={pickLabel}
          disabled={pickDisabled}
          onPick={onPick}
        />
      </div>
    );
  }
  const cut =
    first.kind === 'image'
      ? frameCutText(
          frameMap(measured[first.versionId] ?? null, frame.ratio, frame.fit),
          platformLabel(platform),
        )
      : null;

  function onScroll(): void {
    const list = listRef.current;
    if (nav === undefined || list === null) return;
    const at = slideFromScroll(list.scrollLeft, list.clientWidth + SLIDE_GAP, count);
    if (scrollTarget.current !== null) {
      if (at === scrollTarget.current) scrollTarget.current = null;
      return;
    }
    if (at !== navIndex) nav.onIndexChange(at);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (nav === undefined) return;
    if (event.key === 'ArrowRight' && navIndex < count - 1) {
      event.preventDefault();
      nav.onIndexChange(navIndex + 1);
    } else if (event.key === 'ArrowLeft' && navIndex > 0) {
      event.preventDefault();
      nav.onIndexChange(navIndex - 1);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <ul
          ref={listRef}
          aria-roledescription="carousel"
          {...(nav !== undefined
            ? {
                tabIndex: 0,
                'aria-label': 'Post media',
                onScroll,
                onKeyDown,
                // A finger on the frame takes over from any scroll still heading somewhere.
                onPointerDown: () => {
                  scrollTarget.current = null;
                },
              }
            : {})}
          className="flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {media.map(({ item, index }, slide) => (
            <li
              key={`${item.versionId}-${index}`}
              {...(nav !== undefined
                ? { 'aria-roledescription': 'slide', 'aria-label': slideCounterText(slide, count) }
                : {})}
              className="flex w-full shrink-0 snap-start justify-center"
            >
              <FramedMediaTile
                item={item}
                frame={frame}
                maxHeight={maxHeight}
                removeLabel={removeLabel(item)}
                {...(nav === undefined ? { onRemove: () => onRemove(index) } : {})}
                onMeasure={onMeasure}
              />
            </li>
          ))}
        </ul>
        {nav !== undefined && count > 1 ? (
          <>
            <span
              data-frame-counter=""
              aria-live="polite"
              className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white"
            >
              {slideCounterText(navIndex, count)}
            </span>
            <span
              data-frame-dots=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5"
            >
              {media.map(({ item, index }, slide) => (
                <span
                  key={`${item.versionId}-${index}`}
                  className={cn(
                    'h-1.5 w-1.5 rounded-full transition-colors motion-reduce:transition-none',
                    slide === navIndex ? 'bg-white' : 'bg-white/50',
                  )}
                />
              ))}
            </span>
          </>
        ) : null}
      </div>
      {cut !== null ? (
        <p data-frame-cut className="text-[13px] text-fg-2">
          {cut}
        </p>
      ) : null}
    </div>
  );
}

/** Resolve an asset's current version id via a plain RLS-scoped select. */
async function resolveCurrentVersionId(assetId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('current_version_id')
    .eq('id', assetId)
    .single();
  if (error || data === null) return null;
  return (data as { current_version_id: string | null }).current_version_id ?? null;
}

type Pending = {
  id: string;
  /** Pick order: a finished file takes its picked place among the others. */
  seq: number;
  name: string;
  kind: 'image' | 'file' | 'link';
  /** The picked photo or video's own local picture, shown on its tile from the pick. */
  previewUrl: string | null;
  error: string | null;
  /** Upload progress 0..1 while the request runs. */
  progress: number;
  /** The picked file and its pre-check branch, kept so a failed row can Retry. */
  file?: File;
  isPhoto?: boolean;
  /** A failed link's input, kept so its row can Retry. */
  link?: { url: string; name: string };
};

/** Rows still uploading (failed rows are not counted). Pure. */
export function pendingUploadCount(rows: readonly { error: string | null }[]): number {
  return rows.filter((row) => row.error === null).length;
}

/** Files that failed to upload (failed links are not files). Pure. */
export function failedUploadCount(
  rows: readonly { error: string | null; file?: File | undefined }[],
): number {
  return rows.filter((row) => row.error !== null && row.file !== undefined).length;
}

/** The line under the tiles while files failed: "1 file didn't upload." Pure. */
export function failedFilesLine(count: number): string {
  return count === 1 ? "1 file didn't upload." : `${count} files didn't upload.`;
}

/**
 * Put a finished item at its picked place: before the first item picked after
 * it (items with no known pick order stay where they are). Pure.
 */
export function insertBySeq(
  items: readonly AttachmentItem[],
  item: AttachmentItem,
  seq: number,
  seqOf: (item: AttachmentItem) => number | undefined,
): AttachmentItem[] {
  const at = items.findIndex((other) => {
    const s = seqOf(other);
    return s !== undefined && s > seq;
  });
  return at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)];
}

let pendingSeq = 0;

interface AttachmentsFieldProps {
  workspaceId: string | null;
  value: AttachmentItem[];
  onChange: (items: AttachmentItem[]) => void;
  /**
   * The post's platform and format: media render in the same platform frame the
   * post page shows (frameFor), and with no media yet the empty frame is the
   * upload target. Absent (briefs), or a format with no frame: square tiles.
   */
  frame?: { platform: string; format: string } | null;
  /** How many files are still uploading; called whenever that count changes. */
  onPendingChange?: (count: number) => void;
  /** How many files failed and wait for Retry or Remove; called whenever that changes. */
  onFailedChange?: (count: number) => void;
  /** Once per pick, after its files have all finished: the ones that uploaded. */
  onPickDone?: (items: AttachmentItem[]) => void;
}

export function AttachmentsField({
  workspaceId,
  value,
  onChange,
  frame,
  onPendingChange,
  onFailedChange,
  onPickDone,
}: AttachmentsFieldProps): ReactElement {
  const newTrace = useNewTrace();
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;

  const [pending, setPending] = useState<Pending[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkName, setLinkName] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [slide, setSlide] = useState(0);

  const [measured, setMeasured] = useState<Record<string, { w: number; h: number }>>({});
  const photoInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  // Up to three files upload at once; the rest wait in pick order.
  const limiter = useRef(createLimiter(UPLOAD_CONCURRENCY));
  // Each finished file's pick order, so it lands at its picked place.
  const seqs = useRef(new Map<string, number>());
  // An upload that finishes after the sheet closed frees its preview instead of
  // handing it to a form that is gone.
  const alive = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const row of pendingRef.current) {
        if (row.previewUrl !== null) URL.revokeObjectURL(row.previewUrl);
      }
    };
  }, []);

  // value is a prop, so parallel uploads read (and advance) the latest through
  // this ref rather than a stale closure capture.
  const valueRef = useRef(value);
  valueRef.current = value;

  const pendingCount = pendingUploadCount(pending);
  const failedCount = failedUploadCount(pending);
  const pendingChangeRef = useRef(onPendingChange);
  pendingChangeRef.current = onPendingChange;
  useEffect(() => {
    pendingChangeRef.current?.(pendingCount);
  }, [pendingCount]);
  const failedChangeRef = useRef(onFailedChange);
  failedChangeRef.current = onFailedChange;
  useEffect(() => {
    failedChangeRef.current?.(failedCount);
  }, [failedCount]);
  const pickDoneRef = useRef(onPickDone);
  pickDoneRef.current = onPickDone;

  // Upload one picked file via the shared chat upload runner (the comment
  // composer's path) over XHR so its tile shows progress, returning an asset
  // VERSION id. Never throws.
  const uploadFile = useCallback(
    async (file: File, onProgress: (fraction: number) => void): Promise<ChatAttachmentUpload> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '' || workspaceId === null) {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return uploadChatAttachment({
        file,
        workspaceId,
        origin: 'library',
        token,
        endpoint: uploadEndpoint,
        xhr: { traceId: newTrace(), onProgress },
      });
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  const addLink = useCallback(
    async (url: string, name: string): Promise<LinkOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '' || workspaceId === null) {
        return { ok: false, message: linkErrorMessage('network') };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return addAssetLink({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        url,
        name,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  function setProgress(id: string, fraction: number): void {
    if (!alive.current) return;
    setPending((prev) =>
      prev.map((item) => (item.id === id ? { ...item, progress: fraction } : item)),
    );
  }

  // Every picked file shows its tile (its own picture) at once; up to three
  // upload at a time, and each lands at its picked place when done. Once the
  // whole pick has finished, the parent hears about it once.
  async function addFiles(list: FileList | null, isPhoto: boolean): Promise<void> {
    if (list === null) return;
    const rows: Pending[] = Array.from(list).map((file) => {
      pendingSeq += 1;
      const isImage = isPhoto || file.type.startsWith('image/');
      const media = isImage || file.type.startsWith('video/');
      return {
        id: `att-${pendingSeq}`,
        seq: pendingSeq,
        name: file.name,
        kind: isImage ? ('image' as const) : ('file' as const),
        previewUrl: media ? URL.createObjectURL(file) : null,
        error: null,
        progress: 0,
        file,
        isPhoto,
      };
    });
    setPending((prev) => [...prev, ...rows]);
    const done = await Promise.all(rows.map((row) => limiter.current.run(() => uploadRow(row))));
    if (!alive.current) return;
    const items = done.filter((item): item is AttachmentItem => item !== null);
    if (items.length > 0) pickDoneRef.current?.(items);
  }

  // Upload one row's file; success moves it to the completed list at its picked
  // place, failure keeps the row (with its file and picture) so Retry can run it.
  async function uploadRow(row: Pending): Promise<AttachmentItem | null> {
    if (!alive.current || row.file === undefined) return null;
    const result = await runFileAttachment(row.file, row.isPhoto === true, (file) =>
      uploadFile(file, (fraction) => setProgress(row.id, fraction)),
    );
    if (!alive.current) return null;
    if (result.ok) {
      const item: AttachmentItem = {
        ...result.item,
        ...(row.previewUrl !== null ? { previewUrl: row.previewUrl } : {}),
      };
      seqs.current.set(item.versionId, row.seq);
      setPending((prev) => prev.filter((other) => other.id !== row.id));
      const next = insertBySeq(valueRef.current, item, row.seq, (other) =>
        seqs.current.get(other.versionId),
      );
      valueRef.current = next;
      onChange(next);
      return item;
    }
    setPending((prev) =>
      prev.map((other) =>
        other.id === row.id ? { ...other, error: result.message, progress: 0 } : other,
      ),
    );
    return null;
  }

  function retryPending(id: string): void {
    const row = pending.find((item) => item.id === id);
    if (row === undefined) return;
    if (row.link !== undefined) {
      void retryLink(row.id, row.link);
      return;
    }
    if (row.file === undefined) return;
    const fresh: Pending = { ...row, error: null, progress: 0 };
    setPending((prev) => prev.map((item) => (item.id === id ? fresh : item)));
    void limiter.current
      .run(() => uploadRow(fresh))
      .then((item) => {
        if (item !== null && alive.current) pickDoneRef.current?.([item]);
      });
  }

  function retryFailed(): void {
    for (const row of pending) {
      if (row.error !== null && row.file !== undefined) retryPending(row.id);
    }
  }

  function removeFailed(): void {
    for (const row of pending) {
      if (row.error !== null && row.file !== undefined && row.previewUrl !== null) {
        URL.revokeObjectURL(row.previewUrl);
      }
    }
    setPending((prev) => prev.filter((row) => row.error === null || row.file === undefined));
  }

  async function retryLink(id: string, link: { url: string; name: string }): Promise<void> {
    setPending((prev) => prev.map((item) => (item.id === id ? { ...item, error: null } : item)));
    const result = await runLinkAttachment({
      url: link.url,
      name: link.name,
      addLink,
      resolveVersionId: resolveCurrentVersionId,
    });
    if (!alive.current) return;
    if (result.ok) {
      setPending((prev) => prev.filter((item) => item.id !== id));
      const next = [...valueRef.current, result.item];
      valueRef.current = next;
      onChange(next);
    } else {
      setPending((prev) =>
        prev.map((item) => (item.id === id ? { ...item, error: result.message } : item)),
      );
    }
  }

  async function submitLink(): Promise<void> {
    if (linkBusy) return;
    setLinkBusy(true);
    const result = await runLinkAttachment({
      url: linkUrl,
      name: linkName,
      addLink,
      resolveVersionId: resolveCurrentVersionId,
    });
    setLinkBusy(false);
    if (result.ok) {
      const next = [...valueRef.current, result.item];
      valueRef.current = next;
      onChange(next);
      setLinkUrl('');
      setLinkName('');
      setLinkOpen(false);
    } else {
      pendingSeq += 1;
      setPending((prev) => [
        ...prev,
        {
          id: `link-${pendingSeq}-err`,
          seq: pendingSeq,
          name: linkName.trim() === '' ? linkUrl : linkName.trim(),
          kind: 'link',
          previewUrl: null,
          error: result.message,
          progress: 0,
          link: { url: linkUrl, name: linkName },
        },
      ]);
    }
  }

  function removeCompleted(index: number): void {
    const target = value[index];
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    const next = removeAttachmentAt(value, index);
    valueRef.current = next;
    onChange(next);
  }

  function dismissPending(id: string): void {
    const row = pending.find((item) => item.id === id);
    if (row?.previewUrl !== null && row?.previewUrl !== undefined) {
      URL.revokeObjectURL(row.previewUrl);
    }
    setPending((prev) => prev.filter((item) => item.id !== id));
  }

  const linkValid = isValidLinkUrl(linkUrl) && linkName.trim() !== '';
  const postFrame =
    frame !== null && frame !== undefined
      ? frameFor(frame.platform, frame.format, firstMedia(value, measured))
      : null;
  const framed = postFrame !== null;
  // Framed: media sit in the frame and the tile row, files and links list below.
  const listed = value
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !framed || !isMediaItem(item));
  const media = value
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isMediaItem(item));
  // Framed: a picked photo or video has a tile; anything else keeps its row.
  const pendingTiles: PendingTile[] = framed
    ? pending
        .filter((row) => row.previewUrl !== null)
        .map((row) => ({
          id: row.id,
          name: row.name,
          previewUrl: row.previewUrl ?? '',
          video: row.file?.type.startsWith('video/') === true,
          progress: row.progress,
          failed: row.error !== null,
        }))
    : [];
  const pendingRows = framed ? pending.filter((row) => row.previewUrl === null) : pending;
  const slideAt = Math.min(slide, Math.max(media.length - 1, 0));

  function measure(versionId: string, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    setMeasured((prev) =>
      prev[versionId] !== undefined ? prev : { ...prev, [versionId]: { w, h } },
    );
  }

  function reorderMedia(from: number, to: number): void {
    const next = moveWithin(value, isMediaItem, from, to);
    valueRef.current = next;
    onChange(next);
    setSlide(to);
  }

  // Framed with no media yet: the buttons sit inside the empty frame, and Photo
  // takes a photo or video (the frame's own picker; it waits while uploads run).
  const dropzoneEmpty = framed && media.length === 0;
  const addButtons = (
    <div className={cn('flex flex-wrap gap-2', dropzoneEmpty && 'justify-center')}>
      <Button
        type="button"
        size="lg"
        disabled={dropzoneEmpty && pendingCount > 0}
        onClick={() => (dropzoneEmpty ? mediaInputRef : photoInputRef).current?.click()}
      >
        Photo
      </Button>
      <Button type="button" size="lg" onClick={() => docInputRef.current?.click()}>
        Document
      </Button>
      <Button type="button" size="lg" onClick={() => setLinkOpen((prev) => !prev)}>
        <IconLink size={16} />
        Link
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {framed ? null : addButtons}

      {postFrame !== null && frame !== null && frame !== undefined ? (
        <ComposerMediaFrame
          frame={postFrame}
          platform={frame.platform}
          items={value}
          measured={measured}
          onMeasure={measure}
          onRemove={removeCompleted}
          removeLabel={(item) => `Remove ${item.name}`}
          pickLabel="Add a photo or video"
          // The empty frame cannot be tapped while uploads run.
          pickDisabled={pendingCount > 0}
          onPick={() => mediaInputRef.current?.click()}
          nav={{ index: slideAt, onIndexChange: setSlide }}
          dropzone={addButtons}
        />
      ) : null}

      {framed && (media.length > 0 || pendingTiles.length > 0) ? (
        <FileTiles
          items={media.map(({ item }) => item)}
          pending={pendingTiles}
          activeIndex={slideAt}
          onSelect={setSlide}
          onRemove={(at) => {
            const target = media[at];
            if (target !== undefined) removeCompleted(target.index);
          }}
          onReorder={reorderMedia}
        />
      ) : null}

      {framed && failedCount > 0 ? (
        <div
          data-upload-failed=""
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-bad bg-bad-soft px-3 py-1"
        >
          <p className="min-w-0 flex-1 text-sm text-bad">{failedFilesLine(failedCount)}</p>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className="shrink-0 px-3 text-accent"
            onClick={retryFailed}
          >
            Retry
          </Button>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className="shrink-0 px-3 text-bad"
            onClick={removeFailed}
          >
            Remove
          </Button>
        </div>
      ) : null}

      {framed && !dropzoneEmpty ? addButtons : null}

      {linkOpen ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-3">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://..."
            aria-label="Link URL"
            value={linkUrl}
            disabled={linkBusy}
            onChange={(event) => setLinkUrl(event.target.value)}
          />
          <Input
            placeholder="What should this link be called?"
            aria-label="Link name"
            value={linkName}
            disabled={linkBusy}
            onChange={(event) => setLinkName(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="lg"
              variant="primary"
              disabled={!linkValid || linkBusy}
              onClick={() => void submitLink()}
            >
              {linkBusy ? 'Adding' : 'Add link'}
            </Button>
            <Button type="button" size="lg" variant="ghost" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {listed.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachmentItemList(
            listed.map(({ item }) => item),
            (index) => {
              const at = listed[index];
              if (at !== undefined) removeCompleted(at.index);
            },
          )}
        </ul>
      ) : null}

      {pendingRows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {pendingRows.map((item) => {
            // Framed: a failed document is covered by the "didn't upload" bar
            // (its Retry and Remove), so its row only marks which file failed.
            const coveredByBar = framed && item.error !== null && item.file !== undefined;
            return coveredByBar ? (
              <li key={item.id} data-failed="" className={cnPending(item.error)}>
                <span className="shrink-0 text-fg-3">
                  <IconFile size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg" title={item.name}>
                  {item.name}
                </span>
              </li>
            ) : (
              <li key={item.id} className={cnPending(item.error)}>
                <span className="shrink-0 text-fg-3">
                  {item.kind === 'link' ? <IconLink size={16} /> : <IconFile size={16} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg" title={item.name}>
                  {item.name}
                </span>
                <span
                  className={item.error !== null ? 'text-[11px] text-bad' : 'text-[11px] text-fg-3'}
                >
                  {item.error ?? 'Uploading'}
                </span>
                {item.error !== null && (item.file !== undefined || item.link !== undefined) ? (
                  <Button
                    type="button"
                    size="lg"
                    variant="ghost"
                    className="min-w-[44px] shrink-0 px-2 text-accent"
                    aria-label={`Retry ${item.name}`}
                    onClick={() => retryPending(item.id)}
                  >
                    Retry
                  </Button>
                ) : null}
                {item.error !== null ? (
                  <IconButton
                    label={`Dismiss ${item.name}`}
                    onClick={() => dismissPending(item.id)}
                  >
                    <IconX size={16} />
                  </IconButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={IMAGE_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files, true);
          event.target.value = '';
        }}
      />
      <input
        ref={mediaInputRef}
        type="file"
        multiple
        accept={MEDIA_ACCEPT}
        className="sr-only"
        aria-label="Add a photo or video"
        onChange={(event) => {
          void addFiles(event.target.files, false);
          event.target.value = '';
        }}
      />
      <input
        ref={docInputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files, false);
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** The first attached image or video, for the frame rule (links and files skipped). */
export function firstMedia(
  items: readonly AttachmentItem[],
  measured: Record<string, { w: number; h: number }>,
): FrameMedia | null {
  const first = items.find(isMediaItem);
  if (first === undefined) return null;
  const dims = measured[first.versionId];
  return {
    kind: first.kind === 'image' ? 'image' : 'video',
    w: dims?.w ?? null,
    h: dims?.h ?? null,
  };
}

function cnPending(error: string | null): string {
  return error !== null
    ? 'flex min-h-[44px] w-full items-center gap-2 rounded-md border border-bad bg-panel-2 px-3 py-2'
    : 'flex min-h-[44px] w-full items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2';
}
