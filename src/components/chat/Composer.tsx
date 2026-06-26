import { useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import { IconFile, IconMic, IconSend, IconTrash, IconX } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { IconPaperclip } from '@/components/chat/AttachmentIcons';
import { useAudioRecorder, recordingFileName } from '@/lib/chat/use-audio-recorder';
import type { TranscribeResult } from '@/lib/chat/transcribe';
import { AttachmentMenu } from '@/components/chat/AttachmentMenu';
import { PostPicker } from '@/components/chat/PostPicker';
import { SharedPostChip } from '@/components/chat/SharedPostChip';
import { togglePost } from '@/components/chat/post-picker';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';
import { fileExtension } from '@/lib/assets';
import { precheckFile } from '@/lib/asset-upload';
import {
  canSendAttachmentMessage,
  precheckImage,
  toMessageAttachment,
  type ChatAttachmentUpload,
  type MessageAttachment,
  type ReplyQuote,
} from '@/lib/chat/attachments';
import type { PostCardFields } from '@srtdio/posts';

interface ComposerProps {
  /** Sends the trimmed text plus any completed attachments and shared posts. */
  onSend: (
    text: string,
    attachments: MessageAttachment[],
    sharedPostIds: string[],
    reply: ReplyQuote | null,
  ) => Promise<void>;
  disabled: boolean;
  /** Upload one picked file via the asset pipeline; absent disables attaching. */
  uploadFile?: ((file: File) => Promise<ChatAttachmentUpload>) | undefined;
  /** Transcribe a recorded voice note; absent sends the audio with no transcript. */
  transcribe?: ((blob: Blob) => Promise<TranscribeResult>) | undefined;
  /** Called on each keystroke so the parent can broadcast a throttled typing signal. */
  onTyping?: (() => void) | undefined;
  /** The active reply draft; renders the preview bar above the chips when present. */
  reply?: { authorName: string; quote: ReplyQuote } | undefined;
  /** Clears the active reply draft (cancel button, and after a successful send). */
  onCancelReply?: (() => void) | undefined;
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

/**
 * True when `window.matchMedia('(pointer: coarse)')` matches, i.e. the primary
 * pointer is coarse (touch). Guarded so it returns false when `window` or
 * `window.matchMedia` is unavailable (SSR / non-DOM test environments).
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Whether a composer keydown should send rather than insert a newline: plain
 * Enter only. Shift+Enter (newline) and Enter mid-IME-composition are excluded,
 * and a coarse (touch-primary) pointer never sends on Enter so phones and
 * touch-only tablets keep the newline and tap Send instead.
 */
export function isSendKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && !input.coarsePointer;
}

/**
 * Whether the composer's trailing control is the record-voice-note mic rather
 * than Send: only when attaching is possible and the composer is otherwise idle
 * and empty (no text, no pending attachments, no shared posts, not already
 * recording or processing a voice note).
 */
export function shouldShowMic(input: {
  hasUpload: boolean;
  disabled: boolean;
  text: string;
  attachmentCount: number;
  sharedPostCount: number;
  recording: boolean;
  voiceBusy: boolean;
}): boolean {
  return (
    input.hasUpload &&
    !input.disabled &&
    input.text.trim() === '' &&
    input.attachmentCount === 0 &&
    input.sharedPostCount === 0 &&
    !input.recording &&
    !input.voiceBusy
  );
}

/** Format a non-negative second count as mm:ss; 0 for non-finite input. */
function formatMmSs(s: number): string {
  const safe = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function completedAttachments(pending: readonly Pending[]): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  for (const item of pending) {
    if (item.status.state === 'done')
      out.push(toMessageAttachment(item.file, item.status.versionId));
  }
  return out;
}

/**
 * Composer with text + an extensible attach menu (Photo / File this PR). Files
 * are pre-checked client-side, uploaded through the asset pipeline, and shown as
 * removable chips with progress; an upload failure surfaces inline on its chip
 * and never throws. Send carries the completed attachments plus any text;
 * attachments-only is allowed, empty is blocked, and send is disabled while any
 * upload is in flight.
 */
export function Composer(props: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [sharedPosts, setSharedPosts] = useState<PostCardFields[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const recorder = useAudioRecorder();
  const toast = useToast();

  const formRef = useRef<HTMLFormElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAttach = props.uploadFile !== undefined && !props.disabled;
  const uploading = pending.some((item) => item.status.state === 'uploading');
  const ready = useMemo(() => completedAttachments(pending), [pending]);
  const canSend =
    !props.disabled &&
    canSendAttachmentMessage({
      text,
      attachmentCount: ready.length,
      sharedPostCount: sharedPosts.length,
      uploading,
      sending: submitting,
    });

  const menuItems = useMemo(
    () =>
      attachmentMenuItems({
        onPickPhoto: () => photoInputRef.current?.click(),
        onPickFile: () => fileInputRef.current?.click(),
        onSharePost: () => setPickerOpen(true),
      }),
    [],
  );

  async function addFiles(list: FileList | null, imageOnly: boolean): Promise<void> {
    const upload = props.uploadFile;
    if (list === null || list.length === 0 || upload === undefined) return;
    for (const file of Array.from(list)) {
      const id = `att-${(pendingSeq += 1)}`;
      // The Photo path is image-only; the File path takes the full allowlist.
      const check = imageOnly ? precheckImage(file) : precheckFile(file);
      if (!check.ok) {
        setPending((prev) => [
          ...prev,
          { id, file, previewUrl: null, status: { state: 'error', message: check.message } },
        ]);
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((prev) => [...prev, { id, file, previewUrl, status: { state: 'uploading' } }]);
      const outcome = await upload(file);
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

  function toggleSharedPost(post: PostCardFields): void {
    setSharedPosts((prev) => togglePost(prev, post));
  }

  // Enter sends on desktop; Shift+Enter, IME composition, and touch-primary
  // devices keep the default newline. Route through the form's submit so the
  // Send button's exact handler and guard run.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      !isSendKeydown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        coarsePointer: isCoarsePointer(),
      })
    )
      return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    const pendingText = text;
    const attachments = ready;
    const postIds = sharedPosts.map((post) => post.id);
    setSubmitting(true);
    try {
      await props.onSend(pendingText, attachments, postIds, props.reply?.quote ?? null);
      for (const item of pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      setText('');
      setPending([]);
      setSharedPosts([]);
      props.onCancelReply?.();
    } catch {
      // Keep the draft (text + chips + shared posts) so a failed send is not lost.
    } finally {
      setSubmitting(false);
    }
  }

  async function start(): Promise<void> {
    const ok = await recorder.start();
    if (!ok) toast.show({ title: 'Microphone access is needed to record.' });
  }

  function cancel(): void {
    recorder.cancel();
  }

  async function stopSend(): Promise<void> {
    setVoiceBusy(true);
    const rec = await recorder.stop();
    if (rec === null) {
      setVoiceBusy(false);
      return;
    }
    const file = new File([rec.blob], recordingFileName(rec.mime), { type: rec.mime });
    let transcript: string | undefined;
    if (props.transcribe !== undefined) {
      const t = await props.transcribe(rec.blob);
      if (t.ok && t.transcript.trim() !== '') transcript = t.transcript;
    }
    const up =
      props.uploadFile !== undefined
        ? await props.uploadFile(file)
        : ({ ok: false, message: 'Upload is unavailable.' } as const);
    if (!up.ok) {
      toast.show({ title: up.message });
      setVoiceBusy(false);
      return;
    }
    const attachment: MessageAttachment = {
      assetId: up.versionId,
      name: file.name,
      mime: file.type,
      ...(transcript !== undefined ? { transcript } : {}),
    };
    try {
      await props.onSend('', [attachment], [], props.reply?.quote ?? null);
      props.onCancelReply?.();
    } catch {
      toast.show({ title: 'Could not send the voice note.' });
    } finally {
      setVoiceBusy(false);
    }
  }

  const showMic = shouldShowMic({
    hasUpload: props.uploadFile !== undefined,
    disabled: props.disabled,
    text,
    attachmentCount: ready.length,
    sharedPostCount: sharedPosts.length,
    recording: recorder.recording,
    voiceBusy,
  });

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-border bg-panel px-4 py-3"
    >
      {props.reply != null ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch rounded-full bg-accent" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-medium text-accent">{props.reply.authorName}</span>
            <span className="truncate text-xs text-fg-3">{props.reply.quote.preview}</span>
          </span>
          <IconButton label="Cancel reply" onClick={() => props.onCancelReply?.()}>
            <IconX size={16} />
          </IconButton>
        </div>
      ) : null}

      {pending.length > 0 || sharedPosts.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip key={item.id} item={item} onRemove={() => removePending(item.id)} />
          ))}
          {sharedPosts.map((post) => (
            <SharedPostChip key={post.id} post={post} onRemove={() => toggleSharedPost(post)} />
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
        {recorder.recording ? (
          <>
            <IconButton label="Cancel recording" className="text-bad" onClick={cancel}>
              <IconTrash size={20} />
            </IconButton>
            <div className="flex h-11 flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-3">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-bad"
              />
              <span className="text-sm text-fg-2">Recording</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-fg-2">
                {formatMmSs(recorder.seconds)}
              </span>
            </div>
            <button
              type="button"
              aria-label="Stop and send voice note"
              onClick={() => void stopSend()}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-90"
            >
              <IconSend size={18} />
            </button>
          </>
        ) : voiceBusy ? (
          <div className="flex h-11 flex-1 items-center gap-2 px-1">
            <span
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
            />
            <span className="text-sm text-fg-2">Sending voice note…</span>
          </div>
        ) : (
          <>
            {canAttach ? (
              <div className="relative">
                <IconButton
                  label="Add attachment"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <IconPaperclip size={20} />
                </IconButton>
                <AttachmentMenu
                  open={menuOpen}
                  items={menuItems}
                  onClose={() => setMenuOpen(false)}
                />
              </div>
            ) : null}

            <Textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                props.onTyping?.();
              }}
              onKeyDown={handleKeyDown}
              placeholder="Write a message"
              rows={1}
              className="min-h-[44px]"
            />
            {showMic ? (
              <button
                type="button"
                aria-label="Record voice note"
                onClick={() => void start()}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-90"
              >
                <IconMic size={18} />
              </button>
            ) : (
              <Button type="submit" variant="primary" size="lg" disabled={!canSend}>
                Send
              </Button>
            )}
          </>
        )}
      </div>

      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={menuItems.find((item) => item.id === 'photo')?.accept}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files, true);
          event.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={menuItems.find((item) => item.id === 'file')?.accept}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files, false);
          event.target.value = '';
        }}
      />

      <PostPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={sharedPosts}
        onToggle={toggleSharedPost}
      />
    </form>
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
