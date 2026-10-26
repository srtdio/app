// The extracted comment composer: textarea + an
// attachment picker, used by both the root composer and the per-thread reply
// composer (the reply passes a parentCommentId-bearing onSubmit). Attachments
// reuse the existing chat upload path verbatim (uploadFile -> asset-upload
// worker, which returns asset VERSION ids); picked files show as removable chips
// with per-file progress and inline failure, and never throw. The composer owns
// no trace and no write wrapper: it hands the body + completed version ids back
// through onSubmit, and the panel mints one trace per action and writes through
// the SECURITY DEFINER createComment wrapper.

import { linkTypedUsernames } from '@/lib/chat/mentions';
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MentionInput } from '@/components/comments/MentionInput';
import type { MentionInputHandle } from '@/components/comments/MentionInput';
import { CommentEmojiButton } from '@/components/comments/CommentEmojiButton';
import type { MentionCandidate } from '@/lib/workspace-members';
import { IconFile, IconPaperclip, IconX, ICON_SIZE } from '@/components/ui/icons';
import { fileExtension } from '@/lib/assets';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import type { ChatAttachmentUpload } from '@/lib/chat/attachments';

// The proc enforces a body length of 1..10000; mirror it client-side so submit
// disables and a friendly message shows before the request runs.
const MAX_BODY = 10000;

interface CommentSubmitOptions {
  /** Asset VERSION ids of the completed uploads, passed to createComment. */
  attachmentVersionIds: string[];
}

/**
 * ok clears the draft. A failure keeps it (text and chips): `error` is shown
 * inline under the composer; `notified` means the parent already told the
 * person (a toast), so nothing is shown inline.
 */
export type CommentSubmitResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; notified: true };

interface CommentComposerProps {
  /** Write the comment; resolves ok to clear the draft, or an error to keep it. */
  onSubmit: (body: string, options: CommentSubmitOptions) => Promise<CommentSubmitResult>;
  /** Workspace members offered by the @-mention picker (avatar + name + role). */
  members: MentionCandidate[];
  /** Whether the attach affordance is shown (endpoint configured + a workspace). */
  canAttach: boolean;
  /** Upload one picked file via the shared asset pipeline; never throws. */
  uploadFile?: (file: File) => Promise<ChatAttachmentUpload>;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  /** Seed the editor on mount (e.g. a reply pre-tagging the author); forwarded
   *  verbatim to MentionInput. Undefined leaves the composer blank as before. */
  initialBody?: string;
  /** The guide's data-induction key for the submit button, where its hand can sit. */
  submitAnchor?: string;
  /** Every draft change (token form, the same shape initialBody takes), so a
   *  parent can keep the draft across close/reopen. */
  onBodyChange?: (body: string) => void;
}

export type PendingStatus =
  | { state: 'uploading' }
  | { state: 'done'; versionId: string }
  | { state: 'error'; message: string };

/** One picked file and its upload lifecycle, shown as a removable chip. Shared
 *  with SlotComposer, which runs the same upload flow once per slot. */
export interface Pending {
  id: string;
  file: File;
  previewUrl: string | null;
  status: PendingStatus;
  /**
   * False when the failure was the pre-check (too big, a refused type), which a
   * retry cannot change; absent or true, a failed upload offers Retry (FT17).
   */
  retryable?: boolean;
}

/** Whether a chip offers Retry: a failed upload, not a failed pre-check. Pure. */
export function canRetryPending(item: Pick<Pending, 'status' | 'retryable'>): boolean {
  return item.status.state === 'error' && item.retryable !== false;
}

let pendingSeq = 0;

export function doneVersionIds(pending: readonly Pending[]): string[] {
  const ids: string[] = [];
  for (const item of pending) {
    if (item.status.state === 'done') ids.push(item.status.versionId);
  }
  return ids;
}

export function CommentComposer({
  onSubmit,
  members,
  canAttach,
  uploadFile,
  placeholder = 'Add a comment',
  submitLabel = 'Post',
  autoFocus = false,
  initialBody,
  submitAnchor,
  onBodyChange,
}: CommentComposerProps): ReactElement {
  const [body, setBody] = useState('');
  // The MentionInput is contentEditable and uncontrolled; clearing the draft
  // after a successful submit remounts it via this incrementing key.
  const [composerKey, setComposerKey] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MentionInputHandle>(null);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY;
  const uploading = pending.some((item) => item.status.state === 'uploading');
  const hasReadyAttachment = pending.some((item) => item.status.state === 'done');
  const attachEnabled = canAttach && uploadFile !== undefined;
  const canSubmit =
    (trimmed.length > 0 || hasReadyAttachment) && !tooLong && !uploading && !submitting;

  // Upload one chip's file and settle its status; a failure keeps the chip
  // (with its file) so Retry can run it again.
  async function uploadPending(id: string, file: File): Promise<void> {
    if (uploadFile === undefined) return;
    const outcome = await uploadFile(file);
    setPending((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              status: outcome.ok
                ? { state: 'done', versionId: outcome.versionId }
                : { state: 'error', message: outcome.message },
            }
          : item,
      ),
    );
  }

  async function addFiles(list: FileList | null): Promise<void> {
    if (list === null || uploadFile === undefined) return;
    for (const file of Array.from(list)) {
      const id = `c-att-${(pendingSeq += 1)}`;
      const check = precheckFile(file);
      if (!check.ok) {
        setPending((prev) => [
          ...prev,
          {
            id,
            file,
            previewUrl: null,
            status: { state: 'error', message: check.message },
            retryable: false,
          },
        ]);
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((prev) => [...prev, { id, file, previewUrl, status: { state: 'uploading' } }]);
      await uploadPending(id, file);
    }
  }

  // FT17: a failed upload's chip offers Retry, which re-runs the same upload.
  function retryPending(id: string): void {
    const target = pending.find((item) => item.id === id);
    if (target === undefined || !canRetryPending(target)) return;
    setPending((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: { state: 'uploading' } } : item)),
    );
    void uploadPending(id, target.file);
  }

  function removePending(id: string): void {
    setPending((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    // A typed "@username" of a current member becomes a real mention too.
    const linked = linkTypedUsernames(
      body,
      members.map((m) => ({ userId: m.id, username: m.username })),
    );
    const result = await onSubmit(linked, {
      attachmentVersionIds: doneVersionIds(pending),
    });
    if (result.ok) {
      for (const item of pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      setBody('');
      setComposerKey((key) => key + 1);
      setPending([]);
      setSubmitting(false);
      return;
    }
    // Keep the draft (text + chips) so a failed write is not lost.
    setError('error' in result ? result.error : null);
    setSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <MentionInput
        key={composerKey}
        ref={editorRef}
        members={members}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(next) => {
          setBody(next);
          onBodyChange?.(next);
        }}
        initialBody={initialBody}
      />

      {tooLong ? (
        <p role="alert" className="text-sm text-bad">
          Comments must be at most {MAX_BODY.toLocaleString('en-US')} characters.
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip
              key={item.id}
              item={item}
              onRemove={() => removePending(item.id)}
              onRetry={() => retryPending(item.id)}
            />
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-3 flex-wrap">
        {attachEnabled ? (
          <IconButton
            label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
          >
            <IconPaperclip size={ICON_SIZE.control} />
          </IconButton>
        ) : null}

        <CommentEmojiButton
          disabled={submitting}
          onPick={(char) => editorRef.current?.insertText(char)}
        />

        <Button
          variant="primary"
          className="ml-auto min-w-[44px]"
          data-induction={submitAnchor}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? 'Posting…' : submitLabel}
        </Button>
      </div>

      {error !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-base text-bad">
          {error}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export function PendingChip({
  item,
  onRemove,
  onRetry,
}: {
  item: Pending;
  onRemove: () => void;
  /** FT17: re-run a failed upload; the chip shows Retry only when given and retryable. */
  onRetry?: (() => void) | undefined;
}): ReactElement {
  const error = item.status.state === 'error';
  return (
    <li
      className={
        error
          ? 'flex items-center gap-2 rounded-lg border border-bad bg-panel-2 py-1 pl-1 pr-1'
          : 'flex items-center gap-2 rounded-lg border border-border bg-panel-2 py-1 pl-1 pr-1'
      }
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel-3 text-fg-3">
        {item.previewUrl !== null ? (
          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <IconFile size={ICON_SIZE.inline} />
        )}
      </span>
      <span className="flex min-w-0 max-w-[180px] flex-col">
        <span className="truncate text-sm font-medium text-fg" title={item.file.name}>
          {item.file.name}
        </span>
        <span className={error ? 'truncate text-xs text-bad' : 'text-xs text-fg-3'}>
          {item.status.state === 'uploading'
            ? 'Uploading'
            : item.status.state === 'error'
              ? item.status.message
              : fileExtension(item.file.name)}
        </span>
      </span>
      {onRetry !== undefined && canRetryPending(item) ? (
        <Button
          type="button"
          variant="link"
          className="min-w-[44px] shrink-0"
          aria-label={`Retry ${item.file.name}`}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
      <IconButton label={`Remove ${item.file.name}`} onClick={onRemove}>
        <IconX size={ICON_SIZE.control} />
      </IconButton>
    </li>
  );
}
