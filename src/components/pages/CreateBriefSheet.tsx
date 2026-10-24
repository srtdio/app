import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Select, type SelectOption } from '@/components/ui/Select';
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
import { useWorkspacePlatform } from '@/lib/workspace-context-platform';
import { briefCreate, type Client, type Result } from '@srtdio/rpc';
import { FORMATS_BY_PLATFORM, formatLabel, type PostPlatform } from '@srtdio/posts';
import { createComment, type CreateCommentInput, type CommentResult } from '@srtdio/comments';
import type { Json } from '@srtdio/schemas';

interface CreateBriefSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: (created: BriefCreated) => void;
}

/** What the sheet hands back after a create: the new id, and whether the note failed to post. */
export interface BriefCreated {
  briefId: string;
  noteFailed: boolean;
}

// 'Any' is the absence of a format requirement: when selected, format_requested
// is omitted from the payload rather than sent. It is not a POST_FORMATS value.
const FORMAT_ANY = '';

/**
 * The formats a brief may request on the workspace's platform. Briefs request a
 * deliverable format but never a 'link': a link is an asset, not a post the
 * agency produces, so it is dropped from the choices here.
 */
export function briefFormatsFor(platform: PostPlatform): string[] {
  return FORMATS_BY_PLATFORM[platform].filter((value) => value !== 'link');
}

/** The brief sheet's Format options: Any, then the platform's brief formats. */
export function briefFormatOptions(platform: PostPlatform | null): SelectOption[] {
  return [
    { value: FORMAT_ANY, label: 'Any' },
    ...(platform !== null
      ? briefFormatsFor(platform).map((value) => ({ value, label: formatLabel(platform, value) }))
      : []),
  ];
}

/** The reset-on-open form state: every field cleared, format defaulted to Any. */
export interface CreateBriefFormState {
  title: string;
  objective: string;
  brandRequirements: string;
  format: string;
  targetDate: string;
  initialComment: string;
  attachments: AttachmentItem[];
}

/**
 * The reset-on-open state: every field cleared and the format defaulted to Any.
 * Pure so the reset-on-open invariant is unit-tested without a DOM.
 */
export function initialBriefState(): CreateBriefFormState {
  return {
    title: '',
    objective: '',
    brandRequirements: '',
    format: FORMAT_ANY,
    targetDate: '',
    initialComment: '',
    attachments: [],
  };
}

export interface BuildBriefPayloadInput {
  title: string;
  objective: string;
  /** Optional; sent as brand_requirements only when it has text. */
  brandRequirements?: string;
  format: string;
  targetDate: string;
  versionIds: readonly string[];
}

/**
 * Validate title + objective inline (both required; no runtime schema is exported
 * for briefs) and shape the snake_case jsonb payload brief_create reads. Optional
 * keys are included only when supplied; format_requested is sent only for a real
 * format, never for Any. No created_by / actor id is ever sent: the proc derives
 * the actor from auth.uid() server-side. Pure so it unit-tests without a DOM.
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
  const brand = (input.brandRequirements ?? '').trim();
  if (brand !== '') payload.brand_requirements = brand;
  if (input.format !== FORMAT_ANY) payload.format_requested = input.format;
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
  /** The trimmed-or-not opening note; seeded only when it is non-empty. */
  initialComment: string;
  newTrace: () => string;
  briefCreate: (
    client: Client,
    args: { p_workspace_id: string; p_payload: Json; p_trace_id: string },
  ) => Promise<Result<string>>;
  createComment: (client: Client, input: CreateCommentInput) => Promise<CommentResult<string>>;
}

/**
 * Create the brief via brief_create, then (only when an opening note was entered)
 * seed the brief's discussion thread with one comment. brief_create is the success
 * gate: a failure there surfaces and stops. The seed comment is best-effort: once
 * the brief exists the create has succeeded regardless of the comment's outcome,
 * and a rare lost seed comment is recoverable by commenting on the brief. Never
 * throws.
 */
export async function submitCreateBrief(
  deps: SubmitCreateBriefDeps,
): Promise<{ ok: true; briefId: string; noteFailed: boolean } | { ok: false; message: string }> {
  const created = await deps.briefCreate(deps.client, {
    p_workspace_id: deps.workspaceId,
    p_payload: deps.payload,
    p_trace_id: deps.newTrace(),
  });
  // Plain copy only: the server's own text never reaches the sheet.
  if (!created.ok) return { ok: false, message: errorText('create the brief', created.error) };

  const comment = deps.initialComment.trim();
  let noteFailed = false;
  if (comment !== '') {
    // Best-effort: do not re-create the brief and do not block on a failure here.
    // The caller tells the writer the note didn't post so they can add it.
    const posted = await deps.createComment(deps.client, {
      workspace_id: deps.workspaceId,
      entity_type: 'brief',
      entity_id: created.data,
      body: comment,
      trace_id: deps.newTrace(),
    });
    noteFailed = !posted.ok;
  }
  return { ok: true, briefId: created.data, noteFailed };
}

/** "1 file" / "3 files". */
function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * Whether the sheet holds anything a close would lose: any typed field, a
 * picked format or date, a completed attachment, or an upload in flight or
 * failed. Drives the Sheet's discard confirm (X, backdrop, Escape, Back). Pure.
 */
export function isBriefFormDirty(
  form: CreateBriefFormState,
  pendingUploads: number,
  failedUploads: number,
): boolean {
  const typed = [form.title, form.objective, form.brandRequirements, form.initialComment].some(
    (value) => value.trim() !== '',
  );
  return (
    typed ||
    form.format !== FORMAT_ANY ||
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
export function briefUploadGate(
  pendingUploads: number,
  failedUploads: number,
): { ok: true } | { ok: false; message: string } {
  if (pendingUploads > 0)
    return { ok: false, message: `Wait for ${fileCount(pendingUploads)} to finish` };
  if (failedUploads > 0) return { ok: false, message: 'Remove or retry the failed file' };
  return { ok: true };
}

/** The Create button's label: in flight, uploading, or ready. Pure. */
export function createBriefLabel(submitting: boolean, pendingUploads: number): string {
  if (submitting) return 'Creating…';
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
  const workspacePlatform = useWorkspacePlatform(open ? workspaceId : null);
  const [form, setForm] = useState<CreateBriefFormState>(() => initialBriefState());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [attachmentsRoot, setAttachmentsRoot] = useState<HTMLDivElement | null>(null);
  const failedUploads = useFailedUploadCount(attachmentsRoot);
  const attachmentsRef = useCallback((node: HTMLDivElement | null) => setAttachmentsRoot(node), []);

  function patch(next: Partial<CreateBriefFormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  // Reset the form each time the sheet opens so a prior draft never lingers,
  // including the attachments list and the note.
  useEffect(() => {
    if (!open) return;
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

  // The Title takes focus once the sheet has settled its own focus, on phone
  // and laptop alike, so typing can start at once.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(() => document.getElementById('brief-title')?.focus());
    }, 0);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const dirty = isBriefFormDirty(form, pendingUploads, failedUploads);
  const formatOptions = briefFormatOptions(workspacePlatform);

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null || submitting) return;

    const built = buildBriefCreatePayload({
      title: form.title,
      objective: form.objective,
      brandRequirements: form.brandRequirements,
      format: form.format,
      targetDate: form.targetDate,
      versionIds: attachmentVersionIds(form.attachments),
    });
    if (!built.ok) {
      setFieldErrors(built.errors);
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

    const result = await submitCreateBrief({
      client: supabase,
      workspaceId,
      payload: built.payload,
      initialComment: form.initialComment,
      newTrace,
      briefCreate,
      createComment,
    });

    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.message);
      return;
    }
    onCreated({ briefId: result.briefId, noteFailed: result.noteFailed });
  }

  function fieldError(key: string): ReactElement | null {
    return fieldErrors[key] !== undefined ? (
      <p className="mt-1.5 text-xs text-bad">{fieldErrors[key]}</p>
    ) : null;
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New brief"
      dirty={dirty}
      discard={{ title: 'Discard this brief?', message: 'Your brief and files will be lost.' }}
      busy={submitting}
      busyLabel="Creating…"
      footer={
        <>
          <Button
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <span className="ml-auto">
            <Button
              variant="primary"
              data-induction={INDUCTION_KEYS.briefSheetCreate}
              onClick={() => void handleSubmit()}
              disabled={submitting}
              aria-busy={submitting}
            >
              {createBriefLabel(submitting, pendingUploads)}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4 overflow-x-hidden">
        <Field label="Title" htmlFor="brief-title" required>
          <Input
            id="brief-title"
            data-induction={INDUCTION_KEYS.briefSheetTitle}
            value={form.title}
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
          <Textarea
            id="brief-objective"
            data-induction={INDUCTION_KEYS.briefSheetObjective}
            autoGrow
            value={form.objective}
            onChange={(event) => patch({ objective: event.target.value })}
            placeholder="What should this brief achieve?"
          />
          {fieldError('objective')}
        </Field>

        <Field label="Brand requirements (optional)" htmlFor="brief-brand-requirements">
          <Textarea
            id="brief-brand-requirements"
            autoGrow
            value={form.brandRequirements}
            onChange={(event) => patch({ brandRequirements: event.target.value })}
            placeholder="Colors, tone, logo use, words to avoid"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <Field label="Format (optional)">
              <Select
                label="Format"
                value={form.format}
                options={formatOptions}
                onChange={(value) => patch({ format: value })}
              />
            </Field>
          </div>

          <div className="min-w-0">
            <Field label="Due date (optional)">
              <DatePicker
                label="Due date"
                value={form.targetDate}
                onChange={(value) => patch({ targetDate: value })}
              />
            </Field>
          </div>
        </div>

        <Field label="Attachments (optional)">
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
              className={`mt-1.5 text-xs ${pendingUploads > 0 ? 'text-fg-3' : 'text-bad'}`}
            >
              {uploadNotice}
            </p>
          ) : null}
        </Field>

        <Field label="Note to the agency (optional)" htmlFor="brief-initial-comment">
          <Textarea
            id="brief-initial-comment"
            autoGrow
            value={form.initialComment}
            onChange={(event) => patch({ initialComment: event.target.value })}
            placeholder="Anything the agency should know first"
          />
        </Field>

        {submitError !== null ? (
          <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
            {submitError}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
