import { useEffect, useRef, useState } from 'react';
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
  isMediaItem,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import {
  PlatformPreviewPanel,
  PreviewBody,
  PreviewChip,
  previewChipLabel,
  type PreviewBodyProps,
} from '@/components/preview/PlatformPreviewPanel';
import { FilePromptSheet } from '@/components/pages/create/FilePromptSheet';
import { fileKindOf, filePrompt, mismatchedFiles } from '@/components/pages/create/file-kind';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useWorkspacePlatform } from '@/lib/workspace-context-platform';
import { useWorkspace } from '@/lib/workspace-context';
import { listBuckets, type BucketOption } from '@/lib/buckets';
import { usePostMembers } from '@/components/pages/pcs/use-post-members';
import { postCreate, gallerySet, stageTransition, type Client, type Result } from '@srtdio/rpc';
import { PresetMediaField } from '@/components/induction/PresetMediaField';
import {
  dispatchInductionRefresh,
  formatNeedsMedia,
  INDUCTION_KEYS,
  titleFromCaption,
  type PostSheetPreset,
} from '@/lib/induction';
import { logger } from '@/lib/logger';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { sharePostToChannel } from '@/lib/chat/share-post';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { cn } from '@/lib/cn';
import {
  FORMATS_BY_PLATFORM,
  PostCreatePayloadSchema,
  formatLabel,
  platformLabel,
  type GalleryItem,
  type PostPlatform,
} from '@srtdio/posts';
import { listBriefs, type BriefWithThumbnail } from '@srtdio/briefs';
import type { Json } from '@srtdio/schemas';

interface CreatePostSheetProps {
  open: boolean;
  workspaceId: string | null;
  /** Seeds the target date when the sheet opens ('YYYY-MM-DD'); default blank. */
  initialTargetDate?: string;
  onClose: () => void;
  /** Called with the new post's id once it (and its attachments) saved. */
  onCreated: (postId: string) => void;
  /**
   * An induction post step: owner, bucket, origin and brief stay out, the title
   * comes from the caption, media is required when the format needs it, and the
   * primary is Send for review or Save as draft. Absent: the full sheet.
   */
  preset?: PostSheetPreset;
}

/** The post saved but the move to review did not land: retry the move, never re-create. */
export const REVIEW_RETRY_MESSAGE =
  "Your post is saved, but it didn't reach review. Try sending it again.";

/** The preset's primary button label. */
export function presetPrimaryLabel(input: {
  preset: PostSheetPreset;
  submitting: boolean;
  savedDraft: boolean;
}): string {
  if (input.preset.primary === 'save_draft') return input.submitting ? 'Saving' : 'Save as draft';
  if (input.submitting) return 'Sending';
  return input.savedDraft ? 'Send for review again' : 'Send for review';
}

/** Whether the preset sheet may submit: a caption, a format, and media when the format needs it. */
export function presetCanSubmit(input: {
  caption: string;
  format: string;
  attachments: number;
  busy: boolean;
}): boolean {
  if (input.busy || input.caption.trim() === '' || input.format === '') return false;
  return !formatNeedsMedia(input.format) || input.attachments > 0;
}

/**
 * The Format choices for the workspace's platform, in the platform's order and
 * with its own wording (single_image reads "Image" on X and Threads). There is
 * no Platform field: post_create takes the platform from the workspace.
 */
export function formatOptionsFor(platform: PostPlatform): SelectOption[] {
  return FORMATS_BY_PLATFORM[platform].map((value) => ({
    value,
    label: formatLabel(platform, value),
  }));
}

/** The default format for a platform: the first one it offers. */
export function defaultFormatFor(platform: PostPlatform): string {
  const first = FORMATS_BY_PLATFORM[platform][0];
  if (first === undefined) throw new Error(`no formats for platform: ${platform}`);
  return first;
}

/**
 * User-facing copy for a post_create failure. invalid_format (a format the
 * workspace's platform does not offer) names the platform; anything else keeps
 * the proc's message.
 */
export function postCreateErrorMessage(message: string, platform: PostPlatform): string {
  return message === 'invalid_format'
    ? `That format is not available on ${platformLabel(platform)}.`
    : message;
}

/**
 * The draft's first photo or video as the preview's first media. It is already
 * uploaded (a version id) but shown from its local object URL, so the preview
 * never waits on a presign. Pure.
 */
export function draftGalleryItem(item: AttachmentItem): GalleryItem {
  const video = item.mime?.startsWith('video/') === true;
  return {
    assetAttachmentId: item.versionId,
    assetVersionId: item.versionId,
    assetId: '',
    position: 0,
    filename: item.name,
    mimeType: item.mime ?? null,
    kind: video ? 'video' : 'image',
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
  };
}

/**
 * The live preview's input from the unsaved form: platform, format, caption and
 * the first local photo or video. null until the platform and format resolve.
 */
export function draftPreview(input: {
  platform: PostPlatform | null;
  format: string;
  caption: string;
  handle: string;
  attachments: readonly AttachmentItem[];
}): PreviewBodyProps | null {
  if (input.platform === null || input.format === '') return null;
  const first = input.attachments.find(isMediaItem);
  return {
    platform: input.platform,
    format: input.format,
    caption: input.caption,
    handle: input.handle,
    firstMedia: first !== undefined ? draftGalleryItem(first) : null,
    localUrl: first?.previewUrl ?? null,
  };
}

/** Free every local preview the draft holds. */
function revokePreviews(items: readonly AttachmentItem[]): void {
  for (const item of items) {
    if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
  }
}

type OriginValue = 'none' | 'brief';

export interface CreateFormState {
  title: string;
  caption: string;
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
  /** Prefilled target date (Plan opens the sheet on a day); default blank. */
  targetDate?: string;
}): CreateFormState {
  return {
    title: '',
    caption: '',
    format: opts.defaultFormat,
    ownerUserId: opts.currentUserId ?? '',
    bucketId: '',
    targetDate: opts.targetDate ?? '',
    origin: 'none',
    briefId: '',
    attachments: [],
  };
}

export interface BuildPayloadInput {
  title: string;
  caption: string;
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

export function CreatePostSheet({
  open,
  workspaceId,
  initialTargetDate,
  onClose,
  onCreated,
  preset,
}: CreatePostSheetProps) {
  const newTrace = useNewTrace();
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;
  const { options: memberOptions } = usePostMembers(open ? workspaceId : null);
  // One workspace = one platform: the format list is that platform's own.
  const workspacePlatform = useWorkspacePlatform(open ? workspaceId : null);
  const { workspaceName } = useWorkspace();
  // Below lg the preview opens from a chip; at lg+ it sits beside the form.
  const [previewOpen, setPreviewOpen] = useState(false);

  const [form, setForm] = useState<CreateFormState>(() =>
    initialCreateState({
      // Defaulted to the platform's first format by the effect below.
      defaultFormat: '',
      currentUserId,
      ...(initialTargetDate !== undefined ? { targetDate: initialTargetDate } : {}),
    }),
  );
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [briefs, setBriefs] = useState<BriefWithThumbnail[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Preset only: the saved post whose move to review failed, the share toggle,
  // and an upload in flight.
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [share, setShare] = useState(true);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [shareGuard] = useState(createInFlightGuard);
  // The soft file prompt: version ids of attached files the format does not
  // usually carry, awaiting keep or remove. Never blocks saving.
  const [promptIds, setPromptIds] = useState<string[]>([]);
  // The latest attachments and format, for the upload loop's sequential
  // onChange calls (which close over an older render).
  const formRef = useRef(form);
  formRef.current = form;

  function patch(next: Partial<CreateFormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  /** Newly attached files: flag any the current format does not usually carry. */
  function onAttachmentsChange(next: AttachmentItem[]): void {
    const before = new Set(formRef.current.attachments.map((item) => item.versionId));
    patch({ attachments: next });
    if (workspacePlatform === null) return;
    const added = next.filter((item) => !before.has(item.versionId));
    const off = mismatchedFiles(workspacePlatform, formRef.current.format, added);
    if (off.length > 0) {
      setPromptIds((prev) => [...prev, ...off.map((item) => item.versionId)]);
    }
  }

  /** A format change re-checks every attached file against the new format. */
  function onFormatChange(format: string): void {
    patch({ format });
    if (workspacePlatform === null) return;
    setPromptIds(
      mismatchedFiles(workspacePlatform, format, formRef.current.attachments).map(
        (item) => item.versionId,
      ),
    );
  }

  function removePrompted(): void {
    const drop = new Set(promptIds);
    for (const item of formRef.current.attachments) {
      if (drop.has(item.versionId) && item.previewUrl !== undefined) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
    patch({ attachments: formRef.current.attachments.filter((item) => !drop.has(item.versionId)) });
    setPromptIds([]);
  }

  const promptKinds = form.attachments
    .filter((item) => promptIds.includes(item.versionId) && item.mime !== undefined)
    .map((item) => fileKindOf(item.mime ?? ''));
  const activePrompt =
    workspacePlatform !== null && promptKinds.length > 0
      ? filePrompt(workspacePlatform, form.format, promptKinds)
      : null;

  // Reset the form each time the sheet opens so a prior draft never lingers. The
  // owner is left empty here and defaulted to the current user by the effect
  // below, so the reset never depends on the (possibly still-resolving) session.
  // The prior draft's local previews are freed here, not on close, so the
  // closing sheet never flashes a revoked image.
  useEffect(() => {
    if (!open) return;
    revokePreviews(formRef.current.attachments);
    setForm(
      initialCreateState({
        defaultFormat: '',
        currentUserId: null,
        ...(initialTargetDate !== undefined ? { targetDate: initialTargetDate } : {}),
      }),
    );
    setBuckets([]);
    setBriefs([]);
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(false);
    setSavedDraftId(null);
    setShare(true);
    setMediaBusy(false);
    setPromptIds([]);
    setPreviewOpen(false);
  }, [open, initialTargetDate]);

  // Unmounting frees whatever local previews the draft still holds.
  useEffect(() => () => revokePreviews(formRef.current.attachments), []);

  // Default the format to the platform's first one, and keep it inside the
  // platform's list (the platform resolves with the workspace). Runs after the
  // reset above, so a fresh open always lands on the first allowed format.
  useEffect(() => {
    if (!open || workspacePlatform === null) return;
    const allowed: readonly string[] = FORMATS_BY_PLATFORM[workspacePlatform];
    setForm((prev) =>
      allowed.includes(prev.format)
        ? prev
        : { ...prev, format: defaultFormatFor(workspacePlatform) },
    );
  }, [open, workspacePlatform]);

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

  const formatOptions: SelectOption[] =
    workspacePlatform !== null ? formatOptionsFor(workspacePlatform) : [];
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
    preset !== undefined
      ? workspaceId !== null &&
        presetCanSubmit({
          caption: form.caption,
          format: form.format,
          attachments: form.attachments.length,
          busy: submitting || mediaBusy,
        })
      : workspaceId !== null &&
        form.title.trim() !== '' &&
        form.caption.trim() !== '' &&
        form.format !== '' &&
        (form.origin !== 'brief' || form.briefId !== '') &&
        !submitting;

  /** Preset: move the saved post to review; a failure keeps it to retry the move only. */
  async function sendForReview(postId: string): Promise<boolean> {
    const moved = await stageTransition(supabase, {
      p_post_id: postId,
      p_to_stage: 'review',
      p_trace_id: newTrace(),
    });
    if (!moved.ok) {
      logger.error('first post to review failed', { error: moved.error.message });
      setSavedDraftId(postId);
      setSubmitError(REVIEW_RETRY_MESSAGE);
      return false;
    }
    setSavedDraftId(null);
    return true;
  }

  /** Preset: post the card into the default group through the existing share path. */
  async function shareToGroup(postId: string): Promise<void> {
    if (preset === undefined || preset.share === 'no_group' || !share) return;
    const shared = await sharePostToChannel(
      {
        guard: shareGuard,
        record: (input) => sendMessageRecord({ client: supabase, ...input }),
        // Postgres first; members catch up from the row (no live connection here).
        publish: null,
        newMessageId,
        newTraceId: newTrace,
        onPublishFailed: () => undefined,
      },
      { channelId: preset.share.channelId, postId },
    );
    if (!shared.ok) logger.warn('first post share to group failed', { reason: shared.reason });
  }

  async function handlePresetSubmit(): Promise<void> {
    if (workspaceId === null || preset === undefined) return;
    setSubmitting(true);
    setSubmitError(null);
    let postId = savedDraftId;
    if (postId === null) {
      const built = buildPostCreatePayload({
        title: titleFromCaption(form.caption),
        caption: form.caption,
        format: form.format,
        ownerUserId: '',
        bucketId: '',
        targetDate: form.targetDate,
        origin: 'none',
        briefId: '',
      });
      if (!built.ok) {
        setSubmitting(false);
        setFieldErrors(built.errors);
        return;
      }
      const result = await submitCreatePost({
        client: supabase,
        workspaceId,
        payload: built.payload,
        versionIds: attachmentVersionIds(form.attachments),
        newTrace,
        postCreate,
        gallerySet,
      });
      if (!result.ok) {
        setSubmitting(false);
        setSubmitError(
          workspacePlatform !== null
            ? postCreateErrorMessage(result.message, workspacePlatform)
            : result.message,
        );
        return;
      }
      postId = result.postId;
    }
    if (preset.primary === 'send_for_review' && !(await sendForReview(postId))) {
      setSubmitting(false);
      dispatchInductionRefresh();
      return;
    }
    await shareToGroup(postId);
    setSubmitting(false);
    dispatchInductionRefresh();
    onCreated(postId);
  }

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null) return;
    if (preset !== undefined) {
      await handlePresetSubmit();
      return;
    }

    const built = buildPostCreatePayload({
      title: form.title,
      caption: form.caption,
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
      setSubmitError(
        workspacePlatform !== null
          ? postCreateErrorMessage(result.message, workspacePlatform)
          : result.message,
      );
      return;
    }
    dispatchInductionRefresh();
    onCreated(result.postId);
  }

  const preview = draftPreview({
    platform: workspacePlatform,
    format: form.format,
    caption: form.caption,
    handle: workspaceName ?? '',
    attachments: form.attachments,
  });

  function gridError(key: string): ReactElement | null {
    return fieldErrors[key] !== undefined ? (
      <p className="mt-1.5 text-[11px] text-bad">{fieldErrors[key]}</p>
    ) : null;
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
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
              data-induction={INDUCTION_KEYS.postSheetPrimary}
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {preset !== undefined
                ? presetPrimaryLabel({ preset, submitting, savedDraft: savedDraftId !== null })
                : submitting
                  ? 'Creating'
                  : 'Save as draft'}
            </Button>
          </span>
        </>
      }
    >
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start lg:gap-6">
        <div className="flex flex-col gap-4 overflow-x-hidden">
          {preview !== null ? (
            <div className="-my-2 lg:hidden">
              <PreviewChip platform={preview.platform} onClick={() => setPreviewOpen(true)} />
            </div>
          ) : null}
          {preset !== undefined ? (
            <PresetFields
              preset={preset}
              form={form}
              patch={patch}
              onFormatChange={onFormatChange}
              onAttachmentsChange={onAttachmentsChange}
              platform={workspacePlatform}
              formatOptions={formatOptions}
              workspaceId={workspaceId}
              share={share}
              onShareChange={setShare}
              onMediaBusyChange={setMediaBusy}
              captionError={gridError('caption')}
            />
          ) : (
            <>
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
                  <Field label="Format">
                    <Select
                      label="Format"
                      value={form.format}
                      options={formatOptions}
                      onChange={onFormatChange}
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
                        patch({
                          origin: value as OriginValue,
                          ...(value === 'none' ? { briefId: '' } : {}),
                        })
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
                  onChange={onAttachmentsChange}
                  frame={
                    workspacePlatform !== null
                      ? { platform: workspacePlatform, format: form.format }
                      : null
                  }
                />
              </Field>
            </>
          )}

          {submitError !== null ? (
            <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
              {submitError}
            </div>
          ) : null}
        </div>
        {preview !== null ? (
          <aside
            data-composer-preview=""
            aria-label={previewChipLabel(preview.platform)}
            className="hidden lg:sticky lg:top-0 lg:flex lg:flex-col lg:gap-3"
          >
            <h3 className="text-[13px] font-semibold text-fg-2">
              {previewChipLabel(preview.platform)}
            </h3>
            <PreviewBody {...preview} />
          </aside>
        ) : null}
      </div>
      {preview !== null ? (
        <PlatformPreviewPanel
          open={open && previewOpen}
          onClose={() => setPreviewOpen(false)}
          {...preview}
        />
      ) : null}
      {open && activePrompt !== null ? (
        <FilePromptSheet
          prompt={activePrompt}
          onKeep={() => setPromptIds([])}
          onRemove={removePrompted}
        />
      ) : null}
    </Sheet>
  );
}

/** The preset's fields: caption, format, an optional target date, media, and the share toggle. */
function PresetFields(props: {
  preset: PostSheetPreset;
  form: CreateFormState;
  patch: (next: Partial<CreateFormState>) => void;
  onFormatChange: (format: string) => void;
  onAttachmentsChange: (attachments: AttachmentItem[]) => void;
  platform: PostPlatform | null;
  formatOptions: SelectOption[];
  workspaceId: string | null;
  share: boolean;
  onShareChange: (value: boolean) => void;
  onMediaBusyChange: (busy: boolean) => void;
  captionError: ReactElement | null;
}): ReactElement {
  const { preset, form, patch } = props;
  // Select renders its own trigger and option rows (inline, no portal), so the
  // Format keys are set on the rendered elements from here (attributes only). The
  // option rows mount when the menu opens, so a childList observer re-applies them.
  const formatRef = useRef<HTMLDivElement>(null);
  const singleIndex = props.formatOptions.findIndex((option) => option.value === 'single_image');
  useEffect(() => {
    const root = formatRef.current;
    if (root === null) return undefined;
    function mark(el: HTMLElement): void {
      el.querySelector('[aria-haspopup="listbox"]')?.setAttribute(
        'data-induction',
        INDUCTION_KEYS.postSheetFormat,
      );
      if (singleIndex < 0) return;
      el.querySelectorAll('[role="option"]')[singleIndex]?.setAttribute(
        'data-induction',
        INDUCTION_KEYS.postSheetFormatSingle,
      );
    }
    mark(root);
    const observer = new MutationObserver(() => mark(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [singleIndex]);
  return (
    <>
      <Field label="Caption" htmlFor="post-caption" required>
        <Textarea
          id="post-caption"
          data-induction={INDUCTION_KEYS.postSheetCaption}
          value={form.caption}
          onChange={(event) => patch({ caption: event.target.value })}
          placeholder="Write the caption. Its first line becomes the title."
        />
        {props.captionError}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <div ref={formatRef} className="min-w-0">
          <Field label="Format">
            <Select
              label="Format"
              value={form.format}
              options={props.formatOptions}
              onChange={props.onFormatChange}
            />
          </Field>
        </div>
        <div className="min-w-0">
          <Field label="Target date (optional)">
            <DatePicker
              label="Target date"
              value={form.targetDate}
              onChange={(value) => patch({ targetDate: value })}
            />
          </Field>
        </div>
      </div>

      <Field label="Photo or video" required={formatNeedsMedia(form.format)}>
        <PresetMediaField
          workspaceId={props.workspaceId}
          value={form.attachments}
          onChange={props.onAttachmentsChange}
          required={formatNeedsMedia(form.format)}
          onBusyChange={props.onMediaBusyChange}
          frame={props.platform !== null ? { platform: props.platform, format: form.format } : null}
        />
      </Field>

      {preset.share === 'no_group' ? (
        <p className="text-[13px] text-fg-3">
          This workspace has no chat group yet, so the post is not shared in chat.
        </p>
      ) : (
        <ShareToggle
          label={`Share in the ${preset.share.groupName} chat`}
          checked={props.share}
          onChange={props.onShareChange}
        />
      )}
    </>
  );
}

function ShareToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 text-sm">
      <span className="[text-wrap:pretty]">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-11 w-[60px] shrink-0 items-center rounded-full px-1 transition-colors motion-reduce:transition-none',
          checked ? 'bg-accent' : 'bg-panel-3',
        )}
      >
        <span
          className={cn(
            'h-7 w-7 rounded-full bg-panel transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-[24px]' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}
