// The status ticker's drop-down drawer: the sections behind each bar item in
// the bar's fixed order (only the non-zero ones), each listing its first five
// rows then "See all N". Plans: every current shared plan of the workspace
// (shared in this chat or not), ending soonest first, with its segmented bar,
// progress line and first items (tap opens the Plan screen, at the item for
// an item row). Posts in review open the same
// PostSheet a PostCard tap opens. Briefs navigate to the brief. Marks jump to
// the message and keep their stamp (Delivered / Closed / Completed) with the
// existing inline confirm. The panel only moves on the Y axis; colours are
// design tokens only, so light and dark match.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { Button } from '@/components/ui/Button';
import { Backdrop } from '@/components/ui/Backdrop';
import { PressableRow } from '@/components/ui/PressableRow';
import {
  ICON_SIZE,
  IconBriefs,
  IconCheck,
  IconChevronRight,
  IconEye,
  IconFile,
  IconHourglass,
  IconPlan,
  IconSignpost,
  IconTarget,
} from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import {
  confirmMarkTransition,
  messageTime,
  openPostLines,
  useCardTitles,
} from '@/components/chat/MarksSheet';
import {
  PRESIGN_ENABLED,
  sharedCardPresignCache,
  approverRolesOf,
  type ThreadCardCache,
} from '@/components/chat/PostCard';
import { PostSheet } from '@/components/chat/PostSheet';
import { indexPostsById, sharedPostViews } from '@/components/chat/post-card';
import {
  DRAFT_LABEL,
  clientApproved,
  clientChanges,
  draftLocked,
  isDraftPost,
  itemDateLabel,
  planProgress,
  planRangeLabel,
  progressLabel,
  reviewStatus,
} from '@/components/chat/plan-card';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { formatLabel } from '@/lib/post-detail-presentation';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import {
  STAMP_WORD,
  markConfirmAction,
  markConfirmCopy,
  markRowText,
  priorityLabel,
  type ChatMark,
} from '@/lib/chat/marks';
import {
  readPlanThumbs,
  type ConceptThumb,
  type PlanBundle,
  type PlanItemRow,
} from '@/lib/chat/plans';
import { POST_COVER_BOX, PostCover } from '@/components/chat/PostCover';
import { usePostCovers, type CoverLookup } from '@/lib/chat/post-covers';
import type { WriteResult } from '@/lib/chat/record';
import {
  SECTION_MARK_TYPE,
  SEGMENT_PILL,
  drawerDay,
  openMarksOfType,
  planSectionCount,
  planSegment,
  sectionLabel,
  sectionRows,
  type PlanSegment,
  type StatusKey,
} from '@/lib/chat/status-bar';
import { formatChatTime } from '@/lib/time';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { OpenPostRow } from '@/lib/chat/use-open-posts';
import type { OpenBriefRow } from '@/lib/chat/use-status-counts';
import type { ViewerSide } from '@/lib/chat/viewer-role';

/** Each section's icon, shared with the bar. */
export const STATUS_ICON: Record<
  StatusKey,
  (props: { size?: number; className?: string }) => ReactElement
> = {
  plan: IconPlan,
  posts: IconEye,
  briefs: IconBriefs,
  commitments: IconTarget,
  decisions: IconSignpost,
  pending: IconHourglass,
};

/** No iOS text selection or callout on the bar and drawer. */
export const NO_CALLOUT = 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]';

/** Everything the drawer lists. */
export interface StatusDrawerData {
  /** The sections to show, in the bar's order (its non-zero items). */
  keys: readonly StatusKey[];
  side: ViewerSide;
  /** For tests: the zone moments render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** The workspace zone the posts' target (due) dates render on. Absent: the device zone. */
  workspaceZone?: string | null | undefined;
  /** The workspace's current shared plans, ending soonest first (the bar's set). */
  plans: readonly PlanBundle[];
  posts: { heading: string; rows: readonly OpenPostRow[]; count: number };
  briefs: { rows: readonly OpenBriefRow[]; count: number };
  marks: Map<string, ChatMark>;
  messageFor: (messageId: string) => ThreadMessage | undefined;
  profiles: Map<string, ChatProfile>;
  /** Mark stamps; absent leaves the rows without a stamp. */
  onResolveMark?: ((messageId: string) => Promise<WriteResult>) | undefined;
  onReopenMark?: ((messageId: string) => Promise<WriteResult>) | undefined;
}

/** Where each drawer tap goes. */
export interface StatusDrawerActions {
  onOpenPlan: (planId: string) => void;
  onOpenPlanItem: (planId: string, itemId: string) => void;
  onOpenPost: (postId: string) => void;
  onOpenBrief: (briefId: string) => void;
  onSeeAllBriefs: () => void;
  onJumpMark: (messageId: string) => void;
  onSeeAllMarks: () => void;
}

// Layout and colour only: PressableRow provides width, 44px height, radius,
// left alignment, hover and the focus ring.
const ROW = 'flex items-center gap-3 py-1 transition-colors active:bg-panel-2';
const DATE_COL = 'w-12 shrink-0 font-mono text-sm leading-4 tabular-nums text-fg-3';
const ROW_TITLE = 'line-clamp-2 [overflow-wrap:anywhere] text-base leading-5 text-fg';
const ROW_SUB = 'block truncate text-sm leading-4 text-fg-3';
const PILL = 'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold leading-4';

const SEGMENT_CLASS: Record<PlanSegment, string> = {
  client: 'bg-accent',
  team: 'bg-accent-soft ring-1 ring-inset ring-accent-line',
  changes: 'bg-warn',
  waiting: 'bg-panel-2',
};

const PILL_CLASS: Record<PlanSegment, string> = {
  client: 'bg-good-soft text-good',
  team: 'bg-accent-soft text-accent',
  changes: 'bg-warn-soft text-warn',
  waiting: 'bg-panel-2 text-fg-2',
};

function Chevron(): ReactElement {
  return <IconChevronRight size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />;
}

function SeeAllRow(props: { total: number; onClick: () => void; attr: string }): ReactElement {
  return (
    <PressableRow
      type="button"
      data-see-all={props.attr}
      onClick={props.onClick}
      className={cn(ROW, 'text-base font-medium text-accent')}
    >
      <span className="min-w-0 flex-1">{`See all ${props.total}`}</span>
      <Chevron />
    </PressableRow>
  );
}

function SectionHeader(props: {
  sectionKey: StatusKey;
  label: string;
  count: string;
}): ReactElement {
  const Icon = STATUS_ICON[props.sectionKey];
  return (
    <div className="mb-2 flex h-5 items-center gap-2 text-fg-2">
      <Icon size={ICON_SIZE.inline} className="shrink-0" />
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-[0.06em]">
        {props.label}
      </h3>
      <span className="font-mono text-sm font-medium tabular-nums">{props.count}</span>
    </div>
  );
}

function itemSegment(bundle: PlanBundle, item: PlanItemRow, side: ViewerSide): PlanSegment {
  return planSegment(
    {
      client: clientApproved(bundle, item),
      changes: clientChanges(bundle, item),
      team: reviewStatus(bundle, item.id, 'team') === 'approved',
    },
    side,
  );
}

function itemTitle(bundle: PlanBundle, item: PlanItemRow): string {
  if (item.kind === 'post') {
    const title =
      item.draft_row === true
        ? (item.title ?? undefined)
        : item.post_id !== null
          ? bundle.postInfo[item.post_id]?.title
          : undefined;
    return title !== undefined && title !== '' ? title : 'Post';
  }
  return item.title !== null && item.title.trim() !== '' ? item.title : 'Concept';
}

/**
 * A plan row's 48px picture: a post's cover (first photo or video), and a
 * concept's first image file, a file tile when it holds only documents, or the
 * dashed outline when it has no files (the Plan screen's tile language).
 */
function PlanItemTile(props: {
  item: PlanItemRow;
  cover: CoverLookup | undefined;
  concepts: Record<string, ConceptThumb> | null;
}): ReactElement {
  const { item } = props;
  if (item.kind !== 'concept') {
    const cover =
      item.post_id === null || props.cover === undefined ? null : props.cover(item.post_id);
    return <PostCover cover={cover} />;
  }
  if (props.concepts === null) {
    return <span aria-hidden="true" data-plan-tile="pending" className={POST_COVER_BOX} />;
  }
  const concept = props.concepts[item.id] ?? null;
  if (concept?.kind === 'image') {
    return (
      <PostCover
        cover={{ assetVersionId: concept.versionId, kind: 'image', width: null, height: null }}
      />
    );
  }
  if (concept?.kind === 'file') {
    return (
      <span aria-hidden="true" data-plan-tile="file" className={POST_COVER_BOX}>
        <IconFile size={ICON_SIZE.nav} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-plan-tile="concept"
      className="h-12 w-12 shrink-0 rounded-lg border-[1.5px] border-dashed border-border-strong"
    />
  );
}

/**
 * The concept tiles for a plan's shown rows: one readPlanThumbs call per set of
 * concept ids (never one per row); null until it lands, and a failed read
 * leaves every concept on the dashed outline.
 */
function useConceptTiles(rows: readonly PlanItemRow[]): Record<string, ConceptThumb> | null {
  const key = rows
    .filter((item) => item.kind === 'concept')
    .map((item) => item.id)
    .join(',');
  const [tiles, setTiles] = useState<{ key: string; data: Record<string, ConceptThumb> } | null>(
    null,
  );
  useEffect(() => {
    if (key === '') return;
    let live = true;
    void readPlanThumbs(supabase, [], key.split(',')).then((result) => {
      if (live) setTiles({ key, data: result.ok ? result.data.concepts : {} });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (key === '') return {};
  return tiles !== null && tiles.key === key ? tiles.data : null;
}

/** One current shared plan: its title row, segmented bar, progress line and first items. */
export function PlanBlock(props: {
  bundle: PlanBundle;
  side: ViewerSide;
  first: boolean;
  onOpen: () => void;
  onOpenItem: (itemId: string) => void;
  /** Each post row's post with its cover; absent, post rows show the glyph. */
  cover?: CoverLookup | undefined;
}): ReactElement {
  const { bundle, side } = props;
  const progress = planProgress(bundle);
  const { rows, seeAll } = sectionRows(bundle.items);
  const concepts = useConceptTiles(rows);
  return (
    <div
      data-plan-block={bundle.plan.id}
      className={cn(!props.first && 'mt-3 border-t border-dashed border-border pt-3')}
    >
      <PressableRow type="button" data-plan-open="" onClick={props.onOpen} className={ROW}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg font-semibold leading-5 text-fg">
            {bundle.plan.title}
          </span>
          <span className={ROW_SUB}>
            {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
          </span>
        </span>
        <Chevron />
      </PressableRow>
      <div aria-hidden="true" data-plan-bar="" className="mt-1 flex h-1.5 gap-0.5">
        {bundle.items.map((item) => {
          const seg = itemSegment(bundle, item, side);
          return (
            <i
              key={item.id}
              data-segment={seg}
              className={cn('min-w-0 flex-1 rounded-full', SEGMENT_CLASS[seg])}
            />
          );
        })}
      </div>
      <p className="mb-1 mt-2 text-sm leading-4 text-fg-2">{progressLabel(progress, side)}</p>
      {rows.map((item) => {
        const seg = itemSegment(bundle, item, side);
        const date = itemDateLabel(bundle, item);
        return (
          <PressableRow
            key={item.id}
            type="button"
            data-plan-item={item.id}
            onClick={() => props.onOpenItem(item.id)}
            className={ROW}
          >
            <span className={cn(DATE_COL, !date.dated && 'italic')}>{date.label}</span>
            <PlanItemTile item={item} cover={props.cover} concepts={concepts} />
            <span className="min-w-0 flex-1">
              <span className={ROW_TITLE}>{itemTitle(bundle, item)}</span>
              <span className={ROW_SUB}>{item.kind === 'post' ? 'Post' : 'Concept'}</span>
            </span>
            {isDraftPost(bundle, item) ? (
              <span
                data-pill="draft"
                className={cn(
                  PILL,
                  draftLocked(bundle, item, side)
                    ? 'text-fg-3 ring-1 ring-inset ring-border'
                    : 'bg-panel-2 text-fg-2',
                )}
              >
                {DRAFT_LABEL}
              </span>
            ) : (
              <span data-pill={seg} className={cn(PILL, PILL_CLASS[seg])}>
                {SEGMENT_PILL[seg]}
              </span>
            )}
            <Chevron />
          </PressableRow>
        );
      })}
      {seeAll !== null ? (
        <SeeAllRow total={seeAll} onClick={props.onOpen} attr="plan-items" />
      ) : null}
    </div>
  );
}

function senderOf(message: ThreadMessage | undefined, profiles: Map<string, ChatProfile>): string {
  if (message === undefined) return 'Member';
  if (message.mine) return 'You';
  const name =
    message.senderUserId !== null ? profiles.get(message.senderUserId)?.displayName : undefined;
  return name ?? 'Member';
}

/** One open mark row: the message text, who and when, the P1/P2 pill and the stamp. */
export function StatusMarkRow(props: {
  mark: ChatMark;
  text: string;
  meta: string;
  confirming: boolean;
  busy: boolean;
  canStamp: boolean;
  onJump: () => void;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { mark } = props;
  const priority = mark.type === 'pending' ? priorityLabel(mark.priority) : '';
  return (
    <div data-status-mark={mark.messageId} className="flex flex-col">
      <div className="flex items-center gap-3">
        <PressableRow
          type="button"
          data-mark-jump=""
          onClick={props.onJump}
          className={cn(ROW, 'flex-1')}
        >
          <span className="min-w-0 flex-1">
            <span className={ROW_TITLE}>{props.text}</span>
            <span className={ROW_SUB}>{props.meta}</span>
          </span>
          {priority !== '' ? (
            <span data-priority={priority} className={cn(PILL, 'bg-warn-soft text-warn')}>
              {priority}
            </span>
          ) : null}
          <Chevron />
        </PressableRow>
        {props.canStamp ? (
          <Button
            type="button"
            data-mark-action="resolve"
            aria-expanded={props.confirming}
            disabled={props.busy}
            onClick={props.onAsk}
            className="min-w-[44px] shrink-0"
          >
            <IconCheck size={ICON_SIZE.inline} />
            <span>{STAMP_WORD[mark.type]}</span>
          </Button>
        ) : null}
      </div>
      {props.confirming ? (
        <div
          role="group"
          aria-label={markConfirmCopy(mark.type, 'resolve')}
          data-mark-confirm="resolve"
          className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2"
        >
          <span className="min-w-0 flex-1 text-base text-fg">
            {markConfirmCopy(mark.type, 'resolve')}
          </span>
          <Button variant="ghost" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={props.busy} onClick={props.onConfirm}>
            {markConfirmAction(mark.type, 'resolve')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The drawer's sections. Holds the stamp confirm (one at a time) and the posts
 * section's in-place "See all" expansion; rows update in place on live data.
 */
export function StatusDrawerList(
  props: StatusDrawerData &
    StatusDrawerActions & {
      open: boolean;
      postsExpanded: boolean;
      /** The post row whose tap waits on its read (pressed, busy). */
      busyPostId?: string | null;
      onExpandPosts: () => void;
    },
): ReactElement {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { messageFor, profiles } = props;

  // A closed drawer drops any half-asked confirm.
  useEffect(() => {
    if (!props.open) setConfirming(null);
  }, [props.open]);

  const markedMessages = useMemo(() => {
    const list: ThreadMessage[] = [];
    for (const mark of props.marks.values()) {
      if (mark.resolved) continue;
      const message = messageFor(mark.messageId);
      if (message !== undefined) list.push(message);
    }
    return list;
  }, [props.marks, messageFor]);
  const titles = useCardTitles(props.open, markedMessages);
  const timeOf = (mark: ChatMark): number => messageTime(mark, messageFor(mark.messageId));
  const onResolve = props.onResolveMark;
  const onReopen = props.onReopenMark;

  async function confirm(mark: ChatMark): Promise<void> {
    if (busy || onResolve === undefined || onReopen === undefined) return;
    setBusy(true);
    setConfirming(null);
    await confirmMarkTransition({
      action: 'resolve',
      messageId: mark.messageId,
      onResolve,
      onReopen,
      toast,
    });
    setBusy(false);
  }

  const firstPlan = props.plans[0];
  const firstProgress = firstPlan !== undefined ? planProgress(firstPlan) : null;

  // Covers for every post row the drawer shows (plan rows and posts in review)
  // in one batched read per new set of ids, never one per row.
  const shownPosts = props.postsExpanded ? props.posts.rows : props.posts.rows.slice(0, 5);
  const coverIds = useMemo(
    () => [
      ...props.plans.flatMap((bundle) =>
        sectionRows(bundle.items).rows.flatMap((item) =>
          item.post_id !== null ? [item.post_id] : [],
        ),
      ),
      ...shownPosts.map((post) => post.id),
    ],
    [props.plans, shownPosts],
  );
  const covers = usePostCovers(coverIds);

  const section = (key: StatusKey, count: string, body: ReactNode): ReactElement => (
    <section
      key={key}
      data-status-section={key}
      className="border-b border-border pb-2 pt-4 last:border-b-0"
    >
      <SectionHeader
        sectionKey={key}
        label={sectionLabel(key, { postsHeading: props.posts.heading, plans: props.plans.length })}
        count={count}
      />
      {body}
    </section>
  );

  return (
    <>
      {props.keys.map((key) => {
        if (key === 'plan') {
          return section(
            key,
            planSectionCount(props.plans.length, firstProgress),
            props.plans.map((bundle, i) => (
              <PlanBlock
                key={bundle.plan.id}
                bundle={bundle}
                side={props.side}
                first={i === 0}
                onOpen={() => props.onOpenPlan(bundle.plan.id)}
                onOpenItem={(itemId) => props.onOpenPlanItem(bundle.plan.id, itemId)}
                cover={covers}
              />
            )),
          );
        }
        if (key === 'posts') {
          const shown = shownPosts;
          const seeAll = !props.postsExpanded && props.posts.count > 5 ? props.posts.count : null;
          return section(
            key,
            String(props.posts.count),
            <>
              {shown.map((post) => {
                const lines = openPostLines(post, false, props.workspaceZone);
                const busy = props.busyPostId === post.id;
                return (
                  <PressableRow
                    key={post.id}
                    type="button"
                    data-status-post={post.id}
                    aria-busy={busy}
                    onClick={() => props.onOpenPost(post.id)}
                    // Waiting on its read: pressed tint and a pulsing chevron, same box.
                    className={cn(ROW, busy && 'bg-panel-2')}
                  >
                    <span className={DATE_COL}>
                      {drawerDay(post.target_date, props.workspaceZone)}
                    </span>
                    <PostCover cover={covers(post.id)} />
                    <span className="min-w-0 flex-1">
                      <span className={ROW_TITLE}>{lines.title}</span>
                      <span className={ROW_SUB}>{formatLabel(post.format)}</span>
                    </span>
                    <span className={cn('flex shrink-0', busy && 'animate-pulse')}>
                      <Chevron />
                    </span>
                  </PressableRow>
                );
              })}
              {seeAll !== null ? (
                <SeeAllRow total={seeAll} onClick={props.onExpandPosts} attr="posts" />
              ) : null}
            </>,
          );
        }
        if (key === 'briefs') {
          const { rows, seeAll } = sectionRows(props.briefs.rows, props.briefs.count);
          return section(
            key,
            String(props.briefs.count),
            <>
              {rows.map((brief) => (
                <PressableRow
                  key={brief.id}
                  type="button"
                  data-status-brief={brief.id}
                  onClick={() => props.onOpenBrief(brief.id)}
                  className={ROW}
                >
                  <span className={DATE_COL}>{drawerDay(brief.created_at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className={ROW_TITLE}>{brief.title}</span>
                  </span>
                  <Chevron />
                </PressableRow>
              ))}
              {seeAll !== null ? (
                <SeeAllRow total={seeAll} onClick={props.onSeeAllBriefs} attr="briefs" />
              ) : null}
            </>,
          );
        }
        const type = SECTION_MARK_TYPE[key];
        const open = openMarksOfType(props.marks.values(), type, timeOf);
        const { rows, seeAll } = sectionRows(open);
        return section(
          key,
          String(open.length),
          <>
            {rows.map((mark) => {
              const message = messageFor(mark.messageId);
              const when =
                message !== undefined && message.createdAt !== ''
                  ? formatChatTime(message.createdAt)
                  : formatChatTime(mark.markedAt);
              return (
                <StatusMarkRow
                  key={mark.messageId}
                  mark={mark}
                  text={markRowText(message, titles.get(mark.messageId))}
                  meta={`${senderOf(message, profiles)} · ${when}`}
                  confirming={confirming === mark.messageId}
                  busy={busy}
                  canStamp={onResolve !== undefined && onReopen !== undefined}
                  onJump={() => props.onJumpMark(mark.messageId)}
                  onAsk={() => setConfirming(mark.messageId)}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => void confirm(mark)}
                />
              );
            })}
            {seeAll !== null ? (
              <SeeAllRow total={seeAll} onClick={props.onSeeAllMarks} attr="marks" />
            ) : null}
          </>,
        );
      })}
    </>
  );
}

/** The panel's chrome: scrim, the panel (own scroll), and the bottom handle. */
export function StatusDrawerPanel(props: {
  top: number;
  /** The panel's transform (translateY only). */
  transform: string;
  scrim: number;
  animate: boolean;
  /** Open or opening (taking taps); false while it closes. */
  open: boolean;
  panelRef: Ref<HTMLDivElement>;
  listRef: Ref<HTMLDivElement>;
  onScrim: () => void;
  handle: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
  children: ReactNode;
}): ReactElement {
  const transition = props.animate
    ? 'duration-[220ms] ease-out motion-reduce:transition-none'
    : 'transition-none';
  return (
    <div
      data-status-drawer={props.open ? 'open' : 'moving'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 overflow-hidden',
        !props.open && 'pointer-events-none',
        NO_CALLOUT,
      )}
      style={{ top: props.top }}
    >
      {/* The one scrim (Backdrop); this wrapper carries the drag-linked opacity. */}
      <div
        data-status-scrim=""
        className={cn('absolute inset-0 transition-opacity', transition)}
        style={{ opacity: props.scrim }}
      >
        <Backdrop aria-label="Close open items" position="absolute" onClick={props.onScrim} />
      </div>
      <div
        ref={props.panelRef}
        data-motion-axis="y"
        data-status-panel=""
        role="dialog"
        aria-label="Open in this chat"
        className={cn(
          'absolute inset-x-0 top-0 flex max-h-[calc(100%-48px)] flex-col rounded-b-2xl border-b border-border bg-panel transition-transform',
          transition,
        )}
        style={{ transform: props.transform }}
      >
        <div
          ref={props.listRef}
          data-status-list=""
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
        >
          {props.children}
        </div>
        <div
          data-status-handle=""
          aria-hidden="true"
          {...props.handle}
          className="flex h-6 shrink-0 cursor-grab items-center justify-center [touch-action:none]"
        >
          <span className="h-1 w-8 rounded-full bg-border" />
        </div>
      </div>
    </div>
  );
}

// The post sheet's presign deps: the same mint path a PostCard's sheet uses.
const sheetPresignDeps = {
  endpoint: env.VITE_ASSET_READ_URL ?? null,
  getAccessToken: async (): Promise<string | null> =>
    (await supabase.auth.getSession()).data.session?.access_token ?? null,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => fetchWithTrace(input, init),
};

/**
 * The PostSheet for one post in review, from the thread's card cache (the
 * same sheet a PostCard tap opens). The ticker opens it only once the post
 * is in the cache. Mounts on first open and stays so its exit animates.
 */
export function DrawerPostSheet(props: {
  cache: ThreadCardCache | null;
  postId: string | null;
  open: boolean;
  side: ViewerSide;
  /** For tests: the zone dates render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  onClose: () => void;
}): ReactElement | null {
  const { cache, postId } = props;
  if (postId === null || cache === null) return null;
  const snap = cache.posts([postId]);
  const [view] = sharedPostViews(
    [postId],
    indexPostsById(snap.posts),
    snap.names,
    approverRolesOf(cache),
  );
  if (view === undefined || view.kind !== 'post') return null;
  return (
    <PostSheet
      open={props.open}
      onClose={props.onClose}
      view={view}
      side={props.side}
      timeZone={props.timeZone}
      cache={sharedCardPresignCache()}
      deps={sheetPresignDeps}
      presignEnabled={PRESIGN_ENABLED}
    />
  );
}
