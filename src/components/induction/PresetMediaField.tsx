// The post sheet's media field on an induction post step. It runs the existing
// upload path (uploadChatAttachment over the asset-upload Worker, XHR for
// progress) and adds what a first upload on a weak connection needs: a progress
// bar from the real upload progress, three automatic retries, then a plain
// reason with Try again. File names are never shown (phones name photos
// IMG_4821.HEIC). The rest of the sheet keeps everything typed whatever
// happens here. Chunked background upload is a later backend PR. On the
// first post (fillOnTap) a tap attaches the bundled sample photo instead of
// opening the picker; nothing is uploaded until Send (uploadLocalFile).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { isImageMime } from '@srtdio/storage';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconVideo, IconX, ICON_SIZE } from '@/components/ui/icons';
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

/** The upload path itself is not set up (no endpoint or session): nothing was sent. */
const NOT_STARTED = "Couldn't start the upload. Try again.";

type Upload =
  | { phase: 'idle' }
  | { phase: 'sending'; percent: number; retrying: boolean }
  /** file null: the sample photo did not load; Try again loads it again. */
  | { phase: 'failed'; file: File | null; reason: string };

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
}): Promise<{ ok: true; value: string } | { ok: false }> {
  const result = await uploadChatAttachment({
    file: input.file,
    workspaceId: input.workspaceId,
    origin: 'library',
    token: input.token,
    endpoint: input.endpoint,
    attachThumbnail: attachLateThumbnail,
    xhr: { traceId: input.traceId, onProgress: input.onProgress },
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
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function send(file: File): Promise<void> {
    const check = precheckFile(file);
    if (!check.ok) {
      setUpload({ phase: 'failed', file, reason: check.message });
      return;
    }
    const endpoint = env.VITE_ASSET_UPLOAD_URL;
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
    if (endpoint === undefined || endpoint === '' || workspaceId === null || token === '') {
      setUpload({ phase: 'failed', file, reason: NOT_STARTED });
      return;
    }
    onBusyChange(true);
    setUpload({ phase: 'sending', percent: 0, retrying: false });
    const outcome = await withRetries(
      () => attemptOnce({ file, workspaceId, endpoint, token }),
      UPLOAD_RETRIES,
      () => {
        if (alive.current) setUpload({ phase: 'sending', percent: 0, retrying: true });
      },
    );
    if (!alive.current) return;
    onBusyChange(false);
    if (!outcome.ok) {
      setUpload({ phase: 'failed', file, reason: uploadFailedReason(outcome.failures) });
      return;
    }
    setUpload({ phase: 'idle' });
    const previewUrl =
      isImageMime(file.type) || file.type.startsWith('video/')
        ? URL.createObjectURL(file)
        : undefined;
    onChange([
      ...valueRef.current,
      {
        versionId: outcome.value,
        kind: isImageMime(file.type) ? 'image' : 'file',
        name: file.name,
        ...(previewUrl !== undefined ? { previewUrl } : {}),
        ...(file.type !== '' ? { mime: file.type } : {}),
      },
    ]);
  }

  /** One attempt; its real progress drives the bar. */
  function attemptOnce(input: {
    file: File;
    workspaceId: string;
    endpoint: string;
    token: string;
  }): Promise<{ ok: true; value: string } | { ok: false }> {
    return attemptUpload({
      ...input,
      traceId: newTrace(),
      onProgress: (fraction) => {
        if (!alive.current) return;
        setUpload((prev) =>
          prev.phase === 'sending' ? { ...prev, percent: sendingPercent(fraction) } : prev,
        );
      },
    });
  }

  /** The sample photo, shown from its local copy; the sheet uploads it at Send. */
  async function attachSample(onFilled: () => void): Promise<void> {
    const file = await loadSamplePhoto(newTrace());
    if (!alive.current) return;
    if (file === null) {
      setUpload({ phase: 'failed', file: null, reason: NOT_STARTED });
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

  function retry(failed: File | null): void {
    if (failed !== null) void send(failed);
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
      {upload.phase === 'sending' ? <UploadBar percent={upload.percent} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={sending}
          data-induction={INDUCTION_KEYS.postSheetMedia}
          onClick={pick}
        >
          {value.length > 0 ? 'Add another' : 'Add a photo or video'}
        </Button>
        {upload.phase === 'failed' ? (
          <Button type="button" variant="ghost" onClick={() => retry(upload.file)}>
            Try again
          </Button>
        ) : null}
      </div>
      <p
        aria-live="polite"
        className={upload.phase === 'failed' ? 'text-base text-bad' : 'text-base text-fg'}
      >
        {upload.phase === 'sending'
          ? uploadLine(upload.percent, upload.retrying)
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

/**
 * The bar's share for the bytes sent so far. Sending ends at 90%: the server
 * still checks and stores the photo after the last byte, and only its answer
 * fills the bar, so 100% always means the photo is in the post.
 */
export function sendingPercent(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * SENT_SHARE);
}

const SENT_SHARE = 90;

/** The line under the bar. */
export function uploadLine(percent: number, retrying: boolean): string {
  if (retrying) return `Uploading again, ${percent}%`;
  if (percent >= SENT_SHARE) return 'Almost done, saving your photo';
  return `Uploading, ${percent}%`;
}

/** The upload's real progress as a bar. */
function UploadBar({ percent }: { percent: number }): ReactElement {
  return (
    <div
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-2 w-full overflow-hidden rounded-full bg-panel-3"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-slow ease-enter motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
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
    <li className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-panel-3">
      {item.previewUrl !== undefined ? (
        <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-fg-3">
          <IconVideo size={ICON_SIZE.status} />
        </span>
      )}
      <IconButton type="button" label={label} onClick={onRemove} className="absolute right-0 top-0">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay-badge text-overlay-fg">
          <IconX size={ICON_SIZE.control} />
        </span>
      </IconButton>
    </li>
  );
}
