import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { FORMER_MEMBER } from '@/lib/people-names';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ApproveConfirm, approveTargetDate } from '@/components/ui/ApproveConfirm';
import { OnBehalfApproveSheet } from '@/components/ui/OnBehalfApproveSheet';
import { useWorkspaceApprovers } from '@/components/pages/pcs/use-approvers';
import { briefRoute } from '@/lib/chat/briefs';
import { Sheet } from '@/components/ui/Sheet';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { Textarea } from '@/components/ui/Textarea';
import { Comments, runCreateCommentBatch } from '@/components/comments/Comments';
import type { CommentCounts } from '@/components/comments/Comments';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { dispatchInductionDid, dispatchInductionRefresh, INDUCTION_KEYS } from '@/lib/induction';
import type { CommentAnnotation } from '@/components/comments/Comments';
import { flashNode } from '@/components/comments/flash-node';
import { Highlight, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useSearchJump } from '@/lib/search/jump';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  IconBriefs,
  IconCalendar,
  IconChat,
  IconChevronDown,
  IconChevronLeft,
  IconCheck,
  IconCopy,
  IconLock,
  IconPause,
  IconPipeline,
  IconX,
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
import { runPostReadyNotify } from '@/components/pages/pcs/PostReadyNotice';
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
import { usePostMembers } from '@/components/pages/pcs/use-post-members';
import { canDeletePost, isAgencySide, isClient } from '@/components/pages/pcs/roles';
import {
  STAGE_REASON_LABEL,
  stageReasonComment,
  stageReasonConfirm,
  visibleStageActions,
  type StageReasonConfirmCopy,
} from '@/components/pages/pcs/stage-actions';
import { sheetTitle } from '@/components/chat/post-sheet';
import {
  useApproveGate,
  type ApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { IconPencil, IconMoreVertical } from '@/components/pages/pcs/post-icons';
import { PostActionSheet, type PostMoveRow } from '@/components/pages/pcs/PostActionSheet';
import {
  append,
  galleryWriteErrorCopy,
  insertAfter,
  POST_APPROVED_LOCKED,
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
  SEND_AGAIN_LABEL,
  type DecisionModel,
} from '@/components/pages/pcs/PostDecisionBar';
import { runStageMoveCommit, showWhenVisible } from '@/components/pages/pcs/stage-move-commit';
import {
  CAPTION_TIP_TEXT,
  captionTipDismissed,
  dismissCaptionTip,
} from '@/components/pages/pcs/caption-tip';
import { hasInAppHistory } from '@/components/pages/pcs/post-nav';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { createBucket, listBuckets, type BucketOption } from '@/lib/buckets';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import type { PresignDeps } from '@/lib/asset-presign';
import { displayLabel, fetchMemberRole, listAssets } from '@/lib/assets';
import { uploadAssetFile, type UploadOutcome } from '@/lib/asset-upload';
import { useNewTrace } from '@/lib/trace-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { formatDue } from '@/lib/display-date';
import {
  annotationCreate,
  getPost,
  getPostGallery,
  gallerySet,
  postCaptionUpdate,
  postUpdate,
  stageTransition as stageMove,
} from '@srtdio/posts';
import type { GalleryItem, PostDetail, PostUpdateInput, Stage } from '@srtdio/posts';
import { friendlyTransitionError } from '@/lib/post-transition-errors';
import { errorText } from '@/lib/error-copy';
import { createComment } from '@srtdio/comments';
import { getBrief } from '@srtdio/briefs';
import type { Json } from '@srtdio/schemas';
import { postSoftDelete, stageTransition } from '@srtdio/rpc';
import type { DomainError } from '@srtdio/rpc';

/** Where an upload run lands in the gallery (#26 adds Replace). */
type AddTarget =
  | { mode: 'append' }
  | { mode: 'insertAfter'; index: number }
  | { mode: 'replace'; index: number };

// A refused RPC carries a DomainError ({ code, message }); a thrown transport
// error does not, and reads as the unknown line.
function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * Flow B 37 / 41: a failed stage move or edit on this page in plain words,
 * "Couldn't {action}. {reason}". The approved lock and the stage proc's known
 * refusals get their own reason; anything else (a thrown transport error
 * included) the retry line. Never the raw text. Pure.
 */
export function postActionErrorCopy(error: unknown, action = 'move the post'): string {
  if (isDomainError(error) && !error.message.includes(POST_APPROVED_LOCKED)) {
    if (
      error.code === 'forbidden_role' ||
      error.code === 'invalid_stage_transition' ||
      error.code === 'workspace_member_only'
    ) {
      return friendlyTransitionError(error, action);
    }
  }
  return errorText(action, error);
}

/** The action a failed "Send for review again" names. */
const SEND_AGAIN_ACTION = 'send the post for review';

/**
 * Flow B 33 / 41: a failed "Send for review again" (post_ready_notify) in plain
 * words, from the proc's raised message. Pure.
 */
export function sendAgainErrorCopy(message: string | null): string {
  if (message === 'invalid_stage') {
    return `Couldn't ${SEND_AGAIN_ACTION}. It isn't in review anymore.`;
  }
  return errorText(SEND_AGAIN_ACTION, message);
}

/** Flow B 33: the toast after a landed "Send for review again". */
export const SENT_AGAIN_TOAST = 'Sent for review again';

/**
 * Flow B 31: the creator's on-behalf approve row in the ⋯ sheet. Always
 * "Approve on their behalf", whatever the workspace is called.
 */
export const APPROVE_ON_BEHALF_LABEL = 'Approve on their behalf';

/**
 * Flow B 33: the confirm before "Send for review again" while comments are
 * still open. Open comments never block the send; they only ask first.
 */
export function sendAnywayTitle(openCount: number): string {
  return openCount === 1
    ? '1 comment is still open. Send anyway?'
    : `${openCount} comments are still open. Send anyway?`;
}
export const SEND_ANYWAY_LABEL = 'Send anyway';

/**
 * Flow B 40 / spec B6: the reject confirm's reason field label. The "optional,
 * goes to the comments" idea is said once, here; the body and the menu row
 * no longer repeat it.
 */
export const REJECT_REASON_LABEL = 'Reason (optional)';
export function rejectConfirmBody(creatorName: string | null): string {
  const first = creatorName?.trim().split(/\s+/)[0] ?? '';
  return `${first !== '' ? first : 'The creator'} gets it back to rework.`;
}

/** Spec B4: the approved banner beside the lock. */
export const APPROVED_LOCK_LINE = 'To make changes, move it to Parked.';
/** Spec B4: the banner's button (agency roles only). */
export const MOVE_TO_PARKED_LABEL = 'Move to Parked';

/** Spec B5: the approver's line above Approve / Reject while in review. */
export const CLIENT_REVIEW_NOTE = 'Review and approve one post at a time.';

/** Spec B2: the header line's brief part, "From brief: {title}". */
export function fromBriefLabel(briefTitle: string): string {
  return `From brief: ${briefTitle}`;
}
import { formatLabel, postStatusLine } from '@/lib/post-detail-presentation';
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

// Split a title into everything-but-the-last-word and the last word, so the body
// title can keep the trailing edit pencil glued to the final word (wrapped in a
// nowrap span) instead of letting the glyph wrap onto its own line.
function splitLastWord(title: string): { head: string; last: string } {
  const words = title.split(' ');
  const last = words.pop() ?? title;
  return { head: words.join(' '), last };
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

/** Flow B 29: the chip under the title, "1 open comment" / "{n} open comments". */
export function openCommentsLabel(count: number): string {
  return `${count} open ${count === 1 ? 'comment' : 'comments'}`;
}

/**
 * Flow B 29: scroll the comments section into view, smooth unless the viewer
 * asked for reduced motion. Best-effort: a missing node is a no-op.
 */
export function scrollToCommentsSection(doc: Document = document): void {
  const node = doc.getElementById(COMMENTS_SECTION_ID);
  if (node === null) return;
  const view = doc.defaultView;
  const reduce =
    view !== null &&
    typeof view.matchMedia === 'function' &&
    view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/**
 * Flow B 30: the approver's Comment puts the caret in the comment box (the
 * root composer at the end of the comments) and brings it into view. With no
 * box on screen it falls back to scrolling to the comments. Returns whether a
 * box took focus.
 */
export function focusCommentComposer(doc: Document = document): boolean {
  const box = doc.querySelector<HTMLElement>(
    `#${COMMENTS_SECTION_ID} [data-comments-composer] textarea, #${COMMENTS_SECTION_ID} [data-comments-composer] [contenteditable]:not([contenteditable="false"])`,
  );
  if (box === null) {
    scrollToCommentsSection(doc);
    return false;
  }
  const view = doc.defaultView;
  const reduce =
    view !== null &&
    typeof view.matchMedia === 'function' &&
    view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.focus({ preventScroll: true });
  box.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  return true;
}

/**
 * Flow B 34: the page grid, shared by the skeleton and the loaded page so the
 * first paint never jumps. Below lg (phone, tablet portrait) one column: head
 * (title, details, chip), media, body (caption, comments). lg and up: the
 * picture on the left (at most 520px, the frame keeps the platform shape), the
 * head and body stacked on the right; page at most 1120px, centred. Embedded
 * (inside another screen) always stays one column.
 */
export function postPageGrid(embedded: boolean): {
  page: string;
  head: string;
  media: string;
  body: string;
} {
  if (embedded) {
    return {
      page: 'grid grid-cols-1 gap-4 px-4 md:px-6 pt-4 pb-6',
      head: 'min-w-0',
      media: 'min-w-0',
      body: 'min-w-0',
    };
  }
  return {
    page: 'mx-auto grid w-full max-w-[1120px] grid-cols-1 gap-4 px-4 md:px-6 pt-4 pb-6 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-8',
    head: 'min-w-0 lg:col-start-2 lg:row-start-1',
    media: 'min-w-0 lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:self-start',
    body: 'min-w-0 lg:col-start-2 lg:row-start-2',
  };
}

/**
 * The approve confirm (decision 22): the shared Sheet (translateY axis) with the
 * chat-matching confirm in its footer. The question names the post once (spec
 * B8 / D3: no title repeated above it). Open while the approve waits on a
 * confirm or is in flight;
 * a failure keeps it open with the error and Confirm re-armed. Back, the close
 * button, the backdrop and Escape send nothing. Hookless, so it is unit tested
 * by walking the tree.
 */
export function PcsApproveConfirm(props: {
  gate: ApproveGate;
  gateState: GateState;
  format: string;
  title: string;
  /** Slides in the loaded gallery; null leaves the clause out. */
  mediaCount: number | null;
  targetDate: string;
  busy: boolean;
  error: string | null;
}) {
  const { gate, gateState } = props;
  return (
    <Sheet
      open={gateState.pendingId !== null}
      onClose={gate.cancel}
      title={sheetTitle(props.format)}
      footer={
        <ApproveConfirm
          postTitle={props.title}
          mediaCount={props.mediaCount}
          targetDate={props.targetDate}
          error={props.error}
          busy={props.busy || gateState.sent}
          onBack={gate.cancel}
          onConfirm={gate.confirm}
          induction={INDUCTION_KEYS.postApproveConfirm}
        />
      }
    >
      {null}
    </Sheet>
  );
}

/**
 * The reject / park confirm (W2): the shared Sheet with an optional reason that
 * goes to the comments, Cancel and the destructive Reject / Park. Confirm hands
 * off to the page, which shows the new stage at once behind an Undo toast and
 * only sends the move when the window ends. Hookless, so it is unit tested by
 * walking the tree.
 */
export function StageReasonConfirm(props: {
  copy: StageReasonConfirmCopy | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Flow B 40: the line under the title (reject: who gets it back), or none. */
  body?: string | null;
  /** The reason field's label; the shared park / reject label when absent. */
  label?: string;
  /** A quiet line under the field (reject: "Goes to the comments."), or none. */
  helper?: string | null;
}) {
  const { copy } = props;
  const label = props.label ?? STAGE_REASON_LABEL;
  const body = props.body ?? null;
  const helper = props.helper ?? null;
  return (
    <Sheet
      open={copy !== null}
      onClose={props.onCancel}
      title={copy?.title ?? ''}
      // FT12: a typed reason is unsaved input: Esc, X, the backdrop and system
      // Back all ask before dropping it.
      dirty={props.reason.trim() !== ''}
      discard={{ title: 'Discard your reason?', message: 'Your reason will be lost.' }}
      footer={
        <>
          <Button size="lg" className="ml-auto" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="lg" variant="danger" data-stage-confirm="" onClick={props.onConfirm}>
            {copy?.confirmLabel ?? ''}
          </Button>
        </>
      }
    >
      {body !== null ? (
        <p data-stage-confirm-body="" className="mb-3 text-sm text-fg-2">
          {body}
        </p>
      ) : null}
      <label className="flex flex-col gap-2">
        <span className="text-sm text-fg-2">{label}</span>
        <Textarea
          aria-label={label}
          value={props.reason}
          onChange={(event) => props.onReasonChange(event.target.value)}
        />
        {helper !== null ? (
          <span data-stage-confirm-helper="" className="text-xs text-fg-3">
            {helper}
          </span>
        ) : null}
      </label>
    </Sheet>
  );
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
}: {
  postId?: string;
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

  // Email deep-link: ?comment={commentId} focuses that comment row. Captured into
  // state so it survives the immediate strip below, then handed to Comments which
  // flashes it once the row loads. Fired once per distinct id; only 'comment' is
  // stripped, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  // A search jump's words: coloured in the title, caption and comments until
  // this page unmounts (the target comment comes through ?comment= below).
  const searchJump = useSearchJump(!embedded);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const handledCommentParam = useRef<string | null>(null);
  useEffect(() => {
    if (embedded) return;
    const comment = searchParams.get('comment');
    if (comment === null || comment === '') return;
    if (handledCommentParam.current === comment) return;
    handledCommentParam.current = comment;
    setFocusCommentId(comment);
    // Strip 'comment' in place (replace): the deep link never adds a history entry.
    const next = new URLSearchParams(searchParams);
    next.delete('comment');
    setSearchParams(next, { replace: true });
  }, [embedded, searchParams, setSearchParams]);

  // The sticky phone decision bar shows below md; md and up keep the stage
  // card inline (the laptop two-column layout itself switches at lg).
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const [detail, setDetail] = useState<PostDetail | null>(null);
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

  const [transitioning, setTransitioning] = useState(false);
  // Flow B 41: a failed move shows once, where it was tapped. actionError
  // belongs to the decision row / bar (and the reject / park commit); a failed
  // approve shows only inside the approve confirm (approveError).
  const [actionError, setActionError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  // Flow B 33: "Send for review again" (post_ready_notify) in flight.
  const [notifying, setNotifying] = useState(false);
  // Flow B 33: the "{n} comments are still open. Send anyway?" confirm.
  const [confirmSendAnyway, setConfirmSendAnyway] = useState(false);
  // Spec D: the agency's "Approve on their behalf" sheet, its in-flight flag
  // and its one error line (shown inside the sheet only).
  const [onBehalfOpen, setOnBehalfOpen] = useState(false);
  const [onBehalfBusy, setOnBehalfBusy] = useState(false);
  const [onBehalfError, setOnBehalfError] = useState<string | null>(null);

  // Reject / park (W2): the confirm's target and reason, then the stage shown
  // optimistically while the Undo window runs. The move is sent only when the
  // window ends; Undo clears the optimistic stage and sends nothing.
  const [reasonTarget, setReasonTarget] = useState<Stage | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const [optimisticStage, setOptimisticStage] = useState<Stage | null>(null);
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

  // Caption annotation state: the pending selection drives the composer, and a
  // bump of commentsRefresh re-fetches the comments list after a post.
  const [composer, setComposer] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );
  const [annotating, setAnnotating] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [commentsRefresh, setCommentsRefresh] = useState(0);
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
  const {
    options: memberOptions,
    loading: membersLoading,
    error: membersError,
  } = usePostMembers(workspaceId);
  // Only a list that loaded proves someone is not a current member: until then a
  // person not in it renders nothing extra, never "Former member".
  const membersLoaded = !membersLoading && membersError === null;
  // The workspace's approvers, for the on-behalf approve sheet's picker.
  const approvers = useWorkspaceApprovers(workspaceId);

  const [showDetails, setShowDetails] = useState(false);
  // Workspace buckets, fetched once per workspace to resolve the post's bucket
  // chip (mirrors PostDetailsSheet). A failure leaves the list empty: the chip
  // simply does not render, no spinner, no flash.
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [bucketsLoaded, setBucketsLoaded] = useState(false);
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
    void listAssets(supabase, workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        logger.warn('post page: root asset labels read failed', { error: result.error.message });
      }
      setRootLabels(
        result.ok ? result.data.filter((item) => item.folderId === null).map(displayLabel) : [],
      );
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
  // stale version never bleeds across navigations.
  useEffect(() => {
    setHistoryOpen(false);
    setViewingVersionId(null);
    setCompareIds(null);
    // A stale open count never bleeds across posts; Comments re-lifts the
    // real counts once its fetch for the new post lands.
    setCommentCounts({ open: 0, resolved: 0 });
    setActionError(null);
    setApproveError(null);
    setNotifying(false);
    setOnBehalfOpen(false);
    setOnBehalfBusy(false);
    setOnBehalfError(null);
    // A pending reject / park commits for its own post (flush); the next post
    // never shows that optimistic stage.
    flushUndoable();
    setOptimisticStage(null);
    setReasonTarget(null);
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
        if (cancelled) return;
        setRole(next);
        setRoleLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  useEffect(() => {
    if (workspaceId === null) {
      setBuckets([]);
      setBucketsLoaded(true);
      return;
    }
    let cancelled = false;
    setBucketsLoaded(false);
    void listBuckets(supabase, workspaceId)
      .catch(() => ({ ok: false as const }))
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setBuckets(result.data);
        setBucketsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadError(false);
      const result = await getPost(supabase, postId);
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
    [postId],
  );

  useEffect(() => {
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
    void getPostGallery(supabase, postId)
      .catch(() => null)
      .then((result) => {
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
  }, [postId]);

  // The brief name for the details row, read once per brief_id. No brief (or
  // no post yet) settles at once; a failed read just omits the brief.
  const briefId = detail?.post.brief_id ?? null;
  useEffect(() => {
    if (briefId === null) {
      setBriefName(null);
      setBriefLoadedFor(null);
      return;
    }
    let active = true;
    void getBrief(supabase, briefId)
      .catch(() => null)
      .then((result) => {
        if (!active) return;
        setBriefName(result !== null && result.ok ? (result.data?.brief.title ?? null) : null);
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
  // gallery, the viewer's role, the members (owner name) and the buckets (and
  // the brief name, when the post has one) have all settled; then the page
  // paints once. Silent refreshes after that never flip back to the skeleton.
  const firstPaintPending =
    loading ||
    (!loadError &&
      !notFound &&
      detail !== null &&
      !(galleryLoaded && roleLoaded && !membersLoading && bucketsLoaded && briefLoaded));
  const sheetMountable =
    !firstPaintPending && !notFound && !loadError && detail !== null && !readOnly;
  useEffect(() => {
    if (actionsOpenProp === true && !sheetMountable) onActionsOpenChange?.(false);
  }, [actionsOpenProp, sheetMountable, onActionsOpenChange]);

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

  /**
   * Resolves true once the move landed, false on a failure. Flow B 41: the
   * error shows once, where it was tapped: a failed approve inside the approve
   * confirm, any other move in the decision row / bar.
   */
  async function handleTransition(to: Stage): Promise<boolean> {
    if (postId === undefined) return false;
    setTransitioning(true);
    setActionError(null);
    setApproveError(null);
    const result = await stageTransition(supabase, {
      p_post_id: postId,
      p_to_stage: to,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      setTransitioning(false);
      const message = postActionErrorCopy(
        result.error,
        to === 'approved' ? 'approve the post' : 'move the post',
      );
      if (to === 'approved') setApproveError(message);
      else setActionError(message);
      return false;
    }
    // Re-fetch so the stage badge and the set of available buttons update.
    await load(true);
    setTransitioning(false);
    dispatchInductionRefresh();
    return true;
  }

  // Approve asks first; every other target moves at once through the same
  // handleTransition. A landed approve closes the confirm; a failed one keeps it
  // open with the error and re-arms Confirm.
  const { gate: approveGate, state: approveState } = useApproveGate((_postId, to) => {
    void handleTransition(to).then((ok) => {
      if (to !== 'approved') return;
      if (ok) approveGate.cancel();
      else approveGate.settle();
    });
  });

  // Spec D: the agency approves on a named approver's behalf. The actor stays
  // auth.uid() server-side; onBehalfOf only names whom it was for. A landed
  // approve closes the sheet; a failure keeps it open with the error once.
  async function confirmOnBehalf(onBehalfOf: string | undefined): Promise<void> {
    if (postId === undefined || onBehalfBusy) return;
    const approvedFor = postId;
    setOnBehalfBusy(true);
    setOnBehalfError(null);
    setActionError(null);
    const result = await stageMove(supabase, {
      postId: approvedFor,
      toStage: 'approved',
      traceId: newTrace(),
      ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
    }).catch((error: unknown) => ({ ok: false as const, error }));
    if (!mountedRef.current || postIdRef.current !== approvedFor) return;
    if (!result.ok) {
      setOnBehalfBusy(false);
      setOnBehalfError(postActionErrorCopy(result.error, 'approve the post'));
      return;
    }
    await load(true);
    setOnBehalfBusy(false);
    setOnBehalfOpen(false);
    dispatchInductionRefresh();
  }

  // Reject / park confirmed: show the new stage now, commit after the Undo
  // window. Commit is the existing stage RPC, then (when a reason was typed)
  // the reason as a comment through the same create path as every comment. A
  // failed move puts the old stage back with the friendly error; a failed
  // reason comment leaves the move in place and says so.
  //
  // FB6: the commit may land after this page is gone (the undo hook flushes on
  // unmount, hidden and pagehide), so it runs through runStageMoveCommit: a
  // refusal or a thrown error reverts and shows the inline error while still
  // here, and ALWAYS shows the app-wide toast ("Couldn't reject {title}. It's
  // still in review." with Open), held while the document is hidden. It never
  // rethrows, so the hook's own failure toast never doubles it.
  function confirmReasonMove(): void {
    const to = reasonTarget;
    const copy = to === null ? null : stageReasonConfirm(to);
    if (to === null || copy === null || postId === undefined || detail === null) return;
    const movedPostId = postId;
    const fromStage = detail.post.stage as Stage;
    const postTitle = detail.post.title;
    const reason = stageReasonComment(reasonDraft);
    setReasonTarget(null);
    setReasonDraft('');
    setActionError(null);
    setOptimisticStage(to);
    runUndoable({
      label: copy.undoLabel,
      revert: () => setOptimisticStage(null),
      commit: () => {
        const traceId = newTrace();
        return runStageMoveCommit({
          to,
          fromStage,
          postTitle,
          reason,
          transition: async () => {
            const result = await stageTransition(supabase, {
              p_post_id: movedPostId,
              p_to_stage: to,
              p_trace_id: traceId,
            });
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
          postReason: (body) => createAnchoredComment(body, traceId),
          stillHere: () => mountedRef.current && postIdRef.current === movedPostId,
          revert: () => setOptimisticStage(null),
          setInlineError: setActionError,
          friendlyError: postActionErrorCopy,
          afterSuccess: async () => {
            await load(true);
            setOptimisticStage(null);
            setCommentsRefresh((n) => n + 1);
            dispatchInductionRefresh();
          },
          toast: toastRef.current,
          openPost: () => navigate(`/posts/${movedPostId}`),
          doc: document,
          log: (message, data) => logger.warn(message, data),
        });
      },
    });
  }

  // Leaving the post (FT13): the host's own close when embedded; else one step
  // back when there is in-app history to return to, else the pipeline.
  function leave(): void {
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
            title: `Couldn't delete ${postTitle}. It's still there.`,
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
    void commitGallery(removeAt(orderedIds, index));
  }
  function openAdd(target: AddTarget): void {
    uploadedVersionIds.current = [];
    setAddTarget(target);
  }

  // The upload sheet posts each file to the asset-upload worker; capture the
  // version id of every success so the gallery add can pin them on close.
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const handleUploadFile = useCallback(
    async (file: File, displayName: string, folderId: string | null): Promise<UploadOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      const outcome = await uploadAssetFile(file, {
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        origin: 'library',
        filename: file.name,
        displayName,
        folderId,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (outcome.ok && outcome.assetVersionId !== undefined && outcome.assetVersionId !== '') {
        uploadedVersionIds.current.push(outcome.assetVersionId);
      }
      return outcome;
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  // After a fully-successful upload run, apply append or insert-after for each
  // new version id over the current order, then commit the whole gallery once.
  async function handleUploaded(): Promise<void> {
    const versionIds = uploadedVersionIds.current;
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
      <IconChevronLeft size={20} />
    </IconButton>
  );

  // Flow B 34: the skeleton uses the loaded page's own grid, so nothing jumps
  // when the content paints.
  const grid = postPageGrid(embedded);

  if (firstPaintPending) {
    return (
      <>
        {embedded ? null : (
          <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
            {backButton}
            <div aria-hidden className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-4 w-32 animate-pulse rounded bg-panel-3" />
            </div>
            <div aria-hidden className="h-11 w-11 shrink-0" />
          </div>
        )}
        {/* N12: a skeleton of the page's own shapes (title, details row, media,
            caption, comments) from the existing tokens, with a screen-reader
            label. Flow B 25: it stays until every first-paint read settles. */}
        <div aria-busy="true" data-post-skeleton="" className={grid.page}>
          <span className="sr-only">Loading post</span>
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
            <div className="h-24 animate-pulse rounded-xl bg-panel-2" />
          </div>
        </div>
      </>
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
          icon={<IconPipeline size={22} />}
          title="Post not found"
          description="This post may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" size="lg" onClick={goPipeline}>
              Back to pipeline
            </Button>
          }
        />
      </>
    );
  }

  const post = detail.post;
  const currentStage = optimisticStage ?? (post.stage as Stage);
  // #35: version pictures (sheet rows, old-version view), platform-shaped.
  const versionThumbs: VersionThumbs = {
    gallery,
    cache,
    presignEnabled,
    ratio: galleryFrame(post.platform, post.format, gallery, {})?.ratio ?? 4 / 5,
  };
  const stageActions = visibleStageActions(currentStage, role);
  const ownerInfo = resolveOwner(post.owner_user_id, post.legacy_author_name);
  const bucket = buckets.find((b) => b.id === post.bucket_id) ?? null;
  const hasCaption = post.caption !== null && post.caption.trim() !== '';
  const { head: titleHead, last: titleLast } = splitLastWord(post.title);
  const composerKey = composer !== null ? captionDraftKey(composer.start, composer.end) : null;
  const pinKey =
    pinComposer !== null ? pinDraftKey(pinComposer.index, pinComposer.x, pinComposer.y) : null;

  // A stage pick. Any pick clears the last error (flow B 41: one error, where
  // it was tapped). FN10: while a reject / park Undo window runs the buttons
  // stay enabled, and a pick flushes that pending commit first.
  function pickStage(to: Stage): void {
    if (optimisticStage !== null) flushUndoable();
    setActionError(null);
    setApproveError(null);
    if (stageReasonConfirm(to) !== null) {
      setReasonDraft('');
      setReasonTarget(to);
      return;
    }
    approveGate.request(post.id, to);
  }

  // Spec D: the ⋯ sheet's "Approve on their behalf" opens the on-behalf sheet.
  function openOnBehalf(): void {
    if (optimisticStage !== null) flushUndoable();
    setActionError(null);
    setOnBehalfError(null);
    setOnBehalfOpen(true);
  }

  // Flow B 33: the creator's "Send for review again" tells the approvers
  // through the existing post_ready_notify wrapper. A refusal shows once, in
  // plain words, in the decision row / bar that was tapped. With comments still
  // open the tap asks first ("Send anyway?"); with none it sends straight away.
  function requestSendForReviewAgain(): void {
    if (notifying) return;
    if (openCount > 0) {
      setActionError(null);
      setConfirmSendAnyway(true);
      return;
    }
    void sendForReviewAgain();
  }

  async function sendForReviewAgain(): Promise<void> {
    if (postId === undefined || notifying) return;
    const sentFor = postId;
    setActionError(null);
    setNotifying(true);
    const result = await runPostReadyNotify(supabase, {
      postId: sentFor,
      traceId: newTrace(),
    }).catch(() => null);
    if (!mountedRef.current || postIdRef.current !== sentFor) return;
    setNotifying(false);
    if (result === null || !result.ok) {
      logger.warn('post page: send for review again failed', {
        error: result === null ? 'thrown' : result.error.message,
      });
      setActionError(sendAgainErrorCopy(result === null ? null : result.error.message));
      return;
    }
    push(SENT_AGAIN_TOAST);
    setCommentsRefresh((n) => n + 1);
    dispatchInductionRefresh();
  }

  const approveTimeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? 'UTC';

  // Flow B 28: the details row parts, each only when it has a value. Platform
  // and format always have one, and this is the one place they show (27).
  // Flow B 37 / spec B4: an approved post is locked. No title pencil, caption
  // Edit, gallery tools, slide actions or lightbox edit tools (each shows a
  // lock instead); the details sheet keeps only the due date and the bucket.
  const approvedLocked = currentStage === 'approved';
  const canEditContent = agencySide && !readOnly && !approvedLocked;
  const ownerKnown =
    ownerInfo.name !== '' && !(post.owner_user_id === null && post.legacy_author_name === null);
  const dueLabel =
    post.target_date !== null ? formatDue(post.target_date, approveTimeZone, new Date()) : null;
  const detailsEditable = agencySide && !readOnly;
  // Spec B2: owner · Due date · "From brief: {title}" (a link to the brief),
  // then the bucket and the platform. Each part only when it has a value; a
  // quiet dot sits between parts.
  const detailParts: { key: string; node: React.ReactNode }[] = [];
  if (ownerKnown) {
    detailParts.push({
      key: 'owner',
      node: (
        <span data-detail="owner" className="inline-flex min-w-0 items-center gap-1.5">
          <Avatar
            name={ownerInfo.name}
            size="sm"
            {...(ownerInfo.avatarUrl !== null ? { src: ownerInfo.avatarUrl } : {})}
          />
          <span className="truncate font-medium text-fg">{ownerInfo.name}</span>
          {approvedLocked && agencySide ? (
            <span aria-hidden data-detail-lock="" className="shrink-0 text-fg-3">
              <IconLock size={13} />
            </span>
          ) : null}
        </span>
      ),
    });
  }
  if (dueLabel !== null) {
    detailParts.push({
      key: 'due',
      node: (
        <span data-detail="due" className="inline-flex items-center gap-1.5 tabular-nums">
          <IconCalendar size={15} />
          {dueLabel}
        </span>
      ),
    });
  }
  if (briefName !== null && post.brief_id !== null) {
    detailParts.push({
      key: 'brief',
      node: (
        <Link
          data-detail="brief"
          to={briefRoute(post.brief_id)}
          className="inline-flex min-h-[44px] min-w-0 max-w-full items-center gap-1.5 rounded-md font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconBriefs size={15} />
          <span className="min-w-0 truncate">{fromBriefLabel(briefName)}</span>
        </Link>
      ),
    });
  }
  if (bucket !== null) {
    detailParts.push({
      key: 'bucket',
      node: (
        <span data-detail="bucket" className="inline-flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: bucket.colorHex }}
          />
          <span className="truncate">{bucket.name}</span>
        </span>
      ),
    });
  }
  detailParts.push({
    key: 'platform',
    node: (
      <span data-detail="platform" className="text-fg-3">
        {platformLabel(post.platform)} · {formatLabel(post.format)}
      </span>
    ),
  });
  const detailsParts = detailParts.map((part, index) => (
    <span key={part.key} className="inline-flex min-w-0 max-w-full items-center gap-2">
      {index > 0 ? (
        <span aria-hidden className="text-fg-3">
          ·
        </span>
      ) : null}
      {part.node}
    </span>
  ));

  // Flow B 29: "{n} open comments" under the title while in review; a tap
  // scrolls to the comments. Hidden at 0.
  const openCommentsChip =
    currentStage === 'review' && openCount > 0 && !readOnly ? (
      <div>
        <button
          type="button"
          data-open-comments-chip=""
          onClick={() => scrollToCommentsSection()}
          className="group inline-flex min-h-[44px] items-center focus:outline-none"
        >
          <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-warn-soft px-3 text-[13px] font-semibold text-[color:var(--warn-ink)] group-focus-visible:ring-2 group-focus-visible:ring-accent">
            <IconChat size={15} />
            {openCommentsLabel(openCount)}
            <IconChevronDown size={15} />
          </span>
        </button>
      </div>
    ) : null;

  // The approver's quiet note in review, or null.
  const stageHelper = currentStage === 'review' && clientRole ? CLIENT_REVIEW_NOTE : null;

  // Flow B 30 / 33: the decision row's model. Approvers: Comment (review),
  // Reject, Approve. Creators: one main button; in review it is "Send for
  // review again", disabled only while the send is in flight (open comments
  // ask first, they never block). Their other moves sit
  // in the ⋯ sheet (moveRows below).
  const reviewMove = stageActions.find((action) => action.to === 'review') ?? null;
  const decisionModel: DecisionModel | null = readOnly
    ? null
    : clientRole
      ? stageActions.length > 0 || currentStage === 'review'
        ? {
            kind: 'approver',
            actions: stageActions,
            onComment: currentStage === 'review' ? () => void focusCommentComposer() : null,
            onPick: pickStage,
          }
        : null
      : agencySide && currentStage === 'review'
        ? {
            kind: 'creator',
            label: SEND_AGAIN_LABEL,
            disabled: notifying,
            helper: null,
            onPress: requestSendForReviewAgain,
          }
        : agencySide && reviewMove !== null
          ? {
              kind: 'creator',
              label: reviewMove.label,
              disabled: false,
              helper: null,
              onPress: () => pickStage('review'),
            }
          : null;
  const decisionBusy = transitioning || notifying;

  // Flow B 31: the creator's other moves, as rows in the ⋯ sheet. "Approve on
  // their behalf" opens the existing on-behalf approve confirm; Park and Reject open
  // their reason confirms.
  const moveRows: PostMoveRow[] =
    agencySide && !readOnly
      ? stageActions
          .filter((action) => action.to !== 'review')
          .map((action): PostMoveRow => {
            if (action.to === 'approved') {
              return {
                key: 'approved',
                icon: <IconCheck size={18} />,
                label: APPROVE_ON_BEHALF_LABEL,
                onPick: openOnBehalf,
              };
            }
            if (action.to === 'rejected') {
              return {
                key: 'rejected',
                icon: <IconX size={18} />,
                label: action.label,
                danger: true,
                onPick: () => pickStage('rejected'),
              };
            }
            return {
              key: action.to,
              icon: <IconPause size={18} />,
              label: action.label,
              sub: 'Keeps it aside. You can send it for review later.',
              onPick: () => pickStage(action.to),
            };
          })
      : [];

  // The decision row, rendered ONCE per breakpoint. md and up (and embedded):
  // inline in the decision slot (laptop: the right column, above the caption).
  // Phone: the same row in the sticky decision bar (T12 / FN8), and only the
  // approver's note stays inline, under the caption. A failed tap's error
  // shows inside whichever row is on screen, so role=alert never duplicates.
  const phoneLayout = !isDesktop && !embedded;
  // Flow B 27: the stage shows once, in the top bar; with no moves to offer
  // (and nothing to say) nothing is rendered.
  const stageSection = readOnly ? null : (
    <PostDecisionRow
      model={decisionModel}
      busy={decisionBusy}
      error={actionError}
      note={stageHelper}
    />
  );
  const phoneStageNotes =
    stageHelper !== null ? (
      <section className="rounded-xl border border-border bg-panel-2 p-4">
        <p className="text-sm text-fg-2">{stageHelper}</p>
      </section>
    ) : null;
  const decisionBar =
    phoneLayout && !readOnly ? (
      <PostDecisionBar model={decisionModel} busy={decisionBusy} error={actionError} />
    ) : null;
  const decisionBarShown = decisionBar !== null && (decisionModel !== null || actionError !== null);

  // Spec B4: beside the lock, how to change it, and (agency roles, when the
  // move is legal) "Move to Parked", which opens the existing park confirm.
  // Who approved is not repeated here (the top bar already says Approved).
  const canParkApproved = agencySide && stageActions.some((action) => action.to === 'parked');
  const approvedBanner =
    approvedLocked && !readOnly ? (
      <div
        data-approved-banner=""
        className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl bg-good-soft px-3.5 py-2 text-sm text-fg"
      >
        <span aria-hidden className="shrink-0 text-good">
          <IconLock size={18} />
        </span>
        <p className="min-w-0 flex-1 py-2">{APPROVED_LOCK_LINE}</p>
        {canParkApproved ? (
          <Button
            size="lg"
            data-approved-park=""
            className="shrink-0"
            onClick={() => pickStage('parked')}
          >
            {MOVE_TO_PARKED_LABEL}
          </Button>
        ) : null}
      </div>
    ) : null;

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
            <span className="truncate text-[15px] font-semibold">
              {postStatusLine(
                currentStage,
                post.updated_at,
                post.stage_entered_at,
                new Date(),
                approveTimeZone,
              )}
            </span>
          </div>
          {!readOnly ? (
            <button
              type="button"
              aria-label="Post actions"
              onClick={() => setActionsOpen(true)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-panel-2 hover:text-fg-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <IconMoreVertical size={18} />
            </button>
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
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight break-words [overflow-wrap:anywhere]">
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
                    // Spec B1: the same type and line height as the h1, with
                    // no border or block padding (the ring draws outside the
                    // box), so entering edit never shifts the page.
                    className="-mx-2 w-[calc(100%+1rem)] rounded-md border-0 bg-panel-2 px-2 py-0 text-[28px] font-semibold leading-tight tracking-tight text-fg outline-none ring-1 ring-border focus:ring-2 focus:ring-accent-line"
                  />
                  {isTouchDevice() ? (
                    // FN9: a phone has no Enter / Escape to hand; Save and Cancel are
                    // visible. pointerdown is swallowed so the input's blur-save never
                    // runs ahead of (or instead of) the tapped button.
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="lg"
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
                        size="lg"
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
                <h1 className="text-[28px] font-semibold leading-tight tracking-tight break-words [overflow-wrap:anywhere]">
                  {titleHead !== '' ? <Highlight text={`${titleHead} `} /> : ''}
                  <span className="whitespace-nowrap">
                    <Highlight text={titleLast} />
                    {/* The 44px target overflows the line box (negative block
                        margins), so the title line keeps its own height and the
                        editor below it does not shift. */}
                    <button
                      type="button"
                      aria-label="Edit title"
                      onClick={openTitleEditor}
                      className="-my-1.5 ml-1 inline-flex h-11 w-11 items-center justify-center align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-panel-3 text-fg-3 transition-colors hover:text-fg-2">
                        <IconPencil size={17} />
                      </span>
                    </button>
                  </span>
                </h1>
              )
            ) : (
              <h1
                data-post-title=""
                className="text-[28px] font-semibold leading-tight tracking-tight break-words [overflow-wrap:anywhere]"
              >
                <Highlight text={post.title} />
                {approvedLocked && agencySide ? (
                  <span
                    aria-hidden
                    data-title-lock=""
                    className="ml-2 inline-flex align-middle text-fg-3"
                  >
                    <IconLock size={18} />
                  </span>
                ) : null}
              </h1>
            )}

            {/* Flow B 28: the visible details row. Owner, due date, bucket,
              brief, platform and format, each only when it has a value;
              creators tap it (Edit) to open the details sheet. */}
            <div className="flex flex-wrap items-center gap-x-2">
              {/* The brief part is a link, so the row is a plain line and
                  creators open the details sheet from its own Edit button. */}
              <div
                data-post-details=""
                className="flex min-h-[44px] min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 py-1 text-[13px] text-fg-2"
              >
                {detailsParts}
                {detailsEditable ? (
                  <button
                    type="button"
                    data-post-details-edit=""
                    onClick={() => setShowDetails(true)}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg px-2 font-medium text-accent transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Edit
                  </button>
                ) : null}
              </div>
              <PreviewChip platform={post.platform} onClick={() => setPreviewOpen(true)} />
            </div>
            {/* Flow B 37: the approved lock, under the title and details. */}
            {approvedBanner}
            {/* DECISION ROW SLOT (flow B 30 / 34): on md and up (and embedded)
              the approver / creator decision row renders here, under the
              details and above the open-comments chip and the caption. Below
              md the same row lives in the sticky PostDecisionBar instead. */}
            {phoneLayout ? null : stageSection}
            {openCommentsChip}
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
                <p aria-live="polite" className="mt-2.5 text-xs text-fg-3">
                  Saving…
                </p>
              ) : null}
              {pinError !== null ? (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
                >
                  {pinError}
                </div>
              ) : null}
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
                <Avatar name={workspaceName ?? ''} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">
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
                    <IconCopy size={18} />
                  </IconButton>
                ) : null}
                {agencySide && approvedLocked ? (
                  <span
                    aria-hidden
                    data-caption-lock=""
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-fg-3"
                  >
                    <IconLock size={16} />
                  </span>
                ) : null}
                {canEditContent && !editingCaption ? (
                  <button
                    type="button"
                    data-caption-edit=""
                    onClick={openCaptionEditor}
                    className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-fg-2 transition-colors hover:bg-panel-3 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <IconPencil size={15} />
                    Edit
                  </button>
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
                    <div role="alert" className="text-sm text-bad">
                      {captionError}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="lg"
                      disabled={captionSaving}
                      onClick={() => void saveCaption()}
                    >
                      {captionSaving ? 'Saving…' : captionSaveLabel(currentVersionNumber)}
                    </Button>
                    <Button
                      variant="ghost"
                      size="lg"
                      disabled={captionSaving}
                      onClick={cancelCaptionEdit}
                    >
                      Cancel
                    </Button>
                    <span className="ml-auto text-xs tabular-nums text-fg-3">
                      {captionDraft.trim().length}/5000
                    </span>
                  </div>
                  {captionSaveNote(currentVersionNumber) !== null ? (
                    <p className="text-xs text-fg-3">{captionSaveNote(currentVersionNumber)}</p>
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
                      className="mt-2 flex items-center gap-2 text-xs text-fg-3"
                    >
                      <span>{CAPTION_TIP_TEXT}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setCaptionTipOpen(false);
                          dismissCaptionTip(userId);
                        }}
                        className="ml-auto inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md px-2 text-xs font-medium text-accent transition-colors hover:bg-panel-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Got it
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="mt-3 text-sm text-fg-3">No caption yet.</p>
              )}
              {annotateError !== null ? (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
                >
                  {annotateError}
                </div>
              ) : null}
            </section>

            {phoneLayout ? phoneStageNotes : null}

            {/* Comments own their header row ("Comments", the open-count chip,
              Open / All); the checkpoint strip sits under it, only when
              there are checkpoints (it renders nothing otherwise). */}
            <section
              id={COMMENTS_SECTION_ID}
              className="scroll-mt-16 rounded-xl border border-border bg-panel-2 p-4"
            >
              {workspaceId !== null && postId !== undefined ? (
                <div data-induction={INDUCTION_KEYS.postCommentComposer}>
                  <Comments
                    workspaceId={workspaceId}
                    entityType="post"
                    entityId={postId}
                    annotationsByCommentId={annotationsByCommentId}
                    onAnnotationChipClick={(commentId) => flashTo(`caption-mark-${commentId}`)}
                    refreshSignal={commentsRefresh}
                    focusCommentId={embedded ? (focusCommentIdProp ?? null) : focusCommentId}
                    viewerIsClient={clientRole}
                    guideReplyCommentId={firstHighlightCommentId(post.caption ?? '', highlights)}
                    showHeader
                    onCountsChange={handleCommentCounts}
                    belowHeader={
                      <CheckpointStrip
                        workspaceId={workspaceId}
                        postId={postId}
                        viewerIsClient={clientRole}
                        refreshSignal={commentsRefresh}
                      />
                    }
                  />
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-fg-3">
                  Select a workspace to view comments.
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* The sticky decision bar (phone) and the room under the content so it
          never covers the comment composer. */}
      {decisionBarShown ? (
        <div
          aria-hidden
          data-decision-bar-space=""
          style={{
            height: `calc(${decisionBarSpace(decisionModel, actionError)}px + env(safe-area-inset-bottom))`,
          }}
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

      <StageReasonConfirm
        copy={reasonTarget !== null ? stageReasonConfirm(reasonTarget) : null}
        reason={reasonDraft}
        onReasonChange={setReasonDraft}
        onCancel={() => setReasonTarget(null)}
        onConfirm={confirmReasonMove}
        {...(reasonTarget === 'rejected'
          ? {
              body: rejectConfirmBody(ownerKnown ? ownerInfo.name : null),
              label: REJECT_REASON_LABEL,
            }
          : {})}
      />

      {confirmSendAnyway ? (
        <ConfirmDialog
          title={sendAnywayTitle(openCount)}
          confirmLabel={SEND_ANYWAY_LABEL}
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmSendAnyway(false);
            void sendForReviewAgain();
          }}
          onCancel={() => setConfirmSendAnyway(false)}
        />
      ) : null}

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
              error: { code: 'unknown' as const, message: 'No workspace selected.' },
            });
          }
          return createBucket(supabase, workspaceId, name, newTrace()).then((result) => {
            if (result.ok) {
              const created = result.data;
              setBuckets((prev) =>
                prev.some((b) => b.id === created.id) ? prev : [...prev, created],
              );
            }
            return result;
          });
        }}
        lockedFields={approvedLocked}
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

      <PcsApproveConfirm
        gate={approveGate}
        gateState={approveState}
        format={post.format}
        title={post.title}
        mediaCount={gallery.length > 0 ? gallery.length : null}
        targetDate={approveTargetDate(post.target_date, approveTimeZone)}
        busy={transitioning}
        error={approveError}
      />

      <OnBehalfApproveSheet
        open={onBehalfOpen}
        approvers={approvers}
        brand={workspaceName ?? null}
        busy={onBehalfBusy}
        error={onBehalfError}
        onCancel={() => {
          if (onBehalfBusy) return;
          setOnBehalfOpen(false);
          setOnBehalfError(null);
        }}
        onConfirm={(onBehalfOf) => void confirmOnBehalf(onBehalfOf)}
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
        onToast={push}
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

      {!readOnly ? (
        <PostActionSheet
          open={actionsOpen}
          onClose={() => setActionsOpen(false)}
          postId={post.id}
          workspaceId={workspaceId ?? ''}
          currentUserId={userId ?? ''}
          gallery={gallery}
          deps={deps}
          workspaceKey={workspaceKey}
          postNumber={post.number}
          onToast={push}
          canDelete={canDelete}
          onDeletePost={handleDeletePost}
          moveRows={moveRows}
          {...(onOpenInPipeline !== undefined ? { onOpenInPipeline } : {})}
        />
      ) : null}
    </SearchWordsContext.Provider>
  );
}
