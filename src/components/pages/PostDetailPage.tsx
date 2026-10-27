import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { FORMER_MEMBER } from '@/lib/people-names';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { approveTargetDate } from '@/components/ui/ApproveConfirm';
import { briefRoute } from '@/lib/chat/briefs';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Avatar } from '@/components/ui/Avatar';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorNote } from '@/components/ui/ErrorNote';
import {
  Comments,
  fetchCheckpoints,
  openCheckpointsLabel,
  runCreateCommentBatch,
} from '@/components/comments/Comments';
import type { CommentCounts, SharedCheckpoints } from '@/components/comments/Comments';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { dispatchInductionDid, dispatchInductionRefresh, INDUCTION_KEYS } from '@/lib/induction';
import type { CommentAnnotation } from '@/components/comments/Comments';
import { flashNode } from '@/components/comments/flash-node';
import { Highlight, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useSearchJump } from '@/lib/search/jump';
import { cn } from '@/lib/cn';
import { prefersReducedMotion, useIsLaptop } from '@/lib/use-is-laptop';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  ICON_SIZE,
  IconCalendar,
  IconChat,
  IconChevronDown,
  IconChevronLeft,
  IconCopy,
  IconEdit,
  IconLock,
  IconPipeline,
} from '@/components/ui/icons';
import { PlatformPreviewPanel, PreviewChip } from '@/components/preview/PlatformPreviewPanel';
import { galleryFrame, PostGallery } from '@/components/pages/pcs/PostGallery';
import { CaptionView, firstHighlightCommentId } from '@/components/pages/pcs/CaptionView';
import type { CaptionAnnotationView } from '@/components/pages/pcs/CaptionView';
import {
  CaptionAnnotationComposer,
  COMMENT_POST_FAILED,
} from '@/components/pages/pcs/CaptionAnnotationComposer';
import { PinAnnotationComposer } from '@/components/pages/pcs/PinAnnotationComposer';
import { PinOverlay } from '@/components/pages/pcs/PinOverlay';
import { buildPinData } from '@/components/pages/pcs/pin-annotations';
import type { PinDot } from '@/components/pages/pcs/pin-annotations';
import { CheckpointStrip } from '@/components/pages/pcs/CheckpointStrip';
import { PostDetailsSheet } from '@/components/pages/pcs/PostDetailsSheet';
import { SlideActionsSheet } from '@/components/pages/pcs/SlideActionsSheet';
import {
  VersionHistorySheet,
  type VersionThumbs,
} from '@/components/pages/pcs/VersionHistorySheet';
import { ReadOnlyVersionView } from '@/components/pages/pcs/ReadOnlyVersionView';
import { CompareVersionsView } from '@/components/pages/pcs/CompareVersionsView';
import {
  currentVersionNumber as currentVersionNumberOf,
  parseSnapshot,
  toVersionViews,
} from '@/lib/post-versions';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { canDeletePost, isAgencySide, isClient } from '@/components/pages/pcs/roles';
import { PostActionSheet } from '@/components/pages/pcs/PostActionSheet';
import { postActionErrorCopy, usePostDecisions } from '@/components/pages/pcs/use-post-decisions';
import {
  append,
  galleryWriteErrorCopy,
  insertAfter,
  removeAt,
  replaceAt,
} from '@/components/pages/pcs/gallery-transforms';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import { isTouchDevice } from '@/lib/modal-focus';
import {
  decisionBarSpace,
  PostDecisionBar,
  PostDecisionRow,
} from '@/components/pages/pcs/PostDecisionBar';
import { showWhenVisible } from '@/components/pages/pcs/stage-move-commit';
import {
  CAPTION_TIP_TEXT,
  captionTipDismissed,
  dismissCaptionTip,
} from '@/components/pages/pcs/caption-tip';
import { hasInAppHistory } from '@/components/pages/pcs/post-nav';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { createBucket } from '@/lib/buckets';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import type { PresignDeps } from '@/lib/asset-presign';
import { fetchMemberRole, listRootAssetLabels } from '@/lib/assets';
import { uploadAssetFile, type UploadOutcome } from '@/lib/asset-upload';
import { attachLateThumbnail } from '@/lib/asset-thumbnail-attach';
import { useNewTrace } from '@/lib/trace-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { formatDue } from '@/lib/time';
import {
  annotationCreate,
  getPost,
  getPostGallery,
  gallerySet,
  postCaptionUpdate,
  postUpdate,
} from '@srtdio/posts';
import type { GalleryItem, PostDetail, PostUpdateInput, Stage } from '@srtdio/posts';
import { errorText } from '@/lib/error-copy';
import { createComment } from '@srtdio/comments';
import type { CommentRow } from '@srtdio/comments';
// Title only (no linked-posts count, which this page never shows); not on the
// package index, so it is imported from the read module itself.
import { getBriefTitle } from '../../../packages/briefs/src/read';
import { takePostDetail, takePostGallery } from '@/lib/post-prefetch';
import type { Json } from '@srtdio/schemas';
import { postSoftDelete } from '@srtdio/rpc';

/** Where an upload run lands in the gallery (#26 adds Replace). */
type AddTarget =
  | { mode: 'append' }
  | { mode: 'insertAfter'; index: number }
  | { mode: 'replace'; index: number };

// The decision copy and confirms moved to pcs/use-post-decisions (one hook for
// Post detail and the chat post sheet); re-exported for the page's callers.
export {
  APPROVE_ON_BEHALF_LABEL,
  CLIENT_REVIEW_NOTE,
  PcsApproveConfirm,
  REJECT_REASON_LABEL,
  SEND_ANYWAY_LABEL,
  SENT_AGAIN_TOAST,
  StageReasonConfirm,
  postActionErrorCopy,
  rejectConfirmBody,
  sendAgainErrorCopy,
  sendAnywayTitle,
} from '@/components/pages/pcs/use-post-decisions';

/** Spec B4: the approved banner beside the lock. */
export const APPROVED_LOCK_LINE = 'To make changes, move it to Parked.';
/** Spec B4: the banner's button (agency roles only). */
export const MOVE_TO_PARKED_LABEL = 'Move to Parked';

/** Spec B2: the header line's brief part, "From brief: {title}". */
export function fromBriefLabel(briefTitle: string): string {
  return `From brief: ${briefTitle}`;
}
import { postStatusLine } from '@/lib/post-detail-presentation';
import { postFormatLabel } from '@/lib/post-format';
import { isPostPlatform, platformLabel as postPlatformLabel } from '@srtdio/posts';

// The platform's display name from the single source (@srtdio/posts); a raw
// value outside it renders as-is rather than throwing on the page.
function platformLabel(platform: string): string {
  return isPostPlatform(platform) ? postPlatformLabel(platform) : platform;
}

// Read a caption string out of a version snapshot defensively: the snapshot is
// free-form Json, so a missing or non-string caption yields null (no quote)
// rather than a throw.
function snapshotCaption(snapshot: Json | null): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const caption = (snapshot as { caption?: unknown }).caption;
  return typeof caption === 'string' ? caption : null;
}

// The header status-dot fill per stage, reusing the SAME per-stage colour the
// pill carries (draft dim, review accent, approved good, parked warn, rejected
// bad) so no new colour is introduced.
const STAGE_DOT: Record<Stage, string> = {
  draft: 'bg-fg-3',
  review: 'bg-accent',
  approved: 'bg-good',
  parked: 'bg-warn',
  rejected: 'bg-bad',
};

/** The comments section's id: the open-comments chip scrolls here. */
export const COMMENTS_SECTION_ID = 'post-comments';

/** Flow B 29: the pill under the title, "1 open checkpoint" / "{n} open checkpoints". */
export function openCommentsLabel(count: number): string {
  return openCheckpointsLabel(count);
}

/**
 * Flow B 29: scroll the comments section into view, smooth unless the viewer
 * asked for reduced motion. Best-effort: a missing node is a no-op.
 */
export function scrollToCommentsSection(doc: Document = document): void {
  const node = doc.getElementById(COMMENTS_SECTION_ID);
  if (node === null) return;
  node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/**
 * Flow B 34: the page grid, shared by the skeleton and the loaded page so the
 * first paint never jumps. Below lg (phone, tablet portrait) one column: head
 * (title, details, pills), media, body (caption), side (checkpoints). lg and
 * up, two columns: head, picture and caption on the left (at most 560px), the
 * checkpoints on the right as their own column from the top, sticky and
 * scrolling on their own within the viewport so neither side sits blank; page
 * at most 1120px, centred. Embedded (inside another screen) stays one column.
 */
export function postPageGrid(embedded: boolean): {
  page: string;
  head: string;
  media: string;
  body: string;
  side: string;
} {
  if (embedded) {
    return {
      page: 'grid grid-cols-1 gap-4 px-4 md:px-6 pt-4 pb-6',
      head: 'min-w-0',
      media: 'min-w-0',
      body: 'min-w-0',
      side: 'min-w-0',
    };
  }
  return {
    page: 'mx-auto grid w-full max-w-[1120px] grid-cols-1 gap-4 px-4 md:px-6 pt-4 pb-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr] lg:gap-x-8',
    head: 'min-w-0 lg:col-start-1 lg:row-start-1',
    media: 'min-w-0 lg:col-start-1 lg:row-start-2',
    body: 'min-w-0 lg:col-start-1 lg:row-start-3 lg:self-start',
    side: 'min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:overscroll-contain',
  };
}

/** The caption Save label: the version this save creates, or plain Save before any version. */
export function captionSaveLabel(currentVersionNumber: number | null): string {
  return currentVersionNumber === null ? 'Save' : `Save as v${currentVersionNumber + 1}`;
}

/** The note beside caption Save: comments stay with the version they were made on. */
export function captionSaveNote(currentVersionNumber: number | null): string | null {
  return currentVersionNumber === null
    ? null
    : `Comments on v${currentVersionNumber} stay with it.`;
}

/** Per-selection draft keys, so each caption span and each pin keeps its own text. */
export function captionDraftKey(start: number, end: number): string {
  return `caption:${start}:${end}`;
}
export function pinDraftKey(index: number, x: number, y: number): string {
  return `pin:${index}:${x}:${y}`;
}

export function PostDetailPage({
  postId: postIdProp,
  embedded = false,
  focusCommentId: focusCommentIdProp,
  onNavigateAway,
  actionsOpen: actionsOpenProp,
  onActionsOpenChange,
  onOpenInPipeline,
  resolving = false,
}: {
  postId?: string;
  /**
   * The pretty-link resolver (/p/:ref) is still finding the id: hold the
   * skeleton (never not-found) while the role and members reads already run,
   * so the route shows one loader, not a resolver spinner then a skeleton.
   */
  resolving?: boolean;
  /**
   * Shown inside another screen (the plan item): no page header or back button,
   * no URL reads or writes, and both panels stacked.
   */
  embedded?: boolean;
  /** Embedded only: the comment to focus, in place of the ?comment= deep link. */
  focusCommentId?: string;
  /** Replaces every hard navigation to /pipeline (back, not found, after delete). */
  onNavigateAway?: () => void;
  /**
   * Embedded only: the host owns the post action sheet's open state (its own
   * header button opens this same sheet). Absent: the page owns it.
   */
  actionsOpen?: boolean;
  /** Embedded only: the sheet asks to open or close. */
  onActionsOpenChange?: (open: boolean) => void;
  /** Embedded only: the sheet's first row, Open in pipeline. */
  onOpenInPipeline?: () => void;
} = {}) {
  const params = useParams();
  // The pretty-link resolver (/p/:ref) passes the resolved id as a prop; the
  // classic /posts/:postId route supplies it via the URL. The prop wins so the
  // address bar can stay on the pretty URL without a redirect.
  const postId = postIdProp ?? params.postId;
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const { workspaceId, workspaceKey, workspaces, workspaceName } = useWorkspace();

  // A comment link (?comment={commentId}: Activity, toast, email, search) focuses
  // that comment row. Captured into state so it survives the immediate strip
  // below, then handed to Comments, which lands on it (useFocusTarget, keyed by
  // id: a new id on this same page runs again). Only 'comment' is stripped,
  // preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  // A search jump's words: coloured in the title, caption and comments until
  // this page unmounts (the target comment comes through ?comment= below).
  const searchJump = useSearchJump(!embedded);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  useEffect(() => {
    if (embedded) return;
    const comment = searchParams.get('comment');
    if (comment === null || comment === '') return;
    setFocusCommentId(comment);
    // Strip 'comment' in place (replace): the deep link never adds a history entry.
    const next = new URLSearchParams(searchParams);
    next.delete('comment');
    setSearchParams(next, { replace: true });
  }, [embedded, searchParams, setSearchParams]);

  // PR B: phone pins the decision row to the bottom; laptop (useIsLaptop, the
  // one switch) puts it at the right of the header, beside the ⋯.
  const isLaptop = useIsLaptop();

  const [detail, setDetail] = useState<PostDetail | null>(null);
  // Comments and checkpoints read in the post's own workspace (a link can open
  // a post outside the active one). Until the post lands the active workspace
  // is the best guess, so the reads still start on the first render; they
  // re-run only when the post turns out to live elsewhere.
  const commentsWorkspaceId =
    detail !== null && detail.post.id === postId ? detail.post.workspace_id : workspaceId;
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  // Flow B 25 / 36: the gallery read is part of the first paint. galleryLoaded
  // flips once the first read settles (either way); a failed read keeps
  // galleryLoadError so the page shows "Couldn't load the pictures." with Retry,
  // never the empty gallery.
  const [galleryLoaded, setGalleryLoaded] = useState(false);
  const [galleryLoadError, setGalleryLoadError] = useState(false);
  const [galleryRetrying, setGalleryRetrying] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // FT3: a failed load shows ui/LoadError with Retry; the raw message is logged, never shown.
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // The one-time caption tip (dismissed per user in localStorage).
  const [captionTipOpen, setCaptionTipOpen] = useState(false);

  // True while mounted. Declared BEFORE useUndoableAction so this cleanup runs
  // before the hook's unmount flush: a commit that starts during unmount sees
  // the page as gone (no state writes, no navigation from a leaving page).
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { run: runUndoable, flush: flushUndoable } = useUndoableAction();
  const postIdRef = useRef(postId);
  postIdRef.current = postId;
  // Every toast on this page rides the app-wide ToastProvider (AppLayout),
  // which outlives the page: a failure that lands after navigating away is
  // still seen. Captured in a ref once, as PipelinePage does, so push is stable.
  const toastApi = useOptionalToast();
  const toastRef = useRef(toastApi);
  toastRef.current = toastApi;
  const push = useCallback((message: string): void => {
    toastRef.current?.show({ title: message });
  }, []);
  // A failure toast: the error tone (bad-solid), never the neutral card.
  const pushError = useCallback((message: string): void => {
    toastRef.current?.show({ title: message, tone: 'error' });
  }, []);
  // For children that report a tone with the message (the ⋯ menu, uploads).
  const toastWithTone = useCallback(
    (message: string, tone?: 'error'): void => {
      if (tone === 'error') pushError(message);
      else push(message);
    },
    [push, pushError],
  );

  // Caption annotation state: the pending selection drives the composer, and a
  // bump of commentsRefresh re-fetches the comments list after a post.
  const [composer, setComposer] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );
  const [annotating, setAnnotating] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [commentsRefresh, setCommentsRefresh] = useState(0);

  // The post's checkpoints: ONE read the page owns, handed to both Comments
  // (merged into its list) and the CheckpointStrip (its chips), so neither
  // reads them itself. It starts on the first render, alongside Comments' own
  // list read (never after it), and re-runs on every commentsRefresh bump (pin
  // or caption comment, a decision, live events) and whenever Comments asks
  // after its own writes. A read that lands after a newer one started is dropped.
  const [checkpointRows, setCheckpointRows] = useState<CommentRow[] | null>(null);
  const checkpointSeq = useRef(0);
  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (commentsWorkspaceId === null || postId === undefined) return;
    const seq = ++checkpointSeq.current;
    const rows = await fetchCheckpoints(supabase, commentsWorkspaceId, postId);
    if (seq !== checkpointSeq.current) return;
    setCheckpointRows(rows);
  }, [commentsWorkspaceId, postId]);
  useEffect(() => {
    // Switching posts drops the prior rows so nothing bleeds across.
    setCheckpointRows(null);
    void loadCheckpoints();
  }, [loadCheckpoints]);
  const lastCheckpointRefresh = useRef(commentsRefresh);
  useEffect(() => {
    if (lastCheckpointRefresh.current === commentsRefresh) return;
    lastCheckpointRefresh.current = commentsRefresh;
    void loadCheckpoints();
  }, [commentsRefresh, loadCheckpoints]);
  const sharedCheckpoints = useMemo<SharedCheckpoints>(
    () => ({ rows: checkpointRows, reload: loadCheckpoints }),
    [checkpointRows, loadCheckpoints],
  );
  // Comment drafts keyed per selection (caption span or pin), kept while the
  // page is open so a Cancel and a reselect bring the text back.
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const setDraft = useCallback((key: string, body: string): void => {
    setCommentDrafts((prev) => ({ ...prev, [key]: body }));
  }, []);
  const dropDraft = useCallback((key: string): void => {
    setCommentDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  // The failure shown inside the open composer sheet (text kept).
  const [composerError, setComposerError] = useState<string | null>(null);

  // Flow B 33: the live thread counts lifted from Comments (every open
  // top-level thread, checkpoints included, optimistic resolves too).
  const [commentCounts, setCommentCounts] = useState<CommentCounts>({ open: 0, resolved: 0 });
  const handleCommentCounts = useCallback((counts: CommentCounts) => setCommentCounts(counts), []);
  // The page's ONE open-comment count: the open-comments chip under the title
  // (flow B 29), the Comments header, and the creator's "Send for review
  // again" confirm ("{n} comments are still open. Send anyway?") all read
  // this value. Open comments never disable the send.
  const openCount = Math.max(0, commentCounts.open);

  // Pin annotation state (F5): the placed point drives the pin composer, sibling
  // to the caption composer above. Posting mirrors the caption write path.
  const [pinComposer, setPinComposer] = useState<{ index: number; x: number; y: number } | null>(
    null,
  );
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  // F7 editing state. The viewer's role gates every editing surface; it loads
  // once from the membership and an unknown role stays fully read-only.
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const [role, setRole] = useState<string | null>(null);
  // Flow B 25: the role gates which buttons show, so it is part of the first paint.
  const [roleLoaded, setRoleLoaded] = useState(false);
  // The members read (owner name, version authors, the owner picker) starts on
  // this same first render, alongside the post, gallery and role reads.
  const {
    options: memberOptions,
    loading: membersLoading,
    error: membersError,
  } = useWorkspaceMembers(workspaceId);
  // Only a list that loaded proves someone is not a current member: until then a
  // person not in it renders nothing extra, never "Former member".
  const membersLoaded = !membersLoading && membersError === null;

  const [showDetails, setShowDetails] = useState(false);
  // Spec A4: the slide on show, so the header ⋮ can remove it (the ⋮ circle
  // on the picture is gone).
  const [galleryIndex, setGalleryIndex] = useState(0);
  // No bucket read here: the bucket shows only in the details sheet, which
  // reads the buckets itself each time it opens. (The page used to read them
  // too, never used the list, and held the first paint for it.)
  // The post's brief name for the details row; briefLoaded settles once the
  // read for the current brief_id lands (or there is no brief). A failure
  // simply omits the brief from the row.
  const [briefName, setBriefName] = useState<string | null>(null);
  const [briefLoadedFor, setBriefLoadedFor] = useState<string | null | undefined>(undefined);
  // F8 post action sheet (Send to chat / Copy link / Download all images). Live
  // PCS only; the trigger is suppressed in read-only mode below.
  const [ownActionsOpen, setOwnActionsOpen] = useState(false);
  const actionsOpen = actionsOpenProp ?? ownActionsOpen;
  const setActionsOpen = (next: boolean): void => {
    if (actionsOpenProp === undefined) setOwnActionsOpen(next);
    onActionsOpenChange?.(next);
  };
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const suppressTitleBlur = useRef(false);

  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState('');
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [captionSaving, setCaptionSaving] = useState(false);
  const [confirmCaptionDiscard, setConfirmCaptionDiscard] = useState(false);

  // One full-list gallery write at a time: while one is in flight, reorder and
  // remove taps do nothing and the gallery says "Saving…".
  const [gallerySaving, setGallerySaving] = useState(false);
  const gallerySavingRef = useRef(false);

  // Gallery slide-action state: the open sheet's slide index, the per-run upload
  // target (append vs insert-after), and the version ids collected during a run.
  const [slideIndex, setSlideIndex] = useState<number | null>(null);
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null);
  // #26: the one inline line the gallery tools row shows after a failed write.
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const uploadedVersionIds = useRef<string[]>([]);
  // Root library labels, read when the upload sheet opens, so a bulk upload named
  // after the post continues numbering past "<title> N" already in the library.
  // Cleared on close so a reopen never numbers from a stale list. A failed read
  // leaves the list empty (numbering starts at 1).
  const [rootLabels, setRootLabels] = useState<string[]>([]);
  const uploadOpen = addTarget !== null;
  useEffect(() => {
    if (!uploadOpen || workspaceId === null) {
      setRootLabels([]);
      return;
    }
    let active = true;
    void listRootAssetLabels(supabase, workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        logger.warn('post page: root asset labels read failed', { error: result.error.message });
      }
      setRootLabels(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [uploadOpen, workspaceId]);

  // F7.5 version-history viewer. historyOpen drives the sheet; viewingVersionId,
  // when set to a non-current version, puts the whole PCS into read-only mode.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  // Compare mode (F7.6): the picked (earlier, later) version id pair, or null.
  // Mutually exclusive with viewingVersionId below.
  const [compareIds, setCompareIds] = useState<{ fromId: string; toId: string } | null>(null);

  // Switching posts leaves read-only / compare mode and closes the sheet so a
  // stale version never bleeds across navigations. Only an actual switch: on
  // mount everything already starts clean, and the comments section (mounted
  // on the first render) may lift its counts before this parent effect runs.
  const resetForPost = useRef(postId);
  useEffect(() => {
    if (resetForPost.current === postId) return;
    resetForPost.current = postId;
    setHistoryOpen(false);
    setViewingVersionId(null);
    setCompareIds(null);
    // A stale open count never bleeds across posts; Comments re-lifts the
    // real counts once its fetch for the new post lands.
    setCommentCounts({ open: 0, resolved: 0 });
    // A pending delete or image removal commits for its own post (flush). The
    // decisions hook resets its own state per post.
    flushUndoable();
    setCommentDrafts({});
  }, [postId, flushUndoable]);

  // The caption tip shows until this user taps Got it (storage permitting).
  useEffect(() => {
    setCaptionTipOpen(!captionTipDismissed(userId));
  }, [userId]);

  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      setRoleLoaded(true);
      return;
    }
    let cancelled = false;
    setRoleLoaded(false);
    void fetchMemberRole(supabase, workspaceId, userId)
      .catch(() => null)
      .then((next) => {
        mark('post:role:end');
        if (cancelled) return;
        setRole(next);
        setRoleLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  const agencySide = isAgencySide(role);
  const clientRole = isClient(role);
  const canDelete = canDeletePost(role);

  // Resolve the post owner to a display name + avatar from the active members,
  // never a raw uuid: an owner who is no longer a current member reads "Former member".
  const memberById = useMemo(
    () => new Map(memberOptions.map((option) => [option.userId, option])),
    [memberOptions],
  );
  const resolveOwner = useCallback(
    (
      ownerUserId: string | null,
      legacyName: string | null,
    ): { name: string; avatarUrl: string | null } => {
      if (ownerUserId === null || ownerUserId === '')
        return { name: legacyName ?? 'Unassigned', avatarUrl: null };
      const option = memberById.get(ownerUserId);
      if (option === undefined) {
        return { name: legacyName ?? (membersLoaded ? FORMER_MEMBER : ''), avatarUrl: null };
      }
      return { name: option.displayName, avatarUrl: option.avatarUrl };
    },
    [memberById, membersLoaded],
  );

  // One presign setup for this page, built exactly as the Assets page does: the
  // asset-read endpoint env, the existing access-token source, and the trace
  // fetcher. deps are kept for the lightbox's attachment-disposition download;
  // the cache bounds concurrency and reuses inline URLs across thumbnails.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const deps = useMemo<PresignDeps>(
    () => ({
      endpoint: env.VITE_ASSET_READ_URL ?? null,
      getAccessToken: async () =>
        (await supabase.auth.getSession()).data.session?.access_token ?? null,
      fetcher: (input, init) => fetchWithTrace(input, init),
    }),
    [],
  );
  const cache = appPresignCache();

  // `silent` skips the full-page loading flip so a post-transition refetch
  // updates the badge and buttons in place rather than blanking the screen.
  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (postId === undefined) {
        if (resolving) {
          setLoading(true);
          return;
        }
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadError(false);
      // The first read joins the read a card press already started (see
      // src/lib/post-prefetch.ts); a silent refresh always reads afresh.
      mark('post:detail:start');
      const result =
        silent || userId === null || workspaceId === null
          ? await getPost(supabase, postId)
          : await takePostDetail(supabase, userId, workspaceId, postId);
      mark('post:detail:end');
      if (!silent) setLoading(false);
      if (!result.ok) {
        logger.warn('post page: load failed', { error: result.error.message });
        setLoadError(true);
        return;
      }
      if (result.data === null) {
        setNotFound(true);
        setDetail(null);
        return;
      }
      setNotFound(false);
      setDetail(result.data);
    },
    [postId, resolving, userId, workspaceId],
  );

  useEffect(() => {
    mark('post:mount');
    void load();
  }, [load]);

  // The gallery is a separate read (asset_attachments has no FK back to posts, so
  // it cannot ride getPost's embed). Flow B 36: a failed read is NOT an empty
  // gallery; it sets galleryLoadError (the page shows "Couldn't load the pictures."
  // with Retry) and keeps the last good list. Extracted so a gallery_set write
  // and Retry can refresh it (load(true) only refreshes the post).
  const reloadGallery = useCallback(async (): Promise<void> => {
    if (postId === undefined) {
      setGallery([]);
      setGalleryLoadError(false);
      return;
    }
    const result = await getPostGallery(supabase, postId).catch(() => null);
    if (result !== null && result.ok) {
      setGallery(result.data);
      setGalleryLoadError(false);
    } else {
      logger.warn('post page: gallery load failed', {
        error: result === null ? 'thrown' : result.error.message,
      });
      setGalleryLoadError(true);
    }
  }, [postId]);

  const retryGallery = useCallback(async (): Promise<void> => {
    setGalleryRetrying(true);
    await reloadGallery();
    setGalleryRetrying(false);
  }, [reloadGallery]);

  useEffect(() => {
    if (postId === undefined) {
      setGallery([]);
      setGalleryLoadError(false);
      setGalleryLoaded(true);
      return;
    }
    let active = true;
    setGalleryLoaded(false);
    // Joins the gallery read a card press already started, else reads.
    const read =
      userId === null || workspaceId === null
        ? getPostGallery(supabase, postId)
        : takePostGallery(supabase, userId, workspaceId, postId);
    void read
      .catch(() => null)
      .then((result) => {
        mark('post:gallery:end');
        if (!active) return;
        if (result !== null && result.ok) {
          setGallery(result.data);
          setGalleryLoadError(false);
        } else {
          logger.warn('post page: gallery load failed', {
            error: result === null ? 'thrown' : result.error.message,
          });
          setGallery([]);
          setGalleryLoadError(true);
        }
        setGalleryLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [postId, userId, workspaceId]);

  // The brief name for the details row, read once per brief_id. No brief (or
  // no post yet) settles at once; a failed read just omits the brief. This is
  // the page's one serial read, on purpose: the brief id is only known once
  // getPost lands (posts.brief_id), so it cannot start any earlier. It reads
  // the title alone (one request): the linked-posts count is never shown here.
  const briefId = detail?.post.brief_id ?? null;
  useEffect(() => {
    if (briefId === null) {
      setBriefName(null);
      setBriefLoadedFor(null);
      return;
    }
    let active = true;
    mark('post:brief:start');
    void getBriefTitle(supabase, briefId)
      .catch(() => null)
      .then((result) => {
        mark('post:brief:end');
        if (!active) return;
        setBriefName(result !== null && result.ok ? result.data : null);
        setBriefLoadedFor(briefId);
      });
    return () => {
      active = false;
    };
  }, [briefId]);
  const briefLoaded = briefLoadedFor === briefId;

  // The current version is the highest version_number; annotations made on any
  // other version are stale. Computed here so the reads stay untouched.
  const currentVersionId = useMemo<string | null>(() => {
    if (detail === null || detail.versions.length === 0) return null;
    return detail.versions.reduce((top, v) => (v.version_number > top.version_number ? v : top)).id;
  }, [detail]);

  // F7.5 view-model: the camelCased version chain (ascending) plus the current
  // version number that drives the pill. Derived from getPost's existing embed,
  // no extra read.
  const versionViews = useMemo(
    () => (detail === null ? [] : toVersionViews(detail.versions)),
    [detail],
  );
  const currentVersionNumber = useMemo(() => currentVersionNumberOf(versionViews), [versionViews]);

  // Read-only mode is gated solely by viewingVersion: when set to a non-current
  // version, every write affordance below is suppressed and the read-only view
  // replaces the editable surface. An id that no longer resolves drops the mode.
  const viewingVersion = useMemo(
    () => versionViews.find((v) => v.id === viewingVersionId) ?? null,
    [versionViews, viewingVersionId],
  );
  const viewingSnapshot = useMemo(
    () => (viewingVersion === null ? null : parseSnapshot(viewingVersion.snapshot)),
    [viewingVersion],
  );

  // Compare mode resolves its two version snapshots the same defensive way the
  // read-only path does. An id that no longer resolves drops the mode; captions
  // come straight from parseSnapshot (never diffed against undefined).
  const compareFrom = useMemo(
    () =>
      compareIds === null ? null : (versionViews.find((v) => v.id === compareIds.fromId) ?? null),
    [compareIds, versionViews],
  );
  const compareTo = useMemo(
    () =>
      compareIds === null ? null : (versionViews.find((v) => v.id === compareIds.toId) ?? null),
    [compareIds, versionViews],
  );
  const comparing = compareFrom !== null && compareTo !== null;

  // Both history surfaces suppress every write affordance below; they are
  // mutually exclusive, enforced by the handlers that enter each mode.
  const readOnly = viewingVersion !== null || comparing;
  // A host-owned open (the plan item's header button) while the sheet cannot
  // mount (loading, not found, an old version) closes again at once, so the
  // sheet never pops open later on its own.
  // Flow B 25: one correct first paint. The skeleton stays until the post, the
  // gallery, the viewer's role and the members (owner name) (and the brief
  // name, when the post has one) have all settled; then the page paints once.
  // Silent refreshes after that never flip back to the skeleton. Every one of
  // those reads starts on the first render (independent effects), except the
  // brief, which needs the post's brief_id. The comments and checkpoint reads
  // are not part of this gate: their section mounts (hidden) on the first
  // render too, so they run alongside, and fill in under their own skeleton.
  const firstPaintPending =
    loading ||
    (!loadError &&
      !notFound &&
      detail !== null &&
      !(galleryLoaded && roleLoaded && !membersLoading && briefLoaded));
  const sheetMountable =
    !firstPaintPending && !notFound && !loadError && detail !== null && !readOnly;
  useEffect(() => {
    if (actionsOpenProp === true && !sheetMountable) onActionsOpenChange?.(false);
  }, [actionsOpenProp, sheetMountable, onActionsOpenChange]);

  // The workspace zone: target_date is a due date, a calendar day on the
  // workspace zone (the details sheet's date input round-trips on it too).
  // Moments (status line, comments) read the viewer's device clock.
  const approveTimeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? 'UTC';

  // PR B: every decision (the row, the creator's ⋯ moves, the confirms) comes
  // from the one hook the chat post sheet also calls, so the two never differ.
  const ownerForDecisions =
    detail === null
      ? null
      : resolveOwner(detail.post.owner_user_id, detail.post.legacy_author_name);
  const decisions = usePostDecisions({
    postId,
    stage: detail === null ? null : (detail.post.stage as Stage),
    role,
    enabled: !readOnly,
    workspaceId,
    brand: workspaceName ?? null,
    postTitle: detail?.post.title ?? '',
    creatorName:
      detail !== null &&
      ownerForDecisions !== null &&
      ownerForDecisions.name !== '' &&
      !(detail.post.owner_user_id === null && detail.post.legacy_author_name === null)
        ? ownerForDecisions.name
        : null,
    mediaCount: gallery.length > 0 ? gallery.length : null,
    approveDay: detail === null ? '' : approveTargetDate(detail.post.target_date, approveTimeZone),
    openCount,
    reload: () => load(true),
    onCommentsChanged: () => setCommentsRefresh((n) => n + 1),
  });

  // Resolve a version's createdBy to a display name via the same members read PCS
  // already uses; a null author or one who is no longer a current member reads
  // "Former member", never a raw uuid.
  const resolveAuthorName = useCallback(
    (authorUserId: string | null, legacyName: string | null): string => {
      if (authorUserId === null || authorUserId === '') return legacyName ?? FORMER_MEMBER;
      return (
        memberById.get(authorUserId)?.displayName ??
        legacyName ??
        (membersLoaded ? FORMER_MEMBER : '')
      );
    },
    [memberById, membersLoaded],
  );

  // From the embedded annotations, build (a) the in-bounds current-version
  // caption_span highlights for CaptionView and (b) a per-comment map covering
  // every caption_span (stale included) for the comment chips. Live highlights
  // are numbered in caption order; stale ones carry their original quote sliced
  // from their own version snapshot. Out-of-bounds or inverted ranges are
  // skipped rather than mis-sliced.
  const { highlights, annotationsByCommentId, pinsByAttachment } = useMemo(() => {
    const list: CaptionAnnotationView[] = [];
    const byComment: Record<string, CommentAnnotation> = {};
    const noPins: Record<string, PinDot[]> = {};
    if (detail === null)
      return { highlights: list, annotationsByCommentId: byComment, pinsByAttachment: noPins };

    const liveCaption = detail.post.caption ?? '';
    const versionById = new Map(detail.versions.map((v) => [v.id, v]));
    const spans = detail.annotations
      .filter((a) => a.kind === 'caption_span')
      .sort((a, b) => {
        const sa = a.caption_start ?? 0;
        const sb = b.caption_start ?? 0;
        if (sa !== sb) return sa - sb;
        return a.created_at.localeCompare(b.created_at);
      });

    let liveN = 0;
    for (const a of spans) {
      const start = a.caption_start;
      const end = a.caption_end;
      const stale = a.post_version_id !== currentVersionId;
      const versionNumber = versionById.get(a.post_version_id)?.version_number ?? 0;
      const inRange = (cap: string): boolean =>
        start !== null && end !== null && start >= 0 && end <= cap.length && start < end;

      if (!stale) {
        if (start !== null && end !== null && inRange(liveCaption)) {
          liveN += 1;
          list.push({
            id: a.id,
            n: liveN,
            captionStart: start,
            captionEnd: end,
            commentId: a.comment_id,
          });
          byComment[a.comment_id] = {
            n: liveN,
            quote: liveCaption.slice(start, end),
            stale: false,
            versionNumber,
          };
        }
        // Out-of-bounds current-version annotation: no highlight, no chip.
        continue;
      }

      const snapCaption = snapshotCaption(versionById.get(a.post_version_id)?.snapshot ?? null);
      const quote =
        snapCaption !== null && start !== null && end !== null && inRange(snapCaption)
          ? snapCaption.slice(start, end)
          : '';
      byComment[a.comment_id] = { n: 0, quote, stale: true, versionNumber };
    }

    // Second pass: number the image pins AFTER the captions (continuing liveN)
    // and match current-version pins to their slides for the overlay. Caption
    // numbering above is untouched.
    const pinData = buildPinData(
      detail.annotations,
      currentVersionId,
      detail.versions,
      gallery,
      liveN,
    );
    Object.assign(byComment, pinData.pinChipsByCommentId);

    return {
      highlights: list,
      annotationsByCommentId: byComment,
      pinsByAttachment: pinData.pinsByAttachment,
    };
  }, [detail, currentVersionId, gallery]);

  // Open the composer for a captured caption selection.
  const handleAnnotate = useCallback((start: number, end: number, quote: string): void => {
    setAnnotateError(null);
    setComposerError(null);
    setComposer({ start, end, quote });
  }, []);

  // Scroll to (and briefly flash) a DOM node by id. Every section is on the one
  // page, so a pin, highlight or chip tap never touches the URL and never adds
  // a browser history entry.
  function flashTo(elementId: string): void {
    flashNode(elementId);
  }

  // The comment an annotation anchors to. A client's comment on a post is a
  // checkpoint (comment_batch_create, one point); comment_create refuses a
  // client's top-level comment (forbidden_role). Everyone else writes a plain
  // comment. Both land on the same trace as the annotation that follows.
  async function createAnchoredComment(
    body: string,
    traceId: string,
  ): Promise<{ ok: true; data: string } | { ok: false; message: string }> {
    if (detail === null) return { ok: false, message: 'not_found' };
    if (clientRole) {
      const batch = await runCreateCommentBatch(supabase, {
        workspaceId: detail.post.workspace_id,
        postId: detail.post.id,
        points: [{ body }],
        traceId,
      });
      if (!batch.ok) return { ok: false, message: batch.error.message };
      const first = batch.data[0];
      if (first === undefined) return { ok: false, message: 'invalid_payload' };
      return { ok: true, data: first.id };
    }
    const result = await createComment(supabase, {
      workspace_id: detail.post.workspace_id,
      entity_type: 'post',
      entity_id: detail.post.id,
      body,
      trace_id: traceId,
    });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, data: result.data };
  }

  // Comment-first, annotation-second on one shared trace. If the annotation
  // fails after the comment lands, the comment simply stays a plain comment; we
  // surface an error and refresh the list, with no retry loop.
  async function submitAnnotation(body: string): Promise<void> {
    if (composer === null || detail === null || currentVersionId === null) return;
    // The sheet stays open (busy) until the comment is saved; a failure keeps
    // the text in it with a retry message.
    const span = composer;
    const draftKey = captionDraftKey(span.start, span.end);
    setAnnotating(true);
    setAnnotateError(null);
    setComposerError(null);
    const traceId = newTrace();

    const commentResult = await createAnchoredComment(body, traceId);
    if (!commentResult.ok) {
      logger.warn('post page: caption comment failed', { error: commentResult.message });
      setAnnotating(false);
      setComposerError(COMMENT_POST_FAILED);
      return;
    }
    // The comment is saved: close the sheet and drop its draft.
    setComposer(null);
    dropDraft(draftKey);

    const annotationResult = await annotationCreate(supabase, {
      kind: 'caption_span',
      postId: detail.post.id,
      postVersionId: currentVersionId,
      commentId: commentResult.data,
      captionStart: span.start,
      captionEnd: span.end,
      traceId,
    });
    if (!annotationResult.ok) {
      setAnnotating(false);
      setComposer(null);
      setAnnotateError(
        "Couldn't anchor the comment to the caption. It was posted as a plain comment.",
      );
      dispatchInductionDid(INDUCTION_KEYS.postCommentPost);
      setCommentsRefresh((n) => n + 1);
      return;
    }

    // The comment is on the post: the guide moves on even if a phone lost the tap.
    dispatchInductionDid(INDUCTION_KEYS.postCommentPost);
    await load(true);
    setCommentsRefresh((n) => n + 1);
    setAnnotating(false);
    dispatchInductionRefresh();
  }

  // Pin placement (F5): the lightbox owns the armed state; arming just clears any
  // prior error, and a valid tap opens the pin composer at the captured point.
  const handleRequestPin = useCallback((): void => {
    setPinError(null);
  }, []);

  const handlePlacePin = useCallback((index: number, x: number, y: number): void => {
    setPinError(null);
    setComposerError(null);
    setPinComposer({ index, x, y });
  }, []);

  // Comment-first, image_pin-second on one shared trace, mirroring the caption
  // write path. An annotation failure after the comment lands leaves a plain
  // comment with an error notice and no retry.
  async function submitPinAnnotation(body: string): Promise<void> {
    if (pinComposer === null || detail === null || currentVersionId === null) return;
    const item = gallery[pinComposer.index];
    if (item === undefined) return;
    const draftKey = pinDraftKey(pinComposer.index, pinComposer.x, pinComposer.y);
    setPinSubmitting(true);
    setPinError(null);
    setComposerError(null);
    const traceId = newTrace();

    const commentResult = await createAnchoredComment(body, traceId);
    if (!commentResult.ok) {
      logger.warn('post page: pin comment failed', { error: commentResult.message });
      setPinSubmitting(false);
      setComposerError(COMMENT_POST_FAILED);
      return;
    }
    // The comment is saved: the draft goes; the sheet closes below.
    dropDraft(draftKey);

    const annotationResult = await annotationCreate(supabase, {
      kind: 'image_pin',
      postId: detail.post.id,
      postVersionId: currentVersionId,
      commentId: commentResult.data,
      assetAttachmentId: item.assetAttachmentId,
      imageX: pinComposer.x,
      imageY: pinComposer.y,
      traceId,
    });
    if (!annotationResult.ok) {
      setPinSubmitting(false);
      setPinComposer(null);
      setPinError("Couldn't anchor the comment to the image. It was posted as a plain comment.");
      setCommentsRefresh((n) => n + 1);
      return;
    }

    setPinSubmitting(false);
    setPinComposer(null);
    await load(true);
    setCommentsRefresh((n) => n + 1);
    dispatchInductionRefresh();
  }

  // Leaving the post (FT13): the host's own close when embedded; else one step
  // back when there is in-app history to return to, else the pipeline.
  function leave(): void {
    mark('post:close:tap');
    if (onNavigateAway !== undefined) {
      onNavigateAway();
      return;
    }
    if (hasInAppHistory(window.history.state)) navigate(-1);
    else goPipeline();
  }

  // The explicit "Back to pipeline" (not found), and leave()'s fallback: the
  // one hard navigation to the pipeline, gated by the host's close when embedded.
  function goPipeline(): void {
    if (onNavigateAway !== undefined) onNavigateAway();
    else navigate('/pipeline');
  }

  // Soft-delete the whole post (FT14): a 4s Undo window ("Post deleted"), then
  // the proc (which re-checks post.delete). The page leaves as the commit
  // starts, so the write lands behind the navigation; a refusal is reported
  // through the app-wide toast, which outlives the page, with Open to return.
  async function handleDeletePost(): Promise<void> {
    if (postId === undefined || detail === null) return;
    const deletedId = postId;
    const postTitle = detail.post.title;
    runUndoable({
      label: 'Post deleted',
      commit: async () => {
        if (mountedRef.current && postIdRef.current === deletedId) leave();
        const result = await postSoftDelete(supabase, {
          p_post_id: deletedId,
          p_trace_id: newTrace(),
        });
        if (result.ok) return;
        logger.warn('post page: delete failed', { error: String(result.error.message) });
        showWhenVisible(document, () => {
          toastRef.current?.show({
            title: errorText(`delete ${postTitle}`, result.error),
            tone: 'error',
            action: { label: 'Open', onPress: () => navigate(`/posts/${deletedId}`) },
          });
        });
      },
    });
  }

  // One field at a time through post_update; the proc bumps row_version itself
  // and load(true) refreshes the page. A failure surfaces as one toast in plain
  // words (flow B 41; the approved lock reads "Approved posts can't be edited.").
  const applyPostUpdate = useCallback(
    async (
      patch: Partial<Pick<PostUpdateInput, 'title' | 'bucketId' | 'ownerUserId' | 'targetDate'>>,
    ): Promise<void> => {
      if (postId === undefined) return;
      setSavingMeta(true);
      const result = await postUpdate(supabase, { postId, ...patch }, newTrace());
      setSavingMeta(false);
      if (!result.ok) {
        pushError(postActionErrorCopy(result.error, 'save the details'));
        return;
      }
      await load(true);
    },
    [postId, newTrace, load, pushError],
  );

  // Title is internal: a trimmed, changed value writes via post_update (no new
  // version); empty or unchanged simply cancels. Escape and the post-save blur
  // both suppress the trailing blur-save so the write never doubles.
  function openTitleEditor(): void {
    if (detail === null) return;
    suppressTitleBlur.current = false;
    setTitleDraft(detail.post.title);
    setEditingTitle(true);
  }
  async function saveTitle(): Promise<void> {
    if (detail === null) {
      setEditingTitle(false);
      return;
    }
    const trimmed = titleDraft.trim();
    if (trimmed === '' || trimmed === detail.post.title) {
      setEditingTitle(false);
      return;
    }
    await applyPostUpdate({ title: trimmed });
    setEditingTitle(false);
  }
  function onTitleBlur(): void {
    if (suppressTitleBlur.current) {
      suppressTitleBlur.current = false;
      return;
    }
    void saveTitle();
  }
  function onTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      suppressTitleBlur.current = true;
      void saveTitle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      suppressTitleBlur.current = true;
      setEditingTitle(false);
    }
  }

  // Caption edit (agency side): seed from the live caption, validate 1..5000 on
  // the trimmed value with no call on failure, then post_caption_update (which
  // auto-versions in-txn) and refresh.
  function openCaptionEditor(): void {
    setCaptionDraft(detail?.post.caption ?? '');
    setCaptionError(null);
    setEditingCaption(true);
  }
  async function saveCaption(): Promise<void> {
    if (postId === undefined) return;
    const value = captionDraft.trim();
    if (value.length < 1) {
      setCaptionError('Add a caption before saving.');
      return;
    }
    if (value.length > 5000) {
      setCaptionError('Captions are limited to 5000 characters.');
      return;
    }
    setCaptionSaving(true);
    const result = await postCaptionUpdate(supabase, { postId, caption: value }, newTrace());
    setCaptionSaving(false);
    if (!result.ok) {
      setCaptionError(postActionErrorCopy(result.error, 'save the caption'));
      return;
    }
    setEditingCaption(false);
    await load(true);
  }
  // Cancel with unsaved edits asks first; an unchanged draft just closes.
  function cancelCaptionEdit(): void {
    if (captionDraft !== (detail?.post.caption ?? '')) {
      setConfirmCaptionDiscard(true);
      return;
    }
    setEditingCaption(false);
    setCaptionError(null);
  }

  // Whole-gallery replace via gallery_set (auto-versions + re-stales annotations
  // server-side). load(true) refreshes the post; reloadGallery refreshes the grid.
  // The ref guard drops a second write while one is in flight (a fast double
  // tap lands before the state re-renders), so two full-list writes never
  // overlap and the second never overwrites the first with a stale order.
  const commitGallery = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (postId === undefined || gallerySavingRef.current) return false;
      gallerySavingRef.current = true;
      setGallerySaving(true);
      setGalleryError(null);
      try {
        const result = await gallerySet(supabase, { postId, assetVersionIds: ids }, newTrace());
        if (!result.ok) {
          // #26: shown once, inline in the tools row (no toast on top).
          setGalleryError(galleryWriteErrorCopy(result.error));
          return false;
        }
        await Promise.all([load(true), reloadGallery()]);
        return true;
      } finally {
        gallerySavingRef.current = false;
        setGallerySaving(false);
      }
    },
    [postId, newTrace, load, reloadGallery],
  );

  const orderedIds = useMemo(() => gallery.map((item) => item.assetVersionId), [gallery]);

  // #26: no per-tap reorder (each tap saved a version); the gallery's Reorder
  // mode saves the whole order once through tools.onSaveOrder.
  function handleRemove(index: number): void {
    // Removing the last image is allowed now: gallery_set accepts an empty list,
    // the post keeps its review stage, and the surface falls back to the empty
    // state. The stage is never touched here.
    // PR B delete rule: the image goes at once behind the UNDO_MS Undo strip
    // ("Image removed"), no confirm; the file stays in Assets and the old
    // version keeps it. The one gallery write runs when the window ends; a
    // refused write shows its inline line and reloads the gallery.
    if (gallerySavingRef.current) return;
    const before = gallery;
    const ids = removeAt(orderedIds, index);
    const removedFor = postId;
    const stillHere = (): boolean => mountedRef.current && postIdRef.current === removedFor;
    setGallery(before.filter((_, i) => i !== index));
    runUndoable({
      label: 'Image removed',
      revert: () => {
        if (stillHere()) setGallery(before);
      },
      commit: async () => {
        const ok = await commitGallery(ids);
        if (!ok && stillHere()) await reloadGallery();
      },
    });
  }
  function openAdd(target: AddTarget): void {
    uploadedVersionIds.current = [];
    setAddTarget(target);
  }

  // The upload sheet posts each file to the asset-upload worker; capture the
  // version id of every success so the gallery add can pin them on close.
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const handleUploadFile = useCallback(
    async (
      file: File,
      displayName: string,
      folderId: string | null,
      signal?: AbortSignal,
      onProgress?: (fraction: number) => void,
    ): Promise<UploadOutcome> => {
      // Up to three files go up at once and finish in any order, so each file
      // takes its pick-order slot now (files start in pick order) and fills it
      // on success; empty slots are dropped when the gallery is committed.
      const slots = uploadedVersionIds.current;
      const slot = slots.length;
      slots.push('');
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      if (workspaceId === null) {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      const outcome = await uploadAssetFile(file, {
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        origin: 'library',
        filename: file.name,
        displayName,
        folderId,
        attachThumbnail: attachLateThumbnail,
        // XHR so the row's bar shows real bytes sent and Stop aborts the
        // request in flight; the transport sets X-Trace-Id itself.
        xhr: {
          traceId: newTrace(),
          ...(signal !== undefined ? { signal } : {}),
          ...(onProgress !== undefined ? { onProgress } : {}),
        },
      });
      // The sheet was closed (the list was reset) while this file was going up.
      if (uploadedVersionIds.current !== slots) return outcome;
      if (outcome.ok && outcome.assetVersionId !== undefined && outcome.assetVersionId !== '') {
        slots[slot] = outcome.assetVersionId;
      }
      return outcome;
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  // After a fully-successful upload run, apply append or insert-after for each
  // new version id over the current order, then commit the whole gallery once.
  async function handleUploaded(): Promise<void> {
    const versionIds = uploadedVersionIds.current.filter((id) => id !== '');
    uploadedVersionIds.current = [];
    const target = addTarget;
    setAddTarget(null);
    if (versionIds.length === 0 || target === null) return;
    let ids = orderedIds;
    if (target.mode === 'replace') {
      // #26 Replace: the first upload takes the slide's place, one save.
      const [first] = versionIds;
      if (first !== undefined) ids = replaceAt(ids, target.index, first);
    } else if (target.mode === 'append') {
      for (const versionId of versionIds) ids = append(ids, versionId);
    } else {
      let at = target.index;
      for (const versionId of versionIds) {
        ids = insertAfter(ids, at, versionId);
        at += 1;
      }
    }
    await commitGallery(ids);
  }

  const backButton = (
    <IconButton label="Back" className="shrink-0" onClick={leave}>
      <IconChevronLeft size={ICON_SIZE.control} />
    </IconButton>
  );

  // Flow B 34: the skeleton uses the loaded page's own grid, so nothing jumps
  // when the content paints.
  const grid = postPageGrid(embedded);

  // The checkpoints column (spec D1: its own column at lg, sticky and scrolling
  // within the viewport; below lg it follows the caption). Comments own their
  // header row ("Checkpoints", Open / All); the checkpoint strip sits under it,
  // only when there are checkpoints (it renders nothing otherwise).
  //
  // It is the SAME element in the skeleton and the loaded page (same place in
  // the tree), so Comments and the strip mount on the first render and their
  // reads run alongside the post, gallery, role and members reads instead of
  // after the first paint. While the skeleton shows, the section is `hidden`
  // (display none: nothing seen, nothing focusable, no tour anchor, no
  // deep-link flash) behind the skeleton's own placeholder; at the first paint
  // it is revealed, already loaded or under Comments' own loading skeleton.
  //
  // focusInsetBottom: the phone decision bar's height, set as
  // --focus-inset-bottom so a linked comment lands clear of the sticky bar.
  function sidePanel(pending: boolean, focusInsetBottom?: string): React.ReactElement {
    return (
      <div
        {...(pending ? { 'aria-hidden': true } : { 'data-post-side': '' })}
        className={grid.side}
      >
        {pending ? <div className="h-24 animate-pulse rounded-xl bg-panel-2" /> : null}
        <section
          id={COMMENTS_SECTION_ID}
          hidden={pending}
          className="scroll-mt-16 rounded-xl border border-border bg-panel-2 p-4"
          {...(focusInsetBottom !== undefined
            ? { style: { ['--focus-inset-bottom' as string]: focusInsetBottom } }
            : {})}
        >
          {commentsWorkspaceId !== null && postId !== undefined ? (
            <div data-induction={INDUCTION_KEYS.postCommentComposer}>
              <Comments
                workspaceId={commentsWorkspaceId}
                entityType="post"
                entityId={postId}
                annotationsByCommentId={annotationsByCommentId}
                onAnnotationChipClick={(commentId) => flashTo(`caption-mark-${commentId}`)}
                refreshSignal={commentsRefresh}
                // A linked comment lands only once it can be seen.
                focusCommentId={
                  pending ? null : embedded ? (focusCommentIdProp ?? null) : focusCommentId
                }
                viewerIsClient={clientRole}
                {...(detail !== null ? { postStage: detail.post.stage } : {})}
                guideReplyCommentId={firstHighlightCommentId(
                  detail?.post.caption ?? '',
                  highlights,
                )}
                showHeader
                onCountsChange={handleCommentCounts}
                sharedCheckpoints={sharedCheckpoints}
                belowHeader={
                  <CheckpointStrip
                    workspaceId={commentsWorkspaceId}
                    postId={postId}
                    viewerIsClient={clientRole}
                    refreshSignal={commentsRefresh}
                    checkpoints={checkpointRows}
                  />
                }
              />
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-base text-fg-2">
              Select a workspace to view comments.
            </div>
          )}
        </section>
      </div>
    );
  }

  if (firstPaintPending) {
    // The same root, header slot and grid element as the loaded page below
    // (Provider > header, read-only title slot, grid > head, media, body,
    // side), so the side panel keeps its mounted Comments across the paint.
    return (
      <SearchWordsContext.Provider value={searchJump.words}>
        {embedded ? null : (
          <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
            {backButton}
            <div aria-hidden className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-4 w-32 animate-pulse rounded bg-panel-3" />
            </div>
            <div aria-hidden className="h-11 w-11 shrink-0" />
          </div>
        )}
        {/* The loaded page's read-only title slot: always empty here. */}
        {null}
        {/* N12: a skeleton of the page's own shapes (title, details row, media,
            caption, comments) from the existing tokens, with a screen-reader
            label. Flow B 25: it stays until every first-paint read settles. */}
        <div aria-busy="true" data-post-skeleton="" className={grid.page}>
          <div aria-hidden className={cn(grid.head, 'flex flex-col gap-3')}>
            <div className="h-8 w-3/4 animate-pulse rounded bg-panel-3" />
            <div className="flex min-h-[44px] items-center gap-2">
              <div className="h-5 w-5 animate-pulse rounded-full bg-panel-3" />
              <div className="h-3 w-24 animate-pulse rounded bg-panel-3" />
              <div className="h-3 w-16 animate-pulse rounded bg-panel-3" />
              <div className="h-3 w-20 animate-pulse rounded bg-panel-3" />
            </div>
          </div>
          <div aria-hidden className={grid.media}>
            <div className="aspect-[4/5] w-full animate-pulse rounded-xl bg-panel-3" />
          </div>
          <div aria-hidden className={cn(grid.body, 'flex flex-col gap-6')}>
            <div className="rounded-xl border border-border bg-panel-2 p-4">
              <div className="h-3 w-full animate-pulse rounded bg-panel-3" />
              <div className="mt-2 h-3 w-5/6 animate-pulse rounded bg-panel-3" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-panel-3" />
            </div>
          </div>
          {sidePanel(true)}
          {/* Last, so the four slots above line up with the loaded grid's. */}
          <span className="sr-only">Loading post</span>
        </div>
      </SearchWordsContext.Provider>
    );
  }

  if (loadError) {
    return (
      <>
        {embedded ? null : (
          <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
            {backButton}
          </div>
        )}
        <div className="px-4 md:px-6 mt-4">
          <LoadError title="this post" onRetry={() => void load()} />
        </div>
      </>
    );
  }

  if (notFound || detail === null) {
    return (
      <>
        {embedded ? null : (
          <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
            {backButton}
          </div>
        )}
        <EmptyState
          icon={<IconPipeline size={ICON_SIZE.tray} />}
          title="Post not found"
          description="This post may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" onClick={goPipeline}>
              Back to pipeline
            </Button>
          }
        />
      </>
    );
  }

  const post = detail.post;
  const currentStage = decisions.stage ?? (post.stage as Stage);
  // #35: version pictures (sheet rows, old-version view), platform-shaped.
  const versionThumbs: VersionThumbs = {
    gallery,
    cache,
    presignEnabled,
    ratio: galleryFrame(post.platform, post.format, gallery, {})?.ratio ?? 4 / 5,
  };
  const ownerInfo = resolveOwner(post.owner_user_id, post.legacy_author_name);
  const hasCaption = post.caption !== null && post.caption.trim() !== '';
  const composerKey = composer !== null ? captionDraftKey(composer.start, composer.end) : null;
  const pinKey =
    pinComposer !== null ? pinDraftKey(pinComposer.index, pinComposer.x, pinComposer.y) : null;

  // Spec A1: one meta line under the title. Owner · "Due 20 Jul" · "From
  // brief: {title}" (a link), each only when it has a value; one line that
  // truncates. Platform and format live in the details sheet.
  // Flow B 37 / spec B4: an approved post is locked. No title edit, caption
  // Edit, gallery tools, slide actions or lightbox edit tools (one lock per
  // row instead), and the meta line no longer opens the details sheet.
  const approvedLocked = currentStage === 'approved';
  const canEditContent = agencySide && !readOnly && !approvedLocked;
  const ownerKnown =
    ownerInfo.name !== '' && !(post.owner_user_id === null && post.legacy_author_name === null);
  const dueLabel = post.target_date !== null ? formatDue(post.target_date, approveTimeZone) : null;
  const detailsEditable = canEditContent;
  const metaDot = (
    <span aria-hidden className="shrink-0 text-fg-3">
      ·
    </span>
  );
  const metaHead: React.ReactNode[] = [];
  if (ownerKnown) {
    metaHead.push(
      <span key="owner" data-detail="owner" className="inline-flex min-w-0 items-center gap-1.5">
        <Avatar
          name={ownerInfo.name}
          role="inline"
          {...(ownerInfo.avatarUrl !== null ? { src: ownerInfo.avatarUrl } : {})}
        />
        <span className="truncate font-medium text-fg">{ownerInfo.name}</span>
        {approvedLocked && agencySide ? (
          <span aria-hidden data-detail-lock="" className="shrink-0 text-fg-3">
            <IconLock size={ICON_SIZE.inline} />
          </span>
        ) : null}
      </span>,
    );
  }
  if (dueLabel !== null) {
    if (metaHead.length > 0) metaHead.push(<span key="due-dot">{metaDot}</span>);
    metaHead.push(
      <span key="due" data-detail="due" className="shrink-0 whitespace-nowrap tabular-nums">
        {dueLabel}
      </span>,
    );
  }
  const briefLink =
    briefName !== null && post.brief_id !== null ? (
      <Link
        data-detail="brief"
        to={briefRoute(post.brief_id)}
        className="inline-flex min-h-[44px] min-w-0 items-center rounded-lg font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="min-w-0 truncate">{fromBriefLabel(briefName)}</span>
      </Link>
    ) : null;
  const metaHeadClass = 'flex min-h-[44px] min-w-0 shrink items-center gap-2 rounded-lg';
  const metaLine =
    metaHead.length > 0 || briefLink !== null ? (
      <div
        data-post-details=""
        className="flex min-h-[44px] min-w-0 max-w-full flex-nowrap items-center gap-2 overflow-hidden text-sm text-fg-3"
      >
        {metaHead.length > 0 ? (
          detailsEditable ? (
            <PressableRow
              inline
              type="button"
              data-post-details-edit=""
              onClick={() => setShowDetails(true)}
              className={cn(metaHeadClass, '-mx-1 px-1 transition-colors')}
            >
              {metaHead}
            </PressableRow>
          ) : (
            <div className={metaHeadClass}>{metaHead}</div>
          )
        ) : null}
        {metaHead.length > 0 && briefLink !== null ? metaDot : null}
        {briefLink}
      </div>
    ) : detailsEditable ? (
      // Nothing to show yet: the line is still the way into the details sheet.
      <IconButton
        type="button"
        data-post-details-edit=""
        label="Post details"
        onClick={() => setShowDetails(true)}
        className="text-fg-3"
      >
        <IconCalendar size={ICON_SIZE.control} />
      </IconButton>
    ) : null;

  // Flow B 29: "{n} open comments" under the title while in review; a tap
  // scrolls to the comments. Hidden at 0.
  const openCommentsChip =
    currentStage === 'review' && openCount > 0 && !readOnly ? (
      <Button
        type="button"
        variant="secondary"
        data-open-comments-chip=""
        onClick={() => scrollToCommentsSection()}
      >
        <IconChat size={ICON_SIZE.inline} />
        {openCommentsLabel(openCount)}
        <IconChevronDown size={ICON_SIZE.inline} />
      </Button>
    ) : null;

  // The decision row, rendered ONCE per breakpoint (usePostDecisions builds
  // it, the same as the chat post sheet). Laptop: the buttons at the right of
  // the header, beside the ⋯; the approver's note and a failed tap's error stay
  // in the content's decision slot. Phone: the same row in the bottom bar
  // (T12 / FN8), and only the note stays inline, under the caption. Embedded
  // (a plan item): the whole row inline. A failed tap's error shows inside
  // whichever row is on screen, so role=alert never duplicates.
  const stageHelper = decisions.note;
  const decisionModel = decisions.model;
  const decisionBusy = decisions.busy;
  const actionError = decisions.error;
  const phoneLayout = !isLaptop && !embedded;
  // Flow B 27: the stage shows once, in the top bar; with no moves to offer
  // (and nothing to say) nothing is rendered.
  const headerDecision = isLaptop && !embedded && !readOnly;
  const stageSection = readOnly ? null : (
    <PostDecisionRow
      model={headerDecision ? null : decisionModel}
      busy={decisionBusy}
      error={actionError}
      note={stageHelper}
    />
  );
  const headerStageAction = headerDecision ? (
    <div data-header-decision="" className="shrink-0">
      <PostDecisionRow model={decisionModel} busy={decisionBusy} error={null} />
    </div>
  ) : null;
  const phoneStageNotes =
    stageHelper !== null ? (
      <section className="rounded-xl border border-border bg-panel-2 p-4">
        <p className="text-base text-fg-2">{stageHelper}</p>
      </section>
    ) : null;
  const decisionBar =
    phoneLayout && !readOnly ? (
      <PostDecisionBar model={decisionModel} busy={decisionBusy} error={actionError} />
    ) : null;
  const decisionBarShown = decisionBar !== null && (decisionModel !== null || actionError !== null);
  const decisionBarPx = decisionBarSpace(decisionModel, actionError);
  const decisionBarHeight = `calc(${decisionBarPx}px + env(safe-area-inset-bottom))`;

  // Spec B4: beside the lock, how to change it, and (agency roles, when the
  // move is legal) "Move to Parked", which opens the existing park confirm.
  // Who approved is not repeated here (the top bar already says Approved).
  const canParkApproved = decisions.moveRows.some((row) => row.key === 'parked');
  const approvedBanner =
    approvedLocked && !readOnly ? (
      <div
        data-approved-banner=""
        className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl bg-good-soft px-3.5 py-2 text-base text-fg"
      >
        <span aria-hidden className="shrink-0 text-good">
          <IconLock size={ICON_SIZE.nav} />
        </span>
        <p className="min-w-0 flex-1 py-2">{APPROVED_LOCK_LINE}</p>
        {canParkApproved ? (
          <Button
            data-approved-park=""
            className="shrink-0"
            onClick={() => decisions.pick('parked')}
          >
            {MOVE_TO_PARKED_LABEL}
          </Button>
        ) : null}
      </div>
    ) : null;

  // The post ⋯ menu (ui/ActionMenu): its default trigger at the top right of
  // the header, or, embedded, opened by the host's own header button. Live
  // PCS only, never an old version or a compare.
  const actionMenu = readOnly ? null : (
    <PostActionSheet
      open={actionsOpen}
      onOpenChange={setActionsOpen}
      {...(embedded ? { trigger: null } : {})}
      postId={post.id}
      workspaceId={workspaceId ?? ''}
      currentUserId={userId ?? ''}
      gallery={gallery}
      deps={deps}
      workspaceKey={workspaceKey}
      postNumber={post.number}
      onToast={toastWithTone}
      canDelete={canDelete}
      onDeletePost={handleDeletePost}
      moveRows={decisions.moveRows}
      removeImage={
        canEditContent && gallery.length > 0
          ? {
              index: Math.min(galleryIndex, gallery.length - 1),
              count: gallery.length,
              saving: gallerySaving,
              onRemove: () => handleRemove(Math.min(galleryIndex, gallery.length - 1)),
            }
          : undefined
      }
      {...(onOpenInPipeline !== undefined ? { onOpenInPipeline } : {})}
    />
  );
  mark('post:first-paint');

  return (
    <SearchWordsContext.Provider value={searchJump.words}>
      {embedded ? null : (
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              aria-hidden
              className={`h-[7px] w-[7px] shrink-0 rounded-full ${STAGE_DOT[currentStage]}`}
            />
            <span className="truncate text-lg font-semibold">
              {postStatusLine(currentStage, post.updated_at, post.stage_entered_at, new Date())}
            </span>
          </div>
          {headerStageAction}
          {actionMenu !== null ? (
            <div data-header-more="" className="shrink-0">
              {actionMenu}
            </div>
          ) : (
            <div className="h-11 w-11 shrink-0" />
          )}
        </div>
      )}

      {/* An old version or a compare: the title stays (one h1), every write
          affordance is gone. */}
      {readOnly ? (
        <div className={cn(grid.page, 'pb-0')}>
          <div className={grid.head}>
            <h1 className="text-3xl font-semibold tracking-tight break-words [overflow-wrap:anywhere]">
              <Highlight text={post.title} />
            </h1>
          </div>
        </div>
      ) : null}

      {comparing && compareFrom !== null && compareTo !== null ? (
        <CompareVersionsView
          fromVersionNumber={compareFrom.versionNumber}
          toVersionNumber={compareTo.versionNumber}
          fromCreatedAt={compareFrom.createdAt}
          toCreatedAt={compareTo.createdAt}
          fromCaption={parseSnapshot(compareFrom.snapshot).caption}
          toCaption={parseSnapshot(compareTo.snapshot).caption}
          onBack={() => setCompareIds(null)}
        />
      ) : readOnly && viewingVersion !== null && currentVersionNumber !== null ? (
        <ReadOnlyVersionView
          versionNumber={viewingVersion.versionNumber}
          currentVersionNumber={currentVersionNumber}
          caption={viewingSnapshot?.caption ?? null}
          imageCount={viewingSnapshot?.galleryVersionIds.length ?? 0}
          galleryVersionIds={viewingSnapshot?.galleryVersionIds ?? []}
          thumbs={versionThumbs}
          onBack={() => setViewingVersionId(null)}
        />
      ) : (
        <div className={grid.page}>
          <div className={cn(grid.head, 'flex flex-col gap-3')}>
            {canEditContent ? (
              editingTitle ? (
                <div className="flex flex-col gap-2">
                  <input
                    autoFocus
                    aria-label="Post title"
                    value={titleDraft}
                    disabled={savingMeta}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={onTitleBlur}
                    onKeyDown={onTitleKeyDown}
                    // Spec B1 / A3: the same type, line height, padding and
                    // 44px floor as the tappable title, with no border (the
                    // ring draws outside the box), so entering edit never
                    // shifts the page.
                    className="-mx-2 block min-h-[44px] w-[calc(100%+1rem)] rounded-lg border-0 bg-panel-2 px-2 py-1 text-3xl font-semibold tracking-tight text-fg outline-none ring-1 ring-border focus:ring-2 focus:ring-accent-line"
                  />
                  {isTouchDevice() ? (
                    // FN9: a phone has no Enter / Escape to hand; Save and Cancel are
                    // visible. pointerdown is swallowed so the input's blur-save never
                    // runs ahead of (or instead of) the tapped button.
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        disabled={savingMeta}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => {
                          suppressTitleBlur.current = true;
                          void saveTitle();
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={savingMeta}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => {
                          suppressTitleBlur.current = true;
                          setEditingTitle(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                // Spec A3: the title itself is the edit target (no pencil
                // tile): at least 44px tall, a visible focus ring, and the
                // same padding as the editor so tapping never shifts the page.
                <h1 className="text-3xl font-semibold tracking-tight break-words [overflow-wrap:anywhere]">
                  {/* inline (w-auto) on a block: the -mx-2 bleed widens it to the
                      full title column plus the padding, no width calc needed. */}
                  <PressableRow
                    inline
                    type="button"
                    data-title-edit=""
                    onClick={openTitleEditor}
                    className="-mx-2 block px-2 py-1 font-semibold tracking-tight transition-colors"
                  >
                    <Highlight text={post.title} />
                  </PressableRow>
                </h1>
              )
            ) : (
              <h1
                data-post-title=""
                className="text-3xl font-semibold tracking-tight break-words [overflow-wrap:anywhere]"
              >
                <Highlight text={post.title} />
                {approvedLocked && agencySide ? (
                  <span
                    aria-hidden
                    data-title-lock=""
                    className="ml-2 inline-flex align-middle text-fg-3"
                  >
                    <IconLock size={ICON_SIZE.inline} />
                  </span>
                ) : null}
              </h1>
            )}

            {/* Spec A1: one meta line (owner, due, brief); agency roles tap
              it to open the details sheet while the post is not approved. */}
            {metaLine}
            {/* Spec A2: the preview pill and the open checkpoints pill share
              one row. */}
            <div data-post-pills="" className="flex flex-wrap items-center gap-x-2">
              <PreviewChip platform={post.platform} onClick={() => setPreviewOpen(true)} />
              {openCommentsChip}
            </div>
            {/* Flow B 37: the approved lock, under the title and details. */}
            {approvedBanner}
            {/* DECISION ROW SLOT (flow B 30 / 34): on md (and embedded) the
              approver / creator decision row renders here, under the details
              and above the caption. Below md the same row lives in the sticky
              PostDecisionBar; at lg its buttons sit in the header bar and only
              the note and a failed tap's error stay here. */}
            {phoneLayout ? null : stageSection}
          </div>

          <div className={cn(grid.media, 'flex flex-col gap-3')}>
            <section>
              {/* Flow B 36: a failed gallery read is never shown as an empty
                gallery: "Couldn't load the pictures." with Retry instead. */}
              {galleryLoadError ? (
                <LoadError
                  title="the pictures"
                  retrying={galleryRetrying}
                  onRetry={() => void retryGallery()}
                />
              ) : (
                <PostGallery
                  items={gallery}
                  cache={cache}
                  deps={deps}
                  presignEnabled={presignEnabled}
                  pinOverlay={(item) => (
                    <PinOverlay
                      pins={pinsByAttachment[item.assetAttachmentId] ?? []}
                      onPinClick={(commentId) => flashTo(`comment-${commentId}`)}
                    />
                  )}
                  frame={{
                    platform: post.platform,
                    format: post.format,
                    platformLabel: platformLabel(post.platform),
                  }}
                  onSeePreview={() => setPreviewOpen(true)}
                  pinsFor={(item) => pinsByAttachment[item.assetAttachmentId] ?? []}
                  onPinClick={(commentId) => flashTo(`comment-${commentId}`)}
                  onRequestPin={handleRequestPin}
                  onPlacePin={handlePlacePin}
                  pinCountFor={(item) => pinsByAttachment[item.assetAttachmentId]?.length ?? 0}
                  onSlideActions={
                    canEditContent ? (index: number) => setSlideIndex(index) : undefined
                  }
                  onAddSlide={canEditContent ? () => openAdd({ mode: 'append' }) : undefined}
                  onAddAfter={
                    canEditContent
                      ? (index: number) => openAdd({ mode: 'insertAfter', index })
                      : undefined
                  }
                  onRemove={canEditContent ? handleRemove : undefined}
                  onActiveIndexChange={setGalleryIndex}
                  saving={gallerySaving}
                  tools={{
                    // #26 / flow B 37: creators edit on draft / review / parked /
                    // rejected only; an approved post is locked.
                    canEdit: canEditContent,
                    locked: agencySide && approvedLocked,
                    versionNumber: currentVersionNumber,
                    error: galleryError,
                    onVersions: () => setHistoryOpen(true),
                    onAdd: () => openAdd({ mode: 'append' }),
                    onReplace: (index) => openAdd({ mode: 'replace', index }),
                    onSaveOrder: commitGallery,
                  }}
                />
              )}
              {gallerySaving ? (
                <p aria-live="polite" className="mt-2.5 text-sm text-fg-3">
                  Saving…
                </p>
              ) : null}
              {pinError !== null ? <ErrorNote className="mt-3">{pinError}</ErrorNote> : null}
            </section>
          </div>

          <div className={cn(grid.body, 'flex flex-col gap-6')}>
            {/* The caption block reads like the post (mock P1): the workspace
              as the author row, Edit at the right, the caption text below.
              Flow B 27: platform and format live once, in the details row;
              the version button lives in the gallery tools row. */}
            <section
              data-caption-block=""
              className="rounded-xl border border-border bg-panel-2 p-4"
            >
              <div className="flex items-center gap-3">
                <Avatar name={workspaceName ?? ''} role="header" kind="group" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-medium text-fg">
                    {workspaceName ?? ''}
                  </div>
                </div>
                {hasCaption && !editingCaption ? (
                  <IconButton
                    label="Copy caption"
                    onClick={() => {
                      void copyText(post.caption ?? '').then((ok) => {
                        if (ok) push('Caption copied');
                        else pushError(COPY_FAILED);
                      });
                    }}
                  >
                    <IconCopy size={ICON_SIZE.nav} />
                  </IconButton>
                ) : null}
                {agencySide && approvedLocked ? (
                  <span
                    aria-hidden
                    data-caption-lock=""
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-fg-3"
                  >
                    <IconLock size={ICON_SIZE.inline} />
                  </span>
                ) : null}
                {canEditContent && !editingCaption ? (
                  <Button
                    type="button"
                    variant="ghost"
                    data-caption-edit=""
                    onClick={openCaptionEditor}
                    className="shrink-0"
                  >
                    <IconEdit size={ICON_SIZE.inline} />
                    Edit
                  </Button>
                ) : null}
              </div>
              {editingCaption ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Textarea
                    autoFocus
                    autoGrow
                    aria-label="Caption"
                    value={captionDraft}
                    disabled={captionSaving}
                    onChange={(event) => setCaptionDraft(event.target.value)}
                  />
                  {captionError !== null ? (
                    <div role="alert" className="text-base text-bad">
                      {captionError}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      disabled={captionSaving}
                      onClick={() => void saveCaption()}
                    >
                      {captionSaving ? 'Saving…' : captionSaveLabel(currentVersionNumber)}
                    </Button>
                    <Button variant="ghost" disabled={captionSaving} onClick={cancelCaptionEdit}>
                      Cancel
                    </Button>
                    <span className="ml-auto text-sm tabular-nums text-fg-3">
                      {captionDraft.trim().length}/5000
                    </span>
                  </div>
                  {captionSaveNote(currentVersionNumber) !== null ? (
                    <p className="text-sm text-fg-3">{captionSaveNote(currentVersionNumber)}</p>
                  ) : null}
                </div>
              ) : hasCaption ? (
                <>
                  <div className="mt-3" data-induction={INDUCTION_KEYS.postCaptionText}>
                    <CaptionView
                      caption={post.caption ?? ''}
                      annotations={highlights}
                      onHighlightClick={(commentId) => flashTo(`comment-${commentId}`)}
                      onAnnotate={handleAnnotate}
                    />
                  </div>
                  {captionTipOpen ? (
                    <div
                      data-caption-tip=""
                      className="mt-2 flex items-center gap-2 text-sm text-fg-3"
                    >
                      <span>{CAPTION_TIP_TEXT}</span>
                      <Button
                        type="button"
                        variant="link"
                        onClick={() => {
                          setCaptionTipOpen(false);
                          dismissCaptionTip(userId);
                        }}
                        className="ml-auto shrink-0"
                      >
                        Got it
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="mt-3 text-base text-fg-2">No caption yet.</p>
              )}
              {annotateError !== null ? (
                <ErrorNote className="mt-3">{annotateError}</ErrorNote>
              ) : null}
            </section>

            {phoneLayout ? phoneStageNotes : null}
          </div>

          {/* Spec D1: the checkpoints column, the same element the skeleton
            mounted (see sidePanel). */}
          {sidePanel(false, decisionBarShown ? decisionBarHeight : undefined)}
        </div>
      )}

      {/* The sticky decision bar (phone) and the room under the content so it
          never covers the comment composer. */}
      {decisionBarShown ? (
        <div
          aria-hidden
          data-decision-bar-space=""
          style={{ height: decisionBarHeight }}
        />
      ) : null}
      {decisionBar}

      <CaptionAnnotationComposer
        open={composer !== null}
        quote={composer?.quote ?? ''}
        body={composerKey !== null ? (commentDrafts[composerKey] ?? '') : ''}
        onBodyChange={(body) => {
          if (composerKey !== null) setDraft(composerKey, body);
        }}
        submitting={annotating}
        error={composerError}
        onCancel={() => {
          if (!annotating) setComposer(null);
        }}
        onDiscard={() => {
          if (annotating) return;
          if (composerKey !== null) dropDraft(composerKey);
          setComposer(null);
        }}
        onSubmit={submitAnnotation}
      />

      <PinAnnotationComposer
        open={pinComposer !== null}
        context={
          pinComposer !== null
            ? (gallery[pinComposer.index]?.filename ?? `Slide ${pinComposer.index + 1}`)
            : ''
        }
        body={pinKey !== null ? (commentDrafts[pinKey] ?? '') : ''}
        onBodyChange={(body) => {
          if (pinKey !== null) setDraft(pinKey, body);
        }}
        submitting={pinSubmitting}
        error={composerError}
        onCancel={() => {
          if (!pinSubmitting) setPinComposer(null);
        }}
        onDiscard={() => {
          if (pinSubmitting) return;
          if (pinKey !== null) dropDraft(pinKey);
          setPinComposer(null);
        }}
        onSubmit={submitPinAnnotation}
      />

      {decisions.confirms}

      {confirmCaptionDiscard ? (
        <ConfirmDialog
          title="Discard your changes?"
          message="Your caption edits will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setConfirmCaptionDiscard(false);
            setEditingCaption(false);
            setCaptionError(null);
          }}
          onCancel={() => setConfirmCaptionDiscard(false)}
        />
      ) : null}

      <PostDetailsSheet
        open={showDetails}
        onClose={() => setShowDetails(false)}
        workspaceId={workspaceId ?? ''}
        timeZone={approveTimeZone}
        isAgencySide={agencySide}
        isClient={clientRole}
        bucketId={post.bucket_id}
        ownerUserId={post.owner_user_id}
        targetDate={post.target_date}
        memberOptions={memberOptions}
        ownerName={ownerInfo.name}
        ownerAvatarUrl={ownerInfo.avatarUrl}
        onChangeBucket={(bucketId) => void applyPostUpdate({ bucketId })}
        onChangeOwner={(ownerUserId) => void applyPostUpdate({ ownerUserId })}
        onChangeTargetDate={(targetDate) => void applyPostUpdate({ targetDate })}
        onCreateBucket={(name) => {
          if (workspaceId === null) {
            return Promise.resolve({
              ok: false as const,
              error: {
                code: 'unknown' as const,
                message: "Couldn't create the bucket. Try again.",
              },
            });
          }
          return createBucket(supabase, workspaceId, name, newTrace());
        }}
        lockedFields={approvedLocked}
        platformFormat={`${platformLabel(post.platform)} · ${postFormatLabel(post.format, post.platform)}`}
      />

      <PlatformPreviewPanel
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        platform={post.platform}
        format={post.format}
        caption={post.caption ?? ''}
        handle={workspaceName ?? ''}
        firstMedia={gallery[0] ?? null}
        cache={cache}
        presignEnabled={presignEnabled}
      />

      <SlideActionsSheet
        open={slideIndex !== null && canEditContent}
        onClose={() => setSlideIndex(null)}
        index={slideIndex ?? 0}
        count={gallery.length}
        onAddAfter={() => {
          if (slideIndex !== null) openAdd({ mode: 'insertAfter', index: slideIndex });
        }}
        onRemove={() => {
          if (slideIndex !== null) handleRemove(slideIndex);
        }}
        saving={gallerySaving}
      />

      <AssetUploadSheet
        open={addTarget !== null}
        onClose={() => {
          uploadedVersionIds.current = [];
          setAddTarget(null);
        }}
        onSubmit={
          uploadEndpoint !== undefined && uploadEndpoint !== '' ? handleUploadFile : undefined
        }
        onToast={toastWithTone}
        onUploaded={() => void handleUploaded()}
        siblingLabels={rootLabels}
        defaultBaseName={post.title}
      />

      <VersionHistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        versions={versionViews}
        currentVersionNumber={currentVersionNumber}
        resolveAuthor={resolveAuthorName}
        thumbs={versionThumbs}
        onSelectVersion={(id) => {
          setCompareIds(null);
          setViewingVersionId(id);
          setHistoryOpen(false);
        }}
        onCompare={(fromId, toId) => {
          setViewingVersionId(null);
          setCompareIds({ fromId, toId });
          setHistoryOpen(false);
        }}
      />

      {/* Embedded: the host's own header button opens the menu. */}
      {embedded ? actionMenu : null}
    </SearchWordsContext.Provider>
  );
}
