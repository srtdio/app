import { mark } from '@/lib/perf-marks';
import { FORMER_MEMBER } from '@/lib/people-names';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { appPresignCache } from '@/lib/shared-presign';
import { useSearchJump } from '@/lib/search/jump';
import { Highlight, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { Bone, BoxSkeleton, useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import { leaveIntoCard, useGrowFromCard } from '@/lib/motion/pages';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { Comments } from '@/components/comments/Comments';
import { renderFormatted } from '@/components/chat/message-body';
import { EmptyState } from '@/components/ui/EmptyState';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { STATUS_DOT_TONE, StatusDot, type StatusDotStage } from '@/components/ui/StatusDot';
import { SECTION_LABEL, Text, textRole } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import {
  ICON_SIZE,
  IconBriefs,
  IconCheck,
  IconCopy,
  IconLink,
  IconPlus,
} from '@/components/ui/icons';
import { PostGallery } from '@/components/pages/pcs/PostGallery';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { BRIEF_STATUS, isBriefClosed } from '@/components/pages/BriefCard';
import { BriefLink } from '@/components/pages/BriefLink';
import { BRIEF_NOTE_PARAM } from '@/lib/brief-list';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import type { PresignDeps } from '@/lib/asset-presign';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { entityUrlPath } from '@/lib/entityRef';
import { dispatchWorkspaceDataChanged } from '@/lib/events';
import { civilDay, formatDue, formatDueDate, formatOverdue, formatAgo } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { postFormatLabel } from '@/lib/post-format';
import { copyText, COPY_FAILED } from '@/lib/clipboard';
import { errorText } from '@/lib/error-copy';
import { hasPreviousEntry } from '@/lib/chat/use-history-step';
import { useSession } from '@/lib/session-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { bottomAnchorProps } from '@/lib/bottom-inset';
import { toExternalLinks, type ExternalLink } from '@/lib/links';
import { getBrief, getBriefGallery, reopenBrief } from '@srtdio/briefs';
import type { Brief, BriefGalleryItem, BriefWithLinkedCount, DomainError } from '@srtdio/briefs';
import type { PipelinePost, Stage } from '@srtdio/posts';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
// Not on the package index (owned elsewhere); the read lives beside listPosts.
import { listBriefLinkedPosts } from '../../../packages/posts/src/reads';
import { briefClose } from '@srtdio/rpc';
import { SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';
import { currentEntryState } from '@/lib/focus-target';

// The line under a closed brief's title (and in the Close confirm).
export const CLOSED_BRIEF_LINE = 'Closed briefs stay readable and open to comments.';

/**
 * The comment box inside the Comments section, for "Add note" (the note failed
 * to post on create). Comments renders it after its own read, so the caller
 * retries for a short while. Returns whether it focused.
 */
export function focusCommentBox(root: HTMLElement | null): boolean {
  const box = root?.querySelector<HTMLElement>('[aria-label="Comment body"]') ?? null;
  if (box === null) return false;
  box.scrollIntoView({ block: 'center' });
  box.focus();
  return true;
}

/**
 * The loading state: a static skeleton in the loaded page's shape (title,
 * the two details lines, Objective lines; the Details column on desktop), in the same
 * containers, so nothing jumps when the brief arrives. Shared Bone boxes (sweep, never a pulse).
 */
export function BriefDetailSkeleton(): ReactElement {
  const row = (key: number) => (
    <div key={key} className="flex flex-col gap-1">
      <Bone lit="flat" as="div" className="h-4 w-16 rounded" />
      <Bone lit="flat" as="div" className="h-4 w-20 rounded" />
    </div>
  );
  return (
    <BoxSkeleton
      lit="flat"
      label="Loading brief"
      data-testid="brief-detail-skeleton"
      className={cn(GUTTER, 'py-6 grid grid-cols-1 md:grid-cols-3 gap-6')}
    >
      <div className="md:col-span-2 flex flex-col gap-6">
        <Bone lit="flat" as="div" className="h-8 w-3/4 rounded" />
        <div className="flex flex-col gap-2 md:hidden">
          <Bone lit="flat" as="div" className="h-4 w-52 rounded" />
          <Bone lit="flat" as="div" className="h-4 w-28 rounded" />
        </div>
        <div className="flex flex-col gap-2">
          <Bone lit="flat" as="div" className="mb-1 h-3 w-20 rounded" />
          <Bone lit="flat" as="div" className="h-4 w-full rounded" />
          <Bone lit="flat" as="div" className="h-4 w-11/12 rounded" />
          <Bone lit="flat" as="div" className="h-4 w-2/3 rounded" />
        </div>
      </div>
      <aside className="hidden md:flex flex-col gap-3">
        <Bone lit="flat" as="div" className="mb-2 h-3 w-14 rounded" />
        {[0, 1, 2, 3, 4].map(row)}
      </aside>
    </BoxSkeleton>
  );
}

/**
 * briefs.target_date is a due date in a date-only column: "2026-10-08" reads
 * "8 Oct" ("8 Oct 2027" outside now's year) on every machine, whatever the
 * browser zone (the string's own parts, never new Date(value)); the workspace
 * zone only decides now's year.
 */
export function briefDueDateLabel(
  targetDate: string | null,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  return targetDate !== null
    ? formatDueDate(targetDate, workspaceZone, now) || targetDate
    : 'Not set';
}

export interface BriefStatusLine {
  status: 'Open' | 'Closed';
  /** "Due 14 Aug", or the overdue wording ("Overdue 2mo"); null when not shown. */
  due: string | null;
  /** True when the due part reads overdue (painted text-bad). */
  overdue: boolean;
}

/**
 * The top bar's status line: "Open · Due 14 Aug", "Open · Overdue 2mo"
 * once the due day has passed in the workspace zone, plain "Open" with no due
 * date, and plain "Closed" for a closed brief. The date-only target_date is read
 * as written; the workspace zone only decides which day is today. Pure.
 */
export function briefStatusLine(
  status: string,
  targetDate: string | null,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): BriefStatusLine {
  if (status === BRIEF_STATUS.closed) return { status: 'Closed', due: null, overdue: false };
  if (targetDate === null) return { status: 'Open', due: null, overdue: false };
  if (targetDate < civilDay(now, workspaceZone ?? undefined)) {
    return {
      status: 'Open',
      due: formatOverdue(targetDate, workspaceZone, now).text,
      overdue: true,
    };
  }
  const due = formatDue(targetDate, workspaceZone, now);
  return { status: 'Open', due: due === '' ? null : due, overdue: false };
}

/** The requested format proper-cased ("carousel" -> "Carousel"), never the raw enum. */
export function briefFormatLabel(format: string): string {
  return postFormatLabel(format.trim());
}

/**
 * What "Copy brief" puts on the clipboard: the title, then every text section
 * under its label (Objective, then Brand requirements when set). Pure.
 */
export function briefCopyText(
  brief: Pick<Brief, 'title' | 'objective' | 'brand_requirements'>,
): string {
  const parts = [brief.title, `Objective\n${brief.objective}`];
  const brand = brief.brand_requirements?.trim() ?? '';
  if (brand !== '') parts.push(`Brand requirements\n${brand}`);
  return parts.join('\n\n');
}

/**
 * How many of the brief's posts the linked-posts list reads (one posts read
 * filtered on brief_id). When it finds fewer than the brief's linked count,
 * the section falls back to the count.
 */
export const LINKED_POSTS_SCAN = 200;

export type LinkedPost = Pick<PipelinePost, 'id' | 'title' | 'stage' | 'created_at'>;

/** This brief's posts out of a workspace read, newest first. Pure. */
export function linkedPostsFor(
  posts: readonly Pick<PipelinePost, 'id' | 'title' | 'stage' | 'created_at' | 'brief_id'>[],
  briefId: string,
): LinkedPost[] {
  return posts
    .filter((post) => post.brief_id === briefId)
    .map(({ id, title, stage, created_at }) => ({ id, title, stage, created_at }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** A linked post's stage as the status dot's stage (posts.stage is plain text; an unknown value reads as Draft). */
function linkedDotStage(stage: string): StatusDotStage {
  return Object.hasOwn(STATUS_DOT_TONE, stage) ? (stage as StatusDotStage) : 'draft';
}

/**
 * Whether the viewer may close this brief: brief.close, or brief.close_own on a
 * brief they created. The proc re-checks the same rule. Pure.
 */
export function canCloseBrief(
  canCloseAny: boolean | null,
  canCloseOwn: boolean | null,
  createdBy: string | null,
  viewerId: string | null,
): boolean {
  if (canCloseAny === true) return true;
  return canCloseOwn === true && viewerId !== null && createdBy === viewerId;
}

/** Back goes one in-app step back when there is one, else to the list. Pure. */
export function briefBackTarget(historyState: unknown): 'pop' | '/briefs' {
  return hasPreviousEntry(historyState) ? 'pop' : '/briefs';
}

/**
 * When this brief was raised, short (formatAgo): "just now", "5m", "3h",
 * "Yesterday", "Mon", "2 Nov" ("2 Nov 2025" off-year). An unparseable
 * created_at is returned unchanged.
 */
export function briefRaisedLabel(createdAt: string, now: Date = new Date()): string {
  return formatAgo(createdAt, now) || createdAt;
}

/**
 * Every external URL this brief carries, in one deduped list: the reference_links
 * jsonb first (whatever legacy shape it holds), then the URL of every link-kind
 * attachment. Link attachments used to reach PostGallery, which has no link
 * branch and painted them as dead tiles; they belong here, as real buttons.
 * Deduping runs over the combined input so the same URL stored both ways shows
 * once. Pure, so the merge and its order are unit-tested without rendering.
 */
export function briefExternalLinks(
  referenceLinks: unknown,
  gallery: readonly BriefGalleryItem[],
): ExternalLink[] {
  return toExternalLinks([
    ...toExternalLinks(referenceLinks).map((link) => link.href),
    ...gallery.filter((item) => item.kind === 'link').map((item) => item.externalUrl),
  ]);
}

/** The gallery minus link-kind attachments: only real media reaches PostGallery. */
export function briefMediaItems(gallery: readonly BriefGalleryItem[]): BriefGalleryItem[] {
  return gallery.filter((item) => item.kind !== 'link');
}

// Resolve a brief's "Created by" to a display name: prefer the current member
// name for created_by, then the ETL-frozen legacy author name, then the shared
// "Former member" label for a creator confirmed not to be a current member (no
// creator at all, or the loaded member list does not have them). While that
// list has not loaded, a creator id renders nothing extra (never "Former member"
// early). Pure so the precedence is unit-tested without rendering.
export function briefAuthorLabel(
  createdBy: string | null,
  legacyAuthorName: string | null,
  memberName: (id: string) => string | null,
  membersLoaded = true,
): string {
  const hasCreator = createdBy !== null && createdBy !== '';
  const member = hasCreator ? memberName(createdBy) : null;
  if (member !== null) return member;
  if (legacyAuthorName !== null) return legacyAuthorName;
  return hasCreator && !membersLoaded ? '' : FORMER_MEMBER;
}

/**
 * A failed reopen in plain words: invalid_payload means the brief is no longer
 * closed (someone reopened it first); anything else reads through the shared
 * "Couldn't reopen the brief. {reason}" line (workspace_member_only, offline).
 * Pure.
 */
export function reopenErrorCopy(error: DomainError): string {
  return error.code === 'invalid_payload'
    ? 'This brief is already open.'
    : errorText('reopen the brief', error);
}

/**
 * The absolute link Copy link puts on the clipboard: the pretty /b/KEY-N link
 * on the current origin, or the classic /briefs/:id route when the workspace
 * key is unavailable. Pure.
 */
export function briefCopyLink(
  origin: string,
  workspaceKey: string | null,
  briefNumber: number,
  briefId: string,
): string {
  const path =
    workspaceKey !== null
      ? entityUrlPath('brief', workspaceKey, briefNumber)
      : `/briefs/${briefId}`;
  return origin + path;
}

/**
 * The header ⋯ menu's rows (ui/ActionMenu), on every brief for every member:
 * Copy link, Copy brief, then Close brief (open, and the viewer may close) or
 * Reopen brief (closed, any member). Briefs are never deleted, so there is no
 * Delete row. Pure.
 */
export function briefMenuItems(args: {
  closed: boolean;
  canClose: boolean;
  onCopyLink: () => void;
  onCopyBrief: () => void;
  onCloseBrief: () => void;
  onReopenBrief: () => void;
}): ActionMenuItem[] {
  const items: ActionMenuItem[] = [
    { id: 'copy-link', label: 'Copy link', icon: IconLink, onSelect: args.onCopyLink },
    { id: 'copy-brief', label: 'Copy brief', icon: IconCopy, onSelect: args.onCopyBrief },
  ];
  if (args.closed) {
    items.push({
      id: 'reopen-brief',
      label: 'Reopen brief',
      icon: IconBriefs,
      onSelect: args.onReopenBrief,
    });
  } else if (args.canClose) {
    items.push({
      id: 'close-brief',
      label: 'Close brief',
      icon: IconCheck,
      onSelect: args.onCloseBrief,
    });
  }
  return items;
}

export function BriefDetailPage({
  briefId: briefIdProp,
  resolving = false,
}: {
  briefId?: string;
  /**
   * The pretty-link resolver (/b/:ref) is still finding the id: hold the
   * skeleton (never not-found) so the route shows one loader, not two.
   */
  resolving?: boolean;
} = {}) {
  // The one shared minute clock: the Raised time and the due line age with it.
  const nowMs = useMinuteClock();
  const params = useParams();
  // The pretty-link resolver (/b/:ref) passes the resolved id as a prop; the
  // classic /briefs/:briefId route supplies it via the URL. The prop wins so the
  // address bar can stay on the pretty URL without a redirect.
  const briefId = briefIdProp ?? params.briefId;
  const navigate = useNavigate();
  // growFromCard (kept on laptop): opened from a card tap, the page grows out
  // of that card on its first frame (layout effect, no wait); Back grows it
  // back into the card. Never on a kept-view tab return.
  const pageAnchorRef = useRef<HTMLElement>(null);
  useGrowFromCard(briefId, pageAnchorRef);
  const newTrace = useNewTrace();
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const toast = useOptionalToast();
  const isLaptop = useIsLaptop();
  const { run: runUndoable } = useUndoableAction();
  const { session } = useSession();
  const viewerId = session?.user.id ?? null;
  const canCloseAny = useWorkspaceCapability('brief.close');
  const canCloseOwn = useWorkspaceCapability('brief.close_own');
  // Approvers write briefs; only the other side starts a post from one.
  const isApprover = useWorkspaceCapability('brief.create') === true;
  // Creators (they make posts, not briefs) start a post from an open brief.
  const canCreatePost = useWorkspaceCapability('post.create') === true;

  // The active workspace's zone: the due date is a calendar day on it, so the
  // overdue flip happens at the workspace's midnight. Raised (a moment) reads
  // the viewer's device clock.
  const timeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? null;

  // Resolve created_by to a current member's display name, never a raw uuid.
  // Reuses the shared workspace members read; the map is the resolver behind
  // briefAuthorLabel below.
  const {
    options: memberOptions,
    loading: membersLoading,
    error: membersError,
  } = useWorkspaceMembers(workspaceId);
  // Only a list that loaded proves someone is not a current member.
  const membersLoaded = !membersLoading && membersError === null;
  const memberById = useMemo(
    () => new Map(memberOptions.map((o) => [o.userId, o.displayName])),
    [memberOptions],
  );

  // A comment link (?comment={commentId}: Activity, toast, email, search) focuses
  // that comment row. Captured into state so it survives the immediate strip
  // below, then handed to Comments, which lands on it (useFocusTarget, keyed by
  // id: a new id on this same page runs again). Only 'comment' is stripped,
  // preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  // A search jump's words: coloured in the title, objective and comments until
  // this page unmounts (the target comment comes through ?comment= below).
  const searchJump = useSearchJump();
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  // A fresh key per arriving link, so the same comment linked twice lands twice.
  const [focusRequestKey, setFocusRequestKey] = useState<string | null>(null);
  useEffect(() => {
    const comment = searchParams.get('comment');
    if (comment === null || comment === '') return;
    setFocusCommentId(comment);
    setFocusRequestKey(`${comment}:${Date.now()}`);
    const next = new URLSearchParams(searchParams);
    next.delete('comment');
    // Keep the entry's router state (an in-app open's ref id).
    setSearchParams(next, { replace: true, state: currentEntryState() });
  }, [searchParams, setSearchParams]);

  // "Add note" from the create toast (?note=1): captured, stripped, then the
  // comment box is focused once Comments has rendered it.
  const [wantsNote, setWantsNote] = useState(false);
  useEffect(() => {
    if (searchParams.get(BRIEF_NOTE_PARAM) === null) return;
    setWantsNote(true);
    const next = new URLSearchParams(searchParams);
    next.delete(BRIEF_NOTE_PARAM);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const commentsRef = useRef<HTMLElement>(null);

  const [detail, setDetail] = useState<BriefWithLinkedCount | null>(null);
  const [gallery, setGallery] = useState<BriefGalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // One presign setup for this page, built exactly as the post detail page does:
  // the asset-read endpoint env, the existing access-token source, and the trace
  // fetcher. deps are kept for the lightbox's attachment-disposition download; the
  // cache bounds concurrency and reuses inline URLs across thumbnails.
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

  // `silent` skips the full-page loading flip so the post-close refetch updates
  // the badge in place rather than blanking the screen. A failed read is a load
  // error (LoadError + Retry, never the server's text); a missing brief is its
  // own not-found state.
  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (briefId === undefined) {
        if (resolving) {
          setLoading(true);
          return;
        }
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadFailed(false);
      const result = await getBrief(supabase, briefId);
      mark('brief:row-in');
      if (!silent) setLoading(false);
      if (!result.ok) {
        if (!silent) setLoadFailed(true);
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
    [briefId, resolving],
  );

  useEffect(() => {
    mark('brief:mount');
    void load();
  }, [load]);

  // "Add note": once the brief is on screen, focus the comment box. Comments
  // renders it after its own read, so try for up to 3s, then give up quietly.
  const detailReady = detail !== null;
  useEffect(() => {
    if (!wantsNote || !detailReady) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (): void => {
      if (focusCommentBox(commentsRef.current) || tries >= 30) {
        setWantsNote(false);
        return;
      }
      tries += 1;
      timer = setTimeout(attempt, 100);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [wantsNote, detailReady]);

  // The reference gallery is a separate read (asset_attachments has no FK back to
  // briefs, so it cannot ride getBrief's read) and is non-critical: a failure or
  // an absent brief simply leaves the gallery empty rather than blocking the page.
  useEffect(() => {
    if (briefId === undefined) {
      setGallery([]);
      return;
    }
    let active = true;
    void getBriefGallery(supabase, briefId).then((result) => {
      mark('brief:gallery-in');
      if (active) setGallery(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [briefId]);

  // Linked posts: one posts read filtered on this brief's id (never a whole
  // workspace scan), started on the first render beside the brief read rather
  // than after its count lands, so both arrive in the same round trip. null
  // until it settles; a failed read leaves the count to stand in. A brief with
  // no linked posts shows nothing whatever this read returns.
  const [linkedPosts, setLinkedPosts] = useState<LinkedPost[] | null>(null);
  const linkedCount = detail?.linked_posts_count ?? 0;
  useEffect(() => {
    setLinkedPosts(null);
    if (briefId === undefined) return;
    let active = true;
    listBriefLinkedPosts(supabase, { briefId, limit: LINKED_POSTS_SCAN }).then(
      (result) => {
        mark('brief:linked-in');
        if (active) setLinkedPosts(result.ok ? result.data : []);
      },
      () => {
        if (active) setLinkedPosts([]);
      },
    );
    return () => {
      active = false;
    };
  }, [briefId]);
  // First paint = final state: while a brief that has linked posts waits on
  // their list, the skeleton holds (the list never pops in under the page).
  // Both reads left together, so this rarely waits at all.
  const linkedPending = detail !== null && linkedCount > 0 && linkedPosts === null;

  // Close straight away behind the UNDO_MS Undo (PR B: a close comes back
  // with Reopen, so it asks nothing): the badge flips to Closed at once, Undo
  // puts it back, and brief_close runs only once the window passes. A failed
  // close restores Open and says so in plain words.
  function closeWithUndo(): void {
    if (briefId === undefined || detail === null) return;
    const before = detail.brief.status;
    const setStatus = (status: string): void =>
      setDetail((prev) => (prev === null ? prev : { ...prev, brief: { ...prev.brief, status } }));
    setStatus(BRIEF_STATUS.closed);
    runUndoable({
      label: 'Brief closed',
      revert: () => setStatus(before),
      commit: async () => {
        const result = await briefClose(supabase, { p_brief_id: briefId, p_trace_id: newTrace() });
        if (!result.ok) {
          setStatus(before);
          toast?.show({ title: errorText('close the brief', result.error), tone: 'error' });
          return;
        }
        // Lists and counts that read on mount (Briefs, the chat status drawer)
        // re-read, so a commit flushed by navigating away still lands there.
        dispatchWorkspaceDataChanged();
        await load(true);
      },
    });
  }

  // Reopen straight away behind the same Undo: the badge flips to Open at once,
  // Undo puts Closed back, and brief_reopen runs only once the window passes.
  // Any active member may reopen (the proc's rule; no capability check here). A
  // failed reopen restores Closed and says so in plain words.
  function reopenWithUndo(): void {
    if (briefId === undefined || detail === null) return;
    const before = detail.brief.status;
    const setStatus = (status: string): void =>
      setDetail((prev) => (prev === null ? prev : { ...prev, brief: { ...prev.brief, status } }));
    setStatus(BRIEF_STATUS.open);
    runUndoable({
      label: 'Brief reopened',
      revert: () => setStatus(before),
      commit: async () => {
        const result = await reopenBrief(supabase, { briefId }, newTrace());
        if (!result.ok) {
          setStatus(before);
          toast?.show({ title: reopenErrorCopy(result.error), tone: 'error' });
          return;
        }
        dispatchWorkspaceDataChanged();
        await load(true);
      },
    });
  }

  function copyLink(): void {
    if (briefId === undefined || detail === null) return;
    const link = briefCopyLink(window.location.origin, workspaceKey, detail.brief.number, briefId);
    void copyText(link).then((ok) => {
      if (ok) toast?.show({ title: 'Link copied' });
      else toast?.show({ title: COPY_FAILED, tone: 'error' });
    });
  }

  function copyBrief(): void {
    if (detail === null) return;
    void copyText(briefCopyText(detail.brief)).then((ok) => {
      if (ok) toast?.show({ title: 'Copied' });
      else toast?.show({ title: COPY_FAILED, tone: 'error' });
    });
  }

  function goBack(): void {
    const target = briefBackTarget(window.history.state);
    if (target === 'pop') {
      leaveIntoCard(briefId, pageAnchorRef.current);
      navigate(-1);
    } else navigate(target);
  }

  // The brief screen's top bar is ui/HeaderBar (Back "<" with the leading
  // pull, the status line in the title slot, the ⋯ last), as Post detail. The
  // brief title is the page's one h1 (below), so the bar's title is never an h1.
  const topBar = (title: ReactNode, actions?: ReactNode): ReactElement => (
    <HeaderBar
      barRef={pageAnchorRef}
      compact
      onBack={goBack}
      title={title}
      titleSlot={<span className={textRole('title', 'truncate')}>{title}</span>}
      {...(actions !== undefined ? { actions } : {})}
      className={SAFE_TOP_BAR_CLASS}
    />
  );

  const bareHeader = topBar(null);

  // The page settles once when it lands after the boxes (never on a kept read).
  const showingBoxes = loading || (linkedPending && !loadFailed && !notFound);
  const hadBoxes = useHadBoxes(showingBoxes);
  const landedRef = useRef<HTMLDivElement>(null);
  useSettleOnLanding(landedRef, !showingBoxes && detail !== null, hadBoxes);

  if (showingBoxes) {
    return (
      <>
        {bareHeader}
        <BriefDetailSkeleton />
      </>
    );
  }

  if (loadFailed) {
    return (
      <>
        {bareHeader}
        <div className={cn(GUTTER, 'mt-4')}>
          <LoadError title="this brief" onRetry={() => void load()} />
        </div>
      </>
    );
  }

  if (notFound || detail === null) {
    return (
      <>
        {bareHeader}
        <EmptyState
          icon={<IconBriefs size={ICON_SIZE.tray} />}
          title="Brief not found"
          description="This brief may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" onClick={() => navigate('/briefs')}>
              Back to briefs
            </Button>
          }
        />
      </>
    );
  }

  mark('brief:paint');
  const brief = detail.brief;
  const closed = isBriefClosed(brief);
  const links = briefExternalLinks(brief.reference_links, gallery);
  const mediaItems = briefMediaItems(gallery);
  const canClose = !closed && canCloseBrief(canCloseAny, canCloseOwn, brief.created_by, viewerId);
  const hasBrand = brief.brand_requirements !== null && brief.brand_requirements.trim() !== '';
  const hasFormat = brief.format_requested !== null && brief.format_requested.trim() !== '';
  const statusLine = briefStatusLine(brief.status, brief.target_date, timeZone, new Date(nowMs));
  const showNewPost = canCreatePost && !isApprover && !closed && briefId !== undefined;
  // The brief's one action, placed as Post detail places its decision: the
  // right of the header on laptop (useIsLaptop), a bottom bar on phone.
  const newPostLabel = (
    <>
      <IconPlus size={ICON_SIZE.inline} />
      New post from this brief
    </>
  );
  const startPost = (): void => navigate(`/pipeline?new=1&brief=${encodeURIComponent(brief.id)}`);
  const authorLabel = briefAuthorLabel(
    brief.created_by,
    brief.legacy_author_name,
    (id) => memberById.get(id) ?? null,
    membersLoaded,
  );
  // The creator's name opens the person card (a legacy author with no user id: plain text).
  const creatorId = brief.created_by !== null && brief.created_by !== '' ? brief.created_by : null;
  const creatorFormer =
    creatorId !== null && membersLoaded && (memberById.get(creatorId) ?? null) === null;
  // The details as two short lines, the same on phone (under the title) and
  // desktop (the side column): "Raised Mon by Priya Raman", then "Format
  // Carousel" when a format is set. Status and due date live in the top bar.
  const detailsLines = (
    <div className="flex min-w-0 flex-col gap-1 text-base">
      <p data-brief-raised="" className="min-w-0 break-words text-fg">
        <span className="text-fg-3">Raised</span>{' '}
        <span className="tabular-nums">{briefRaisedLabel(brief.created_at, new Date(nowMs))}</span>
        {authorLabel === '' && membersLoading ? (
          <span
            data-testid="created-by-skeleton"
            aria-label="Loading"
            className="ml-1 inline-block h-4 w-28 rounded bg-panel-3 align-middle"
          />
        ) : authorLabel !== '' ? (
          <>
            {' by '}
            {creatorId !== null ? (
              <PersonTrigger
                userId={creatorId}
                name={authorLabel}
                {...(creatorFormer ? { former: true } : {})}
              >
                {authorLabel}
              </PersonTrigger>
            ) : (
              authorLabel
            )}
          </>
        ) : null}
      </p>
      {hasFormat ? (
        <p data-brief-format="" className="min-w-0 break-words text-fg">
          <span className="text-fg-3">Format</span> {briefFormatLabel(brief.format_requested ?? '')}
        </p>
      ) : null}
    </div>
  );
  // Linked posts: compact rows that open each post. Nothing at all for none
  // (no "0"), nothing while the read runs, and the count as a link to the
  // pipeline when the list could not be read in full.
  const linkedSection =
    linkedCount === 0 || linkedPosts === null ? null : (
      <section data-linked-posts={linkedPosts.length >= linkedCount ? 'list' : 'count'}>
        <div className={`${SECTION_LABEL} mb-1`}>Linked posts</div>
        {linkedPosts.length >= linkedCount ? (
          <ul className="flex min-w-0 flex-col">
            {linkedPosts.map((post) => (
              <li key={post.id} className="min-w-0">
                <Link
                  to={`/posts/${post.id}`}
                  data-linked-post=""
                  className="-mx-2 flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 text-base text-fg mv-tint lit-hover focus-visible:lit-focus"
                >
                  <StatusDot stage={linkedDotStage(post.stage)} />
                  <span className="min-w-0 flex-1 truncate">{post.title}</span>
                  {/* The dot's stage in words, so the row name never rests on colour. */}
                  <span className="sr-only">, {stageLabel(post.stage as Stage)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Link
            to="/pipeline"
            data-linked-posts-count=""
            className="-mx-2 inline-flex min-h-11 min-w-11 items-center rounded-lg px-2 text-base tabular-nums text-accent mv-tint lit-hover focus-visible:lit-focus"
          >
            {linkedCount}
          </Link>
        )}
      </section>
    );

  return (
    <SearchWordsContext.Provider value={searchJump.words}>
      {topBar(
        // The status line, as the post screen's: the status dot and the title role.
        <span data-brief-status-line="" className="flex min-w-0 items-center gap-2">
          <StatusDot stage={closed ? 'closed' : 'open'} />
          <span className="truncate">
            <span data-brief-status={closed ? BRIEF_STATUS.closed : BRIEF_STATUS.open}>
              {statusLine.status}
            </span>
            {statusLine.due !== null ? (
              <>
                {' · '}
                <span
                  data-brief-due=""
                  {...(statusLine.overdue ? { 'data-overdue': '' } : {})}
                  className={statusLine.overdue ? 'text-bad' : undefined}
                >
                  {statusLine.due}
                </span>
              </>
            ) : null}
          </span>
        </span>,
        <>
          {showNewPost && isLaptop ? (
            <Button
              variant="primary"
              data-new-post-from-brief="top"
              className="shrink-0"
              onClick={startPost}
            >
              {newPostLabel}
            </Button>
          ) : null}
          <span data-brief-more="" className="flex shrink-0">
            <ActionMenu
              title="Brief actions"
              items={briefMenuItems({
                closed,
                canClose,
                onCopyLink: copyLink,
                onCopyBrief: copyBrief,
                onCloseBrief: closeWithUndo,
                onReopenBrief: reopenWithUndo,
              })}
            />
          </span>
        </>,
      )}

      <div ref={landedRef} className={cn(GUTTER, 'py-6 grid grid-cols-1 md:grid-cols-3 gap-6')}>
        {/* One order on phone and desktop: title (details lines under it on
            phone), Objective, Brand requirements, Attachments, Reference links,
            Comments. Desktop's side column holds the details and linked posts. */}
        <div className="md:col-span-2 flex min-w-0 flex-col gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            {/* The brief title matches the post title (display role); it wraps,
                never scrolls sideways. */}
            <Text as="h1" role="display" className="min-w-0 break-words text-fg">
              <Highlight text={brief.title} />
            </Text>
            {closed ? <p className="text-base text-fg-2">{CLOSED_BRIEF_LINE}</p> : null}
            <div data-brief-details="phone" className="md:hidden">
              {detailsLines}
            </div>
          </div>

          {linkedSection !== null ? <div className="md:hidden">{linkedSection}</div> : null}

          <section className="min-w-0">
            <div className={`${SECTION_LABEL} mb-1`}>Objective</div>
            <p className="text-base whitespace-pre-wrap break-words text-fg">
              {renderFormatted(brief.objective, (text) => [<Highlight key="h" text={text} />])}
            </p>
          </section>

          {hasBrand ? (
            <section className="min-w-0">
              <div className={`${SECTION_LABEL} mb-1`}>Brand requirements</div>
              <p className="text-base whitespace-pre-wrap break-words text-fg">
                {renderFormatted(brief.brand_requirements ?? '', (text) => [text])}
              </p>
            </section>
          ) : null}

          {mediaItems.length > 0 ? (
            <section className="min-w-0">
              <PostGallery
                items={mediaItems}
                title={brief.title}
                cache={cache}
                deps={deps}
                presignEnabled={presignEnabled}
                columns={2}
                aspect="3/2"
                showIndex={false}
              />
            </section>
          ) : null}

          {links.length > 0 ? (
            <section className="min-w-0">
              <div className={`${SECTION_LABEL} mb-2`}>Reference links</div>
              <ul className="flex min-w-0 flex-col gap-2">
                {links.map((link) => (
                  <li key={link.href} className="min-w-0 break-words">
                    <BriefLink url={link.href} domain={link.domain} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* No workspace: nothing at all, never a dead-end line. */}
          {workspaceId !== null && briefId !== undefined ? (
            <section ref={commentsRef} className="min-w-0">
              <div className={`${SECTION_LABEL} mb-2`}>Comments</div>
              <Comments
                // The brief's own workspace: a link can open a brief outside the active one.
                workspaceId={brief.workspace_id}
                entityType="brief"
                entityId={briefId}
                whereLabel={brief.title}
                focusCommentId={focusCommentId}
                focusRequestKey={focusRequestKey}
              />
            </section>
          ) : null}
        </div>

        <aside className="hidden md:flex min-w-0 flex-col gap-6">
          <section data-brief-details="desktop">
            <div className={`${SECTION_LABEL} mb-2`}>Details</div>
            {detailsLines}
          </section>
          {linkedSection}
        </aside>
      </div>

      {/* Phone: the primary action in a bar pinned to the bottom (the shell
          drops the tab bar on this route; safe-area aware), with room under
          the content so it never covers the comments. Laptop has it in the
          top bar instead. */}
      {showNewPost && !isLaptop ? (
        <>
          <div aria-hidden="true" data-brief-action-space="" className="h-20" />
          <div
            data-brief-action-bar=""
            {...bottomAnchorProps}
            className="lit-dock fixed inset-x-0 bottom-0 z-dock border-t bg-panel pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
          >
            <Button
              variant="primary"
              data-new-post-from-brief="bar"
              className="w-full md:w-auto"
              onClick={startPost}
            >
              {newPostLabel}
            </Button>
          </div>
        </>
      ) : null}
    </SearchWordsContext.Provider>
  );
}
