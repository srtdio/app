// The Plan screen (full page over the chat, one history step): the plan's
// title and who it is shared with or by, the client's progress, and one list
// grouped by day for every day of the range (workspace zone; "Nothing planned"
// on an empty day, out-of-range days before or after, "No date" last; a plan
// longer than a week adds a sticky "Week of" header per Mon-start week). Each
// row: the slot checkbox (client side for a client, team side for the agency)
// and the open area (kind tag, title, description or date, status pills,
// visible comment count). Tapping the open area opens the Item screen (its own
// step). A tick is optimistic, with Undo on its toast; a failure reverts.
// The agency side also gets "Share with client" on a team plan and Remove on a
// row's long-press (confirmed). One read per table per open (plans.ts), bounded
// at 5s; a late answer still lands. Nothing paints until that read settles, so
// the list never renders and then shrinks. This file also holds the page frame,
// the bounded read hook and the confirm sheet the other plan screens share.
// Motion: the page and sheets move on translateY only. Tokens only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Result } from '@srtdio/rpc';
import { planItemRemove, planItemReview, planShareWithClient } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { useLongPress } from '@/components/ui';
import { IconCheck, IconChevronLeft, IconPlan, IconX } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import {
  DRAFT_LABEL,
  DRAFT_NOT_READY,
  PLAN_NOT_AVAILABLE,
  SLOT_UNDO,
  SLOT_UNDO_MS,
  draftLocked,
  isDraftPost,
  itemDateLabel,
  itemKindLabel,
  itemPills,
  planProgress,
  planRangeLabel,
  planSharedLine,
  progressLabel,
  progressPercent,
  reviewStatus,
  slotCheckboxShown,
  slotSide,
  slotTicked,
  slotToastSpec,
  withReviewOverrides,
  type StatusPill,
} from '@/components/chat/plan-card';
import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS, withLateRead } from '@/lib/chat-reads';
import {
  PLAN_CHANGED_EVENT,
  dispatchPlanChanged,
  planChangedId,
  planItemDayInZone,
  readPlanScreen,
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
import { logger } from '@/lib/logger';
import { DUR_SLOW_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import { formatCivilDayHeader, planShowsWeeks, planWeekGroups } from '@/lib/plan-week';

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
      <header className="flex min-h-[60px] shrink-0 items-center gap-2 border-b border-border bg-panel pl-1 pr-3">
        <button
          type="button"
          aria-label={props.backLabel}
          onClick={props.onBack}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {props.backIcon ?? <IconChevronLeft size={22} />}
        </button>
        <div data-plan-page-titles="" className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-base font-semibold text-fg">{props.title}</h2>
          {props.subtitle !== undefined ? (
            <span data-plan-page-subtitle="" className="truncate text-[13px] text-fg-3">
              {props.subtitle}
            </span>
          ) : null}
        </div>
        {props.action}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
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
 * The progress line beside the bar: the agency sees team and client counts
 * (planProgress, shared with the card); anyone else the client count only. Pure.
 */
export function screenProgressLabel(bundle: PlanBundle, side: ViewerSide): string {
  const p = planProgress(bundle);
  return side === 'agency' ? progressLabel(p, side) : `${p.approved}/${p.total} approved`;
}

/** The progress bar (client approval) and its count. */
export function PlanProgressRow(props: { bundle: PlanBundle; side: ViewerSide }): ReactElement {
  const pct = progressPercent(planProgress(props.bundle));
  return (
    <div className="flex items-center gap-2.5 px-4 pb-1 pt-3">
      <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
        <span className="block h-1.5 bg-good" style={{ width: `${pct}%` }} />
      </span>
      <span data-plan-screen-progress="" className="font-mono text-[13px] text-fg-3">
        {screenProgressLabel(props.bundle, props.side)}
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

export function PlanScreen(props: {
  open: boolean;
  planId: string;
  /** The message sender (client's "Shared by"). Absent outside a chat. */
  senderName?: string;
  /** The open chat's title (agency's "Shared with"). Absent outside a chat. */
  chatTitle?: string;
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
  const toast = useToast();
  const planId = props.planId;
  const { read, reload } = useScreenRead<PlanScreenData>(props.open, planId, (signal) =>
    readPlanScreen(supabase, planId, signal),
  );
  const [itemId, setItemId] = useState<string | null>(props.initialItemId ?? null);
  const entryItemId = props.initialItemId ?? null;
  const [removing, setRemoving] = useState<PlanItemRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryStep(
    itemId !== null && itemId !== entryItemId && props.open,
    HISTORY_STEP_KEYS.planItem,
    () => setItemId(null),
  );

  // A closed screen forgets its item, tab and confirms.
  useEffect(() => {
    if (props.open) return;
    setItemId(null);
    setRemoving(null);
    setSlotOverrides({});
    setError(null);
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
  const slot = shownBundle !== null ? slotSide(side, shownBundle.plan.audience) : null;
  // The viewer's slot ticks, laid over the read until a fresh read lands (a
  // tick still being written survives that read). Rows, pills, counts and the
  // bar all read the same bundle, so they move together on tick and revert.
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
  const bundle = useMemo(
    () =>
      shownBundle !== null && slot !== null
        ? withReviewOverrides(shownBundle, slot, slotOverrides)
        : shownBundle,
    [shownBundle, slot, slotOverrides],
  );

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
  const counts = read.status === 'ready' ? read.data.commentCounts : {};
  // First paint: the thread's card cache already holds the title.
  const planCards = usePlanCards();
  const cachedTitle = planCards?.cache.snapshot([planId]).bundles.get(planId)?.plan.title ?? null;
  const title = planHeaderTitle(read.status, bundle?.plan.title ?? null, cachedTitle);
  const sharedName = side === 'agency' ? props.chatTitle : props.senderName;
  const subtitle =
    side !== 'unknown' && sharedName !== undefined ? planSharedLine(side, sharedName) : undefined;

  const shareWithClient = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const traceId = generateTraceId();
    const result = await planShareWithClient(supabase, { p_plan_id: planId, p_trace_id: traceId });
    setBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan share with client failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      setError("Couldn't share. Try again.");
      return;
    }
    toast.show({ title: 'Shared with the client' });
    dispatchPlanChanged(window, planId);
  };

  const removeItem = async (): Promise<void> => {
    if (removing === null || busy) return;
    setBusy(true);
    const traceId = generateTraceId();
    const result = await planItemRemove(supabase, { p_item_id: removing.id, p_trace_id: traceId });
    setBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan item remove failed', {
        trace_id: traceId,
        item_id: removing.id,
        error: result.error.message,
      });
      setError("Couldn't remove. Try again.");
      return;
    }
    setRemoving(null);
    setError(null);
    dispatchPlanChanged(window, planId);
  };

  // One slot write: optimistic at once, reverted on failure; a tick's toast
  // offers Undo (a write back to waiting), an untick's says it was removed.
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
      ...(spec.undo
        ? {
            durationMs: SLOT_UNDO_MS,
            action: {
              label: SLOT_UNDO,
              onPress: () =>
                void writeSlot(item, reviewSide, 'waiting', 'approved', 'undo', dayHeader),
            },
          }
        : {}),
    });
  };
  const toggleSlot = (item: PlanItemRow): void => {
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

  const found = bundle?.items.find((i) => i.id === itemId) ?? null;
  // A draft the viewer can see by name only never opens (a drawer row included).
  const item =
    found !== null && bundle !== null && !draftLocked(bundle, found, side) ? found : null;
  return (
    <>
      <PlanPage
        open={props.open}
        testId="plan"
        title={title}
        subtitle={subtitle}
        backLabel="Back"
        onBack={props.onClose}
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
            counts={counts}
            side={side}
            timeZone={timeZone}
            onOpenItem={setItemId}
            onToggleSlot={toggleSlot}
            onRemove={(row) => {
              setError(null);
              setRemoving(row);
            }}
            shareError={removing === null ? error : null}
            sharing={busy && removing === null}
            onShareWithClient={() => void shareWithClient()}
          />
        )}
      </PlanPage>
      {bundle !== null && item !== null ? (
        <PlanItemScreen
          open={props.open && itemId !== null}
          bundle={bundle}
          item={item}
          side={side}
          {...(itemId === entryItemId
            ? {
                backLabel: 'Back',
                ...(props.highlightCommentId !== undefined
                  ? { highlightCommentId: props.highlightCommentId }
                  : {}),
              }
            : {})}
          onClose={() => (itemId === entryItemId ? props.onClose() : setItemId(null))}
        />
      ) : null}
      <PlanConfirmSheet
        open={removing !== null}
        title="Remove from plan?"
        message={`"${removing !== null ? rowTitle(bundle, removing) : ''}" leaves the plan. Its comments stay with it.`}
        confirmLabel="Remove"
        destructive
        busy={busy}
        error={removing !== null ? error : null}
        onConfirm={() => void removeItem()}
        onCancel={() => {
          setRemoving(null);
          setError(null);
        }}
      />
    </>
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

function PlanBody(props: {
  bundle: PlanBundle;
  counts: Record<string, number>;
  side: ViewerSide;
  timeZone: string;
  onOpenItem: (id: string) => void;
  onToggleSlot: (item: PlanItemRow) => void;
  onRemove: (item: PlanItemRow) => void;
  shareError: string | null;
  sharing: boolean;
  onShareWithClient: () => void;
}): ReactElement {
  const { bundle, side } = props;
  const { starts_on: startsOn, ends_on: endsOn } = bundle.plan;
  const weeks = planShowsWeeks(startsOn, endsOn);
  const groups = planWeekGroups(
    bundle.items,
    { startsOn, endsOn },
    (item) => planItemDayInZone(item, bundle.postInfo, props.timeZone),
    weeks,
  );
  return (
    <>
      <PlanProgressRow bundle={bundle} side={side} />
      <p className="px-4 font-mono text-[13px] text-fg-3">{planRangeLabel(startsOn, endsOn)}</p>
      {side === 'agency' && bundle.plan.audience === 'team' ? (
        <div className="flex flex-col gap-1.5 px-4 pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2">
            <span className="flex-1 text-[13px] text-warn">
              Agency only. The client can&apos;t see it yet.
            </span>
            <Button
              size="sm"
              data-plan-share-client=""
              className="min-h-[44px]"
              disabled={props.sharing}
              onClick={props.onShareWithClient}
            >
              Share with client
            </Button>
          </div>
          {props.shareError !== null ? (
            <p role="alert" className="text-[13px] text-bad">
              {props.shareError}
            </p>
          ) : null}
        </div>
      ) : null}
      <div data-plan-list={weeks ? 'weeks' : 'days'} className="flex flex-col pb-4 pt-1">
        {groups.map((week, w) => (
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
            {week.days.map((day) => (
              <div
                key={day.day ?? 'none'}
                data-plan-day={day.day ?? 'none'}
                {...(day.day !== null && !day.inRange ? { 'data-plan-day-out': '' } : {})}
                className="flex flex-col"
              >
                <h4
                  data-plan-day-header=""
                  className="px-4 pb-1.5 pt-3 text-[13px] font-semibold text-fg-2"
                >
                  {day.label}
                </h4>
                {day.items.length === 0 ? (
                  <p
                    data-plan-day-empty=""
                    className={cn(
                      'mx-4 flex items-center text-[13px] text-fg-3',
                      weeks
                        ? 'h-8'
                        : 'min-h-[56px] rounded-lg border border-dashed border-border px-3',
                    )}
                  >
                    Nothing planned
                  </p>
                ) : (
                  <div className="flex flex-col gap-2 px-4">
                    {day.items.map((item) => (
                      <PlanRow
                        key={item.id}
                        bundle={bundle}
                        item={item}
                        side={side}
                        comments={props.counts[item.id] ?? 0}
                        onOpen={() => props.onOpenItem(item.id)}
                        onToggleSlot={() => props.onToggleSlot(item)}
                        {...(side === 'agency' ? { onRemove: () => props.onRemove(item) } : {})}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

/**
 * The slot checkbox: a 22px box in a 44x44 target. Ticked reads approved
 * ('changes' shows unticked). Tokens only; no motion.
 */
export function SlotCheckbox(props: {
  side: ReviewSide;
  checked: boolean;
  title: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={
        props.checked ? `Remove slot approval: ${props.title}` : `Approve slot: ${props.title}`
      }
      data-plan-slot={props.side}
      data-plan-slot-state={props.checked ? 'approved' : 'pending'}
      onClick={props.onToggle}
      className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span
        className={cn(
          'flex h-[22px] w-[22px] items-center justify-center rounded-md border-2',
          props.checked ? 'border-good bg-good-soft text-good' : 'border-border-strong bg-panel',
        )}
      >
        {props.checked ? <IconCheck size={14} /> : null}
      </span>
    </button>
  );
}

/** A draft post's pill: grey for the agency, outlined for anyone else. */
export function DraftPill(props: { locked: boolean }): ReactElement {
  return (
    <span
      data-plan-pill="draft"
      className={cn(
        'inline-flex min-h-[24px] items-center rounded-md px-2 text-[13px]',
        props.locked ? 'border border-border text-fg-3' : 'bg-panel-2 text-fg-2',
      )}
    >
      {DRAFT_LABEL}
    </span>
  );
}

function PlanRow(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  comments: number;
  onOpen: () => void;
  onToggleSlot: () => void;
  onRemove?: () => void;
}): ReactElement {
  const onRemove = props.onRemove;
  const hold = useLongPress(() => onRemove?.());
  const sub = rowSubline(props.item);
  const date = itemDateLabel(props.bundle, props.item);
  const draft = isDraftPost(props.bundle, props.item);
  const kindTag = itemKindLabel(props.bundle.items, props.item);
  const title = rowTitle(props.bundle, props.item);
  if (draftLocked(props.bundle, props.item, props.side)) {
    // Name only: no checkbox, no open, no hover, no chevron.
    return (
      <div
        role="button"
        aria-disabled="true"
        data-plan-row={props.item.id}
        data-plan-row-draft="locked"
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          'flex w-full cursor-default flex-col gap-2 rounded-lg border border-border bg-panel p-3 text-left',
          NO_TOUCH_SELECT,
        )}
      >
        <span className="flex w-full gap-3">
          <span className="h-12 w-12 shrink-0 rounded-md border border-dashed border-border bg-panel-2" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span data-plan-row-kind="" className="text-xs text-fg-3">
              {kindTag}
            </span>
            <span className="truncate text-[15px] font-semibold text-fg-2">{title}</span>
            <span className="text-[13px] text-fg-3">{DRAFT_NOT_READY}</span>
            <span
              data-plan-row-date={date.dated ? 'dated' : 'none'}
              className={cn('text-[13px] text-fg-3', date.dated && 'font-mono')}
            >
              {date.label}
            </span>
          </span>
        </span>
        <span className="flex w-full flex-wrap items-center gap-1.5">
          <DraftPill locked />
        </span>
      </div>
    );
  }
  const slot = slotCheckboxShown(props.bundle, props.item, props.side);
  return (
    <div
      data-plan-row-wrap={props.item.id}
      className="flex w-full items-stretch rounded-lg border border-border bg-panel"
    >
      {slot !== null ? (
        <span className="flex shrink-0 items-center pl-1">
          <SlotCheckbox
            side={slot}
            checked={slotTicked(props.bundle, props.item.id, slot)}
            title={title}
            onToggle={props.onToggleSlot}
          />
        </span>
      ) : null}
      <button
        type="button"
        data-plan-row={props.item.id}
        {...(draft ? { 'data-plan-row-draft': 'open' } : {})}
        {...(onRemove !== undefined ? hold.handlers : {})}
        onContextMenu={(event) => {
          event.preventDefault();
          if (onRemove === undefined) return;
          hold.cancel();
          onRemove();
        }}
        onClick={() => {
          if (hold.consumeClickSuppression()) return;
          props.onOpen();
        }}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-2 rounded-lg p-3 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          slot !== null && 'pl-1',
          NO_TOUCH_SELECT,
        )}
      >
        <span className="flex w-full gap-3">
          <span
            className={cn(
              'h-12 w-12 shrink-0 rounded-md',
              props.item.kind === 'concept'
                ? 'border border-dashed border-border-strong bg-panel-3'
                : 'bg-accent-soft',
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span data-plan-row-kind="" className="text-xs text-fg-3">
              {kindTag}
            </span>
            <span className="truncate text-[15px] font-semibold text-fg">{title}</span>
            {sub !== '' ? <span className="line-clamp-2 text-[13px] text-fg-3">{sub}</span> : null}
            <span
              data-plan-row-date={date.dated ? 'dated' : 'none'}
              className={cn('text-[13px] text-fg-3', date.dated && 'font-mono')}
            >
              {date.label}
            </span>
          </span>
        </span>
        <span className="flex w-full flex-wrap items-center gap-1.5">
          {draft ? <DraftPill locked={false} /> : null}
          {itemPills(props.bundle, props.item, props.side).map((pill) => (
            <PlanPill key={pill.side} pill={pill} />
          ))}
          <span className="ml-auto text-xs text-fg-3">
            {props.comments === 1 ? '1 comment' : `${props.comments} comments`}
          </span>
        </span>
      </button>
    </div>
  );
}
