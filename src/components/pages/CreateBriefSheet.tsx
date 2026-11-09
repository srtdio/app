import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { WritingBox } from '@/components/ui/WritingBox';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { ComposerSheet } from '@/components/pages/create/ComposerSheet';
import { DatePicker } from '@/components/ui/DatePicker';
import {
  AttachmentsField,
  attachmentVersionIds,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import { supabase } from '@/lib/supabase';
import { errorText } from '@/lib/error-copy';
import { useNewTrace } from '@/lib/trace-context';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { briefCreate, type Client, type Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';

interface CreateBriefSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: (created: BriefCreated) => void;
}

/** What the sheet hands back after a create: the new brief's id. */
export interface BriefCreated {
  briefId: string;
}

/**
 * The New brief form (9 Nov 2026): Title, Objective, Due date, Attachments, in
 * that order. No Brand requirements, no Format, no opening note: one write per
 * create.
 */
interface CreateBriefFormState {
  title: string;
  objective: string;
  targetDate: string;
  attachments: AttachmentItem[];
}

/**
 * The reset-on-open state: every field cleared. Pure so the reset-on-open
 * invariant is unit-tested without a DOM.
 */
export function initialBriefState(): CreateBriefFormState {
  return {
    title: '',
    objective: '',
    targetDate: '',
    attachments: [],
  };
}

export interface BuildBriefPayloadInput {
  title: string;
  objective: string;
  targetDate: string;
  versionIds: readonly string[];
}

/**
 * Validate title + objective inline (both required; no runtime schema is exported
 * for briefs) and shape the snake_case jsonb payload brief_create reads. Optional
 * keys are included only when supplied; format_requested and brand_requirements
 * are never sent (the sheet no longer asks for them; brief_create is unchanged).
 * No created_by / actor id is ever sent: the proc derives the actor from
 * auth.uid() server-side. Pure so it unit-tests without a DOM.
 */
export function buildBriefCreatePayload(
  input: BuildBriefPayloadInput,
): { ok: true; payload: Json } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (input.title.trim() === '') errors.title = 'Title is required.';
  if (input.objective.trim() === '') errors.objective = 'Objective is required.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const payload: Record<string, Json> = {
    title: input.title.trim(),
    objective: input.objective.trim(),
  };
  if (input.targetDate !== '') payload.target_date = input.targetDate;
  if (input.versionIds.length > 0) {
    payload.attachment_asset_version_ids = [...input.versionIds];
  }
  return { ok: true, payload: payload as Json };
}

export interface SubmitCreateBriefDeps {
  client: Client;
  workspaceId: string;
  payload: Json;
  newTrace: () => string;
  briefCreate: (
    client: Client,
    args: { p_workspace_id: string; p_payload: Json; p_trace_id: string },
  ) => Promise<Result<string>>;
}

/**
 * Create the brief via brief_create: the one write. A failure surfaces as plain
 * copy (never the server's text). Never throws.
 */
export async function submitCreateBrief(
  deps: SubmitCreateBriefDeps,
): Promise<{ ok: true; briefId: string } | { ok: false; message: string }> {
  const created = await deps.briefCreate(deps.client, {
    p_workspace_id: deps.workspaceId,
    p_payload: deps.payload,
    p_trace_id: deps.newTrace(),
  });
  // Plain copy only: the server's own text never reaches the sheet.
  if (!created.ok) return { ok: false, message: errorText('create the brief', created.error) };
  return { ok: true, briefId: created.data };
}

/** "1 file" / "3 files". */
function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * Whether the sheet holds anything a close would lose: any typed field, a
 * picked date, a completed attachment, or an upload in flight or
 * failed. Drives the Sheet's discard confirm (X, backdrop, Escape, Back). Pure.
 */
function isBriefFormDirty(
  form: CreateBriefFormState,
  pendingUploads: number,
  failedUploads: number,
): boolean {
  const typed = [form.title, form.objective].some((value) => value.trim() !== '');
  return (
    typed ||
    form.targetDate !== '' ||
    form.attachments.length > 0 ||
    pendingUploads > 0 ||
    failedUploads > 0
  );
}

/**
 * Whether Create may send now. Uploads still running: wait (the button stays
 * enabled and says so). A failed upload: blocked until it is removed or
 * retried. Pure.
 */
function briefUploadGate(
  pendingUploads: number,
  failedUploads: number,
): { ok: true } | { ok: false; message: string } {
  if (pendingUploads > 0)
    return { ok: false, message: `Wait for ${fileCount(pendingUploads)} to finish` };
  if (failedUploads > 0) return { ok: false, message: 'Remove or retry the failed file' };
  return { ok: true };
}

/** The sheet's first field, focused on open (phone and laptop). */
function briefTitleInput(): HTMLElement | null {
  return document.getElementById('brief-title');
}

/** The brief fields that can carry a line after Create. */
type BriefErrorField = 'title' | 'objective';

/** The field's control id. */
function briefFieldId(key: BriefErrorField): string {
  return `brief-${key}`;
}

/** The id of the field's error line (the control's aria-describedby). */
export function briefErrorId(key: BriefErrorField): string {
  return `brief-${key}-error`;
}

/** The first field with an error in screen order (Title, then Objective), or null. Pure. */
export function firstBriefErrorField(errors: Record<string, string>): BriefErrorField | null {
  if (errors.title !== undefined) return 'title';
  if (errors.objective !== undefined) return 'objective';
  return null;
}

/** The Create button's label: uploading, or ready (in flight is Button busy). Pure. */
function createBriefLabel(pendingUploads: number): string {
  if (pendingUploads > 0) return `Uploading ${fileCount(pendingUploads)}…`;
  return 'Create brief';
}

// A failed AttachmentsField row is the only one with a Dismiss button; the field
// reports pending uploads but not failures, so the sheet counts those rows.
const FAILED_ROW_SELECTOR = 'button[aria-label^="Dismiss "]';

/** Live count of failed upload rows under `root` (0 while it is unmounted). */
function useFailedUploadCount(root: HTMLElement | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (root === null) {
      setCount(0);
      return;
    }
    const read = (): void => setCount(root.querySelectorAll(FAILED_ROW_SELECTOR).length);
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
  return count;
}

export function CreateBriefSheet({ open, workspaceId, onClose, onCreated }: CreateBriefSheetProps) {
  const newTrace = useNewTrace();
  const [form, setForm] = useState<CreateBriefFormState>(() => initialBriefState());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [attachmentsRoot, setAttachmentsRoot] = useState<HTMLDivElement | null>(null);
  const failedUploads = useFailedUploadCount(attachmentsRoot);
  const attachmentsRef = useCallback((node: HTMLDivElement | null) => setAttachmentsRoot(node), []);
  // The writing boxes' fields (ui/WritingBox acts on them: Aa row, emoji).
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);

  function patch(next: Partial<CreateBriefFormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  // Reset the form each time the sheet opens so a prior draft never lingers,
  // including the attachments list.
  useEffect(() => {
    if (!open) return;
    mark('brief:create:open');
    setForm(initialBriefState());
    setFieldErrors({});
    setSubmitError(null);
    setUploadNotice(null);
    setSubmitting(false);
    setPendingUploads(0);
  }, [open]);

  // The upload notice answers a tap; it goes once the uploads settle.
  useEffect(() => {
    if (uploadNotice !== null && briefUploadGate(pendingUploads, failedUploads).ok) {
      setUploadNotice(null);
    }
  }, [uploadNotice, pendingUploads, failedUploads]);

  const dirty = isBriefFormDirty(form, pendingUploads, failedUploads);

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null || submitting) return;

    const built = buildBriefCreatePayload({
      title: form.title,
      objective: form.objective,
      targetDate: form.targetDate,
      versionIds: attachmentVersionIds(form.attachments),
    });
    if (!built.ok) {
      setFieldErrors(built.errors);
      // The first field with a line takes focus (Title, then Objective), the
      // way New post does it.
      const first = firstBriefErrorField(built.errors);
      if (first !== null) document.getElementById(briefFieldId(first))?.focus();
      return;
    }
    setFieldErrors({});

    const gate = briefUploadGate(pendingUploads, failedUploads);
    if (!gate.ok) {
      setUploadNotice(gate.message);
      return;
    }
    setUploadNotice(null);
    setSubmitting(true);
    setSubmitError(null);

    mark('brief:create:submit');
    const result = await submitCreateBrief({
      client: supabase,
      workspaceId,
      payload: built.payload,
      newTrace,
      briefCreate,
    });

    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.message);
      return;
    }
    onCreated({ briefId: result.briefId });
  }

  function fieldError(key: BriefErrorField): ReactElement | null {
    return fieldErrors[key] !== undefined ? (
      <ErrorNote className="mt-2">
        <span id={briefErrorId(key)}>{fieldErrors[key]}</span>
      </ErrorNote>
    ) : null;
  }

  /** aria-invalid plus aria-describedby to the field's line while it shows. */
  function fieldErrorProps(key: BriefErrorField): {
    'aria-invalid': boolean;
    'aria-describedby'?: string;
  } {
    return fieldErrors[key] !== undefined
      ? { 'aria-invalid': true, 'aria-describedby': briefErrorId(key) }
      : { 'aria-invalid': false };
  }

  // Create sits in the header like New post (ComposerSheet): no footer, and
  // the X is the way out (it asks first while the sheet holds a change).
  const headerActions = (
    <Button
      variant="primary"
      className="shrink-0"
      data-induction={INDUCTION_KEYS.briefSheetCreate}
      onClick={() => void handleSubmit()}
      busy={submitting}
    >
      {createBriefLabel(pendingUploads)}
    </Button>
  );

  return (
    <ComposerSheet
      open={open}
      onClose={onClose}
      title="New brief"
      actions={headerActions}
      dirty={dirty}
      discard={{ title: 'Discard this brief?', message: 'Your brief and files will be lost.' }}
      busy={submitting}
      wide={false}
      initialFocus={briefTitleInput}
    >
      <div className="flex flex-col gap-4 overflow-x-hidden">
        <Field label="Title" htmlFor="brief-title" required>
          <Input
            id="brief-title"
            data-induction={INDUCTION_KEYS.briefSheetTitle}
            value={form.title}
            {...fieldErrorProps('title')}
            enterKeyHint="next"
            onChange={(event) => patch({ title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                document.getElementById('brief-objective')?.focus();
              }
            }}
            placeholder="Brief title"
          />
          {fieldError('title')}
        </Field>

        <Field label="Objective" htmlFor="brief-objective" required>
          <WritingBox
            mode="field"
            field={() => objectiveRef.current}
            hasText={form.objective !== ''}
            expandTitle="Objective"
            input={
              <Textarea
                formatting
                ref={objectiveRef}
                id="brief-objective"
                data-induction={INDUCTION_KEYS.briefSheetObjective}
                autoGrow
                value={form.objective}
                {...fieldErrorProps('objective')}
                onChange={(event) => patch({ objective: event.target.value })}
                placeholder="What should this brief achieve?"
              />
            }
          />
          {fieldError('objective')}
        </Field>

        <Field label="Due date">
          {(id) => (
            <DatePicker
              id={id}
              label="Due date"
              value={form.targetDate}
              onChange={(value) => patch({ targetDate: value })}
            />
          )}
        </Field>

        <Field label="Attachments">
          <div ref={attachmentsRef}>
            <AttachmentsField
              workspaceId={workspaceId}
              value={form.attachments}
              onChange={(attachments) => patch({ attachments })}
              onPendingChange={setPendingUploads}
            />
          </div>
          {uploadNotice !== null ? (
            // Waiting on uploads is not an error: neutral text. A failed file
            // still reads in the error colour.
            <p
              role="status"
              className={`mt-2 text-sm ${pendingUploads > 0 ? 'text-fg-3' : 'text-bad'}`}
            >
              {uploadNotice}
            </p>
          ) : null}
        </Field>

        {submitError !== null ? <ErrorNote>{submitError}</ErrorNote> : null}
      </div>
    </ComposerSheet>
  );
}
