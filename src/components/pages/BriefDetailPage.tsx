import { FORMER_MEMBER } from '@/lib/people-names';
import { appPresignCache } from '@/lib/shared-presign';
import { useSearchJump } from '@/lib/search/jump';
import { Highlight, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Comments } from '@/components/comments/Comments';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { LoadError } from '@/components/ui/LoadError';
import { popoverClass } from '@/components/ui/popover-classes';
import { useOptionalToast } from '@/components/ui/toast';
import { IconBriefs, IconChevronLeft, IconCopy, IconMore } from '@/components/ui/icons';
import { PostGallery } from '@/components/pages/pcs/PostGallery';
import { usePostMembers } from '@/components/pages/pcs/use-post-members';
import { BRIEF_STATUS, isBriefClosed } from '@/components/pages/BriefCard';
import { EntityRefChip } from '@/components/refs/EntityRefChip';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { UnsafeLinkButton } from '@/components/ui/UnsafeLinkSheet';
import { checkLink } from '@/lib/links/safety';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import type { PresignDeps } from '@/lib/asset-presign';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { civilDate } from '@/lib/list-sort';
import { formatCivilDay, formatRaisedDay } from '@/lib/brief-groups';
import { copyText, COPY_FAILED } from '@/lib/clipboard';
import { plainError } from '@/lib/error-copy';
import { useEscapeLayer } from '@/lib/escape-stack';
import { hasPreviousEntry } from '@/lib/chat/use-history-step';
import { useSession } from '@/lib/session-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { cn } from '@/lib/cn';
import { toExternalLinks, type ExternalLink } from '@/lib/links';
import { getBrief, getBriefGallery } from '@srtdio/briefs';
import type { BriefGalleryItem, BriefWithLinkedCount } from '@srtdio/briefs';
import { briefClose } from '@srtdio/rpc';

// Status badge styling. Open reads as the active/good state, Closed as muted;
// both use theme tokens so light/dark parity is automatic. The status values
// themselves come from BRIEF_STATUS (pinned to the @srtdio/briefs type), never
// inline literals.
const STATUS_BADGE: Record<string, string> = {
  [BRIEF_STATUS.open]: 'border-good text-good',
  [BRIEF_STATUS.closed]: 'border-border text-fg-3',
};

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * briefs.target_date is a date-only column: "2026-10-08" reads "Oct 8, 2026" on
 * every machine, whatever the browser zone (never new Date(value)). Pure.
 */
export function briefDueDateLabel(targetDate: string | null): string {
  return targetDate !== null ? formatCivilDay(targetDate, true) : 'Not set';
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
 * The day this brief was raised, read in the WORKSPACE zone and carrying the
 * four-digit year: "Tuesday 22 Sep 2026". The day itself comes from the Briefs
 * list formatter, so the detail row and the list's day headings can never
 * disagree; the year is the same civil reading, sliced off the civil date. An
 * unparseable created_at is returned unchanged (never handed to Intl.format), and
 * an unknown zone degrades to UTC rather than throwing. Pure, so the label is
 * unit-tested without rendering the page.
 */
export function briefRaisedLabel(createdAt: string, timeZone: string): string {
  const instant = new Date(createdAt);
  if (Number.isNaN(instant.getTime())) return createdAt;
  let year: string;
  try {
    year = civilDate(instant, timeZone).slice(0, 4);
  } catch {
    year = civilDate(instant, 'UTC').slice(0, 4);
  }
  return `${formatRaisedDay(createdAt, timeZone)} ${year}`;
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

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wide text-fg-3';

/** A section label with a 44px copy button beside it. */
function CopyHeading({ label, onCopy }: { label: string; onCopy: () => void }): ReactElement {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <div className={SECTION_LABEL}>{label}</div>
      <IconButton label={`Copy ${label.toLowerCase()}`} className="-my-2 shrink-0" onClick={onCopy}>
        <IconCopy size={16} />
      </IconButton>
    </div>
  );
}

/** The header ⋯ menu: one action today, Close brief. Escape or a tap outside closes it. */
function BriefActionsMenu({ onCloseBrief }: { onCloseBrief: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  return (
    <div className="relative shrink-0">
      <IconButton
        label="Brief actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconMore size={18} />
      </IconButton>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className={cn('absolute right-0 top-full z-50 mt-1.5 w-52', popoverClass(true))}>
            <div role="menu" aria-label="Brief actions" className="flex flex-col">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onCloseBrief();
                }}
                className="flex min-h-[44px] w-full items-center rounded-md px-3 text-left text-sm text-fg-2 transition-colors duration-fast hover:bg-panel-2 hover:text-fg"
              >
                Close brief
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
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
  const { toasts, push, dismiss } = useToasts();
  const toast = useOptionalToast();
  const { run: runUndoable } = useUndoableAction();
  const { session } = useSession();
  const viewerId = session?.user.id ?? null;
  const canCloseAny = useWorkspaceCapability('brief.close');
  const canCloseOwn = useWorkspaceCapability('brief.close_own');
  // Approvers write briefs, so the "from the approvers" hint is for everyone else.
  const isApprover = useWorkspaceCapability('brief.create') === true;

  // The active workspace's zone, derived exactly as the Pipeline surface derives
  // it, so the Raised row reads on the workspace calendar rather than whatever
  // zone the reviewer's laptop happens to be in.
  const timeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? 'UTC';

  // Resolve created_by to a current member's display name, never a raw uuid.
  // Reuses the post detail page's member hook unchanged; the map is the resolver
  // behind briefAuthorLabel below.
  const {
    options: memberOptions,
    loading: membersLoading,
    error: membersError,
  } = usePostMembers(workspaceId);
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

  const [detail, setDetail] = useState<BriefWithLinkedCount | null>(null);
  const [gallery, setGallery] = useState<BriefGalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [confirmingClose, setConfirmingClose] = useState(false);

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

  // Close behind a 7s Undo: the badge flips to Closed at once, Undo puts it
  // back, and brief_close runs only once the window passes. A failed close
  // restores Open and says so in plain words.
  function closeWithUndo(): void {
    if (briefId === undefined || detail === null) return;
    setConfirmingClose(false);
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
          toast?.show({ title: plainError(result.error) });
          return;
        }
        await load(true);
      },
    });
  }

  async function copy(text: string): Promise<void> {
    push((await copyText(text)) ? 'Copied' : COPY_FAILED);
  }

  function goBack(): void {
    const target = briefBackTarget(window.history.state);
    if (target === 'pop') navigate(-1);
    else navigate(target);
  }

  // The same chevron as Post detail.
  const backButton = (
    <IconButton label="Back" className="shrink-0" onClick={goBack}>
      <IconChevronLeft size={20} />
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
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading brief</div>
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
          icon={<IconBriefs size={22} />}
          title="Brief not found"
          description="This brief may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/briefs')}>
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
  const showClose = !closed && canCloseBrief(canCloseAny, canCloseOwn, brief.created_by, viewerId);
  const hasBrand = brief.brand_requirements !== null && brief.brand_requirements.trim() !== '';
  const hasFormat = brief.format_requested !== null && brief.format_requested.trim() !== '';
  const authorLabel = briefAuthorLabel(
    brief.created_by,
    brief.legacy_author_name,
    (id) => memberById.get(id) ?? null,
    membersLoaded,
  );
  const statusBadge = (
    <span
      className={`shrink-0 inline-flex items-center rounded-full border px-3 h-7 text-xs font-medium ${
        STATUS_BADGE[brief.status] ?? 'border-border text-fg-3'
      }`}
    >
      {statusLabel(brief.status)}
    </span>
  );

  return (
    <SearchWordsContext.Provider value={searchJump.words}>
      <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
        {backButton}
        {/* Phone: the title gets its own line below; the bar keeps the chevron. */}
        <h1 className="hidden md:block min-w-0 flex-1 text-[15px] font-semibold truncate">
          <Highlight text={brief.title} />
        </h1>
        <div className="flex-1 md:hidden" />
        {workspaceKey !== null ? (
          <EntityRefChip
            kind="brief"
            entityKey={workspaceKey}
            number={brief.number}
            onCopied={() => push('Link copied')}
          />
        ) : null}
        <span className="hidden md:inline-flex">{statusBadge}</span>
        {showClose ? <BriefActionsMenu onCloseBrief={() => setConfirmingClose(true)} /> : null}
      </div>

      <div className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 flex flex-col gap-6">
          {/* Phone order: title, Details, Objective, Brand requirements,
              Attachments, Comments. md:order-none hands desktop back its DOM
              order (gallery first), unchanged. */}
          <h2 className="md:hidden text-[22px] font-semibold leading-tight tracking-tight text-fg">
            <Highlight text={brief.title} />
          </h2>

          <section className="order-1 md:hidden">
            <div className={`${SECTION_LABEL} mb-2`}>Details</div>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-fg-3">Due date</dt>
                <dd className="tabular-nums">{briefDueDateLabel(brief.target_date)}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-fg-3">Format</dt>
                <dd className="truncate">{hasFormat ? brief.format_requested : 'Any'}</dd>
              </div>
              <div className="flex min-w-0 flex-col items-start gap-1">
                <dt className="text-fg-3">Status</dt>
                <dd>{statusBadge}</dd>
              </div>
            </dl>
          </section>

          {mediaItems.length > 0 ? (
            <section className="order-4 md:order-none">
              {!isApprover ? (
                <p className="mb-3 text-sm text-fg-3">
                  Reference images from the approvers. Tap for full screen or download. Briefs are
                  read-only after creation.
                </p>
              ) : null}
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

          <section className="order-2 md:order-none">
            <CopyHeading label="Objective" onCopy={() => void copy(brief.objective)} />
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
              <Highlight text={brief.objective} />
            </p>
          </section>

          {hasBrand ? (
            <section className="order-3 md:order-none">
              <CopyHeading
                label="Brand requirements"
                onCopy={() => void copy(brief.brand_requirements ?? '')}
              />
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
                {brief.brand_requirements}
              </p>
            </section>
          ) : null}

          {links.length > 0 ? (
            <section className="order-4 md:order-none">
              <div className={`${SECTION_LABEL} mb-2`}>Reference links</div>
              <ul className="flex flex-col gap-2">
                {links.map((link, index) => (
                  <li key={link.href}>
                    {/* The first link gets the preview card; the rest stay buttons. */}
                    {index === 0 ? (
                      <LinkPreviewCard url={link.href} className="w-full max-w-[420px]" />
                    ) : checkLink(link.href).verdict === 'unsafe' ? (
                      <UnsafeLinkButton
                        url={link.href}
                        reasons={checkLink(link.href).reasons}
                        domain={link.domain}
                        className="w-full"
                      />
                    ) : (
                      <LinkButton url={link.href} className="w-full" />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="order-5 md:order-none">
            <div className={`${SECTION_LABEL} mb-2`}>Comments</div>
            {workspaceId !== null && briefId !== undefined ? (
              <Comments
                workspaceId={workspaceId}
                entityType="brief"
                entityId={briefId}
                focusCommentId={focusCommentId}
              />
            ) : (
              <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
                Select a workspace to view comments.
              </div>
            )}
          </section>
        </div>

        <aside className="hidden md:flex flex-col gap-6">
          <section>
            <div className={`${SECTION_LABEL} mb-2`}>Details</div>
            <dl className="flex flex-col gap-3 text-sm">
              {hasFormat ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-fg-3">Format requested</dt>
                  <dd className="text-fg">{brief.format_requested}</dd>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Raised</dt>
                <dd className="tabular-nums">{briefRaisedLabel(brief.created_at, timeZone)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Target date</dt>
                <dd className="tabular-nums">{briefDueDateLabel(brief.target_date)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Linked posts</dt>
                <dd className="tabular-nums">{detail.linked_posts_count}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Created by</dt>
                <dd className="break-all">
                  {authorLabel === '' && membersLoading ? (
                    <span
                      data-testid="created-by-skeleton"
                      aria-label="Loading"
                      className="block h-4 w-28 rounded bg-panel-3"
                    />
                  ) : (
                    authorLabel
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      {confirmingClose ? (
        <ConfirmDialog
          title="Close this brief?"
          message="It leaves Open but stays readable and commentable."
          confirmLabel="Close brief"
          onConfirm={closeWithUndo}
          onCancel={() => setConfirmingClose(false)}
        />
      ) : null}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </SearchWordsContext.Provider>
  );
}
