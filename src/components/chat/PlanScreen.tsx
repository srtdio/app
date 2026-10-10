// The Plan screen (full page over the chat, one history step): the plan's
// title and who it is shared with or by, the client's progress, Concepts and
// Posts tabs, and one row per item (title, description or date, status pills,
// visible comment count). Tapping a row opens the Item screen (its own step).
// The agency side also gets "Share with client" on a team plan and Remove on a
// row's long-press (confirmed). One read per table per open (plans.ts), bounded
// at 5s; a late answer still lands. Nothing paints until that read settles, so
// the list never renders and then shrinks. This file also holds the page frame,
// the bounded read hook and the confirm sheet the other plan screens share.
// Motion: the page and sheets move on translateY only. Tokens only.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Result } from '@srtdio/rpc';
import { planItemRemove, planShareWithClient } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { useLongPress } from '@/components/ui';
import { IconChevronLeft, IconPlan } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import {
  PLAN_HAS_DRAFTS_COPY,
  PLAN_NOT_AVAILABLE,
  itemPills,
  planProgress,
  planRangeLabel,
  planSharedLine,
  shortDay,
  type StatusPill,
} from '@/components/chat/plan-card';
import { PlanItemScreen } from '@/components/chat/PlanItemScreen';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS, withLateRead } from '@/lib/chat-reads';
import {
  PLAN_CHANGED_EVENT,
  dispatchPlanChanged,
  planChangedId,
  readPlanScreen,
  type PlanBundle,
  type PlanItemRow,
  type PlanScreenData,
} from '@/lib/chat/plans';
import { HISTORY_STEP_KEYS, useHistoryStep } from '@/lib/chat/use-history-step';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { DUR_SLOW_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';

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
  footer?: ReactNode;
  children: ReactNode;
  testId: string;
}): ReactElement | null {
  const [rendered, setRendered] = useState(props.open);
  const [entered, setEntered] = useState(false);
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
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-base font-semibold text-fg">{props.title}</h2>
          {props.subtitle !== undefined ? (
            <span className="truncate text-[13px] text-fg-3">{props.subtitle}</span>
          ) : null}
        </div>
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

/** The progress bar and its count. */
export function PlanProgressRow(props: { bundle: PlanBundle }): ReactElement {
  const p = planProgress(props.bundle);
  const pct = p.total === 0 ? 0 : Math.round((p.approved / p.total) * 100);
  return (
    <div className="flex items-center gap-2.5 px-4 pb-1 pt-3">
      <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
        <span className="block h-1.5 bg-good" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-[13px] text-fg-3">
        {p.approved}/{p.total} approved
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

type PlanTab = 'concept' | 'post';

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
  const { workspaceId } = useWorkspace();
  const { side } = useViewerSide(workspaceId);
  const toast = useToast();
  const planId = props.planId;
  const { read, reload } = useScreenRead<PlanScreenData>(props.open, planId, (signal) =>
    readPlanScreen(supabase, planId, signal),
  );
  const [tab, setTab] = useState<PlanTab>('concept');
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
    setTab('concept');
    setRemoving(null);
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
  const bundle =
    readBundle !== null &&
    props.onlyWorkspaceId !== undefined &&
    readBundle.plan.workspace_id !== props.onlyWorkspaceId
      ? null
      : readBundle;

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
      setError(
        result.error.message.includes('plan_has_drafts')
          ? PLAN_HAS_DRAFTS_COPY
          : "Couldn't share. Try again.",
      );
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

  const item = bundle?.items.find((i) => i.id === itemId) ?? null;
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
            tab={tab}
            onTab={setTab}
            onOpenItem={setItemId}
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

/** A row's title: a concept's own, or its post's. Pure. */
export function rowTitle(bundle: PlanBundle | null, item: PlanItemRow): string {
  if (item.kind === 'concept') return item.title ?? '';
  const info = item.post_id !== null ? bundle?.postInfo[item.post_id] : undefined;
  return info?.title ?? 'Post';
}

/** A row's second line: a concept's description, or its post's date. Pure. */
export function rowSubline(bundle: PlanBundle, item: PlanItemRow): string {
  if (item.kind === 'concept') return item.description ?? '';
  const info = item.post_id !== null ? bundle.postInfo[item.post_id] : undefined;
  return info?.target_date !== null && info?.target_date !== undefined
    ? shortDay(info.target_date.slice(0, 10))
    : '';
}

function PlanBody(props: {
  bundle: PlanBundle;
  counts: Record<string, number>;
  side: ViewerSide;
  tab: PlanTab;
  onTab: (tab: PlanTab) => void;
  onOpenItem: (id: string) => void;
  onRemove: (item: PlanItemRow) => void;
  shareError: string | null;
  sharing: boolean;
  onShareWithClient: () => void;
}): ReactElement {
  const { bundle, side } = props;
  const concepts = bundle.items.filter((i) => i.kind === 'concept');
  const posts = bundle.items.filter((i) => i.kind === 'post');
  const list = props.tab === 'concept' ? concepts : posts;
  return (
    <>
      <PlanProgressRow bundle={bundle} />
      <p className="px-4 font-mono text-[13px] text-fg-3">
        {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
      </p>
      {side === 'agency' && bundle.plan.audience === 'team' ? (
        <div className="flex flex-col gap-1.5 px-4 pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2">
            <span className="flex-1 text-[13px] text-warn">
              Team only. The client can&apos;t see it yet.
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
      <div role="tablist" className="flex gap-2 px-4 pt-3">
        {(
          [
            ['concept', `Concepts ${concepts.length}`],
            ['post', `Posts ${posts.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={props.tab === id}
            data-plan-tab={id}
            onClick={() => props.onTab(id)}
            className={cn(
              'min-h-[44px] rounded-full border px-3.5 text-sm font-medium',
              props.tab === id
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border text-fg-2 hover:bg-panel-2',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 p-4">
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-3">
            {props.tab === 'concept' ? 'No concepts in this plan.' : 'No posts in this plan.'}
          </p>
        ) : (
          list.map((item) => (
            <PlanRow
              key={item.id}
              bundle={bundle}
              item={item}
              side={side}
              comments={props.counts[item.id] ?? 0}
              onOpen={() => props.onOpenItem(item.id)}
              {...(side === 'agency' ? { onRemove: () => props.onRemove(item) } : {})}
            />
          ))
        )}
      </div>
    </>
  );
}

function PlanRow(props: {
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  comments: number;
  onOpen: () => void;
  onRemove?: () => void;
}): ReactElement {
  const onRemove = props.onRemove;
  const hold = useLongPress(() => onRemove?.());
  const sub = rowSubline(props.bundle, props.item);
  return (
    <button
      type="button"
      data-plan-row={props.item.id}
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
        'flex w-full flex-col gap-2 rounded-lg border border-border bg-panel p-3 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
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
          <span className="truncate text-[15px] font-semibold text-fg">
            {rowTitle(props.bundle, props.item)}
          </span>
          {sub !== '' ? (
            <span
              className={cn(
                'line-clamp-2 text-[13px] text-fg-3',
                props.item.kind === 'post' && 'font-mono',
              )}
            >
              {sub}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex w-full flex-wrap items-center gap-1.5">
        {itemPills(props.bundle, props.item, props.side).map((pill) => (
          <PlanPill key={pill.side} pill={pill} />
        ))}
        <span className="ml-auto text-xs text-fg-3">
          {props.comments === 1 ? '1 comment' : `${props.comments} comments`}
        </span>
      </span>
    </button>
  );
}
