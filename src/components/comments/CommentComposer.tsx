// The extracted comment composer: textarea + optional decision toggle + an
// attachment picker, used by both the root composer and the per-thread reply
// composer (the reply passes a parentCommentId-bearing onSubmit). Attachments
// reuse the existing chat upload path verbatim (uploadFile -> asset-upload
// worker, which returns asset VERSION ids); picked files show as removable chips
// with per-file progress and inline failure, and never throw. The composer owns
// no trace and no write wrapper: it hands the body + completed version ids back
// through onSubmit, and the panel mints one trace per action and writes through
// the SECURITY DEFINER createComment wrapper.

import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MentionInput } from '@/components/comments/MentionInput';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
import { IconFile, IconX } from '@/components/ui/icons';
import { IconPaperclip } from '@/components/chat/AttachmentIcons';
import { fileExtension } from '@/lib/assets';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import type { ChatAttachmentUpload } from '@/lib/chat/attachments';

// The proc enforces a body length of 1..10000; mirror it client-side so submit
// disables and a friendly message shows before the request runs.
const MAX_BODY = 10000;

export interface CommentSubmitOptions {
  /** Asset VERSION ids of the completed uploads, passed to createComment. */
  attachmentVersionIds: string[];
  isDecision: boolean;
}

export type CommentSubmitResult = { ok: true } | { ok: false; error: string };

interface CommentComposerProps {
  /** Write the comment; resolves ok to clear the draft, or an error to keep it. */
  onSubmit: (body: string, options: CommentSubmitOptions) => Promise<CommentSubmitResult>;
  /** Workspace members offered by the @-mention picker (avatar + name + role). */
  members: MentionCandidate[];
  /** The decision toggle is a post-only affordance; briefs never carry it. */
  showDecisionToggle: boolean;
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
}

type PendingStatus =
  | { state: 'uploading' }
  | { state: 'done'; versionId: string }
  | { state: 'error'; message: string };

/** One picked file and its upload lifecycle, shown as a removable chip. */
interface Pending {
  id: string;
  file: File;
  previewUrl: string | null;
  status: PendingStatus;
}

let pendingSeq = 0;

function doneVersionIds(pending: readonly Pending[]): string[] {
  const ids: string[] = [];
  for (const item of pending) {
    if (item.status.state === 'done') ids.push(item.status.versionId);
  }
  return ids;
}

export function CommentComposer({
  onSubmit,
  members,
  showDecisionToggle,
  canAttach,
  uploadFile,
  placeholder = 'Add a comment',
  submitLabel = 'Post',
  autoFocus = false,
  initialBody,
}: CommentComposerProps): ReactElement {
  const [body, setBody] = useState('');
  // The MentionInput is contentEditable and uncontrolled; clearing the draft
  // after a successful submit remounts it via this incrementing key.
  const [composerKey, setComposerKey] = useState(0);
  const [isDecision, setIsDecision] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY;
  const uploading = pending.some((item) => item.status.state === 'uploading');
  const hasReadyAttachment = pending.some((item) => item.status.state === 'done');
  const attachEnabled = canAttach && uploadFile !== undefined;
  const canSubmit =
    (trimmed.length > 0 || hasReadyAttachment) && !tooLong && !uploading && !submitting;

  async function addFiles(list: FileList | null): Promise<void> {
    if (list === null || uploadFile === undefined) return;
    for (const file of Array.from(list)) {
      const id = `c-att-${(pendingSeq += 1)}`;
      const check = precheckFile(file);
      if (!check.ok) {
        setPending((prev) => [
          ...prev,
          { id, file, previewUrl: null, status: { state: 'error', message: check.message } },
        ]);
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((prev) => [...prev, { id, file, previewUrl, status: { state: 'uploading' } }]);
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
    const result = await onSubmit(body, {
      attachmentVersionIds: doneVersionIds(pending),
      isDecision: showDecisionToggle ? isDecision : false,
    });
    if (result.ok) {
      for (const item of pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      setBody('');
      setComposerKey((key) => key + 1);
      setIsDecision(false);
      setPending([]);
      setSubmitting(false);
      return;
    }
    // Keep the draft (text + chips) so a failed write is not lost.
    setError(result.error);
    setSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <MentionInput
        key={composerKey}
        members={members}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={setBody}
        initialBody={initialBody}
      />

      {tooLong ? (
        <p role="alert" className="text-xs text-bad">
          Comments must be at most {MAX_BODY.toLocaleString()} characters.
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip key={item.id} item={item} onRemove={() => removePending(item.id)} />
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
            <IconPaperclip size={20} />
          </IconButton>
        ) : null}

        {showDecisionToggle ? (
          <label className="inline-flex items-center gap-2 min-h-[44px] cursor-pointer select-none text-sm text-fg-2">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-border accent-accent"
              checked={isDecision}
              onChange={(event) => setIsDecision(event.target.checked)}
              disabled={submitting}
            />
            Mark as decision
          </label>
        ) : null}

        <Button
          size="lg"
          variant="primary"
          className="ml-auto min-w-[44px]"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? 'Posting' : submitLabel}
        </Button>
      </div>

      {error !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
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

function PendingChip({ item, onRemove }: { item: Pending; onRemove: () => void }): ReactElement {
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
          <IconFile size={16} />
        )}
      </span>
      <span className="flex min-w-0 max-w-[180px] flex-col">
        <span className="truncate text-xs font-medium text-fg" title={item.file.name}>
          {item.file.name}
        </span>
        <span className={error ? 'truncate text-[11px] text-bad' : 'text-[11px] text-fg-3'}>
          {item.status.state === 'uploading'
            ? 'Uploading'
            : item.status.state === 'error'
              ? item.status.message
              : fileExtension(item.file.name)}
        </span>
      </span>
      <IconButton label={`Remove ${item.file.name}`} onClick={onRemove}>
        <IconX size={16} />
      </IconButton>
    </li>
  );
}
