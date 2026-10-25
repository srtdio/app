import { FORMER_MEMBER } from '@/lib/people-names';
import { appPresignCache } from '@/lib/shared-presign';
import { useSearchJump } from '@/lib/search/jump';
import { Highlight, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { Comments } from '@/components/comments/Comments';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { LoadError } from '@/components/ui/LoadError';
import { useOptionalToast } from '@/components/ui/toast';
import {
  ICON_SIZE,
  IconBriefs,
  IconCheck,
  IconChevronLeft,
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
import { civilDay, formatDate, formatDue, formatDueDate, formatOverdue } from '@/lib/time';
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
import { listPosts, type PipelinePost } from '@srtdio/posts';
import { briefClose } from '@srtdio/rpc';

// The line under a closed brief's title (and in the Close confirm).
export const CLOSED_BRIEF_LINE = 'Closed briefs stay readable and open to comments.';

// The brief title matches the post title on the same screen size (Post detail
// uses this exact size on phone and desktop). It wraps, never scrolls sideways.
export const BRIEF_TITLE_CLASS =
  'min-w-0 break-words text-3xl font-semibold tracking-tight text-fg';

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
 * containers, so nothing jumps when the brief arrives. Token fills, no motion.
 */
export function BriefDetailSkeleton(): ReactElement {
  const row = (key: number) => (
    <div key={key} className="flex flex-col gap-1">
      <div className="h-4 w-16 rounded bg-panel-2" />
      <div className="h-4 w-20 rounded bg-panel-2" />
    </div>
  );
  return (
    <div
      data-testid="brief-detail-skeleton"
      aria-busy="true"
      className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6"
    >
      <div className="md:col-span-2 flex flex-col gap-6">
        <div className="h-8 w-3/4 rounded bg-panel-2" />
        <div className="flex flex-col gap-1.5 md:hidden">
          <div className="h-4 w-52 rounded bg-panel-2" />
          <div className="h-4 w-28 rounded bg-panel-2" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="mb-1 h-3 w-20 rounded bg-panel-2" />
          <div className="h-4 w-full rounded bg-panel-2" />
          <div className="h-4 w-11/12 rounded bg-panel-2" />
          <div className="h-4 w-2/3 rounded bg-panel-2" />
        </div>
      </div>
      <aside className="hidden md:flex flex-col gap-3">
        <div className="mb-2 h-3 w-14 rounded bg-panel-2" />
        {[0, 1, 2, 3, 4].map(row)}
      </aside>
    </div>
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
  /** "Due 14 Aug", or the overdue wording ("Overdue 2 months"); null when not shown. */
  due: string | null;
  /** True when the due part reads overdue (painted text-bad). */
  overdue: boolean;
}

/**
 * The top bar's status line: "Open · Due 14 Aug", "Open · Overdue 2 months"
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
 * How many workspace posts the linked-posts list reads (the existing listPosts
 * read, filtered here by brief_id). When the filter finds fewer than the
 * brief's linked count, the section falls back to the count.
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

// posts.stage is a plain text column; an unknown value gets the draft dot.
const LINKED_STAGE_DOT: Record<string, string> = {
  draft: 'bg-fg-3',
  review: 'bg-accent',
  approved: 'bg-good',
  parked: 'bg-warn',
  rejected: 'bg-bad',
};

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
 * The day this brief was raised, read on the viewer's clock (`timeZone` is for
 * tests) with the app day format: "22 Sep", or "22 Sep 2025" outside now's
 * year. An unparseable created_at is returned unchanged, and an unknown zone
 * never throws.
 */
export function briefRaisedLabel(
  createdAt: string,
  timeZone?: string,
  now: Date = new Date(),
): string {
  return formatDate(createdAt, now, timeZone) || createdAt;
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

const SECTION_LABEL = 'text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

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

export function BriefDetailPage({ briefId: briefIdProp }: { briefId?: string } = {}) {
  const params = useParams();
  // The pretty-link resolver (/b/:ref) passes the resolved id as a prop; the
  // classic /briefs/:briefId route supplies it via the URL. The prop wins so the
  // address bar can stay on the pretty URL without a redirect.
  const briefId = briefIdProp ?? params.briefId;
  const navigate = useNavigate();
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

  // Email deep-link: ?comment={commentId} focuses that comment row. Captured into
  // state so it survives the immediate strip below, then handed to Comments which
  // owns the scroll-to-and-flash. Fired once per distinct id; only 'comment' is
  // stripped, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  // A search jump's words: coloured in the title, objective and comments until
  // this page unmounts (the target comment comes through ?comment= below).
  const searchJump = useSearchJump();
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const handledCommentParam = useRef<string | null>(null);
  useEffect(() => {
    const comment = searchParams.get('comment');
    if (comment === null || comment === '') return;
    if (handledCommentParam.current === comment) return;
    handledCommentParam.current = comment;
    setFocusCommentId(comment);
    const next = new URLSearchParams(searchParams);
    next.delete('comment');
    setSearchParams(next, { replace: true });
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
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadFailed(false);
      const result = await getBrief(supabase, briefId);
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
    [briefId],
  );

  useEffect(() => {
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
      if (active) setGallery(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [briefId]);

  // Linked posts: the existing workspace posts read, filtered to this brief.
  // Only read when the brief has any; null until the read settles (nothing
  // shows meanwhile), and a failed read leaves the count to stand in.
  const [linkedPosts, setLinkedPosts] = useState<LinkedPost[] | null>(null);
  const linkedCount = detail?.linked_posts_count ?? 0;
  useEffect(() => {
    setLinkedPosts(null);
    if (briefId === undefined || workspaceId === null || linkedCount === 0) return;
    let active = true;
    listPosts(supabase, { workspaceId, limit: LINKED_POSTS_SCAN }).then(
      (result) => {
        if (active) setLinkedPosts(result.ok ? linkedPostsFor(result.data, briefId) : []);
      },
      () => {
        if (active) setLinkedPosts([]);
      },
    );
    return () => {
      active = false;
    };
  }, [briefId, workspaceId, linkedCount]);

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
    if (target === 'pop') navigate(-1);
    else navigate(target);
  }

  // The same chevron as Post detail.
  const backButton = (
    <IconButton label="Back" className="shrink-0" onClick={goBack}>
      <IconChevronLeft size={ICON_SIZE.control} />
    </IconButton>
  );

  const bareHeader = (
    <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
      {backButton}
    </div>
  );

  if (loading) {
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
        <div className="px-4 md:px-6 mt-4">
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

  const brief = detail.brief;
  const closed = isBriefClosed(brief);
  const links = briefExternalLinks(brief.reference_links, gallery);
  const mediaItems = briefMediaItems(gallery);
  const canClose = !closed && canCloseBrief(canCloseAny, canCloseOwn, brief.created_by, viewerId);
  const hasBrand = brief.brand_requirements !== null && brief.brand_requirements.trim() !== '';
  const hasFormat = brief.format_requested !== null && brief.format_requested.trim() !== '';
  const statusLine = briefStatusLine(brief.status, brief.target_date, timeZone);
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
  // The details as two short lines, the same on phone (under the title) and
  // desktop (the side column): "Raised 15 Jun by Priya Raman", then "Format
  // Carousel" when a format is set. Status and due date live in the top bar.
  const detailsLines = (
    <div className="flex min-w-0 flex-col gap-1 text-base">
      <p data-brief-raised="" className="min-w-0 break-words text-fg">
        <span className="text-fg-3">Raised</span>{' '}
        <span className="tabular-nums">{briefRaisedLabel(brief.created_at)}</span>
        {authorLabel === '' && membersLoading ? (
          <span
            data-testid="created-by-skeleton"
            aria-label="Loading"
            className="ml-1 inline-block h-4 w-28 rounded bg-panel-3 align-middle"
          />
        ) : authorLabel !== '' ? (
          <> by {authorLabel}</>
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
                  className="-mx-2 flex min-h-[44px] min-w-0 items-center gap-2 rounded-md px-2 text-base text-fg transition-colors duration-fast hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span
                    aria-hidden="true"
                    className={`h-[7px] w-[7px] shrink-0 rounded-full ${LINKED_STAGE_DOT[post.stage] ?? 'bg-fg-3'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{post.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Link
            to="/pipeline"
            data-linked-posts-count=""
            className="-mx-2 inline-flex min-h-[44px] min-w-[44px] items-center rounded-md px-2 text-base tabular-nums text-accent transition-colors duration-fast hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {linkedCount}
          </Link>
        )}
      </section>
    );

  return (
    <SearchWordsContext.Provider value={searchJump.words}>
      <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
        {backButton}
        {/* The status line, as the post screen's: a 7px dot and 15px semibold. */}
        <div data-brief-status-line="" className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-[7px] w-[7px] shrink-0 rounded-full ${closed ? 'bg-fg-3' : 'bg-accent'}`}
          />
          <span className="truncate text-lg font-semibold text-fg">
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
        </div>
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
        <div data-brief-more="" className="shrink-0">
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
        </div>
      </div>

      <div className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* One order on phone and desktop: title (details lines under it on
            phone), Objective, Brand requirements, Attachments, Reference links,
            Comments. Desktop's side column holds the details and linked posts. */}
        <div className="md:col-span-2 flex min-w-0 flex-col gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className={BRIEF_TITLE_CLASS}>
              <Highlight text={brief.title} />
            </h1>
            {closed ? <p className="text-base text-fg-2">{CLOSED_BRIEF_LINE}</p> : null}
            <div data-brief-details="phone" className="md:hidden">
              {detailsLines}
            </div>
          </div>

          {linkedSection !== null ? <div className="md:hidden">{linkedSection}</div> : null}

          <section className="min-w-0">
            <div className={`${SECTION_LABEL} mb-1`}>Objective</div>
            <p className="text-base leading-relaxed whitespace-pre-wrap break-words text-fg">
              <Highlight text={brief.objective} />
            </p>
          </section>

          {hasBrand ? (
            <section className="min-w-0">
              <div className={`${SECTION_LABEL} mb-1`}>Brand requirements</div>
              <p className="text-base leading-relaxed whitespace-pre-wrap break-words text-fg">
                {brief.brand_requirements}
              </p>
            </section>
          ) : null}

          {mediaItems.length > 0 ? (
            <section className="min-w-0">
              <PostGallery
                items={mediaItems}
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
                workspaceId={workspaceId}
                entityType="brief"
                entityId={briefId}
                focusCommentId={focusCommentId}
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
          <div aria-hidden="true" data-brief-action-space="" className="h-[76px]" />
          <div
            data-brief-action-bar=""
            {...bottomAnchorProps}
            className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
          >
            <Button
              variant="primary"
              data-new-post-from-brief="bar"
              className="w-full"
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
