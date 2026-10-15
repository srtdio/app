// The post sheet's media field on an induction post step. It runs the existing
// upload path (uploadChatAttachment over the asset-upload Worker, XHR for
// progress) and adds what a first upload on a weak connection needs: a 2 s
// speed probe and an honest estimate from it, three automatic retries, then a
// plain reason with Try again. The rest of the sheet keeps everything typed
// whatever happens here. Chunked background upload is a later backend PR.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import { Button } from '@/components/ui/Button';
import {
  attachmentItemList,
  removeAttachmentAt,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import { precheckFile } from '@/lib/asset-upload';
import { uploadChatAttachment } from '@/lib/chat/attachments';
import { env } from '@/lib/env';
import {
  UPLOAD_PROBE_MS,
  UPLOAD_RETRIES,
  uploadEstimate,
  uploadFailedReason,
  withRetries,
} from '@/lib/induction';
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
  | { phase: 'sending'; name: string; line: string }
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
    setUpload({ phase: 'sending', name: file.name, line: 'Starting the upload' });
    const outcome = await withRetries(
      () => attemptOnce({ file, workspaceId, endpoint, token }),
      UPLOAD_RETRIES,
      () => {
        if (alive.current) {
          setUpload({
            phase: 'sending',
            name: file.name,
            line: 'The connection dropped. Trying again',
          });
        }
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

  /** One attempt, with the speed probe: after 2 s the estimate replaces the line. */
  async function attemptOnce(input: {
    file: File;
    workspaceId: string;
    endpoint: string;
    token: string;
  }): Promise<{ ok: true; value: string } | { ok: false }> {
    const started = performance.now();
    let fraction = 0;
    const probe = window.setTimeout(() => {
      if (!alive.current) return;
      const line = uploadEstimate({
        sentBytes: fraction * input.file.size,
        elapsedMs: performance.now() - started,
        totalBytes: input.file.size,
      });
      setUpload({ phase: 'sending', name: input.file.name, line });
    }, UPLOAD_PROBE_MS);
    try {
      const result = await uploadChatAttachment({
        file: input.file,
        workspaceId: input.workspaceId,
        origin: 'library',
        token: input.token,
        endpoint: input.endpoint,
        xhr: {
          traceId: newTrace(),
          onProgress: (next) => {
            fraction = next;
          },
        },
      });
      return result.ok ? { ok: true, value: result.versionId } : { ok: false };
    } finally {
      window.clearTimeout(probe);
    }
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
        <ul className="flex flex-wrap gap-2">{attachmentItemList(value, remove)}</ul>
      ) : null}
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
          ? `${upload.name}: ${upload.line}.`
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
