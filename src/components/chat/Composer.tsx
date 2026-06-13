import { useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import { IconFile, IconX } from '@/components/ui/icons';
import { IconPaperclip } from '@/components/chat/AttachmentIcons';
import { AttachmentMenu } from '@/components/chat/AttachmentMenu';
import { attachmentMenuItems } from '@/lib/chat/attachment-menu';
import { fileExtension } from '@/lib/assets';
import { precheckFile, type UploadOutcome } from '@/lib/asset-upload';
import {
  canSendAttachmentMessage,
  toMessageAttachment,
  type MessageAttachment,
} from '@/lib/chat/attachments';

interface ComposerProps {
  /** Sends the trimmed text plus any completed attachments; resolves on settle. */
  onSend: (text: string, attachments: MessageAttachment[]) => Promise<void>;
  disabled: boolean;
  /** Upload one picked file via the asset pipeline; absent disables attaching. */
  uploadFile?: ((file: File) => Promise<UploadOutcome>) | undefined;
}

type PendingStatus =
  | { state: 'uploading' }
  | { state: 'done'; assetId: string }
  | { state: 'error'; message: string };

/** One picked file and its upload lifecycle, shown as a removable chip. */
interface Pending {
  id: string;
  file: File;
  previewUrl: string | null;
  status: PendingStatus;
}

let pendingSeq = 0;

function completedAttachments(pending: readonly Pending[]): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  for (const item of pending) {
    if (item.status.state === 'done') out.push(toMessageAttachment(item.file, item.status.assetId));
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      uploading,
      sending: submitting,
    });

  const menuItems = useMemo(
    () =>
      attachmentMenuItems({
        onPickPhoto: () => photoInputRef.current?.click(),
        onPickFile: () => fileInputRef.current?.click(),
      }),
    [],
  );

  async function addFiles(list: FileList | null): Promise<void> {
    const upload = props.uploadFile;
    if (list === null || list.length === 0 || upload === undefined) return;
    for (const file of Array.from(list)) {
      const id = `att-${(pendingSeq += 1)}`;
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
      const outcome = await upload(file);
      setPending((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: outcome.ok
                  ? { state: 'done', assetId: outcome.assetId }
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    const pendingText = text;
    const attachments = ready;
    setSubmitting(true);
    try {
      await props.onSend(pendingText, attachments);
      for (const item of pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      setText('');
      setPending([]);
    } catch {
      // Keep the draft (text + chips) so a failed send is not silently lost.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border bg-panel px-4 py-3">
      {pending.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip key={item.id} item={item} onRemove={() => removePending(item.id)} />
          ))}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
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
            <AttachmentMenu open={menuOpen} items={menuItems} onClose={() => setMenuOpen(false)} />
          </div>
        ) : null}

        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Write a message"
          rows={1}
          className="min-h-[44px]"
        />
        <Button type="submit" variant="primary" size="lg" disabled={!canSend}>
          Send
        </Button>
      </div>

      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={menuItems.find((item) => item.id === 'photo')?.accept}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files);
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
          void addFiles(event.target.files);
          event.target.value = '';
        }}
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
