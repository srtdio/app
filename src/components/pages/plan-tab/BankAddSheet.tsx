// Add idea (the Bank toolbar's primary): Title (required, up to 200, first),
// Description, files through the existing upload path (ui/DropZone over the
// comments' library uploader, createConceptUploads) and the bucket chips
// (many may be picked; add a bucket inline). "Add to bank" runs
// bank_idea_create; the new idea lands at the top of the kept Bank page (an
// own write updates the kept values). Waits for uploads in flight; a failed
// upload refuses until it is retried or removed.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { DropZone } from '@/components/ui/DropZone';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';
import { ICON_SIZE, IconPaperclip, IconX } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import type { BucketOption } from '@/lib/buckets';
import type { AttachmentUploader } from '@/lib/chat/attachments';
import {
  CONCEPT_UPLOAD_FAILED,
  conceptSaveGate,
  createConceptUploads,
  type BankIdea,
  type ConceptUpload,
  type ConceptUploads,
} from '@/lib/chat/plans';
import { errorText } from '@/lib/error-copy';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { supabase } from '@/lib/supabase';
import { BucketChips, type BucketWrites } from './BankFilterSheet';
import { addBankIdea } from './use-bank-data';

/** An idea's title limit. */
export const BANK_TITLE_MAX = 200;

/** Whether Add to bank may go: a title of 1 to 200 characters. Pure. */
export function bankAddValid(title: string): boolean {
  const t = title.trim();
  return t.length > 0 && t.length <= BANK_TITLE_MAX;
}

interface BankAddSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  buckets: readonly BucketOption[];
  writes: BucketWrites;
  onBuckets: (next: BucketOption[]) => void;
  onAdded: (idea: BankIdea) => void;
}

/**
 * Mounts the sheet (and its upload path) on its first open only, then keeps
 * it so it closes with its own move: the Plan tab's paint never sets up the
 * uploader.
 */
export function BankAddSheet(props: BankAddSheetProps): ReactElement | null {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  return opened ? <BankAddSheetBody {...props} /> : null;
}

function BankAddSheetBody(props: BankAddSheetProps): ReactElement {
  const { uploadFile } = useCommentAttachments();
  const toast = useToast().show;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<Array<{ versionId: string; name: string }>>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [uploads, setUploads] = useState<readonly ConceptUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<AttachmentUploader>(uploadFile);
  uploadRef.current = uploadFile;
  const controllerRef = useRef<ConceptUploads | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createConceptUploads({
      upload: (file, onProgress, signal) => uploadRef.current(file, onProgress, signal),
      precheck: precheckFile,
      onChange: setUploads,
      onUploaded: (versionId, name) =>
        setFiles((prev) =>
          prev.some((f) => f.versionId === versionId) ? prev : [...prev, { versionId, name }],
        ),
    });
  }
  const controller = controllerRef.current;
  // A closed sheet drops its form and aborts its uploads; so does unmount.
  useEffect(() => {
    if (props.open) return;
    controller.abortAll();
    setTitle('');
    setDescription('');
    setFiles([]);
    setPicked(new Set());
    setError(null);
  }, [props.open, controller]);
  useEffect(() => () => controller.abortAll(), [controller]);

  const dirty = title.trim() !== '' || description.trim() !== '' || files.length > 0;
  const submit = async (): Promise<void> => {
    if (!bankAddValid(title)) {
      setError("Couldn't add. Give the idea a title.");
      return;
    }
    const gate = conceptSaveGate(uploads);
    if (gate !== 'go') {
      toast({
        title: gate === 'wait' ? 'Files are still uploading.' : CONCEPT_UPLOAD_FAILED,
        tone: 'error',
      });
      return;
    }
    setBusy(true);
    const res = await addBankIdea(supabase, {
      workspaceId: props.workspaceId,
      title,
      description,
      versionIds: files.map((f) => f.versionId),
      bucketIds: [...picked],
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorText('add the idea', res.error.message));
      return;
    }
    props.onAdded(res.data);
    props.onClose();
  };

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Add idea"
      dirty={dirty && !busy}
      discard={{ title: 'Discard this idea?', message: 'Your idea will be lost.' }}
      busy={busy}
      busyLabel="Adding…"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" type="button" className="mr-auto" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="button" data-bank-add-go="" onClick={() => void submit()}>
            Add to bank
          </Button>
        </div>
      }
    >
      <div data-bank-add="" className="flex flex-col gap-3 bg-bg p-4">
        <div className="lit-card flex flex-col gap-3 rounded-xl border bg-panel p-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
              Title
            </span>
            <Input
              autoFocus
              data-bank-add-title=""
              value={title}
              maxLength={BANK_TITLE_MAX}
              required
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
              Description
            </span>
            <Textarea
              data-bank-add-description=""
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
        <div className="lit-card flex flex-col gap-2 rounded-xl border bg-panel p-3.5">
          <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">Files</span>
          <DropZone
            data-bank-add-files=""
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              controller.add([...e.dataTransfer.files]);
            }}
          >
            <IconPaperclip size={ICON_SIZE.control} />
            <span className="text-base">Add files</span>
          </DropZone>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={UPLOAD_ACCEPT}
            onChange={(e) => {
              controller.add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {files.length > 0 || uploads.length > 0 ? (
            <ul className="flex flex-col">
              {files.map((f) => (
                <li key={f.versionId} className="flex items-center gap-2 text-base text-fg">
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <IconButton
                    label={`Remove ${f.name}`}
                    onClick={() =>
                      setFiles((prev) => prev.filter((x) => x.versionId !== f.versionId))
                    }
                  >
                    <IconX size={ICON_SIZE.control} />
                  </IconButton>
                </li>
              ))}
              {uploads.map((u) => (
                <li key={u.id} className="flex items-center gap-2 text-base text-fg-2">
                  <span className="min-w-0 flex-1 truncate">
                    {u.status.state === 'error' ? u.status.message : u.file.name}
                  </span>
                  {u.status.state === 'error' ? (
                    <Button type="button" onClick={() => controller.retry(u.id)}>
                      Retry
                    </Button>
                  ) : null}
                  <IconButton
                    label={`Remove ${u.file.name}`}
                    onClick={() => controller.remove(u.id)}
                  >
                    <IconX size={ICON_SIZE.control} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="lit-card flex flex-col gap-2 rounded-xl border bg-panel p-3.5">
          <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
            Buckets
          </span>
          <BucketChips
            buckets={props.buckets}
            picked={null}
            multi={picked}
            onPick={(id) => {
              if (id === null) return;
              setPicked((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            writes={props.writes}
            onBuckets={props.onBuckets}
          />
        </div>
      </div>
    </Sheet>
  );
}
