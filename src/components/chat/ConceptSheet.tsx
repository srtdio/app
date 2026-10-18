// The concept sheet: title, description, date and files (library picks and
// fresh uploads). One component for both "Add concept" (the New plan screen)
// and "Edit concept" (a concept's item screen); the parent owns the form and
// the submit. The files picker opens over it and closes with it. Uploads go
// through the comments' upload path (library origin), all at once, and land in
// the file list when done; Save waits for them and is refused while one has
// failed, so nothing saves partially. Closing aborts uploads in flight (files
// already uploaded stay in storage, unlinked). Edit: until the concept's files
// are known the files section shows a skeleton (or a Retry) and Add / Upload
// stay hidden. Tokens only; the Sheet's translateY motion only.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { IconX } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { Thumbnail } from '@/components/media/Thumbnail';
import { AssetPicker } from '@/components/chat/AssetPicker';
import { PendingChip } from '@/components/comments/CommentComposer';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ConceptDateField } from '@/components/chat/PlanScreen';
import { PlanDayTiles } from '@/components/chat/PlanDayPickerSheet';
import { CONCEPT_FILES_MAX, PLAN_TITLE_MAX } from '@/components/chat/plan-card';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import type { AttachmentUploader } from '@/lib/chat/attachments';
import {
  CONCEPT_UPLOAD_FAILED,
  conceptSaveGate,
  createConceptFilesRead,
  createConceptUploads,
  type ConceptFilesReadState,
  type ConceptUpload,
  type ConceptUploads,
  type ComposeDay,
  type ComposeRange,
  wordCounterLabel,
} from '@/lib/chat/plans';
import { cn } from '@/lib/cn';

/** A concept file as the sheet shows it (a library pick, or a recorded version). */
export interface ConceptFile {
  versionId: string;
  name: string;
}

/** The concept being added or edited. */
export interface ConceptForm {
  title: string;
  description: string;
  files: ConceptFile[];
  /** "YYYY-MM-DD", or '' for no date. */
  date: string;
}

export const EMPTY_CONCEPT: ConceptForm = { title: '', description: '', files: [], date: '' };

/** Max description length (the proc's limit). */
export const CONCEPT_DESCRIPTION_MAX = 5000;

export const FIELD =
  'min-h-[48px] w-full rounded-lg border border-border bg-panel px-3.5 text-base text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';

/** The hint once the files reach the cap (library picks and uploads together). */
export const CONCEPT_FILES_LIMIT_HINT = `You can add up to ${CONCEPT_FILES_MAX} files.`;

/** The files section when the concept's files could not be read. */
export const CONCEPT_FILES_READ_FAILED = "Couldn't load files.";

/** The Save label while it waits for uploads. */
export const CONCEPT_SAVE_UPLOADING = 'Uploading...';

/** The files section: known, being read, or the read failed (edit only). */
export type ConceptFilesState = 'ready' | ConceptFilesReadState;

/** How many more files fit: the cap less picks and uploads (failed ones too). Pure. */
export function conceptFilesRoom(picked: number, uploads: number): number {
  return Math.max(0, CONCEPT_FILES_MAX - picked - uploads);
}

/**
 * The Edit concept sheet's files read while `active` (the sheet is open and
 * the files are not known): it starts on activation, retry() starts it again,
 * and deactivating or unmounting aborts it. A success goes to onLoaded.
 */
export function useConceptFilesRead(
  active: boolean,
  load: (cancel: AbortSignal) => Promise<Result<string[]>>,
  onLoaded: (files: string[]) => void,
): { state: ConceptFilesReadState; retry: () => void } {
  const [state, setState] = useState<ConceptFilesReadState>('loading');
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  const readRef = useRef<{ start: () => void } | null>(null);
  useEffect(() => {
    if (!active) {
      setState('loading');
      return;
    }
    const read = createConceptFilesRead({
      load: (cancel) => loadRef.current(cancel),
      onState: setState,
      onLoaded: (files) => loadedRef.current(files),
    });
    readRef.current = read;
    read.start();
    return () => {
      read.stop();
      readRef.current = null;
    };
  }, [active]);
  const retry = useCallback(() => readRef.current?.start(), []);
  return { state, retry };
}

/** The description's placeholder. */
export const CONCEPT_DESCRIPTION_PLACEHOLDER =
  'What is the concept? The idea, the hook, what approvers will see.';

/** The tiles' selection for a form date: '' is No date; a day outside the plan selects none. Pure. */
export function conceptTileDay(date: string, range: ComposeRange): ComposeDay {
  if (date === '') return 'none';
  return date >= range.startsOn && date <= range.endsOn ? date : null;
}

/** The discard confirm's title. */
export const CONCEPT_DISCARD_TITLE = 'Discard this concept?';

/** The discard confirm's copy: Add loses the concept, Edit loses the changes. Pure. */
export function conceptDiscardCopy(mode: 'add' | 'edit'): { title: string; message: string } {
  return {
    title: CONCEPT_DISCARD_TITLE,
    message: mode === 'add' ? 'Your concept will be lost.' : 'Your changes will be lost.',
  };
}

/**
 * Whether closing would lose work: an upload in flight, or the text, date or
 * (Add) files differ from what the sheet opened with. Edit's files load after
 * open, so they are not compared there. Pure.
 */
export function conceptDirty(input: {
  mode: 'add' | 'edit';
  form: ConceptForm;
  baseline: ConceptForm;
  uploads: number;
}): boolean {
  const { form, baseline } = input;
  if (input.uploads > 0) return true;
  if (form.title.trim() !== baseline.title.trim()) return true;
  if (form.description.trim() !== baseline.description.trim()) return true;
  if (form.date !== baseline.date) return true;
  if (input.mode === 'add') {
    const before = baseline.files.map((f) => f.versionId).join(',');
    return form.files.map((f) => f.versionId).join(',') !== before;
  }
  return false;
}

/** Whether the form can be submitted: a title of 1 to 200 characters. Pure. */
export function conceptFormValid(form: Pick<ConceptForm, 'title'>): boolean {
  const t = form.title.trim();
  return t !== '' && t.length <= PLAN_TITLE_MAX;
}

export function ConceptSheet(props: {
  open: boolean;
  mode: 'add' | 'edit';
  form: ConceptForm;
  onChange: (update: (form: ConceptForm) => ConceptForm) => void;
  onSubmit: () => void;
  onClose: () => void;
  busy?: boolean;
  /** A muted line above the buttons; none when null or absent. */
  note?: string | null;
  /** The concept's current files (edit only); 'ready' when absent. */
  filesState?: ConceptFilesState;
  /** Read the files again after a failed read (edit only). */
  onRetryFiles?: () => void;
  /** Upload one file, library origin (the comments' path); no Upload when absent. */
  uploadFile?: AttachmentUploader;
  /**
   * The plan's days: the date is picked from its day tiles plus No date.
   * Absent: the native date field (a caller without the plan's range).
   */
  range?: ComposeRange;
  /** Today in the workspace zone (the tiles' accent weekday). */
  today?: string;
  /** Items per day for the tiles. */
  dayCounts?: Readonly<Record<string, number>>;
}): ReactElement {
  const { form, onChange } = props;
  const words = wordCounterLabel(form.description);
  const busy = props.busy === true;
  const filesState = props.filesState ?? 'ready';
  const showToast = useToast().show;
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [uploads, setUploads] = useState<readonly ConceptUpload[]>([]);
  // Save tapped while uploads run: it goes once they settle.
  const [waiting, setWaiting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef(props.uploadFile);
  uploadRef.current = props.uploadFile;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const submitRef = useRef(props.onSubmit);
  submitRef.current = props.onSubmit;
  const uploadsRef = useRef<ConceptUploads | null>(null);
  if (uploadsRef.current === null) {
    uploadsRef.current = createConceptUploads({
      upload: (file, onProgress, signal) => {
        const upload = uploadRef.current;
        return upload !== undefined
          ? upload(file, onProgress, signal)
          : Promise.resolve({ ok: false, message: CONCEPT_UPLOAD_FAILED });
      },
      precheck: precheckFile,
      onChange: setUploads,
      onUploaded: (versionId, name) =>
        changeRef.current((f) =>
          f.files.some((x) => x.versionId === versionId)
            ? f
            : { ...f, files: [...f.files, { versionId, name }] },
        ),
      preview: (file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null),
      revoke: (url) => URL.revokeObjectURL(url),
    });
  }
  const controller = uploadsRef.current;
  // A closed sheet closes its picker and aborts its uploads; so does unmount.
  useEffect(() => {
    if (props.open) return;
    setAssetsOpen(false);
    setWaiting(false);
    controller.abortAll();
  }, [props.open, controller]);
  useEffect(() => () => controller.abortAll(), [controller]);
  // A waiting Save goes once nothing is in flight; a failed upload refuses it.
  const valid = conceptFormValid(form);
  useEffect(() => {
    if (!waiting) return;
    const gate = conceptSaveGate(uploads);
    if (gate === 'wait') return;
    setWaiting(false);
    if (gate === 'refuse') showToast({ title: CONCEPT_UPLOAD_FAILED });
    else if (valid) submitRef.current();
  }, [waiting, uploads, valid, showToast]);

  const edit = props.mode === 'edit';
  // What the sheet opened with: Add compares against an empty concept (a kept
  // draft still counts as work), Edit against the concept as it was.
  const wasOpen = useRef(false);
  const baseline = useRef<ConceptForm>(EMPTY_CONCEPT);
  if (props.open && !wasOpen.current) baseline.current = edit ? form : EMPTY_CONCEPT;
  wasOpen.current = props.open;
  const dirty = conceptDirty({
    mode: props.mode,
    form,
    baseline: baseline.current,
    uploads: uploads.length,
  });
  const discardCopy = conceptDiscardCopy(props.mode);
  const room = conceptFilesRoom(form.files.length, uploads.length);
  const atLimit = room === 0;
  const canUpload = props.uploadFile !== undefined;
  const save = (): void => {
    if (waiting) return;
    const gate = conceptSaveGate(uploads);
    if (gate === 'refuse') {
      showToast({ title: CONCEPT_UPLOAD_FAILED });
      return;
    }
    if (gate === 'wait') {
      setWaiting(true);
      return;
    }
    props.onSubmit();
  };
  return (
    <>
      <Sheet
        open={props.open}
        onClose={props.onClose}
        title={edit ? 'Edit concept' : 'Add concept'}
        dirty={dirty}
        discard={discardCopy}
        busy={busy}
        footer={
          <div className="flex w-full flex-col gap-2">
            {props.note !== undefined && props.note !== null ? (
              <p data-plan-concept-reset="" className="text-[13px] leading-[18px] text-fg-3">
                {props.note}
              </p>
            ) : null}
            <div className="grid w-full grid-cols-2 gap-2">
              <Button size="lg" variant="ghost" disabled={busy} onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                size="lg"
                variant="primary"
                data-plan-concept-save=""
                aria-busy={waiting}
                disabled={busy || !valid}
                onClick={save}
              >
                {waiting ? CONCEPT_SAVE_UPLOADING : edit ? 'Save' : 'Add'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-3">Title</span>
            <input
              data-plan-concept-title=""
              value={form.title}
              maxLength={PLAN_TITLE_MAX}
              autoComplete="off"
              disabled={busy}
              onChange={(e) => {
                const title = e.target.value;
                onChange((f) => ({ ...f, title }));
              }}
              className={FIELD}
            />
          </label>
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              <span className="text-[13px] text-fg-3">Description</span>
              <textarea
                data-plan-concept-description=""
                value={form.description}
                maxLength={CONCEPT_DESCRIPTION_MAX}
                rows={4}
                disabled={busy}
                placeholder={CONCEPT_DESCRIPTION_PLACEHOLDER}
                onChange={(e) => {
                  const description = e.target.value;
                  onChange((f) => ({ ...f, description }));
                }}
                className={cn(FIELD, 'min-h-[104px] py-2.5 leading-[1.45]')}
              />
            </label>
            <p
              data-plan-concept-words={words.over ? 'over' : 'ok'}
              aria-live="polite"
              className={cn(
                'text-right font-mono text-[11.5px] tabular-nums',
                words.over ? 'text-warn' : 'text-fg-3',
              )}
            >
              {words.label}
            </p>
          </div>
          {props.range === undefined ? (
            <ConceptDateField
              value={form.date}
              disabled={busy}
              onChange={(date) => onChange((f) => ({ ...f, date }))}
            />
          ) : null}
          {filesState === 'loading' ? (
            <div
              data-plan-concept-files-loading=""
              aria-label="Loading files"
              className="h-[72px] animate-pulse rounded-lg bg-panel-2"
            />
          ) : filesState === 'failed' ? (
            <div
              data-plan-concept-files-failed=""
              className="flex min-h-[72px] items-center justify-between gap-3 rounded-lg border border-border bg-panel px-3.5"
            >
              <p className="text-sm text-fg-2">{CONCEPT_FILES_READ_FAILED}</p>
              <Button
                size="lg"
                data-plan-concept-files-retry=""
                className="min-w-[44px]"
                onClick={props.onRetryFiles}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              {form.files.length > 0 ? (
                <div className="grid grid-cols-4 gap-1.5">
                  {form.files.map((f) => (
                    <div
                      key={f.versionId}
                      data-plan-concept-file=""
                      className="relative overflow-hidden rounded-md border border-border bg-panel-2"
                    >
                      <Thumbnail
                        assetVersionId={f.versionId}
                        cache={sharedCardPresignCache()}
                        presignEnabled={PRESIGN_ENABLED}
                        fallback={{ kind: 'glyph' }}
                        alt={f.name}
                      />
                      <button
                        type="button"
                        data-plan-concept-file-remove=""
                        aria-label={`Remove ${f.name}`}
                        disabled={busy}
                        onClick={() =>
                          onChange((x) => ({
                            ...x,
                            files: x.files.filter((y) => y.versionId !== f.versionId),
                          }))
                        }
                        className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-panel text-fg-2">
                          <IconX size={14} />
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {uploads.length > 0 ? (
                <ul data-plan-concept-uploads="" className="flex flex-col gap-2">
                  {uploads.map((u) => (
                    <li
                      key={u.id}
                      data-plan-concept-upload={u.status.state}
                      className="flex items-center gap-2"
                    >
                      <ul className="min-w-0">
                        <PendingChip item={u} onRemove={() => controller.remove(u.id)} />
                      </ul>
                      {u.status.state === 'error' ? (
                        <button
                          type="button"
                          data-plan-concept-upload-retry=""
                          aria-label={`Retry ${u.file.name}`}
                          disabled={busy}
                          onClick={() => controller.retry(u.id)}
                          className="min-h-[44px] min-w-[44px] shrink-0 rounded-md px-2 text-[15px] font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                        >
                          Retry
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {atLimit ? (
                <p
                  data-plan-concept-files-limit=""
                  className="text-[13px] leading-[18px] text-fg-3"
                >
                  {CONCEPT_FILES_LIMIT_HINT}
                </p>
              ) : null}
              <div className={cn('grid gap-2', canUpload ? 'grid-cols-2' : 'grid-cols-1')}>
                <Button
                  size="lg"
                  data-plan-concept-files=""
                  disabled={busy}
                  onClick={() => {
                    if (!atLimit) setAssetsOpen(true);
                  }}
                >
                  Add files
                </Button>
                {canUpload ? (
                  <Button
                    size="lg"
                    data-plan-concept-upload-pick=""
                    disabled={busy}
                    onClick={() => {
                      if (!atLimit) inputRef.current?.click();
                    }}
                  >
                    Upload
                  </Button>
                ) : null}
              </div>
              {canUpload ? (
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={UPLOAD_ACCEPT}
                  data-plan-concept-upload-input=""
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    controller.add(
                      picked.slice(0, conceptFilesRoom(form.files.length, uploads.length)),
                    );
                  }}
                />
              ) : null}
            </>
          )}
          {props.range !== undefined ? (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-fg-3">Day</span>
              <PlanDayTiles
                range={props.range}
                selected={conceptTileDay(form.date, props.range)}
                today={props.today ?? ''}
                disabled={busy}
                onPick={(day) => onChange((f) => ({ ...f, date: day === 'none' ? '' : day }))}
                {...(props.dayCounts !== undefined ? { counts: props.dayCounts } : {})}
              />
            </div>
          ) : null}
        </div>
      </Sheet>

      <AssetPicker
        open={props.open && assetsOpen}
        onClose={() => setAssetsOpen(false)}
        onConfirm={(picks) => {
          setAssetsOpen(false);
          onChange((f) => {
            const seen = new Set(f.files.map((x) => x.versionId));
            const next = [
              ...f.files,
              ...picks
                .filter((p) => !seen.has(p.versionId))
                .map((p): ConceptFile => ({ versionId: p.versionId, name: p.name })),
            ];
            return { ...f, files: next.slice(0, CONCEPT_FILES_MAX - uploads.length) };
          });
        }}
      />
    </>
  );
}
