import { useEffect, useState } from 'react';
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
import { useNewTrace } from '@/lib/trace-context';
import { briefCreate, type Client, type Result } from '@srtdio/rpc';
import { POST_FORMATS } from '@srtdio/posts';
import { createComment, type CreateCommentInput, type CommentResult } from '@srtdio/comments';
import type { Json } from '@srtdio/schemas';

interface CreateBriefSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Title-case a snake_case enum value for display (single_image -> Single Image). */
function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// 'Any' is the absence of a format requirement: when selected, format_requested
// is omitted from the payload rather than sent. It is not a POST_FORMATS value.
const FORMAT_ANY = '';

// Briefs request a deliverable format but never a 'link': a link is an asset, not
// a post the agency produces, so it is dropped from the choices here.
const BRIEF_FORMATS = POST_FORMATS.filter((value) => value !== 'link');

/** The reset-on-open form state: every field cleared, format defaulted to Any. */
export interface CreateBriefFormState {
  title: string;
  objective: string;
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
    format: FORMAT_ANY,
    targetDate: '',
    initialComment: '',
    attachments: [],
  };
}

export interface BuildBriefPayloadInput {
  title: string;
  objective: string;
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
): Promise<{ ok: true; briefId: string } | { ok: false; message: string }> {
  const created = await deps.briefCreate(deps.client, {
    p_workspace_id: deps.workspaceId,
    p_payload: deps.payload,
    p_trace_id: deps.newTrace(),
  });
  if (!created.ok) return { ok: false, message: created.error.message };

  const comment = deps.initialComment.trim();
  if (comment !== '') {
    // Best-effort: do not re-create the brief and do not block on a failure here.
    await deps.createComment(deps.client, {
      workspace_id: deps.workspaceId,
      entity_type: 'brief',
      entity_id: created.data,
      body: comment,
      trace_id: deps.newTrace(),
    });
  }
  return { ok: true, briefId: created.data };
}

export function CreateBriefSheet({ open, workspaceId, onClose, onCreated }: CreateBriefSheetProps) {
  const newTrace = useNewTrace();
  const [form, setForm] = useState<CreateBriefFormState>(() => initialBriefState());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function patch(next: Partial<CreateBriefFormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  // Reset the form each time the sheet opens so a prior draft never lingers,
  // including the attachments list and the initial comment.
  useEffect(() => {
    if (!open) return;
    setForm(initialBriefState());
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  const canSubmit =
    workspaceId !== null && form.title.trim() !== '' && form.objective.trim() !== '' && !submitting;

  const formatOptions: SelectOption[] = [
    { value: FORMAT_ANY, label: 'Any' },
    ...BRIEF_FORMATS.map((value) => ({ value, label: humanize(value) })),
  ];

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null) return;

    const built = buildBriefCreatePayload({
      title: form.title,
      objective: form.objective,
      format: form.format,
      targetDate: form.targetDate,
      versionIds: attachmentVersionIds(form.attachments),
    });
    if (!built.ok) {
      setFieldErrors(built.errors);
      return;
    }

    setFieldErrors({});
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
    onCreated();
  }

  function fieldError(key: string): ReactElement | null {
    return fieldErrors[key] !== undefined ? (
      <p className="mt-1.5 text-[11px] text-bad">{fieldErrors[key]}</p>
    ) : null;
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New brief"
      footer={
        <>
          <Button size="lg" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <span className="ml-auto">
            <Button
              variant="primary"
              size="lg"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {submitting ? 'Creating' : 'Create brief'}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4 overflow-x-hidden">
        <p className="text-xs text-fg-3">
          Briefs are written by clients and are read-only once created.
        </p>

        <Field label="Title" htmlFor="brief-title" required>
          <Input
            id="brief-title"
            value={form.title}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder="Brief title"
          />
          {fieldError('title')}
        </Field>

        <Field label="Objective" htmlFor="brief-objective" required>
          <Textarea
            id="brief-objective"
            value={form.objective}
            onChange={(event) => patch({ objective: event.target.value })}
            placeholder="What should this brief achieve?"
          />
          {fieldError('objective')}
        </Field>

        <Field label="Attachments">
          <AttachmentsField
            workspaceId={workspaceId}
            value={form.attachments}
            onChange={(attachments) => patch({ attachments })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <Field label="Format requested">
              <Select
                label="Format requested"
                value={form.format}
                options={formatOptions}
                onChange={(value) => patch({ format: value })}
              />
            </Field>
          </div>

          <div className="min-w-0">
            <Field label="Target date">
              <DatePicker
                label="Target date"
                value={form.targetDate}
                onChange={(value) => patch({ targetDate: value })}
              />
            </Field>
          </div>
        </div>

        <Field label="Initial comment" htmlFor="brief-initial-comment">
          <Textarea
            id="brief-initial-comment"
            value={form.initialComment}
            onChange={(event) => patch({ initialComment: event.target.value })}
            placeholder="Add an opening note for the agency"
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
