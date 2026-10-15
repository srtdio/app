// The post sheet's media field on an induction post step. It runs the existing
// upload path (uploadChatAttachment over the asset-upload Worker, XHR for
// progress) and adds what a first upload on a weak connection needs: a progress
// bar from the real upload progress, three automatic retries, then a plain
// reason with Try again. File names are never shown (phones name photos
// IMG_4821.HEIC). The rest of the sheet keeps everything typed whatever
// happens here. Chunked background upload is a later backend PR.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import { Button } from '@/components/ui/Button';
import { IconVideo, IconX } from '@/components/ui/icons';
import {
  removeAttachmentAt,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import { precheckFile } from '@/lib/asset-upload';
import { uploadChatAttachment } from '@/lib/chat/attachments';
import { env } from '@/lib/env';
import { UPLOAD_RETRIES, uploadFailedReason, withRetries } from '@/lib/induction';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';

/** Photos and videos from the upload allowlist: what a post's creative is. */
const MEDIA_ACCEPT = ALLOWED_MIME_TYPES.filter(
  (mime) => isImageMime(mime) || mime.startsWith('video/'),
).join(',');

/** The upload path itself is not set up (no endpoint or session): nothing was sent. */
const NOT_STARTED = "We couldn't start the upload. Try again in a moment.";

type Upload =
  | { phase: 'idle' }
  | { phase: 'sending'; percent: number; retrying: boolean }
  | { phase: 'failed'; file: File; reason: string };

export function PresetMediaField({
  workspaceId,
  value,
  onChange,
  required,
  onBusyChange,
}: {
  workspaceId: string | null;
  value: AttachmentItem[];
  onChange: (items: AttachmentItem[]) => void;
  required: boolean;
  onBusyChange: (busy: boolean) => void;
}): ReactElement {
  const newTrace = useNewTrace();
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload>({ phase: 'idle' });
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
    const previewUrl = isImageMime(file.type) ? URL.createObjectURL(file) : undefined;
    onChange([
      ...valueRef.current,
      {
        versionId: outcome.value,
        kind: isImageMime(file.type) ? 'image' : 'file',
        name: file.name,
        ...(previewUrl !== undefined ? { previewUrl } : {}),
      },
    ]);
  }

  /** One attempt; its real progress drives the bar. */
  async function attemptOnce(input: {
    file: File;
    workspaceId: string;
    endpoint: string;
    token: string;
  }): Promise<{ ok: true; value: string } | { ok: false }> {
    const result = await uploadChatAttachment({
      file: input.file,
      workspaceId: input.workspaceId,
      origin: 'library',
      token: input.token,
      endpoint: input.endpoint,
      xhr: {
        traceId: newTrace(),
        onProgress: (fraction) => {
          if (!alive.current) return;
          setUpload((prev) =>
            prev.phase === 'sending' ? { ...prev, percent: sendingPercent(fraction) } : prev,
          );
        },
      },
    });
    return result.ok ? { ok: true, value: result.versionId } : { ok: false };
  }

  function remove(index: number): void {
    const target = value[index];
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    onChange(removeAttachmentAt(value, index));
  }

  const sending = upload.phase === 'sending';
  return (
    <div className="flex flex-col gap-3">
      {value.length > 0 ? (
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
          size="lg"
          disabled={sending}
          onClick={() => inputRef.current?.click()}
        >
          {value.length > 0 ? 'Add another' : 'Add a photo or video'}
        </Button>
        {upload.phase === 'failed' ? (
          <Button type="button" size="lg" variant="ghost" onClick={() => void send(upload.file)}>
            Try again
          </Button>
        ) : null}
      </div>
      <p
        aria-live="polite"
        className={upload.phase === 'failed' ? 'text-[12px] text-bad' : 'text-[12px] text-fg-3'}
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
  if (retrying) return `The connection dropped. Trying again, ${percent}%`;
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
        className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out motion-reduce:transition-none"
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
          <IconVideo size={22} />
        </span>
      )}
      <button
        type="button"
        aria-label={label}
        onClick={onRemove}
        className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-panel text-fg shadow">
          <IconX size={14} />
        </span>
      </button>
    </li>
  );
}
