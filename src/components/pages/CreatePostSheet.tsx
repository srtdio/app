import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import {
  computeMenuPlacement,
  Select,
  SelectMenu,
  type MenuPlacement,
  type SelectOption,
} from '@/components/ui/Select';
import { DatePicker } from '@/components/ui/DatePicker';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconChevronDown, IconSend } from '@/components/ui/icons';
import { useEscapeLayer } from '@/lib/escape-stack';
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
import {
  fileKindOf,
  filePrompt,
  formatForFile,
  mismatchedFiles,
  untouchedDefaultFormat,
} from '@/components/pages/create/file-kind';
import {
  CAPTION_LIMITS,
  captionCounterText,
  captionOverLimit,
} from '@/components/pages/create/caption-limits';
import {
  BUCKET_SAVE_FAILED,
  createSheetErrorMessage,
  POST_SAVE_FAILED,
} from '@/components/pages/create/errors';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useWorkspacePlatform } from '@/lib/workspace-context-platform';
import { useWorkspace } from '@/lib/workspace-context';
import { BUCKET_NAME_MAX, createBucket, listBuckets, type BucketOption } from '@/lib/buckets';
import { postCreate, gallerySet, stageTransition, type Client, type Result } from '@srtdio/rpc';
import { PresetMediaField, uploadLocalFile } from '@/components/induction/PresetMediaField';
import {
  dispatchInductionRefresh,
  formatNeedsMedia,
  INDUCTION_KEYS,
  titleFromCaption,
  type PostSheetPreset,
} from '@/lib/induction';
import { FIRST_POST_SAMPLE } from '@/lib/induction-copy';
import { logger } from '@/lib/logger';
import { useOptionalToast } from '@/components/ui/toast';
import { entityUrlPath } from '@/lib/entityRef';
import { dispatchWorkspaceDataChanged } from '@/lib/events';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { sharePostToChannel } from '@/lib/chat/share-post';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { cn } from '@/lib/cn';
import {
  FORMATS_BY_PLATFORM,
  PostCreatePayloadSchema,
  formatLabel,
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
  /** Preselects this brief and opens More options (New post from this brief). */
  initialBriefId?: string;
  /**
   * Called with the new post's id once it (and its attachments) saved. The full
   * sheet also passes where the post now sits and the link to open it on.
   */
  onCreated: (postId: string, outcome?: CreatedOutcome) => void;
  /**
   * An induction post step: owner, bucket, origin and brief stay out, the title
   * comes from the caption, media is required when the format needs it, and the
   * primary is Send for review or Save as draft. Absent: the full sheet.
   */
  preset?: PostSheetPreset;
}

/** What the full sheet saved: the post's stage and the in-app link to open it on. */
export interface CreatedOutcome {
  stage: 'draft' | 'review';
  path: string;
}

/** Which footer button saved: Save as draft or Send for review. */
export type SubmitMode = 'draft' | 'review';

/** The bottom strip after the sheet closes. Pure. */
export function createdStripTitle(stage: SubmitMode): string {
  return stage === 'review' ? 'Sent for review' : 'Saved as draft';
}

/** The new post's link: the pretty /p/key-n when known, else /posts/:id. Pure. */
export function createdPostPath(
  postId: string,
  workspaceKey: string | null,
  number: number | null,
): string {
  return workspaceKey !== null && number !== null
    ? entityUrlPath('post', workspaceKey, number)
    : `/posts/${postId}`;
}

/** The line above the footer while a file failed. */
export const FAILED_UPLOAD_FOOTER = "Retry or remove the file that didn't upload.";

/** The folded row under the caption and its sub-line. */
export const MORE_OPTIONS_LABEL = 'More options';
export const MORE_OPTIONS_HINT = 'Title, bucket, due date, brief';

/** The Title helper inside More options. */
export const TITLE_HELPER = "Left blank, it uses the caption's first line.";

/** The Brief helper inside More options. */
export const BRIEF_HELPER = 'Open briefs in this workspace.';

/** The Format row's line once the first file set the format. Pure. */
export function formatSourceLine(kind: 'image' | 'video'): string {
  return kind === 'video' ? 'Set from your video' : 'Set from your photo';
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
 * User-facing copy for a post_create failure, always plain words. invalid_format
 * (a format the workspace's platform does not offer) names the platform; known
 * codes get their own line; anything else is "Couldn't save the post. Try
 * again." Raw server text is never shown.
 */
export function postCreateErrorMessage(message: string, platform: PostPlatform | null): string {
  return createSheetErrorMessage(message, platform, POST_SAVE_FAILED);
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

/** The Bucket select's last option: opens the inline new bucket form. */
export const NEW_BUCKET_VALUE = '__new_bucket__';

/** The discard confirm for a dirty sheet: every close path and Cancel share it. Pure. */
export function createPostDiscard(files: number): { title: string; message: string } {
  return {
    title: 'Discard this post?',
    message: `Your caption and ${files} ${files === 1 ? 'file' : 'files'} will be removed.`,
  };
}

/** The discard confirm with no files counted. */
export const CREATE_POST_DISCARD = createPostDiscard(0);

/**
 * Whether closing would lose work: any field with content, or any file (done,
 * uploading or failed). A brief the sheet opened with is not work. Pure.
 */
export function createPostDirty(
  form: Pick<
    CreateFormState,
    'title' | 'caption' | 'bucketId' | 'targetDate' | 'briefId' | 'attachments'
  >,
  pendingUploads: number,
  initialTargetDate = '',
  initialBriefId = '',
): boolean {
  return (
    form.title.trim() !== '' ||
    form.caption.trim() !== '' ||
    form.bucketId !== '' ||
    form.briefId !== initialBriefId ||
    form.targetDate !== initialTargetDate ||
    form.attachments.length > 0 ||
    pendingUploads > 0
  );
}

/** The primary's label while files upload: "Uploading 3 files…". Pure. */
export function uploadingLabel(count: number): string {
  return `Uploading ${count} ${count === 1 ? 'file' : 'files'}…`;
}

/** The inline line when the primary is tapped mid-upload. Pure. */
export function waitForUploadsMessage(count: number): string {
  return `Wait for ${count} ${count === 1 ? 'file' : 'files'} to finish`;
}

/** Each missing required field's inline error. The format is always set, so only the caption. Pure. */
export function requiredFieldErrors(
  form: Pick<CreateFormState, 'caption' | 'format'>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.caption.trim() === '') errors.caption = 'Write a caption';
  return errors;
}

/** Drop one field's error the moment the person types a fix. Pure. */
export function clearFieldError(
  errors: Record<string, string>,
  key: string,
): Record<string, string> {
  if (errors[key] === undefined) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/** The title sent: the typed one, else the caption's first line (80 chars max). Pure. */
export function resolvedTitle(title: string, caption: string): string {
  return title.trim() !== '' ? title : titleFromCaption(caption);
}

/** Whether this device is touch first (no autofocus there, so no keyboard jumps up). */
function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

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

/**
 * Upload the attachments kept local until Send (the first post's sample
 * photo) and swap in their real version ids, in order. The first failure's
 * reason stops it; nothing else is touched.
 */
export async function uploadLocalAttachments(
  items: readonly AttachmentItem[],
  upload: (file: File) => Promise<{ ok: true; versionId: string } | { ok: false; reason: string }>,
): Promise<{ ok: true; items: AttachmentItem[] } | { ok: false; reason: string }> {
  const out: AttachmentItem[] = [];
  for (const item of items) {
    if (item.localFile === undefined) {
      out.push(item);
      continue;
    }
    const sent = await upload(item.localFile);
    if (!sent.ok) return { ok: false, reason: sent.reason };
    const uploaded: AttachmentItem = { ...item, versionId: sent.versionId };
    delete uploaded.localFile;
    out.push(uploaded);
  }
  return { ok: true, items: out };
}

type UploadOutcome = { ok: true; versionId: string } | { ok: false; reason: string };

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
  /**
   * The duplicate guard: a post this sheet already created (an earlier attempt
   * whose attach failed). When set, post_create is skipped and the files
   * attach to that post, so a retry never makes a second post.
   */
  existingPostId?: string | null;
  /** Called the moment the post row exists, before the files attach. */
  onPostCreated?: (postId: string) => void;
}

/**
 * Create the post via post_create, then (only when there are completed
 * attachments) bind them in order via gallery_set. post_create takes no gallery,
 * so the second call is how attachments attach. With existingPostId the create
 * is skipped and only the attach runs. Surfaces the first failing call's
 * message (and the post's id once it exists); never throws.
 */
export async function submitCreatePost(
  deps: SubmitCreatePostDeps,
): Promise<{ ok: true; postId: string } | { ok: false; message: string; postId: string | null }> {
  let postId = deps.existingPostId ?? null;
  if (postId === null) {
    const created = await deps.postCreate(deps.client, {
      p_workspace_id: deps.workspaceId,
      p_payload: deps.payload,
      p_trace_id: deps.newTrace(),
    });
    if (!created.ok) return { ok: false, message: created.error.message, postId: null };
    postId = created.data;
    deps.onPostCreated?.(postId);
  }

  if (deps.versionIds.length > 0) {
    const gallery = await deps.gallerySet(deps.client, {
      p_post_id: postId,
      p_asset_version_ids: [...deps.versionIds],
      p_trace_id: deps.newTrace(),
    });
    if (!gallery.ok) return { ok: false, message: gallery.error.message, postId };
  }
  return { ok: true, postId };
}

export function CreatePostSheet({
  open,
  workspaceId,
  initialTargetDate,
  initialBriefId,
  onClose,
  onCreated,
  preset: presetProp,
}: CreatePostSheetProps) {
  // The preset as it was while open: the parent drops it once the first post is
  // sent, and the closing sheet must not flash into the full form on its way out.
  const presetSeen = useRef(presetProp);
  if (open) presetSeen.current = presetProp;
  const preset = open ? presetProp : presetSeen.current;
  const newTrace = useNewTrace();
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;
  // One workspace = one platform: the format list is that platform's own.
  const workspacePlatform = useWorkspacePlatform(open ? workspaceId : null);
  const { workspaceName, workspaceKey } = useWorkspace();
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
  // Full sheet: which button is saving, the post row once created (the
  // duplicate guard: a retry re-attaches to it), and the Cancel confirm.
  const [submitMode, setSubmitMode] = useState<SubmitMode | null>(null);
  const createdPostId = useRef<string | null>(null);
  // A second tap in the same frame (before Saving… renders) is ignored.
  const submitLock = useRef(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  // Full sheet: the folded More options row, and Format following the first
  // file until the person picks one themselves.
  const [moreOpen, setMoreOpen] = useState(initialBriefId !== undefined);
  const formatTouched = useRef(false);
  const [formatSource, setFormatSource] = useState<'image' | 'video' | null>(null);
  const [failedUploads, setFailedUploads] = useState(0);
  // Preset only: the saved post whose move to review failed, the share toggle,
  // and an upload in flight.
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [share, setShare] = useState(true);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [shareGuard] = useState(createInFlightGuard);
  // Files still uploading in the full form, and whether Save was tapped meanwhile.
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadWait, setUploadWait] = useState(false);
  // The inline "+ New bucket" form.
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketBusy, setNewBucketBusy] = useState(false);
  const [newBucketError, setNewBucketError] = useState<string | null>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const toast = useOptionalToast();
  const uploads = useRef(new Map<File, Promise<UploadOutcome>>());
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

  /**
   * Preset: newly attached files are flagged when the current format does not
   * usually carry them. Full sheet: until the person picks a format, the first
   * photo or video sets it (the soft prompt waits for the whole pick).
   */
  function onAttachmentsChange(next: AttachmentItem[]): void {
    if (preset !== undefined) {
      const before = new Set(formRef.current.attachments.map((item) => item.versionId));
      patch({ attachments: next });
      if (workspacePlatform === null) return;
      const added = next.filter((item) => !before.has(item.versionId));
      const off = mismatchedFiles(workspacePlatform, formRef.current.format, added);
      if (off.length > 0) {
        setPromptIds((prev) => [...prev, ...off.map((item) => item.versionId)]);
      }
      return;
    }
    patch({ attachments: next });
    formRef.current = { ...formRef.current, attachments: next };
    if (workspacePlatform === null || formatTouched.current) return;
    const first = next.find(isMediaItem);
    if (first === undefined) {
      setFormatSource(null);
      return;
    }
    const kind = first.kind === 'image' ? 'image' : fileKindOf(first.mime ?? '');
    if (kind !== 'image' && kind !== 'video') return;
    const format = formatForFile(workspacePlatform, FORMATS_BY_PLATFORM[workspacePlatform], kind);
    if (format === null) return;
    formRef.current = { ...formRef.current, format };
    patch({ format });
    setFormatSource(kind);
  }

  /** Full sheet: once per pick, flag the files the format does not usually carry. */
  function onPickDone(items: AttachmentItem[]): void {
    if (workspacePlatform === null) return;
    const off = mismatchedFiles(workspacePlatform, formRef.current.format, items);
    if (off.length > 0) {
      setPromptIds((prev) => [...prev, ...off.map((item) => item.versionId)]);
    }
  }

  /** A format change re-checks every attached file against the new format. */
  function onFormatChange(format: string): void {
    formatTouched.current = true;
    setFormatSource(null);
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
    setForm({
      ...initialCreateState({
        defaultFormat: '',
        currentUserId: null,
        ...(initialTargetDate !== undefined ? { targetDate: initialTargetDate } : {}),
      }),
      briefId: initialBriefId ?? '',
    });
    setSubmitMode(null);
    createdPostId.current = null;
    submitLock.current = false;
    setCancelConfirm(false);
    setMoreOpen(initialBriefId !== undefined);
    formatTouched.current = false;
    setFormatSource(null);
    setFailedUploads(0);
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
    setPendingUploads(0);
    setUploadWait(false);
    setNewBucketOpen(false);
    setNewBucketName('');
    setNewBucketBusy(false);
    setNewBucketError(null);
  }, [open, initialTargetDate, initialBriefId]);

  // Desktop: the caption takes focus on open. Touch: nothing autofocuses.
  const hasPreset = preset !== undefined;
  useEffect(() => {
    if (!open || hasPreset || isTouchDevice()) return;
    const raf = requestAnimationFrame(() => captionRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, hasPreset]);

  // The wait line goes once every file has finished.
  useEffect(() => {
    if (pendingUploads === 0) setUploadWait(false);
  }, [pendingUploads]);

  // Unmounting frees whatever local previews the draft still holds.
  useEffect(() => () => revokePreviews(formRef.current.attachments), []);

  // Default the format and keep it inside the platform's list (the platform
  // resolves with the workspace). Runs after the reset above. The preset opens on
  // the platform's first format; the full sheet on its single-image format where
  // the first one needs a video (Instagram: Single image, not Reel), and the
  // first file then sets it.
  useEffect(() => {
    if (!open || workspacePlatform === null) return;
    const allowed: readonly string[] = FORMATS_BY_PLATFORM[workspacePlatform];
    const fallback = hasPreset
      ? defaultFormatFor(workspacePlatform)
      : untouchedDefaultFormat(workspacePlatform, allowed);
    setForm((prev) => (allowed.includes(prev.format) ? prev : { ...prev, format: fallback }));
  }, [open, workspacePlatform, hasPreset]);

  // Default the owner to the current user once the session resolves while open.
  useEffect(() => {
    if (open && currentUserId !== null) {
      setForm((prev) => (prev.ownerUserId === '' ? { ...prev, ownerUserId: currentUserId } : prev));
    }
  }, [open, currentUserId]);

  // Load buckets and this workspace's open briefs (reusing the existing reads).
  // The brief list is filtered in the query: this workspace, open only.
  useEffect(() => {
    if (!open || workspaceId === null) return;
    let cancelled = false;
    void listBuckets(supabase, workspaceId).then((res) => {
      if (!cancelled && res.ok) setBuckets(res.data);
    });
    void listBriefs(supabase, { workspaceId, status: 'open' }).then((res) => {
      if (!cancelled && res.ok) setBriefs(res.data);
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
    { value: NEW_BUCKET_VALUE, label: '+ New bucket' },
  ];
  const briefOptions: SelectOption[] = [
    { value: '', label: 'No brief' },
    ...briefs.map((brief) => ({ value: brief.id, label: brief.title })),
  ];

  function onBucketChange(value: string): void {
    if (value === NEW_BUCKET_VALUE) {
      setNewBucketOpen(true);
      setNewBucketName('');
      setNewBucketError(null);
      return;
    }
    patch({ bucketId: value });
  }

  async function submitNewBucket(): Promise<void> {
    if (workspaceId === null || newBucketBusy) return;
    const name = newBucketName.trim();
    if (name === '' || name.length > BUCKET_NAME_MAX) {
      setNewBucketError('Use 1 to 40 characters.');
      return;
    }
    setNewBucketBusy(true);
    setNewBucketError(null);
    const res = await createBucket(supabase, workspaceId, name, newTrace());
    setNewBucketBusy(false);
    if (!res.ok) {
      setNewBucketError(
        createSheetErrorMessage(res.error.message, workspacePlatform, BUCKET_SAVE_FAILED),
      );
      return;
    }
    setBuckets((prev) => (prev.some((b) => b.id === res.data.id) ? prev : [...prev, res.data]));
    patch({ bucketId: res.data.id });
    setNewBucketOpen(false);
    setNewBucketName('');
  }

  const dirty =
    preset === undefined &&
    createPostDirty(
      form,
      pendingUploads + failedUploads,
      initialTargetDate ?? '',
      initialBriefId ?? '',
    );
  const discard = createPostDiscard(form.attachments.length + pendingUploads + failedUploads);

  /** Footer Cancel: the same discard confirm as X, backdrop, Escape and Back. */
  function requestCancel(): void {
    if (submitting) return;
    if (dirty) {
      setCancelConfirm(true);
      return;
    }
    onClose();
  }

  const canSubmit =
    preset !== undefined
      ? workspaceId !== null &&
        presetCanSubmit({
          caption: form.caption,
          format: form.format,
          attachments: form.attachments.length,
          busy: submitting || mediaBusy,
        })
      : // Never disabled for a missing field: a tap shows each field's error. A
        // failed file blocks both buttons until Retry or Remove.
        workspaceId !== null && !submitting && failedUploads === 0;

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

  /**
   * The local photo's upload, started the moment it is attached (Instagram
   * style: the bytes go up while the person reads on), shared by Send.
   */
  function uploadOnce(file: File): Promise<UploadOutcome> {
    const known = uploads.current.get(file);
    if (known !== undefined) return known;
    const started =
      workspaceId === null
        ? Promise.resolve<UploadOutcome>({ ok: false, reason: 'No workspace' })
        : uploadLocalFile({ file, workspaceId, newTrace });
    uploads.current.set(file, started);
    // A failed attempt is not kept: Try again starts a fresh one.
    void started.then((out) => {
      if (!out.ok) uploads.current.delete(file);
    });
    return started;
  }

  useEffect(() => {
    if (!open || preset === undefined || workspaceId === null) return;
    for (const item of form.attachments) {
      if (item.localFile !== undefined) void uploadOnce(item.localFile);
    }
    // uploadOnce is stable in effect (keyed by file); only new attachments matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset, workspaceId, form.attachments]);

  /**
   * After the sheet has closed: the photo (already uploading), the gallery and
   * the group card. The post is already in review; a failure offers Try again.
   */
  async function finishInBackground(postId: string, items: AttachmentItem[]): Promise<void> {
    const sent = await uploadLocalAttachments(items, uploadOnce);
    const ids = sent.ok ? attachmentVersionIds(sent.items) : [];
    let ok = sent.ok;
    if (ok && ids.length > 0) {
      const gallery = await gallerySet(supabase, {
        p_post_id: postId,
        p_asset_version_ids: ids,
        p_trace_id: newTrace(),
      });
      ok = gallery.ok;
      if (!gallery.ok)
        logger.error('first post photo attach failed', { error: gallery.error.message });
    }
    if (!ok) {
      toast?.show({
        title: "Your photo didn't attach",
        description: 'The post is in review. Try again to add the photo.',
        durationMs: null,
        action: { label: 'Try again', onPress: () => void finishInBackground(postId, items) },
      });
      dispatchWorkspaceDataChanged();
      return;
    }
    await shareToGroup(postId);
    dispatchWorkspaceDataChanged();
  }

  async function handlePresetSubmit(): Promise<void> {
    if (workspaceId === null || preset === undefined) return;
    setSubmitting(true);
    setSubmitError(null);
    const items = form.attachments;
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
      // The post first, with no gallery: the photo binds after the sheet closes.
      const result = await submitCreatePost({
        client: supabase,
        workspaceId,
        payload: built.payload,
        versionIds: [],
        newTrace,
        postCreate,
        gallerySet,
      });
      if (!result.ok) {
        setSubmitting(false);
        setSubmitError(postCreateErrorMessage(result.message, workspacePlatform));
        return;
      }
      postId = result.postId;
    }
    if (preset.primary === 'send_for_review' && !(await sendForReview(postId))) {
      setSubmitting(false);
      dispatchInductionRefresh();
      return;
    }
    setSubmitting(false);
    dispatchInductionRefresh();
    onCreated(postId);
    void finishInBackground(postId, items);
  }

  /** Focus a field after its error shows: scroll it into view first. */
  function focusField(el: HTMLElement | null): void {
    if (el === null) return;
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    el.focus({ preventScroll: true });
  }

  /** The new post's link: its pretty /p/key-n when the number reads back, else /posts/:id. */
  async function createdPath(postId: string): Promise<string> {
    const key = workspaceKey ?? null;
    if (key === null) return createdPostPath(postId, null, null);
    try {
      const { data } = await supabase.from('posts').select('number').eq('id', postId).maybeSingle();
      const number = (data as { number: number | null } | null)?.number ?? null;
      return createdPostPath(postId, key, number);
    } catch {
      return createdPostPath(postId, null, null);
    }
  }

  async function handleSubmit(mode: SubmitMode = 'draft'): Promise<void> {
    if (workspaceId === null) return;
    if (preset !== undefined) {
      await handlePresetSubmit();
      return;
    }
    if (submitting || failedUploads > 0) return;

    if (pendingUploads > 0) {
      setUploadWait(true);
      return;
    }
    const missing = requiredFieldErrors(form);
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      focusField(captionRef.current);
      return;
    }

    const built = buildPostCreatePayload({
      title: resolvedTitle(form.title, form.caption),
      caption: form.caption,
      format: form.format,
      ownerUserId: form.ownerUserId,
      bucketId: form.bucketId,
      targetDate: form.targetDate,
      origin: form.briefId !== '' ? 'brief' : 'none',
      briefId: form.briefId,
    });
    if (!built.ok) {
      setFieldErrors(built.errors);
      // The failing field may sit inside the folded More options.
      if (built.errors.caption === undefined) setMoreOpen(true);
      return;
    }

    if (submitLock.current) return;
    submitLock.current = true;
    setFieldErrors({});
    setSubmitting(true);
    setSubmitMode(mode);
    setSubmitError(null);

    // The duplicate guard (as the preset's): once the post row exists its id is
    // kept, so a retry after a failed attach or move re-uses it.
    const result = await submitCreatePost({
      client: supabase,
      workspaceId,
      payload: built.payload,
      versionIds: attachmentVersionIds(form.attachments),
      newTrace,
      postCreate,
      gallerySet,
      existingPostId: createdPostId.current,
      onPostCreated: (postId) => {
        createdPostId.current = postId;
      },
    });

    if (!result.ok) {
      logger.error('create post failed', { error: result.message });
      submitLock.current = false;
      setSubmitting(false);
      setSubmitMode(null);
      setSubmitError(postCreateErrorMessage(result.message, workspacePlatform));
      return;
    }

    // Send for review: the same move the preset's Send for review makes.
    if (mode === 'review') {
      const moved = await stageTransition(supabase, {
        p_post_id: result.postId,
        p_to_stage: 'review',
        p_trace_id: newTrace(),
      });
      if (!moved.ok) {
        logger.error('new post to review failed', { error: moved.error.message });
        submitLock.current = false;
        setSubmitting(false);
        setSubmitMode(null);
        setSubmitError(REVIEW_RETRY_MESSAGE);
        dispatchWorkspaceDataChanged();
        return;
      }
    }

    const path = await createdPath(result.postId);
    submitLock.current = false;
    setSubmitting(false);
    setSubmitMode(null);
    dispatchInductionRefresh();
    toast?.show({ title: createdStripTitle(mode), kind: 'undo' });
    onCreated(result.postId, { stage: mode, path });
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

  /** A field's value changed: its error goes at once, not at the next submit. */
  function patchField(key: keyof CreateFormState, next: Partial<CreateFormState>): void {
    patch(next);
    setFieldErrors((prev) => clearFieldError(prev, key));
  }

  // Laptop: Cmd/Ctrl+Enter sends for review.
  function onFormKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (preset !== undefined || event.key !== 'Enter') return;
    if (!(event.metaKey || event.ctrlKey) || isTouchDevice()) return;
    event.preventDefault();
    void handleSubmit('review');
  }

  const presetFooter = (
    <>
      <Button size="lg" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <span className="ml-auto flex flex-col items-end gap-1">
        <Button
          variant="primary"
          size="lg"
          data-induction={INDUCTION_KEYS.postSheetPrimary}
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          aria-busy={false}
        >
          {preset !== undefined
            ? presetPrimaryLabel({ preset, submitting, savedDraft: savedDraftId !== null })
            : null}
        </Button>
      </span>
    </>
  );

  const fullFooter = (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {failedUploads > 0 ? (
        <p data-upload-failed-footer="" role="status" className="text-[13px] text-bad">
          {FAILED_UPLOAD_FOOTER}
        </p>
      ) : uploadWait && pendingUploads > 0 ? (
        <p data-upload-wait="" role="status" className="text-[11px] text-fg-2">
          {waitForUploadsMessage(pendingUploads)}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <Button
          size="lg"
          variant="ghost"
          className="shrink-0 px-2.5 sm:px-4"
          onClick={requestCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2.5">
          <Button
            size="lg"
            className="shrink-0 px-2.5 sm:px-4"
            data-submit="draft"
            onClick={() => void handleSubmit('draft')}
            disabled={!canSubmit}
            aria-busy={pendingUploads > 0}
          >
            {submitMode === 'draft' ? (
              'Saving…'
            ) : pendingUploads > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
                />
                {uploadingLabel(pendingUploads)}
              </>
            ) : (
              'Save as draft'
            )}
          </Button>
          <Button
            variant="primary"
            size="lg"
            className="shrink-0 px-2.5 sm:px-4"
            data-submit="review"
            onClick={() => void handleSubmit('review')}
            disabled={!canSubmit}
          >
            {submitMode === 'review' ? (
              'Saving…'
            ) : (
              <>
                <IconSend size={16} />
                Send for review
              </>
            )}
          </Button>
        </span>
      </div>
    </div>
  );

  const captionLimit = workspacePlatform !== null ? CAPTION_LIMITS[workspacePlatform] : null;
  const captionCount = form.caption.length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
      title="New post"
      dirty={dirty}
      discard={discard}
      busy={preset === undefined && submitting}
      busyLabel="Saving…"
      footer={preset !== undefined ? presetFooter : fullFooter}
    >
      {preset !== undefined ? (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start lg:gap-6">
          <div className="flex flex-col gap-4 overflow-x-hidden">
            {preview !== null ? (
              <div className="-my-2 lg:hidden">
                <PreviewChip platform={preview.platform} onClick={() => setPreviewOpen(true)} />
              </div>
            ) : null}
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
      ) : (
        <div
          data-create-layout=""
          onKeyDown={onFormKeyDown}
          className="flex flex-col gap-4 lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start lg:gap-6"
        >
          {/* Below lg the preview opens from a chip; its row is reserved from the
              first paint so nothing jumps when the platform resolves. At lg the
              frame itself is the preview. */}
          <div data-preview-chip-slot="" className="-my-2 flex min-h-[44px] items-center lg:hidden">
            {preview !== null ? (
              <PreviewChip platform={preview.platform} onClick={() => setPreviewOpen(true)} />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-0">
            <AttachmentsField
              workspaceId={workspaceId}
              value={form.attachments}
              onChange={onAttachmentsChange}
              onPendingChange={setPendingUploads}
              onFailedChange={setFailedUploads}
              onPickDone={onPickDone}
              frame={
                workspacePlatform !== null
                  ? { platform: workspacePlatform, format: form.format }
                  : null
              }
            />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <FormatRow
              platform={workspacePlatform}
              format={form.format}
              source={formatSource}
              options={formatOptions}
              onChange={onFormatChange}
            />

            <Field label="Caption" htmlFor="post-caption" required>
              <div className="relative">
                <Textarea
                  ref={captionRef}
                  id="post-caption"
                  autoGrow
                  value={form.caption}
                  aria-invalid={fieldErrors.caption !== undefined ? true : undefined}
                  aria-describedby="post-caption-count"
                  onChange={(event) => patchField('caption', { caption: event.target.value })}
                  placeholder="Write the caption"
                  className="pb-7"
                />
                {captionLimit !== null ? (
                  <span
                    id="post-caption-count"
                    data-caption-count=""
                    {...(captionOverLimit(captionCount, captionLimit) ? { 'data-over': '' } : {})}
                    className={cn(
                      'pointer-events-none absolute bottom-2 right-3 text-[11px] tabular-nums',
                      captionOverLimit(captionCount, captionLimit) ? 'text-bad' : 'text-fg-3',
                    )}
                  >
                    {captionCounterText(captionCount, captionLimit)}
                  </span>
                ) : null}
              </div>
              {gridError('caption')}
            </Field>

            <button
              type="button"
              data-more-options=""
              aria-expanded={moreOpen}
              aria-controls="post-more-options"
              onClick={() => setMoreOpen((prev) => !prev)}
              className="flex min-h-[44px] w-full items-center gap-3 rounded-md border border-border bg-panel-2 px-3 py-2 text-left transition-colors hover:bg-panel-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{MORE_OPTIONS_LABEL}</span>
                <span className="block truncate text-[13px] text-fg-3">{MORE_OPTIONS_HINT}</span>
              </span>
              <IconChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-fg-3 transition-transform motion-reduce:transition-none',
                  moreOpen && 'rotate-180',
                )}
              />
            </button>

            {moreOpen ? (
              <div id="post-more-options" className="flex flex-col gap-4">
                <Field label="Title" htmlFor="post-title" hint={TITLE_HELPER}>
                  <Input
                    id="post-title"
                    value={form.title}
                    onChange={(event) => patchField('title', { title: event.target.value })}
                    placeholder="Post title"
                  />
                  {gridError('title')}
                </Field>

                <Field label="Bucket">
                  <Select
                    label="Bucket"
                    value={form.bucketId}
                    options={bucketOptions}
                    onChange={onBucketChange}
                    placeholder="No bucket"
                  />
                  {newBucketOpen ? (
                    <div
                      data-new-bucket=""
                      className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-3"
                    >
                      <Input
                        aria-label="New bucket name"
                        placeholder="Bucket name"
                        value={newBucketName}
                        maxLength={BUCKET_NAME_MAX}
                        disabled={newBucketBusy}
                        onChange={(event) => {
                          setNewBucketName(event.target.value);
                          setNewBucketError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.stopPropagation();
                            void submitNewBucket();
                          }
                        }}
                      />
                      {newBucketError !== null ? (
                        <p role="alert" className="text-[11px] text-bad">
                          {newBucketError}
                        </p>
                      ) : null}
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="lg"
                          variant="primary"
                          disabled={newBucketBusy}
                          onClick={() => void submitNewBucket()}
                        >
                          {newBucketBusy ? 'Creating' : 'Create'}
                        </Button>
                        <Button
                          type="button"
                          size="lg"
                          variant="ghost"
                          disabled={newBucketBusy}
                          onClick={() => {
                            setNewBucketOpen(false);
                            setNewBucketName('');
                            setNewBucketError(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </Field>

                <Field label="Due date">
                  <DatePicker
                    label="Due date"
                    value={form.targetDate}
                    disablePast
                    actions
                    onChange={(value) => patchField('targetDate', { targetDate: value })}
                  />
                  {gridError('targetDate')}
                </Field>

                <Field label="Brief" hint={BRIEF_HELPER}>
                  <Select
                    label="Brief"
                    value={form.briefId}
                    options={briefOptions}
                    onChange={(value) => patchField('briefId', { briefId: value })}
                    placeholder="No brief"
                  />
                  {gridError('briefId')}
                </Field>
              </div>
            ) : null}

            {submitError !== null ? (
              <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
                {submitError}
              </div>
            ) : null}
          </div>
        </div>
      )}
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
      {open && cancelConfirm ? (
        <ConfirmDialog
          title={discard.title}
          message={discard.message}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setCancelConfirm(false);
            onClose();
          }}
          onCancel={() => setCancelConfirm(false)}
        />
      ) : null}
    </Sheet>
  );
}

/**
 * The full sheet's Format row: the label, a pill with the format's name, where
 * it came from ("Set from your photo") while the first file set it, and Change,
 * which opens the format picker.
 */
export function FormatRow({
  platform,
  format,
  source,
  options,
  onChange,
}: {
  platform: PostPlatform | null;
  format: string;
  source: 'image' | 'video' | null;
  options: SelectOption[];
  onChange: (format: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement>('down');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => setOpen(false));

  // Open: the selected format takes focus so the arrow keys work at once.
  // Close: Change gets focus back.
  useEffect(() => {
    if (!open) return;
    const trigger = buttonRef.current;
    const list = listRef.current;
    (
      list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      list?.querySelector<HTMLElement>('[role="option"]') ??
      null
    )?.focus({ preventScroll: true });
    return () => trigger?.focus({ preventScroll: true });
  }, [open]);

  function toggle(): void {
    if (!open && buttonRef.current !== null) {
      setPlacement(
        computeMenuPlacement(buttonRef.current.getBoundingClientRect().bottom, window.innerHeight),
      );
    }
    setOpen((prev) => !prev);
  }

  const name = platform !== null && format !== '' ? formatLabel(platform, format) : '';
  return (
    <div data-format-row="" className="relative flex min-h-[44px] min-w-0 items-center gap-3">
      <span className="shrink-0 text-sm font-medium text-fg">Format</span>
      <span
        data-format-pill=""
        className="inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-panel-2 px-3 text-[13px] font-medium text-fg"
      >
        {name}
      </span>
      <span data-format-source="" className="min-w-0 flex-1 truncate text-[13px] text-fg-3">
        {source !== null ? formatSourceLine(source) : ''}
      </span>
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex h-11 shrink-0 items-center justify-center rounded-md px-3 text-sm font-medium text-accent transition-colors hover:bg-panel-2 disabled:pointer-events-none disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change format"
        disabled={options.length === 0}
        onClick={toggle}
      >
        Change
      </button>
      {open ? (
        <SelectMenu
          options={options}
          value={format}
          placement={placement}
          onChange={onChange}
          onClose={() => setOpen(false)}
          listRef={listRef}
        />
      ) : null}
    </div>
  );
}

/**
 * The preset's fields: caption, format, an optional target date, media, and the
 * share toggle. With fillOnTap the person never types: a tap on the caption
 * fills the sample caption, on Format picks Single image (where the platform
 * has it), on the photo field attaches the sample photo, and each tells the
 * guide to move on. The target date stays empty.
 */
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
  const fill = preset.fillOnTap;
  const captionRef = useRef<HTMLTextAreaElement>(null);
  // A filled caption lets go of focus once it has rendered, so no keyboard stays up.
  const [captionFilled, setCaptionFilled] = useState(0);
  useEffect(() => {
    if (captionFilled > 0) captionRef.current?.blur();
  }, [captionFilled]);
  function fillCaption(): void {
    if (fill === undefined) return;
    if (form.caption.trim() === '') patch({ caption: FIRST_POST_SAMPLE.caption });
    fill.onFilled([INDUCTION_KEYS.postSheetCaption]);
    setCaptionFilled((n) => n + 1);
  }
  function pickSingle(): void {
    if (fill === undefined) return;
    props.onFormatChange('single_image');
    fill.onFilled([INDUCTION_KEYS.postSheetFormat, INDUCTION_KEYS.postSheetFormatSingle]);
  }
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
          ref={captionRef}
          id="post-caption"
          data-induction={INDUCTION_KEYS.postSheetCaption}
          value={form.caption}
          onChange={(event) => patch({ caption: event.target.value })}
          {...(fill !== undefined ? { inputMode: 'none' as const, onFocus: fillCaption } : {})}
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
              {...(fill !== undefined && singleIndex >= 0 ? { onPress: pickSingle } : {})}
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
          {...(fill !== undefined && singleIndex >= 0
            ? { fillOnTap: { onFilled: () => fill.onFilled([INDUCTION_KEYS.postSheetMedia]) } }
            : {})}
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
