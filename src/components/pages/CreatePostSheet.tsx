import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Select, type SelectOption } from '@/components/ui/Select';
import { DatePicker } from '@/components/ui/DatePicker';
import {
  AttachmentsField,
  attachmentVersionIds,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { listBuckets, type BucketOption } from '@/lib/buckets';
import { usePostMembers } from '@/components/pages/pcs/use-post-members';
import { postCreate, gallerySet, type Client, type Result } from '@srtdio/rpc';
import { POST_FORMATS, POST_PLATFORMS, PostCreatePayloadSchema } from '@srtdio/posts';
import { listBriefs, type BriefWithThumbnail } from '@srtdio/briefs';
import type { Json } from '@srtdio/schemas';

interface CreatePostSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Title-case a snake_case enum value for display (e.g. single_image -> Single Image). */
function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const DEFAULT_FORMAT = POST_FORMATS[0];

type OriginValue = 'none' | 'brief';

export interface CreateFormState {
  title: string;
  caption: string;
  platform: string;
  format: string;
  ownerUserId: string;
  bucketId: string;
  targetDate: string;
  origin: OriginValue;
  briefId: string;
  attachments: AttachmentItem[];
}

/**
 * The reset-on-open state: every field cleared, the format defaulted to the
 * first value and the owner defaulted to the current user. Pure so the
 * reset-on-open invariant is unit-tested without a DOM.
 */
export function initialCreateState(opts: {
  defaultFormat: string;
  currentUserId: string | null;
}): CreateFormState {
  return {
    title: '',
    caption: '',
    platform: '',
    format: opts.defaultFormat,
    ownerUserId: opts.currentUserId ?? '',
    bucketId: '',
    targetDate: '',
    origin: 'none',
    briefId: '',
    attachments: [],
  };
}

export interface BuildPayloadInput {
  title: string;
  caption: string;
  platform: string;
  format: string;
  ownerUserId: string;
  bucketId: string;
  targetDate: string;
  origin: OriginValue;
  briefId: string;
}

/**
 * Validate the named fields with PostCreatePayloadSchema (plus the brief_id
 * requirement when origin is a brief) and shape the snake_case jsonb payload the
 * post_create proc reads. Owner, bucket, origin + brief and target date are
 * included only when set. Pure so it unit-tests without a DOM or network.
 */
export function buildPostCreatePayload(
  input: BuildPayloadInput,
): { ok: true; payload: Json } | { ok: false; errors: Record<string, string> } {
  const candidate = {
    title: input.title.trim(),
    caption: input.caption.trim(),
    platform: input.platform,
    format: input.format,
    ...(input.ownerUserId !== '' ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.bucketId !== '' ? { bucketId: input.bucketId } : {}),
    ...(input.targetDate !== '' ? { targetDate: input.targetDate } : {}),
    ...(input.origin === 'brief'
      ? { origin: 'brief' as const, ...(input.briefId !== '' ? { briefId: input.briefId } : {}) }
      : {}),
  };

  const parsed = PostCreatePayloadSchema.safeParse(candidate);
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      if (errors[key] === undefined) errors[key] = issue.message;
    }
  }
  // brief_id is required when the post originates from a brief; the proc would
  // reject otherwise, so block it client-side with a friendly message.
  if (input.origin === 'brief' && input.briefId === '') {
    errors.briefId = 'Choose a brief';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const data = parsed.success ? parsed.data : null;
  if (data === null) return { ok: false, errors: { form: 'Invalid form' } };

  const payload: Record<string, Json> = {
    title: data.title,
    caption: data.caption ?? '',
    platform: data.platform,
    format: data.format ?? input.format,
  };
  if (data.ownerUserId !== undefined) payload.owner_user_id = data.ownerUserId;
  if (data.bucketId !== undefined) payload.bucket_id = data.bucketId;
  if (data.targetDate !== undefined) payload.target_date = data.targetDate;
  if (data.origin !== undefined) payload.origin = data.origin;
  if (data.briefId !== undefined) payload.brief_id = data.briefId;
  return { ok: true, payload: payload as Json };
}

export interface SubmitCreatePostDeps {
  client: Client;
  workspaceId: string;
  payload: Json;
  versionIds: readonly string[];
  newTrace: () => string;
  postCreate: (
    client: Client,
    args: { p_workspace_id: string; p_payload: Json; p_trace_id: string },
  ) => Promise<Result<string>>;
  gallerySet: (
    client: Client,
    args: { p_post_id: string; p_asset_version_ids: string[]; p_trace_id: string },
  ) => Promise<Result<string>>;
}

/**
 * Create the post via post_create, then (only when there are completed
 * attachments) bind them in order via gallery_set. post_create takes no gallery,
 * so the second call is how attachments attach. Surfaces the first failing call's
 * message; never throws.
 */
export async function submitCreatePost(
  deps: SubmitCreatePostDeps,
): Promise<{ ok: true; postId: string } | { ok: false; message: string }> {
  const created = await deps.postCreate(deps.client, {
    p_workspace_id: deps.workspaceId,
    p_payload: deps.payload,
    p_trace_id: deps.newTrace(),
  });
  if (!created.ok) return { ok: false, message: created.error.message };

  if (deps.versionIds.length > 0) {
    const gallery = await deps.gallerySet(deps.client, {
      p_post_id: created.data,
      p_asset_version_ids: [...deps.versionIds],
      p_trace_id: deps.newTrace(),
    });
    if (!gallery.ok) return { ok: false, message: gallery.error.message };
  }
  return { ok: true, postId: created.data };
}

export function CreatePostSheet({ open, workspaceId, onClose, onCreated }: CreatePostSheetProps) {
  const newTrace = useNewTrace();
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;
  const { options: memberOptions } = usePostMembers(open ? workspaceId : null);

  const [form, setForm] = useState<CreateFormState>(() =>
    initialCreateState({ defaultFormat: DEFAULT_FORMAT, currentUserId }),
  );
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [briefs, setBriefs] = useState<BriefWithThumbnail[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function patch(next: Partial<CreateFormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  // Reset the form each time the sheet opens so a prior draft never lingers. The
  // owner is left empty here and defaulted to the current user by the effect
  // below, so the reset never depends on the (possibly still-resolving) session.
  useEffect(() => {
    if (!open) return;
    setForm(initialCreateState({ defaultFormat: DEFAULT_FORMAT, currentUserId: null }));
    setBuckets([]);
    setBriefs([]);
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  // Default the owner to the current user once the session resolves while open.
  useEffect(() => {
    if (open && currentUserId !== null) {
      setForm((prev) => (prev.ownerUserId === '' ? { ...prev, ownerUserId: currentUserId } : prev));
    }
  }, [open, currentUserId]);

  // Load buckets and the workspace's briefs (reusing the existing reads). Briefs
  // are scoped to the active workspace client-side, as the Briefs page does.
  useEffect(() => {
    if (!open || workspaceId === null) return;
    let cancelled = false;
    void listBuckets(supabase, workspaceId).then((res) => {
      if (!cancelled && res.ok) setBuckets(res.data);
    });
    void listBriefs(supabase).then((res) => {
      if (!cancelled && res.ok) {
        setBriefs(res.data.filter((brief) => brief.workspace_id === workspaceId));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const platformOptions: SelectOption[] = POST_PLATFORMS.map((value) => ({
    value,
    label: humanize(value),
  }));
  const formatOptions: SelectOption[] = POST_FORMATS.map((value) => ({
    value,
    label: humanize(value),
  }));
  const bucketOptions: SelectOption[] = [
    { value: '', label: 'No bucket' },
    ...buckets.map((bucket) => ({
      value: bucket.id,
      label: bucket.name,
      renderLeft: (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: bucket.colorHex }}
          aria-hidden="true"
        />
      ),
    })),
  ];
  const ownerOptions: SelectOption[] = memberOptions.map((member) => ({
    value: member.userId,
    label: member.displayName,
    renderLeft: (
      <Avatar
        name={member.displayName}
        {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
        size="sm"
      />
    ),
  }));
  const originOptions: SelectOption[] = [
    { value: 'none', label: 'None' },
    { value: 'brief', label: 'From a brief' },
  ];
  const briefOptions: SelectOption[] = briefs.map((brief) => ({
    value: brief.id,
    label: brief.title,
  }));

  const canSubmit =
    workspaceId !== null &&
    form.title.trim() !== '' &&
    form.caption.trim() !== '' &&
    form.platform !== '' &&
    (form.origin !== 'brief' || form.briefId !== '') &&
    !submitting;

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null) return;

    const built = buildPostCreatePayload({
      title: form.title,
      caption: form.caption,
      platform: form.platform,
      format: form.format,
      ownerUserId: form.ownerUserId,
      bucketId: form.bucketId,
      targetDate: form.targetDate,
      origin: form.origin,
      briefId: form.briefId,
    });
    if (!built.ok) {
      setFieldErrors(built.errors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setSubmitError(null);

    const result = await submitCreatePost({
      client: supabase,
      workspaceId,
      payload: built.payload,
      versionIds: attachmentVersionIds(form.attachments),
      newTrace,
      postCreate,
      gallerySet,
    });

    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.message);
      return;
    }
    onCreated();
  }

  function gridError(key: string): ReactElement | null {
    return fieldErrors[key] !== undefined ? (
      <p className="mt-1.5 text-[11px] text-bad">{fieldErrors[key]}</p>
    ) : null;
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New post"
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
              {submitting ? 'Creating' : 'Save as draft'}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4 overflow-x-hidden">
        <Field label="Title" htmlFor="post-title" required>
          <Input
            id="post-title"
            value={form.title}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder="Post title"
          />
          {gridError('title')}
        </Field>

        <Field label="Caption" htmlFor="post-caption" required>
          <Textarea
            id="post-caption"
            value={form.caption}
            onChange={(event) => patch({ caption: event.target.value })}
            placeholder="Write the caption"
          />
          {gridError('caption')}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <Field label="Platform" required>
              <Select
                label="Platform"
                value={form.platform}
                options={platformOptions}
                onChange={(value) => patch({ platform: value })}
                placeholder="Choose a platform"
              />
              {gridError('platform')}
            </Field>
          </div>

          <div className="min-w-0">
            <Field label="Format">
              <Select
                label="Format"
                value={form.format}
                options={formatOptions}
                onChange={(value) => patch({ format: value })}
              />
            </Field>
          </div>

          <div className="min-w-0">
            <Field label="Bucket">
              <Select
                label="Bucket"
                value={form.bucketId}
                options={bucketOptions}
                onChange={(value) => patch({ bucketId: value })}
                placeholder="No bucket"
              />
            </Field>
          </div>

          <div className="min-w-0">
            <Field label="Owner">
              <Select
                label="Owner"
                value={form.ownerUserId}
                options={ownerOptions}
                onChange={(value) => patch({ ownerUserId: value })}
                placeholder="Choose an owner"
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

          <div className="min-w-0">
            <Field label="Origin">
              <Select
                label="Origin"
                value={form.origin}
                options={originOptions}
                onChange={(value) =>
                  patch({ origin: value as OriginValue, ...(value === 'none' ? { briefId: '' } : {}) })
                }
              />
            </Field>
          </div>

          {form.origin === 'brief' ? (
            <div className="col-span-2 min-w-0">
              <Field label="Brief" required>
                <Select
                  label="Brief"
                  value={form.briefId}
                  options={briefOptions}
                  onChange={(value) => patch({ briefId: value })}
                  placeholder="Choose a brief"
                />
                {gridError('briefId')}
              </Field>
            </div>
          ) : null}
        </div>

        <Field label="Attachments">
          <AttachmentsField
            workspaceId={workspaceId}
            value={form.attachments}
            onChange={(attachments) => patch({ attachments })}
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
