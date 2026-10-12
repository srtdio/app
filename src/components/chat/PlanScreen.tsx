// The Plan screen (full page over the chat, one history step): the plan's
// title, "{range} · Draft" or "{range} · Shared with client", progress, and
// one list grouped by each item's plan day (a post slot's day is its post's
// posts.target_date in the workspace zone, a concept's plan_items.target_date)
// for every day of the range ("Nothing planned" on an empty day, "No date"
// last; a plan longer than a week adds a sticky "Week of" header per week).
// Each row: day column, thumbnail, title, type line, the agency's client
// status line, "Also in" when the post sits in another plan, "Approved by"
// on an Open plan's client-approved row, then the slot tick. One view of
// ticks: a Draft plan shows the team side (agency only), an Open plan the
// client side for everyone (a client ticks, the agency sees them read-only).
// Tapping a row opens the Item screen. A tick is optimistic, with Undo on its
// toast; a failure reverts. The agency side also gets: the title menu (Rename
// inline, Delete plan for its creator or an owner/admin), Add under each day
// and "+" in the header, long-press drag to reorder or move between days (one
// 5-arg plan_item_move, optimistic, reverted on failure; an Open plan's
// client-approved slot asks "Keep the approval?" first), and the footer: "Open
// for client" on a Draft plan, and from a chat "Send in {chat}" or "Go to
// card". One read per table per open (plans.ts), bounded at 5s; nothing paints
// until that read settles. This file also holds the page frame, the bounded
// read hook and the confirm sheet the other plan screens share.
// Motion: drag on translateY and scale only; the page, menu and sheets on
// translateY. Tokens only.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Result } from '@srtdio/rpc';
import {
  chatPlanShare,
  planConceptAdd,
  planDelete,
  planItemMove,
  planItemReview,
  planPostsAdd,
  planShareWithClient,
  planUpdate,
} from '@srtdio/rpc';
import type { PostCardFields } from '@srtdio/posts';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { useLongPress } from '@/components/ui';
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconEdit,
  IconPlan,
  IconPlus,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { Thumbnail } from '@/components/media/Thumbnail';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import {
  ADD_FAILED,
  commentsLabel,
  DELETE_PLAN_LABEL,
  DELETE_PLAN_TITLE,
  DRAFT_NOT_READY,
  GO_TO_CARD_LABEL,
  MOVE_FAILED,
  NO_DATE_LABEL,
  OPEN_FOR_CLIENT_BODY,
  OPEN_FOR_CLIENT_FAILED,
  OPEN_FOR_CLIENT_LABEL,
  OPEN_FOR_CLIENT_TITLE,
  OPEN_FOR_CLIENT_TOAST,
  PLAN_DELETED_TOAST,
  PLAN_NOT_AVAILABLE,
  PLAN_TITLE_MAX,
  RENAMED_TOAST,
  RENAME_FAILED,
  RENAME_LABEL,
  SEND_FAILED,
  SEND_NEEDS_OPEN,
  SLOT_UNDO,
  SLOT_UNDO_MS,
  addedToast,
  alsoInLabel,
  approvedBy,
  approvedByLine,
  approvedWhen,
  approverIds,
  canDeletePlan,
  dayHeaderOf,
  deletePlanBody,
  deletePlanErrorCopy,
  draftLocked,
  itemDateLabel,
  itemKindLabel,
  itemStatusLine,
  keepApprovalBody,
  keepApprovalTitle,
  moveAsksKeep,
  movedKeptToast,
  movedToast,
  planHeaderSubtitle,
  planProgressView,
  planSendAction,
  planWriteErrorCopy,
  renameTitle,
  reviewStatus,
  slotCheckboxShown,
  slotSide,
  slotTicked,
  slotToastSpec,
  slotUndoStatus,
  stageLabel,
  withReviewOverrides,
  type PillTone,
  type SendAction,
  type StatusPill,
} from '@/components/chat/plan-card';
import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { PlanAddSheet } from '@/components/chat/PlanAddSheet';
import { PlanKeepApprovalSheet, type MoveDay } from '@/components/chat/PlanMoveSheet';
import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import {
  applyMove,
  dropIndex,
  findItem,
  flattenOrder,
  hasTicks,
  isNoop,
  moveItem,
  type DayIds,
} from '@/lib/chat/plan-drag';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS, readProfiles, withLateRead } from '@/lib/chat-reads';
import { newMessageId } from '@/lib/chat/message-id';
import { sharePlanToChannel } from '@/lib/chat/share-plan';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { fetchMemberRole } from '@/lib/assets';
import { useSession } from '@/lib/session-context';
import {
  PLAN_CHANGED_EVENT,
  dispatchPlanChanged,
  planChangedId,
  conceptAddArgs,
  planItemDayInZone,
  readPlanScreen,
  refusedForClient,
  runSlotWrite,
  type PlanBundle,
  type PlanItemRow,
  type PlanScreenData,
  type ReviewSide,
  type ReviewStatus,
} from '@/lib/chat/plans';
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { HISTORY_STEP_KEYS, useHistoryStep } from '@/lib/chat/use-history-step';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { formatLabel } from '@/lib/post-detail-presentation';
import { logger } from '@/lib/logger';
import { DUR_SLOW_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import {
  civilDaysBetween,
  civilToday,
  civilWeekdayShort,
  dayOfMonth,
  formatCivilDayHeader,
  planShowsWeeks,
  planWeekGroups,
  type PlanWeekGroup,
} from '@/lib/plan-week';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * A full page over the chat: slides up on translateY, header with a 44px back
 * (or close) button, a scrolling body and an optional footer. Rendered into the
 * body so no ancestor clips it; sheets (z-50) stack above it.
 */
export function PlanPage(props: {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  backLabel: string;
  backIcon?: ReactNode;
  onBack: () => void;
  /** The slide in has ended (at once when there is no slide, as under reduced motion). */
  onEntered?: () => void;
  footer?: ReactNode;
  /** A header action (44px) after the title column, e.g. an overflow button. */
  action?: ReactNode;
  /** Replaces the title line (the agency's menu button, the inline rename). */
  titleSlot?: ReactNode;
  /** Drawn under the header, anchored to it (the header menu). */
  overlay?: ReactNode;
  /** The scrolling body (a drag auto-scrolls it). */
  bodyRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
  testId: string;
}): ReactElement | null {
  const [rendered, setRendered] = useState(props.open);
  const [entered, setEntered] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const onEnteredRef = useRef(props.onEntered);
  onEnteredRef.current = props.onEntered;
  useEffect(() => {
    const el = pageRef.current;
    if (!entered || el === null) return;
    if (parseFloat(getComputedStyle(el).transitionDuration) === 0) {
      onEnteredRef.current?.();
      return;
    }
    const done = (event: TransitionEvent): void => {
      if (event.target === el && event.propertyName === 'transform') onEnteredRef.current?.();
    };
    el.addEventListener('transitionend', done);
    el.addEventListener('transitioncancel', done);
    return () => {
      el.removeEventListener('transitionend', done);
      el.removeEventListener('transitioncancel', done);
    };
  }, [entered]);
  useEffect(() => {
    if (props.open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), DUR_SLOW_MS);
    return () => clearTimeout(timer);
  }, [props.open]);
  if (!rendered) return null;
  return createPortal(
    <div
      ref={pageRef}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      data-plan-page={props.testId}
      className={cn(
        'fixed inset-0 z-40 flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] transition-transform duration-slow ease-enter motion-reduce:transition-none',
        entered ? 'translate-y-0' : 'translate-y-full',
      )}
    >
      <header className="relative z-20 flex min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-panel pl-1 pr-3">
        <button
          type="button"
          aria-label={props.backLabel}
          onClick={props.onBack}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {props.backIcon ?? <IconChevronLeft size={22} />}
        </button>
        <div data-plan-page-titles="" className="flex min-w-0 flex-1 flex-col">
          {props.titleSlot ?? (
            <h2 className="truncate text-[17px] font-[650] leading-[22px] text-fg">
              {props.title}
            </h2>
          )}
          {props.subtitle !== undefined ? (
            <span
              data-plan-page-subtitle=""
              className="truncate text-[13px] leading-[18px] text-fg-3"
            >
              {props.subtitle}
            </span>
          ) : null}
        </div>
        {props.action}
        {props.overlay}
      </header>
      <div
        ref={props.bodyRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {props.children}
      </div>
      {props.footer !== undefined ? (
        <div className="shrink-0 border-t border-border bg-panel px-4 pb-3 pt-2.5">
          {props.footer}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export type ScreenRead<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error' };

/**
 * One bounded read per open (and per `key`): loading until it settles, an error
 * at 5s, and a late answer within the grace still lands. `reload` re-reads
 * keeping what is shown. Aborted on close, key change and unmount.
 */
export function useScreenRead<T>(
  open: boolean,
  key: string,
  run: (signal: AbortSignal) => Promise<Result<T>>,
): { read: ScreenRead<T>; reload: () => void } {
  const [read, setRead] = useState<ScreenRead<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seenKey.current = null;
      setRead({ status: 'loading' });
      return;
    }
    // A new key starts from loading; a reload keeps what is shown.
    if (seenKey.current !== key) setRead({ status: 'loading' });
    seenKey.current = key;
    const cancel = new AbortController();
    void withLateRead((signal) => runRef.current(signal), {
      cancel: cancel.signal,
      timeoutMs: READ_TIMEOUT_MS,
      graceMs: LATE_READ_GRACE_MS,
      onLate: (data) => {
        if (!cancel.signal.aborted) setRead({ status: 'ready', data });
      },
    }).then((result) => {
      if (cancel.signal.aborted) return;
      if (result.ok) setRead({ status: 'ready', data: result.data });
      else setRead((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
    });
    return () => cancel.abort();
  }, [open, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { read, reload };
}

/** A confirm as a bottom sheet: the question, Cancel and the action (44px each). */
export function PlanConfirmSheet(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <Sheet
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      footer={
        <div className="grid w-full grid-cols-2 gap-2">
          <Button size="lg" variant="ghost" onClick={props.onCancel} disabled={props.busy === true}>
            Cancel
          </Button>
          <Button
            size="lg"
            variant={props.destructive === true ? 'danger' : 'primary'}
            data-plan-confirm=""
            onClick={props.onConfirm}
            disabled={props.busy === true}
          >
            {props.confirmLabel}
          </Button>
        </div>
      }
    >
      <p className="text-[15px] leading-[21px] text-fg-2">{props.message}</p>
      {props.error !== undefined && props.error !== null ? (
        <p role="alert" className="mt-2 text-sm text-bad">
          {props.error}
        </p>
      ) : null}
    </Sheet>
  );
}

/**
 * A concept's optional date: the native date input the plan's From and To use,
 * empty by default, with a 44px clear button while it holds a date. Any date is
 * allowed (inside or outside the plan's range).
 */
export function ConceptDateField(props: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] text-fg-3">Date (optional)</span>
      <span className="flex items-center gap-1.5">
        <input
          type="date"
          data-plan-concept-date=""
          value={props.value}
          disabled={props.disabled === true}
          onChange={(e) => props.onChange(e.target.value)}
          className="min-h-[48px] w-full min-w-0 flex-1 rounded-lg border border-border bg-panel px-3.5 font-mono text-[15px] text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        />
        {props.value !== '' ? (
          <button
            type="button"
            aria-label="Clear date"
            data-plan-concept-date-clear=""
            disabled={props.disabled === true}
            onClick={() => props.onChange('')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            <IconX size={18} />
          </button>
        ) : null}
      </span>
    </label>
  );
}

const PILL_TONES: Record<StatusPill['tone'], string> = {
  good: 'bg-good-soft text-good',
  review: 'bg-panel-2 text-stage-review',
  neutral: 'bg-panel-2 text-fg-2',
};

/** One status pill. */
export function PlanPill(props: { pill: StatusPill }): ReactElement {
  return (
    <span
      data-plan-pill={props.pill.side}
      className={cn(
        'inline-flex min-h-[24px] items-center rounded-md px-2 text-[13px]',
        PILL_TONES[props.pill.tone],
      )}
    >
      {props.pill.label}
    </span>
  );
}

/**
 * The progress line as one string (tests and labels), the same for every
 * viewer: Draft "Team X of N", Open "Client X of N". `side` is kept for the
 * callers. Pure.
 */
export function screenProgressLabel(bundle: PlanBundle, side?: ViewerSide): string {
  void side;
  return planProgressView(bundle).lead;
}

/**
 * The progress block under the header (sans, 13px/18px): one line, Draft
 * "Team X of N" or Open "Client X of N", the same for every viewer; a 4px bar
 * below (accent for the team side, good for the client's).
 */
export function PlanProgressRow(props: { bundle: PlanBundle; side?: ViewerSide }): ReactElement {
  const view = planProgressView(props.bundle);
  return (
    <div data-plan-progress-block="" className="flex flex-col gap-2 px-4 pt-3">
      <div
        data-plan-screen-progress=""
        className="flex items-baseline justify-between gap-3 text-[13px] leading-[18px]"
      >
        <span className="font-semibold text-fg">{view.lead}</span>
      </div>
      <span className="block h-1 overflow-hidden rounded-[2px] bg-panel-3">
        <span
          data-plan-progress-bar={view.tone}
          className={cn('block h-1', view.tone === 'accent' ? 'bg-accent' : 'bg-good')}
          style={{ width: `${view.percent}%` }}
        />
      </span>
    </div>
  );
}

/** The loading body: fixed rows so the list lands without a shift. */
function ScreenSkeleton(): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading plan"
      className="flex flex-col gap-2 p-4"
    >
      <span className="h-1.5 w-full animate-pulse rounded-full bg-panel-2" />
      <span className="h-10 w-48 animate-pulse rounded-full bg-panel-2" />
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-[104px] w-full animate-pulse rounded-lg bg-panel-2" />
      ))}
    </div>
  );
}

/** A read that failed: neutral copy and a Retry. */
export function ScreenFailed(props: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-fg-2">Couldn&apos;t load. Try again.</p>
      <Button size="lg" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Plan screen
// ---------------------------------------------------------------------------

/** The list's day groups: every plan day, out-of-range days, No date (always for the agency). */
export function planListGroups(
  bundle: PlanBundle,
  timeZone: string,
  side: ViewerSide,
): PlanWeekGroup<PlanItemRow>[] {
  const { starts_on: startsOn, ends_on: endsOn } = bundle.plan;
  return planWeekGroups(
    bundle.items,
    { startsOn, endsOn },
    (item) => planItemDayInZone(item, bundle.postInfo, timeZone),
    planShowsWeeks(startsOn, endsOn),
    side === 'agency',
  );
}

/** The list as day groups of item ids, in display order (the drag and Move math). Pure. */
export function planDayIds(groups: readonly PlanWeekGroup<PlanItemRow>[]): DayIds[] {
  return groups.flatMap((w) => w.days.map((d) => ({ day: d.day, ids: d.items.map((i) => i.id) })));
}

/** The days an item can go to: the plan's own days and No date. Pure. */
export function planMoveDays(plan: Pick<PlanBundle['plan'], 'starts_on' | 'ends_on'>): MoveDay[] {
  return [
    ...civilDaysBetween(plan.starts_on, plan.ends_on).map((day) => ({
      day,
      label: formatCivilDayHeader(day),
    })),
    { day: null, label: NO_DATE_LABEL },
  ];
}

/** "Wed 14" for a drop slot; "No date" for No date. Pure. */
export function dropDayLabel(day: string | null): string {
  return day === null ? NO_DATE_LABEL : `${civilWeekdayShort(day)} ${dayOfMonth(day)}`;
}

/** A pending optimistic move: laid over the read until a fresh read lands. */
interface MoveOverlay {
  itemId: string;
  toDay: string | null;
  order: string[];
  /** The move keeps the item's reviews (the keep sheet's "Yes, keep it"). */
  keep: boolean;
}

/** The chat the Plan screen was opened from (absent at /plans/:id). */
export interface PlanScreenChat {
  channelId: string;
  /** The chat's title ("Send in {chat name}"). */
  name: string;
  /** A client among the chat's members; null while unknown. */
  hasClient: boolean | null;
  /** The plans the chat's loaded thread holds a card for. */
  cardPlanIds: readonly string[];
  /** A plan card was recorded into this chat (the thread adds the row). */
  onSent: (row: ChatMessageRow, traceId: string) => void;
  /** "Go to card": close the screen, scroll to the card and highlight it. */
  onGoToCard: (planId: string) => void;
}

/** A move waiting on "Keep the approval?". */
interface KeepAsk {
  itemId: string;
  toDay: string | null;
  toIndex: number;
  approver: string;
}

export function PlanScreen(props: {
  open: boolean;
  planId: string;
  /** The message sender. Absent outside a chat (kept for callers; the subtitle is the range). */
  senderName?: string;
  /** The open chat's title. Absent outside a chat (kept for callers). */
  chatTitle?: string;
  /** The chat the screen was opened from: its send / Go to card footer. Absent outside a chat. */
  chat?: PlanScreenChat;
  /**
   * Outside a chat (the standalone page): the item open on entry. It takes no
   * history step of its own (the page's entry is its step), so closing it
   * closes the screen and one Back leaves.
   */
  initialItemId?: string;
  /** Outside a chat: the comment the entry item scrolls to and highlights. */
  highlightCommentId?: string;
  /** Outside a chat: a plan of another workspace reads as not available. */
  onlyWorkspaceId?: string;
  onClose: () => void;
}): ReactElement | null {
  const { workspaceId, workspaces } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side } = useViewerSide(workspaceId);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const toast = useToast();
  const planId = props.planId;
  const { read, reload } = useScreenRead<PlanScreenData>(
    props.open,
    `${planId}:${timeZone}`,
    (signal) =>
      readPlanScreen(supabase, planId, signal, {
        timeZone,
        approvers: approverIds,
        readNames: (ids, s) => readProfiles(supabase, ids, s),
      }),
  );
  const [itemId, setItemId] = useState<string | null>(props.initialItemId ?? null);
  const entryItemId = props.initialItemId ?? null;
  // Add: the sheet (its day; undefined = closed), the concept sheet, the picker.
  const [addFor, setAddFor] = useState<{ day: string | null } | null>(null);
  const [conceptFor, setConceptFor] = useState<{ day: string | null } | null>(null);
  const [conceptForm, setConceptForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [conceptBusy, setConceptBusy] = useState(false);
  const [pickFor, setPickFor] = useState<{ day: string | null } | null>(null);
  const [picked, setPicked] = useState<PostCardFields[]>([]);
  // The header menu, the inline rename, the delete and open-for-client confirms.
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [openConfirm, setOpenConfirm] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [keepAsk, setKeepAsk] = useState<KeepAsk | null>(null);
  const [sendGuard] = useState(createInFlightGuard);
  const { canAttach, uploadFile } = useCommentAttachments();
  const bodyRef = useRef<HTMLDivElement>(null);
  useHistoryStep(
    itemId !== null && itemId !== entryItemId && props.open,
    HISTORY_STEP_KEYS.planItem,
    () => setItemId(null),
  );

  // A closed screen forgets its item, sheets and local state.
  useEffect(() => {
    if (props.open) return;
    setItemId(null);
    setSlotOverrides({});
    setMoveOverlay(null);
    setAddFor(null);
    setConceptFor(null);
    setPickFor(null);
    setPicked([]);
    setMenuOpen(false);
    setRenaming(null);
    setDeleteOpen(false);
    setDeleteError(null);
    setOpenConfirm(false);
    setOpenError(null);
    setSendError(null);
    setKeepAsk(null);
  }, [props.open]);

  // A write anywhere re-reads this plan (keeping what is shown meanwhile).
  useEffect(() => {
    if (!props.open) return;
    const onChanged = (event: Event): void => {
      if (planChangedId(event) === planId) reload();
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onChanged);
  }, [props.open, planId, reload]);

  const readBundle = read.status === 'ready' ? read.data.bundle : null;
  const shownBundle =
    readBundle !== null &&
    props.onlyWorkspaceId !== undefined &&
    readBundle.plan.workspace_id !== props.onlyWorkspaceId
      ? null
      : readBundle;
  // The side the viewer's ticks WRITE (null: read-only, as the agency on an Open plan).
  const slot = shownBundle !== null ? slotSide(side, shownBundle.plan.audience) : null;
  // The viewer's slot ticks and a pending move, laid over the read until a
  // fresh read lands (a write still in flight survives that read). Rows,
  // pills, counts and the bar all read the same bundle, so they move together.
  const [slotOverrides, setSlotOverrides] = useState<Record<string, ReviewStatus>>({});
  const slotWriting = useRef(new Set<string>());
  const [moveOverlay, setMoveOverlay] = useState<MoveOverlay | null>(null);
  const moveWriting = useRef(false);
  useEffect(() => {
    setSlotOverrides((prev) => {
      const kept = Object.fromEntries(
        Object.entries(prev).filter(([id]) => slotWriting.current.has(id)),
      );
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
    if (!moveWriting.current) setMoveOverlay(null);
  }, [shownBundle]);
  const bundle = useMemo(() => {
    if (shownBundle === null) return null;
    const ticked =
      slot !== null ? withReviewOverrides(shownBundle, slot, slotOverrides) : shownBundle;
    return moveOverlay !== null
      ? applyMove(
          ticked,
          moveOverlay.itemId,
          moveOverlay.toDay,
          moveOverlay.order,
          timeZone,
          moveOverlay.keep,
        )
      : ticked;
  }, [shownBundle, slot, slotOverrides, moveOverlay, timeZone]);
  const groups = useMemo(
    () => (bundle !== null ? planListGroups(bundle, timeZone, side) : []),
    [bundle, timeZone, side],
  );
  const names = read.status === 'ready' ? (read.data.names ?? {}) : {};
  const nameOf = (userId: string | null): string =>
    (userId !== null ? names[userId] : undefined) ?? MEMBER_NAME;

  // A re-read that drops the open item (removed) or the plan itself (deleted,
  // no longer readable) closes that layer through its own close path, so its
  // history step is released and Back lands on the layer below.
  const hadPlan = useRef(false);
  useEffect(() => {
    if (!props.open) {
      hadPlan.current = false;
      return;
    }
    const drop = droppedLayer({
      status: read.status,
      bundle,
      itemId,
      hadPlan: hadPlan.current,
    });
    if (bundle !== null) hadPlan.current = true;
    if (drop === 'plan') props.onClose();
    else if (drop === 'item') setItemId(null);
    // props.onClose is the parent's stable close; the read and item decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, read, bundle, itemId]);
  // First paint: the thread's card cache already holds the title.
  const planCards = usePlanCards();
  const cachedTitle = planCards?.cache.snapshot([planId]).bundles.get(planId)?.plan.title ?? null;
  const title = planHeaderTitle(read.status, bundle?.plan.title ?? null, cachedTitle);
  const subtitle =
    bundle !== null && side !== 'unknown' ? planHeaderSubtitle(bundle.plan) : undefined;
  const agency = side === 'agency' && bundle !== null;
  // Delete is for the plan's creator or a workspace owner/admin: one role read
  // per open, agency side only.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open || side !== 'agency' || workspaceId === null || me === null) return;
    let cancelled = false;
    void fetchMemberRole(supabase, workspaceId, me).then((next) => {
      if (!cancelled) setRole(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, side, workspaceId, me]);
  const mayDelete = bundle !== null && canDeletePlan(bundle.plan, me, role);

  // Rename: the title becomes a field; Done saves through plan_update with the
  // plan's current dates.
  const saveRename = async (): Promise<void> => {
    if (bundle === null || renaming === null || renameBusy) return;
    const next = renameTitle(renaming);
    if (next === null) return;
    if (next === bundle.plan.title) {
      setRenaming(null);
      return;
    }
    setRenameBusy(true);
    const traceId = generateTraceId();
    const result = await planUpdate(supabase, {
      p_plan_id: planId,
      p_title: next,
      p_starts_on: bundle.plan.starts_on,
      p_ends_on: bundle.plan.ends_on,
      p_trace_id: traceId,
    });
    setRenameBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan rename failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: RENAME_FAILED });
      return;
    }
    setRenaming(null);
    toast.show({ title: RENAMED_TOAST });
    dispatchPlanChanged(window, planId);
  };

  const deletePlan = async (): Promise<void> => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const traceId = generateTraceId();
    const result = await planDelete(supabase, { p_plan_id: planId, p_trace_id: traceId });
    setDeleteBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan delete failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      setDeleteError(deletePlanErrorCopy(result.error.message));
      return;
    }
    setDeleteOpen(false);
    toast.show({ title: PLAN_DELETED_TOAST });
    dispatchPlanChanged(window, planId);
    props.onClose();
  };

  const openForClient = async (): Promise<void> => {
    if (openBusy) return;
    setOpenBusy(true);
    setOpenError(null);
    const traceId = generateTraceId();
    const result = await planShareWithClient(supabase, { p_plan_id: planId, p_trace_id: traceId });
    setOpenBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan open for client failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      setOpenError(OPEN_FOR_CLIENT_FAILED);
      return;
    }
    setOpenConfirm(false);
    toast.show({ title: OPEN_FOR_CLIENT_TOAST });
    dispatchPlanChanged(window, planId);
  };

  const chat = props.chat ?? null;
  const sendAction =
    bundle !== null
      ? planSendAction({
          side,
          audience: bundle.plan.audience,
          chat:
            chat !== null
              ? {
                  name: chat.name,
                  hasClient: chat.hasClient,
                  cardInChat: chat.cardPlanIds.includes(planId),
                }
              : null,
        })
      : ({ kind: 'none' } as const);
  const sendHere = async (): Promise<void> => {
    if (chat === null || sendBusy) return;
    setSendError(null);
    setSendBusy(true);
    const result = await sharePlanToChannel(
      {
        guard: sendGuard,
        record: (input) =>
          chatPlanShare(supabase, {
            p_id: input.id,
            p_channel_id: input.channelId,
            p_plan_id: input.planId,
            p_trace_id: input.traceId,
          }),
        // The open thread adds the row and publishes it live.
        publish: null,
        newMessageId,
        newTraceId: generateTraceId,
        onPublishFailed: () => {},
      },
      { channelId: chat.channelId, planId },
    );
    setSendBusy(false);
    if (!result.ok) {
      if (result.reason === 'busy') return;
      logger.warn('chat: plan send from the plan screen failed', {
        channel_id: chat.channelId,
        plan_id: planId,
        error: result.message,
      });
      setSendError(refusedForClient(result.message) ? SEND_NEEDS_OPEN : SEND_FAILED);
      return;
    }
    chat.onSent(result.row, result.traceId);
  };

  // One slot write: optimistic at once, reverted on failure; a tick's toast
  // offers Undo (a write back to the status the tick replaced), an untick's
  // says it was removed.
  const writeSlot = async (
    item: PlanItemRow,
    reviewSide: ReviewSide,
    status: ReviewStatus,
    previous: ReviewStatus,
    kind: 'tick' | 'untick' | 'undo',
    dayHeader: string | null,
  ): Promise<void> => {
    if (slotWriting.current.has(item.id)) return;
    slotWriting.current.add(item.id);
    const traceId = generateTraceId();
    const result = await runSlotWrite({
      status,
      previous,
      apply: (next) => setSlotOverrides((prev) => ({ ...prev, [item.id]: next })),
      write: (next) =>
        planItemReview(supabase, {
          p_item_id: item.id,
          p_side: reviewSide,
          p_status: next,
          p_trace_id: traceId,
        }),
    });
    slotWriting.current.delete(item.id);
    if (!result.ok) {
      logger.warn('chat: plan slot review failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
    } else {
      dispatchPlanChanged(window, planId);
    }
    const spec = slotToastSpec(
      kind,
      result.ok ? { ok: true } : { ok: false, message: result.error.message },
      dayHeader,
    );
    if (spec === null) return;
    toast.show({
      title: spec.title,
      ...(spec.undo ? { tone: 'success' as const } : {}),
      ...(spec.undo
        ? {
            durationMs: SLOT_UNDO_MS,
            action: {
              label: SLOT_UNDO,
              // Undo restores the exact status the tick replaced.
              onPress: () =>
                void writeSlot(
                  item,
                  reviewSide,
                  slotUndoStatus(previous),
                  'approved',
                  'undo',
                  dayHeader,
                ),
            },
          }
        : {}),
    });
  };
  const toggleSlot = (item: PlanItemRow): void => {
    // Read-only boxes (the agency on an Open plan) never write.
    if (bundle === null || slot === null) return;
    const previous = reviewStatus(bundle, item.id, slot);
    const ticked = previous === 'approved';
    const day = planItemDayInZone(item, bundle.postInfo, timeZone);
    void writeSlot(
      item,
      slot,
      ticked ? 'waiting' : 'approved',
      previous,
      ticked ? 'untick' : 'tick',
      day !== null ? formatCivilDayHeader(day) : null,
    );
  };

  // A drop or a Move: optimistic at once (the full new order and the day),
  // one 5-arg plan_item_move, reverted on failure. On an Open plan a day
  // change of a client-approved slot asks "Keep the approval?" first
  // (cancelling cancels the move); every other move resets (false).
  const commitMove = async (
    moved: string,
    toDay: string | null,
    toIndex: number,
    keep: boolean,
  ): Promise<void> => {
    if (bundle === null) return;
    const days = planDayIds(groups);
    const from = findItem(days, moved);
    if (from === null || isNoop(days, moved, { day: toDay, index: toIndex })) return;
    if (moveWriting.current) {
      toast.show({ title: MOVE_FAILED });
      return;
    }
    const order = flattenOrder(moveItem(days, moved, toDay, toIndex));
    const dayChanged = from.day !== toDay;
    const hadTicks = hasTicks(bundle, moved);
    moveWriting.current = true;
    setMoveOverlay({ itemId: moved, toDay, order, keep });
    const traceId = generateTraceId();
    const result = await planItemMove(supabase, {
      p_item_id: moved,
      p_target_date: toDay,
      p_item_ids: order,
      p_keep_reviews: keep,
      p_trace_id: traceId,
    });
    moveWriting.current = false;
    if (!result.ok) {
      logger.warn('chat: plan item move failed', {
        trace_id: traceId,
        item_id: moved,
        error: result.error.message,
      });
      setMoveOverlay(null);
      toast.show({ title: planWriteErrorCopy(result.error.message, MOVE_FAILED) });
      return;
    }
    if (dayChanged) {
      toast.show({
        title: keep ? movedKeptToast(dayHeaderOf(toDay)) : movedToast(dayHeaderOf(toDay), hadTicks),
      });
    }
    dispatchPlanChanged(window, planId);
  };
  const moveTo = (moved: string, toDay: string | null, toIndex: number): void => {
    if (bundle === null) return;
    const item = bundle.items.find((i) => i.id === moved);
    const from = findItem(planDayIds(groups), moved);
    if (item === undefined || from === null) return;
    if (moveAsksKeep(bundle, item, from.day, toDay)) {
      setKeepAsk({
        itemId: moved,
        toDay,
        toIndex,
        approver: nameOf(approvedBy(bundle, item)?.userId ?? null),
      });
      return;
    }
    void commitMove(moved, toDay, toIndex, false);
  };
  const drag = usePlanDrag({
    enabled: agency,
    bodyRef,
    onDrop: (moved, toDay, toIndex) => moveTo(moved, toDay, toIndex),
  });

  // Add: a concept on that day, or picked posts on that day.
  const openAdd = (day: string | null): void => setAddFor({ day });
  const startConcept = (): void => {
    if (addFor === null) return;
    setConceptForm({ ...EMPTY_CONCEPT, date: addFor.day ?? '' });
    setConceptFor(addFor);
    setAddFor(null);
  };
  const startPick = (): void => {
    if (addFor === null) return;
    setPicked([]);
    setPickFor(addFor);
    setAddFor(null);
  };
  const saveConcept = async (): Promise<void> => {
    if (conceptBusy || conceptFor === null) return;
    const date = conceptForm.date === '' ? null : conceptForm.date;
    setConceptBusy(true);
    const traceId = generateTraceId();
    const result = await planConceptAdd(
      supabase,
      conceptAddArgs(
        planId,
        {
          key: '',
          title: conceptForm.title.trim(),
          description: conceptForm.description.trim(),
          versionIds: conceptForm.files.map((f) => f.versionId),
          targetDate: date,
        },
        traceId,
      ),
    );
    setConceptBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan concept add failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, ADD_FAILED) });
      return;
    }
    setConceptFor(null);
    toast.show({ title: addedToast('concept', dayHeaderOf(date)) });
    dispatchPlanChanged(window, planId);
  };
  const closePicker = async (): Promise<void> => {
    if (pickFor === null) return;
    const day = pickFor.day;
    const ids = picked.map((p) => p.id);
    setPickFor(null);
    setPicked([]);
    if (ids.length === 0) return;
    const traceId = generateTraceId();
    const result = await planPostsAdd(supabase, {
      p_plan_id: planId,
      p_post_ids: ids,
      p_trace_id: traceId,
      ...(day !== null ? { p_target_date: day } : {}),
    });
    if (!result.ok) {
      logger.warn('chat: plan posts add failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, ADD_FAILED) });
      return;
    }
    toast.show({ title: addedToast('post', dayHeaderOf(day)) });
    dispatchPlanChanged(window, planId);
  };
  const inPlan = useMemo(
    () => new Set((bundle?.items ?? []).flatMap((i) => (i.post_id !== null ? [i.post_id] : []))),
    [bundle],
  );

  const found = bundle?.items.find((i) => i.id === itemId) ?? null;
  // A draft the viewer can see by name only never opens (a drawer row included).
  const item =
    found !== null && bundle !== null && !draftLocked(bundle, found, side) ? found : null;
  const showOpen = side === 'agency' && bundle !== null && bundle.plan.audience === 'team';
  const footer =
    bundle !== null && (showOpen || sendAction.kind !== 'none') ? (
      <PlanFooter
        showOpen={showOpen}
        send={sendAction}
        sending={sendBusy}
        error={sendError}
        onOpenForClient={() => {
          setOpenError(null);
          setOpenConfirm(true);
        }}
        onSend={() => void sendHere()}
        onGoToCard={() => chat?.onGoToCard(planId)}
      />
    ) : undefined;
  return (
    <>
      <PlanPage
        open={props.open}
        testId="plan"
        title={title}
        // The inline rename takes the whole title column.
        subtitle={renaming !== null ? undefined : subtitle}
        backLabel="Back"
        onBack={props.onClose}
        bodyRef={bodyRef}
        footer={footer}
        {...(agency
          ? {
              titleSlot:
                renaming !== null ? (
                  <RenameField
                    value={renaming}
                    busy={renameBusy}
                    onChange={setRenaming}
                    onCancel={() => setRenaming(null)}
                    onDone={() => void saveRename()}
                  />
                ) : (
                  <PlanTitleButton
                    title={title}
                    open={menuOpen}
                    onToggle={() => setMenuOpen((v) => !v)}
                  />
                ),
              overlay: (
                <PlanHeaderMenu
                  open={props.open && menuOpen}
                  canDelete={mayDelete}
                  onRename={() => {
                    setMenuOpen(false);
                    setRenaming(bundle?.plan.title ?? '');
                  }}
                  onDelete={() => {
                    setMenuOpen(false);
                    setDeleteError(null);
                    setDeleteOpen(true);
                  }}
                  onClose={() => setMenuOpen(false)}
                />
              ),
              ...(renaming === null
                ? {
                    action: (
                      <button
                        type="button"
                        aria-label="Add to plan"
                        data-plan-add-header=""
                        onClick={() => openAdd(null)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <IconPlus size={22} />
                      </button>
                    ),
                  }
                : {}),
            }
          : {})}
      >
        {read.status === 'loading' ? (
          <ScreenSkeleton />
        ) : read.status === 'error' ? (
          <ScreenFailed onRetry={reload} />
        ) : bundle === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-2">
            <IconPlan size={22} />
            <p className="text-sm">{PLAN_NOT_AVAILABLE}</p>
          </div>
        ) : (
          <PlanBody
            bundle={bundle}
            groups={groups}
            side={side}
            timeZone={timeZone}
            thumbs={read.status === 'ready' ? read.data.thumbs : {}}
            counts={read.status === 'ready' ? read.data.commentCounts : {}}
            names={names}
            alsoIn={read.status === 'ready' ? (read.data.alsoIn ?? {}) : {}}
            drag={drag.state}
            onOpenItem={setItemId}
            onToggleSlot={toggleSlot}
            {...(agency ? { onAdd: openAdd, onDragStart: drag.start } : {})}
          />
        )}
      </PlanPage>
      {drag.state !== null && bundle !== null ? (
        <DragCard
          bundle={bundle}
          state={drag.state}
          thumb={(() => {
            const dragged = bundle.items.find((i) => i.id === drag.state?.itemId);
            return dragged?.post_id != null && read.status === 'ready'
              ? (read.data.thumbs[dragged.post_id] ?? null)
              : null;
          })()}
        />
      ) : null}
      {bundle !== null && item !== null ? (
        <PlanItemScreen
          open={props.open && itemId !== null}
          bundle={bundle}
          item={item}
          side={side}
          approverName={nameOf(approvedBy(bundle, item)?.userId ?? null)}
          {...(itemId === entryItemId
            ? {
                backLabel: 'Back',
                ...(props.highlightCommentId !== undefined
                  ? { highlightCommentId: props.highlightCommentId }
                  : {}),
              }
            : {})}
          onClose={() => (itemId === entryItemId ? props.onClose() : setItemId(null))}
          onRemoved={() => setItemId(null)}
        />
      ) : null}
      <PlanKeepApprovalSheet
        open={props.open && keepAsk !== null}
        title={keepApprovalTitle(keepAsk?.approver ?? MEMBER_NAME)}
        body={keepApprovalBody(dayHeaderOf(keepAsk?.toDay ?? null))}
        onKeep={(keep) => {
          const ask = keepAsk;
          setKeepAsk(null);
          if (ask !== null) void commitMove(ask.itemId, ask.toDay, ask.toIndex, keep);
        }}
        onCancel={() => setKeepAsk(null)}
      />
      {agency ? (
        <>
          <PlanConfirmSheet
            open={props.open && deleteOpen}
            title={DELETE_PLAN_TITLE}
            message={deletePlanBody(bundle?.plan.audience ?? 'team')}
            confirmLabel={DELETE_PLAN_LABEL}
            destructive
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void deletePlan()}
            onCancel={() => {
              if (!deleteBusy) setDeleteOpen(false);
            }}
          />
          <PlanConfirmSheet
            open={props.open && openConfirm}
            title={OPEN_FOR_CLIENT_TITLE}
            message={OPEN_FOR_CLIENT_BODY}
            confirmLabel={OPEN_FOR_CLIENT_LABEL}
            busy={openBusy}
            error={openError}
            onConfirm={() => void openForClient()}
            onCancel={() => {
              if (!openBusy) setOpenConfirm(false);
            }}
          />
          <PlanAddSheet
            open={props.open && addFor !== null}
            dayHeader={addFor !== null ? dayHeaderOf(addFor.day) : null}
            onNewConcept={startConcept}
            onPickPost={startPick}
            onClose={() => setAddFor(null)}
          />
          <ConceptSheet
            open={props.open && conceptFor !== null}
            mode="add"
            form={conceptForm}
            onChange={setConceptForm}
            onSubmit={() => void saveConcept()}
            onClose={() => {
              if (!conceptBusy) setConceptFor(null);
            }}
            busy={conceptBusy}
            {...(canAttach ? { uploadFile } : {})}
          />
          <PostPicker
            open={props.open && pickFor !== null}
            onClose={() => void closePicker()}
            mode="posts"
            selected={picked}
            onToggle={(post) =>
              setPicked((prev) =>
                prev.some((p) => p.id === post.id)
                  ? prev.filter((p) => p.id !== post.id)
                  : [...prev, post],
              )
            }
            selectedBriefs={[]}
            onToggleBrief={() => {}}
            channelHasClient={false}
            excludePostIds={inPlan}
          />
        </>
      ) : null}
    </>
  );
}

/** The name an approver reads as when their name did not load. */
export const MEMBER_NAME = 'Member';

/**
 * The agency's header title: a button with a small chevron that opens the
 * header menu (Rename, Delete plan). 44px tall; truncates.
 */
function PlanTitleButton(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      data-plan-title-menu=""
      aria-haspopup="menu"
      aria-expanded={props.open}
      onClick={props.onToggle}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        '-ml-1 flex min-h-[44px] min-w-0 max-w-full items-center gap-1 self-start rounded-md px-1 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        NO_TOUCH_SELECT,
      )}
    >
      <h2 className="truncate text-[17px] font-[650] leading-[22px] text-fg">{props.title}</h2>
      <span aria-hidden="true" className="shrink-0 text-fg-3">
        <IconChevronDown size={16} />
      </span>
    </button>
  );
}

/**
 * The header menu, anchored under the header: Rename and, for the plan's
 * creator or a workspace owner/admin, "Delete plan" (danger, bin icon). Slides
 * on translateY only; an outside tap or Escape closes it.
 */
export function PlanHeaderMenu(props: {
  open: boolean;
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = props.onClose;
  // Slides in on translateY (no X, no rotate); reduced motion skips it.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!props.open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: Event): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target) === true) return;
      if (target instanceof Element && target.closest('[data-plan-title-menu]') !== null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [props.open, onClose]);
  if (!props.open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Plan actions"
      data-plan-header-menu=""
      className={cn(
        'absolute left-12 top-full z-20 mt-1 flex w-56 flex-col overflow-hidden rounded-lg border border-border-strong bg-panel py-1 shadow-lg transition-transform duration-fast ease-enter motion-reduce:transition-none',
        entered ? 'translate-y-0' : '-translate-y-1',
        NO_TOUCH_SELECT,
      )}
    >
      <button
        type="button"
        role="menuitem"
        data-plan-menu-rename=""
        onClick={props.onRename}
        className="flex min-h-[44px] w-full items-center gap-3 px-3 text-left text-[15px] text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconEdit size={18} />
        {RENAME_LABEL}
      </button>
      {props.canDelete ? (
        <button
          type="button"
          role="menuitem"
          data-plan-menu-delete=""
          onClick={props.onDelete}
          className="flex min-h-[44px] w-full items-center gap-3 px-3 text-left text-[15px] text-bad hover:bg-bad-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconTrash size={18} />
          {DELETE_PLAN_LABEL}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The inline rename: the title as a text field (1 to 200 characters, trimmed),
 * Cancel (X) and Done, each 44px. Enter is Done, Escape is Cancel.
 */
export function RenameField(props: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onDone: () => void;
}): ReactElement {
  const valid = renameTitle(props.value) !== null;
  return (
    <div data-plan-rename="" className="flex min-w-0 items-center gap-1">
      <input
        aria-label="Plan title"
        data-plan-rename-input=""
        autoFocus
        value={props.value}
        maxLength={PLAN_TITLE_MAX}
        disabled={props.busy}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) props.onDone();
          if (e.key === 'Escape') props.onCancel();
        }}
        className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-base font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      />
      <button
        type="button"
        aria-label="Cancel rename"
        data-plan-rename-cancel=""
        disabled={props.busy}
        onClick={props.onCancel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        <IconX size={20} />
      </button>
      <button
        type="button"
        data-plan-rename-done=""
        disabled={props.busy || !valid}
        onClick={props.onDone}
        className="min-h-[44px] min-w-[44px] shrink-0 rounded-md px-2 text-[15px] font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        Done
      </button>
    </div>
  );
}

/**
 * The Plan screen's footer: "Open for client" (primary) on an agency Draft
 * plan, then the chat action: "Send in {chat}" (disabled with its hint on a
 * Draft plan in a chat with a client) or "Go to card". 44px+ targets.
 */
export function PlanFooter(props: {
  showOpen: boolean;
  send: SendAction;
  sending: boolean;
  error: string | null;
  onOpenForClient: () => void;
  onSend: () => void;
  onGoToCard: () => void;
}): ReactElement {
  const { send } = props;
  const hint = send.kind === 'send' ? send.hint : null;
  return (
    <div data-plan-footer="" className="flex flex-col gap-1.5">
      {props.error !== null ? (
        <p role="alert" data-plan-send-error="" className="text-[13px] text-bad">
          {props.error}
        </p>
      ) : null}
      {hint !== null ? (
        <p data-plan-send-hint="" className="text-[13px] leading-[18px] text-fg-3">
          {hint}
        </p>
      ) : null}
      <div className="flex gap-2">
        {props.showOpen ? (
          <Button
            size="lg"
            variant="primary"
            data-plan-open-client=""
            className="min-h-[48px] flex-1"
            onClick={props.onOpenForClient}
          >
            {OPEN_FOR_CLIENT_LABEL}
          </Button>
        ) : null}
        {send.kind === 'send' ? (
          <Button
            size="lg"
            data-plan-send-here=""
            className="min-h-[48px] min-w-0 flex-1"
            disabled={send.disabled || props.sending}
            onClick={props.onSend}
          >
            <span className="truncate">{send.label}</span>
          </Button>
        ) : send.kind === 'go' ? (
          <Button
            size="lg"
            data-plan-go-card=""
            className="min-h-[48px] flex-1"
            onClick={props.onGoToCard}
          >
            {GO_TO_CARD_LABEL}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag (agency): long-press lifts a row, the pointer moves it, a drop moves it
// ---------------------------------------------------------------------------

/** Lift and drop timings (ms); reduced motion skips the scale and the snap. */
export const DRAG_LIFT_MS = 120;
export const DRAG_SNAP_MS = 180;
/** Auto-scroll: the edge band (px) and the step per frame (px). */
const EDGE_PX = 56;
const EDGE_STEP_PX = 10;

/** A drag in progress: the item, where it started, the pointer and the hovered drop. */
export interface DragState {
  itemId: string;
  /** The row's rect when lifted (viewport px). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Pointer y at lift and now (viewport px). */
  startY: number;
  y: number;
  /** The hovered droppable day (undefined = none) and the index in it. */
  overDay: string | null | undefined;
  overIndex: number;
  /** Set once dropped: the clone eases to this top before the move lands. */
  snapTop: number | null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The drag controller: `start` from a row's long-press lifts it; window
 * pointer listeners move it (translateY only), hover a day block, auto-scroll
 * near the body's edges; pointerup drops (one onDrop), Escape or pointercancel
 * cancels with no write. Every listener, frame and timer is removed on end
 * and on unmount.
 */
function usePlanDrag(opts: {
  enabled: boolean;
  bodyRef: RefObject<HTMLDivElement>;
  onDrop: (itemId: string, toDay: string | null, toIndex: number) => void;
}): {
  state: DragState | null;
  start: (itemId: string, row: HTMLElement, clientY: number) => void;
} {
  const [state, setState] = useState<DragState | null>(null);
  const stateRef = useRef<DragState | null>(null);
  const onDropRef = useRef(opts.onDrop);
  onDropRef.current = opts.onDrop;
  const cleanupRef = useRef<(() => void) | null>(null);

  const set = (next: DragState | null): void => {
    stateRef.current = next;
    setState(next);
  };
  const end = useCallback((): void => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    stateRef.current = null;
    setState(null);
  }, []);
  useEffect(() => end, [end]);
  useEffect(() => {
    if (!opts.enabled) end();
  }, [opts.enabled, end]);

  const start = (itemId: string, row: HTMLElement, clientY: number): void => {
    if (!opts.enabled || stateRef.current !== null) return;
    const body = opts.bodyRef.current;
    if (body === null) return;
    const rect = row.getBoundingClientRect();
    let frame = 0;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;

    const target = (y: number): { day: string | null | undefined; index: number } => {
      const x = rect.left + 8;
      const hit = document.elementFromPoint(x, y);
      const block = hit?.closest<HTMLElement>('[data-plan-drop]') ?? null;
      if (block === null) return { day: undefined, index: 0 };
      const raw = block.getAttribute('data-plan-day');
      const day = raw === null || raw === 'none' ? null : raw;
      const middles = [...block.querySelectorAll<HTMLElement>('[data-plan-row-wrap]')]
        .filter((el) => el.getAttribute('data-plan-row-wrap') !== itemId)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2;
        });
      return { day, index: dropIndex(middles, y) };
    };
    const update = (y: number): void => {
      const current = stateRef.current;
      if (current === null || current.snapTop !== null) return;
      const hit = target(y);
      set({ ...current, y, overDay: hit.day, overIndex: hit.index });
    };
    const onMove = (event: PointerEvent): void => update(event.clientY);
    const onTouchMove = (event: TouchEvent): void => event.preventDefault();
    const cancel = (): void => end();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };
    const onUp = (): void => {
      const current = stateRef.current;
      if (current === null || current.snapTop !== null) return;
      if (current.overDay === undefined) {
        cancel();
        return;
      }
      const toDay = current.overDay;
      const toIndex = current.overIndex;
      const commit = (): void => {
        end();
        onDropRef.current(itemId, toDay, toIndex);
      };
      const slot = document.querySelector<HTMLElement>('[data-plan-drop-slot]');
      if (prefersReducedMotion() || slot === null) {
        commit();
        return;
      }
      set({ ...current, snapTop: slot.getBoundingClientRect().top });
      snapTimer = setTimeout(commit, DRAG_SNAP_MS);
    };
    // Auto-scroll near the body's top or bottom edge while the pointer rests.
    const tick = (): void => {
      const current = stateRef.current;
      if (current !== null && current.snapTop === null) {
        const box = body.getBoundingClientRect();
        const before = body.scrollTop;
        if (current.y < box.top + EDGE_PX) body.scrollTop -= EDGE_STEP_PX;
        else if (current.y > box.bottom - EDGE_PX) body.scrollTop += EDGE_STEP_PX;
        // The rows moved under a resting pointer: re-aim the drop.
        if (body.scrollTop !== before) update(current.y);
      }
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    frame = requestAnimationFrame(tick);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchmove', onTouchMove);
      cancelAnimationFrame(frame);
      if (snapTimer !== null) clearTimeout(snapTimer);
    };
    const first = target(clientY);
    set({
      itemId,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      startY: clientY,
      y: clientY,
      overDay: first.day,
      overIndex: first.index,
      snapTop: null,
    });
  };

  return { state, start };
}

/**
 * The lifted card: fixed over the list at the row's place, moved with
 * translateY only, raised (shadow token, a slight scale that eases in over
 * 120ms); on drop it eases to the slot over 180ms. Reduced motion: no scale,
 * no ease.
 */
function DragCard(props: {
  bundle: PlanBundle;
  state: DragState;
  thumb: string | null;
}): ReactElement | null {
  const { state } = props;
  const [lifted, setLifted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setLifted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const item = props.bundle.items.find((i) => i.id === state.itemId);
  if (item === undefined) return null;
  const dy = state.snapTop !== null ? state.snapTop - state.top : state.y - state.startY;
  return createPortal(
    <div
      aria-hidden="true"
      data-plan-drag-card=""
      className={cn(
        'pointer-events-none fixed z-[60]',
        state.snapTop !== null && 'transition-transform ease-exit motion-reduce:transition-none',
      )}
      style={{
        left: state.left,
        top: state.top,
        width: state.width,
        transform: `translateY(${dy}px)`,
        ...(state.snapTop !== null ? { transitionDuration: `${DRAG_SNAP_MS}ms` } : {}),
      }}
    >
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border border-border bg-panel p-2 shadow-lg transition-transform ease-enter motion-reduce:scale-100 motion-reduce:transition-none',
          lifted ? 'scale-[1.02]' : 'scale-100',
        )}
        style={{ transitionDuration: `${DRAG_LIFT_MS}ms` }}
      >
        <RowTile item={item} thumb={props.thumb} muted={false} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold leading-5 text-fg">
            {rowTitle(props.bundle, item)}
          </span>
          <span className="truncate text-[13px] leading-[18px] text-fg-3">
            {rowMeta(props.bundle, item)}
          </span>
        </span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The Plan screen's header: the read's title once ready (or "Plan not
 * available"), else the cached card's title, else "Plan" when nothing is
 * cached. Pure.
 */
export function planHeaderTitle(
  status: ScreenRead<unknown>['status'],
  readTitle: string | null,
  cachedTitle: string | null,
): string {
  if (status === 'ready') return readTitle ?? PLAN_NOT_AVAILABLE;
  return cachedTitle ?? 'Plan';
}

/**
 * Which open layer a settled read dropped: 'plan' when a plan that was
 * readable is gone, 'item' when the open item is no longer in the plan, else
 * null (a plan never readable keeps its "Plan not available" body). Pure.
 */
export function droppedLayer(input: {
  status: ScreenRead<unknown>['status'];
  bundle: Pick<PlanBundle, 'items'> | null;
  itemId: string | null;
  hadPlan: boolean;
}): 'plan' | 'item' | null {
  if (input.status !== 'ready') return null;
  if (input.bundle === null) return input.hadPlan ? 'plan' : null;
  if (input.itemId !== null && !input.bundle.items.some((i) => i.id === input.itemId)) {
    return 'item';
  }
  return null;
}

/** A row's title: a concept's own, a draft row's, or its post's. Pure. */
export function rowTitle(bundle: PlanBundle | null, item: PlanItemRow): string {
  if (item.kind === 'concept') return item.title ?? '';
  if (item.draft_row === true) return item.title ?? 'Post';
  const info = item.post_id !== null ? bundle?.postInfo[item.post_id] : undefined;
  return info?.title ?? 'Post';
}

/** A row's second line: a concept's description (the date has its own line). Pure. */
export function rowSubline(item: PlanItemRow): string {
  return item.kind === 'concept' ? (item.description ?? '') : '';
}

export function PlanBody(props: {
  bundle: PlanBundle;
  groups: readonly PlanWeekGroup<PlanItemRow>[];
  side: ViewerSide;
  timeZone: string;
  thumbs: Record<string, string>;
  /** Visible comment counts by item id (the screen's one count read). */
  counts?: Readonly<Record<string, number>>;
  /** Approvers' names by user id (the Approved by lines). */
  names?: Readonly<Record<string, string>>;
  /** Other plans' titles by post id (the Also in pill). */
  alsoIn?: Readonly<Record<string, string[]>>;
  /** The drag in progress, or null. */
  drag: DragState | null;
  onOpenItem: (id: string) => void;
  onToggleSlot: (item: PlanItemRow) => void;
  /** Agency only: a day's Add row (null = No date). */
  onAdd?: (day: string | null) => void;
  /** Agency only: a row's long-press lifts it. */
  onDragStart?: (itemId: string, row: HTMLElement, clientY: number) => void;
}): ReactElement {
  const { bundle, side, drag } = props;
  const weeks = planShowsWeeks(bundle.plan.starts_on, bundle.plan.ends_on);
  const today = civilToday(new Date(), props.timeZone);
  const dragFrom = drag !== null ? (findItem(planDayIds(props.groups), drag.itemId) ?? null) : null;
  return (
    <>
      <PlanProgressRow bundle={bundle} />
      <div data-plan-list={weeks ? 'weeks' : 'days'} className="flex flex-col pb-4 pt-3">
        {props.groups.map((week, w) => (
          <section
            key={week.label ?? `days-${w}`}
            {...(week.label !== null ? { 'data-plan-week': week.label } : {})}
            className="flex flex-col"
          >
            {week.label !== null ? (
              <h3
                data-plan-week-header=""
                className="sticky top-0 z-10 border-b border-border bg-bg px-4 py-2 text-[13px] font-semibold text-fg-2"
              >
                {week.label}
              </h3>
            ) : null}
            {week.days.map((day) => {
              const droppable = drag !== null && (day.day === null || day.inRange);
              const hovered = droppable && drag.overDay === day.day;
              const items = day.items;
              // The drop slot shows where the item would land, unless that is where it is.
              const slotAt =
                hovered &&
                !(
                  dragFrom !== null &&
                  dragFrom.day === day.day &&
                  dragFrom.index === drag.overIndex
                )
                  ? drag.overIndex
                  : null;
              const others = items.filter((i) => drag === null || i.id !== drag.itemId);
              const empty = items.length === 0;
              let k = 0;
              return (
                <div
                  key={day.day ?? 'none'}
                  data-plan-day={day.day ?? 'none'}
                  {...(day.day !== null && !day.inRange ? { 'data-plan-day-out': '' } : {})}
                  {...(droppable ? { 'data-plan-drop': '' } : {})}
                  {...(hovered ? { 'data-plan-drop-over': '' } : {})}
                  className={cn(
                    'flex gap-3 border-t border-border py-4 pl-4 pr-[5px]',
                    hovered && 'shadow-[inset_3px_0_0_var(--accent)]',
                  )}
                >
                  <DayColumn day={day.day} today={today} empty={empty} />
                  <div className="flex min-w-0 flex-1 flex-col gap-4">
                    {items.map((item) => {
                      const lifted = drag !== null && item.id === drag.itemId;
                      const slotHere = !lifted && slotAt === k;
                      if (!lifted) k += 1;
                      return (
                        <Fragment key={item.id}>
                          {slotHere ? <DropSlot day={day.day} /> : null}
                          <PlanRow
                            bundle={bundle}
                            item={item}
                            side={side}
                            thumb={
                              item.post_id !== null ? (props.thumbs[item.post_id] ?? null) : null
                            }
                            dimmed={lifted}
                            comments={props.counts?.[item.id] ?? 0}
                            timeZone={props.timeZone}
                            approvedByName={(() => {
                              const by = approvedBy(bundle, item);
                              if (by === null) return null;
                              return (
                                (by.userId !== null ? props.names?.[by.userId] : undefined) ??
                                MEMBER_NAME
                              );
                            })()}
                            alsoIn={
                              item.post_id !== null ? (props.alsoIn?.[item.post_id] ?? []) : []
                            }
                            onOpen={() => props.onOpenItem(item.id)}
                            onToggleSlot={() => props.onToggleSlot(item)}
                            {...(props.onDragStart !== undefined &&
                            (day.day === null || day.inRange)
                              ? { onDragStart: props.onDragStart }
                              : {})}
                          />
                        </Fragment>
                      );
                    })}
                    {slotAt !== null && slotAt >= others.length ? <DropSlot day={day.day} /> : null}
                    {props.onAdd !== undefined && (day.day === null || day.inRange) ? (
                      <AddRow day={day.day} empty={empty} onAdd={props.onAdd} />
                    ) : empty && slotAt === null ? (
                      <p
                        data-plan-day-empty=""
                        className="flex min-h-[44px] items-center text-[13px] text-fg-3"
                      >
                        Nothing planned
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}

/** The dashed 44px drop slot in the hovered day. */
function DropSlot(props: { day: string | null }): ReactElement {
  return (
    <div
      data-plan-drop-slot=""
      className="flex h-11 items-center rounded-lg border-[1.5px] border-dashed border-accent px-3 text-[13px] text-accent"
    >
      {`Drop to move to ${dropDayLabel(props.day)}`}
    </div>
  );
}

/**
 * A day's Add row (agency): plus icon and "Add" (13px, 600, accent) in a 44px
 * target, its left edge on the thumbnail column. Under a day's rows it tucks
 * up so the gap stays 16px; on an empty day it sits right of "Nothing planned".
 */
function AddRow(props: {
  day: string | null;
  empty: boolean;
  onAdd: (day: string | null) => void;
}): ReactElement {
  const label = `Add to ${props.day !== null ? formatCivilDayHeader(props.day) : NO_DATE_LABEL}`;
  return (
    <div
      data-plan-add-row=""
      className={cn('flex min-h-[44px] items-center gap-2', !props.empty && '-mb-3 -mt-2')}
    >
      {props.empty ? (
        <p data-plan-day-empty="" className="flex-1 text-[13px] text-fg-3">
          Nothing planned
        </p>
      ) : null}
      <button
        type="button"
        aria-label={label}
        data-plan-add={props.day ?? 'none'}
        onClick={() => props.onAdd(props.day)}
        className="flex h-11 items-center gap-1.5 pr-3 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconPlus size={16} />
        Add
      </button>
    </div>
  );
}

/**
 * A day's left column: 48px wide, 44px tall (the thumbnail's height), the
 * weekday (11px/14px, 600, uppercase, .06em, muted) over the digits
 * (22px/28px, 600, -.01em, tabular), centred as one block with a 2px gap.
 * Today: both in the accent. An empty day's digits are faint. "No date": the
 * words in the weekday style, no digits.
 */
export function DayColumn(props: {
  day: string | null;
  today: string;
  empty: boolean;
}): ReactElement {
  const weekdayClass = 'text-[11px] font-semibold uppercase leading-[14px] tracking-[.06em]';
  if (props.day === null) {
    return (
      <div
        data-plan-day-col=""
        className="flex h-11 w-12 shrink-0 flex-col items-center justify-center gap-0.5 text-center"
      >
        <span data-plan-day-weekday="" className={cn(weekdayClass, 'text-fg-3')}>
          No date
        </span>
      </div>
    );
  }
  const isToday = props.day === props.today;
  return (
    <div
      data-plan-day-col=""
      {...(isToday ? { 'data-plan-today': '' } : {})}
      className="flex h-11 w-12 shrink-0 flex-col items-center justify-center gap-0.5 text-center"
    >
      <span
        data-plan-day-weekday=""
        className={cn(weekdayClass, isToday ? 'text-accent' : 'text-fg-3')}
      >
        {civilWeekdayShort(props.day)}
      </span>
      <span
        data-plan-day-number=""
        className={cn(
          'text-[22px] font-semibold leading-7 tracking-[-.01em] tabular-nums',
          isToday ? 'text-accent' : props.empty ? 'text-border-strong' : 'text-fg',
        )}
      >
        {dayOfMonth(props.day)}
      </span>
    </div>
  );
}

/**
 * The slot checkbox, at a row's right end: a 22px box (radius 6) in a 44x44
 * target, top-aligned with the thumbnail so the box centres on it. Unticked:
 * a 1.5px border-strong outline. Ticked: the client side fills with the
 * success token, the team side with the accent; white tick. Tokens only.
 */
export function SlotCheckbox(props: {
  side: ReviewSide;
  checked: boolean;
  title: string;
  /** Read-only (the agency on an Open plan): shown, disabled, never writes. */
  readOnly?: boolean;
  onToggle: () => void;
}): ReactElement {
  const readOnly = props.readOnly === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={
        readOnly
          ? `${props.checked ? 'Client approved' : 'Client pending'}: ${props.title}`
          : props.checked
            ? `Remove slot approval: ${props.title}`
            : `Approve slot: ${props.title}`
      }
      data-plan-slot={props.side}
      data-plan-slot-state={props.checked ? 'approved' : 'pending'}
      {...(readOnly ? { 'data-plan-slot-readonly': '' } : {})}
      disabled={readOnly}
      onClick={readOnly ? undefined : props.onToggle}
      className="flex h-11 w-11 shrink-0 items-center justify-center self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
    >
      <span
        className={cn(
          'flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-accent-fg',
          props.checked
            ? props.side === 'client'
              ? 'border-[1.5px] border-good bg-good'
              : 'border-[1.5px] border-accent bg-accent'
            : 'border-[1.5px] border-border-strong bg-panel',
        )}
      >
        {props.checked ? <IconCheck size={14} /> : null}
      </span>
    </button>
  );
}

/** A row's meta line: a post's "Carousel · In review", a concept's description. Pure. */
export function rowMeta(bundle: PlanBundle, item: PlanItemRow): string {
  if (item.kind === 'concept') return rowSubline(item);
  if (item.post_id === null) return stageLabel('draft');
  const stage = stageLabel(bundle.postStages[item.post_id]);
  const format = bundle.postInfo[item.post_id]?.format ?? null;
  return format !== null && format !== '' ? `${formatLabel(format)} · ${stage}` : stage;
}

/** The row's 44x44 tile: a post's first image, "Aa" for a text post, a dashed concept outline. */
function RowTile(props: { item: PlanItemRow; thumb: string | null; muted: boolean }): ReactElement {
  if (props.item.kind === 'concept') {
    return (
      <span
        data-plan-row-tile="concept"
        className="h-11 w-11 shrink-0 rounded-lg border-[1.5px] border-dashed border-border-strong"
      />
    );
  }
  if (props.thumb !== null) {
    return (
      <span
        data-plan-row-tile="image"
        className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-panel-2"
      >
        <Thumbnail
          assetVersionId={props.thumb}
          cache={sharedCardPresignCache()}
          presignEnabled={PRESIGN_ENABLED}
          fallback={{ kind: 'glyph' }}
          alt=""
        />
      </span>
    );
  }
  return (
    <span
      data-plan-row-tile="text"
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[15px] font-semibold',
        props.muted ? 'bg-panel-2 text-fg-3' : 'bg-accent-soft text-accent',
      )}
    >
      {props.muted ? '' : 'Aa'}
    </span>
  );
}

/** The Post / Concept tag pill (11px/18px, 650, radius 4, padding 0 6, tinted). */
function KindTag(props: { item: PlanItemRow; label: string }): ReactElement {
  const post = props.item.kind === 'post';
  return (
    <span
      data-plan-row-kind={props.label}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 text-[11px] font-[650] leading-[18px]',
        post ? 'bg-accent-soft text-accent' : 'bg-panel-3 text-fg-2',
      )}
    >
      {post ? 'Post' : 'Concept'}
    </span>
  );
}

const STATUS_TONES: Record<PillTone, string> = {
  good: 'text-good',
  review: 'text-stage-review',
  neutral: 'text-fg-3',
};

function PlanRow(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  thumb: string | null;
  dimmed: boolean;
  /** Visible comments on the item; shown when above zero. */
  comments: number;
  /** The workspace zone (the Approved by time, the date line). */
  timeZone?: string;
  /** An Open plan's client-approved row: the approver's name; null otherwise. */
  approvedByName?: string | null;
  /** Other live plans this post sits in (the Also in pill). */
  alsoIn?: readonly string[];
  onOpen: () => void;
  onToggleSlot: () => void;
  /** Agency only: a long-press lifts the row (no menu any more). */
  onDragStart?: (itemId: string, row: HTMLElement, clientY: number) => void;
}): ReactElement {
  const onDragStart = props.onDragStart;
  const zone = props.timeZone ?? 'UTC';
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointerY = useRef(0);
  const hold = useLongPress(() => {
    if (onDragStart !== undefined && wrapRef.current !== null) {
      onDragStart(props.item.id, wrapRef.current, pointerY.current);
    }
  });
  const kindLabel = itemKindLabel(props.bundle.items, props.item);
  const title = rowTitle(props.bundle, props.item);
  const comments = commentsLabel(props.comments);
  const date = itemDateLabel(props.bundle, props.item, zone);
  const alsoIn = alsoInLabel(props.alsoIn ?? []);
  const by = props.approvedByName != null ? approvedBy(props.bundle, props.item) : null;
  const dateLine = (
    <span
      data-plan-row-date={date.dated ? 'dated' : 'none'}
      className={cn('sr-only', date.dated && 'font-mono')}
    >
      {date.label}
    </span>
  );
  if (draftLocked(props.bundle, props.item, props.side)) {
    // Name only: no checkbox (the right side stays empty), no open, no hover.
    return (
      <div
        role="button"
        aria-disabled="true"
        data-plan-row={props.item.id}
        data-plan-row-draft="locked"
        onContextMenu={(event) => event.preventDefault()}
        className={cn('flex w-full cursor-default items-start gap-3 pr-12', NO_TOUCH_SELECT)}
      >
        <RowTile item={props.item} thumb={null} muted />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-plan-row-title=""
            className="truncate text-[15px] font-semibold leading-5 text-fg-2"
          >
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-fg-3">
            <KindTag item={props.item} label={kindLabel} />
            <span className="truncate">{DRAFT_NOT_READY}</span>
          </span>
          {dateLine}
        </span>
      </div>
    );
  }
  const slot = slotCheckboxShown(props.bundle, props.item, props.side);
  const meta = rowMeta(props.bundle, props.item);
  const status = itemStatusLine(props.bundle, props.item, props.side);
  return (
    <div
      ref={wrapRef}
      data-plan-row-wrap={props.item.id}
      {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
      className={cn('flex w-full items-start gap-1', props.dimmed && 'opacity-25')}
    >
      <button
        type="button"
        data-plan-row={props.item.id}
        {...(onDragStart !== undefined
          ? {
              ...hold.handlers,
              onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
                pointerY.current = event.clientY;
                hold.handlers.onPointerDown(event);
              },
              onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
                pointerY.current = event.clientY;
                hold.handlers.onPointerMove(event);
              },
            }
          : {})}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (hold.consumeClickSuppression()) return;
          props.onOpen();
        }}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          NO_TOUCH_SELECT,
        )}
      >
        <RowTile item={props.item} thumb={props.thumb} muted={false} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-plan-row-title=""
            className="truncate text-[15px] font-semibold leading-5 text-fg"
          >
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-fg-3">
            <KindTag item={props.item} label={kindLabel} />
            {meta !== '' ? (
              <span data-plan-row-meta="" className="truncate">
                {meta}
              </span>
            ) : null}
          </span>
          {status !== null ? (
            <span data-plan-row-status="" className="flex min-w-0 items-center text-xs leading-4">
              <span className={cn('flex shrink-0 items-center gap-1.5', STATUS_TONES[status.tone])}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {status.label}
              </span>
              {comments !== null ? (
                <span data-plan-row-comments="" className="truncate text-fg-3">
                  {` · ${comments}`}
                </span>
              ) : null}
            </span>
          ) : comments !== null ? (
            <span data-plan-row-comments="" className="truncate text-xs leading-4 text-fg-3">
              {comments}
            </span>
          ) : null}
          {alsoIn !== null ? (
            <span
              data-plan-row-also-in=""
              className="inline-flex max-w-full self-start truncate rounded px-1.5 text-[11px] font-semibold leading-[18px] bg-warn-soft text-warn"
            >
              {alsoIn}
            </span>
          ) : null}
          {by !== null && props.approvedByName != null ? (
            <span
              data-plan-row-approved-by=""
              className="flex min-w-0 items-center gap-1 text-xs leading-4 text-good"
            >
              <IconCheck size={12} />
              <span className="truncate">
                {approvedByLine(props.approvedByName, approvedWhen(by.at, new Date(), zone))}
              </span>
            </span>
          ) : null}
          {dateLine}
        </span>
      </button>
      {slot !== null ? (
        <SlotCheckbox
          side={slot.side}
          checked={slotTicked(props.bundle, props.item.id, slot.side)}
          title={title}
          readOnly={!slot.writable}
          onToggle={props.onToggleSlot}
        />
      ) : (
        <span aria-hidden="true" className="h-11 w-11 shrink-0" />
      )}
    </div>
  );
}
