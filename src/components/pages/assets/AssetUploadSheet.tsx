import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { DropZone } from '@/components/ui/DropZone';
import { ICON_SIZE, IconCheck, IconFile, IconPlus, IconUpload, IconX } from '@/components/ui/icons';
import { fileExtension, humanizeSize } from '@/lib/assets';
import {
  UPLOAD_ACCEPT,
  nextUploadNames,
  precheckFile,
  runUploads,
  type QueueItem,
  type UploadOutcome,
} from '@/lib/asset-upload';
import { useBackGuard } from '@/lib/back-guard';
import { dispatchInductionRefresh } from '@/lib/induction';
import { ROOT_LABEL } from '@/components/pages/assets/assets-nav';

/** One queued file with an optional image preview. Names are derived per mode. */
export interface PendingUpload {
  id: string;
  file: File;
  /** Object URL for image previews, or null for non-image files. */
  previewUrl: string | null;
}

/** display_name is capped at 500 chars (mirrors the worker's validName ceiling). */
const DISPLAY_NAME_MAX = 500;

/** The two naming modes, derived from the selected file count. */
export type UploadMode = 'root-single' | 'root-bulk';

/** Pick the naming mode: a single file takes one typed name, two or more share one base name. */
export function uploadMode(count: number): UploadMode {
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
  base: string;
  siblingLabels: readonly string[];
  count: number;
}

/**
 * The display_name for each of `count` files, positionally. A single file is the
 * typed name verbatim; two or more are "${base} N" continuing the library's
 * existing labels. Every name is capped at DISPLAY_NAME_MAX.
 */
export function computeDisplayNames(args: NameArgs): string[] {
  const { base, siblingLabels, count } = args;
  const trimmed = base.trim();
  if (count <= 1) return [trimmed.slice(0, DISPLAY_NAME_MAX)];
  return nextUploadNames(trimmed, siblingLabels, count).map((name) => fitName(trimmed, name));
}

/** Block copy for the name gate, or null when the names are ready to upload. */
export function uploadNameError(mode: UploadMode, base: string): string | null {
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

/** The sheet header while a run is in flight: "Uploading 2 of 5…". Pure. */
export function uploadBusyLabel(current: number, total: number): string {
  if (total <= 1) return 'Uploading…';
  return `Uploading ${Math.min(Math.max(current, 1), total)} of ${total}…`;
}

/** The one toast a finished run shows. A sticky toast stays until dismissed. */
export interface UploadSummary {
  title: string;
  sticky: boolean;
}

/**
 * The single summary toast for a run: any failure is sticky and says how many
 * failed; an all-success run says how many uploaded. Null when nothing ran. Pure.
 */
export function uploadSummary(args: {
  uploaded: number;
  reused: number;
  failed: number;
}): UploadSummary | null {
  const { uploaded, reused, failed } = args;
  const ok = uploaded + reused;
  if (failed > 0) {
    if (ok === 0) {
      return {
        title:
          failed === 1
            ? "Couldn't upload the file. Try again."
            : `${failed} uploads failed. Try again.`,
        sticky: true,
      };
    }
    return { title: `Uploaded ${ok} of ${ok + failed}. ${failed} failed.`, sticky: true };
  }
  if (ok === 0) return null;
  if (uploaded === 0) return { title: 'Already in your assets', sticky: false };
  return { title: ok === 1 ? 'Uploaded 1 file' : `Uploaded ${ok} files`, sticky: false };
}

/**
 * The run was stopped (Stop, or the sheet went away mid-run): the file in flight
 * was aborted, or the file was never started. Never shown as a failure.
 */
export const STOPPED_MESSAGE = 'Not uploaded';

const STOPPED_OUTCOME: UploadOutcome = { ok: false, message: STOPPED_MESSAGE };

/** Whether an outcome is the stopped marker, not a real failure. Pure. */
export function isStoppedOutcome(outcome: UploadOutcome): boolean {
  return !outcome.ok && outcome.message === STOPPED_MESSAGE;
}

/** The Stop confirm (from the Stop button or system Back while uploading). */
export const STOP_CONFIRM = {
  title: 'Stop uploading?',
  message: 'Files already uploaded stay. The rest are cancelled.',
  confirmLabel: 'Stop',
  cancelLabel: 'Keep uploading',
};

/** The Sheet's discard confirm for files picked but not started. */
export const UPLOAD_DISCARD = {
  title: 'Discard these files?',
  message: 'The files you picked are not uploaded.',
};

/** The toast after a stopped run: "Upload stopped. 2 of 5 files uploaded." Pure. */
export function uploadStoppedLabel(done: number, total: number): string {
  return `Upload stopped. ${done} of ${total} ${total === 1 ? 'file' : 'files'} uploaded.`;
}

/**
 * Wrap the per-file upload so a run can stop without changing runUploads: once
 * `stopped()` is true every file not started returns the stopped outcome at
 * once, and the file in flight (aborted through `signal`) reports stopped too
 * unless it had already finished. Pure orchestration, tested directly.
 */
export function stoppableUpload(
  upload: (item: QueueItem, signal: AbortSignal) => Promise<UploadOutcome>,
  control: { stopped: () => boolean; signal: AbortSignal },
): (item: QueueItem) => Promise<UploadOutcome> {
  return async (item) => {
    if (control.stopped()) return STOPPED_OUTCOME;
    const outcome = await upload(item, control.signal);
    if (!outcome.ok && control.stopped()) return STOPPED_OUTCOME;
    return outcome;
  };
}

/**
 * One toast for every file the pre-check turned away: one file names itself and
 * the reason; several share one line. Null when nothing was turned away. Pure.
 */
export function precheckSummary(
  rejected: readonly { name: string; message: string }[],
): string | null {
  const [first] = rejected;
  if (first === undefined) return null;
  if (rejected.length === 1) return `${first.name}: ${first.message}`;
  const reasons = new Set(rejected.map((item) => item.message));
  const reason =
    reasons.size > 1
      ? 'Files up to 100MB only, in a supported type.'
      : first.message === "This file type isn't supported"
        ? "Their file type isn't supported."
        : `${first.message}.`;
  return `${rejected.length} files weren't added. ${reason}`;
}

/** Per-file lifecycle within an upload run. */
type FileStatus =
  | { state: 'queued' }
  | { state: 'uploading' }
  | { state: 'done' }
  | { state: 'stopped' }
  | { state: 'error'; message: string };

/** The live run, held in a ref so Stop, Back and an unmount reach the same one. */
interface RunControl {
  controller: AbortController;
  /** Stop was confirmed, or the sheet went away: no more files start. */
  stopped: boolean;
  /** The sheet went away mid-run: the toast is out, the sheet does nothing more. */
  abandoned: boolean;
  done: number;
  total: number;
}

interface AssetUploadSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Per-file commit: POST one file to the asset-upload worker with its resolved
   * display_name and destination folder (always null: the library root), reporting its outcome. When omitted, the
   * sheet stays a naming surface only (no upload endpoint configured) and the
   * confirm action explains that uploading is not wired yet. `signal` aborts
   * the request in flight when the run is stopped.
   */
  onSubmit?:
    | ((
        file: File,
        displayName: string,
        folderId: string | null,
        signal?: AbortSignal,
      ) => Promise<UploadOutcome>)
    | undefined;
  /** Toast sink (the page toast queue). */
  onToast?: ((message: string) => void) | undefined;
  /**
   * One summary toast per run (the Assets page). When set, the per-file toasts
   * are not shown; the summary is sticky when any file failed.
   */
  onSummary?: ((summary: UploadSummary) => void) | undefined;
  /** Called once after a run in which every file succeeded, to refresh the grid. */
  onUploaded?: (() => void) | undefined;
  /** Display labels of the assets already in the library, to continue numbering. */
  siblingLabels?: readonly string[];
  /**
   * Seed for the root name box in place of the first file's name (the post page
   * passes the post title). Still editable.
   */
  defaultBaseName?: string | null;
}

/**
 * The name box once the queue first fills: a name already typed is kept; else the
 * caller's default when set, else the first file's name.
 */
export function seedName(prev: string, defaultBaseName: string | null, filename: string): string {
  if (prev !== '') return prev;
  const preset = defaultBaseName?.trim() ?? '';
  return preset !== '' ? preset.slice(0, DISPLAY_NAME_MAX) : baseName(filename);
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
  onSummary,
  onUploaded,
  siblingLabels = [],
  defaultBaseName = null,
}: AssetUploadSheetProps) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({});
  const [running, setRunning] = useState(false);
  // Which file of the run is going up, for the busy header.
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  // The single typed name: the file's name with one file, or the shared base
  // with several.
  const [nameInput, setNameInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  // The Stop confirm, from the Stop button or system Back while uploading.
  const [stopAsk, setStopAsk] = useState(false);
  const runRef = useRef<RunControl | null>(null);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;

  // The sheet went away (closed by code, unmounted by sign-out, a workspace
  // switch or a route change) while files were going up: abort the one in
  // flight, start no more, and say how far it got in an app-wide toast.
  const abandonRun = useCallback((): void => {
    const control = runRef.current;
    if (control === null || control.abandoned) return;
    control.stopped = true;
    control.abandoned = true;
    control.controller.abort();
    runRef.current = null;
    onToastRef.current?.(uploadStoppedLabel(control.done, control.total));
  }, []);

  useEffect(() => () => abandonRun(), [abandonRun]);

  // Stop confirmed: abort the file in flight; the rest return stopped at once.
  const confirmStop = useCallback((): void => {
    setStopAsk(false);
    const control = runRef.current;
    if (control === null) return;
    control.stopped = true;
    control.controller.abort();
  }, []);

  // Revoke any object URLs we created when the queue changes or the sheet closes,
  // so previews never leak.
  const revokeAll = useCallback((items: PendingUpload[]): void => {
    for (const item of items) {
      if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      abandonRun();
      setStopAsk(false);
      setUploads((prev) => {
        revokeAll(prev);
        return [];
      });
      setStatuses({});
      setRunning(false);
      setNameInput('');
    }
  }, [open, revokeAll, abandonRun]);

  useEffect(() => () => revokeAll(uploads), [uploads, revokeAll]);

  const setStatus = useCallback((id: string, status: FileStatus): void => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
  }, []);

  // Client-side pre-checks run here, before any bytes leave the device. A file
  // over the size cap or outside the shared MIME allowlist never enters the
  // queue; every one turned away is reported in one summary toast.
  function addFiles(fileList: FileList | null): void {
    if (fileList === null || fileList.length === 0) return;
    const accepted: PendingUpload[] = [];
    const rejected: { name: string; message: string }[] = [];
    for (const file of Array.from(fileList)) {
      const check = precheckFile(file);
      if (!check.ok) {
        rejected.push({ name: file.name, message: check.message });
        continue;
      }
      accepted.push({
        id: `pending-${(pendingSeq += 1)}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    const summary = precheckSummary(rejected);
    if (summary !== null) onToast?.(summary);
    if (accepted.length === 0) return;
    // Seed the name field the first time the queue fills (the caller's default, or
    // the first file's name), so a root upload starts with a sensible name. A name
    // the user already typed is kept.
    if (uploads.length === 0) {
      setNameInput((prev) => seedName(prev, defaultBaseName, accepted[0]!.file.name));
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

  const startRun = useCallback(
    async (targets: PendingUpload[]): Promise<void> => {
      if (onSubmit === undefined || targets.length === 0) return;
      const control: RunControl = {
        controller: new AbortController(),
        stopped: false,
        abandoned: false,
        done: 0,
        total: targets.length,
      };
      runRef.current = control;
      setRunning(true);
      setProgress({ current: 0, total: targets.length });
      let reused = 0;
      const plan = buildUploadPlan(targets, {
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

      const uploadOne = stoppableUpload(
        (item, signal) => onSubmit(item.file, item.displayName ?? '', null, signal),
        { stopped: () => control.stopped, signal: control.controller.signal },
      );

      const result = await runUploads(items, uploadOne, {
        onStart: (id) => {
          if (control.stopped) return;
          setStatus(id, { state: 'uploading' });
          setProgress((prev) => ({ ...prev, current: Math.min(prev.current + 1, prev.total) }));
        },
        onResult: (id, outcome) => {
          const name = byId.get(id)?.displayName ?? 'file';
          if (isStoppedOutcome(outcome)) {
            setStatus(id, { state: 'stopped' });
          } else if (outcome.ok) {
            control.done += 1;
            setStatus(id, { state: 'done' });
            if (outcome.reused) reused += 1;
            if (onSummary === undefined) {
              onToast?.(outcome.reused ? 'Already in your assets' : `Uploaded ${name}`);
            }
          } else {
            setStatus(id, { state: 'error', message: outcome.message });
            if (onSummary === undefined) onToast?.(outcome.message);
          }
        },
      });

      if (runRef.current === control) runRef.current = null;
      // The sheet went away mid-run: the toast is out; nothing here is shown.
      if (control.abandoned) {
        if (result.succeeded.length > 0) dispatchInductionRefresh();
        return;
      }

      setRunning(false);

      // Stopped: finished files stay, the rest are cancelled, and the sheet closes.
      if (control.stopped) {
        const title = uploadStoppedLabel(result.succeeded.length, targets.length);
        if (onSummary !== undefined) onSummary({ title, sticky: false });
        else onToast?.(title);
        if (result.succeeded.length > 0) dispatchInductionRefresh();
        onUploaded?.();
        onClose();
        return;
      }

      if (onSummary !== undefined) {
        const summary = uploadSummary({
          uploaded: result.succeeded.length - reused,
          reused,
          failed: result.failed.length,
        });
        if (summary !== null) onSummary(summary);
      }

      // Succeeded files leave the queue; failures stay for inline retry.
      if (result.succeeded.length > 0) {
        const done = new Set(result.succeeded);
        setUploads((prev) => prev.filter((item) => !done.has(item.id)));
      }

      if (result.succeeded.length > 0) dispatchInductionRefresh();

      if (result.failed.length === 0) {
        if (onSummary === undefined && result.succeeded.length > 1) {
          onToast?.(`Uploaded ${result.succeeded.length} files`);
        }
        onUploaded?.();
        onClose();
      }
    },
    [onSubmit, onToast, onSummary, onUploaded, onClose, setStatus, nameInput, siblingLabels],
  );

  const canCommit = onSubmit !== undefined;
  const hasFiles = uploads.length > 0;
  const count = uploads.length;
  const mode = uploadMode(count);
  const nameError = hasFiles ? uploadNameError(mode, nameInput) : null;
  const previewNames = hasFiles
    ? computeDisplayNames({ base: nameInput, siblingLabels, count })
    : [];
  const canUpload = canCommit && hasFiles && nameError === null && !running;

  // System Back while files are going up asks the Stop confirm (the Sheet's
  // own busy guard sits under this one and only keeps the sheet). Keep
  // uploading leaves the same run going. While running, the guard also asks
  // the browser's leave prompt on a reload or tab close.
  useBackGuard({ active: open && running, onBack: () => setStopAsk(true) });

  const footer = (
    <>
      {!canCommit ? (
        <span className="mr-auto text-sm text-fg-3">
          Uploading is not enabled yet. Names are saved when the upload endpoint ships.
        </span>
      ) : nameError !== null ? (
        <span className="mr-auto text-sm text-fg-3">{nameError}</span>
      ) : null}
      <span className={canCommit && nameError === null ? 'ml-auto flex gap-2.5' : 'flex gap-2.5'}>
        {running ? (
          <Button variant="ghost" onClick={() => setStopAsk(true)}>
            Stop
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )}
        <Button variant="primary" disabled={!canUpload} onClick={() => void startRun(uploads)}>
          <IconUpload size={ICON_SIZE.inline} />
          {running ? 'Uploading' : hasFiles ? `Upload ${uploads.length}` : 'Upload'}
        </Button>
      </span>
    </>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Upload assets"
      footer={footer}
      busy={running}
      busyLabel={uploadBusyLabel(progress.current, progress.total)}
      dirty={hasFiles && !running}
      discard={UPLOAD_DISCARD}
    >
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
        <DropZone type="button" minHeight="panel" onClick={() => inputRef.current?.click()}>
          <IconUpload size={ICON_SIZE.status} />
          <span className="text-base font-medium">Choose files</span>
          <span className="text-sm text-fg-3">
            Name your upload before it is added to {ROOT_LABEL}.
          </span>
        </DropZone>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* One file takes one name; several share one base name. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${inputId}-name`} className="text-base font-medium text-fg-2">
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
              <span className="truncate text-sm text-fg-3">{previewNames.join(', ')}</span>
            ) : null}
          </div>

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
                      <IconFile size={ICON_SIZE.control} />
                      {fileExtension(item.file.name) !== '' ? (
                        <span className="text-xs font-medium">{fileExtension(item.file.name)}</span>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-base text-fg">{item.file.name}</span>
                  <span className="truncate text-sm text-fg-3">{humanizeSize(item.file.size)}</span>
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
                  <IconX size={ICON_SIZE.nav} />
                </IconButton>
              </div>
            );
          })}

          <Button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={running}
            className="border-dashed text-fg-2"
          >
            <IconPlus size={ICON_SIZE.inline} />
            Add more files
          </Button>
        </div>
      )}
      {stopAsk && running ? (
        <ConfirmDialog
          title={STOP_CONFIRM.title}
          message={STOP_CONFIRM.message}
          confirmLabel={STOP_CONFIRM.confirmLabel}
          cancelLabel={STOP_CONFIRM.cancelLabel}
          destructive
          onConfirm={confirmStop}
          onCancel={() => setStopAsk(false)}
        />
      ) : null}
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
      <span className="flex items-center gap-1 text-sm text-good">
        <IconCheck size={ICON_SIZE.inline} />
        Uploaded
      </span>
    );
  }
  if (status.state === 'stopped') {
    return <span className="text-sm text-fg-3">{STOPPED_MESSAGE}</span>;
  }
  if (status.state === 'error') {
    return (
      <span className="flex items-center justify-between gap-2 text-sm text-bad">
        <span className="min-w-0 truncate">{status.message}</span>
        <Button
          variant="ghost"
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="shrink-0"
        >
          Retry
        </Button>
      </span>
    );
  }
  return null;
}
