// The New plan screen (full page, one history step), opened from the Plans
// sheet. Title, the plan dates (this Monday to Sunday in the workspace zone by
// default; Change opens a From / To sheet, at most 5 weeks) and one list of
// items in screen order: concepts (title, description, up to 20 library
// files), posts from Pipeline and drafts. Every item has a day button: a day
// of the plan, No date, or (a post dated outside the plan, or a day the dates
// dropped) "Pick a day" in warning colour. A picked post's day comes from its
// Pipeline date when that is inside the plan; picking another day, or No date
// on a dated post, says so under the row. Every new plan is a Draft (audience
// team). Nothing is written until "Create plan": then one
// plan_create_with_items call with one trace id saves the plan, its items and
// the Pipeline dates together, or nothing (the form is never locked; a failure
// says what to do and nothing is half built). While an item needs a day the
// server is never called. On success the screen closes and the new plan's Plan
// screen opens. No card is ever sent to chat. Every close path (X, Escape,
// system or browser Back) asks "Discard this plan?" while the plan holds
// anything: useBackGuard holds the Back above the chat's own step, so the
// half-built plan stays on Keep editing; Discard releases the guard, then
// closes. The phone page is a modal dialog (focus moves in and returns, see
// PlanPage). Tokens only; translateY motion for sheets, a short translateX
// shake on the first flagged row.
// The Plan tab opens it too, outside any chat, its dates the week of a
// picked day when one is passed (initialRange).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PostCardFields } from '@srtdio/posts';
import { planCreateWithItems } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ICON_SIZE, IconCalendar, IconChevronRight, IconPlus, IconX } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import {
  ConceptSheet,
  EMPTY_CONCEPT,
  FIELD,
  conceptFormValid,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import { PlanPage } from '@/components/chat/PlanScreen';
import {
  PlanDatesSheet,
  PlanDayPickerSheet,
  dayPickerSubline,
} from '@/components/chat/PlanDayPickerSheet';
import {
  CREATE_PLAN_LABEL,
  DRAFT_PROBLEM_COPY,
  NO_DATE_LABEL,
  PLAN_CREATE_ERROR_COPY,
  PLAN_CREATE_FAILED_COPY,
  PLAN_TITLE_MAX,
  composeTitlePlaceholder,
  defaultPlanRange,
  draftProblem,
  planWriteErrorCopy,
  stageLabel,
} from '@/components/chat/plan-card';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useBackGuard } from '@/lib/back-guard';
import { newMessageId } from '@/lib/chat/message-id';
import {
  COMPOSE_EMPTY,
  COMPOSE_MAX_CONCEPTS,
  COMPOSE_MAX_POSTS,
  COMPOSE_TOO_MANY,
  composeCreateArgs,
  composeCreatedToast,
  composeItemNote,
  composeNeedsDay,
  composeNeedsDayError,
  composePipelineUpdates,
  composePostItem,
  composeSummary,
  createShareEpoch,
  inComposeRange,
  recheckComposeItems,
  type ComposeConcept,
  type ComposeDay,
  type ComposeItem,
  type ComposeRange,
  type ShareEpoch,
} from '@/lib/chat/plans';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { cn } from '@/lib/cn';
import { prefersReducedMotion } from '@/lib/use-is-laptop';
import { logger } from '@/lib/logger';
import { civilDaysBetween, civilToday, formatCivilDayHeader } from '@/lib/plan-week';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

export { DATE_FIELD, DATE_FIT } from '@/components/chat/PlanDayPickerSheet';

/** Every new plan is a Draft (audience team); plan_create_with_items makes it so. */
export const NEW_PLAN_AUDIENCE = 'team';

/** The empty list's line. */
export const COMPOSE_NO_ITEMS = 'Concepts, posts and drafts you add show up here.';

/** The day button while an item needs a day. */
export const PICK_A_DAY = 'Pick a day';

/** The close confirm when the plan holds anything. */
export const PLAN_DISCARD = {
  title: 'Discard this plan?',
  message: 'Your concepts and posts will be lost.',
};

/** Whether closing would lose work: a name, any item, or an unsaved concept draft. Pure. */
export function composeHasContent(input: {
  title: string;
  items: readonly unknown[];
  conceptDraft: Pick<ConceptForm, 'title' | 'description' | 'files'>;
}): boolean {
  const d = input.conceptDraft;
  return (
    input.title.trim() !== '' ||
    input.items.length > 0 ||
    d.title.trim() !== '' ||
    d.description.trim() !== '' ||
    d.files.length > 0
  );
}

/** Create's button while the one call is in flight. */
export const CREATING_LABEL = 'Creating…';

/**
 * A concept form's date standing for "needs a day": before any plan day, so
 * the tiles select nothing and a Save without a pick keeps it flagged.
 */
const CONCEPT_DAY_UNSET = '0000-00-00';

/** An inline error under Create: a heading plus per-item lines, or one sentence. */
interface ComposeError {
  heading: string;
  lines: string[];
  /** The lines are a list of items (the needs-a-day refusal). */
  list?: boolean;
}

/** The concept form for a row (its day mapped to the form's date). Pure. */
export function composeConceptForm(item: ComposeConcept): ConceptForm {
  return {
    title: item.title,
    description: item.description,
    files: [...item.files],
    date: item.day === null ? CONCEPT_DAY_UNSET : item.day === 'none' ? '' : item.day,
  };
}

/** A concept row from the sheet's form: '' is No date, a day outside the plan needs one. Pure. */
export function composeConceptFrom(
  key: string,
  form: ConceptForm,
  range: ComposeRange,
): ComposeConcept {
  const day: ComposeDay =
    form.date === '' ? 'none' : inComposeRange(form.date, range) ? form.date : null;
  return {
    kind: 'concept',
    key,
    title: form.title.trim(),
    description: form.description.trim(),
    files: [...form.files],
    day,
  };
}

/** Items per plan day (the tiles' counts). Pure. */
export function composeDayCounts(items: readonly ComposeItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of items) {
    if (i.day !== null && i.day !== 'none') counts[i.day] = (counts[i.day] ?? 0) + 1;
  }
  return counts;
}

/** A server failure's copy, split so the first sentence can lead in bold. Pure. */
export function composeServerError(message: string): ComposeError {
  const copy = planWriteErrorCopy(message, PLAN_CREATE_FAILED_COPY, PLAN_CREATE_ERROR_COPY);
  const at = copy.indexOf('. ');
  return at === -1
    ? { heading: copy, lines: [] }
    : { heading: copy.slice(0, at + 1), lines: [copy.slice(at + 2)] };
}

export function PlanComposeScreen(props: {
  open: boolean;
  workspaceId: string;
  timeZone: string;
  /** The plan dates each open starts with (default: this Monday to Sunday). */
  initialRange?: ComposeRange;
  onClose: () => void;
  /**
   * The plan exists with its items: open its Plan screen. `stale` is true when
   * the screen was closed (or reopened) meanwhile: nothing opens.
   */
  onCreated: (planId: string, stale: boolean) => void;
}): ReactElement | null {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const startsOn = props.initialRange?.startsOn;
  const endsOn = props.initialRange?.endsOn;
  const [range, setRange] = useState(() =>
    startsOn !== undefined && endsOn !== undefined
      ? { startsOn, endsOn }
      : defaultPlanRange(new Date(), props.timeZone),
  );
  const [items, setItems] = useState<ComposeItem[]>([]);
  // The picker's rows for the posts in the list (the picker's selection).
  const [picked, setPicked] = useState<PostCardFields[]>([]);
  const [picker, setPicker] = useState<'posts' | 'drafts' | null>(null);
  const [conceptOpen, setConceptOpen] = useState(false);
  // The concept the sheet edits; null while it adds a new one.
  const [editKey, setEditKey] = useState<string | null>(null);
  const [dayFor, setDayFor] = useState<string | null>(null);
  const [datesOpen, setDatesOpen] = useState(false);
  // Concept uploads go as comments' do (library origin).
  const { canAttach, uploadFile } = useCommentAttachments();
  const [conceptForm, setConceptForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ComposeError | null>(null);
  const [triedShare, setTriedShare] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const inFlight = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Every open and close starts a new epoch: a create still running from an
  // earlier form never lands its result on the current one.
  const open = props.open;
  const epochRef = useRef<ShareEpoch | null>(null);
  epochRef.current ??= createShareEpoch();
  const epoch = epochRef.current;
  useEffect(() => {
    epoch.next();
  }, [open, epoch]);

  // Each open starts a fresh plan (a closed screen keeps nothing).
  const timeZone = props.timeZone;
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setRange(
      startsOn !== undefined && endsOn !== undefined
        ? { startsOn, endsOn }
        : defaultPlanRange(new Date(), timeZone),
    );
    setItems([]);
    setPicked([]);
    setPicker(null);
    setConceptOpen(false);
    setEditKey(null);
    setDayFor(null);
    setDatesOpen(false);
    setConceptForm(EMPTY_CONCEPT);
    setBusy(false);
    setError(null);
    setTriedShare(false);
    setCloseConfirm(false);
    inFlight.current = false;
  }, [open, timeZone, startsOn, endsOn]);

  // Every close (X, back, Escape) asks first while the plan holds anything.
  const hasContent = composeHasContent({ title, items, conceptDraft: conceptForm });
  const requestClose = (): void => {
    if (hasContent) {
      setCloseConfirm(true);
      return;
    }
    props.onClose();
  };
  // System or browser Back with content asks the same confirm (FB4): the
  // guard's step sits above the chat's planCompose step, so Back never
  // reaches the chat's own close while anything is typed. Released before a
  // confirmed Discard and before Create's own close.
  const guard = useBackGuard({ active: props.open && hasContent, onBack: requestClose });

  const problem = draftProblem({ title, startsOn: range.startsOn, endsOn: range.endsOn });
  const today = civilToday(new Date(), timeZone);
  const counts = composeDayCounts(items);
  const dayCount = civilDaysBetween(range.startsOn, range.endsOn).length;

  const flash = (key: string): void => {
    const row = rowRefs.current.get(key);
    if (row === undefined) return;
    row.scrollIntoView({ block: 'center' });
    if (!prefersReducedMotion() && typeof row.animate === 'function') {
      row.animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-4px)' },
          { transform: 'translateX(4px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 300, easing: 'ease-out' },
      );
    }
  };

  const create = async (): Promise<void> => {
    if (inFlight.current) return;
    setTriedShare(true);
    if (problem === 'title') return;
    if (items.length === 0) {
      setError({ heading: COMPOSE_EMPTY, lines: [] });
      return;
    }
    const need = composeNeedsDayError(items);
    if (need !== null) {
      setError({ ...need, list: true });
      const first = composeNeedsDay(items)[0];
      if (first !== undefined) flash(first.key);
      return;
    }
    const concepts = items.filter((i) => i.kind === 'concept').length;
    if (concepts > COMPOSE_MAX_CONCEPTS || items.length - concepts > COMPOSE_MAX_POSTS) {
      setError({ heading: COMPOSE_TOO_MANY, lines: [] });
      return;
    }
    inFlight.current = true;
    const token = epoch.current();
    setBusy(true);
    setError(null);
    const traceId = generateTraceId();
    const args = composeCreateArgs({
      workspaceId: props.workspaceId,
      title,
      range,
      items,
      traceId,
    });
    let result: Awaited<ReturnType<typeof planCreateWithItems>>;
    try {
      result = await planCreateWithItems(supabase, args);
    } catch (thrown) {
      result = { ok: false, error: { code: 'unknown', message: String(thrown) } };
    }
    inFlight.current = false;
    if (!mounted.current || !epoch.isCurrent(token)) {
      // The form this create started from is gone: nothing opens.
      if (result.ok) props.onCreated(result.data, true);
      return;
    }
    setBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan create failed', {
        trace_id: traceId,
        error: result.error.message,
      });
      setError(composeServerError(result.error.message));
      return;
    }
    toast.show({ title: composeCreatedToast(items.length, composePipelineUpdates(items)) });
    const planId = result.data;
    // The guard goes before the parent's close pops the screen's own step.
    guard.release();
    props.onCreated(planId, false);
  };

  // Add appends a new concept; Edit replaces it in place (same key, same
  // position). Local only: nothing is written until Create.
  // The concept sheet closes only when its draft is discarded (or was empty):
  // the draft goes then, and is otherwise kept for the next Add concept.
  const closeConcept = (): void => {
    setConceptOpen(false);
    setConceptForm(EMPTY_CONCEPT);
    setEditKey(null);
  };

  const submitConcept = (): void => {
    if (!conceptFormValid(conceptForm)) return;
    const key = editKey ?? newMessageId();
    const next = composeConceptFrom(key, conceptForm, range);
    setItems((prev) =>
      editKey !== null ? prev.map((i) => (i.key === editKey ? next : i)) : [...prev, next],
    );
    setConceptForm(EMPTY_CONCEPT);
    setEditKey(null);
    setConceptOpen(false);
  };

  const editConcept = (key: string): void => {
    const item = items.find((i) => i.key === key);
    if (item === undefined || item.kind !== 'concept') return;
    setConceptForm(composeConceptForm(item));
    setEditKey(key);
    setConceptOpen(true);
  };

  const removeItem = (key: string): void => {
    setItems((prev) => prev.filter((i) => i.key !== key));
    setPicked((prev) => prev.filter((p) => p.id !== key));
    setError(null);
  };

  // The picker toggles a post in or out; a new row's day is worked out here,
  // before it renders, so it paints in its final state.
  const togglePicked = (post: PostCardFields): void => {
    if (picked.some((p) => p.id === post.id)) {
      removeItem(post.id);
      return;
    }
    const row = composePostItem(
      post as PostCardFields & { target_date?: string | null },
      post.stage === 'draft' ? 'draft' : 'post',
      range,
      timeZone,
    );
    setPicked((prev) => [...prev, post]);
    setItems((prev) => (prev.some((i) => i.key === row.key) ? prev : [...prev, row]));
    setError(null);
  };

  const pickDay = (day: string | 'none'): void => {
    const key = dayFor;
    setDayFor(null);
    if (key === null) return;
    const next = items.map((i) =>
      i.key !== key ? i : i.kind === 'concept' ? { ...i, day } : { ...i, day, chosen: true },
    );
    setItems(next);
    if (composeNeedsDay(next).length === 0) setError(null);
  };

  const saveDates = (next: ComposeRange): void => {
    setRange(next);
    setItems((prev) => recheckComposeItems(prev, next));
    setDatesOpen(false);
    setError(null);
  };

  const dayItem = items.find((i) => i.key === dayFor) ?? null;
  // The sheet keeps its last item's header through its exit.
  const lastDayItem = useRef<ComposeItem | null>(null);
  if (dayItem !== null) lastDayItem.current = dayItem;
  const shownDayItem = dayItem ?? lastDayItem.current;

  const footer = (
    <div className="flex flex-col gap-2">
      {error !== null ? (
        <div
          role="alert"
          data-plan-share-error=""
          className="rounded-xl bg-bad-soft px-3 py-2.5 text-md leading-[1.45] text-bad"
        >
          <p className="font-semibold">{error.heading}</p>
          {error.list === true ? (
            <ul className="mt-1 list-disc pl-[18px]">
              {error.lines.map((line, at) => (
                <li key={at}>{line}</li>
              ))}
            </ul>
          ) : (
            error.lines.map((line, at) => <p key={at}>{line}</p>)
          )}
        </div>
      ) : null}
      <Button
        variant="primary"
        data-plan-create=""
        className="w-full"
        aria-busy={busy}
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? CREATING_LABEL : CREATE_PLAN_LABEL}
      </Button>
      <p data-plan-compose-summary="" className="text-center text-sm text-fg-3">
        {composeSummary(items)}
      </p>
    </div>
  );

  const addClass =
    'w-full border-dashed border-border-strong text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  // Left aligned inside the full-width button (the Button itself centres).
  const addInner = 'flex w-full items-center gap-2';

  return (
    <>
      <PlanPage
        open={props.open}
        testId="compose"
        title="New plan"
        backLabel="Close"
        backIcon={<IconX size={ICON_SIZE.tray} />}
        onBack={requestClose}
        closeLabel="Close"
        footer={footer}
      >
        <div className="flex flex-col gap-3.5 p-3">
          <div className="flex flex-col gap-1.5">
            <input
              id="plan-title"
              data-plan-title=""
              aria-label="Plan name"
              value={title}
              maxLength={PLAN_TITLE_MAX}
              autoComplete="off"
              enterKeyHint="done"
              placeholder={composeTitlePlaceholder(range)}
              onChange={(e) => setTitle(e.target.value)}
              className={cn(FIELD, 'font-semibold')}
            />
            {triedShare && problem === 'title' ? (
              <p className="text-md text-bad">{DRAFT_PROBLEM_COPY.title}</p>
            ) : null}
          </div>

          <div
            data-plan-dates-row=""
            className="flex min-h-[48px] items-center justify-between gap-2 rounded-xl bg-panel-2 pl-3 pr-1"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-base text-fg">
                {formatCivilDayHeader(range.startsOn)} to {formatCivilDayHeader(range.endsOn)}
              </span>
              <span className="text-sm text-fg-3">
                Plan dates · <span className="font-mono tabular-nums">{dayCount}</span> days
              </span>
            </div>
            <Button
              type="button"
              variant="link"
              data-plan-dates-change=""
              onClick={() => setDatesOpen(true)}
              className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Change
            </Button>
          </div>

          <section className="flex flex-col gap-2" aria-label="Items">
            <h3 className="mx-1 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
              Items · <span className="font-mono tabular-nums">{items.length}</span>
            </h3>
            {items.length === 0 ? (
              <p className="px-0.5 text-sm leading-[1.4] text-fg-3">{COMPOSE_NO_ITEMS}</p>
            ) : null}
            {items.map((item) => (
              <ComposeItemRow
                key={item.key}
                item={item}
                rowRef={(el) => {
                  if (el !== null) rowRefs.current.set(item.key, el);
                  else rowRefs.current.delete(item.key);
                }}
                onDay={() => setDayFor(item.key)}
                onEdit={() => editConcept(item.key)}
                onRemove={() => removeItem(item.key)}
              />
            ))}
          </section>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              data-plan-add-concept=""
              onClick={() => {
                // A kept Add draft reopens as it was; an edit's form never carries over.
                if (editKey !== null) {
                  setConceptForm(EMPTY_CONCEPT);
                  setEditKey(null);
                }
                setConceptOpen(true);
              }}
              className={addClass}
            >
              <span className={addInner}>
                <IconPlus size={ICON_SIZE.inline} />
                Add concept
              </span>
            </Button>
            <Button
              type="button"
              data-plan-add-posts=""
              onClick={() => setPicker('posts')}
              className={addClass}
            >
              <span className={addInner}>
                <IconPlus size={ICON_SIZE.inline} />
                Add from Pipeline
              </span>
            </Button>
            <Button
              type="button"
              data-plan-add-drafts=""
              onClick={() => setPicker('drafts')}
              className={addClass}
            >
              <span className={addInner}>
                <IconPlus size={ICON_SIZE.inline} />
                Add drafts
              </span>
            </Button>
          </div>
        </div>
      </PlanPage>

      <PostPicker
        open={props.open && picker !== null}
        onClose={() => setPicker(null)}
        mode={picker ?? 'posts'}
        selected={picked}
        onToggle={togglePicked}
        selectedBriefs={[]}
        onToggleBrief={() => {}}
        // A Draft plan allows drafts (the picker's own drafts gate reads this).
        channelHasClient={false}
      />

      <ConceptSheet
        open={props.open && conceptOpen}
        mode={editKey !== null ? 'edit' : 'add'}
        form={conceptForm}
        onChange={setConceptForm}
        onSubmit={submitConcept}
        onClose={closeConcept}
        range={range}
        today={today}
        dayCounts={counts}
        {...(canAttach ? { uploadFile } : {})}
      />

      <PlanDayPickerSheet
        open={props.open && dayItem !== null}
        title={shownDayItem?.title ?? ''}
        subline={shownDayItem !== null ? dayPickerSubline(shownDayItem, range) : ''}
        range={range}
        selected={shownDayItem?.day ?? null}
        today={today}
        counts={counts}
        pipelineDay={
          shownDayItem !== null && shownDayItem.kind !== 'concept' ? shownDayItem.orig : null
        }
        onPick={pickDay}
        onClose={() => setDayFor(null)}
      />

      <PlanDatesSheet
        open={props.open && datesOpen}
        range={range}
        onSave={saveDates}
        onClose={() => setDatesOpen(false)}
      />

      {props.open && closeConfirm ? (
        <ConfirmDialog
          title={PLAN_DISCARD.title}
          message={PLAN_DISCARD.message}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setCloseConfirm(false);
            // Release first: the guard's entry pops before the screen's own.
            guard.release();
            props.onClose();
          }}
          onCancel={() => setCloseConfirm(false)}
        />
      ) : null}
    </>
  );
}

/** A row's type line: "Concept", "Draft", or "Post · In review". Pure. */
export function composeKindLabel(item: ComposeItem): string {
  if (item.kind === 'concept') return 'Concept';
  if (item.kind === 'draft') return 'Draft';
  return `Post · ${stageLabel(item.stage)}`;
}

/**
 * One item on the New plan screen: thumb, title and type line, the remove X
 * (44px), a concept's description (2 lines), the full-width day button and
 * its note. A row that needs a day is drawn in warning colour. A concept's
 * title area opens it in the concept sheet.
 */
export function ComposeItemRow(props: {
  item: ComposeItem;
  rowRef?: (el: HTMLDivElement | null) => void;
  onDay: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  const { item } = props;
  const need = item.day === null;
  const note = composeItemNote(item);
  const head = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold',
          item.kind === 'concept' && 'border-[1.5px] border-dashed border-border-strong text-fg-3',
          item.kind === 'post' && 'bg-accent-soft text-accent',
          item.kind === 'draft' && 'bg-panel-2 text-fg-3',
        )}
      >
        {item.kind === 'concept' ? 'C' : item.title.charAt(0).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span data-plan-item-title="" className="truncate text-lg font-semibold text-fg">
          {item.title}
        </span>
        <span className="text-sm text-fg-3">{composeKindLabel(item)}</span>
      </span>
    </>
  );
  return (
    <div
      ref={props.rowRef}
      data-plan-compose-item={item.kind}
      data-plan-compose-flag={need ? 'need' : 'ok'}
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-2.5',
        need ? 'border-warn bg-warn-soft' : 'border-border bg-panel',
      )}
    >
      <div className="flex items-center gap-2.5">
        {item.kind === 'concept' ? (
          <PressableRow
            type="button"
            data-plan-draft-concept-edit=""
            aria-label={`Edit ${item.title}`}
            onClick={props.onEdit}
            onContextMenu={(event) => event.preventDefault()}
            className={cn('-m-1 flex min-w-0 flex-1 items-center gap-2.5 p-1', NO_TOUCH_SELECT)}
          >
            {head}
          </PressableRow>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">{head}</div>
        )}
        <IconButton
          type="button"
          data-plan-compose-remove=""
          label={`Remove ${item.title}`}
          onClick={props.onRemove}
          className="-my-1.5 -mr-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconX size={ICON_SIZE.control} />
        </IconButton>
      </div>
      {item.kind === 'concept' && item.description !== '' ? (
        <p className="line-clamp-2 px-0.5 text-md leading-[1.45] text-fg-3">{item.description}</p>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        data-plan-day-button={need ? 'need' : item.day === 'none' ? 'none' : 'day'}
        onClick={props.onDay}
        className={cn(
          'w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          need ? 'border-warn text-warn' : 'bg-panel-2',
        )}
      >
        <span data-plan-day-inner="" className="flex w-full items-center justify-between gap-2">
          {need ? (
            <>
              {PICK_A_DAY}
              <IconChevronRight size={ICON_SIZE.inline} />
            </>
          ) : (
            <>
              {item.day === 'none' ? (
                <span className="font-medium text-fg-3">{NO_DATE_LABEL}</span>
              ) : (
                <span>{formatCivilDayHeader(item.day as string)}</span>
              )}
              <span className="text-fg-3">
                <IconCalendar size={ICON_SIZE.inline} />
              </span>
            </>
          )}
        </span>
      </Button>
      {note !== null ? (
        <p
          data-plan-compose-note={note.warn ? 'warn' : 'info'}
          className={cn(
            'px-0.5 text-sm leading-[1.4]',
            note.warn ? 'font-medium text-warn' : 'text-fg-3',
          )}
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

/** Whether the notice shows: a share is counted for this chat and its time has not run out. Pure. */
export function noticeShown(count: number, expired: number): boolean {
  return count > 0 && count !== expired;
}

/**
 * The chat's composer form inside `host`: the last form holding a text area.
 * Walks elements from the notice's ref (no selector strings), so it runs on
 * every engine. Null when none is mounted.
 */
export function composerFormIn(host: Pick<Element, 'getElementsByTagName'>): Element | null {
  const forms = Array.from(host.getElementsByTagName('form'));
  for (let i = forms.length - 1; i >= 0; i -= 1) {
    const form = forms[i];
    if (form !== undefined && form.getElementsByTagName('textarea').length > 0) return form;
  }
  return null;
}

/** How long the "Plan shared" notice stays. */
export const PLAN_SHARED_NOTICE_MS = 4_000;

/**
 * The "Plan shared" notice, drawn inside the chat just above its composer (so
 * it never covers a plan page header, which sits above the chat). From its own
 * ref it measures the composer form in its chat surface; opacity motion only; the timer
 * and frame are cleared on unmount and on a new notice.
 */
export function PlanSharedNotice(props: {
  /** Bumped per share; 0 shows nothing. */
  shareCount: number;
  text: string;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  // The last count whose time ran out: visibility is derived, so a count of 0
  // (another chat) hides the notice at once, with no timer left to clear it.
  const [expired, setExpired] = useState(0);
  const [bottom, setBottom] = useState<number | null>(null);
  const count = props.shareCount;
  useEffect(() => {
    if (count === 0) return;
    const host = ref.current?.parentElement ?? null;
    const form = host !== null ? composerFormIn(host) : null;
    if (host !== null && form !== null) {
      setBottom(host.getBoundingClientRect().bottom - form.getBoundingClientRect().top + 8);
    }
    const timer = setTimeout(() => setExpired(count), PLAN_SHARED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [count]);
  const shown = noticeShown(count, expired);
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-plan-shared-notice={shown ? 'shown' : 'hidden'}
      style={{ bottom: bottom ?? 96 }}
      className={cn(
        'pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3 transition-opacity duration-base motion-reduce:transition-none',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      {shown ? (
        <span className="rounded-lg border border-border-strong bg-panel px-3.5 py-2.5 text-base font-medium text-fg shadow-[var(--strip-shadow)]">
          {props.text}
        </span>
      ) : null}
    </div>
  );
}
