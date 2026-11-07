// The post sheet's media field on an induction post step. It runs the existing
// upload path (uploadChatAttachment over the asset-upload Worker, XHR for
// progress) and adds what a first upload on a weak connection needs: the one
// upload look (ui/UploadRing on the photo, filling with the real progress; its
// X cancels) with a size line ("1.2 of 3.4 MB"), three automatic retries, then
// a plain reason with Retry in the ring's spot (UploadRetry). File names are never shown (phones name photos
// IMG_4821.HEIC). The rest of the sheet keeps everything typed whatever
// happens here. Chunked background upload is a later backend PR. On the
// first post (fillOnTap) a tap attaches the bundled sample photo instead of
// opening the picker; nothing is uploaded until Send (uploadLocalFile).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { isImageMime } from '@srtdio/storage';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconTrash, IconVideo, ICON_SIZE } from '@/components/ui/icons';
import { UploadRetry, UploadRing, uploadSizeMeta } from '@/components/ui/UploadRing';
import {
  ComposerMediaFrame,
  firstMedia,
  MEDIA_ACCEPT,
  removeAttachmentAt,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import { frameFor } from '@/lib/platform-specs';
import { precheckFile } from '@/lib/asset-upload';
import { uploadChatAttachment } from '@/lib/chat/attachments';
import { attachLateThumbnail } from '@/lib/asset-thumbnail-attach';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { INDUCTION_KEYS, UPLOAD_RETRIES, uploadFailedReason, withRetries } from '@/lib/induction';
import { FIRST_POST_SAMPLE } from '@/lib/induction-copy';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { errorText } from '@/lib/error-copy';

/** The upload path itself is not set up (no endpoint or session): nothing was sent. */
const NOT_STARTED = errorText('start the upload', null);

type Upload =
  | { phase: 'idle' }
  /** sent: the share of the bytes sent so far, 0..1. */
  | { phase: 'sending'; file: File; previewUrl: string | null; sent: number; retrying: boolean }
  /** file null: the sample photo did not load; Try again loads it again. */
  | { phase: 'failed'; file: File | null; previewUrl: string | null; reason: string };

/** The placeholder version id of the sample photo until Send uploads it. */
export const SAMPLE_VERSION_ID = 'local-first-post';

/** The bundled sample photo as a file, or null when it did not load. */
async function loadSamplePhoto(traceId: string): Promise<File | null> {
  try {
    const res = await fetchWithTrace(FIRST_POST_SAMPLE.photoPath, undefined, traceId);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], FIRST_POST_SAMPLE.photoName, { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

/** One attempt over the asset-upload Worker; its real progress goes to onProgress. */
async function attemptUpload(input: {
  file: File;
  workspaceId: string;
  endpoint: string;
  token: string;
  traceId: string;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true; value: string } | { ok: false }> {
  const result = await uploadChatAttachment({
    file: input.file,
    workspaceId: input.workspaceId,
    origin: 'library',
    token: input.token,
    endpoint: input.endpoint,
    attachThumbnail: attachLateThumbnail,
    xhr: {
      traceId: input.traceId,
      onProgress: input.onProgress,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  });
  return result.ok ? { ok: true, value: result.versionId } : { ok: false };
}

/** A file kept local until Send (the sample photo): the same path and retries as a picked one. */
export async function uploadLocalFile(input: {
  file: File;
  workspaceId: string;
  newTrace: () => string;
}): Promise<{ ok: true; versionId: string } | { ok: false; reason: string }> {
  const check = precheckFile(input.file);
  if (!check.ok) return { ok: false, reason: check.message };
  const endpoint = env.VITE_ASSET_UPLOAD_URL;
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
  if (endpoint === undefined || endpoint === '' || token === '') {
    return { ok: false, reason: NOT_STARTED };
  }
  const outcome = await withRetries(
    () =>
      attemptUpload({
        file: input.file,
        workspaceId: input.workspaceId,
        endpoint,
        token,
        traceId: input.newTrace(),
        onProgress: () => undefined,
      }),
    UPLOAD_RETRIES,
    () => undefined,
  );
  return outcome.ok
    ? { ok: true, versionId: outcome.value }
    : { ok: false, reason: uploadFailedReason(outcome.failures) };
}

export function PresetMediaField({
  workspaceId,
  value,
  onChange,
  required,
  onBusyChange,
  frame,
  fillOnTap,
}: {
  workspaceId: string | null;
  value: AttachmentItem[];
  onChange: (items: AttachmentItem[]) => void;
  required: boolean;
  onBusyChange: (busy: boolean) => void;
  /**
   * The post's platform and format: the empty frame at the format's shape is
   * the upload target and media fill it, as on the post page. null, or a format
   * with no frame: small square tiles.
   */
  frame: { platform: string; format: string } | null;
  /** The first post: a tap attaches the sample photo (or, with one attached, only moves on). */
  fillOnTap?: { onFilled: () => void };
}): ReactElement {
  const newTrace = useNewTrace();
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload>({ phase: 'idle' });
  const [measured, setMeasured] = useState<Record<string, { w: number; h: number }>>({});
  const valueRef = useRef(value);
  valueRef.current = value;
  const alive = useRef(true);
  // The running upload: the ring's X aborts it (and stops its retries).
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** previewUrl: the failed photo's own picture, reused when it is retried. */
  async function send(file: File, previewUrl: string | null = previewOf(file)): Promise<void> {
    const check = precheckFile(file);
    if (!check.ok) {
      setUpload({ phase: 'failed', file, previewUrl, reason: check.message });
      return;
    }
    const endpoint = env.VITE_ASSET_UPLOAD_URL;
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
    if (endpoint === undefined || endpoint === '' || workspaceId === null || token === '') {
      setUpload({ phase: 'failed', file, previewUrl, reason: NOT_STARTED });
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    onBusyChange(true);
    setUpload({ phase: 'sending', file, previewUrl, sent: 0, retrying: false });
    const outcome = await withRetries(
      () => attemptOnce({ file, workspaceId, endpoint, token, signal: abort.signal }),
      UPLOAD_RETRIES,
      () => {
        if (alive.current && !abort.signal.aborted) {
          setUpload({ phase: 'sending', file, previewUrl, sent: 0, retrying: true });
        }
      },
    );
    // Cancelled: the field is already back at rest.
    if (!alive.current || abort.signal.aborted) return;
    abortRef.current = null;
    onBusyChange(false);
    if (!outcome.ok) {
      setUpload({
        phase: 'failed',
        file,
        previewUrl,
        reason: uploadFailedReason(outcome.failures),
      });
      return;
    }
    setUpload({ phase: 'idle' });
    onChange([
      ...valueRef.current,
      {
        versionId: outcome.value,
        kind: isImageMime(file.type) ? 'image' : 'file',
        name: file.name,
        ...(previewUrl !== null ? { previewUrl } : {}),
        ...(file.type !== '' ? { mime: file.type } : {}),
      },
    ]);
  }

  /** One attempt; its real progress fills the ring. A cancelled upload sends nothing more. */
  async function attemptOnce(input: {
    file: File;
    workspaceId: string;
    endpoint: string;
    token: string;
    signal: AbortSignal;
  }): Promise<{ ok: true; value: string } | { ok: false }> {
    if (input.signal.aborted) return { ok: false };
    return attemptUpload({
      ...input,
      traceId: newTrace(),
      onProgress: (fraction) => {
        if (!alive.current) return;
        setUpload((prev) => (prev.phase === 'sending' ? { ...prev, sent: fraction } : prev));
      },
    });
  }

  /** The ring's X: stop the upload at once (no confirm) and drop the photo. */
  function cancel(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    if (upload.phase !== 'idle' && upload.previewUrl !== null) {
      URL.revokeObjectURL(upload.previewUrl);
    }
    setUpload({ phase: 'idle' });
    onBusyChange(false);
  }

  /** The sample photo, shown from its local copy; the sheet uploads it at Send. */
  async function attachSample(onFilled: () => void): Promise<void> {
    const file = await loadSamplePhoto(newTrace());
    if (!alive.current) return;
    if (file === null) {
      setUpload({ phase: 'failed', file: null, previewUrl: null, reason: NOT_STARTED });
      return;
    }
    setUpload({ phase: 'idle' });
    onChange([
      ...valueRef.current,
      {
        versionId: SAMPLE_VERSION_ID,
        kind: 'image',
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        mime: file.type,
        localFile: file,
      },
    ]);
    onFilled();
  }

  /** The photo field's tap: the picker, or on the first post the sample photo. */
  function pick(): void {
    if (fillOnTap === undefined) {
      inputRef.current?.click();
      return;
    }
    if (valueRef.current.length > 0) fillOnTap.onFilled();
    else void attachSample(fillOnTap.onFilled);
  }

  function retry(failed: File | null, previewUrl: string | null): void {
    if (failed !== null) void send(failed, previewUrl);
    else if (fillOnTap !== undefined) void attachSample(fillOnTap.onFilled);
  }

  function remove(index: number): void {
    const target = value[index];
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    onChange(removeAttachmentAt(value, index));
  }

  function measure(versionId: string, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    setMeasured((prev) =>
      prev[versionId] !== undefined ? prev : { ...prev, [versionId]: { w, h } },
    );
  }

  const sending = upload.phase === 'sending';
  const postFrame =
    frame !== null ? frameFor(frame.platform, frame.format, firstMedia(value, measured)) : null;
  return (
    <div className="flex flex-col gap-3">
      {postFrame !== null && frame !== null ? (
        <ComposerMediaFrame
          frame={postFrame}
          platform={frame.platform}
          items={value}
          measured={measured}
          onMeasure={measure}
          onRemove={remove}
          removeLabel={(item) => (item.kind === 'image' ? 'Remove photo' : 'Remove video')}
          pickLabel="Add a photo or video"
          pickDisabled={sending}
          onPick={pick}
        />
      ) : value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((item, index) => (
            <MediaTile
              key={`${item.versionId}-${index}`}
              item={item}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      ) : null}
      {upload.phase === 'sending' || (upload.phase === 'failed' && upload.file !== null) ? (
        <ul className="flex flex-wrap gap-2">
          <PendingPhoto
            previewUrl={upload.previewUrl}
            video={upload.file?.type.startsWith('video/') === true}
            {...(upload.phase === 'sending'
              ? { progress: ringProgress(upload.sent), onCancel: cancel }
              : { onRetry: () => retry(upload.file, upload.previewUrl) })}
          />
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={sending}
          data-induction={INDUCTION_KEYS.postSheetMedia}
          onClick={pick}
        >
          {value.length > 0 ? 'Add another' : 'Add a photo or video'}
        </Button>
        {/* A photo that failed retries from the ring spot on it; the sample
            photo that did not load has no picture, so it retries here. */}
        {upload.phase === 'failed' && upload.file === null ? (
          <Button type="button" variant="ghost" onClick={() => retry(null, null)}>
            Retry
          </Button>
        ) : null}
      </div>
      <p
        aria-live="polite"
        className={upload.phase === 'failed' ? 'text-base text-bad' : 'text-base text-fg'}
      >
        {upload.phase === 'sending'
          ? uploadLine(upload.sent, upload.file.size, upload.retrying)
          : upload.phase === 'failed'
            ? upload.reason
            : required
              ? 'This format needs a photo or a video.'
              : 'Optional for this format.'}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        className="sr-only"
        aria-label="Add a photo or video"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void send(file);
        }}
      />
    </div>
  );
}

/** The photo's own picture while it uploads (images only; a video shows its glyph). */
function previewOf(file: File): string | null {
  return isImageMime(file.type) || file.type.startsWith('video/')
    ? URL.createObjectURL(file)
    : null;
}

/**
 * The ring's fill for the bytes sent so far (0..1). Sending ends at 0.9: the
 * server still checks and stores the photo after the last byte, so a full ring
 * never shows before the photo is in the post (it then leaves the field).
 */
export function ringProgress(fraction: number): number {
  return Math.min(Math.max(fraction, 0), 1) * SENT_SHARE;
}

const SENT_SHARE = 0.9;

/** The line under the photo: sizes, never a % figure. */
export function uploadLine(sent: number, totalBytes: number, retrying: boolean): string {
  const share = Math.min(Math.max(sent, 0), 1);
  if (retrying) return `Uploading again, ${uploadSizeMeta(share * totalBytes, totalBytes)}`;
  if (share >= 1) return 'Almost done, saving your photo';
  return `Uploading, ${uploadSizeMeta(share * totalBytes, totalBytes)}`;
}

/**
 * The photo on its way: its own picture with the upload ring on it (X
 * cancels), or Retry in the same spot once it failed. The tile never changes size.
 */
function PendingPhoto(props: {
  previewUrl: string | null;
  video: boolean;
  progress?: number;
  onCancel?: () => void;
  onRetry?: () => void;
}): ReactElement {
  return (
    <li
      data-pending-photo={props.onRetry !== undefined ? 'failed' : 'uploading'}
      className={
        props.onRetry !== undefined
          ? 'relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-bad bg-panel-3 lit-bad'
          : 'relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-panel-3 lit-pill'
      }
    >
      {props.previewUrl !== null && !props.video ? (
        <img src={props.previewUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-fg-3">
          <IconVideo size={ICON_SIZE.status} />
        </span>
      )}
      {props.onRetry !== undefined ? (
        <UploadRetry variant="image" onRetry={props.onRetry} className="absolute inset-0 m-auto" />
      ) : (
        <UploadRing
          variant="image"
          label="Cancel upload"
          progress={props.progress ?? null}
          onCancel={props.onCancel}
          className="absolute inset-0 m-auto"
        />
      )}
    </li>
  );
}

/** A finished upload: the photo itself, or a video tile. No file name. */
function MediaTile({
  item,
  onRemove,
}: {
  item: AttachmentItem;
  onRemove: () => void;
}): ReactElement {
  const label = item.kind === 'image' ? 'Remove photo' : 'Remove video';
  return (
    <li className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-panel-3 lit-pill">
      {item.previewUrl !== undefined ? (
        <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-fg-3">
          <IconVideo size={ICON_SIZE.status} />
        </span>
      )}
      <IconButton type="button" label={label} onClick={onRemove} className="absolute right-0 top-0">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay-badge text-overlay-fg">
          <IconTrash size={ICON_SIZE.control} />
        </span>
      </IconButton>
    </li>
  );
}
