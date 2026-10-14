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
// Swipe to remove (agency, use-row-swipe.ts): a row swiped left shows a red
// Remove; the write waits for the Undo toast. A one-time peek teaches it. A
// plan whose range holds today opens with today's group at the top.
// Laptop (md and up): the screens dock as a full-height panel beside the chat
// (440px from 972px, 360px below; translateX in); agency rows get a grip
// (mouse or touch, 4px lifts), calendar and dustbin buttons, a right-click day
// menu and the keyboard move (plan-keyboard-move.ts); swipe and its peek are
// off. Every day change toasts; Undo only when no tick was reset. Touch keeps
// the long-press drag at every width.
// Motion: drag on translateY and scale only (no scale on a laptop); the page,
// menu and sheets on translateY; plan rows alone also move on translateX (the swipe and its
// peek), and a removed row collapses on height. Tokens only.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { Result } from '@srtdio/rpc';
import {
  chatPlanShare,
  planConceptAdd,
  planDelete,
  planItemMove,
  planItemRemove,
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
  REMOVED_TOAST,
  REMOVE_FAILED,
  RENAMED_TOAST,
  RENAME_FAILED,
  RENAME_LABEL,
  SEND_FAILED,
  SEND_NEEDS_OPEN,
  SLOT_UNDO,
  SLOT_UNDO_MS,
  SWIPE_REMOVE_LABEL,
  SWIPE_TIP_TOAST,
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
import { PlanDayPickerSheet, dayPickerSubline } from '@/components/chat/PlanDayPickerSheet';
import { PlanDayPopover, type PopoverAnchor } from '@/components/chat/PlanDayPopover';
import {
  PlanDropHere,
  PlanDropLine,
  PlanGrip,
  PlanGripSpacer,
  PlanKeyHints,
  PlanRowButtons,
} from '@/components/chat/PlanRowActions';
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
  type DayIndex,
} from '@/lib/chat/plan-drag';
import {
  DROPPED,
  MOVE_CANCELLED,
  PICKED_UP,
  dayMoveToast,
  othersIn,
  previewGroups,
  rowKeyIntent,
  slotAnnouncement,
  stepSlot,
} from '@/lib/chat/plan-keyboard-move';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS, readProfiles, withLateRead } from '@/lib/chat-reads';
import { newMessageId } from '@/lib/chat/message-id';
import { sharePlanToChannel } from '@/lib/chat/share-plan';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import {
  ROW_ACTION_PX,
  createDelayedRemover,
  flushOnLeave,
  openRowOnSettle,
  openRowOnStart,
  rowSwipeEnabled,
  runPlanPeek,
  useRowSwipe,
} from '@/lib/chat/use-row-swipe';
import { fetchMemberRole } from '@/lib/assets';
import { useSession } from '@/lib/session-context';
import {
  PLAN_CHANGED_EVENT,
  dispatchPlanChanged,
  planChangedId,
  conceptAddArgs,
  groupPostsByDay,
  planItemDayInZone,
  skippedOutsideNote,
  splitPickedByRange,
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
import { LAPTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { formatLabel } from '@/lib/post-detail-presentation';
import { logger } from '@/lib/logger';
import { DUR_BASE_MS, DUR_SLOW_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import {
  civilDayOf,
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
 * The laptop panel's width: 440px from 972px, 360px below (768 to 971px), so
 * the chat's channel list stays clear down to 892px. CSS only, so the width is
 * right on the first frame and a resize across 972px changes it with no
 * motion.
 */
export const PLAN_PANEL_WIDTH = 'w-[360px] min-[972px]:w-[440px]';

/**
 * Anything other than a plan panel that owns an Escape pressed on the page
 * itself (focus on body): a dialog or sheet, a menu, an expanded control
 * (the status drawer), chat selection, a drag. Pure over the document.
 */
export const OTHER_ESCAPE_OWNERS =
  '[role="dialog"], [role="menu"], [aria-modal="true"], [aria-expanded="true"], [data-selection-cancel], [data-selecting-text], [data-plan-drag-card]';

/**
 * In-flow viewers inside a panel that close on a window-level Escape (the
 * embedded post's image viewer): the panel hands them the key on window only,
 * so it still never reaches the chat's document listeners.
 */
export const IN_PANEL_ESCAPE_OWNERS = '[aria-label="Image viewer"]';

/** Whether a keydown target is a text field (Escape there leaves the field). Pure. */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return (
    el?.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName ?? '')
  );
}

/**
 * A plan surface. Phone (below md): a full page over the chat that slides up
 * on translateY, header with a 44px back (or close) button. Laptop (md and
 * up): a right-docked panel, full height and at its final width from its
 * first frame (PLAN_PANEL_WIDTH), border-left, a left-edge shadow while it
 * overlays (below 1180px), no scrim, not modal (role complementary), entering
 * on translateX 24px to 0 with opacity (reduced motion: none), a close X in
 * the header. Opening focuses its heading; closing hands focus back to what
 * opened it. Escape: a key inside the panel is the panel's alone (it never
 * reaches the chat): an in-flow viewer inside it first (handed the key on
 * window only), then the screen's own layer (`onEscape`), a text field next
 * (it is left), else Back. On the page itself (focus on body) it closes
 * the topmost panel only when no other surface is open. Both: a scrolling
 * body and an optional footer, rendered into the body so no ancestor clips
 * it; sheets (z-50) stack above it.
 */
export function PlanPage(props: {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  backLabel: string;
  backIcon?: ReactNode;
  onBack: () => void;
  /** Laptop: keep the back button (the Item screen's Back to the list). */
  desktopBack?: boolean;
  /** Laptop: the header X (default: onBack). */
  onDismiss?: () => void;
  /** Laptop: the header X's label. */
  closeLabel?: string;
  /** Laptop: Escape for an inner layer (drag, pick-up, popover, menu, rename); true when taken. */
  onEscape?: () => boolean;
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
  const desktop = useMediaQuery(LAPTOP_QUERY);
  const pageRef = useRef<HTMLDivElement>(null);
  const onEnteredRef = useRef(props.onEntered);
  onEnteredRef.current = props.onEntered;
  const onBackRef = useRef(props.onBack);
  onBackRef.current = props.onBack;
  const onEscapeRef = useRef(props.onEscape);
  onEscapeRef.current = props.onEscape;
  // Laptop Escape. Inside the panel: the panel's alone (stopped at its edge,
  // so no chat handler sees it), unless a modal opened from it holds the key
  // (it has its own handler). On the page (focus on body): the topmost panel,
  // only while nothing else that takes Escape is open.
  useEffect(() => {
    const el = pageRef.current;
    if (!desktop || !props.open || el === null) return;
    const escape = (): void => {
      if (onEscapeRef.current?.() === true) return;
      onBackRef.current();
    };
    const inside = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      if (el.querySelector(IN_PANEL_ESCAPE_OWNERS) !== null) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return;
      }
      if (onEscapeRef.current?.() === true) return;
      if (isTextField(event.target)) {
        (event.target as HTMLElement).blur();
        el.querySelector<HTMLElement>('[data-plan-heading]')?.focus({ preventScroll: true });
        return;
      }
      onBackRef.current();
    };
    const onPage = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.target !== document.body) return;
      const panels = document.querySelectorAll('[data-plan-panel]');
      if (panels[panels.length - 1] !== el) return;
      if (document.querySelector(OTHER_ESCAPE_OWNERS) !== null) return;
      escape();
    };
    el.addEventListener('keydown', inside);
    document.addEventListener('keydown', onPage);
    return () => {
      el.removeEventListener('keydown', inside);
      document.removeEventListener('keydown', onPage);
    };
  }, [desktop, props.open, rendered]);
  // Laptop focus: the heading on open (the chat never scrolls), and back to
  // whatever opened the panel on close, when focus is still in the panel or
  // nowhere, and that element is not inside a panel that is closing too.
  useEffect(() => {
    const el = pageRef.current;
    if (!desktop || !props.open || el === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.querySelector<HTMLElement>('[data-plan-heading]')?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (opener === null || !opener.isConnected) return;
      if (now !== null && now !== document.body && !el.contains(now)) return;
      const host = opener.closest('[data-plan-page]');
      if (host !== null && !host.hasAttribute('data-plan-panel')) return;
      opener.focus({ preventScroll: true });
    };
  }, [desktop, props.open, rendered]);
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
  const showBack = !desktop || props.desktopBack === true;
  return createPortal(
    <div
      ref={pageRef}
      {...(desktop ? { role: 'complementary' } : { role: 'dialog', 'aria-modal': 'true' as const })}
      aria-label={props.title}
      data-plan-page={props.testId}
      {...(desktop ? { 'data-plan-desktop': '' } : {})}
      {...(desktop && props.open ? { 'data-plan-panel': '' } : {})}
      className={cn(
        desktop
          ? // Laptop: the box is final on its first frame; axis: translateX only.
            cn(
              'fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-panel pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] [box-shadow:var(--shadow-panel-left)] transition-[transform,opacity] duration-base motion-reduce:transition-none min-[1180px]:[box-shadow:none]',
              PLAN_PANEL_WIDTH,
            )
          : 'fixed inset-0 z-40 flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] transition-transform duration-slow ease-enter motion-reduce:transition-none',
        desktop
          ? entered
            ? 'translate-x-0 opacity-100 ease-enter'
            : 'translate-x-6 opacity-0 ease-exit'
          : entered
            ? 'translate-y-0'
            : 'translate-y-full',
      )}
    >
      <header
        className={cn(
          'relative z-20 flex min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-panel pr-3',
          showBack ? 'pl-1' : 'pl-4',
        )}
      >
        {showBack ? (
          <button
            type="button"
            aria-label={props.backLabel}
            onClick={props.onBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {props.backIcon ?? <IconChevronLeft size={22} />}
          </button>
        ) : null}
        <div
          data-plan-page-titles=""
          {...(desktop ? { 'data-plan-heading': '', tabIndex: -1 } : {})}
          className="flex min-w-0 flex-1 flex-col rounded-md focus:outline-none"
        >
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
        {desktop ? (
          <button
            type="button"
            aria-label={props.closeLabel ?? 'Close'}
            data-plan-close=""
            onClick={props.onDismiss ?? props.onBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <IconX size={20} />
          </button>
        ) : null}
        {props.overlay}
      </header>
      <div
        ref={props.bodyRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain"
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

/** The bundle without the rows a removal hides (their reviews too). Pure. */
export function withoutItems(bundle: PlanBundle, hidden: ReadonlySet<string>): PlanBundle {
  if (hidden.size === 0) return bundle;
  return {
    ...bundle,
    items: bundle.items.filter((i) => !hidden.has(i.id)),
    reviews: bundle.reviews.filter((r) => !hidden.has(r.item_id)),
  };
}

/**
 * The day the list opens at: today when the plan's range holds it and no item
 * was deep-linked (the link keeps priority); null opens at the top. Pure.
 */
export function todayScrollDay(
  plan: Pick<PlanBundle['plan'], 'starts_on' | 'ends_on'>,
  today: string,
  entryItemId: string | null,
): string | null {
  if (entryItemId !== null) return null;
  return today >= plan.starts_on && today <= plan.ends_on ? today : null;
}

/** The open position is set once per open of a plan: a re-read never re-scrolls. Pure. */
export function needsOpenScroll(scrolledFor: string | null, planId: string): boolean {
  return scrolledFor !== planId;
}

/**
 * Scroll the list so `day`'s group sits at the top, directly under its sticky
 * week header (when the list has weeks). Instant: no smooth scroll.
 */
function scrollDayToTop(body: HTMLElement, day: string): void {
  const block = body.querySelector<HTMLElement>(`[data-plan-day="${day}"]`);
  if (block === null) return;
  const header = block.closest('section')?.querySelector<HTMLElement>('[data-plan-week-header]');
  const sticky = header?.getBoundingClientRect().height ?? 0;
  // Whole pixels: WebKit truncates a fractional scrollTop, which would leave
  // rows on sub-pixel edges.
  body.scrollTop = Math.round(
    body.scrollTop + block.getBoundingClientRect().top - body.getBoundingClientRect().top - sticky,
  );
}

/** The first swipeable row fully in view and not under a sticky header, or null. */
function firstVisibleSwipeRow(body: HTMLElement | null): string | null {
  if (body === null) return null;
  const box = body.getBoundingClientRect();
  for (const el of body.querySelectorAll<HTMLElement>('[data-plan-row-swipe]')) {
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 2);
    if (hit !== null && el.contains(hit)) return el.getAttribute('data-plan-row-swipe');
  }
  return null;
}

/** A set with or without one id (the same set when nothing changes). Pure. */
function withId(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
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
  // Header "+" picks dated outside the plan: one day sheet per post, in turn.
  const [outside, setOutside] = useState<{
    posts: OutsidePost[];
    at: number;
    choices: Array<{ postId: string; day: string }>;
  } | null>(null);
  // "{title} was not added" lines for posts whose day sheet was closed.
  const [skippedNotes, setSkippedNotes] = useState<string[]>([]);
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
  // Swipe to remove (agency): the one open row; rows hidden while their
  // removal waits on Undo, is in flight, or until a re-read drops them; the
  // rows collapsing now; the one-time peek's row and offset.
  const [openSwipe, setOpenSwipe] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsing, setCollapsing] = useState<ReadonlySet<string>>(() => new Set());
  const [peek, setPeek] = useState<{ id: string; offset: number } | null>(null);
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
    setOpenSwipe(null);
    setPeek(null);
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
  // A removed row stays hidden until a read no longer lists it (no flicker).
  useEffect(() => {
    if (shownBundle === null) return;
    setGone((prev) => {
      const kept = [...prev].filter((id) => shownBundle.items.some((i) => i.id === id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [shownBundle]);
  const bundle = useMemo(() => {
    if (shownBundle === null) return null;
    const listed = withoutItems(shownBundle, gone);
    const ticked = slot !== null ? withReviewOverrides(listed, slot, slotOverrides) : listed;
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
  }, [shownBundle, gone, slot, slotOverrides, moveOverlay, timeZone]);
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
  // Laptop (md and up): the docked panel, the grip, row buttons, the day
  // popover and the keyboard move replace swipe and its peek (agency only).
  const desktop = useMediaQuery(LAPTOP_QUERY);
  const deskAgency = desktop && agency;
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
    /** An Undo's move back: no toast of its own. */
    quiet = false,
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
    // plan_item_move takes the full order: any removal lands first.
    await remover.settled();
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
    if (dayChanged && !quiet) {
      // Every day change toasts. Undo (one plan_item_move back to the exact
      // day and index it left) only when nothing was reset: a client's tick
      // cannot be put back by the agency.
      const spec = dayMoveToast(
        dayHeaderOf(toDay),
        bundle.items.find((i) => i.id === moved)?.kind === 'post',
        !keep && hadTicks,
      );
      toast.show({
        title: spec.title,
        ...(spec.undo
          ? {
              durationMs: SLOT_UNDO_MS,
              action: {
                label: SLOT_UNDO,
                onPress: () => void commitMoveRef.current(moved, from.day, from.index, keep, true),
              },
            }
          : {}),
      });
    }
    dispatchPlanChanged(window, planId);
  };
  // The Undo runs later, against the list as it is then.
  const commitMoveRef = useRef(commitMove);
  commitMoveRef.current = commitMove;
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

  // Swipe to remove: the row collapses and hides at once; plan_item_remove
  // goes out when the Undo toast ends, or at once on close, background, a
  // drag, opening an item or another removal. Undo restores the row in place
  // with no request; a failure restores it with the remove error.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const undoToast = useRef<string | null>(null);
  const collapseTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const removePlan = useRef(new Map<string, string>());
  const unhide = useCallback((id: string): void => {
    const timer = collapseTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    collapseTimers.current.delete(id);
    setCollapsing((prev) => withId(prev, id, false));
    setGone((prev) => withId(prev, id, false));
  }, []);
  const [remover] = useState(() =>
    createDelayedRemover({
      delayMs: SLOT_UNDO_MS,
      send: async (id) => {
        const traceId = generateTraceId();
        const result = await planItemRemove(supabase, { p_item_id: id, p_trace_id: traceId });
        if (!result.ok) {
          logger.warn('chat: plan item remove failed', {
            trace_id: traceId,
            item_id: id,
            error: result.error.message,
          });
        }
        return result.ok;
      },
      onSend: () => {
        if (undoToast.current !== null) toastRef.current.dismiss(undoToast.current);
        undoToast.current = null;
      },
      onSent: (id) => {
        const from = removePlan.current.get(id);
        removePlan.current.delete(id);
        if (from !== undefined) dispatchPlanChanged(window, from);
      },
      onFailed: (id) => {
        removePlan.current.delete(id);
        unhide(id);
        toastRef.current.show({ title: REMOVE_FAILED });
      },
    }),
  );
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;
  // What a refocus aims at next render (a CSS selector inside the list).
  const refocus = useRef<string | null>(null);
  const removeRow = (id: string): void => {
    if (!agency || gone.has(id) || collapsing.has(id)) return;
    setOpenSwipe(null);
    remover.schedule(id);
    removePlan.current.set(id, planId);
    if (prefersReducedMotion()) {
      setGone((prev) => withId(prev, id, true));
    } else {
      setCollapsing((prev) => withId(prev, id, true));
      collapseTimers.current.set(
        id,
        setTimeout(() => {
          collapseTimers.current.delete(id);
          setGone((prev) => withId(prev, id, true));
          setCollapsing((prev) => withId(prev, id, false));
        }, DUR_BASE_MS),
      );
    }
    undoToast.current = toast.show({
      title: REMOVED_TOAST,
      durationMs: SLOT_UNDO_MS,
      action: {
        label: SLOT_UNDO,
        onPress: () => {
          if (remover.pending() === id && remover.undo()) {
            removePlan.current.delete(id);
            // Laptop: focus returns to the restored row.
            if (desktopRef.current) refocus.current = `button[data-plan-row="${id}"]`;
            unhide(id);
          }
        },
      },
    });
  };
  // Close, background, unmount: a waiting removal goes out now.
  useEffect(() => {
    if (!props.open) remover.flush();
  }, [props.open, remover]);
  useEffect(() => {
    const timers = collapseTimers.current;
    const stop = flushOnLeave(remover, { doc: document, win: window });
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      stop();
    };
  }, [remover]);
  // A lift or an item screen works on the full plan order: the waiting
  // removal goes out first, and an open row closes.
  const startDrag = (id: string, row: HTMLElement, clientY: number): void => {
    setOpenSwipe(null);
    remover.flush();
    drag.start(id, row, clientY);
  };
  const openItem = (id: string): void => {
    remover.flush();
    setItemId(id);
  };

  // Laptop (agency): the day popover (the calendar button's, or the
  // right-click menu with Remove), the keyboard pick-up and its live region.
  const [popover, setPopover] = useState<{
    itemId: string;
    anchor: PopoverAnchor;
    withRemove: boolean;
  } | null>(null);
  const [pick, setPick] = useState<{ itemId: string; from: DayIndex; at: DayIndex } | null>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (deskAgency) return;
    setPopover(null);
    setPick(null);
  }, [deskAgency]);
  // A pick-up never outlives its row's focus: nothing unsaved stays on screen.
  const cancelPick = useCallback((): void => {
    if (pickRef.current === null) return;
    pickRef.current = null;
    setPick(null);
    setAnnounce(MOVE_CANCELLED);
  }, []);
  const pickedId = pick?.itemId ?? null;
  useEffect(() => {
    if (pickedId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A step re-renders the row and focus is put back before this check runs.
    const onFocusOut = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const now = document.activeElement;
        if (!(now instanceof HTMLElement && now.matches(`button[data-plan-row="${pickedId}"]`))) {
          cancelPick();
        }
      }, 0);
    };
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusout', onFocusOut, true);
      if (timer !== null) clearTimeout(timer);
    };
  }, [pickedId, cancelPick]);
  // The list as shown: a pick-up previews its slot (nothing is written yet).
  const viewGroups = useMemo(
    () => (pick !== null ? previewGroups(groups, pick.itemId, pick.at) : groups),
    [groups, pick],
  );
  // A pick-up step, a removal or an Undo re-renders rows: focus follows.
  useLayoutEffect(() => {
    const target = refocus.current;
    const body = bodyRef.current;
    if (target === null || body === null) return;
    const el = body.querySelector<HTMLElement>(target);
    if (el === null) return;
    refocus.current = null;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  });
  // Laptop removal: focus goes to the next row, the previous one when it was
  // last, or the day's Add when the day is now empty; never to the page.
  const removeWithFocus = (id: string): void => {
    const body = bodyRef.current;
    const rows = rowButtons().filter((el) => el.closest('[data-plan-row-collapsing]') === null);
    const row = body?.querySelector<HTMLElement>(`button[data-plan-row="${id}"]`) ?? null;
    const at = row !== null ? rows.indexOf(row) : -1;
    const day = row?.closest('[data-plan-day]');
    const dayRows = rows.filter((el) => el.closest('[data-plan-day]') === day);
    const add = day?.querySelector<HTMLElement>('[data-plan-add]') ?? null;
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    refocus.current =
      dayRows.length === 1 && add !== null
        ? `[data-plan-day="${day?.getAttribute('data-plan-day') ?? ''}"] [data-plan-add]`
        : next !== null
          ? `button[data-plan-row="${next.getAttribute('data-plan-row') ?? ''}"]`
          : null;
    if (refocus.current === null) {
      body
        ?.closest('[data-plan-page]')
        ?.querySelector<HTMLElement>('[data-plan-heading]')
        ?.focus({ preventScroll: true });
    }
    removeRow(id);
  };
  const dayLabelOf = (day: string | null): string => dayHeaderOf(day) ?? NO_DATE_LABEL;
  const isDroppable = (day: string | null): boolean =>
    day === null || (bundle !== null && day >= bundle.plan.starts_on && day <= bundle.plan.ends_on);
  const moveToDay = (id: string, day: string | null): void => {
    const days = planDayIds(groups);
    const from = findItem(days, id);
    if (from === null || from.day === day) return;
    moveTo(id, day, othersIn(days, id, day));
  };
  const openPopover = (id: string, anchor: PopoverAnchor, withRemove: boolean): void => {
    if (drag.state !== null) return;
    remover.flush();
    setPopover((prev) =>
      prev !== null && prev.itemId === id && !withRemove && !prev.withRemove
        ? null
        : { itemId: id, anchor, withRemove },
    );
  };
  const popoverDays = useMemo(() => {
    if (bundle === null) return [];
    const days = planDayIds(groups);
    return planMoveDays(bundle.plan).map((d) => ({
      ...d,
      count: days.find((g) => g.day === d.day)?.ids.length ?? 0,
    }));
  }, [bundle, groups]);
  const rowButtons = (): HTMLElement[] => [
    ...(bodyRef.current?.querySelectorAll<HTMLElement>('button[data-plan-row]') ?? []),
  ];
  const onRowKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!deskAgency || !(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>('button[data-plan-row]');
    if (row === null || row !== event.target) return;
    const id = row.getAttribute('data-plan-row') ?? '';
    const picking = pick !== null && pick.itemId === id;
    const intent = rowKeyIntent(event.key, picking);
    if (intent === null) return;
    event.preventDefault();
    const days = planDayIds(groups);
    if (intent === 'up' || intent === 'down') {
      const dir = intent === 'up' ? -1 : 1;
      if (pick !== null && picking) {
        const next = stepSlot(days, id, pick.at, dir, isDroppable);
        if (next === null) return;
        refocus.current = `button[data-plan-row="${id}"]`;
        setPick({ ...pick, at: next });
        setAnnounce(slotAnnouncement(dayLabelOf(next.day), next.index));
        return;
      }
      const rows = rowButtons();
      rows[rows.indexOf(row) + dir]?.focus();
      return;
    }
    if (intent === 'pick') {
      // Space on another row while one is up puts that one back first.
      if (pick !== null) {
        cancelPick();
        return;
      }
      const from = findItem(days, id);
      if (from === null || !isDroppable(from.day)) return;
      remover.flush();
      setPopover(null);
      refocus.current = `button[data-plan-row="${id}"]`;
      setPick({ itemId: id, from, at: from });
      setAnnounce(PICKED_UP);
      return;
    }
    if (intent === 'cancel') {
      refocus.current = `button[data-plan-row="${id}"]`;
      cancelPick();
      return;
    }
    if (intent === 'drop' && pick !== null) {
      const to = pick.at;
      refocus.current = `button[data-plan-row="${id}"]`;
      pickRef.current = null;
      setPick(null);
      setAnnounce(DROPPED);
      if (!isNoop(days, id, to)) moveTo(id, to.day, to.index);
      return;
    }
    if (intent === 'remove') {
      cancelPick();
      removeWithFocus(id);
    }
  };
  // Laptop Escape inside the panel: the innermost layer first; true when taken.
  const onPanelEscape = (): boolean => {
    if (drag.state !== null) {
      drag.cancel();
      return true;
    }
    if (pickRef.current !== null) {
      refocus.current = `button[data-plan-row="${pickRef.current.itemId}"]`;
      cancelPick();
      return true;
    }
    if (popover !== null) {
      setPopover(null);
      return true;
    }
    if (menuOpen) {
      setMenuOpen(false);
      return true;
    }
    if (renaming !== null) {
      setRenaming(null);
      return true;
    }
    return false;
  };
  // Space must never also click the row (that opens the item).
  const onRowKeyUp = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (deskAgency && event.key === ' ' && event.target instanceof HTMLElement) {
      if (event.target.matches('button[data-plan-row]')) event.preventDefault();
    }
  };
  // One open row: a tap anywhere outside it or a scroll of the list closes it.
  useEffect(() => {
    if (openSwipe === null) return;
    const body = bodyRef.current;
    const onDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(`[data-plan-row-item="${openSwipe}"]`)) {
        return;
      }
      setOpenSwipe(null);
    };
    const onScroll = (): void => setOpenSwipe(null);
    document.addEventListener('pointerdown', onDown, true);
    body?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      body?.removeEventListener('scroll', onScroll);
    };
  }, [openSwipe]);

  // The one-time peek (agency, a plan with rows): never while a drag, a swipe,
  // a press, a sheet or a menu is active; a press during it ends it.
  const peekBlocked = useRef(false);
  peekBlocked.current =
    drag.state !== null ||
    openSwipe !== null ||
    menuOpen ||
    renaming !== null ||
    addFor !== null ||
    conceptFor !== null ||
    pickFor !== null ||
    outside !== null ||
    deleteOpen ||
    openConfirm ||
    keepAsk !== null ||
    popover !== null ||
    pick !== null ||
    itemId !== null;
  const hasRows = agency && !desktop && bundle !== null && bundle.items.length > 0;
  useEffect(() => {
    if (!props.open || !hasRows) return;
    let pressing = false;
    let showing = false;
    const cancel = runPlanPeek({
      blocked: () => peekBlocked.current || pressing,
      firstRow: () => firstVisibleSwipeRow(bodyRef.current),
      reducedMotion: prefersReducedMotion,
      onOffset: (id, offset) => {
        showing = offset !== null;
        setPeek(offset === null ? null : { id, offset });
      },
      onTip: () => toastRef.current.show({ title: SWIPE_TIP_TOAST }),
    });
    const onDown = (): void => {
      pressing = true;
      if (showing) cancel();
    };
    const onUp = (): void => {
      pressing = false;
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      cancel();
    };
  }, [props.open, hasRows]);

  // Open at today: when the plan's range holds today (workspace zone) and no
  // item was deep-linked, the list's first paint already has today's group at
  // the top (set before paint, never animated). Once per open: a re-read or a
  // later render never re-scrolls.
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!props.open) {
      scrolledFor.current = null;
      return;
    }
    const body = bodyRef.current;
    if (bundle === null || body === null || !needsOpenScroll(scrolledFor.current, planId)) return;
    scrolledFor.current = planId;
    const day = todayScrollDay(bundle.plan, civilToday(new Date(), timeZone), entryItemId);
    if (day !== null) scrollDayToTop(body, day);
  }, [props.open, bundle, planId, timeZone, entryItemId]);

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
  // One plan_posts_add; `day` puts every post on that plan day. False on failure (toasted).
  const addPosts = async (ids: string[], day: string | null): Promise<boolean> => {
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
      return false;
    }
    return true;
  };
  const planRange = {
    startsOn: bundle?.plan.starts_on ?? '',
    endsOn: bundle?.plan.ends_on ?? '',
  };
  const closePicker = async (): Promise<void> => {
    if (pickFor === null) return;
    const day = pickFor.day;
    const posts = picked;
    setPickFor(null);
    setPicked([]);
    setSkippedNotes([]);
    if (posts.length === 0) return;
    if (day !== null) {
      // A day's Add row: every post goes on that day.
      if (
        !(await addPosts(
          posts.map((p) => p.id),
          day,
        ))
      )
        return;
      toast.show({ title: addedToast('post', dayHeaderOf(day)) });
      dispatchPlanChanged(window, planId);
      return;
    }
    // Header "+": a post dated outside the plan never goes without a day.
    const split = splitPickedByRange(
      posts as Array<PostCardFields & { target_date?: string | null }>,
      planRange,
      timeZone,
    );
    if (split.outside.length > 0) {
      setOutside({
        posts: split.outside.map((p) => ({
          id: p.id,
          title: p.title,
          orig: civilDayOf(p.target_date ?? null, timeZone),
        })),
        at: 0,
        choices: [],
      });
    }
    if (split.now.length === 0) return;
    if (!(await addPosts(split.now, null))) return;
    toast.show({ title: addedToast('post', null) });
    dispatchPlanChanged(window, planId);
  };
  // The outside posts' day sheet: a pick or a close moves to the next post;
  // after the last, one plan_posts_add per chosen day.
  const outsideNext = (choice: string | null): void => {
    if (outside === null) return;
    const post = outside.posts[outside.at];
    if (post === undefined) return;
    const choices =
      choice !== null ? [...outside.choices, { postId: post.id, day: choice }] : outside.choices;
    if (choice === null) setSkippedNotes((prev) => [...prev, skippedOutsideNote(post.title)]);
    if (outside.at + 1 < outside.posts.length) {
      setOutside({ ...outside, at: outside.at + 1, choices });
      return;
    }
    setOutside(null);
    void addOnDays(choices);
  };
  const addOnDays = async (choices: Array<{ postId: string; day: string }>): Promise<void> => {
    const groups = groupPostsByDay(choices);
    let added = 0;
    for (const group of groups) {
      if (!(await addPosts(group.postIds, group.day))) break;
      added += 1;
    }
    if (added === 0) return;
    const only = groups.length === 1 ? groups[0] : undefined;
    toast.show({ title: addedToast('post', only !== undefined ? dayHeaderOf(only.day) : null) });
    dispatchPlanChanged(window, planId);
  };
  const outsidePost = outside?.posts[outside.at] ?? null;
  const lastOutside = useRef<OutsidePost | null>(null);
  if (outsidePost !== null) lastOutside.current = outsidePost;
  const shownOutside = outsidePost ?? lastOutside.current;
  const inPlan = useMemo(
    () => new Set((bundle?.items ?? []).flatMap((i) => (i.post_id !== null ? [i.post_id] : []))),
    [bundle],
  );

  const found = bundle?.items.find((i) => i.id === itemId) ?? null;
  // A draft the viewer can see by name only never opens (a drawer row included).
  const item =
    found !== null && bundle !== null && !draftLocked(bundle, found, side) ? found : null;
  const showOpen = side === 'agency' && bundle !== null && bundle.plan.audience === 'team';
  const actions =
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
    ) : null;
  // Laptop (agency): the slim hint line sits under the footer's actions.
  const footer =
    deskAgency || actions !== null ? (
      <div className="flex flex-col gap-2">
        {actions}
        {deskAgency ? <PlanKeyHints /> : null}
      </div>
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
        closeLabel="Close plan"
        onEscape={onPanelEscape}
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
        {skippedNotes.length > 0 ? (
          <div
            role="status"
            data-plan-skipped-notes=""
            className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-warn-soft py-1 pl-3 pr-1 text-[13px] leading-[18px] text-warn"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
              {skippedNotes.map((note, at) => (
                <p key={at}>{note}</p>
              ))}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setSkippedNotes([])}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <IconX size={16} />
            </button>
          </div>
        ) : null}
        {deskAgency ? (
          <p role="status" aria-live="polite" data-plan-live="" className="sr-only">
            {announce}
          </p>
        ) : null}
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
            groups={viewGroups}
            side={side}
            timeZone={timeZone}
            thumbs={read.status === 'ready' ? read.data.thumbs : {}}
            counts={read.status === 'ready' ? read.data.commentCounts : {}}
            names={names}
            alsoIn={read.status === 'ready' ? (read.data.alsoIn ?? {}) : {}}
            drag={drag.state}
            onOpenItem={openItem}
            onToggleSlot={toggleSlot}
            {...(deskAgency
              ? {
                  onAdd: openAdd,
                  onDragStart: startDrag,
                  desk: {
                    collapsing,
                    pickedId: pick?.itemId ?? null,
                    popoverId: popover !== null && !popover.withRemove ? popover.itemId : null,
                    dragging: drag.state !== null,
                    onCalendar: (id: string, el: HTMLElement) =>
                      openPopover(id, { el, point: null }, false),
                    onMenu: (id: string, row: HTMLElement, x: number, y: number) => {
                      const r = row.getBoundingClientRect();
                      openPopover(id, { el: row, point: { dx: x - r.left, dy: y - r.top } }, true);
                    },
                    onRemove: removeWithFocus,
                    onKeyDown: onRowKey,
                    onKeyUp: onRowKeyUp,
                  },
                }
              : agency
                ? {
                    onAdd: openAdd,
                    onDragStart: startDrag,
                    swipe: {
                      openId: openSwipe,
                      collapsing,
                      peek,
                      dragging: drag.state !== null,
                      onStart: (id: string) => setOpenSwipe((prev) => openRowOnStart(prev, id)),
                      onSettle: (id: string, open: boolean) =>
                        setOpenSwipe((prev) => openRowOnSettle(prev, id, open)),
                      onRemove: removeRow,
                    },
                  }
                : {})}
          />
        )}
      </PlanPage>
      {deskAgency && popover !== null && props.open ? (
        <PlanDayPopover
          anchor={popover.anchor}
          bounds={bodyRef.current}
          days={popoverDays}
          current={findItem(planDayIds(groups), popover.itemId)?.day ?? null}
          withRemove={popover.withRemove}
          onPick={(day) => {
            const id = popover.itemId;
            setPopover(null);
            refocus.current = `button[data-plan-row="${id}"]`;
            moveToDay(id, day);
          }}
          onRemove={() => {
            const id = popover.itemId;
            setPopover(null);
            removeWithFocus(id);
          }}
          onClose={() => setPopover(null)}
        />
      ) : null}
      {drag.state !== null && bundle !== null ? (
        <DragCard
          bundle={bundle}
          state={drag.state}
          desktop={desktop}
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
          onDismiss={props.onClose}
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
            {...(bundle !== null
              ? { range: planRange, today: civilToday(new Date(), timeZone) }
              : {})}
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
          <PlanDayPickerSheet
            open={props.open && outsidePost !== null}
            title={shownOutside?.title ?? ''}
            subline={
              shownOutside !== null
                ? dayPickerSubline({ kind: 'post', orig: shownOutside.orig }, planRange)
                : ''
            }
            range={planRange}
            selected={null}
            today={civilToday(new Date(), timeZone)}
            pipelineDay={shownOutside?.orig ?? null}
            hideNoDate
            onPick={(day) => {
              if (day !== 'none') outsideNext(day);
            }}
            onClose={() => outsideNext(null)}
          />
        </>
      ) : null}
    </>
  );
}

/** A header "+" pick dated outside the plan, waiting for a day. */
interface OutsidePost {
  id: string;
  title: string;
  orig: string | null;
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
  /** Escape: puts the row back while the pointer is down; once released the drop commits. */
  cancel: () => void;
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
      if (event.key === 'Escape' && stateRef.current?.snapTop === null) cancel();
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

  const cancel = (): void => {
    if (stateRef.current !== null && stateRef.current.snapTop === null) end();
  };
  return { state, start, cancel };
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
  /** Laptop: no lift scale (translateY only) and a grabbing cursor on the whole page. */
  desktop?: boolean;
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
        NO_TOUCH_SELECT,
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
      {props.desktop === true ? <style>{'*{cursor:grabbing !important}'}</style> : null}
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border border-border bg-panel p-2 shadow-lg transition-transform ease-enter motion-reduce:scale-100 motion-reduce:transition-none',
          lifted && props.desktop !== true ? 'scale-[1.02]' : 'scale-100',
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

/** The agency's swipe to remove, handed down to each row. */
export interface PlanRowSwipe {
  /** The one open row, or null. */
  openId: string | null;
  /** Rows collapsing out after Remove. */
  collapsing: ReadonlySet<string>;
  /** The one-time peek's row and offset (px), or null. */
  peek: { id: string; offset: number } | null;
  /** A drag is running: no swipe starts. */
  dragging: boolean;
  /** A swipe locked in on this row (any other open row closes). */
  onStart: (id: string) => void;
  /** The row came to rest open or closed. */
  onSettle: (id: string, open: boolean) => void;
  onRemove: (id: string) => void;
}

/** The laptop row controls (md and up, agency), handed down to each row. */
export interface PlanRowDesk {
  /** Rows collapsing out after Remove. */
  collapsing: ReadonlySet<string>;
  /** The row the keyboard has picked up, or null. */
  pickedId: string | null;
  /** The row whose calendar popover is open, or null. */
  popoverId: string | null;
  /** A drag is running: no menu opens. */
  dragging: boolean;
  onCalendar: (id: string, anchor: HTMLElement) => void;
  /** Right-click: the day popover with Remove, at the pointer (kept on the row). */
  onMenu: (id: string, row: HTMLElement, x: number, y: number) => void;
  onRemove: (id: string) => void;
  /** The list's key handlers (rows are the targets). */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => void;
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
  /** Agency only: swipe left to remove. */
  swipe?: PlanRowSwipe;
  /** Agency on a laptop: grip, row buttons, right-click, keyboard (no swipe). */
  desk?: PlanRowDesk;
}): ReactElement {
  const { bundle, side, drag, desk } = props;
  const weeks = planShowsWeeks(bundle.plan.starts_on, bundle.plan.ends_on);
  const today = civilToday(new Date(), props.timeZone);
  const dragFrom = drag !== null ? (findItem(planDayIds(props.groups), drag.itemId) ?? null) : null;
  return (
    <>
      <PlanProgressRow bundle={bundle} />
      <div
        data-plan-list={weeks ? 'weeks' : 'days'}
        className="flex flex-col pb-4 pt-3"
        {...(desk !== undefined ? { onKeyDown: desk.onKeyDown, onKeyUp: desk.onKeyUp } : {})}
      >
        {props.groups.map((week, w) => (
          <section
            key={week.label ?? `days-${w}`}
            {...(week.label !== null ? { 'data-plan-week': week.label } : {})}
            className="flex flex-col"
          >
            {week.label !== null ? (
              <h3
                data-plan-week-header=""
                className="sticky top-0 z-10 border-b border-border bg-bg px-4 py-2 text-[13px] font-semibold text-fg-2 md:bg-panel"
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
                    hovered && desk === undefined && 'shadow-[inset_3px_0_0_var(--accent)]',
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
                          {slotHere ? (
                            desk !== undefined ? (
                              <PlanDropLine />
                            ) : (
                              <DropSlot day={day.day} />
                            )
                          ) : null}
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
                            {...(props.swipe !== undefined ? { swipe: props.swipe } : {})}
                            {...(desk !== undefined ? { desk } : {})}
                          />
                        </Fragment>
                      );
                    })}
                    {slotAt !== null &&
                    slotAt >= others.length &&
                    !(desk !== undefined && empty) ? (
                      desk !== undefined ? (
                        <PlanDropLine />
                      ) : (
                        <DropSlot day={day.day} />
                      )
                    ) : null}
                    {desk !== undefined && droppable && empty ? (
                      <PlanDropHere over={hovered} />
                    ) : props.onAdd !== undefined && (day.day === null || day.inRange) ? (
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
  /** Agency only: swipe left to remove. */
  swipe?: PlanRowSwipe;
  /** Agency on a laptop: grip, calendar and dustbin, right-click (no swipe). */
  desk?: PlanRowDesk;
}): ReactElement {
  const onDragStart = props.onDragStart;
  const desk = props.desk;
  const zone = props.timeZone ?? 'UTC';
  const id = props.item.id;
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointerY = useRef(0);
  const lastPointer = useRef('');
  const hold = useLongPress(() => {
    // A lift ends any swipe of this press.
    rowSwipe.cancel();
    if (onDragStart !== undefined && wrapRef.current !== null) {
      onDragStart(id, wrapRef.current, pointerY.current);
    }
  });
  // Swipe left (agency): the row content moves on translateX only, 1:1 with
  // the finger while dragging, then eases to rest open (-88px) or closed.
  const swipe =
    props.swipe !== undefined &&
    rowSwipeEnabled(props.side, draftLocked(props.bundle, props.item, props.side))
      ? props.swipe
      : undefined;
  const open = swipe?.openId === id;
  const [dragX, setDragX] = useState<number | null>(null);
  const rowSwipe = useRowSwipe({
    isOpen: () => open,
    enabled: () => swipe !== undefined && !swipe.dragging,
    onStart: (pointerId) => {
      hold.cancel();
      window.getSelection()?.removeAllRanges();
      swipe?.onStart(id);
      if (pointerId === undefined) return;
      try {
        wrapRef.current?.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone; the release settles the row.
      }
    },
    onDrag: setDragX,
    onSettle: (next) => {
      setDragX(null);
      swipe?.onSettle(id, next);
    },
  });
  const peekOffset = swipe?.peek?.id === id ? swipe.peek.offset : null;
  const offset = dragX ?? (open ? -ROW_ACTION_PX : (peekOffset ?? 0));
  const collapsing = swipe?.collapsing.has(id) === true;
  // The red action shows only while the row is off rest, until it has eased
  // back home; the row always clips, so it never shows past the row's edge.
  const [shownOffset, setShownOffset] = useState(offset);
  const [settling, setSettling] = useState(false);
  if (shownOffset !== offset) {
    setShownOffset(offset);
    setSettling(offset === 0 && dragX === null && !prefersReducedMotion());
  }
  const actionShown = offset !== 0 || settling || collapsing;
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
  const picked = desk?.pickedId === id;
  const meta = rowMeta(props.bundle, props.item);
  const status = itemStatusLine(props.bundle, props.item, props.side);
  const rowButton = (
    <button
      type="button"
      data-plan-row={props.item.id}
      {...(onDragStart !== undefined
        ? {
            ...hold.handlers,
            onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
              pointerY.current = event.clientY;
              // Laptop: a mouse lifts by the grip only; touch keeps the long-press.
              if (desk !== undefined && event.pointerType === 'mouse') return;
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
      {...(picked ? { 'data-plan-row-picked': '' } : {})}
      className={cn(
        'flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        picked && 'ring-2 ring-accent ring-offset-2 ring-offset-panel',
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
  );
  const slotBox =
    slot !== null ? (
      <SlotCheckbox
        side={slot.side}
        checked={slotTicked(props.bundle, props.item.id, slot.side)}
        title={title}
        readOnly={!slot.writable}
        onToggle={props.onToggleSlot}
      />
    ) : (
      <span aria-hidden="true" className="h-11 w-11 shrink-0" />
    );
  const row = (
    <>
      {rowButton}
      {slotBox}
    </>
  );
  if (desk !== undefined) {
    // Laptop: grip, the row, calendar and dustbin, then the tick. A removed
    // row folds on height (Y only); it clips only while folding, so the focus
    // ring shows.
    const folding = desk.collapsing.has(id);
    return (
      <div
        data-plan-row-item={id}
        {...(folding ? { 'data-plan-row-collapsing': '', 'aria-hidden': true } : {})}
        className={cn(
          'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,margin] duration-base ease-exit motion-reduce:transition-none',
          folding ? '-mb-4 grid-rows-[0fr] last:mb-0' : 'grid-rows-[1fr]',
        )}
      >
        <div className={cn('min-h-0 min-w-0', folding && 'overflow-hidden')}>
          <div
            ref={wrapRef}
            data-plan-row-wrap={id}
            {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
            onPointerDownCapture={(event) => {
              lastPointer.current = event.pointerType;
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              // A touch long-press lifts the row; it never opens the menu.
              const native = event.nativeEvent as Partial<PointerEvent>;
              if (native.pointerType === 'touch' || lastPointer.current === 'touch') return;
              if (desk.dragging || wrapRef.current === null) return;
              desk.onMenu(id, wrapRef.current, event.clientX, event.clientY);
            }}
            className={cn(
              'group flex w-full min-w-0 items-start gap-1',
              props.dimmed && 'opacity-25',
              NO_TOUCH_SELECT,
            )}
          >
            {onDragStart !== undefined ? (
              <PlanGrip
                onLift={(clientY) => {
                  hold.cancel();
                  if (wrapRef.current !== null) onDragStart(id, wrapRef.current, clientY);
                }}
              />
            ) : (
              <PlanGripSpacer />
            )}
            {rowButton}
            <PlanRowButtons
              title={title}
              calendarOpen={desk.popoverId === id}
              onCalendar={(anchor) => desk.onCalendar(id, anchor)}
              onRemove={() => desk.onRemove(id)}
            />
            {slotBox}
          </div>
        </div>
      </div>
    );
  }
  if (swipe === undefined) {
    return (
      <div
        ref={wrapRef}
        data-plan-row-wrap={id}
        {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
        className={cn('flex w-full min-w-0 items-start gap-1', props.dimmed && 'opacity-25')}
      >
        {row}
      </div>
    );
  }
  // Collapse after Remove: the row's height eases to 0 (and the list gap with
  // it), Y only; the red action sits behind the content, full row height.
  // The single track is minmax(0, 1fr) and every wrapper is min-w-0, so a long
  // title truncates inside the column instead of widening the row (and the page).
  return (
    <div
      data-plan-row-item={id}
      {...(collapsing ? { 'data-plan-row-collapsing': '', 'aria-hidden': true } : {})}
      className={cn(
        'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,margin] duration-base ease-exit motion-reduce:transition-none',
        collapsing ? '-mb-4 grid-rows-[0fr] last:mb-0' : 'grid-rows-[1fr]',
      )}
    >
      <div className="relative min-h-0 min-w-0 overflow-hidden">
        <button
          type="button"
          data-plan-row-remove={id}
          aria-label={`${SWIPE_REMOVE_LABEL}: ${title}`}
          aria-hidden={!open}
          tabIndex={open ? 0 : -1}
          onClick={() => swipe.onRemove(id)}
          className={cn(
            'absolute inset-y-0 right-0 flex min-h-[44px] w-[88px] flex-col items-center justify-center gap-0.5 rounded-lg bg-bad text-[13px] font-semibold text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            !open && 'pointer-events-none',
            !actionShown && 'invisible',
            NO_TOUCH_SELECT,
          )}
        >
          <IconTrash size={18} />
          {SWIPE_REMOVE_LABEL}
        </button>
        <div
          ref={wrapRef}
          data-plan-row-wrap={id}
          data-plan-row-swipe={id}
          {...(open ? { 'data-plan-row-open': '' } : {})}
          {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
          {...rowSwipe.handlers}
          onClickCapture={(event) => {
            // The click that trails a swipe does nothing; a tap on an open
            // row closes it (and opens nothing).
            const swiped = rowSwipe.consumeClickSuppression();
            if (!swiped && !open) return;
            event.preventDefault();
            event.stopPropagation();
            if (!swiped) swipe.onSettle(id, false);
          }}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) setSettling(false);
          }}
          className={cn(
            'relative flex w-full min-w-0 touch-pan-y items-start gap-1 bg-bg',
            dragX === null &&
              'transition-transform duration-slow ease-exit motion-reduce:transition-none',
            props.dimmed && 'opacity-25',
            NO_TOUCH_SELECT,
          )}
          style={{ transform: `translateX(${offset}px)` }}
        >
          {row}
        </div>
      </div>
    </div>
  );
}
