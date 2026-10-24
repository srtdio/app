// The Plan screen (full page over the chat, one history step): the plan's
// title, "{range} · Draft" or "{range} · Shared with approvers", progress, and
// one list grouped by each item's plan day (a post slot's day is its post's
// posts.target_date in the workspace zone, a concept's plan_items.target_date)
// for every day of the range ("Nothing planned" on an empty day, "No date"
// last; a plan longer than a week adds a sticky "Week of" header per week).
//
// View mode (the default, everyone): each day shows one calendar date tile
// (56x56) beside its first row; a row is the title block (title, format line,
// "Also in") with the thumbnail (56x56) on the right, then two lines: PLAN
// (the viewer's check of the slot) and POST (the post's stage). PLAN is the
// OK | Not OK switch while undecided and a solid pill once decided (tap to
// change). OK is optimistic behind a 4s Undo strip
// (useUndoableAction; the write goes when the toast ends, never after Undo);
// Not OK opens the Item screen with the note box open. One view: a Draft plan
// shows the team side (agency only, writable), an Open plan the client side
// (a client writes, the agency reads it as text). No drag, no swipe, no grip,
// no row dustbin. Tapping a row opens the Item screen. The
// agency side also gets the title menu (Rename, Delete plan), Add under each
// day and "+" in the header (instant, their sheets have their own Save), the
// header's "Edit" button, and the footer's one primary button: from a chat
// "Send to approvers in {chat}" on a Draft plan (plan_share_with_client, then
// chat_plan_share; a failed second step offers Retry that only reposts) or
// "Send in {chat}" on an Open plan; outside a chat "Open for approvers" on a
// Draft plan, nothing on an Open one. A send from a chat reads "Sending in
// {chat}…" (disabled); a done "Send in {chat}" reads "Sent" (soft, disabled)
// until a change here, and on reopening while the chat's last send of this
// plan (read with the screen) is newer than the plan's last change.
//
// Edit mode (agency, "Edit"): the header becomes Cancel / "Editing plan" /
// "Save changes"; the title and From/To dates are fields at the top; each row
// is grip | date tile | title block | thumbnail with PLAN and POST as text,
// and a bottom line with the day chip (the day picker) left and the remove
// icon right (touch or mouse drag on the grip; the laptop keyboard move too);
// the footer is hidden. Every change
// paints at once but is only queued (plan-drag.ts: applyPlanOps); nothing is
// written until Save changes, which sends the queue in one plan_save call
// (all or nothing). Moving an Open plan's client-approved slot still asks
// "Keep the approval?" at the move and records keep_reviews in that op. Save:
// toast "Plan saved", view mode, re-read; a failure keeps edit mode and the
// queue with an inline error and Retry; while saving the screen cannot close.
// Cancel, the screen's own back, Esc and system/browser Back with queued
// changes ask "Discard changes?" (ConfirmDialog; useBackGuard holds the Back).
// One read per table per open (plans.ts), bounded at 5s; nothing paints until
// that read settles. This file also holds the page frame (phone: a modal
// dialog whose focus moves in and returns on close), the bounded read hook
// and the confirm sheet the other plan screens share.
// Laptop (md and up): the screens dock as a full-height panel beside the chat
// (440px from 972px, 360px below; translateX in); edit mode adds a right-click
// day menu and the keyboard move (plan-keyboard-move.ts).
// Motion: drag on translateY and scale only (no scale on a laptop); the page,
// menu and sheets on translateY. Tokens only.

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
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { glowTarget, Highlight } from '@/components/ui/SearchHighlight';
import { createPortal } from 'react-dom';
import type { PlanSaveOp, Result } from '@srtdio/rpc';
import {
  chatPlanShare,
  planConceptAdd,
  planDelete,
  planItemReview,
  planPostsAdd,
  planSave,
  planShareWithClient,
  planUpdate,
} from '@srtdio/rpc';
import type { PostCardFields } from '@srtdio/posts';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import {
  ICON_SIZE,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconEdit,
  IconFile,
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
  CANCEL_EDIT_LABEL,
  DELETE_PLAN_LABEL,
  DELETE_PLAN_TITLE,
  DISCARD_EDITS,
  DISCARD_LABEL,
  DRAFT_NOT_READY,
  DRAFT_PROBLEM_COPY,
  EDITING_TITLE,
  EDIT_FROM_LABEL,
  EDIT_LABEL,
  EDIT_TITLE_LABEL,
  EDIT_TO_LABEL,
  KEEP_EDITING_LABEL,
  NO_DATE_LABEL,
  OPEN_FOR_CLIENT_BODY,
  OPEN_FOR_CLIENT_FAILED,
  OPEN_FOR_CLIENT_LABEL,
  OPEN_FOR_CLIENT_TITLE,
  OPEN_FOR_CLIENT_TOAST,
  PLAN_DELETED_TOAST,
  PLAN_NOT_AVAILABLE,
  PLAN_SAVED_TOAST,
  PLAN_TITLE_MAX,
  RENAMED_TOAST,
  RENAME_FAILED,
  RENAME_LABEL,
  RETRY_LABEL,
  SAVE_CHANGES_LABEL,
  SAVING_LABEL,
  SEND_AFTER_OPEN_FAILED,
  SEND_FAILED,
  SEND_NEEDS_OPEN,
  addedToast,
  alsoInLabel,
  approvedBy,
  approverIds,
  canDeletePlan,
  countPercent,
  dayHeaderOf,
  deletePlanBody,
  deletePlanErrorCopy,
  draftLocked,
  draftProblem,
  itemDateLabel,
  keepApprovalBody,
  keepApprovalTitle,
  moveAsksKeep,
  planControl,
  planControlState,
  planControlText,
  planCountLabel,
  planHeaderCounts,
  planHeaderSubtitle,
  planFooterLabel,
  planPrimaryAction,
  planSendButtonState,
  planProgressView,
  planSaveErrorCopy,
  planWriteErrorCopy,
  renameTitle,
  reviewStatus,
  PLAN_LINE_LABEL,
  PLAN_NOT_OK_LABEL,
  PLAN_OK_LABEL,
  POST_LINE_LABEL,
  postLine,
  slotApprovedToast,
  slotErrorCopy,
  slotSide,
  withReviewOverrides,
  type PostLineTone,
  type PrimaryAction,
  type SendButtonState,
  type StatusPill,
} from '@/components/chat/plan-card';
import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { PlanAddSheet } from '@/components/chat/PlanAddSheet';
import { PlanKeepApprovalSheet, type MoveDay } from '@/components/chat/PlanMoveSheet';
import {
  ConceptSheet,
  EMPTY_CONCEPT,
  FIELD,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import {
  DATE_FIELD,
  PlanDayPickerSheet,
  dayPickerSubline,
} from '@/components/chat/PlanDayPickerSheet';
import { PlanDayPopover, type PopoverAnchor } from '@/components/chat/PlanDayPopover';
import {
  PlanDropHere,
  PlanDropLine,
  PlanGrip,
  PlanGripSpacer,
  PlanKeyHints,
  PlanRowEditButtons,
} from '@/components/chat/PlanRowActions';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import {
  applyPlanOps,
  dropIndex,
  findItem,
  flattenOrder,
  hasQueuedOps,
  headerDraftOf,
  isNoop,
  moveItem,
  queueOp,
  withHeaderUpdate,
  type DayIds,
  type DayIndex,
  type PlanHeaderDraft,
} from '@/lib/chat/plan-drag';
import {
  DROPPED,
  MOVE_CANCELLED,
  PICKED_UP,
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
import { fetchMemberRole } from '@/lib/assets';
import { useBackGuard } from '@/lib/back-guard';
import { useModalFocus } from '@/lib/modal-focus';
import { useSession } from '@/lib/session-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
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
  type ConceptThumb,
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
import { DUR_SLOW_MS } from '@/lib/motion';
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
 * on translateY, header with a 44px back (or close) button; a modal dialog
 * (role dialog, aria-modal) whose focus moves in on open and returns to the
 * opener on close (useModalFocus). Laptop (md and up): a right-docked panel,
 * full height and at its final width from its first frame (PLAN_PANEL_WIDTH),
 * border-left, a left-edge shadow while it overlays (below 1180px), no scrim,
 * not modal (role complementary), entering on translateX 24px to 0 with
 * opacity (reduced motion: none), a close X in the header. Opening focuses its
 * heading; closing hands focus back to what opened it. Escape: a key inside
 * the panel is the panel's alone (it never reaches the chat): an in-flow
 * viewer inside it first (handed the key on window only), then the screen's
 * own layer (`onEscape`), a text field next (it is left), else Back. On the
 * page itself (focus on body) it closes the topmost panel only when no other
 * surface is open. Both: a scrolling body and an optional footer, rendered
 * into the body so no ancestor clips it; sheets (z-50) stack above it.
 */
export function PlanPage(props: {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  backLabel: string;
  backIcon?: ReactNode;
  /** A text back button ("Cancel") instead of the icon, 44px tall. */
  backText?: string;
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
  /**
   * The Plan screen's view header: line 1 the back button and a 28px title,
   * line 2 the subtitle with these actions (Add, Edit) on the right.
   */
  twoLine?: { actions?: ReactNode };
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
  // Phone: a modal layer. Focus moves in on open (never a text field on a
  // touch device), Tab stays inside, and the opener gets it back on close.
  useModalFocus(pageRef, !desktop && props.open && rendered);
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
  const backButton = showBack ? (
    props.backText !== undefined ? (
      <Button
        type="button"
        variant="ghost"
        aria-label={props.backLabel}
        data-plan-back-text=""
        onClick={props.onBack}
        className="-ml-2 shrink-0 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {props.backText}
      </Button>
    ) : (
      <IconButton
        type="button"
        label={props.backLabel}
        onClick={props.onBack}
        className="-ml-[11px] shrink-0 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {props.backIcon ?? <IconChevronLeft size={ICON_SIZE.control} />}
      </IconButton>
    )
  ) : null;
  const closeButton = desktop ? (
    <IconButton
      type="button"
      label={props.closeLabel ?? 'Close'}
      data-plan-close=""
      onClick={props.onDismiss ?? props.onBack}
      className="-mr-3 shrink-0 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <IconX size={ICON_SIZE.control} />
    </IconButton>
  ) : null;
  return createPortal(
    <div
      ref={pageRef}
      {...(desktop ? { role: 'complementary' } : { role: 'dialog', 'aria-modal': 'true' as const })}
      aria-label={props.title}
      tabIndex={-1}
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
        'focus:outline-none',
        desktop
          ? entered
            ? 'translate-x-0 opacity-100 ease-enter'
            : 'translate-x-6 opacity-0 ease-exit'
          : entered
            ? 'translate-y-0'
            : 'translate-y-full',
      )}
    >
      {props.twoLine !== undefined ? (
        // Line 1 (48px): back, the 28px title (2 lines at most). Line 2 (44px,
        // 2px below): the subtitle, then the actions on the 16px edge. Line 2
        // is always drawn so the header never grows after the plan loads.
        <header
          data-plan-header-two-line=""
          className="relative z-20 flex shrink-0 flex-col gap-[2px] border-b border-border bg-panel px-4"
        >
          <div data-plan-header-line="1" className="flex min-h-[48px] items-center gap-2">
            {backButton}
            <div
              data-plan-page-titles=""
              {...(desktop ? { 'data-plan-heading': '', tabIndex: -1 } : {})}
              className="flex min-w-0 flex-1 flex-col rounded-md focus:outline-none"
            >
              {props.titleSlot ?? (
                <h2 className={PLAN_HEADER_TITLE}>
                  <Highlight text={props.title} />
                </h2>
              )}
            </div>
            {closeButton}
          </div>
          <div data-plan-header-line="2" className="flex min-h-[44px] items-center gap-2">
            <span
              {...(props.subtitle !== undefined ? { 'data-plan-page-subtitle': '' } : {})}
              className="min-w-0 flex-1 truncate text-sm text-fg-3"
            >
              {props.subtitle}
            </span>
            {props.twoLine.actions}
          </div>
          {props.overlay}
        </header>
      ) : (
        <header
          className={cn(
            // 16px on both sides: the back glyph and the last text action sit on the lines.
            'relative z-20 flex min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-panel pl-4 pr-4',
          )}
        >
          {backButton}
          <div
            data-plan-page-titles=""
            {...(desktop ? { 'data-plan-heading': '', tabIndex: -1 } : {})}
            className="flex min-w-0 flex-1 flex-col rounded-md focus:outline-none"
          >
            {props.titleSlot ?? (
              <h2 className="truncate text-lg font-semibold text-fg">
                <Highlight text={props.title} />
              </h2>
            )}
            {props.subtitle !== undefined ? (
              <span data-plan-page-subtitle="" className="truncate text-sm text-fg-3">
                {props.subtitle}
              </span>
            ) : null}
          </div>
          {props.action}
          {closeButton}
          {props.overlay}
        </header>
      )}
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
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy === true}>
            Cancel
          </Button>
          <Button
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
      <p className="text-lg text-fg-2">{props.message}</p>
      {props.error !== undefined && props.error !== null ? (
        <p role="alert" className="mt-2 text-base text-bad">
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
      <span className="text-md text-fg-3">Date (optional)</span>
      <span className="flex items-center gap-1.5">
        <input
          type="date"
          data-plan-concept-date=""
          value={props.value}
          disabled={props.disabled === true}
          onChange={(e) => props.onChange(e.target.value)}
          className="h-11 min-h-[44px] w-full min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-3.5 font-mono text-input text-fg placeholder:text-fg-3 md:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        />
        {props.value !== '' ? (
          <IconButton
            type="button"
            label="Clear date"
            data-plan-concept-date-clear=""
            disabled={props.disabled === true}
            onClick={() => props.onChange('')}
            className="shrink-0 text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            <IconX size={ICON_SIZE.control} />
          </IconButton>
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
        'inline-flex min-h-[24px] items-center rounded-md px-2 text-md',
        PILL_TONES[props.pill.tone],
      )}
    >
      {props.pill.label}
    </span>
  );
}

/**
 * The progress line as one string (tests and labels), the same for every
 * viewer: Draft "Creators X of N", Open "Approved X of N". `side` is kept for
 * the callers. Pure.
 */
export function screenProgressLabel(bundle: PlanBundle, side?: ViewerSide): string {
  void side;
  return planProgressView(bundle).lead;
}

/**
 * The progress under the header: two equal boxes (bg-panel-2, radius 12, 12px
 * padding, 8px apart). PLAN: "{ok}/{n} OK" over the items the viewer's side
 * reviews, a 4px good bar; POST: "{approved}/{n} approved" over the post
 * items, a 4px accent bar. Numbers in JetBrains Mono.
 */
export function PlanProgressRow(props: { bundle: PlanBundle; side?: ViewerSide }): ReactElement {
  const counts = planHeaderCounts(props.bundle, props.side ?? 'unknown');
  const boxes = [
    {
      key: 'plan',
      label: PLAN_LINE_LABEL,
      text: planCountLabel(counts.plan.ok, counts.plan.n, 'OK'),
      percent: countPercent(counts.plan.ok, counts.plan.n),
      bar: 'bg-good',
      tone: 'good',
    },
    {
      key: 'post',
      label: POST_LINE_LABEL,
      text: planCountLabel(counts.post.approved, counts.post.n, 'approved'),
      percent: countPercent(counts.post.approved, counts.post.n),
      bar: 'bg-accent',
      tone: 'accent',
    },
  ] as const;
  return (
    <div data-plan-progress-block="" className="grid grid-cols-2 gap-2 px-4 pt-3">
      {boxes.map((box) => (
        <div
          key={box.key}
          data-plan-screen-progress={box.key}
          className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-panel-2 p-3"
        >
          <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
            {box.label}
          </span>
          <span className="truncate font-mono text-md text-fg">{box.text}</span>
          <span className="block h-1 overflow-hidden rounded-[2px] bg-panel-3">
            <span
              data-plan-progress-bar={box.tone}
              className={cn('block h-1', box.bar)}
              style={{ width: `${box.percent}%` }}
            />
          </span>
        </div>
      ))}
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
      <p className="text-base text-fg-2">Couldn&apos;t load. Try again.</p>
      <Button onClick={props.onRetry}>Retry</Button>
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

/** "Wed 14" for a drop slot and the day chip; "No date" for No date. Pure. */
export function dropDayLabel(day: string | null): string {
  return day === null ? NO_DATE_LABEL : `${civilWeekdayShort(day)} ${dayOfMonth(day)}`;
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
  /** Kept for callers: the footer no longer offers "Go to card". */
  onGoToCard: (planId: string) => void;
}

/** A move waiting on "Keep the approval?". */
interface KeepAsk {
  itemId: string;
  toDay: string | null;
  toIndex: number;
  approver: string;
}

/** Where a discard confirm leads: back to view mode, or out of the screen (Back). */
type LeaveEdit = 'exit' | 'close';

export function PlanScreen(props: {
  open: boolean;
  planId: string;
  /** The message sender. Absent outside a chat (kept for callers; the subtitle is the range). */
  senderName?: string;
  /** The open chat's title. Absent outside a chat (kept for callers). */
  chatTitle?: string;
  /** The chat the screen was opened from: its send footer. Absent outside a chat. */
  chat?: PlanScreenChat;
  /**
   * Outside a chat (the standalone page): the item open on entry. It takes no
   * history step of its own (the page's entry is its step), so closing it
   * closes the screen and one Back leaves.
   */
  initialItemId?: string;
  /** Outside a chat: the comment the entry item scrolls to and highlights. */
  highlightCommentId?: string;
  /**
   * Outside a chat: a search jump's plan item. Once the list paints, its row
   * comes to the centre with the arrival tint; an item no longer in the plan
   * opens the plan as usual, with no error.
   */
  jumpItemId?: string;
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
  const undoable = useUndoableAction();
  const planId = props.planId;
  const sentInChannelId = props.chat?.channelId;
  const { read, reload } = useScreenRead<PlanScreenData>(
    props.open,
    `${planId}:${timeZone}:${sentInChannelId ?? ''}`,
    (signal) =>
      readPlanScreen(supabase, planId, signal, {
        timeZone,
        approvers: approverIds,
        readNames: (ids, s) => readProfiles(supabase, ids, s),
        sentInChannelId,
      }),
  );
  const [itemId, setItemId] = useState<string | null>(props.initialItemId ?? null);
  // The Item screen was opened by a row's Not OK: its note box opens focused.
  const [askChanges, setAskChanges] = useState(false);
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
  // The header menu, the inline rename, the delete and open-for-approvers confirms.
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
  // "Sent" in this screen session: true after a send here, false after any
  // change here; null: the read decides (last send vs last change).
  const [sentHere, setSentHere] = useState<boolean | null>(null);
  // A second tap before the busy state paints does nothing.
  const sendingRef = useRef(false);
  // The kind of the tap that started the send (a Retry keeps it): only a
  // "Send in {chat}" turns Sent.
  const sendKindRef = useRef<PrimaryAction['kind']>('none');
  const [keepAsk, setKeepAsk] = useState<KeepAsk | null>(null);
  const [sendGuard] = useState(createInFlightGuard);
  const { canAttach, uploadFile } = useCommentAttachments();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Edit mode: the queued plan_save ops (applied to the paint, written on
  // Save), the header fields, the save in flight and its error, the discard
  // confirm, and the row whose day picker is open.
  const [editMode, setEditMode] = useState(false);
  const [ops, setOps] = useState<PlanSaveOp[]>([]);
  const [headerDraft, setHeaderDraft] = useState<PlanHeaderDraft>({
    title: '',
    startsOn: '',
    endsOn: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardAsk, setDiscardAsk] = useState<LeaveEdit | null>(null);
  const [dayFor, setDayFor] = useState<string | null>(null);
  useHistoryStep(
    itemId !== null && itemId !== entryItemId && props.open,
    HISTORY_STEP_KEYS.planItem,
    () => setItemId(null),
  );

  // A closed screen forgets its item, sheets, edits and local state.
  useEffect(() => {
    if (props.open) return;
    setItemId(null);
    setSlotOverrides({});
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
    setSentHere(null);
    setKeepAsk(null);
    setEditMode(false);
    setOps([]);
    setSaveError(null);
    setDiscardAsk(null);
    setDayFor(null);
  }, [props.open]);

  // A write anywhere re-reads this plan (keeping what is shown meanwhile).
  useEffect(() => {
    if (!props.open) return;
    const onChanged = (event: Event): void => {
      if (planChangedId(event) !== planId) return;
      // Any change (Save, Add, Plan OK, rename) brings "Send in {chat}" back.
      setSentHere(false);
      reload();
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
  // The viewer's slot ticks, laid over the read until a fresh read lands (a
  // write still pending survives that read). Rows, pills, counts and the bar
  // all read the same bundle, so they move together.
  const [slotOverrides, setSlotOverrides] = useState<Record<string, ReviewStatus>>({});
  const slotWriting = useRef(new Set<string>());
  useEffect(() => {
    setSlotOverrides((prev) => {
      const kept = Object.fromEntries(
        Object.entries(prev).filter(([id]) => slotWriting.current.has(id)),
      );
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }, [shownBundle]);
  // A saved queue stays painted until the re-read lands (no flash of the old
  // list), then goes; a cancelled one goes at once (exitEdit).
  const savedRef = useRef(false);
  useEffect(() => {
    if (!savedRef.current) return;
    savedRef.current = false;
    setOps([]);
  }, [shownBundle]);
  const bundle = useMemo(() => {
    if (shownBundle === null) return null;
    const ticked =
      slot !== null ? withReviewOverrides(shownBundle, slot, slotOverrides) : shownBundle;
    return ops.length > 0 ? applyPlanOps(ticked, ops, timeZone) : ticked;
  }, [shownBundle, slot, slotOverrides, ops, timeZone]);
  // A search jump's item: scrolled to and tinted once, when its row is on screen.
  const jumpItemId = props.jumpItemId ?? null;
  const jumpedRef = useRef<string | null>(null);
  const hasJumpRow =
    jumpItemId !== null && (bundle?.items.some((i) => i.id === jumpItemId) ?? false);
  useEffect(() => {
    if (!props.open || jumpItemId === null || !hasJumpRow || jumpedRef.current === jumpItemId) {
      return;
    }
    let clear: (() => void) | null = null;
    const raf = requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector<HTMLElement>(
        `[data-plan-row="${CSS.escape(jumpItemId)}"]`,
      );
      if (row == null) return;
      jumpedRef.current = jumpItemId;
      clear = glowTarget(row);
    });
    return () => {
      cancelAnimationFrame(raf);
      clear?.();
    };
  }, [props.open, jumpItemId, hasJumpRow]);
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
  // Laptop (md and up): the docked panel; edit mode adds the right-click day
  // menu and the keyboard move (agency only).
  const desktop = useMediaQuery(LAPTOP_QUERY);
  const deskAgency = desktop && agency;
  const editing = agency && editMode;
  const deskEditing = deskAgency && editMode;
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

  const chat = props.chat ?? null;
  // Send the card into the chat the screen was opened from: one
  // chat_plan_share (the open thread adds the row and publishes it live).
  // `afterOpen`: the second step of "Send to approvers"; its failure says the
  // plan is open and offers a Retry that only reposts.
  const sendHere = async (afterOpen = false): Promise<void> => {
    if (chat === null || sendBusy || sendingRef.current) return;
    sendingRef.current = true;
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
    sendingRef.current = false;
    setSendBusy(false);
    if (!result.ok) {
      if (result.reason === 'busy') return;
      logger.warn('chat: plan send from the plan screen failed', {
        channel_id: chat.channelId,
        plan_id: planId,
        error: result.message,
      });
      setSendError(
        afterOpen
          ? SEND_AFTER_OPEN_FAILED
          : refusedForClient(result.message)
            ? SEND_NEEDS_OPEN
            : SEND_FAILED,
      );
      return;
    }
    if (sendKindRef.current === 'send') setSentHere(true);
    chat.onSent(result.row, result.traceId);
  };

  // Open for approvers (plan_share_with_client, confirmed: it cannot be
  // undone); from a chat, "Send to approvers in {chat}" then posts the card.
  const openForClient = async (thenSend: boolean): Promise<void> => {
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
    if (thenSend) await sendHere(true);
  };

  const primary: PrimaryAction =
    bundle !== null
      ? planPrimaryAction({
          side,
          audience: bundle.plan.audience,
          chat: chat !== null ? { name: chat.name } : null,
        })
      : { kind: 'none' };
  const readData = read.status === 'ready' ? read.data : null;
  const sendState: SendButtonState = planSendButtonState({
    kind: primary.kind,
    busy: sendBusy || openBusy,
    error: sendError !== null,
    sentHere,
    lastSentAt: readData?.lastSentAt ?? null,
    lastChangedAt: readData?.lastChangedAt ?? null,
  });
  const onPrimary = (): void => {
    if (sendingRef.current || sendState !== 'idle') return;
    if (sendError !== null) {
      // Retry only reposts the card.
      void sendHere(true);
      return;
    }
    sendKindRef.current = primary.kind;
    if (primary.kind === 'open' || primary.kind === 'send-approvers') {
      setOpenError(null);
      setOpenConfirm(true);
      return;
    }
    if (primary.kind === 'send') void sendHere();
  };

  // PLAN (view mode). OK is optimistic behind a 4s Undo strip: the
  // write goes when the toast ends (or the screen is left),
  // never after Undo; a failed write reverts with its copy. Not OK opens the
  // Item screen with the note box open: Send writes 'changes', closing writes
  // nothing.
  const tickSlot = (
    item: PlanItemRow,
    reviewSide: ReviewSide,
    previous: ReviewStatus,
    dayHeader: string | null,
  ): void => {
    if (slotWriting.current.has(item.id)) return;
    slotWriting.current.add(item.id);
    setSlotOverrides((prev) => ({ ...prev, [item.id]: 'approved' }));
    const revert = (): void => {
      slotWriting.current.delete(item.id);
      setSlotOverrides((prev) => ({ ...prev, [item.id]: previous }));
    };
    undoable.run({
      label: slotApprovedToast(dayHeader),
      // L5: the approval toast is success-tinted.
      tone: 'success',
      revert,
      commit: async () => {
        const traceId = generateTraceId();
        const result = await planItemReview(supabase, {
          p_item_id: item.id,
          p_side: reviewSide,
          p_status: 'approved',
          p_trace_id: traceId,
        });
        if (!result.ok) {
          logger.warn('chat: plan slot review failed', {
            trace_id: traceId,
            item_id: item.id,
            error: result.error.message,
          });
          revert();
          toast.show({ title: slotErrorCopy(result.error.message) });
          return;
        }
        slotWriting.current.delete(item.id);
        dispatchPlanChanged(window, planId);
      },
    });
  };
  const planOk = (item: PlanItemRow): void => {
    // Read-only (the agency on an Open plan) never writes; edit mode shows text.
    if (bundle === null || slot === null || editMode) return;
    const previous = reviewStatus(bundle, item.id, slot);
    if (previous === 'approved') return;
    const day = planItemDayInZone(item, bundle.postInfo, timeZone);
    const dayHeader = day !== null ? formatCivilDayHeader(day) : null;
    tickSlot(item, slot, previous, dayHeader);
  };
  const planNotOk = (item: PlanItemRow): void => {
    if (bundle === null || slot === null || editMode) return;
    // A pending OK goes first, so the note's 'changes' lands after it.
    undoable.flush();
    setAskChanges(true);
    setItemId(item.id);
  };

  // Edit mode. Enter copies the header into its fields; every change paints
  // at once through the queue (nothing is written). Leaving with queued
  // changes asks; Save sends the queue as one plan_save.
  const enterEdit = (): void => {
    if (bundle === null || !agency) return;
    setHeaderDraft(headerDraftOf(bundle.plan));
    setOps([]);
    setSaveError(null);
    setMenuOpen(false);
    setRenaming(null);
    setEditMode(true);
  };
  const exitEdit = (): void => {
    setEditMode(false);
    setOps([]);
    setSaveError(null);
    setDayFor(null);
    setKeepAsk(null);
    setPopover(null);
    cancelPick();
    drag.cancel();
  };
  const requestLeaveEdit = (then: LeaveEdit): void => {
    if (saving) return;
    if (hasQueuedOps(ops)) {
      setDiscardAsk(then);
      return;
    }
    exitEdit();
    if (then === 'close') props.onClose();
  };
  const dirty = editMode && hasQueuedOps(ops);
  // System or browser Back: queued changes ask (the same confirm as Cancel);
  // a save in flight keeps the screen as it is. The guard is released right
  // before a confirmed Discard, so that close pops cleanly.
  const guard = useBackGuard({
    active: props.open && (dirty || saving),
    onBack: () => {
      if (saving) return;
      setDiscardAsk('close');
    },
  });
  const discardEdits = (): void => {
    const then = discardAsk;
    setDiscardAsk(null);
    guard.release();
    exitEdit();
    if (then === 'close') props.onClose();
  };
  const headerProblem =
    bundle !== null && editMode
      ? draftProblem({
          title: headerDraft.title.trim() === '' ? bundle.plan.title : headerDraft.title,
          startsOn: headerDraft.startsOn,
          endsOn: headerDraft.endsOn,
        })
      : null;
  const changeHeader = (next: PlanHeaderDraft): void => {
    if (shownBundle === null) return;
    setHeaderDraft(next);
    setOps((prev) => withHeaderUpdate(prev, shownBundle.plan, next));
  };
  const saveChanges = async (): Promise<void> => {
    if (saving || bundle === null) return;
    if (!hasQueuedOps(ops)) {
      exitEdit();
      return;
    }
    if (headerProblem !== null) return;
    setSaving(true);
    setSaveError(null);
    const traceId = generateTraceId();
    let result: Awaited<ReturnType<typeof planSave>>;
    try {
      result = await planSave(supabase, { p_plan_id: planId, p_ops: ops, p_trace_id: traceId });
    } catch (thrown) {
      result = { ok: false, error: { code: 'unknown', message: String(thrown) } };
    }
    setSaving(false);
    if (!result.ok) {
      logger.warn('chat: plan save failed', {
        trace_id: traceId,
        plan_id: planId,
        ops: ops.length,
        error: result.error.message,
      });
      setSaveError(planSaveErrorCopy(result.error.message));
      return;
    }
    // The queue stays painted until the re-read lands.
    savedRef.current = true;
    setEditMode(false);
    setSaveError(null);
    setDayFor(null);
    setKeepAsk(null);
    setPopover(null);
    cancelPick();
    toast.show({ title: PLAN_SAVED_TOAST });
    dispatchPlanChanged(window, planId);
  };

  // A drop, a day chip pick or a keyboard drop: queued as one 'move' op (the
  // full new order and the day), painted at once. On an Open plan a day
  // change of a client-approved slot asks "Keep the approval?" first
  // (cancelling cancels the move); every other move resets (false).
  const commitMove = (
    moved: string,
    toDay: string | null,
    toIndex: number,
    keep: boolean,
  ): void => {
    if (bundle === null || !editMode) return;
    const days = planDayIds(groups);
    const from = findItem(days, moved);
    if (from === null || isNoop(days, moved, { day: toDay, index: toIndex })) return;
    const order = flattenOrder(moveItem(days, moved, toDay, toIndex));
    setOps((prev) =>
      queueOp(prev, {
        op: 'move',
        item_id: moved,
        target_date: toDay,
        item_ids: order,
        keep_reviews: keep,
      }),
    );
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
    commitMove(moved, toDay, toIndex, false);
  };
  const drag = usePlanDrag({
    enabled: editing,
    bodyRef,
    onDrop: (moved, toDay, toIndex) => moveTo(moved, toDay, toIndex),
  });
  // Remove (edit mode): queued as one 'remove' op; the row goes at once.
  const removeRow = (id: string): void => {
    if (!editing) return;
    setDayFor(null);
    setOps((prev) => queueOp(prev, { op: 'remove', item_id: id }));
  };
  const openItem = (id: string): void => {
    if (editMode) return;
    setAskChanges(false);
    setItemId(id);
  };

  // Laptop (agency, edit mode): the right-click day menu with Remove, the
  // keyboard pick-up and its live region.
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
    if (deskEditing) return;
    setPopover(null);
    setPick(null);
  }, [deskEditing]);
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
  // The list as shown: a pick-up previews its slot (nothing is queued yet).
  const viewGroups = useMemo(
    () => (pick !== null ? previewGroups(groups, pick.itemId, pick.at) : groups),
    [groups, pick],
  );
  // What a refocus aims at next render (a CSS selector inside the list).
  const refocus = useRef<string | null>(null);
  // A pick-up step or a removal re-renders rows: focus follows.
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
  // last, or the day's drop target when the day is now empty; never to the page.
  const removeWithFocus = (id: string): void => {
    const body = bodyRef.current;
    const rows = rowButtons();
    const row = body?.querySelector<HTMLElement>(`button[data-plan-row="${id}"]`) ?? null;
    const at = row !== null ? rows.indexOf(row) : -1;
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    refocus.current =
      next !== null ? `button[data-plan-row="${next.getAttribute('data-plan-row') ?? ''}"]` : null;
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
  const openPopover = (id: string, anchor: PopoverAnchor): void => {
    if (drag.state !== null) return;
    setDayFor(null);
    setPopover({ itemId: id, anchor, withRemove: true });
  };
  const popoverDays = useMemo(() => {
    if (bundle === null) return [];
    const days = planDayIds(groups);
    return planMoveDays(bundle.plan).map((d) => ({
      ...d,
      count: days.find((g) => g.day === d.day)?.ids.length ?? 0,
    }));
  }, [bundle, groups]);
  const dayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of planDayIds(groups)) if (d.day !== null) counts[d.day] = d.ids.length;
    return counts;
  }, [groups]);
  const rowButtons = (): HTMLElement[] => [
    ...(bodyRef.current?.querySelectorAll<HTMLElement>('button[data-plan-row]') ?? []),
  ];
  const onRowKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!deskEditing || !(event.target instanceof HTMLElement)) return;
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
    if (editMode) {
      // Esc is Cancel: queued changes ask first.
      requestLeaveEdit('exit');
      return true;
    }
    return false;
  };
  // Space must never also click the row.
  const onRowKeyUp = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (deskEditing && event.key === ' ' && event.target instanceof HTMLElement) {
      if (event.target.matches('button[data-plan-row]')) event.preventDefault();
    }
  };

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

  // Add (view mode, instant): a concept on that day, or picked posts on that day.
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
  // The edit row whose day picker is open (its current day for the tiles).
  const dayItem = dayFor !== null ? (bundle?.items.find((i) => i.id === dayFor) ?? null) : null;
  const lastDayItem = useRef<PlanItemRow | null>(null);
  if (dayItem !== null) lastDayItem.current = dayItem;
  const shownDayItem = dayItem ?? lastDayItem.current;
  const dayItemDay =
    shownDayItem !== null && bundle !== null
      ? planItemDayInZone(shownDayItem, bundle.postInfo, timeZone)
      : null;

  const found = bundle?.items.find((i) => i.id === itemId) ?? null;
  // A draft the viewer can see by name only never opens (a drawer row included).
  const item =
    found !== null && bundle !== null && !draftLocked(bundle, found, side) ? found : null;
  const footer =
    !editMode && bundle !== null && (primary.kind !== 'none' || sendError !== null) ? (
      <PlanFooter
        action={primary}
        busy={sendBusy || openBusy}
        error={sendError}
        state={sendState}
        chatName={chat?.name ?? null}
        onPress={onPrimary}
      />
    ) : undefined;
  const editHeaderSlot = (
    <h2 data-plan-editing-title="" className="truncate text-lg font-semibold text-fg">
      {EDITING_TITLE}
    </h2>
  );
  const saveButton = (
    <Button
      type="button"
      variant="link"
      data-plan-save=""
      aria-busy={saving}
      disabled={saving || headerProblem !== null}
      onClick={() => void saveChanges()}
      className="-mr-2 shrink-0 md:mr-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {saving ? SAVING_LABEL : SAVE_CHANGES_LABEL}
    </Button>
  );
  // Line 2's boxed pair: Add (accent soft), then Edit (outlined), each box 34px
  // in a 44px tap target, the last one's right edge on the 16px line.
  const viewActions = (
    <span data-plan-header-actions="" className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-label="Add to plan"
        data-plan-add-header=""
        onClick={() => openAdd(null)}
        className="group flex h-11 shrink-0 items-center focus-visible:outline-none"
      >
        <span
          data-plan-header-box=""
          className="flex h-[34px] items-center gap-1.5 rounded-[10px] border border-transparent bg-accent-soft px-3 text-base font-semibold leading-5 text-accent group-hover:brightness-95 group-focus-visible:ring-2 group-focus-visible:ring-accent"
        >
          <IconPlus size={ICON_SIZE.inline} />
          Add
        </span>
      </button>
      <button
        type="button"
        data-plan-edit=""
        onClick={enterEdit}
        className="group flex h-11 shrink-0 items-center focus-visible:outline-none"
      >
        <span
          data-plan-header-box=""
          className="flex h-[34px] items-center gap-1.5 rounded-[10px] border border-border-strong bg-panel px-3 text-base font-semibold leading-5 text-fg group-hover:bg-panel-2 group-focus-visible:ring-2 group-focus-visible:ring-accent"
        >
          <IconEdit size={ICON_SIZE.inline} />
          {EDIT_LABEL}
        </span>
      </button>
    </span>
  );
  return (
    <>
      <PlanPage
        open={props.open}
        testId="plan"
        title={editing ? EDITING_TITLE : title}
        // The inline rename takes the whole title column; edit mode has its own line.
        subtitle={renaming !== null || editing ? undefined : subtitle}
        backLabel={editing ? 'Cancel editing' : 'Back'}
        onBack={editing ? () => requestLeaveEdit('exit') : props.onClose}
        closeLabel="Close plan"
        onDismiss={editing ? () => requestLeaveEdit('close') : props.onClose}
        onEscape={onPanelEscape}
        bodyRef={bodyRef}
        footer={footer}
        {...(editing
          ? {
              backText: CANCEL_EDIT_LABEL,
              desktopBack: true,
              titleSlot: editHeaderSlot,
              action: saveButton,
            }
          : renaming === null
            ? { twoLine: agency ? { actions: viewActions } : {} }
            : {})}
        {...(editing
          ? {}
          : agency
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
              }
            : {})}
      >
        {skippedNotes.length > 0 ? (
          <div
            role="status"
            data-plan-skipped-notes=""
            className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-warn-soft py-1 pl-3 pr-1 text-md text-warn"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
              {skippedNotes.map((note, at) => (
                <p key={at}>{note}</p>
              ))}
            </div>
            <IconButton
              type="button"
              label="Dismiss"
              onClick={() => setSkippedNotes([])}
              className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </div>
        ) : null}
        {deskEditing ? (
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
            <IconPlan size={ICON_SIZE.tray} />
            <p className="text-base">{PLAN_NOT_AVAILABLE}</p>
          </div>
        ) : (
          <>
            {editing ? (
              <PlanEditHeader
                draft={headerDraft}
                problem={headerProblem !== null ? DRAFT_PROBLEM_COPY[headerProblem] : null}
                saving={saving}
                error={saveError}
                onChange={changeHeader}
                onRetry={() => void saveChanges()}
                keyHints={deskEditing}
              />
            ) : null}
            <PlanBody
              bundle={bundle}
              groups={viewGroups}
              side={side}
              timeZone={timeZone}
              thumbs={read.status === 'ready' ? read.data.thumbs : {}}
              conceptThumbs={read.status === 'ready' ? (read.data.conceptThumbs ?? {}) : {}}
              alsoIn={read.status === 'ready' ? (read.data.alsoIn ?? {}) : {}}
              drag={drag.state}
              onOpenItem={openItem}
              onPlanOk={planOk}
              onPlanNotOk={planNotOk}
              {...(editing
                ? {
                    onDragStart: (id: string, row: HTMLElement, clientY: number) =>
                      drag.start(id, row, clientY),
                    edit: {
                      pickedId: pick?.itemId ?? null,
                      dayOpenId: dayFor,
                      dragging: drag.state !== null,
                      onDay: (id: string) => {
                        setPopover(null);
                        setDayFor(id);
                      },
                      onRemove: deskEditing ? removeWithFocus : removeRow,
                      ...(deskEditing
                        ? {
                            onMenu: (id: string, row: HTMLElement, x: number, y: number) => {
                              const r = row.getBoundingClientRect();
                              openPopover(id, {
                                el: row,
                                point: { dx: x - r.left, dy: y - r.top },
                              });
                            },
                            onKeyDown: onRowKey,
                            onKeyUp: onRowKeyUp,
                          }
                        : {}),
                    },
                  }
                : agency
                  ? { onAdd: openAdd }
                  : {})}
            />
          </>
        )}
      </PlanPage>
      {deskEditing && popover !== null && props.open ? (
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
          conceptThumb={(() => {
            const dragged = bundle.items.find((i) => i.id === drag.state?.itemId);
            return dragged?.kind === 'concept' && read.status === 'ready'
              ? (read.data.conceptThumbs?.[dragged.id] ?? null)
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
          askChanges={askChanges}
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
          if (ask !== null) commitMove(ask.itemId, ask.toDay, ask.toIndex, keep);
        }}
        onCancel={() => setKeepAsk(null)}
      />
      {props.open && discardAsk !== null ? (
        <ConfirmDialog
          title={DISCARD_EDITS.title}
          message={DISCARD_EDITS.message}
          confirmLabel={DISCARD_LABEL}
          cancelLabel={KEEP_EDITING_LABEL}
          destructive
          onConfirm={discardEdits}
          onCancel={() => setDiscardAsk(null)}
        />
      ) : null}
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
            confirmLabel={primary.kind === 'send-approvers' ? primary.label : OPEN_FOR_CLIENT_LABEL}
            busy={openBusy}
            error={openError}
            onConfirm={() => void openForClient(primary.kind === 'send-approvers')}
            onCancel={() => {
              if (!openBusy) setOpenConfirm(false);
            }}
          />
          <PlanDayPickerSheet
            open={props.open && editMode && dayFor !== null}
            title={shownDayItem !== null && bundle !== null ? rowTitle(bundle, shownDayItem) : ''}
            subline={
              shownDayItem !== null
                ? shownDayItem.kind === 'concept'
                  ? dayPickerSubline({ kind: 'concept' }, planRange)
                  : dayPickerSubline({ kind: 'post', orig: dayItemDay }, planRange)
                : ''
            }
            range={planRange}
            selected={dayItemDay ?? 'none'}
            today={civilToday(new Date(), timeZone)}
            counts={dayCounts}
            onPick={(day) => {
              const id = dayFor;
              setDayFor(null);
              if (id !== null) moveToDay(id, day === 'none' ? null : day);
            }}
            onClose={() => setDayFor(null)}
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
 * Edit mode's top block (FT53): the plan name and From / To as fields, a
 * problem line when the dates or name are not right, and the Save changes
 * failure (plain words, Retry) when a save failed. Nothing here writes: every
 * change goes into the queue. Laptop: the keyboard hint line sits under it.
 */
export function PlanEditHeader(props: {
  draft: PlanHeaderDraft;
  problem: string | null;
  saving: boolean;
  error: string | null;
  onChange: (draft: PlanHeaderDraft) => void;
  onRetry: () => void;
  keyHints?: boolean;
}): ReactElement {
  const { draft } = props;
  return (
    <div
      data-plan-edit-header=""
      className="flex flex-col gap-2.5 border-b border-border px-4 pb-4 pt-3"
    >
      {props.error !== null ? (
        <div
          role="alert"
          data-plan-save-error=""
          className="flex items-center justify-between gap-2 rounded-xl bg-bad-soft py-1 pl-3 pr-1 text-md leading-[1.45] text-bad"
        >
          <p className="min-w-0 flex-1 py-2">{props.error}</p>
          <Button
            type="button"
            variant="ghost"
            data-plan-save-retry=""
            disabled={props.saving}
            onClick={props.onRetry}
            className="shrink-0 text-bad hover:bg-panel hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {RETRY_LABEL}
          </Button>
        </div>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-md text-fg-3">{EDIT_TITLE_LABEL}</span>
        <input
          data-plan-edit-title=""
          value={draft.title}
          maxLength={PLAN_TITLE_MAX}
          autoComplete="off"
          enterKeyHint="done"
          disabled={props.saving}
          onChange={(e) => props.onChange({ ...draft, title: e.target.value })}
          className={cn(FIELD, 'font-semibold')}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['startsOn', EDIT_FROM_LABEL],
            ['endsOn', EDIT_TO_LABEL],
          ] as const
        ).map(([field, label]) => (
          <label key={field} className="flex w-full min-w-0 flex-col gap-1">
            <span className="text-md text-fg-3">{label}</span>
            <input
              type="date"
              data-plan-edit-date={field}
              value={draft[field]}
              disabled={props.saving}
              onChange={(e) => props.onChange({ ...draft, [field]: e.target.value })}
              className={DATE_FIELD}
            />
          </label>
        ))}
      </div>
      {props.problem !== null ? (
        <p role="alert" data-plan-edit-problem="" className="text-md text-bad">
          {props.problem}
        </p>
      ) : null}
      {props.keyHints === true ? <PlanKeyHints /> : null}
    </div>
  );
}

/** The view header's title: the page title role (28/34, 600, tight), 2 lines at most. */
const PLAN_HEADER_TITLE = 'line-clamp-2 break-normal text-3xl font-semibold tracking-tight text-fg';

/**
 * The agency's header title: a button with a chevron (18px, 6px gap) that
 * opens the header menu (Rename, Delete plan). At least 44px tall; 2 lines.
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
        '-ml-1 flex min-h-[44px] min-w-0 max-w-full items-center gap-1.5 self-start rounded-lg px-1 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        NO_TOUCH_SELECT,
      )}
    >
      <h2 className={PLAN_HEADER_TITLE}>{props.title}</h2>
      <span aria-hidden="true" className="shrink-0 text-fg-2">
        <IconChevronDown size={ICON_SIZE.nav} />
      </span>
    </button>
  );
}

/**
 * The header menu, anchored under the header: Rename and, for the plan's
 * creator or a workspace owner/admin, "Delete plan" (danger, bin icon). Slides
 * on translateY only; an outside tap or Escape closes it. Focus moves to its
 * first row on open (FN27), Up/Down move between rows, and it goes back to
 * the title button on close.
 */
export function PlanHeaderMenu(props: {
  open: boolean;
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
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
  // One listener set per open (never per render, so a focused row stays focused).
  useEffect(() => {
    if (!props.open) return;
    const onClose = (): void => onCloseRef.current();
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
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
      // Focus goes back to the title button when the menu still held it.
      const now = document.activeElement;
      const held = now === null || now === document.body || ref.current?.contains(now) === true;
      if (held && returnTo?.isConnected === true) returnTo.focus({ preventScroll: true });
    };
  }, [props.open]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  if (!props.open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Plan actions"
      data-plan-header-menu=""
      onKeyDown={onKeyDown}
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
        className="flex min-h-[44px] w-full items-center gap-3 px-3 text-left text-lg text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconEdit size={ICON_SIZE.nav} />
        {RENAME_LABEL}
      </button>
      {props.canDelete ? (
        <button
          type="button"
          role="menuitem"
          data-plan-menu-delete=""
          onClick={props.onDelete}
          className="flex min-h-[44px] w-full items-center gap-3 px-3 text-left text-lg text-bad hover:bg-bad-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconTrash size={ICON_SIZE.nav} />
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
        enterKeyHint="done"
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) props.onDone();
          if (e.key === 'Escape') props.onCancel();
        }}
        className="h-11 min-h-[44px] min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-3 text-input font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 md:text-base"
      />
      <IconButton
        type="button"
        label="Cancel rename"
        data-plan-rename-cancel=""
        disabled={props.busy}
        onClick={props.onCancel}
        className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        <IconX size={ICON_SIZE.control} />
      </IconButton>
      <Button
        type="button"
        variant="link"
        data-plan-rename-done=""
        disabled={props.busy || !valid}
        onClick={props.onDone}
        className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Done
      </Button>
    </div>
  );
}

/**
 * The Plan screen's footer (view mode): one primary button, 44px tall, full
 * width: "Send to approvers in {chat}" / "Send in {chat}" / "Open for
 * approvers" (planPrimaryAction). An error line sits above it; while an
 * error is shown the button reads "Retry". From a chat a send in flight reads
 * "Sending in {chat}…"; a sent "Send in {chat}" reads "Sent" in the soft
 * accent (same box, disabled, no icon). Hidden in edit mode.
 */
export function PlanFooter(props: {
  action: PrimaryAction;
  busy: boolean;
  error: string | null;
  /** The button's state (planSendButtonState); absent reads as idle. */
  state?: SendButtonState;
  /** The chat's title for "Sending in {chat}…"; null outside a chat. */
  chatName?: string | null;
  onPress: () => void;
}): ReactElement | null {
  const { action } = props;
  if (action.kind === 'none' && props.error === null) return null;
  const state = props.state ?? 'idle';
  const label = planFooterLabel({
    action,
    state,
    error: props.error !== null,
    chatName: props.chatName ?? null,
  });
  if (state === 'sent') {
    return (
      <div data-plan-footer="" className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="secondary"
          data-plan-primary={action.kind}
          data-plan-send-state="sent"
          disabled
          className="w-full min-w-0 cursor-default border-accent-line bg-accent-soft text-accent disabled:opacity-100"
        >
          <span className="truncate">{label}</span>
        </Button>
      </div>
    );
  }
  return (
    <div data-plan-footer="" className="flex flex-col gap-1.5">
      {props.error !== null ? (
        <p role="alert" data-plan-send-error="" className="text-md text-bad">
          {props.error}
        </p>
      ) : null}
      <Button
        variant="primary"
        data-plan-primary={props.error !== null ? 'retry' : action.kind}
        data-plan-send-state={state}
        className={cn('w-full min-w-0', state === 'sending' && 'disabled:opacity-100')}
        aria-busy={props.busy}
        disabled={props.busy || state !== 'idle'}
        onClick={props.onPress}
      >
        <span className="truncate">{label}</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag (edit mode): the grip lifts a row, the pointer moves it, a drop queues a move
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
 * The drag controller: `start` from a row's grip lifts it; window pointer
 * listeners move it (translateY only), hover a day block, auto-scroll near
 * the body's edges; pointerup drops (one onDrop), Escape or pointercancel
 * cancels with no change. Every listener, frame and timer is removed on end
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
  conceptThumb?: ConceptThumb | null;
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
        <RowTile
          item={item}
          thumb={props.thumb}
          conceptThumb={props.conceptThumb ?? null}
          muted={false}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-medium text-fg">
            {rowTitle(props.bundle, item)}
          </span>
          <span className="truncate text-sm text-fg-3">{rowMeta(props.bundle, item)}</span>
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

/** Edit mode's row controls (agency, every width), handed down to each row. */
export interface PlanRowEdit {
  /** The row the keyboard has picked up (laptop), or null. */
  pickedId: string | null;
  /** The row whose day picker is open, or null. */
  dayOpenId: string | null;
  /** A drag is running: no menu opens. */
  dragging: boolean;
  /** The day chip: opens the day picker for the row. */
  onDay: (id: string, anchor: HTMLElement) => void;
  onRemove: (id: string) => void;
  /** Laptop right-click: the day menu with Remove, at the pointer (kept on the row). */
  onMenu?: (id: string, row: HTMLElement, x: number, y: number) => void;
  /** Laptop: the list's key handlers (rows are the targets). */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onKeyUp?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export function PlanBody(props: {
  bundle: PlanBundle;
  groups: readonly PlanWeekGroup<PlanItemRow>[];
  side: ViewerSide;
  timeZone: string;
  thumbs: Record<string, string>;
  /** Concept tiles by item id (the first image, or a file tile). */
  conceptThumbs?: Readonly<Record<string, ConceptThumb>>;
  /** Other plans' titles by post id (the Also in pill). */
  alsoIn?: Readonly<Record<string, string[]>>;
  /** The drag in progress, or null. */
  drag: DragState | null;
  onOpenItem: (id: string) => void;
  /** PLAN: OK on a row (behind the Undo toast). */
  onPlanOk: (item: PlanItemRow) => void;
  /** PLAN: Not OK on a row (the Item screen with the note box open). */
  onPlanNotOk: (item: PlanItemRow) => void;
  /** Agency, view mode: a day's Add row (null = No date). */
  onAdd?: (day: string | null) => void;
  /** Edit mode: a row's grip lifts it. */
  onDragStart?: (itemId: string, row: HTMLElement, clientY: number) => void;
  /** Edit mode: grip, day chip, remove (laptop: right-click, keyboard). */
  edit?: PlanRowEdit;
}): ReactElement {
  const { bundle, side, drag, edit } = props;
  const weeks = planShowsWeeks(bundle.plan.starts_on, bundle.plan.ends_on);
  const today = civilToday(new Date(), props.timeZone);
  const dragFrom = drag !== null ? (findItem(planDayIds(props.groups), drag.itemId) ?? null) : null;
  const keyHandlers =
    edit?.onKeyDown !== undefined && edit.onKeyUp !== undefined
      ? { onKeyDown: edit.onKeyDown, onKeyUp: edit.onKeyUp }
      : {};
  return (
    <>
      <PlanProgressRow bundle={bundle} side={side} />
      <div
        data-plan-list={weeks ? 'weeks' : 'days'}
        {...(edit !== undefined ? { 'data-plan-list-mode': 'edit' } : {})}
        className="flex flex-col pb-4 pt-3"
        {...keyHandlers}
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
                className="sticky top-0 z-10 border-b border-border bg-bg px-4 py-2 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2 md:bg-panel"
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
              // One date tile per day: on its first row, or beside the empty day's line.
              const tile = <DayColumn day={day.day} today={today} empty={empty} />;
              let k = 0;
              const emptyBody =
                droppable && empty ? (
                  <PlanDropHere over={hovered} />
                ) : props.onAdd !== undefined && (day.day === null || day.inRange) ? (
                  <AddRow day={day.day} empty onAdd={props.onAdd} />
                ) : slotAt === null ? (
                  <p
                    data-plan-day-empty=""
                    className="flex min-h-[44px] items-center text-md text-fg-3"
                  >
                    Nothing planned
                  </p>
                ) : null;
              return (
                <div
                  key={day.day ?? 'none'}
                  data-plan-day={day.day ?? 'none'}
                  {...(day.day !== null && !day.inRange ? { 'data-plan-day-out': '' } : {})}
                  {...(droppable ? { 'data-plan-drop': '' } : {})}
                  {...(hovered ? { 'data-plan-drop-over': '' } : {})}
                  className="flex flex-col gap-4 border-t border-border px-4 py-4"
                >
                  {items.map((item, index) => {
                    const lifted = drag !== null && item.id === drag.itemId;
                    const slotHere = !lifted && slotAt === k;
                    if (!lifted) k += 1;
                    return (
                      <Fragment key={item.id}>
                        {slotHere ? <PlanDropLine /> : null}
                        <PlanRow
                          bundle={bundle}
                          item={item}
                          side={side}
                          thumb={
                            item.post_id !== null ? (props.thumbs[item.post_id] ?? null) : null
                          }
                          conceptThumb={props.conceptThumbs?.[item.id] ?? null}
                          dimmed={lifted}
                          tile={index === 0 ? tile : null}
                          timeZone={props.timeZone}
                          alsoIn={item.post_id !== null ? (props.alsoIn?.[item.post_id] ?? []) : []}
                          day={day.day}
                          onOpen={() => props.onOpenItem(item.id)}
                          onPlanOk={() => props.onPlanOk(item)}
                          onPlanNotOk={() => props.onPlanNotOk(item)}
                          {...(props.onDragStart !== undefined && (day.day === null || day.inRange)
                            ? { onDragStart: props.onDragStart }
                            : {})}
                          {...(edit !== undefined ? { edit } : {})}
                        />
                      </Fragment>
                    );
                  })}
                  {slotAt !== null && slotAt >= others.length && !empty ? <PlanDropLine /> : null}
                  {empty ? (
                    <div className="flex items-center">
                      {edit !== undefined ? (
                        <span className="mr-1 shrink-0">
                          <PlanGripSpacer />
                        </span>
                      ) : null}
                      {tile}
                      <div className="ml-3 min-w-0 flex-1">{emptyBody}</div>
                    </div>
                  ) : props.onAdd !== undefined && (day.day === null || day.inRange) ? (
                    <AddRow day={day.day} empty={false} onAdd={props.onAdd} />
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}

/**
 * A day's Add row (agency, view mode): plus icon and "Add" (13px, 600, accent)
 * in a 44px target. Under a day's rows it sits on the title column and tucks
 * up so the gap stays 16px; on an empty day it sits right of "Nothing
 * planned", beside the date tile.
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
      className={cn(
        'flex min-h-[44px] items-center gap-2',
        !props.empty && '-mb-3 -mt-2 pl-[68px]',
      )}
    >
      {props.empty ? (
        <p data-plan-day-empty="" className="flex-1 text-md text-fg-3">
          Nothing planned
        </p>
      ) : null}
      <Button
        type="button"
        variant="link"
        aria-label={label}
        data-plan-add={props.day ?? 'none'}
        onClick={() => props.onAdd(props.day)}
        className="!gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconPlus size={ICON_SIZE.inline} />
        Add
      </Button>
    </div>
  );
}

/**
 * A day's calendar tile, shown once per day group: 56x56, radius 10, a 1px
 * border-strong, bg-panel. An 18px strip on top holds the weekday (10px/12px,
 * 700, uppercase, .08em, bg-panel-2, text-fg-2); the day number sits centred
 * below it (JetBrains Mono 20px/24px, 500). Today (the workspace zone): the
 * strip in the accent with accent-fg text and an accent border. "No date":
 * the strip stays empty (bg-panel-2) and the body reads "No date" centred on
 * one line (Inter 11px/14px, 600, text-fg-2, not uppercase); it is never
 * today, so no accent.
 */
export function DayColumn(props: {
  day: string | null;
  today: string;
  empty?: boolean;
}): ReactElement {
  const isToday = props.day !== null && props.day === props.today;
  return (
    <div
      data-plan-day-col=""
      {...(isToday ? { 'data-plan-today': '' } : {})}
      className={cn(
        'flex h-14 w-14 shrink-0 flex-col overflow-hidden rounded-[10px] border bg-panel',
        isToday ? 'border-accent' : 'border-border-strong',
      )}
    >
      <span
        data-plan-day-weekday=""
        className={cn(
          'flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap text-xs font-semibold uppercase leading-3 tracking-[.08em]',
          isToday ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-fg-2',
        )}
      >
        {props.day === null ? '' : civilWeekdayShort(props.day)}
      </span>
      <span
        data-plan-day-number=""
        className={cn(
          'flex flex-1 items-center justify-center',
          props.day === null
            ? 'whitespace-nowrap text-xs font-semibold text-fg-2'
            : 'font-mono text-2xl font-medium leading-6 tabular-nums text-fg',
        )}
      >
        {props.day === null ? NO_DATE_LABEL : dayOfMonth(props.day)}
      </span>
    </div>
  );
}

/** The PLAN / POST line label: 36px column, the section label (12/16, 600, uppercase). */
const LINE_LABEL = 'w-9 shrink-0 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/**
 * The PLAN switch: "OK" and "Not OK" joined (36px visual, min 84px each,
 * 1px border-strong, bg-panel), each in a 44px tall target. Reopened from
 * the pill, the current answer is highlighted. Not full width.
 */
export function PlanSwitch(props: {
  side: ReviewSide;
  title: string;
  /** The answer it was reopened on; null when undecided. */
  current: 'approved' | 'changes' | null;
  onOk: () => void;
  onNotOk: () => void;
}): ReactElement {
  const visual =
    'flex h-9 min-w-[84px] items-center justify-center gap-1.5 border px-3.5 text-md font-semibold';
  return (
    <span
      role="group"
      aria-label={`${PLAN_LINE_LABEL}: ${props.title}`}
      data-plan-slot={props.side}
      data-plan-slot-state={planControlState(props.current ?? 'waiting')}
      data-plan-control="switch"
      className="flex shrink-0 items-center"
    >
      <button
        type="button"
        aria-pressed={props.current === 'approved'}
        data-plan-ok=""
        onClick={props.onOk}
        className="group flex h-11 items-center focus-visible:outline-none"
      >
        <span
          className={cn(
            visual,
            'rounded-l-lg text-good group-focus-visible:ring-2 group-focus-visible:ring-accent',
            props.current === 'approved'
              ? 'border-good bg-good-soft'
              : 'border-border-strong bg-panel',
          )}
        >
          <IconCheck size={ICON_SIZE.inline} />
          {PLAN_OK_LABEL}
        </span>
      </button>
      <button
        type="button"
        aria-pressed={props.current === 'changes'}
        data-plan-not-ok=""
        onClick={props.onNotOk}
        className="group -ml-px flex h-11 items-center focus-visible:outline-none"
      >
        <span
          className={cn(
            visual,
            'rounded-r-lg text-bad group-focus-visible:ring-2 group-focus-visible:ring-accent',
            props.current === 'changes'
              ? 'border-bad bg-bad-soft'
              : 'border-border-strong bg-panel',
          )}
        >
          <IconX size={ICON_SIZE.inline} />
          {PLAN_NOT_OK_LABEL}
        </span>
      </button>
    </span>
  );
}

/**
 * The decided PLAN pill: 32px visual in a 44px target, fully round, icon +
 * "OK" / "Not OK" + a chevron at 70%. Solid good / bad fills (light values in
 * both themes) under white text. Tapping it reopens the switch.
 */
export function PlanDecidedPill(props: {
  side: ReviewSide;
  title: string;
  status: 'approved' | 'changes';
  onChange: () => void;
}): ReactElement {
  const ok = props.status === 'approved';
  return (
    <button
      type="button"
      aria-label={`${PLAN_LINE_LABEL} ${ok ? PLAN_OK_LABEL : PLAN_NOT_OK_LABEL}: ${props.title}`}
      aria-haspopup="true"
      data-plan-slot={props.side}
      data-plan-slot-state={planControlState(props.status)}
      data-plan-control="pill"
      onClick={props.onChange}
      className="group flex h-11 shrink-0 items-center focus-visible:outline-none"
    >
      <span
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-full px-3 text-md font-semibold text-white group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-panel',
          ok ? 'bg-[var(--good-solid)]' : 'bg-[var(--bad-solid)]',
        )}
      >
        {ok ? <IconCheck size={ICON_SIZE.inline} /> : <IconX size={ICON_SIZE.inline} />}
        {ok ? PLAN_OK_LABEL : PLAN_NOT_OK_LABEL}
        <span aria-hidden="true" className="opacity-70">
          <IconChevronDown size={ICON_SIZE.inline} />
        </span>
      </span>
    </button>
  );
}

const PLAN_TEXT_TONES: Record<ReviewStatus, string> = {
  approved: 'text-good',
  changes: 'text-bad',
  waiting: 'text-fg-2',
};

const POST_LINE_TONES: Record<PostLineTone, string> = {
  draft: 'text-fg-2',
  review: 'text-stage-review',
  approved: 'text-stage-approved',
  parked: 'text-stage-parked',
  rejected: 'text-stage-rejected',
  none: 'text-fg-2',
};

/**
 * Under the title row: PLAN (the switch, the pill, or read-only text) and
 * POST (an 8px dot and the stage, same colour). Edit mode shows both as text.
 */
function PlanStatusLines(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  title: string;
  /** Edit mode: text only. */
  readOnly: boolean;
  onOk: () => void;
  onNotOk: () => void;
}): ReactElement {
  const [changing, setChanging] = useState(false);
  const control = planControl(props.bundle, props.item, props.side);
  const decided = control.kind === 'pill' ? control.status : null;
  // A new answer (a write, an Undo, a re-read) closes the reopened switch.
  useEffect(() => setChanging(false), [decided]);
  const post = postLine(props.bundle, props.item);
  let plan: ReactNode = null;
  if (control.kind === 'text' || (props.readOnly && control.kind !== 'none')) {
    const status =
      control.kind === 'text'
        ? control.status
        : control.kind === 'pill'
          ? control.status
          : 'waiting';
    plan = (
      <span
        data-plan-slot={control.side}
        data-plan-slot-state={planControlState(status)}
        data-plan-slot-readonly=""
        data-plan-control="text"
        className={cn('text-md font-semibold', PLAN_TEXT_TONES[status])}
      >
        {planControlText(status)}
      </span>
    );
  } else if (control.kind === 'switch' || (control.kind === 'pill' && changing)) {
    plan = (
      <PlanSwitch
        side={control.side}
        title={props.title}
        current={decided}
        onOk={() => {
          setChanging(false);
          if (decided !== 'approved') props.onOk();
        }}
        onNotOk={() => {
          setChanging(false);
          props.onNotOk();
        }}
      />
    );
  } else if (control.kind === 'pill') {
    plan = (
      <PlanDecidedPill
        side={control.side}
        title={props.title}
        status={control.status}
        onChange={() => setChanging(true)}
      />
    );
  }
  return (
    <div data-plan-row-lines="" className="mt-1 flex flex-col">
      {plan !== null ? (
        <div data-plan-line="plan" className="flex min-h-[44px] items-center gap-3">
          <span className={LINE_LABEL}>{PLAN_LINE_LABEL}</span>
          {plan}
        </div>
      ) : null}
      <div data-plan-line="post" className="flex min-h-[24px] items-center gap-3">
        <span className={LINE_LABEL}>{POST_LINE_LABEL}</span>
        <span
          data-plan-post-status={post.tone}
          className={cn(
            'flex min-w-0 items-center gap-2 text-md font-medium',
            POST_LINE_TONES[post.tone],
          )}
        >
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-current" />
          <span className="truncate">{post.label}</span>
        </span>
      </div>
    </div>
  );
}

/** A row's format line: a post's format ("Carousel"), a concept's description. Pure. */
export function rowMeta(bundle: PlanBundle, item: PlanItemRow): string {
  if (item.kind === 'concept') return rowSubline(item);
  const format = item.post_id !== null ? (bundle.postInfo[item.post_id]?.format ?? null) : null;
  return format !== null && format !== '' ? formatLabel(format) : '';
}

/**
 * The row's 56x56 tile (right end, radius 10, cropped): a post's first image,
 * "Aa" for a text post; a concept's first image file, a file icon when it
 * holds only documents, and the dashed outline when it has no files.
 */
function RowTile(props: {
  item: PlanItemRow;
  thumb: string | null;
  conceptThumb?: ConceptThumb | null;
  muted: boolean;
}): ReactElement {
  if (props.item.kind === 'concept') {
    const concept = props.conceptThumb ?? null;
    if (concept !== null && concept.kind === 'image' && !props.muted) {
      return (
        <span
          data-plan-row-tile="concept-image"
          className="h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-panel-2"
        >
          <Thumbnail
            assetVersionId={concept.versionId}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            fallback={{ kind: 'glyph' }}
            alt=""
          />
        </span>
      );
    }
    if (concept !== null && concept.kind === 'file' && !props.muted) {
      return (
        <span
          data-plan-row-tile="concept-file"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] bg-panel-3 text-fg-3"
        >
          <IconFile size={ICON_SIZE.tray} />
        </span>
      );
    }
    return (
      <span
        data-plan-row-tile="concept"
        className="h-14 w-14 shrink-0 rounded-[10px] border-[1.5px] border-dashed border-border-strong"
      />
    );
  }
  if (props.thumb !== null) {
    return (
      <span
        data-plan-row-tile="image"
        className="h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-panel-2"
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
        'flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] text-xl font-semibold',
        props.muted ? 'bg-panel-2 text-fg-3' : 'bg-accent-soft text-accent',
      )}
    >
      {props.muted ? '' : 'Aa'}
    </span>
  );
}

function PlanRow(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  thumb: string | null;
  conceptThumb?: ConceptThumb | null;
  dimmed: boolean;
  /** The day's date tile on its first row; null on the rows under it. */
  tile: ReactNode;
  /** The workspace zone (the date line). */
  timeZone?: string;
  /** Other live plans this post sits in (the Also in pill). */
  alsoIn?: readonly string[];
  /** The row's plan day (the edit chip's label). */
  day?: string | null;
  onOpen: () => void;
  /** PLAN: OK (behind the Undo toast). */
  onPlanOk: () => void;
  /** PLAN: Not OK (the Item screen with the note box open). */
  onPlanNotOk: () => void;
  /** Edit mode: the grip lifts the row. */
  onDragStart?: (itemId: string, row: HTMLElement, clientY: number) => void;
  /** Edit mode: grip, day chip, remove (laptop: right-click, keyboard). */
  edit?: PlanRowEdit;
}): ReactElement {
  const onDragStart = props.onDragStart;
  const edit = props.edit;
  const zone = props.timeZone ?? 'UTC';
  const id = props.item.id;
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef('');
  const title = rowTitle(props.bundle, props.item);
  const date = itemDateLabel(props.bundle, props.item, zone);
  const alsoIn = alsoInLabel(props.alsoIn ?? []);
  const dim = props.dimmed && 'opacity-25';
  // The tile column stays 56px wide on every row, so titles align.
  const tileCol = props.tile ?? <span aria-hidden="true" className="w-14 shrink-0" />;
  const dateLine = (
    <span
      data-plan-row-date={date.dated ? 'dated' : 'none'}
      className={cn('sr-only', date.dated && 'font-mono')}
    >
      {date.label}
    </span>
  );
  const titleText = (muted: boolean): ReactElement => (
    <span
      data-plan-row-title=""
      className={cn(
        'line-clamp-2 break-words text-base font-medium',
        muted ? 'text-fg-2' : 'text-fg',
      )}
    >
      <Highlight text={title} />
    </span>
  );
  if (draftLocked(props.bundle, props.item, props.side)) {
    // Name only: no PLAN control, no open, no hover.
    return (
      <div data-plan-row-wrap={id} className="flex w-full min-w-0 items-start gap-3">
        {tileCol}
        <div
          role="button"
          aria-disabled="true"
          data-plan-row={props.item.id}
          data-plan-row-draft="locked"
          onContextMenu={(event) => event.preventDefault()}
          className={cn('flex min-w-0 flex-1 cursor-default items-start gap-3', NO_TOUCH_SELECT)}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {titleText(true)}
            <span className="truncate text-sm text-fg-3">{DRAFT_NOT_READY}</span>
            {dateLine}
          </span>
          <RowTile item={props.item} thumb={null} muted />
        </div>
      </div>
    );
  }
  const picked = edit?.pickedId === id;
  const meta = rowMeta(props.bundle, props.item);
  const rowButton = (
    <button
      type="button"
      data-plan-row={props.item.id}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        // Edit mode rows do not open: the row's controls are the grip, chip and remove.
        if (edit !== undefined) return;
        props.onOpen();
      }}
      {...(picked ? { 'data-plan-row-picked': '' } : {})}
      className={cn(
        'flex w-full min-w-0 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        picked && 'ring-2 ring-accent ring-offset-2 ring-offset-panel',
        edit !== undefined && 'cursor-default',
        NO_TOUCH_SELECT,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {titleText(false)}
        {meta !== '' ? (
          <span data-plan-row-meta="" className="truncate text-sm text-fg-3">
            {meta}
          </span>
        ) : null}
        {alsoIn !== null ? (
          <span
            data-plan-row-also-in=""
            className="inline-flex max-w-full self-start truncate rounded px-1.5 text-xs font-semibold bg-warn-soft text-warn"
          >
            {alsoIn}
          </span>
        ) : null}
        {dateLine}
      </span>
      <RowTile
        item={props.item}
        thumb={props.thumb}
        conceptThumb={props.conceptThumb ?? null}
        muted={false}
      />
    </button>
  );
  const lines = (
    <PlanStatusLines
      bundle={props.bundle}
      item={props.item}
      side={props.side}
      title={title}
      readOnly={edit !== undefined}
      onOk={props.onPlanOk}
      onNotOk={props.onPlanNotOk}
    />
  );
  if (edit !== undefined) {
    // Edit mode: grip | date tile | title block | thumbnail; PLAN and POST as
    // text; the day chip and the remove icon on the row's bottom line.
    return (
      <div
        ref={wrapRef}
        data-plan-row-wrap={id}
        data-plan-row-item={id}
        data-plan-row-edit=""
        {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
        onPointerDownCapture={(event) => {
          lastPointer.current = event.pointerType;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // A touch long-press never opens the menu (the grip drags).
          const native = event.nativeEvent as Partial<PointerEvent>;
          if (native.pointerType === 'touch' || lastPointer.current === 'touch') return;
          if (edit.onMenu === undefined || edit.dragging || wrapRef.current === null) return;
          edit.onMenu(id, wrapRef.current, event.clientX, event.clientY);
        }}
        className={cn('group flex w-full min-w-0 items-start', NO_TOUCH_SELECT)}
      >
        <span className={cn('mr-1 shrink-0', dim)}>
          {onDragStart !== undefined ? (
            <PlanGrip
              onLift={(clientY) => {
                if (wrapRef.current !== null) onDragStart(id, wrapRef.current, clientY);
              }}
            />
          ) : (
            <PlanGripSpacer />
          )}
        </span>
        {tileCol}
        <div className={cn('ml-3 flex min-w-0 flex-1 flex-col', dim)}>
          {rowButton}
          {lines}
          <PlanRowEditButtons
            title={title}
            dayLabel={dropDayLabel(props.day ?? null)}
            dayOpen={edit.dayOpenId === id}
            onDay={(anchor) => edit.onDay(id, anchor)}
            onRemove={() => edit.onRemove(id)}
          />
        </div>
      </div>
    );
  }
  // View mode: date tile | title block | thumbnail, then PLAN and POST.
  return (
    <div
      ref={wrapRef}
      data-plan-row-wrap={id}
      {...(props.dimmed ? { 'data-plan-row-lifted': '' } : {})}
      className="flex w-full min-w-0 items-start gap-3"
    >
      {tileCol}
      <div className={cn('flex min-w-0 flex-1 flex-col', dim)}>
        {rowButton}
        {lines}
      </div>
    </div>
  );
}
