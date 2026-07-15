import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { IconCheck, IconFile, IconPlus, IconUpload, IconX } from '@/components/ui/icons';
import { fileExtension, humanizeSize } from '@/lib/assets';
import {
  UPLOAD_ACCEPT,
  nextUploadNames,
  precheckFile,
  runUploads,
  type QueueItem,
  type UploadOutcome,
} from '@/lib/asset-upload';

/** One queued file with an optional image preview. Names are derived per mode. */
export interface PendingUpload {
  id: string;
  file: File;
  /** Object URL for image previews, or null for non-image files. */
  previewUrl: string | null;
}

/** display_name is capped at 500 chars (mirrors the worker's validName ceiling). */
const DISPLAY_NAME_MAX = 500;

/** The three naming modes, derived from the scope and the selected file count. */
export type UploadMode = 'folder' | 'root-single' | 'root-bulk';

/**
 * Pick the naming mode: inside a folder every file is auto-named (no input); at
 * the root a single file takes one typed name, two or more share one base name.
 */
export function uploadMode(inFolder: boolean, count: number): UploadMode {
  if (inFolder) return 'folder';
  return count > 1 ? 'root-bulk' : 'root-single';
}

/** Cap one name at DISPLAY_NAME_MAX, trimming the base so a numeric suffix survives. */
function fitName(base: string, name: string): string {
  if (name.length <= DISPLAY_NAME_MAX) return name;
  const suffix = name.slice(base.length);
  const keep = Math.max(1, DISPLAY_NAME_MAX - suffix.length);
  return `${base.slice(0, keep)}${suffix}`;
}

interface NameArgs {
  inFolder: boolean;
  folderName: string | null;
  base: string;
  siblingLabels: readonly string[];
  count: number;
}

/**
 * The display_name for each of `count` files, positionally. In a folder every
 * file is "${folderName} N" continuing the folder's existing labels; at the root
 * a single file is the typed name verbatim; two or more are "${base} N"
 * continuing the root's existing labels. Every name is capped at DISPLAY_NAME_MAX.
 */
export function computeDisplayNames(args: NameArgs): string[] {
  const { inFolder, folderName, base, siblingLabels, count } = args;
  if (inFolder) {
    const folder = folderName ?? '';
    return nextUploadNames(folder, siblingLabels, count).map((name) => fitName(folder, name));
  }
  const trimmed = base.trim();
  if (count <= 1) return [trimmed.slice(0, DISPLAY_NAME_MAX)];
  return nextUploadNames(trimmed, siblingLabels, count).map((name) => fitName(trimmed, name));
}

/** Block copy for the name gate, or null when the names are ready to upload. */
export function uploadNameError(mode: UploadMode, base: string): string | null {
  if (mode === 'folder') return null;
  if (base.trim() !== '') return null;
  return mode === 'root-bulk' ? 'Name these files to upload.' : 'Name this file to upload.';
}

/** One file's resolved upload: the original bytes kept as-is plus its display_name. */
export interface UploadPlanItem {
  id: string;
  file: File;
  displayName: string;
}

/**
 * Pair each pending file with its computed display_name, positionally. The file
 * is carried untouched so the part is always sent under its original name.
 */
export function buildUploadPlan(
  pending: readonly { id: string; file: File }[],
  args: Omit<NameArgs, 'count'>,
): UploadPlanItem[] {
  const names = computeDisplayNames({ ...args, count: pending.length });
  return pending.map((item, index) => ({
    id: item.id,
    file: item.file,
    displayName: names[index] ?? '',
  }));
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
   * Per-file commit: POST one file to the asset-upload worker with its resolved
   * display_name and destination folder, reporting its outcome. When omitted, the
   * sheet stays a naming surface only (no upload endpoint configured) and the
   * confirm action explains that uploading is not wired yet.
   */
  onSubmit?:
    | ((file: File, displayName: string, folderId: string | null) => Promise<UploadOutcome>)
    | undefined;
  /** Toast sink (the page toast queue). */
  onToast?: ((message: string) => void) | undefined;
  /** Called once after a run in which every file succeeded, to refresh the grid. */
  onUploaded?: (() => void) | undefined;
  /** Current scope: a folder id, or null at the library root (the default). */
  folderId?: string | null;
  /** The current folder's name (for auto-naming), or null at the root (the default). */
  folderName?: string | null;
  /** Display labels of the assets already in this scope, to continue numbering. */
  siblingLabels?: readonly string[];
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
  folderId = null,
  folderName = null,
  siblingLabels = [],
}: AssetUploadSheetProps) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({});
  const [running, setRunning] = useState(false);
  // The single typed name: the file's name at the root with one file, or the
  // shared base at the root with several. Unused in folder mode (auto-named).
  const [nameInput, setNameInput] = useState('');
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
      setNameInput('');
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
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    if (accepted.length === 0) return;
    // Seed the name field from the first file the first time the queue fills, so
    // a root single upload starts with a sensible name (ignored in folder mode).
    if (uploads.length === 0) {
      setNameInput((prev) => (prev === '' ? baseName(accepted[0]!.file.name) : prev));
    }
    setUploads((prev) => [...prev, ...accepted]);
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

  const inFolder = folderId !== null;

  const startRun = useCallback(
    async (targets: PendingUpload[]): Promise<void> => {
      if (onSubmit === undefined || targets.length === 0) return;
      setRunning(true);
      const plan = buildUploadPlan(targets, {
        inFolder: folderId !== null,
        folderName,
        base: nameInput,
        siblingLabels,
      });
      const byId = new Map(plan.map((item) => [item.id, item]));
      const items: QueueItem[] = plan.map((item) => ({
        id: item.id,
        file: item.file,
        filename: item.file.name,
        displayName: item.displayName,
      }));

      const result = await runUploads(
        items,
        (item) => onSubmit(item.file, item.displayName ?? '', folderId),
        {
          onStart: (id) => setStatus(id, { state: 'uploading' }),
          onResult: (id, outcome) => {
            const name = byId.get(id)?.displayName ?? 'file';
            if (outcome.ok) {
              setStatus(id, { state: 'done' });
              onToast?.(outcome.reused ? 'Already in your assets' : `Uploaded ${name}`);
            } else {
              setStatus(id, { state: 'error', message: outcome.message });
              onToast?.(outcome.message);
            }
          },
        },
      );

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
    [
      onSubmit,
      onToast,
      onUploaded,
      onClose,
      setStatus,
      folderId,
      folderName,
      nameInput,
      siblingLabels,
    ],
  );

  const canCommit = onSubmit !== undefined;
  const hasFiles = uploads.length > 0;
  const count = uploads.length;
  const mode = uploadMode(inFolder, count);
  const nameError = hasFiles ? uploadNameError(mode, nameInput) : null;
  const previewNames = hasFiles
    ? computeDisplayNames({ inFolder, folderName, base: nameInput, siblingLabels, count })
    : [];
  const canUpload = canCommit && hasFiles && nameError === null && !running;

  const footer = (
    <>
      {!canCommit ? (
        <span className="mr-auto text-xs text-fg-3">
          Uploading is not enabled yet. Names are saved when the upload endpoint ships.
        </span>
      ) : nameError !== null ? (
        <span className="mr-auto text-xs text-fg-3">{nameError}</span>
      ) : null}
      <span className={canCommit && nameError === null ? 'ml-auto flex gap-2.5' : 'flex gap-2.5'}>
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
            {inFolder
              ? `Files are named after this folder automatically.`
              : `Name your upload before it is added to the library.`}
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* Naming control by mode: a folder auto-names every file; a single root
              file takes one name; several root files share one base name. */}
          {mode === 'folder' ? (
            <p className="rounded-xl border border-border bg-panel-2 px-3 py-2 text-xs text-fg-2">
              Auto-named: <span className="text-fg">{previewNames.join(', ')}</span>
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${inputId}-name`} className="text-xs font-medium text-fg-2">
                {mode === 'root-bulk' ? 'Name these files' : 'Name'}
              </label>
              <Input
                id={`${inputId}-name`}
                aria-label={mode === 'root-bulk' ? 'Base name for these files' : 'Name'}
                value={nameInput}
                disabled={running}
                aria-invalid={nameError !== null}
                onChange={(event) => setNameInput(event.target.value)}
                className="h-11"
              />
              {mode === 'root-bulk' && nameInput.trim() !== '' ? (
                <span className="truncate text-[11px] text-fg-3">{previewNames.join(', ')}</span>
              ) : null}
            </div>
          )}

          {uploads.map((item) => {
            const status = statuses[item.id] ?? { state: 'queued' };
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
                  <span className="truncate text-sm text-fg">{item.file.name}</span>
                  <span className="truncate text-[11px] text-fg-3">
                    {humanizeSize(item.file.size)}
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
