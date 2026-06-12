import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { IconCheck, IconFile, IconPlus, IconUpload, IconX } from '@/components/ui/icons';
import { fileExtension, humanizeSize } from '@/lib/assets';
import {
  UPLOAD_ACCEPT,
  allNamed,
  precheckFile,
  runUploads,
  uploadFilename,
  type QueueItem,
  type UploadOutcome,
} from '@/lib/asset-upload';

/** One queued file with its editable display name and an optional image preview. */
export interface PendingUpload {
  id: string;
  file: File;
  /** The name the user typed; sent as the upload filename on commit. */
  name: string;
  /** Object URL for image previews, or null for non-image files. */
  previewUrl: string | null;
}

/** Per-file lifecycle within an upload run. */
type FileStatus =
  | { state: 'queued' }
  | { state: 'uploading' }
  | { state: 'done' }
  | { state: 'error'; message: string };

interface AssetUploadSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Per-file commit: POST one file to the asset-upload worker, reporting its
   * outcome. When omitted, the sheet stays a naming surface only (no upload
   * endpoint configured) and the confirm action explains that uploading is not
   * wired yet.
   */
  onSubmit?: ((file: File, filename: string) => Promise<UploadOutcome>) | undefined;
  /** Toast sink (the page toast queue). */
  onToast?: ((message: string) => void) | undefined;
  /** Called once after a run in which every file succeeded, to refresh the grid. */
  onUploaded?: (() => void) | undefined;
}

/** Strip the extension from a filename to seed the editable display name. */
function baseName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

let pendingSeq = 0;

export function AssetUploadSheet({
  open,
  onClose,
  onSubmit,
  onToast,
  onUploaded,
}: AssetUploadSheetProps) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({});
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // Revoke any object URLs we created when the queue changes or the sheet closes,
  // so previews never leak.
  const revokeAll = useCallback((items: PendingUpload[]): void => {
    for (const item of items) {
      if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setUploads((prev) => {
        revokeAll(prev);
        return [];
      });
      setStatuses({});
      setRunning(false);
    }
  }, [open, revokeAll]);

  useEffect(() => () => revokeAll(uploads), [uploads, revokeAll]);

  const setStatus = useCallback((id: string, status: FileStatus): void => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
  }, []);

  // Client-side pre-checks run here, before any bytes leave the device. A file
  // over the size cap or outside the shared MIME allowlist is rejected with a
  // toast naming it and never enters the queue.
  function addFiles(fileList: FileList | null): void {
    if (fileList === null || fileList.length === 0) return;
    const accepted: PendingUpload[] = [];
    for (const file of Array.from(fileList)) {
      const check = precheckFile(file);
      if (!check.ok) {
        onToast?.(`${file.name}: ${check.message}`);
        continue;
      }
      accepted.push({
        id: `pending-${(pendingSeq += 1)}`,
        file,
        name: baseName(file.name),
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    if (accepted.length > 0) setUploads((prev) => [...prev, ...accepted]);
  }

  function rename(id: string, name: string): void {
    setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, name } : item)));
  }

  function remove(id: string): void {
    setUploads((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
    setStatuses((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
  }

  const startRun = useCallback(
    async (targets: PendingUpload[]): Promise<void> => {
      if (onSubmit === undefined || targets.length === 0) return;
      setRunning(true);
      const byId = new Map(targets.map((item) => [item.id, item]));
      const items: QueueItem[] = targets.map((item) => ({
        id: item.id,
        file: item.file,
        filename: uploadFilename(item.name, item.file.name),
      }));

      const result = await runUploads(items, (item) => onSubmit(item.file, item.filename), {
        onStart: (id) => setStatus(id, { state: 'uploading' }),
        onResult: (id, outcome) => {
          const name = byId.get(id)?.name ?? 'file';
          if (outcome.ok) {
            setStatus(id, { state: 'done' });
            onToast?.(outcome.reused ? 'Already in your assets' : `Uploaded ${name}`);
          } else {
            setStatus(id, { state: 'error', message: outcome.message });
            onToast?.(outcome.message);
          }
        },
      });

      setRunning(false);

      // Succeeded files leave the queue; failures stay for inline retry.
      if (result.succeeded.length > 0) {
        const done = new Set(result.succeeded);
        setUploads((prev) => prev.filter((item) => !done.has(item.id)));
      }

      if (result.failed.length === 0) {
        if (result.succeeded.length > 1) {
          onToast?.(`Uploaded ${result.succeeded.length} files`);
        }
        onUploaded?.();
        onClose();
      }
    },
    [onSubmit, onToast, onUploaded, onClose, setStatus],
  );

  const canCommit = onSubmit !== undefined;
  const hasFiles = uploads.length > 0;
  const namesComplete = allNamed(uploads.map((item) => item.name));
  const canUpload = canCommit && hasFiles && namesComplete && !running;

  const footer = (
    <>
      {!canCommit ? (
        <span className="mr-auto text-xs text-fg-3">
          Uploading is not enabled yet. Names are saved when the upload endpoint ships.
        </span>
      ) : !namesComplete && hasFiles ? (
        <span className="mr-auto text-xs text-fg-3">Name every file to upload.</span>
      ) : null}
      <span className={canCommit && namesComplete ? 'ml-auto flex gap-2.5' : 'flex gap-2.5'}>
        <Button variant="ghost" onClick={onClose} disabled={running}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canUpload} onClick={() => void startRun(uploads)}>
          <IconUpload size={16} />
          {running ? 'Uploading' : hasFiles ? `Upload ${uploads.length}` : 'Upload'}
        </Button>
      </span>
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Upload assets" footer={footer}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {!hasFiles ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex min-h-[160px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-panel-2 px-4 text-center text-fg-2 transition-colors hover:bg-panel-3"
        >
          <IconUpload size={26} />
          <span className="text-sm font-medium">Choose files</span>
          <span className="text-xs text-fg-3">
            Name each file before it is added to the library.
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {uploads.map((item) => {
            const status = statuses[item.id] ?? { state: 'queued' };
            const nameMissing = item.name.trim() === '';
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-panel-2 p-2.5"
              >
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3">
                  {item.previewUrl !== null ? (
                    <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center gap-0.5">
                      <IconFile size={20} />
                      {fileExtension(item.file.name) !== '' ? (
                        <span className="text-[10px] font-medium">
                          {fileExtension(item.file.name)}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Input
                    aria-label={`Name for ${item.file.name}`}
                    value={item.name}
                    disabled={running}
                    aria-invalid={nameMissing}
                    onChange={(event) => rename(item.id, event.target.value)}
                    className="h-9"
                  />
                  <span className="truncate text-[11px] text-fg-3">
                    {item.file.name} &middot; {humanizeSize(item.file.size)}
                  </span>
                  <UploadStatusRow
                    status={status}
                    onRetry={() => void startRun([item])}
                    disabled={running}
                  />
                </div>
                <IconButton
                  label={`Remove ${item.file.name}`}
                  onClick={() => remove(item.id)}
                  disabled={running}
                >
                  <IconX size={18} />
                </IconButton>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={running}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-fg-2 transition-colors hover:bg-panel-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            <IconPlus size={16} />
            Add more files
          </button>
        </div>
      )}
    </Sheet>
  );
}

/** Per-file progress / outcome line: an indeterminate bar while uploading, a
 *  success marker on done, and an inline Retry on error. */
function UploadStatusRow({
  status,
  onRetry,
  disabled,
}: {
  status: FileStatus;
  onRetry: () => void;
  disabled: boolean;
}) {
  if (status.state === 'uploading') {
    return (
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-panel-3"
        role="progressbar"
        aria-label="Uploading"
      >
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
    );
  }
  if (status.state === 'done') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-good">
        <IconCheck size={13} />
        Uploaded
      </span>
    );
  }
  if (status.state === 'error') {
    return (
      <span className="flex items-center gap-2 text-[11px] text-bad">
        <span className="truncate">{status.message}</span>
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-fg underline-offset-2 hover:underline disabled:opacity-50"
        >
          Retry
        </button>
      </span>
    );
  }
  return null;
}
