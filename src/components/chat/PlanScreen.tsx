// The Plan screen (full page over the chat, one history step): the plan's
// title, "{range} · Draft" or "{range} · Shared with approvers", progress, and
// one list grouped by each item's plan day (a post slot's day is its post's
// posts.target_date in the workspace zone, a concept's plan_items.target_date)
// for every day of the range ("Planned posts show up here." on an empty day,
// a run of two or more empty days folded into one card, "No date" last; a plan
// longer than a week adds a sticky "Week of" header per week).
//
// Everyone sees the same rows: one calendar date tile (56x56) beside a day's
// first row; a row is the title block (title, format line, "Also in") with the
// thumbnail (56x56) on the right, then two lines: PLAN (the viewer's check of
// the slot) and POST (the post's stage). PLAN is the OK | Not OK switch while
// undecided and a solid pill once decided (tap to change). OK is optimistic
// behind a 4s Undo strip (useUndoableAction; the write goes when the strip
// ends, never after Undo); Not OK opens the Item screen with the note box open.
// A Draft plan shows the team side (agency only, writable), an Open plan the
// client side (a client writes, the agency reads it as text). Tapping a row
// opens the Item screen.
//
// No Edit mode: every change saves itself. Creators get the title menu
// (Rename, Change dates, Delete plan), Add under each day and in the header
// (New concept, Pick a post, From bank), and a ⋯ menu on each row (Open, Move
// to another day, Move to bank on a concept, Remove from plan; long-press on
// touch and right-click on laptop open it too). Move to bank: the row closes
// upward at once (itemOut); plan_item_to_bank goes when its Undo strip ends.
// After the list paints (never before): the rows' buckets ("{format} ·
// {bucket, bucket}", one plan_item_buckets and one posts read) and, for the
// agency, where a concept left this plan ("{title} moved to bank", one
// audit_log and one plan_items read). A move or a
// remove paints at once and is written when its Undo strip ends (one
// plan_save with that one op); Undo takes it back and nothing is written.
// Moving an Open plan's client-approved slot still asks "Keep the approval?"
// first. Last save wins. The footer's one primary button: from a chat "Send to
// approvers in {chat}" on a Draft plan (plan_share_with_client, then
// chat_plan_share; a failed second step offers Retry that only reposts) or
// "Send in {chat}" on an Open plan; outside a chat "Open for approvers" on a
// Draft plan, nothing on an Open one. A send from a chat reads "Sending in
// {chat}…" (disabled); a done "Send in {chat}" reads "Sent" (soft, disabled)
// until a change here, and on reopening while the chat's last send of this
// plan (read with the screen) is newer than the plan's last change.
//
// Live: while open, the screen listens on the plan's private broadcast topic
// (plan:<id>, src/lib/chat/plan-live.ts); any change by anyone re-reads the
// plan in the background, keeping what is shown meanwhile.
// One read per table per open (plans.ts), bounded at 5s; nothing paints until
// that read settles. This file also holds the page frame (phone: a modal
// dialog whose focus moves in and returns on close), the bounded read hook
// and the confirm sheet the other plan screens share.
// Laptop (md and up): the screens dock as a full-height panel beside the chat
// (440px from 972px, 360px below; translateX in).

import { mark } from '@/lib/perf-marks';
import { itemOut } from '@/lib/motion';
import { PlanOpenSendSheet, type PlanOpenSendAsk } from '@/components/chat/PlanOpenSendSheet';
import { BankPickSheet, fromBankDay } from '@/components/pages/plan-tab/BankPickSheet';
import { movedToBankLine } from '@/lib/chat/bank-plan-copy';
import {
  PLAN_ROW_TO_BANK_EVENT,
  moveToBankAction,
  useBankTraces,
  usePlanRowBuckets,
  withRowToBank,
  type PlanRowToBankDetail,
} from '@/lib/chat/plan-bank-extras';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { postUpdate, type PostCardFields } from '@srtdio/posts';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { Card } from '@/components/ui/Card';
import { SECTION_LABEL_INK, Text, TEXT_ROLE } from '@/components/ui/Text';
import { CONTROL_IN_LINE, GUTTER } from '@/components/ui/layout';
import { Input } from '@/components/ui/Input';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { useMenuGesture } from '@/components/ui/useLongPress';
import {
  ICON_SIZE,
  IconCalendar,
  IconChat,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconBank,
  IconFile,
  IconLink,
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
  DELETE_PLAN_LABEL,
  DRAFT_NOT_READY,
  NO_DATE_LABEL,
  OPEN_FOR_CLIENT_BODY,
  OPEN_FOR_CLIENT_LABEL,
  OPEN_FOR_CLIENT_TITLE,
  OPEN_FOR_CLIENT_TOAST,
  PLAN_DELETED_TOAST,
  PLAN_NOT_AVAILABLE,
  PLAN_SAVE_ERROR_COPY,
  PLAN_TITLE_MAX,
  RENAMED_TOAST,
  RENAME_LABEL,
  CHANGE_DATES_LABEL,
  DATES_CHANGED_TOAST,
  MOVE_TO_DAY_LABEL,
  OPEN_ITEM_LABEL,
  REMOVED_TOAST,
  RETRY_LABEL,
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
  deletePlanErrorCopy,
  draftLocked,
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
  PAIR_POST_LABEL,
  linkedPost,
  postItemOf,
  postLine,
  shortDay,
  withoutPairedPosts,
  type LinkedPost,
  slotApprovedToast,
  slotErrorCopy,
  slotSide,
  withReviewOverrides,
  type PostLineTone,
  type PrimaryAction,
  type SendButtonState,
  type StatusPill,
} from '@/components/chat/plan-card';
import { LinkedPostPage, PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { PlanAddSheet } from '@/components/chat/PlanAddSheet';
import {
  PlanKeepApprovalSheet,
  REMOVE_ROW_LABEL,
  type MoveDay,
} from '@/components/chat/PlanMoveSheet';
import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import {
  PlanDatesSheet,
  PlanDayPickerSheet,
  dayPickerSubline,
} from '@/components/chat/PlanDayPickerSheet';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import {
  applyPlanOps,
  findItem,
  flattenOrder,
  hasTicks,
  isNoop,
  moveItem,
  rebuildOps,
  type DayIds,
} from '@/lib/chat/plan-drag';
import { dayMoveToast, othersIn } from '@/lib/chat/plan-keyboard-move';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import {
  LATE_READ_GRACE_MS,
  READ_TIMEOUT_MS,
  readProfiles,
  withLateRead,
  withReadTimeout,
  type ChatProfile,
} from '@/lib/chat-reads';
import { peekWorkspaceMembers } from '@/lib/workspace-members';
import { newMessageId } from '@/lib/chat/message-id';
import { sharePlanToChannel } from '@/lib/chat/share-plan';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { fetchMemberRole } from '@/lib/assets';
import { useModalFocus } from '@/lib/modal-focus';
import { useSession } from '@/lib/session-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { subscribePlanLive } from '@/lib/chat/plan-live';
import { bankIdeaMovedIn } from '@/lib/chat/plan-item-bank';
import {
  PLAN_CHANGED_EVENT,
  dispatchPlanChanged,
  planChangedId,
  conceptAddArgs,
  groupPostsByDay,
  planItemDayInZone,
  skippedOutsideNote,
  splitPickedByRange,
  readPlanBundles,
  readPlanScreen,
  refusedForClient,
  bucketLine,
  tracesByDay,
  type BankTrace,
  type RowBuckets,
  type ComposeRange,
  type ConceptThumb,
  type PlanBundle,
  type PlanItemRow,
  type NameRow,
  type PlanScreenData,
  type ReviewSide,
  type ReviewStatus,
} from '@/lib/chat/plans';
import { safeTimeZone } from '@/lib/time';
import { HISTORY_STEP_KEYS, useHistoryStep } from '@/lib/chat/use-history-step';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { formatLabel } from '@/lib/post-detail-presentation';
import { logger } from '@/lib/logger';
import {
  EDGE_BACK_CLOSE_PX,
  Bone,
  BoxSkeleton,
  EDGE_BACK_ZONE_PX,
  growFromTrigger,
  pushBack,
  pushIn,
  pushSettle,
  skipForUATransition,
  useDragDismiss,
  usePresence,
} from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import { TODAY_LABEL } from '@/lib/plan-tab';
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
import { errorText } from '@/lib/error-copy';
import { CountBadge } from '@/components/ui/CountBadge';
import {
  peekEntityUnreadComment,
  unreadCommentsLabel,
  useEntityUnread,
} from '@/lib/inbox/unread-entities';

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
/** Open layers that take Escape before a plan panel does. */
export const PANEL_ESCAPE_YIELD = '[aria-modal="true"], [role="menu"]';

export const IN_PANEL_ESCAPE_OWNERS = '[aria-label="Image viewer"]';

/** Whether a keydown target is a text field (Escape there leaves the field). Pure. */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return (
    el?.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName ?? '')
  );
}

/**
 * A plan surface. Phone (below md): a full page over the chat that pushes in
 * from the right (docs/motion.md, push: 280 ms in, 240 ms back, a drag from
 * the left 28 px follows the finger and closes past 130 px or on a flick,
 * skipped when the browser already animated the back; the incoming edge is a
 * 1px ring), header with a 44px back (or close) button; a modal dialog
 * (role dialog, aria-modal) whose focus moves in on open and returns to the
 * opener on close (useModalFocus). Laptop (md and up): a right-docked panel,
 * full height and at its final width from its first frame (PLAN_PANEL_WIDTH),
 * border-left, lit as an overlay below 1180px (it sits over the chat) and
 * flat from 1180px (beside the list), no scrim,
 * not modal (role complementary), at once (laptop pane switches are
 * instant), a close X in the header. Opening focuses its
 * heading; closing hands focus back to what opened it. Escape: a key inside
 * the panel is the panel's alone (it never reaches the chat): an in-flow
 * viewer inside it first (handed the key on window only), then the screen's
 * own layer (`onEscape`), a text field next (it is left), else Back. On the
 * page itself (focus on body) it closes the topmost panel only when no other
 * surface is open. Both: a scrolling body and an optional footer, rendered
 * into the body so no ancestor clips it; sheets (z-sheet) stack above it.
 */
export function PlanPage(props: {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  backLabel: string;
  onBack: () => void;
  /** Laptop: keep the back button (the Item screen's Back to the list). */
  desktopBack?: boolean;
  /** Laptop: the header X (default: onBack). */
  onDismiss?: () => void;
  /** Laptop: the header X's label. */
  closeLabel?: string;
  /** Laptop: Escape for an inner layer (drag, pick-up, popover, menu, rename); true when taken. */
  onEscape?: () => boolean;
  footer?: ReactNode;
  /** A header action (44px) after the title column, e.g. an overflow button (last, on the trailing rule). */
  action?: ReactNode;
  /** Replaces the title line (the agency's menu button, the inline rename). */
  titleSlot?: ReactNode;
  /** The Plan screen's view actions (Add), before the ⋯ / X in the bar's actions. */
  twoLine?: { actions?: ReactNode };
  /** Drawn under the header, anchored to it (the header menu). */
  overlay?: ReactNode;
  /** The scrolling body (a drag auto-scrolls it). */
  bodyRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
  testId: string;
}): ReactElement | null {
  const desktop = useIsLaptop();
  // Where an edge drag let go (px), so the back push starts under the finger.
  const dragXRef = useRef(0);
  // Push (phone only; laptop instant): the page renders at rest on its first
  // frame and the move is laid over it. Back is skipped when the browser
  // already animated it (iPhone swipe).
  const { rendered, ref: pageRef } = usePresence<HTMLDivElement>(props.open, {
    enter: (el) => {
      dragXRef.current = 0;
      if (!desktop) pushIn(el);
    },
    exit: (el) => {
      const fromX = dragXRef.current;
      dragXRef.current = 0;
      el.style.transform = '';
      return pushBack(desktop || skipForUATransition() ? null : el, null, fromX);
    },
  });
  const edgeBack = useDragDismiss({
    axis: 'x',
    direction: 1,
    closeAt: EDGE_BACK_CLOSE_PX,
    edgeZone: EDGE_BACK_ZONE_PX,
    enabled: !desktop && props.open,
    onMove: (offset) => {
      dragXRef.current = offset;
      const el = pageRef.current;
      if (el !== null) el.style.transform = `translateX(${offset}px)`;
    },
    // The screen's own back path; the exit push starts where the finger let go.
    onDismiss: () => onBackRef.current(),
    onCancel: (offset) => {
      dragXRef.current = 0;
      const el = pageRef.current;
      if (el === null) return;
      el.style.transform = '';
      pushSettle(el, offset);
    },
  });
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
      // An open modal or menu (a popover from inside the panel) takes Escape
      // first (escape-stack); the panel only closes on the next one.
      if (event.key !== 'Escape' || document.querySelector(PANEL_ESCAPE_YIELD) !== null) return;
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
  if (!rendered) return null;
  const showBack = !desktop || props.desktopBack === true;
  // One exit per panel: the X shows only where there is no back "<". It is the
  // bar's last action, so the bar's trailing rule puts its glyph on the edge.
  const closeButton =
    desktop && !showBack ? (
      <IconButton
        type="button"
        label={props.closeLabel ?? 'Close'}
        data-plan-close=""
        onClick={props.onDismiss ?? props.onBack}
      >
        <IconX size={ICON_SIZE.control} />
      </IconButton>
    ) : null;
  const actions =
    props.twoLine?.actions !== undefined || props.action !== undefined || closeButton !== null ? (
      <>
        {props.twoLine?.actions}
        {props.action}
        {closeButton}
      </>
    ) : undefined;
  return createPortal(
    <div
      ref={pageRef}
      {...(desktop ? { role: 'complementary' } : { role: 'dialog', 'aria-modal': 'true' as const })}
      aria-label={props.title}
      tabIndex={-1}
      data-plan-page={props.testId}
      {...(desktop ? { 'data-plan-desktop': '' } : {})}
      {...(desktop && props.open ? { 'data-plan-panel': '' } : {})}
      {...(desktop ? {} : edgeBack)}
      className={cn(
        desktop
          ? // Laptop: the box is final on its first frame and appears at once.
            cn(
              'fixed inset-y-0 right-0 z-dock flex flex-col border-l bg-panel pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] max-[1179px]:lit-overlay min-[1180px]:border-border',
              PLAN_PANEL_WIDTH,
            )
          : // Phone: the push's incoming edge is a 1px ring, no shadow.
            'fixed inset-0 z-dock flex flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] ring-1 ring-border',
        'focus:outline-none',
      )}
    >
      {/* The one header bar: back "<" (leading pull), the title (title role)
          with its subtitle line, the actions (Add, ⋯, the laptop X) last on
          the trailing rule. */}
      <HeaderBar
        title={<Highlight text={props.title} />}
        {...(showBack ? { onBack: props.onBack, backProps: { label: props.backLabel } } : {})}
        {...(props.subtitle !== undefined
          ? { subtitle: <span data-plan-page-subtitle="">{props.subtitle}</span> }
          : {})}
        {...(props.titleSlot !== undefined ? { titleSlot: props.titleSlot } : {})}
        titleProps={{
          'data-plan-page-titles': '',
          ...(desktop ? { 'data-plan-heading': '', tabIndex: -1 } : {}),
        }}
        {...(actions !== undefined ? { actions } : {})}
        {...(props.overlay !== undefined ? { overlay: props.overlay } : {})}
        compact
      />
      <div
        ref={props.bodyRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-bg"
      >
        {props.children}
      </div>
      {props.footer !== undefined ? (
        <div className={cn('shrink-0 border-t bg-panel py-3 lit-dock', GUTTER)}>{props.footer}</div>
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
 * keeping what is shown; a reload from the error state (Retry) shows loading
 * at once. A reload that fails while data is shown keeps it and bumps
 * `refreshFailed`, so the screen can say so (never unconfirmed data in
 * silence). Aborted on close, key change and unmount.
 */
export function useScreenRead<T>(
  open: boolean,
  key: string,
  run: (signal: AbortSignal) => Promise<Result<T>>,
): { read: ScreenRead<T>; reload: () => void; refreshFailed: number } {
  const [read, setRead] = useState<ScreenRead<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const [refreshFailed, setRefreshFailed] = useState(0);
  // Whether data is on screen now (a failed reload keeps it).
  const shownRef = useRef(false);
  shownRef.current = read.status === 'ready';
  const runRef = useRef(run);
  runRef.current = run;
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seenKey.current = null;
      setRead({ status: 'loading' });
      return;
    }
    // A new key starts from loading; a reload keeps what is shown, but a
    // Retry after a failed read shows loading right away.
    if (seenKey.current !== key) setRead({ status: 'loading' });
    else setRead((prev) => (prev.status === 'error' ? { status: 'loading' } : prev));
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
      if (result.ok) {
        setRead({ status: 'ready', data: result.data });
        return;
      }
      if (shownRef.current) setRefreshFailed((n) => n + 1);
      else setRead({ status: 'error' });
    });
    return () => cancel.abort();
  }, [open, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { read, reload, refreshFailed };
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
        <Input
          type="date"
          data-plan-concept-date=""
          value={props.value}
          disabled={props.disabled === true}
          onChange={(e) => props.onChange(e.target.value)}
          className="min-w-0 flex-1 font-mono disabled:text-fg-3"
        />
        {props.value !== '' ? (
          <IconButton
            type="button"
            label="Clear date"
            data-plan-concept-date-clear=""
            disabled={props.disabled === true}
            onClick={() => props.onChange('')}
            className="shrink-0 text-fg-3"
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
        'inline-flex min-h-6 items-center rounded-lg px-2 text-md lit-pill',
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
          className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-panel-2 p-3 lit-card-muted"
        >
          <span className={TEXT_ROLE.section}>
            {box.label}
          </span>
          <span className="truncate font-mono text-md text-fg">{box.text}</span>
          <span className="block h-1 overflow-hidden rounded-full bg-panel-3 lit-well">
            <span
              data-plan-progress-bar={box.tone}
              className={cn('block h-1 lit-fill', box.bar)}
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
    <BoxSkeleton lit="flat" label="Loading plan" className="flex flex-col gap-2 p-4">
      <Bone lit="lit-well" className="h-1.5 w-full rounded-full" />
      <Bone lit="lit-well" className="h-10 w-48 rounded-full" />
      {[0, 1, 2].map((i) => (
        <Bone lit="lit-card" key={`bone-${i}`} className="h-24 w-full rounded-xl" />
      ))}
    </BoxSkeleton>
  );
}

/** The screens' load-failure copy (the failed body, and a failed re-read's toast). */
export const SCREEN_LOAD_FAILED = errorText('load', null);

/** A read that failed: neutral copy and a Retry. */
export function ScreenFailed(props: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-base text-fg-2">{SCREEN_LOAD_FAILED}</p>
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

/**
 * The approvers' names the workspace members read already holds, and the ids
 * it lacks (an ex-member, or no members read in this window). Pure.
 */
export function namesFromMembers(
  ids: readonly string[],
  profiles: ReadonlyMap<string, ChatProfile> | null,
): { known: NameRow[]; missing: string[] } {
  const known: NameRow[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const profile = profiles?.get(id);
    if (profile !== undefined) known.push({ userId: id, displayName: profile.displayName });
    else missing.push(id);
  }
  return { known, missing };
}

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
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side } = useViewerSide(workspaceId);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const toast = useToast();
  const undoable = useUndoableAction();
  const planId = props.planId;
  const sentInChannelId = props.chat?.channelId;
  // The approvers' names come from the workspace members this session already
  // read (the shell, Settings, the approvers' pickers): no request when every
  // approver is there; only the ones it lacks (an ex-member) are read.
  const readApproverNames = async (
    ids: string[],
    signal?: AbortSignal,
  ): Promise<Result<NameRow[]>> => {
    const members =
      me !== null && workspaceId !== null ? peekWorkspaceMembers(me, workspaceId) : null;
    const { known, missing } = namesFromMembers(ids, members?.profiles ?? null);
    if (missing.length === 0) return { ok: true, data: known };
    const rest = await readProfiles(supabase, missing, signal);
    if (!rest.ok) return known.length > 0 ? { ok: true, data: known } : rest;
    return { ok: true, data: [...known, ...rest.data] };
  };
  const { read, reload, refreshFailed } = useScreenRead<PlanScreenData>(
    props.open,
    `${planId}:${workspaceId ?? ''}:${timeZone}:${sentInChannelId ?? ''}`,
    // One plan_bundle_read (the plan, its rows, tiles, Also in and the last
    // send into this chat), then only the approver names the members lack.
    (signal) =>
      readPlanScreen(supabase, planId, signal, {
        timeZone,
        approvers: approverIds,
        readNames: (ids, s) => readApproverNames(ids, s),
        sentInChannelId,
        ...(workspaceId !== null ? { workspaceId } : {}),
      }),
  );
  const [itemId, setItemId] = useState<string | null>(props.initialItemId ?? null);
  // A pair's linked post that is not a post item in this plan, opened alone.
  const [linkedOpenId, setLinkedOpenId] = useState<string | null>(null);
  // The Item screen was opened by a row's Not OK: its note box opens focused.
  const [askChanges, setAskChanges] = useState(false);
  // A row opened with unread comments lands on the newest one (read at tap
  // time: opening the item marks them read and clears the marker).
  const [rowHighlight, setRowHighlight] = useState<string | null>(null);
  const entryItemId = props.initialItemId ?? null;
  // Add: the sheet (its target; null = closed), the concept sheet, the picker.
  const [addFor, setAddFor] = useState<AddTarget | null>(null);
  const [conceptFor, setConceptFor] = useState<AddTarget | null>(null);
  const [conceptForm, setConceptForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [conceptBusy, setConceptBusy] = useState(false);
  const [pickFor, setPickFor] = useState<AddTarget | null>(null);
  // From bank: the day the picked idea goes on (null = closed).
  const [bankDay, setBankDay] = useState<string | null>(null);
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
  // The mode of the last send (true: the second step of "Send to approvers"):
  // the footer's Retry sends the same way, so its failure reads the same.
  const sendAfterOpenRef = useRef(false);
  const [keepAsk, setKeepAsk] = useState<KeepAsk | null>(null);
  const [sendGuard] = useState(createInFlightGuard);
  const { canAttach, uploadFile } = useCommentAttachments();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Autosave: a move or a remove paints at once as a plan_save op laid over
  // the read, and is written when its Undo strip ends (one op per write). A
  // written op stays painted until the re-read lands; Undo or a failed write
  // takes it back off. The row whose ⋯ menu or day picker is open.
  const [ops, setOps] = useState<PlanSaveOp[]>([]);
  const writtenOps = useRef(new Set<PlanSaveOp>());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dayFor, setDayFor] = useState<string | null>(null);
  const [datesOpen, setDatesOpen] = useState(false);
  // Move to bank: rows that left at once (itemOut), their write behind Undo.
  const [bankHidden, setBankHidden] = useState<ReadonlySet<string>>(new Set());
  // Move to bank from the item screen: the row leaves here at once too.
  useEffect(() => {
    const on = (event: Event): void => {
      const detail = (event as CustomEvent<PlanRowToBankDetail>).detail;
      if (detail !== undefined) setBankHidden((prev) => withRowToBank(prev, detail));
    };
    window.addEventListener(PLAN_ROW_TO_BANK_EVENT, on);
    return () => window.removeEventListener(PLAN_ROW_TO_BANK_EVENT, on);
  }, []);
  // The Open and send sheet (a Draft plan refused for a chat with approvers).
  const [openSendAsk, setOpenSendAsk] = useState<PlanOpenSendAsk | null>(null);
  useHistoryStep(
    itemId !== null && itemId !== entryItemId && props.open,
    HISTORY_STEP_KEYS.planItem,
    () => setItemId(null),
  );
  // The linked post opens on the item layer's step (one item layer at a time).
  useHistoryStep(
    linkedOpenId !== null && itemId === null && props.open,
    HISTORY_STEP_KEYS.planItem,
    () => setLinkedOpenId(null),
  );

  // A closed screen forgets its item, sheets, edits and local state.
  useEffect(() => {
    if (props.open) return;
    setItemId(null);
    setLinkedOpenId(null);
    setSlotOverrides({});
    setAddFor(null);
    setConceptFor(null);
    setPickFor(null);
    setBankDay(null);
    setPicked([]);
    // The header "+" day sheets and their notes never come back on the next open.
    setOutside(null);
    setSkippedNotes([]);
    setMenuOpen(false);
    setRenaming(null);
    setOpenConfirm(false);
    setOpenError(null);
    setSendError(null);
    setSentHere(null);
    setKeepAsk(null);
    setOps([]);
    writtenOps.current.clear();
    setMenuFor(null);
    setDayFor(null);
    setDatesOpen(false);
    setBankHidden(new Set());
    setOpenSendAsk(null);
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
  // Live: a change by anyone (a comment, OK / Not OK, a move, a rename) is
  // announced on the plan's topic; it re-reads every open plan surface the
  // same way a local write does. Starts after paint, never holds it.
  useEffect(() => {
    if (!props.open) return;
    return subscribePlanLive(supabase, planId, () => dispatchPlanChanged(window, planId));
  }, [props.open, planId]);

  const readBundle = read.status === 'ready' ? read.data.bundle : null;
  if (readBundle !== null) mark('plan:ready');
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
  // A written op stays painted until the re-read lands (no flash of the old
  // list), then goes; an op still behind its Undo strip stays.
  useEffect(() => {
    const written = writtenOps.current;
    if (written.size === 0) return;
    setOps((prev) => prev.filter((op) => !written.has(op)));
    written.clear();
  }, [shownBundle]);
  // A re-read that failed while the screen shows data (after a save, an add,
  // a tick): the load-failure copy as a toast with Retry, never silence.
  const seenRefreshFailed = useRef(refreshFailed);
  useEffect(() => {
    if (refreshFailed === seenRefreshFailed.current) return;
    seenRefreshFailed.current = refreshFailed;
    if (!props.open) return;
    toast.show({
      title: SCREEN_LOAD_FAILED,
      tone: 'error',
      action: { label: RETRY_LABEL, onPress: reload },
    });
    // toast is the provider's stable api.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshFailed, props.open, reload]);
  const bundle = useMemo(() => {
    if (shownBundle === null) return null;
    const ticked =
      slot !== null ? withReviewOverrides(shownBundle, slot, slotOverrides) : shownBundle;
    const moved = withoutItems(ticked, bankHidden);
    return ops.length > 0 ? applyPlanOps(moved, ops, timeZone) : moved;
  }, [shownBundle, slot, slotOverrides, ops, timeZone, bankHidden]);
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
  // The list shows a linked concept and its post as one pair: the post item
  // the pair stands in for is left out (its data untouched). A move's order
  // is taken from every live item (allGroups), so a write always names them all.
  const groups = useMemo(
    () => (bundle !== null ? planListGroups(withoutPairedPosts(bundle), timeZone, side) : []),
    [bundle, timeZone, side],
  );
  const allGroups = useMemo(
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
  // After paint: the rows' buckets (everyone) and the moved-to-bank traces
  // (agency only). One read per table, never before the list paints.
  const rowBuckets = usePlanRowBuckets({
    client: supabase,
    enabled: props.open && shownBundle !== null,
    bundle: shownBundle,
  });
  const tracePlans = useMemo(() => (shownBundle !== null ? [shownBundle.plan] : []), [shownBundle]);
  const traces = useBankTraces({
    client: supabase,
    enabled: props.open && side === 'agency' && shownBundle !== null,
    workspaceId: shownBundle?.plan.workspace_id ?? null,
    plans: tracePlans,
    timeZone,
  });
  const dayTraces = useMemo(() => {
    const live = new Set((bundle?.items ?? []).map((i) => i.id));
    return tracesByDay((traces.get(planId) ?? []).filter((t) => !live.has(t.itemId)));
  }, [traces, planId, bundle]);
  // A moved row stays hidden until the re-read no longer holds it, then the
  // id is let go (so the idea can come back into this plan later).
  useEffect(() => {
    if (shownBundle === null) return;
    setBankHidden((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(shownBundle.items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownBundle]);
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
      toast.show({ title: errorText('rename', result.error) });
      return;
    }
    setRenaming(null);
    toast.show({ title: RENAMED_TOAST });
    dispatchPlanChanged(window, planId);
  };

  // Delete plan: at once, no confirm. The screen closes and the bottom strip
  // offers Undo for UNDO_MS (useUndoableAction); the write goes only when the
  // strip ends, or at once when the page is hidden, the app is switched or
  // the screen unmounts (so it is never lost); Undo means it never goes. A
  // failed write says so in the bad tone.
  const commitDelete = async (): Promise<void> => {
    const traceId = generateTraceId();
    const result = await planDelete(supabase, { p_plan_id: planId, p_trace_id: traceId });
    if (!result.ok) {
      logger.warn('chat: plan delete failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: deletePlanErrorCopy(result.error.message), tone: 'error' });
      return;
    }
    dispatchPlanChanged(window, planId);
  };
  const deletePlan = (): void => {
    props.onClose();
    undoable.run({ label: PLAN_DELETED_TOAST, commit: commitDelete });
  };

  const chat = props.chat ?? null;
  // Send the card into the chat the screen was opened from: one
  // chat_plan_share (the open thread adds the row and publishes it live).
  // `afterOpen`: the second step of "Send to approvers"; its failure says the
  // plan is open and offers a Retry that only reposts.
  const sendHere = async (afterOpen = false): Promise<void> => {
    if (chat === null || sendBusy || sendingRef.current) return;
    sendingRef.current = true;
    sendAfterOpenRef.current = afterOpen;
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
      if (!afterOpen && refusedForClient(result.message) && bundle !== null) {
        // A Draft plan into a chat with approvers: ask to open it first.
        setOpenSendAsk({
          planId,
          planTitle: bundle.plan.title,
          channelId: chat.channelId,
          chatName: chat.name,
        });
        return;
      }
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
      setOpenError(errorText('open for approvers', result.error));
      // From the Open and send sheet the error has no confirm sheet to sit in.
      if (openSendAsk !== null) {
        setOpenSendAsk(null);
        toast.show({ title: errorText('open for approvers', result.error), tone: 'error' });
      }
      return;
    }
    setOpenConfirm(false);
    setOpenSendAsk(null);
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
      // Retry only reposts the card, the same way as the send that failed.
      void sendHere(sendAfterOpenRef.current);
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
    mark('plan:ok:tap');
    slotWriting.current.add(item.id);
    mark('plan:ok:optimistic');
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
        mark('plan:ok:rpc:end');
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
    // Read-only (the agency on an Open plan) never writes.
    if (bundle === null || slot === null) return;
    const previous = reviewStatus(bundle, item.id, slot);
    if (previous === 'approved') return;
    const day = planItemDayInZone(item, bundle.postInfo, timeZone);
    const dayHeader = day !== null ? formatCivilDayHeader(day) : null;
    tickSlot(item, slot, previous, dayHeader);
  };
  const planNotOk = (item: PlanItemRow): void => {
    if (bundle === null || slot === null) return;
    // A pending OK goes first, so the note's 'changes' lands after it.
    undoable.flush();
    setAskChanges(true);
    setRowHighlight(null);
    setItemId(item.id);
  };

  // Autosave. A move or a remove paints at once (an op over the read) and is
  // written when its Undo strip ends: one read of the plan as it is now, the
  // op rebuilt on it (rebuildOps), then one plan_save with that op. A write
  // that finds something gone ("no longer available") reads once more and
  // retries once. Undo, or a failed write, takes the op back off the paint.
  // Last save wins: the procs never reject a stale order.
  const sendQueued = async (
    queued: readonly PlanSaveOp[],
    traceId: string,
  ): Promise<Awaited<ReturnType<typeof planSave>>> => {
    const fresh = await withReadTimeout((signal) =>
      readPlanBundles(supabase, [planId], signal, timeZone, workspaceId ?? undefined),
    );
    if (!fresh.ok) return { ok: false, error: { code: 'unknown', message: fresh.error.message } };
    const now = fresh.data.get(planId);
    if (now === undefined) {
      return { ok: false, error: { code: 'unknown', message: 'invalid_payload' } };
    }
    const rebuilt = rebuildOps(now, queued, timeZone);
    // Everything this op touched is gone already: nothing left to write.
    if (rebuilt.length === 0) return { ok: true, data: undefined };
    try {
      return await planSave(supabase, { p_plan_id: planId, p_ops: rebuilt, p_trace_id: traceId });
    } catch (thrown) {
      return { ok: false, error: { code: 'unknown', message: String(thrown) } };
    }
  };
  const autosave = (op: PlanSaveOp, label: string): void => {
    setOps((prev) => [...prev, op]);
    undoable.run({
      label,
      commit: async () => {
        const traceId = generateTraceId();
        let result = await sendQueued([op], traceId);
        if (
          !result.ok &&
          planSaveErrorCopy(result.error.message) === PLAN_SAVE_ERROR_COPY.invalid_payload
        ) {
          result = await sendQueued([op], traceId);
        }
        if (!result.ok) {
          logger.warn('chat: plan autosave failed', {
            trace_id: traceId,
            plan_id: planId,
            op: op.op,
            error: result.error.message,
          });
          throw new Error(planSaveErrorCopy(result.error.message));
        }
        writtenOps.current.add(op);
        dispatchPlanChanged(window, planId);
      },
      revert: () => setOps((prev) => prev.filter((queued) => queued !== op)),
    });
  };

  // A day pick (the row's ⋯ menu): one 'move' op, the item's new day and the
  // plan's full new order, saved behind Undo. On an Open plan a day change of
  // a client-approved slot asks "Keep the approval?" first (cancelling
  // cancels the move); every other move resets (false).
  const commitMove = (
    moved: string,
    toDay: string | null,
    toIndex: number,
    keep: boolean,
  ): void => {
    if (bundle === null || !agency) return;
    const item = bundle.items.find((i) => i.id === moved);
    const days = planDayIds(allGroups);
    const from = findItem(days, moved);
    if (item === undefined || from === null) return;
    if (isNoop(days, moved, { day: toDay, index: toIndex })) return;
    const order = flattenOrder(moveItem(days, moved, toDay, toIndex));
    // Nothing is reset until the write, so Undo is always offered.
    const resets = !keep && from.day !== toDay && hasTicks(bundle, moved);
    autosave(
      { op: 'move', item_id: moved, target_date: toDay, item_ids: order, keep_reviews: keep },
      dayMoveToast(dayHeaderOf(toDay), item.kind === 'post', resets).title,
    );
  };
  const moveTo = (moved: string, toDay: string | null, toIndex: number): void => {
    if (bundle === null) return;
    const item = bundle.items.find((i) => i.id === moved);
    const from = findItem(planDayIds(allGroups), moved);
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
  // Remove from plan: one 'remove' op, the row goes at once, saved behind Undo.
  const removeRow = (id: string): void => {
    if (!agency) return;
    setDayFor(null);
    autosave({ op: 'remove', item_id: id }, REMOVED_TOAST);
  };
  // Move to bank (concepts, agency): the row closes upward at once (itemOut)
  // and leaves the list; plan_item_to_bank fires when the Undo strip ends.
  const moveRowToBank = (id: string): void => {
    if (!agency) return;
    setMenuFor(null);
    const row =
      bodyRef.current?.querySelector<HTMLElement>(`[data-plan-row-wrap="${CSS.escape(id)}"]`) ??
      null;
    // Undo while the row is still closing: it never hides.
    let back = false;
    const show = (): void => {
      back = true;
      for (const move of row?.getAnimations() ?? []) move.cancel();
      setBankHidden((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };
    undoable.run(
      moveToBankAction({
        client: supabase,
        itemId: id,
        hide: () => {
          const out = itemOut(row);
          const hide = (): void => {
            if (!back) setBankHidden((prev) => new Set(prev).add(id));
          };
          if (out.instant) hide();
          else void out.done.then(hide);
        },
        show,
        onMoved: () => {
          // The Bank's kept page gets the idea at once (no read).
          const moved = bundle?.items.find((i) => i.id === id);
          dispatchPlanChanged(
            window,
            planId,
            moved !== undefined
              ? {
                  kind: 'in',
                  idea: bankIdeaMovedIn(
                    moved,
                    bundle?.plan.title ?? null,
                    new Date().toISOString(),
                  ),
                }
              : undefined,
          );
        },
        onError: (copy) => toast.show({ title: copy, tone: 'error' }),
      }),
    );
  };
  const openItem = (id: string): void => {
    mark('plan:item:open');
    setAskChanges(false);
    setRowHighlight(peekEntityUnreadComment('plan_item', id));
    setItemId(id);
  };
  // A pair's post (or a concept's Post row) opens as a post item opens: the
  // plan's own post item when the post is one, else the post alone.
  const openLinkedPost = (postId: string): void => {
    if (bundle === null) return;
    const postItem = postItemOf(bundle, postId);
    if (postItem !== null && !draftLocked(bundle, postItem, side)) {
      openItem(postItem.id);
      return;
    }
    mark('plan:item:open');
    setItemId(null);
    setLinkedOpenId(postId);
  };
  const moveToDay = (id: string, day: string | null): void => {
    const days = planDayIds(allGroups);
    const from = findItem(days, id);
    if (from === null || from.day === day) return;
    moveTo(id, day, othersIn(days, id, day));
  };
  const dayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of planDayIds(groups)) if (d.day !== null) counts[d.day] = d.ids.length;
    return counts;
  }, [groups]);
  // Change dates (title ⋯ menu): saved at once through plan_update, like Rename.
  const saveDates = async (range: ComposeRange): Promise<void> => {
    if (bundle === null) return;
    setDatesOpen(false);
    if (range.startsOn === bundle.plan.starts_on && range.endsOn === bundle.plan.ends_on) return;
    const traceId = generateTraceId();
    const result = await planUpdate(supabase, {
      p_plan_id: planId,
      p_title: bundle.plan.title,
      p_starts_on: range.startsOn,
      p_ends_on: range.endsOn,
      p_trace_id: traceId,
    });
    if (!result.ok) {
      logger.warn('chat: plan dates change failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: planSaveErrorCopy(result.error.message), tone: 'error' });
      return;
    }
    toast.show({ title: DATES_CHANGED_TOAST });
    dispatchPlanChanged(window, planId);
  };
  // Laptop Escape inside the panel: the innermost layer first; true when taken.
  const onPanelEscape = (): boolean => {
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

  // Add (view mode, instant): a concept on that day, or picked posts on that
  // day. A group's Add with day null is No date (an explicit No date target);
  // the header "+" has no target (day null, noDate false).
  const openAdd = (day: string | null): void => setAddFor({ day, noDate: day === null });
  const openHeaderAdd = (): void => setAddFor({ day: null, noDate: false });
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
  // From bank: onto the Add's day; the header "+" and No date take today when
  // the plan holds it, else its nearest day (plan_item_from_bank needs a day).
  const startFromBank = (): void => {
    if (addFor === null || bundle === null) return;
    setBankDay(addFor.day ?? fromBankDay(bundle.plan, civilToday(new Date(), timeZone)));
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
  // One plan_posts_add; `day` puts every post on that plan day. The raw error
  // message on failure (logged, not toasted), null when added.
  const addPostsQuiet = async (ids: string[], day: string | null): Promise<string | null> => {
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
      return result.error.message;
    }
    return null;
  };
  // addPostsQuiet with its failure toasted. False on failure.
  const addPosts = async (ids: string[], day: string | null): Promise<boolean> => {
    const error = await addPostsQuiet(ids, day);
    if (error === null) return true;
    toast.show({ title: planWriteErrorCopy(error, ADD_FAILED) });
    return false;
  };
  // No date's Add: a post slot's day is its post's date, so each dated post's
  // date is cleared (post_update, target_date null) before the add, whatever
  // its Pipeline date; then one plan_posts_add with no day. False on failure
  // (toasted with the add copy).
  const addPostsNoDate = async (
    posts: ReadonlyArray<PostCardFields & { target_date?: string | null }>,
  ): Promise<boolean> => {
    const dated = posts.filter((p) => p.target_date !== null);
    const cleared = await Promise.all(
      dated.map(async (p) => {
        const traceId = generateTraceId();
        const result = await postUpdate(supabase, { postId: p.id, targetDate: null }, traceId);
        if (!result.ok) {
          logger.warn('chat: plan no date clear failed', {
            trace_id: traceId,
            post_id: p.id,
            error: result.error.message,
          });
        }
        return result;
      }),
    );
    const failed = cleared.find((r) => !r.ok);
    if (failed !== undefined && !failed.ok) {
      toast.show({ title: planWriteErrorCopy(failed.error.message, ADD_FAILED) });
      return false;
    }
    return addPosts(
      posts.map((p) => p.id),
      null,
    );
  };
  const planRange = {
    startsOn: bundle?.plan.starts_on ?? '',
    endsOn: bundle?.plan.ends_on ?? '',
  };
  // The picker's Done: the ticked posts are added to the picker's target.
  const closePicker = async (): Promise<void> => {
    if (pickFor === null) return;
    const day = pickFor.day;
    const posts = picked;
    setPickFor(null);
    setPicked([]);
    setSkippedNotes([]);
    if (posts.length === 0) return;
    if (pickFor.noDate) {
      // No date's Add row: every post goes on No date (target_date null).
      const dated = posts as Array<PostCardFields & { target_date?: string | null }>;
      if (!(await addPostsNoDate(dated))) return;
      toast.show({ title: addedToast('post', null) });
      dispatchPlanChanged(window, planId);
      return;
    }
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
  // Every day is tried (one failure never stops the rest): all added, the
  // success toast; any failed, one error toast (the add copy) and no success
  // toast. Anything added re-reads the plan either way.
  const addOnDays = async (choices: Array<{ postId: string; day: string }>): Promise<void> => {
    const groups = groupPostsByDay(choices);
    let added = 0;
    let firstError: string | null = null;
    for (const group of groups) {
      const error = await addPostsQuiet(group.postIds, group.day);
      if (error === null) added += 1;
      else firstError ??= error;
    }
    if (firstError !== null) {
      toast.show({ title: planWriteErrorCopy(firstError, ADD_FAILED) });
    } else if (added > 0) {
      const only = groups.length === 1 ? groups[0] : undefined;
      toast.show({ title: addedToast('post', only !== undefined ? dayHeaderOf(only.day) : null) });
    }
    if (added > 0) dispatchPlanChanged(window, planId);
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
    bundle !== null && (primary.kind !== 'none' || sendError !== null) ? (
      <PlanFooter
        action={primary}
        busy={sendBusy || openBusy}
        error={sendError}
        state={sendState}
        chatName={chat?.name ?? null}
        onPress={onPrimary}
      />
    ) : undefined;
  // The bar's Add: the shared Button at 44 with IconPlus (B1), before the X.
  // No Edit: every change saves itself.
  const viewActions = (
    <Button
      type="button"
      variant="secondary"
      aria-label="Add to plan"
      data-plan-add-header=""
      onClick={openHeaderAdd}
      className="shrink-0"
    >
      <IconPlus size={ICON_SIZE.inline} />
      Add
    </Button>
  );
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
        onDismiss={props.onClose}
        onEscape={onPanelEscape}
        bodyRef={bodyRef}
        footer={footer}
        {...(renaming === null ? { twoLine: agency ? { actions: viewActions } : {} } : {})}
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
                  onChangeDates={() => {
                    setMenuOpen(false);
                    setDatesOpen(true);
                  }}
                  onDelete={() => {
                    setMenuOpen(false);
                    deletePlan();
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
            className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-warn-soft py-1 pl-3 pr-1 text-md text-warn lit-tint"
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
              className="shrink-0"
            >
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </div>
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
            <PlanBody
              bundle={bundle}
              groups={groups}
              side={side}
              timeZone={timeZone}
              thumbs={read.status === 'ready' ? read.data.thumbs : {}}
              conceptThumbs={read.status === 'ready' ? (read.data.conceptThumbs ?? {}) : {}}
              commentCounts={read.status === 'ready' ? read.data.commentCounts : {}}
              alsoIn={read.status === 'ready' ? (read.data.alsoIn ?? {}) : {}}
              buckets={rowBuckets}
              {...(agency ? { traces: dayTraces } : {})}
              onOpenItem={openItem}
              onOpenLinkedPost={openLinkedPost}
              onPlanOk={planOk}
              onPlanNotOk={planNotOk}
              {...(agency
                ? {
                    onAdd: openAdd,
                    rowMenu: {
                      openId: menuFor,
                      onOpenChange: (id: string, open: boolean) => setMenuFor(open ? id : null),
                      onMove: (id: string) => setDayFor(id),
                      onToBank: moveRowToBank,
                      onRemove: removeRow,
                    },
                  }
                : {})}
            />
          </>
        )}
      </PlanPage>
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
                  : rowHighlight !== null
                    ? { highlightCommentId: rowHighlight }
                    : {}),
              }
            : rowHighlight !== null
              ? { highlightCommentId: rowHighlight }
              : {})}
          onClose={() => (itemId === entryItemId ? props.onClose() : setItemId(null))}
          onDismiss={props.onClose}
          onRemoved={() => setItemId(null)}
          onOpenLinkedPost={openLinkedPost}
        />
      ) : null}
      {bundle !== null && linkedOpenId !== null ? (
        <LinkedPostPage
          open={props.open && itemId === null}
          postId={linkedOpenId}
          subtitle={bundle.plan.title}
          onClose={() => setLinkedOpenId(null)}
          onDismiss={props.onClose}
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
      {agency ? (
        <>
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
          <PlanOpenSendSheet
            ask={props.open ? openSendAsk : null}
            busy={openBusy || sendBusy}
            onClose={() => {
              if (!openBusy) setOpenSendAsk(null);
            }}
            onOpenAndSend={() => {
              sendKindRef.current = 'send-approvers';
              void openForClient(true);
            }}
          />
          <PlanDayPickerSheet
            open={props.open && dayFor !== null}
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
          <PlanDatesSheet
            open={props.open && datesOpen}
            range={planRange}
            onSave={(range) => void saveDates(range)}
            onClose={() => setDatesOpen(false)}
          />
          <PlanAddSheet
            open={props.open && addFor !== null}
            dayHeader={addFor !== null ? dayHeaderOf(addFor.day) : null}
            onNewConcept={startConcept}
            onPickPost={startPick}
            onFromBank={startFromBank}
            onClose={() => setAddFor(null)}
          />
          <BankPickSheet
            open={props.open && bankDay !== null}
            workspaceId={bundle?.plan.workspace_id ?? workspaceId}
            day={bankDay ?? ''}
            today={civilToday(new Date(), timeZone)}
            plans={bundle !== null ? [bundle.plan] : []}
            onClose={() => setBankDay(null)}
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
            // Done adds the ticked posts; a dismiss (X, backdrop, swipe, Back,
            // Esc) drops the selection and adds nothing.
            onDone={() => void closePicker()}
            onClose={() => {
              setPickFor(null);
              setPicked([]);
            }}
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

/** Where an Add goes: a plan day, No date (`noDate`), or the header "+" (day null). */
interface AddTarget {
  day: string | null;
  noDate: boolean;
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
 * The agency's header title: a button with a chevron (18px, 8px gap) that
 * opens the header menu (Rename, Delete plan). The bar's title role on one
 * line; its 44 box sits in the title line without growing the bar.
 */
function PlanTitleButton(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <PressableRow
      type="button"
      inline
      data-plan-title-menu=""
      aria-haspopup="menu"
      aria-expanded={props.open}
      onClick={props.onToggle}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex min-w-0 max-w-full items-center gap-2 self-start',
        CONTROL_IN_LINE,
        NO_TOUCH_SELECT,
      )}
    >
      <Text role="title" data-plan-title-text="" className="min-w-0 truncate">
        {props.title}
      </Text>
      <span aria-hidden="true" className="shrink-0 text-fg-2">
        <IconChevronDown size={ICON_SIZE.nav} />
      </span>
    </PressableRow>
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
  onChangeDates: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  // Grows from its trigger (the title button, top left), on the first frame
  // of an already painted menu (docs/motion.md, growFromTrigger).
  useLayoutEffect(() => {
    if (props.open) growFromTrigger(ref.current, 'top left');
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
        'absolute left-12 top-full z-sticky mt-1 flex w-56 flex-col overflow-hidden rounded-xl border bg-panel py-1 lit-overlay',
        NO_TOUCH_SELECT,
      )}
    >
      <PressableRow
        type="button"
        role="menuitem"
        data-plan-menu-rename=""
        onClick={props.onRename}
        flat
        className="flex items-center gap-3 px-3 text-lg text-fg"
      >
        <IconEdit size={ICON_SIZE.tray} />
        {RENAME_LABEL}
      </PressableRow>
      <PressableRow
        type="button"
        role="menuitem"
        data-plan-menu-dates=""
        onClick={props.onChangeDates}
        flat
        className="flex items-center gap-3 px-3 text-lg text-fg"
      >
        <IconCalendar size={ICON_SIZE.tray} />
        {CHANGE_DATES_LABEL}
      </PressableRow>
      {props.canDelete ? (
        <PressableRow
          type="button"
          role="menuitem"
          data-plan-menu-delete=""
          onClick={props.onDelete}
          flat
          className="flex items-center gap-3 px-3 text-lg text-bad hover:bg-bad-soft"
        >
          <IconTrash size={ICON_SIZE.tray} />
          {DELETE_PLAN_LABEL}
        </PressableRow>
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
      <Input
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
        className="min-w-0 flex-1 font-semibold disabled:text-fg-3"
      />
      <IconButton
        type="button"
        label="Cancel rename"
        data-plan-rename-cancel=""
        disabled={props.busy}
        onClick={props.onCancel}
        className="shrink-0"
      >
        <IconX size={ICON_SIZE.control} />
      </IconButton>
      <Button
        type="button"
        variant="link"
        data-plan-rename-done=""
        disabled={props.busy || !valid}
        onClick={props.onDone}
        className="shrink-0"
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
 * "Sending in {chat}…"; a sent "Send in {chat}" reads "Sent" in the primary
 * button's disabled state (same box, no icon).
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
          variant="primary"
          data-plan-primary={action.kind}
          data-plan-send-state="sent"
          disabled
          className="w-full md:w-auto min-w-0"
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
        // Sending keeps the primary fill (accent sorts after fg-3, so it wins).
        className={cn('w-full md:w-auto min-w-0', state === 'sending' && 'disabled:bg-accent')}
        aria-busy={props.busy}
        disabled={props.busy || state !== 'idle'}
        onClick={props.onPress}
      >
        <span className="truncate">{label}</span>
      </Button>
    </div>
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

/** A row's bucket names: a concept's own (plan_item_buckets), a post's one bucket. Pure. */
export function rowBucketNames(item: PlanItemRow, buckets: RowBuckets | undefined): string[] {
  if (buckets === undefined) return [];
  if (item.kind === 'concept') return buckets.items[item.id] ?? [];
  return item.post_id !== null ? (buckets.posts[item.post_id] ?? []) : [];
}

/**
 * Where a concept left the plan (agency only): a quiet line on that day,
 * "{title} moved to bank" with the bank icon, a dashed edge, never tappable.
 */
export function BankTraceLine(props: { trace: Pick<BankTrace, 'itemId' | 'title'> }): ReactElement {
  return (
    <p
      data-plan-trace={props.trace.itemId}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-fg-3"
    >
      <IconBank size={ICON_SIZE.inline} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{movedToBankLine(props.trace.title)}</span>
    </p>
  );
}

/** A creator's row ⋯ menu: Open, Move to another day, Move to bank, Remove from plan. */
export interface PlanRowMenu {
  /** The row whose menu is open, or null. */
  openId: string | null;
  onOpenChange: (id: string, open: boolean) => void;
  /** Move to another day: opens the day picker for the row. */
  onMove: (id: string) => void;
  /** Move to bank (concepts): the row leaves at once, the write behind Undo. */
  onToBank?: (id: string) => void;
  /** Remove from plan: at once, behind Undo. */
  onRemove: (id: string) => void;
}

export function PlanBody(props: {
  bundle: PlanBundle;
  groups: readonly PlanWeekGroup<PlanItemRow>[];
  side: ViewerSide;
  timeZone: string;
  thumbs: Record<string, string>;
  /** Concept tiles by item id (the first image, or a file tile). */
  conceptThumbs?: Readonly<Record<string, ConceptThumb>>;
  /** Visible comments by item id (the count under each row's tile). */
  commentCounts?: Readonly<Record<string, number>>;
  /** Other plans' titles by post id (the Also in pill). */
  alsoIn?: Readonly<Record<string, string[]>>;
  /** The rows' bucket names (read after paint): concepts by item id, posts by post id. */
  buckets?: RowBuckets;
  /** Agency: the moved-to-bank lines by plan day (read after paint). */
  traces?: ReadonlyMap<string, BankTrace[]>;
  onOpenItem: (id: string) => void;
  /** A pair's post row opens its post. */
  onOpenLinkedPost?: (postId: string) => void;
  /** PLAN: OK on a row (behind the Undo toast). */
  onPlanOk: (item: PlanItemRow) => void;
  /** PLAN: Not OK on a row (the Item screen with the note box open). */
  onPlanNotOk: (item: PlanItemRow) => void;
  /** Creators: a day's Add row (null = No date). */
  onAdd?: (day: string | null) => void;
  /** Creators: each row's ⋯ menu (Open, Move to another day, Remove from plan). */
  rowMenu?: PlanRowMenu;
}): ReactElement {
  const { bundle, side, rowMenu } = props;
  const weeks = planShowsWeeks(bundle.plan.starts_on, bundle.plan.ends_on);
  const today = civilToday(new Date(), props.timeZone);
  return (
    <>
      <PlanProgressRow bundle={bundle} side={side} />
      <div data-plan-list={weeks ? 'weeks' : 'days'} className="flex flex-col gap-4 pb-4 pt-3">
        {props.groups.map((week, w) => (
          <section
            key={week.label ?? `days-${w}`}
            {...(week.label !== null ? { 'data-plan-week': week.label } : {})}
            className="flex flex-col gap-4"
          >
            {week.label !== null ? (
              <h3
                data-plan-week-header=""
                className={cn(
                  `sticky top-0 z-raised bg-bg py-2 ${TEXT_ROLE.section}`,
                  GUTTER,
                )}
              >
                {week.label}
              </h3>
            ) : null}
            {week.days.map((day) => {
              const items = day.items;
              const empty = items.length === 0;
              const dayTraces = day.day !== null ? (props.traces?.get(day.day) ?? []) : [];
              // One date tile per day: on its first row, or beside the empty day's line.
              const tile = <DayColumn day={day.day} today={today} empty={empty} />;
              const emptyBody =
                props.onAdd !== undefined && (day.day === null || day.inRange) ? (
                  <AddRow day={day.day} empty onAdd={props.onAdd} />
                ) : (
                  <p
                    data-plan-day-empty=""
                    className="flex min-h-11 items-center text-md text-fg-3"
                  >
                    Planned posts show up here.
                  </p>
                );
              return (
                <Card
                  key={day.day ?? 'none'}
                  data-plan-day={day.day ?? 'none'}
                  {...(day.day !== null && !day.inRange ? { 'data-plan-day-out': '' } : {})}
                  {...(day.day === today ? { 'data-plan-day-today': '' } : {})}
                  // One card per day on the page edge (16 in, 16 apart); today takes the selected edge.
                  selected={day.day === today}
                  className="mx-4 self-stretch md:mx-6"
                >
                  <div className="flex flex-col gap-4">
                    {items.map((item, index) => (
                      <PlanRow
                        key={item.id}
                        bundle={bundle}
                        item={item}
                        side={side}
                        thumb={item.post_id !== null ? (props.thumbs[item.post_id] ?? null) : null}
                        conceptThumb={props.conceptThumbs?.[item.id] ?? null}
                        pairThumb={
                          item.linked_post_id != null
                            ? (props.thumbs[item.linked_post_id] ?? null)
                            : null
                        }
                        {...(props.onOpenLinkedPost !== undefined
                          ? { onOpenLinkedPost: props.onOpenLinkedPost }
                          : {})}
                        commentCount={props.commentCounts?.[item.id] ?? 0}
                        buckets={rowBucketNames(item, props.buckets)}
                        tile={index === 0 ? tile : null}
                        timeZone={props.timeZone}
                        alsoIn={item.post_id !== null ? (props.alsoIn?.[item.post_id] ?? []) : []}
                        onOpen={() => props.onOpenItem(item.id)}
                        onPlanOk={() => props.onPlanOk(item)}
                        onPlanNotOk={() => props.onPlanNotOk(item)}
                        {...(rowMenu !== undefined && (day.day === null || day.inRange)
                          ? { menu: rowMenu }
                          : {})}
                      />
                    ))}
                    {empty ? (
                      <div className="flex items-center">
                        {tile}
                        <div className="ml-3 min-w-0 flex-1">{emptyBody}</div>
                      </div>
                    ) : null}
                    {dayTraces.length > 0 ? (
                      <div className="flex items-start gap-3">
                        <span aria-hidden="true" className="w-14 shrink-0" />
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          {dayTraces.map((trace) => (
                            <BankTraceLine key={trace.itemId} trace={trace} />
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {empty ? null : props.onAdd !== undefined &&
                      (day.day === null || day.inRange) ? (
                      <AddRow day={day.day} empty={false} onAdd={props.onAdd} />
                    ) : null}
                  </div>
                </Card>
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
        'flex min-h-11 items-center gap-2',
        !props.empty && '-mb-3 -mt-2 pl-[68px]',
      )}
    >
      {props.empty ? (
        <p data-plan-day-empty="" className="flex-1 text-md text-fg-3">
          Planned posts show up here.
        </p>
      ) : null}
      <Button
        type="button"
        variant="link"
        aria-label={label}
        data-plan-add={props.day ?? 'none'}
        onClick={() => props.onAdd(props.day)}
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
 * 600, uppercase, 0.06em, bg-panel-2, text-fg-2); the day number sits centred
 * below it (JetBrains Mono 20px/24px, 500). Today (the workspace zone): the
 * whole tile solid accent (accent-fg strip and number), with a solid "Today"
 * pill centred under it in the tile's 56px column, 6px below. "No date":
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
  const tile = (
    <div
      data-plan-day-col=""
      {...(isToday ? { 'data-plan-today': '' } : {})}
      className={cn(
        'flex h-14 w-14 shrink-0 flex-col overflow-hidden rounded-xl border lit-card',
        // Today keeps its solid accent fill: bg-none drops lit-card's gradient.
        isToday ? 'border-transparent bg-accent bg-none' : 'bg-panel',
      )}
    >
      <span
        data-plan-day-weekday=""
        className={cn(
          `flex h-5 shrink-0 items-center justify-center whitespace-nowrap ${SECTION_LABEL_INK}`,
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
            ? 'shrink-0 whitespace-nowrap text-xs font-semibold text-fg-2'
            : cn(
                'font-mono text-2xl font-medium tabular-nums',
                isToday ? 'text-accent-fg' : 'text-fg',
              ),
        )}
      >
        {props.day === null ? NO_DATE_LABEL : dayOfMonth(props.day)}
      </span>
    </div>
  );
  if (!isToday) return tile;
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1.5">
      {tile}
      <span
        data-plan-today-pill=""
        className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg lit-pill"
      >
        {TODAY_LABEL}
      </span>
    </div>
  );
}

/** The PLAN / POST line label: 36px column, the section label (12/16, 600, uppercase). */
const LINE_LABEL = `w-9 shrink-0 ${TEXT_ROLE.section}`;

/**
 * The PLAN switch: "OK" and "Not OK" joined, each the shared 44px Button
 * (min 84px, 1px border-strong, bg-panel; the inner corners square so the two
 * read as one control). Reopened from the pill, the current answer is
 * highlighted (good-soft / bad-soft). Not full width.
 */
export function PlanSwitch(props: {
  side: ReviewSide;
  title: string;
  /** The answer it was reopened on; null when undecided. */
  current: 'approved' | 'changes' | null;
  onOk: () => void;
  onNotOk: () => void;
}): ReactElement {
  const segment = 'min-w-20 border';
  return (
    <span
      role="group"
      aria-label={`${PLAN_LINE_LABEL}: ${props.title}`}
      data-plan-slot={props.side}
      data-plan-slot-state={planControlState(props.current ?? 'waiting')}
      data-plan-control="switch"
      className="flex shrink-0 items-center"
    >
      <Button
        type="button"
        variant="ghost"
        aria-pressed={props.current === 'approved'}
        data-plan-ok=""
        onClick={props.onOk}
        className={cn(
          segment,
          'rounded-r-none text-good hover:text-good',
          props.current === 'approved'
            ? 'border-good bg-good-soft lit-active'
            : 'border-border-strong bg-panel lit-chip',
        )}
      >
        <IconCheck size={ICON_SIZE.inline} />
        {PLAN_OK_LABEL}
      </Button>
      <Button
        type="button"
        variant="ghost"
        aria-pressed={props.current === 'changes'}
        data-plan-not-ok=""
        onClick={props.onNotOk}
        className={cn(
          segment,
          '-ml-px rounded-l-none text-bad hover:text-bad',
          props.current === 'changes'
            ? 'border-bad bg-bad-soft lit-active'
            : 'border-border-strong bg-panel lit-chip',
        )}
      >
        <IconX size={ICON_SIZE.inline} />
        {PLAN_NOT_OK_LABEL}
      </Button>
    </span>
  );
}

/**
 * The decided PLAN pill: the shared 44px Button in the success / danger
 * variant (solid good / bad fills, light values in both themes, under
 * accent-fg text), icon + "OK" / "Not OK" + a chevron at 70%. Tapping it
 * reopens the switch.
 */
export function PlanDecidedPill(props: {
  side: ReviewSide;
  title: string;
  status: 'approved' | 'changes';
  onChange: () => void;
}): ReactElement {
  const ok = props.status === 'approved';
  return (
    <Button
      type="button"
      variant={ok ? 'success' : 'danger'}
      aria-label={`${PLAN_LINE_LABEL} ${ok ? PLAN_OK_LABEL : PLAN_NOT_OK_LABEL}: ${props.title}`}
      aria-haspopup="true"
      data-plan-slot={props.side}
      data-plan-slot-state={planControlState(props.status)}
      data-plan-control="pill"
      onClick={props.onChange}
      className="shrink-0"
    >
      {ok ? <IconCheck size={ICON_SIZE.inline} /> : <IconX size={ICON_SIZE.inline} />}
      {ok ? PLAN_OK_LABEL : PLAN_NOT_OK_LABEL}
      <span aria-hidden="true">
        <IconChevronDown size={ICON_SIZE.inline} />
      </span>
    </Button>
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
 * POST (an 8px dot and the stage, same colour); creators get the row's ⋯ menu at the POST line's end.
 */
function PlanStatusLines(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  title: string;
  /** Creators: the row's ⋯ menu, at the end of the POST line. */
  menu?: ReactNode;
  onOk: () => void;
  onNotOk: () => void;
}): ReactElement {
  const [changing, setChanging] = useState(false);
  const control = planControl(props.bundle, props.item, props.side);
  const decided = control.kind === 'pill' ? control.status : null;
  // A new answer (a write, an Undo, a re-read) closes the reopened switch.
  useEffect(() => setChanging(false), [decided]);
  const post = postLine(props.bundle, props.item, props.side);
  let plan: ReactNode = null;
  if (control.kind === 'text') {
    const status = control.status;
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
          mark('plan:notok:tap');
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
        <div data-plan-line="plan" className="flex min-h-11 items-center gap-3">
          <span className={LINE_LABEL}>{PLAN_LINE_LABEL}</span>
          {plan}
        </div>
      ) : null}
      {props.menu !== undefined && props.menu !== null ? (
        <div className="flex items-center justify-between gap-3">
          <PostStatusLine post={post} />
          {props.menu}
        </div>
      ) : (
        <PostStatusLine post={post} />
      )}
    </div>
  );
}

/** The POST line: an 8px dot and the stage, same colour (a row and a pair's post row). */
function PostStatusLine(props: { post: { label: string; tone: PostLineTone } }): ReactElement {
  const { post } = props;
  return (
    <div data-plan-line="post" className="flex min-h-6 items-center gap-3">
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
  );
}

/**
 * A linked concept's post, joined under the concept row: indented behind a
 * 2px accent line, "Post for this concept" with the link icon, the post's
 * title, format (and its own day, mono, when it is not the concept's), its
 * tile and its POST line. No PLAN line: the pair is approved through its
 * concept. Opens as a post item opens. A post the viewer cannot read (a client;
 * RLS hides drafts) reads "Not ready to view yet" and never opens.
 */
function PairedPostRow(props: {
  bundle: PlanBundle;
  concept: PlanItemRow;
  link: Exclude<LinkedPost, { kind: 'none' }>;
  thumb: string | null;
  timeZone: string;
  onOpen?: (postId: string) => void;
}): ReactElement {
  const { link } = props;
  // The tile reads as a post's (its first image, or "Aa").
  const tileItem: PlanItemRow = {
    ...props.concept,
    kind: 'post',
    post_id: link.postId,
    linked_post_id: null,
  };
  const label = (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-accent">
      <IconLink size={ICON_SIZE.inline} />
      {PAIR_POST_LABEL}
    </span>
  );
  if (link.kind === 'hidden') {
    return (
      <div
        data-plan-pair={link.postId}
        className="mt-2 flex flex-col border-l border-border-strong pl-3"
      >
        <div
          role="button"
          aria-disabled="true"
          data-plan-pair-row="locked"
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            'flex min-h-11 min-w-0 cursor-default items-start gap-3',
            NO_TOUCH_SELECT,
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {label}
            <span className="truncate text-sm text-fg-3">{DRAFT_NOT_READY}</span>
          </span>
          <TileColumn count={0}>
            <RowTile item={tileItem} thumb={null} muted />
          </TileColumn>
        </div>
      </div>
    );
  }
  const conceptDay = planItemDayInZone(props.concept, props.bundle.postInfo, props.timeZone);
  const postDay = civilDayOf(link.info.target_date ?? null, props.timeZone);
  const format =
    link.info.format !== null && link.info.format !== undefined && link.info.format !== ''
      ? formatLabel(link.info.format)
      : '';
  const onOpen = props.onOpen;
  return (
    <div
      data-plan-pair={link.postId}
      className="mt-2 flex flex-col border-l border-border-strong pl-3"
    >
      <PressableRow
        type="button"
        data-plan-pair-row={link.postId}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => onOpen?.(link.postId)}
        className={cn('flex min-w-0 items-start gap-3', NO_TOUCH_SELECT)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {label}
          <span
            data-plan-pair-title=""
            className="line-clamp-2 break-words text-base font-medium text-fg"
          >
            {link.info.title !== '' ? link.info.title : PAIR_POST_LABEL}
          </span>
          {format !== '' || (postDay !== null && postDay !== conceptDay) ? (
            <span className="truncate text-sm text-fg-3">
              {format}
              {postDay !== null && postDay !== conceptDay ? (
                <>
                  {format !== '' ? ' · ' : ''}
                  <span data-plan-pair-date="" className="font-mono tabular-nums">
                    {shortDay(postDay)}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </span>
        <TileColumn count={0}>
          <RowTile item={tileItem} thumb={props.thumb} muted={false} />
        </TileColumn>
      </PressableRow>
      <div className="mt-1">
        <PostStatusLine post={postLine(props.bundle, props.concept, 'agency')} />
      </div>
    </div>
  );
}

/** The menu entry that sends a concept back to the bank. */
export const MOVE_TO_BANK_LABEL = 'Move to bank';

/** A concept's format: its linked post's, when it has one; '' otherwise. Pure. */
export function conceptFormat(bundle: PlanBundle, item: PlanItemRow): string {
  const linked = item.kind === 'concept' ? (item.linked_post_id ?? null) : null;
  const format = linked !== null ? (bundle.postInfo[linked]?.format ?? null) : null;
  return format !== null && format !== '' ? formatLabel(format) : '';
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
          className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-panel-2 lit-pill"
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
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-panel-3 text-fg-3 lit-pill"
        >
          <IconFile size={ICON_SIZE.tray} />
        </span>
      );
    }
    return (
      <span
        data-plan-row-tile="concept"
        className="h-14 w-14 shrink-0 rounded-lg border border-dashed border-border-strong"
      />
    );
  }
  if (props.thumb !== null) {
    return (
      <span
        data-plan-row-tile="image"
        className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-panel-2 lit-pill"
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
        'flex h-14 w-14 shrink-0 items-center justify-center rounded-lg text-xl font-semibold lit-pill',
        props.muted ? 'bg-panel-2 text-fg-3' : 'bg-accent-soft text-accent',
      )}
    >
      {props.muted ? '' : 'Aa'}
    </span>
  );
}

/** "1 comment" / "4 comments": the count's accessible name. Pure. */
export function commentCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}

/**
 * An item's comment count: IconChat and the number (sm, tabular-nums, fg-2),
 * named "{n} comment(s)". With the item's id and unread comments for the
 * viewer, IconChat and the CountBadge pill instead. Nothing at all for 0, so a
 * row keeps its height.
 * The Plan rows (under the tile) and the Plan tab calendar entries use it.
 */
export function PlanCommentCount(props: { count: number; itemId?: string }): ReactElement | null {
  const unread = useEntityUnread('plan_item', props.itemId ?? '');
  if (props.itemId !== undefined && unread > 0) {
    // Unread comments: the comment glyph and the shared count pill (the same
    // rows Activity shows); opening the item clears it.
    return (
      <span
        data-plan-comment-unread={unread}
        role="img"
        aria-label={unreadCommentsLabel(unread)}
        className="inline-flex shrink-0 items-center gap-1 text-fg"
      >
        <IconChat size={ICON_SIZE.inline} />
        <CountBadge count={unread} />
      </span>
    );
  }
  if (!(props.count > 0)) return null;
  return (
    <span
      data-plan-comment-count={props.count}
      role="img"
      aria-label={commentCountLabel(props.count)}
      className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-fg-2"
    >
      <IconChat size={ICON_SIZE.inline} />
      <span aria-hidden="true">{props.count}</span>
    </span>
  );
}

/** The row's 56px tile column: the tile, then the comment count under it (when above 0). */
function TileColumn(props: { count: number; itemId?: string; children: ReactNode }): ReactElement {
  return (
    <span data-plan-row-tile-col="" className="flex w-14 shrink-0 flex-col items-center gap-1">
      {props.children}
      <PlanCommentCount
        count={props.count}
        {...(props.itemId !== undefined ? { itemId: props.itemId } : {})}
      />
    </span>
  );
}

function PlanRow(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  thumb: string | null;
  conceptThumb?: ConceptThumb | null;
  /** A linked concept's post: its first image (the pair's tile); null for none. */
  pairThumb?: string | null;
  /** The pair's post row opens its post. */
  onOpenLinkedPost?: (postId: string) => void;
  /** Visible comments on the item; 0 shows nothing. */
  commentCount?: number;
  /** The row's bucket names (the format line's tail). */
  buckets?: readonly string[];
  /** The day's date tile on its first row; null on the rows under it. */
  tile: ReactNode;
  /** The workspace zone (the date line). */
  timeZone?: string;
  /** Other live plans this post sits in (the Also in pill). */
  alsoIn?: readonly string[];
  onOpen: () => void;
  /** PLAN: OK (behind the Undo toast). */
  onPlanOk: () => void;
  /** PLAN: Not OK (the Item screen with the note box open). */
  onPlanNotOk: () => void;
  /** Creators: the row's ⋯ menu; right-click on laptop and long-press on touch open it too. */
  menu?: PlanRowMenu;
}): ReactElement {
  const zone = props.timeZone ?? 'UTC';
  const id = props.item.id;
  const menu = props.menu;
  const title = rowTitle(props.bundle, props.item);
  const date = itemDateLabel(props.bundle, props.item, zone);
  const alsoIn = alsoInLabel(props.alsoIn ?? []);
  // Long-press on touch and right-click on laptop open the same ⋯ menu.
  const gesture = useMenuGesture(() => menu?.onOpenChange(id, true));
  // The tile column stays 56px wide on every row, so titles align.
  const tileCol = props.tile ?? <span aria-hidden="true" className="w-14 shrink-0" />;
  // Rows under a day's first sit on a hairline, centred in the 16px gap.
  const rowLine = props.tile === null && '-mt-2 border-t border-border pt-2';
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
      <div data-plan-row-wrap={id} className={cn('flex w-full min-w-0 items-start gap-3', rowLine)}>
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
          <TileColumn count={props.commentCount ?? 0} itemId={props.item.id}>
            <RowTile item={props.item} thumb={null} muted />
          </TileColumn>
        </div>
      </div>
    );
  }
  const meta = rowMeta(props.bundle, props.item);
  const buckets = props.buckets ?? [];
  // A post's format line carries its bucket ("Reel · Launch"); a concept keeps
  // its description and adds "{format} · {buckets}" when it has any.
  const formatLine =
    props.item.kind === 'post'
      ? bucketLine(meta, buckets)
      : bucketLine(conceptFormat(props.bundle, props.item), buckets);
  const subLine = props.item.kind === 'post' ? '' : meta;
  const rowButton = (
    <PressableRow
      type="button"
      data-plan-row={props.item.id}
      {...(menu !== undefined
        ? gesture.handlers
        : { onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault() })}
      onClick={() => {
        if (gesture.consumeClickSuppression()) return;
        props.onOpen();
      }}
      className={cn('flex min-w-0 items-start gap-3', NO_TOUCH_SELECT)}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {titleText(false)}
        {formatLine !== '' ? (
          <span
            data-plan-row-format=""
            {...(buckets.length > 0 ? { 'data-plan-row-buckets': '' } : {})}
            className="truncate text-sm text-fg-2"
          >
            {formatLine}
          </span>
        ) : null}
        {subLine !== '' ? (
          <span data-plan-row-meta="" className="truncate text-sm text-fg-3">
            {subLine}
          </span>
        ) : null}
        {alsoIn !== null ? (
          <span
            data-plan-row-also-in=""
            className="inline-flex max-w-full self-start truncate rounded px-1.5 text-xs font-semibold bg-warn-soft text-warn lit-pill"
          >
            {alsoIn}
          </span>
        ) : null}
        {dateLine}
      </span>
      <TileColumn count={props.commentCount ?? 0} itemId={props.item.id}>
        <RowTile
          item={props.item}
          thumb={props.thumb}
          conceptThumb={props.conceptThumb ?? null}
          muted={false}
        />
      </TileColumn>
    </PressableRow>
  );
  const menuNode =
    menu !== undefined ? (
      <ActionMenu
        title={title}
        open={menu.openId === id}
        onOpenChange={(open) => menu.onOpenChange(id, open)}
        align="right"
        items={[
          { id: 'open', label: OPEN_ITEM_LABEL, icon: IconChevronRight, onSelect: props.onOpen },
          {
            id: 'move',
            label: MOVE_TO_DAY_LABEL,
            icon: IconCalendar,
            onSelect: () => menu.onMove(id),
          },
          ...(props.item.kind === 'concept' && menu.onToBank !== undefined
            ? [
                {
                  id: 'to-bank',
                  label: MOVE_TO_BANK_LABEL,
                  icon: IconBank,
                  onSelect: () => menu.onToBank?.(id),
                },
              ]
            : []),
          {
            id: 'remove',
            label: REMOVE_ROW_LABEL,
            icon: IconTrash,
            tone: 'danger',
            onSelect: () => menu.onRemove(id),
          },
        ]}
      />
    ) : null;
  const lines = (
    <PlanStatusLines
      bundle={props.bundle}
      item={props.item}
      side={props.side}
      title={title}
      menu={menuNode}
      onOk={props.onPlanOk}
      onNotOk={props.onPlanNotOk}
    />
  );
  // Date tile | title block | thumbnail, then PLAN and POST (the ⋯ menu at the
  // POST line's end for creators); a linked concept's post row joins under it.
  const link = linkedPost(props.bundle, props.item, props.side);
  return (
    <div data-plan-row-wrap={id} className={cn('flex w-full min-w-0 items-start gap-3', rowLine)}>
      {tileCol}
      <div className="flex min-w-0 flex-1 flex-col">
        {rowButton}
        {lines}
        {link.kind !== 'none' ? (
          <PairedPostRow
            bundle={props.bundle}
            concept={props.item}
            link={link}
            thumb={props.pairThumb ?? null}
            timeZone={zone}
            {...(props.onOpenLinkedPost !== undefined ? { onOpen: props.onOpenLinkedPost } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}
