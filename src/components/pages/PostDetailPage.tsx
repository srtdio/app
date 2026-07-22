import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { Textarea } from '@/components/ui/Textarea';
import { Comments, writeClipboard } from '@/components/comments/Comments';
import type { CommentAnnotation } from '@/components/comments/Comments';
import { flashNode } from '@/components/comments/flash-node';
import {
  PCS_TAB_PARAM,
  parsePcsTab,
  pcsTabPanelClass,
  pcsTabPanelId,
  withPcsTab,
} from '@/components/pages/pcs/PcsTabs';
import type { PcsTab } from '@/components/pages/pcs/PcsTabs';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronLeft, IconChevronRight, IconCopy, IconPipeline } from '@/components/ui/icons';
import { PostGallery } from '@/components/pages/pcs/PostGallery';
import { CaptionView } from '@/components/pages/pcs/CaptionView';
import type { CaptionAnnotationView } from '@/components/pages/pcs/CaptionView';
import { CaptionAnnotationComposer } from '@/components/pages/pcs/CaptionAnnotationComposer';
import { PinAnnotationComposer } from '@/components/pages/pcs/PinAnnotationComposer';
import { PinOverlay } from '@/components/pages/pcs/PinOverlay';
import { buildPinData } from '@/components/pages/pcs/pin-annotations';
import type { PinDot } from '@/components/pages/pcs/pin-annotations';
import { FeedbackLedger } from '@/components/pages/pcs/FeedbackLedger';
import type { LedgerCounts } from '@/components/pages/pcs/FeedbackLedger';
import { PostDetailsSheet } from '@/components/pages/pcs/PostDetailsSheet';
import { SlideActionsSheet } from '@/components/pages/pcs/SlideActionsSheet';
import { VersionPill } from '@/components/pages/pcs/VersionPill';
import { VersionHistorySheet } from '@/components/pages/pcs/VersionHistorySheet';
import { ReadOnlyVersionView } from '@/components/pages/pcs/ReadOnlyVersionView';
import { CompareVersionsView } from '@/components/pages/pcs/CompareVersionsView';
import {
  currentVersionNumber as currentVersionNumberOf,
  parseSnapshot,
  toVersionViews,
} from '@/lib/post-versions';
import { usePostMembers } from '@/components/pages/pcs/use-post-members';
import { isAgencySide, isClient, isOwnerOrAdmin } from '@/components/pages/pcs/roles';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';
import { IconPencil, IconMoreVertical } from '@/components/pages/pcs/post-icons';
import { PostActionSheet } from '@/components/pages/pcs/PostActionSheet';
import {
  append,
  insertAfter,
  moveLeft,
  moveRight,
  removeAt,
} from '@/components/pages/pcs/gallery-transforms';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { supabase } from '@/lib/supabase';
import { listBuckets, type BucketOption } from '@/lib/buckets';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { fetchMemberRole } from '@/lib/assets';
import { uploadAssetFile, type UploadOutcome } from '@/lib/asset-upload';
import { useNewTrace } from '@/lib/trace-context';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import {
  annotationCreate,
  getPost,
  getPostGallery,
  gallerySet,
  postCaptionUpdate,
  postUpdate,
} from '@srtdio/posts';
import type { DomainError, GalleryItem, PostDetail, PostUpdateInput, Stage } from '@srtdio/posts';
import { createComment } from '@srtdio/comments';
import type { Json } from '@srtdio/schemas';
import { postSoftDelete, stageTransition } from '@srtdio/rpc';
import { formatLabel, platformLabel, postStatusLine } from '@/lib/post-detail-presentation';

// Read a caption string out of a version snapshot defensively: the snapshot is
// free-form Json, so a missing or non-string caption yields null (no quote)
// rather than a throw.
function snapshotCaption(snapshot: Json | null): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const caption = (snapshot as { caption?: unknown }).caption;
  return typeof caption === 'string' ? caption : null;
}

// Title-case a single workflow stage for display. Stage values come from
// @srtdio/posts; this is presentation only.
function stageLabel(stage: Stage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// Split a title into everything-but-the-last-word and the last word, so the body
// title can keep the trailing edit pencil glued to the final word (wrapped in a
// nowrap span) instead of letting the glyph wrap onto its own line.
function splitLastWord(title: string): { head: string; last: string } {
  const words = title.split(' ');
  const last = words.pop() ?? title;
  return { head: words.join(' '), last };
}

// Soft-filled stage pill styling per stage, from existing theme tokens so
// light/dark parity is automatic. draft/review resolve to soft fills
// (panel-3 / accent-soft are concrete tokens). approved/parked/rejected fall
// back to the stage's coloured border + text: the good/warn/bad tokens are bare
// hex CSS vars, so Tailwind's `/opacity` modifier cannot mint a soft tint from
// them and there is no good-soft/warn-soft/bad-soft token to substitute.
const STAGE_PILL: Record<Stage, string> = {
  draft: 'bg-panel-3 text-fg-2',
  review: 'bg-accent-soft text-accent',
  approved: 'border border-good text-good',
  parked: 'border border-warn text-warn',
  rejected: 'border border-bad text-bad',
};

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

// Display label per stage for the pill (distinct from stageLabel, which the
// read-only status line reuses).
const STAGE_PILL_LABEL: Record<Stage, string> = {
  draft: 'Draft',
  review: 'In review',
  approved: 'Approved',
  parked: 'Parked',
  rejected: 'Rejected',
};

// Map the proc's domain errors to friendly, inline copy. The proc owns the
// policy: it raises forbidden_role when the role lacks approve/reject
// capability and invalid_stage_transition for an illegal move.
function friendlyTransitionError(error: DomainError): string {
  switch (error.code) {
    case 'forbidden_role':
      return 'You do not have permission to make this change.';
    case 'invalid_stage_transition':
      return 'That move is not allowed from the current stage.';
    case 'workspace_member_only':
      return 'You must be a member of this workspace to make this change.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function PostDetailPage({ postId: postIdProp }: { postId?: string } = {}) {
  const params = useParams();
  // The pretty-link resolver (/p/:ref) passes the resolved id as a prop; the
  // classic /posts/:postId route supplies it via the URL. The prop wins so the
  // address bar can stay on the pretty URL without a redirect.
  const postId = postIdProp ?? params.postId;
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const { workspaceId, workspaceKey } = useWorkspace();

  // Email deep-link: ?comment={commentId} focuses that comment row. Captured into
  // state so it survives the immediate strip below, then handed to Comments which
  // flashes it once the row loads. Fired once per distinct id; only 'comment' is
  // stripped, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const handledCommentParam = useRef<string | null>(null);
  useEffect(() => {
    const comment = searchParams.get('comment');
    if (comment === null || comment === '') return;
    if (handledCommentParam.current === comment) return;
    handledCommentParam.current = comment;
    setFocusCommentId(comment);
    // The focused comment lives in the Feedback tab, so the same replace that
    // strips 'comment' lands the mobile layout on that tab (desktop shows both
    // columns regardless).
    const next = withPcsTab(searchParams, 'feedback');
    next.delete('comment');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Mobile PCS tab (F-layout): below md the post/comment split becomes two
  // tabs whose active value lives in ?tab= so the back button restores the
  // previous tab. Desktop keeps both columns and never touches the param.
  const activeTab = parsePcsTab(searchParams.get(PCS_TAB_PARAM));
  const isDesktop = useMediaQuery('(min-width: 768px)');
  // enteredTab trails activeTab by one frame so the freshly shown panel starts
  // at opacity-0/translate-y-1 and transitions to rest (the Sheet enter
  // pattern). Equal values mean the swap motion has settled.
  const [enteredTab, setEnteredTab] = useState<PcsTab>(activeTab);
  useEffect(() => {
    if (enteredTab === activeTab) return;
    const raf = requestAnimationFrame(() => setEnteredTab(activeTab));
    return () => cancelAnimationFrame(raf);
  }, [activeTab, enteredTab]);

  // A cross-link whose target sat in the hidden tab: the flash is parked here
  // until the tab switch has rendered, then fired by the effect below.
  const [pendingFlash, setPendingFlash] = useState<{ tab: PcsTab; elementId: string } | null>(null);
  useEffect(() => {
    if (pendingFlash === null || activeTab !== pendingFlash.tab) return;
    flashNode(pendingFlash.elementId);
    setPendingFlash(null);
  }, [pendingFlash, activeTab]);

  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [transitioning, setTransitioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Caption annotation state: the pending selection drives the composer, and a
  // bump of commentsRefresh re-fetches the comments list after a post.
  const [composer, setComposer] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );
  const [annotating, setAnnotating] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [commentsRefresh, setCommentsRefresh] = useState(0);

  // Checkpoint counts lifted from FeedbackLedger's one fetch (no duplicate
  // read): they drive the header "X of N" chip and the Feedback tab badge.
  const [checkpointCounts, setCheckpointCounts] = useState<LedgerCounts>({
    resolved: 0,
    total: 0,
  });
  const handleLedgerCounts = useCallback((counts: LedgerCounts) => setCheckpointCounts(counts), []);
  const bumpCommentsRefresh = useCallback(() => setCommentsRefresh((n) => n + 1), []);

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
  const { options: memberOptions } = usePostMembers(workspaceId);
  const { toasts, push, dismiss } = useToasts();

  const [showDetails, setShowDetails] = useState(false);
  // Workspace buckets, fetched once per workspace to resolve the post's bucket
  // chip (mirrors PostDetailsSheet). A failure leaves the list empty: the chip
  // simply does not render, no spinner, no flash.
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  // F8 post action sheet (Send to chat / Copy link / Download all images). Live
  // PCS only; the trigger is suppressed in read-only mode below.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const suppressTitleBlur = useRef(false);

  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState('');
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [captionSaving, setCaptionSaving] = useState(false);

  // Gallery slide-action state: the open sheet's slide index, the per-run upload
  // target (append vs insert-after), and the version ids collected during a run.
  const [slideIndex, setSlideIndex] = useState<number | null>(null);
  const [addTarget, setAddTarget] = useState<
    { mode: 'append' } | { mode: 'insertAfter'; index: number } | null
  >(null);
  const uploadedVersionIds = useRef<string[]>([]);

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
    // A stale checkpoint chip never bleeds across posts; the ledger re-lifts
    // the real counts once its fetch for the new post lands.
    setCheckpointCounts({ resolved: 0, total: 0 });
  }, [postId]);

  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      return;
    }
    let cancelled = false;
    void fetchMemberRole(supabase, workspaceId, userId).then((next) => {
      if (!cancelled) setRole(next);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  useEffect(() => {
    if (workspaceId === null) {
      setBuckets([]);
      return;
    }
    let cancelled = false;
    void listBuckets(supabase, workspaceId).then((result) => {
      if (!cancelled && result.ok) setBuckets(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const agencySide = isAgencySide(role);
  const clientRole = isClient(role);
  const canDelete = isOwnerOrAdmin(role);

  // Resolve the post owner to a display name + avatar from the active members,
  // never a raw uuid: an owner who is no longer a current member reads "(ex-member)".
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
      if (option === undefined) return { name: legacyName ?? '(ex-member)', avatarUrl: null };
      return { name: option.displayName, avatarUrl: option.avatarUrl };
    },
    [memberById],
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
  const cache = useMemo(() => new PresignCache(deps), [deps]);

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
      setLoadError(null);
      const result = await getPost(supabase, postId);
      if (!silent) setLoading(false);
      if (!result.ok) {
        setLoadError(result.error.message);
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
  // it cannot ride getPost's embed) and is non-critical: a failure or an absent
  // post simply leaves the grid empty rather than blocking the page. Extracted so
  // a gallery_set write can refresh it (load(true) only refreshes the post).
  const reloadGallery = useCallback(async (): Promise<void> => {
    if (postId === undefined) {
      setGallery([]);
      return;
    }
    const result = await getPostGallery(supabase, postId);
    setGallery(result.ok ? result.data : []);
  }, [postId]);

  useEffect(() => {
    if (postId === undefined) {
      setGallery([]);
      return;
    }
    let active = true;
    void getPostGallery(supabase, postId).then((result) => {
      if (active) setGallery(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [postId]);

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

  // Resolve a version's createdBy to a display name via the same members read PCS
  // already uses; a null author or one who is no longer a current member reads
  // (ex-member), never a raw uuid.
  const resolveAuthorName = useCallback(
    (authorUserId: string | null, legacyName: string | null): string => {
      if (authorUserId === null || authorUserId === '') return legacyName ?? '(ex-member)';
      return memberById.get(authorUserId)?.displayName ?? legacyName ?? '(ex-member)';
    },
    [memberById],
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
    setComposer({ start, end, quote });
  }, []);

  // Scroll to (and briefly flash) a DOM node by id, switching to the tab that
  // hosts it first when the mobile layout has it hidden. Desktop flashes
  // directly (both columns visible) so cross-links never touch the URL there.
  function flashTo(tab: PcsTab, elementId: string): void {
    if (!isDesktop && activeTab !== tab) {
      setSearchParams(withPcsTab(searchParams, tab));
      setPendingFlash({ tab, elementId });
      return;
    }
    flashNode(elementId);
  }

  // Comment-first, annotation-second on one shared trace. If the annotation
  // fails after the comment lands, the comment simply stays a plain comment; we
  // surface an error and refresh the list, with no retry loop.
  async function submitAnnotation(body: string): Promise<void> {
    if (composer === null || detail === null || currentVersionId === null) return;
    setAnnotating(true);
    setAnnotateError(null);
    const traceId = newTrace();

    const commentResult = await createComment(supabase, {
      workspace_id: detail.post.workspace_id,
      entity_type: 'post',
      entity_id: detail.post.id,
      body,
      trace_id: traceId,
    });
    if (!commentResult.ok) {
      setAnnotating(false);
      setAnnotateError(commentResult.error.message);
      return;
    }

    const annotationResult = await annotationCreate(supabase, {
      kind: 'caption_span',
      postId: detail.post.id,
      postVersionId: currentVersionId,
      commentId: commentResult.data,
      captionStart: composer.start,
      captionEnd: composer.end,
      traceId,
    });
    if (!annotationResult.ok) {
      setAnnotating(false);
      setComposer(null);
      setAnnotateError(
        'Could not anchor the comment to the caption. It was posted as a plain comment.',
      );
      setCommentsRefresh((n) => n + 1);
      return;
    }

    setAnnotating(false);
    setComposer(null);
    await load(true);
    setCommentsRefresh((n) => n + 1);
  }

  // Pin placement (F5): the lightbox owns the armed state; arming just clears any
  // prior error, and a valid tap opens the pin composer at the captured point.
  const handleRequestPin = useCallback((): void => {
    setPinError(null);
  }, []);

  const handlePlacePin = useCallback((index: number, x: number, y: number): void => {
    setPinError(null);
    setPinComposer({ index, x, y });
  }, []);

  // Comment-first, image_pin-second on one shared trace, mirroring the caption
  // write path. An annotation failure after the comment lands leaves a plain
  // comment with an error notice and no retry.
  async function submitPinAnnotation(body: string): Promise<void> {
    if (pinComposer === null || detail === null || currentVersionId === null) return;
    const item = gallery[pinComposer.index];
    if (item === undefined) return;
    setPinSubmitting(true);
    setPinError(null);
    const traceId = newTrace();

    const commentResult = await createComment(supabase, {
      workspace_id: detail.post.workspace_id,
      entity_type: 'post',
      entity_id: detail.post.id,
      body,
      trace_id: traceId,
    });
    if (!commentResult.ok) {
      setPinSubmitting(false);
      setPinError(commentResult.error.message);
      return;
    }

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
      setPinError('Could not anchor the comment to the image. It was posted as a plain comment.');
      setCommentsRefresh((n) => n + 1);
      return;
    }

    setPinSubmitting(false);
    setPinComposer(null);
    await load(true);
    setCommentsRefresh((n) => n + 1);
  }

  async function handleTransition(to: Stage): Promise<void> {
    if (postId === undefined) return;
    setTransitioning(true);
    setActionError(null);
    const result = await stageTransition(supabase, {
      p_post_id: postId,
      p_to_stage: to,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      setTransitioning(false);
      setActionError(friendlyTransitionError(result.error));
      return;
    }
    // Re-fetch so the stage badge and the set of available buttons update.
    await load(true);
    setTransitioning(false);
  }

  // Soft-delete the whole post (owner/admin only; the proc re-checks the
  // capability). On success leave PCS for the pipeline; a failure stays put with
  // a toast, mirroring handleTransition's friendly-error shape.
  async function handleDeletePost(): Promise<void> {
    if (postId === undefined) return;
    const result = await postSoftDelete(supabase, { p_post_id: postId, p_trace_id: newTrace() });
    if (!result.ok) {
      push('Could not delete this post. Please try again.');
      return;
    }
    navigate('/pipeline');
  }

  // One field at a time through post_update; the proc bumps row_version itself
  // and load(true) refreshes the page. A failure surfaces as a toast.
  const applyPostUpdate = useCallback(
    async (
      patch: Partial<Pick<PostUpdateInput, 'title' | 'bucketId' | 'ownerUserId' | 'targetDate'>>,
    ): Promise<void> => {
      if (postId === undefined) return;
      setSavingMeta(true);
      const result = await postUpdate(supabase, { postId, ...patch }, newTrace());
      setSavingMeta(false);
      if (!result.ok) {
        push('Could not save the change. Please try again.');
        return;
      }
      await load(true);
    },
    [postId, newTrace, load, push],
  );

  // Title is internal: a trimmed, changed value writes via post_update (no new
  // version); empty or unchanged simply cancels. Escape and the post-save blur
  // both suppress the trailing blur-save so the write never doubles.
  function openTitleEditor(): void {
    if (detail === null) return;
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
      setCaptionError('Could not save the caption. Please try again.');
      return;
    }
    setEditingCaption(false);
    await load(true);
  }

  // Whole-gallery replace via gallery_set (auto-versions + re-stales annotations
  // server-side). load(true) refreshes the post; reloadGallery refreshes the grid.
  const commitGallery = useCallback(
    async (ids: string[]): Promise<void> => {
      if (postId === undefined) return;
      const result = await gallerySet(supabase, { postId, assetVersionIds: ids }, newTrace());
      if (!result.ok) {
        push('Could not update the gallery. Please try again.');
        return;
      }
      await Promise.all([load(true), reloadGallery()]);
    },
    [postId, newTrace, load, reloadGallery, push],
  );

  const orderedIds = useMemo(() => gallery.map((item) => item.assetVersionId), [gallery]);

  function handleMoveLeft(index: number): void {
    void commitGallery(moveLeft(orderedIds, index));
  }
  function handleMoveRight(index: number): void {
    void commitGallery(moveRight(orderedIds, index));
  }
  // Make-first / make-last compose the existing single-step transforms and land
  // in the same one-shot gallery_set commit; no new write path.
  function handleMakeFirst(index: number): void {
    let ids = orderedIds;
    for (let i = index; i > 0; i -= 1) ids = moveLeft(ids, i);
    void commitGallery(ids);
  }
  function handleMakeLast(index: number): void {
    let ids = orderedIds;
    for (let i = index; i < ids.length - 1; i += 1) ids = moveRight(ids, i);
    void commitGallery(ids);
  }
  function handleRemove(index: number): void {
    if (orderedIds.length <= 1) {
      push('A post needs at least one image.');
      return;
    }
    void commitGallery(removeAt(orderedIds, index));
  }
  function openAdd(target: { mode: 'append' } | { mode: 'insertAfter'; index: number }): void {
    uploadedVersionIds.current = [];
    setAddTarget(target);
  }

  // The upload sheet posts each file to the asset-upload worker; capture the
  // version id of every success so the gallery add can pin them on close.
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const handleUploadFile = useCallback(
    async (file: File, displayName: string, folderId: string | null): Promise<UploadOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: 'Upload failed. Check your connection and retry' };
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
    if (target.mode === 'append') {
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
    <IconButton label="Back" className="shrink-0" onClick={() => navigate('/pipeline')}>
      <IconChevronLeft size={20} />
    </IconButton>
  );

  if (loading) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading post</div>
      </>
    );
  }

  if (loadError !== null) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load this post. {loadError}
          </div>
        </div>
      </>
    );
  }

  if (notFound || detail === null) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <EmptyState
          icon={<IconPipeline size={22} />}
          title="Post not found"
          description="This post may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/pipeline')}>
              Back to pipeline
            </Button>
          }
        />
      </>
    );
  }

  const post = detail.post;
  const currentStage = post.stage as Stage;
  const stageActions = visibleStageActions(currentStage, role);
  const ownerInfo = resolveOwner(post.owner_user_id, post.legacy_author_name);
  const bucket = buckets.find((b) => b.id === post.bucket_id) ?? null;
  const hasCaption = post.caption !== null && post.caption.trim() !== '';
  const { head: titleHead, last: titleLast } = splitLastWord(post.title);

  // The stage rail buttons, shared by the review helpers and the default branch.
  // The Approve target gets a green success fill from the `good` token (there is
  // no on-good token, so its text is white, as the danger variant does); cn here
  // is a plain join, but Tailwind emits bg-good/text-white/hover:bg-good after
  // the primary variant's classes, so they deterministically win the override.
  const stageButtons = (
    <div className="flex flex-col gap-2">
      {stageActions.map((action) => (
        <Button
          key={action.to}
          size="lg"
          variant={action.variant}
          disabled={transitioning}
          onClick={() => void handleTransition(action.to)}
          className={action.to === 'approved' ? 'bg-good text-white hover:bg-good' : undefined}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );

  // The stage-actions card. Rendered twice, one instance per breakpoint: in the
  // desktop aside (hidden md:block) and at the bottom of the mobile Post tab
  // (md:hidden), so stage moves stay reachable without leaving the post. Only
  // buttons and copy live here, so no flashNode target id is ever duplicated.
  const stageSection = (
    <section className="rounded-xl border border-border bg-panel-2 p-4">
      {currentStage === 'review' && clientRole ? (
        <>
          <p className="mb-3 text-sm text-fg-2">
            Commenting keeps the post in review. Approval is deliberate, one post at a time.
          </p>
          {stageButtons}
        </>
      ) : currentStage === 'review' && agencySide ? (
        <>
          <p className="mb-3 text-sm text-fg-2">
            Waiting on the client. Content edits create a new version.
          </p>
          {stageButtons}
        </>
      ) : stageActions.length > 0 ? (
        stageButtons
      ) : (
        <p className="text-sm text-fg-3">Status: {stageLabel(currentStage)}.</p>
      )}
      {actionError !== null ? (
        <div role="alert" className="mt-3 rounded-md border border-bad px-3 py-2 text-sm text-bad">
          {actionError}
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
        {backButton}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className={`h-[7px] w-[7px] shrink-0 rounded-full ${STAGE_DOT[currentStage]}`}
          />
          <span className="truncate text-[15px] font-semibold">
            {postStatusLine(currentStage, post.updated_at, post.stage_entered_at, new Date())}
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

      <div className="flex flex-col gap-3 px-4 md:px-6 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          {bucket !== null ? (
            agencySide ? (
              <button
                type="button"
                onClick={() => setShowDetails(true)}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 text-xs font-semibold text-fg transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: bucket.colorHex }}
                />
                {bucket.name}
              </button>
            ) : (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 text-xs font-semibold text-fg">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: bucket.colorHex }}
                />
                {bucket.name}
              </span>
            )
          ) : null}
          <span
            className={`inline-flex h-7 items-center rounded-full px-2.5 text-xs font-semibold ${STAGE_PILL[currentStage]}`}
          >
            {STAGE_PILL_LABEL[currentStage]}
          </span>
          <span className="text-sm text-fg-2">
            {platformLabel(post.platform)} · {formatLabel(post.format)}
          </span>
        </div>

        {agencySide && !readOnly ? (
          editingTitle ? (
            <input
              autoFocus
              aria-label="Post title"
              value={titleDraft}
              disabled={savingMeta}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={onTitleBlur}
              onKeyDown={onTitleKeyDown}
              className="w-full rounded-md border border-border bg-panel-2 px-2 py-1 text-[28px] font-semibold leading-tight tracking-tight text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft"
            />
          ) : (
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight">
              {titleHead !== '' ? `${titleHead} ` : ''}
              <span className="whitespace-nowrap">
                {titleLast}
                <button
                  type="button"
                  aria-label="Edit title"
                  onClick={openTitleEditor}
                  className="ml-1 inline-flex h-11 w-11 items-center justify-center align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-panel-3 text-fg-3 transition-colors hover:text-fg-2">
                    <IconPencil size={17} />
                  </span>
                </button>
              </span>
            </h2>
          )
        ) : (
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{post.title}</h1>
        )}

        <button
          type="button"
          onClick={() => setShowDetails(true)}
          disabled={readOnly}
          className="flex min-h-[44px] max-w-full flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg-2 transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none"
        >
          <Avatar
            name={ownerInfo.name}
            size="sm"
            {...(ownerInfo.avatarUrl !== null ? { src: ownerInfo.avatarUrl } : {})}
          />
          <span className="truncate font-medium text-fg">{ownerInfo.name}</span>
          <span aria-hidden className="text-fg-3">
            ·
          </span>
          <span className="tabular-nums">
            {post.target_date !== null ? formatTargetDate(post.target_date) : 'No date'}
          </span>
          {!readOnly ? (
            <span className="text-fg-3">
              <IconChevronRight size={16} />
            </span>
          ) : null}
        </button>
      </div>

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
          onBack={() => setViewingVersionId(null)}
        />
      ) : (
        <div className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div
            id={pcsTabPanelId('post')}
            className={cn('md:col-span-2', pcsTabPanelClass(true, true))}
          >
            <section>
              <PostGallery
                items={gallery}
                cache={cache}
                deps={deps}
                presignEnabled={presignEnabled}
                pinOverlay={(item) => (
                  <PinOverlay
                    pins={pinsByAttachment[item.assetAttachmentId] ?? []}
                    onPinClick={(commentId) => flashTo('feedback', `comment-${commentId}`)}
                  />
                )}
                onRequestPin={handleRequestPin}
                onPlacePin={handlePlacePin}
                pinCountFor={(item) => pinsByAttachment[item.assetAttachmentId]?.length ?? 0}
                onSlideActions={agencySide ? (index: number) => setSlideIndex(index) : undefined}
                onAddSlide={agencySide && !readOnly ? () => openAdd({ mode: 'append' }) : undefined}
                onMakeFirst={agencySide && !readOnly ? handleMakeFirst : undefined}
                onMoveLeft={agencySide && !readOnly ? handleMoveLeft : undefined}
                onMoveRight={agencySide && !readOnly ? handleMoveRight : undefined}
                onMakeLast={agencySide && !readOnly ? handleMakeLast : undefined}
                onAddAfter={
                  agencySide && !readOnly
                    ? (index: number) => openAdd({ mode: 'insertAfter', index })
                    : undefined
                }
                onRemove={agencySide && !readOnly ? handleRemove : undefined}
              />
              {gallery.length > 0 ? (
                <p className="mt-2.5 text-xs text-fg-3">
                  Tap a slide for full screen. Long-press to place a pin.
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

            <section className="rounded-xl border border-border bg-panel-2 p-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-fg-3">
                  Caption
                </span>
                {currentVersionNumber !== null ? (
                  <VersionPill
                    versionNumber={currentVersionNumber}
                    onClick={() => setHistoryOpen(true)}
                  />
                ) : null}
                {checkpointCounts.total > 0 ? (
                  <span
                    title="Checkpoints resolved"
                    className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-xs font-medium tabular-nums text-fg-2"
                  >
                    {checkpointCounts.resolved} of {checkpointCounts.total}
                  </span>
                ) : null}
                <div className="flex-1" />
                {hasCaption && !editingCaption ? (
                  <IconButton
                    label="Copy caption"
                    onClick={() => {
                      void writeClipboard(post.caption ?? '').then(() => push('Caption copied'));
                    }}
                  >
                    <IconCopy size={18} />
                  </IconButton>
                ) : null}
                {agencySide && !editingCaption && !readOnly ? (
                  <IconButton label="Edit caption" onClick={openCaptionEditor}>
                    <IconPencil size={16} />
                  </IconButton>
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
                      {captionSaving ? 'Saving' : 'Save'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="lg"
                      disabled={captionSaving}
                      onClick={() => {
                        setEditingCaption(false);
                        setCaptionError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <span className="ml-auto text-xs tabular-nums text-fg-3">
                      {captionDraft.trim().length}/5000
                    </span>
                  </div>
                </div>
              ) : hasCaption ? (
                <>
                  <div className="mt-3">
                    <CaptionView
                      caption={post.caption ?? ''}
                      annotations={highlights}
                      onHighlightClick={(commentId) => flashTo('feedback', `comment-${commentId}`)}
                      onAnnotate={handleAnnotate}
                    />
                  </div>
                  <p className="mt-2 text-xs text-fg-3">Select any text to comment on it.</p>
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

            <div className="md:hidden">{stageSection}</div>
          </div>

          <aside
            id={pcsTabPanelId('feedback')}
            className={cn(
              'md:sticky md:top-14 md:max-h-[calc(100vh-3.5rem)] md:self-start md:overflow-y-auto',
              pcsTabPanelClass(true, true),
            )}
          >
            <div className="flex items-center gap-2 md:hidden">
              <h2 className="text-lg font-semibold tracking-tight">Feedback</h2>
              {checkpointCounts.total - checkpointCounts.resolved > 0 ? (
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold tabular-nums text-accent">
                  {checkpointCounts.total - checkpointCounts.resolved}
                </span>
              ) : null}
            </div>
            {workspaceId !== null && postId !== undefined ? (
              <FeedbackLedger
                workspaceId={workspaceId}
                postId={postId}
                postStage={currentStage}
                viewerIsClient={clientRole}
                viewerUserId={userId ?? ''}
                refreshSignal={commentsRefresh}
                onMutated={bumpCommentsRefresh}
                onCounts={handleLedgerCounts}
              />
            ) : null}

            <div className="hidden md:block">{stageSection}</div>

            <section className="rounded-xl border border-border bg-panel-2 p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-fg-3">
                  Comments
                </span>
                <span className="text-xs text-fg-3">Tap the menu for actions</span>
              </div>
              {workspaceId !== null && postId !== undefined ? (
                <Comments
                  workspaceId={workspaceId}
                  entityType="post"
                  entityId={postId}
                  annotationsByCommentId={annotationsByCommentId}
                  onAnnotationChipClick={(commentId) =>
                    flashTo('post', `caption-mark-${commentId}`)
                  }
                  refreshSignal={commentsRefresh}
                  focusCommentId={focusCommentId}
                  viewerIsClient={clientRole}
                />
              ) : (
                <div className="px-4 py-8 text-center text-sm text-fg-3">
                  Select a workspace to view comments.
                </div>
              )}
            </section>
          </aside>
        </div>
      )}

      <CaptionAnnotationComposer
        open={composer !== null}
        quote={composer?.quote ?? ''}
        submitting={annotating}
        onClose={() => {
          if (!annotating) setComposer(null);
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
        submitting={pinSubmitting}
        onClose={() => {
          if (!pinSubmitting) setPinComposer(null);
        }}
        onSubmit={submitPinAnnotation}
      />

      <PostDetailsSheet
        open={showDetails}
        onClose={() => setShowDetails(false)}
        workspaceId={workspaceId ?? ''}
        isAgencySide={agencySide}
        isClient={clientRole}
        bucketId={post.bucket_id}
        ownerUserId={post.owner_user_id}
        targetDate={post.target_date}
        origin={post.origin}
        memberOptions={memberOptions}
        ownerName={ownerInfo.name}
        ownerAvatarUrl={ownerInfo.avatarUrl}
        onChangeBucket={(bucketId) => void applyPostUpdate({ bucketId })}
        onChangeOwner={(ownerUserId) => void applyPostUpdate({ ownerUserId })}
        onChangeTargetDate={(targetDate) => void applyPostUpdate({ targetDate })}
      />

      <SlideActionsSheet
        open={slideIndex !== null}
        onClose={() => setSlideIndex(null)}
        index={slideIndex ?? 0}
        count={gallery.length}
        onMoveLeft={() => {
          if (slideIndex !== null) handleMoveLeft(slideIndex);
        }}
        onMoveRight={() => {
          if (slideIndex !== null) handleMoveRight(slideIndex);
        }}
        onAddAfter={() => {
          if (slideIndex !== null) openAdd({ mode: 'insertAfter', index: slideIndex });
        }}
        onRemove={() => {
          if (slideIndex !== null) handleRemove(slideIndex);
        }}
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
      />

      <VersionHistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        versions={versionViews}
        currentVersionNumber={currentVersionNumber}
        resolveAuthor={resolveAuthorName}
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
        />
      ) : null}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
