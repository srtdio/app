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
import type { ReactElement } from 'react';
import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import { platformLabel } from '@srtdio/posts';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { IconFile, IconLink, IconX } from '@/components/ui/icons';
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

/** True for a photo, or a video with a local preview: what a frame can show. */
export function isMediaItem(item: AttachmentItem): boolean {
  return item.kind === 'image' || item.mime?.startsWith('video/') === true;
}

/** A 44x44 remove control laid over a tile's corner. */
function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onRemove}
      className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white"
    >
      <IconX size={14} />
    </button>
  );
}

/** One local photo or video drawn in the post's platform frame. */
function FramedMediaTile({
  item,
  frame,
  removeLabel,
  onRemove,
  onMeasure,
}: {
  item: AttachmentItem;
  frame: Frame;
  removeLabel: string;
  onRemove: () => void;
  onMeasure: (versionId: string, w: number, h: number) => void;
}): ReactElement {
  const video = item.mime?.startsWith('video/') === true;
  const src = item.previewUrl;
  return (
    <PlatformFrame
      frame={frame}
      maxHeight={COMPOSER_FRAME_MAX_HEIGHT}
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
      <RemoveButton label={removeLabel} onRemove={onRemove} />
    </PlatformFrame>
  );
}

/**
 * The composer's media in the post's platform frame. No media yet: the empty
 * frame at the format's shape is the upload target. With media: each photo or
 * video fills the same frame (slides swipe on the X axis, as on the post page),
 * and the line under it says how much of the first photo the platform cuts.
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
}): ReactElement {
  const media = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isMediaItem(item));
  const first = media[0]?.item;
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
  return (
    <div className="flex flex-col gap-1">
      <ul
        aria-roledescription="carousel"
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain"
      >
        {media.map(({ item, index }) => (
          <li
            key={`${item.versionId}-${index}`}
            className="flex w-full shrink-0 snap-start justify-center"
          >
            <FramedMediaTile
              item={item}
              frame={frame}
              removeLabel={removeLabel(item)}
              onRemove={() => onRemove(index)}
              onMeasure={onMeasure}
            />
          </li>
        ))}
      </ul>
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
  name: string;
  kind: 'image' | 'file' | 'link';
  previewUrl: string | null;
  error: string | null;
};

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
}

export function AttachmentsField({
  workspaceId,
  value,
  onChange,
  frame,
}: AttachmentsFieldProps): ReactElement {
  const newTrace = useNewTrace();
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;

  const [pending, setPending] = useState<Pending[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkName, setLinkName] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);

  const [measured, setMeasured] = useState<Record<string, { w: number; h: number }>>({});
  const photoInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  // An upload that finishes after the sheet closed frees its preview instead of
  // handing it to a form that is gone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // value is a prop, so a sequential add loop reads the latest through this ref
  // rather than a stale closure capture.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Upload one picked file via the shared chat upload runner (the comment
  // composer's path), returning an asset VERSION id. Never throws.
  const uploadFile = useCallback(
    async (file: File): Promise<ChatAttachmentUpload> => {
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
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
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

  async function addFiles(list: FileList | null, isPhoto: boolean): Promise<void> {
    if (list === null) return;
    for (const file of Array.from(list)) {
      const id = `att-${(pendingSeq += 1)}`;
      const isImage = isPhoto || file.type.startsWith('image/');
      const previewUrl =
        isImage || file.type.startsWith('video/') ? URL.createObjectURL(file) : null;
      setPending((prev) => [
        ...prev,
        { id, name: file.name, kind: isImage ? 'image' : 'file', previewUrl, error: null },
      ]);
      const result = await runFileAttachment(file, isPhoto, uploadFile);
      if (!alive.current) {
        if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
        return;
      }
      setPending((prev) => prev.filter((item) => item.id !== id));
      if (result.ok) {
        onChange([
          ...valueRef.current,
          { ...result.item, ...(previewUrl !== null ? { previewUrl } : {}) },
        ]);
      } else {
        if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
        setPending((prev) => [
          ...prev,
          {
            id: `${id}-err`,
            name: file.name,
            kind: isImage ? 'image' : 'file',
            previewUrl: null,
            error: result.message,
          },
        ]);
      }
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
      onChange([...valueRef.current, result.item]);
      setLinkUrl('');
      setLinkName('');
      setLinkOpen(false);
    } else {
      setPending((prev) => [
        ...prev,
        {
          id: `link-${(pendingSeq += 1)}-err`,
          name: linkName.trim() === '' ? linkUrl : linkName.trim(),
          kind: 'link',
          previewUrl: null,
          error: result.message,
        },
      ]);
    }
  }

  function removeCompleted(index: number): void {
    const target = value[index];
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    onChange(removeAttachmentAt(value, index));
  }

  function dismissPending(id: string): void {
    setPending((prev) => prev.filter((item) => item.id !== id));
  }

  const linkValid = isValidLinkUrl(linkUrl) && linkName.trim() !== '';
  const postFrame =
    frame !== null && frame !== undefined
      ? frameFor(frame.platform, frame.format, firstMedia(value, measured))
      : null;
  // Framed: media sit in the frame, files and links list below it.
  const listed = value
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => postFrame === null || !isMediaItem(item));
  function measure(versionId: string, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    setMeasured((prev) =>
      prev[versionId] !== undefined ? prev : { ...prev, [versionId]: { w, h } },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="lg" onClick={() => photoInputRef.current?.click()}>
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
          onPick={() => mediaInputRef.current?.click()}
        />
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

      {pending.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {pending.map((item) => (
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
              {item.error !== null ? (
                <IconButton label={`Dismiss ${item.name}`} onClick={() => dismissPending(item.id)}>
                  <IconX size={16} />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={photoInputRef}
        type="file"
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
