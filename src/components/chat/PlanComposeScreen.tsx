// The New plan screen (full page, one history step), opened from the Plans
// sheet. Title, From and To (this Monday to Sunday in the workspace zone by
// default, at most 92 days), concepts (title, description, up to 20 library
// files) and posts from Pipeline (drafts allowed). Every new plan is a Draft
// (audience team); there is no audience choice. Nothing is written until
// "Create plan": then plan_create, each concept in order and the posts in one
// call, in sequence with one trace id. No card is ever sent to chat. A failed
// step keeps what was created and offers Retry, which resumes from that step
// (the form locks once the plan exists, so a retry never adds a concept
// twice). On success the screen closes and the new plan's Plan screen opens.
// Tokens only; translateY motion only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PostCardFields } from '@srtdio/posts';
import { planConceptAdd, planCreate, planPostsAdd } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { IconX } from '@/components/ui/icons';
import {
  ConceptSheet,
  EMPTY_CONCEPT,
  FIELD,
  conceptFormValid,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import { togglePost } from '@/components/chat/post-picker';
import { PlanPage } from '@/components/chat/PlanScreen';
import {
  CREATE_PLAN_LABEL,
  DRAFT_PROBLEM_COPY,
  NO_DATE_LABEL,
  PLAN_TITLE_MAX,
  defaultPlanRange,
  draftProblem,
  shortDay,
  stageLabel,
} from '@/components/chat/plan-card';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { newMessageId } from '@/lib/chat/message-id';
import {
  PLAN_CREATE_FAILED,
  conceptAddArgs,
  createShareEpoch,
  initialShareProgress,
  runPlanShare,
  type DraftConcept,
  type PlanDraft,
  type ShareEpoch,
  type ShareProgress,
} from '@/lib/chat/plans';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

/** Every new plan is a Draft: plan_create's audience. */
export const NEW_PLAN_AUDIENCE = 'team';

export function PlanComposeScreen(props: {
  open: boolean;
  workspaceId: string;
  timeZone: string;
  onClose: () => void;
  /**
   * The plan exists with its concepts and posts: open its Plan screen.
   * `stale` is true when the screen was closed (or reopened) meanwhile: the
   * current form is left alone and nothing opens.
   */
  onCreated: (planId: string, stale: boolean) => void;
}): ReactElement | null {
  const [title, setTitle] = useState('');
  const [range, setRange] = useState(() => defaultPlanRange(new Date(), props.timeZone));
  const [concepts, setConcepts] = useState<DraftConceptItem[]>([]);
  const [posts, setPosts] = useState<PostCardFields[]>([]);
  const [picker, setPicker] = useState<'posts' | 'drafts' | null>(null);
  const [conceptOpen, setConceptOpen] = useState(false);
  // The draft concept the sheet edits; null while it adds a new one.
  const [editKey, setEditKey] = useState<string | null>(null);
  // Concept uploads go as comments' do (library origin).
  const { canAttach, uploadFile } = useCommentAttachments();
  const [conceptForm, setConceptForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [progress, setProgress] = useState<ShareProgress>(() =>
    initialShareProgress(newMessageId()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triedShare, setTriedShare] = useState(false);
  const traceRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Every open and close starts a new epoch: a share still running from an
  // earlier form never lands its progress or error on the current one.
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
    setRange(defaultPlanRange(new Date(), timeZone));
    setConcepts([]);
    setPosts([]);
    setPicker(null);
    setConceptOpen(false);
    setEditKey(null);
    setConceptForm(EMPTY_CONCEPT);
    setProgress(initialShareProgress(newMessageId()));
    setBusy(false);
    setError(null);
    setTriedShare(false);
    traceRef.current = null;
  }, [open, timeZone]);

  // Once the plan exists the form is fixed: a retry resumes, never re-adds.
  const locked = progress.planId !== null || busy;
  const problem = draftProblem({ title, startsOn: range.startsOn, endsOn: range.endsOn });

  // Drafts list in the plan's order: dated by day, undated last (stable).
  const shownConcepts = useMemo(
    () =>
      concepts
        .map((c, at) => ({ c, at }))
        .sort(
          (a, b) =>
            (a.c.date === '' ? 1 : 0) - (b.c.date === '' ? 1 : 0) ||
            a.c.date.localeCompare(b.c.date) ||
            a.at - b.at,
        )
        .map(({ c }) => c),
    [concepts],
  );

  const create = async (): Promise<void> => {
    setTriedShare(true);
    if (busy || problem !== null) return;
    const token = epoch.current();
    setBusy(true);
    setError(null);
    const traceId = traceRef.current ?? generateTraceId();
    traceRef.current = traceId;
    const draft: PlanDraft = {
      workspaceId: props.workspaceId,
      title: title.trim(),
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      audience: NEW_PLAN_AUDIENCE,
      concepts: concepts.map(
        (c): DraftConcept => ({
          key: c.key,
          title: c.title.trim(),
          description: c.description.trim(),
          versionIds: c.files.map((f) => f.versionId),
          targetDate: c.date !== '' ? c.date : null,
        }),
      ),
      postIds: posts.map((p) => p.id),
    };
    const result = await runPlanShare(
      {
        create: (d, trace) =>
          planCreate(supabase, {
            p_workspace_id: d.workspaceId,
            p_title: d.title,
            p_starts_on: d.startsOn,
            p_ends_on: d.endsOn,
            p_audience: d.audience,
            p_trace_id: trace,
          }),
        conceptAdd: (planId, c, trace) =>
          planConceptAdd(supabase, conceptAddArgs(planId, c, trace)),
        postsAdd: (planId, ids, trace) =>
          planPostsAdd(supabase, { p_plan_id: planId, p_post_ids: ids, p_trace_id: trace }),
      },
      draft,
      progress,
      traceId,
    );
    const planId = result.progress.planId;
    if (!mounted.current || !epoch.isCurrent(token)) {
      // The form this create started from is gone: nothing opens.
      if (result.ok && planId !== null) props.onCreated(planId, true);
      return;
    }
    setBusy(false);
    setProgress(result.progress);
    if (!result.ok) {
      logger.warn('chat: plan create failed', {
        trace_id: traceId,
        step: result.step,
        plan_id: result.progress.planId,
        error: result.message,
      });
      setError(PLAN_CREATE_FAILED);
      return;
    }
    if (planId !== null) props.onCreated(planId, false);
  };

  // Add appends a new concept; Edit replaces the draft in place (same key,
  // same position). Local only: nothing is written until Share.
  const submitConcept = (): void => {
    if (!conceptFormValid(conceptForm)) return;
    const form = conceptForm;
    setConcepts((prev) =>
      editKey !== null
        ? replaceDraftConcept(prev, editKey, form)
        : [...prev, { ...form, key: newMessageId() }],
    );
    setConceptForm(EMPTY_CONCEPT);
    setEditKey(null);
    setConceptOpen(false);
  };

  const editConcept = (key: string): void => {
    if (locked) return;
    const form = draftConceptForm(concepts, key);
    if (form === null) return;
    setConceptForm(form);
    setEditKey(key);
    setConceptOpen(true);
  };

  const footer = (
    <div className="flex flex-col gap-1.5">
      {error !== null ? (
        <p role="alert" data-plan-share-error="" className="text-[13px] text-bad">
          {error}
        </p>
      ) : null}
      <Button
        size="lg"
        variant="primary"
        data-plan-create=""
        className="min-h-[50px] w-full"
        disabled={busy || problem !== null}
        onClick={() => void create()}
      >
        {busy ? 'Creating…' : error !== null ? 'Retry' : CREATE_PLAN_LABEL}
      </Button>
    </div>
  );

  return (
    <>
      <PlanPage
        open={props.open}
        testId="compose"
        title="New plan"
        backLabel="Close"
        backIcon={<IconX size={22} />}
        onBack={props.onClose}
        footer={footer}
      >
        <div className="flex flex-col gap-[18px] p-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="plan-title" className="text-[13px] text-fg-3">
              Title
            </label>
            <input
              id="plan-title"
              data-plan-title=""
              value={title}
              maxLength={PLAN_TITLE_MAX}
              disabled={locked}
              autoComplete="off"
              placeholder="Week of 12 Oct"
              onChange={(e) => setTitle(e.target.value)}
              className={FIELD}
            />
            {triedShare && problem === 'title' ? (
              <p className="text-[13px] text-bad">{DRAFT_PROBLEM_COPY.title}</p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['startsOn', 'From'],
                  ['endsOn', 'To'],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="flex w-full min-w-0 flex-col gap-1">
                  <span className="text-[13px] text-fg-3">{label}</span>
                  <input
                    type="date"
                    data-plan-date={field}
                    value={range[field]}
                    disabled={locked}
                    onChange={(e) => setRange((r) => ({ ...r, [field]: e.target.value }))}
                    className={DATE_FIELD}
                  />
                </label>
              ))}
            </div>
            {problem === 'dates' || problem === 'too_long' ? (
              <p className="text-[13px] text-bad">{DRAFT_PROBLEM_COPY[problem]}</p>
            ) : null}
          </div>

          <section className="flex flex-col gap-2" aria-label="Concepts">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-fg">Concepts</h3>
              <span className="text-[13px] text-fg-3">Ideas before they are posts</span>
            </div>
            {shownConcepts.map((c) => (
              <DraftConceptRow
                key={c.key}
                concept={c}
                locked={locked}
                onEdit={() => editConcept(c.key)}
                onRemove={() => setConcepts((prev) => removeDraftConcept(prev, c.key))}
              />
            ))}
            <button
              type="button"
              data-plan-add-concept=""
              disabled={locked}
              onClick={() => {
                setConceptForm(EMPTY_CONCEPT);
                setEditKey(null);
                setConceptOpen(true);
              }}
              className="min-h-[44px] rounded-lg border border-dashed border-border-strong text-[15px] font-medium text-accent disabled:opacity-60"
            >
              + Add concept
            </button>
          </section>

          <section className="flex flex-col gap-2" aria-label="Posts">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-fg">Posts</h3>
              <span className="text-[13px] text-fg-3">From Pipeline</span>
            </div>
            {posts.map((p) => (
              <div
                key={p.id}
                data-plan-draft-post=""
                className="flex items-center gap-3 rounded-lg border border-border bg-panel p-3"
              >
                <span className="h-12 w-12 shrink-0 rounded-md bg-accent-soft" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">
                  {p.title}
                </span>
                <span className="rounded-md bg-panel-2 px-2 py-0.5 text-[13px] text-fg-2">
                  {stageLabel(p.stage)}
                </span>
              </div>
            ))}
            <button
              type="button"
              data-plan-add-posts=""
              disabled={locked}
              onClick={() => setPicker('posts')}
              className="min-h-[44px] rounded-lg border border-dashed border-border-strong text-[15px] font-medium text-accent disabled:opacity-60"
            >
              + Add from Pipeline
            </button>
            <button
              type="button"
              data-plan-add-drafts=""
              disabled={locked}
              onClick={() => setPicker('drafts')}
              className="min-h-[44px] rounded-lg border border-dashed border-border-strong text-[15px] font-medium text-accent disabled:opacity-60"
            >
              + Add drafts
            </button>
          </section>
        </div>
      </PlanPage>

      <PostPicker
        open={props.open && picker !== null}
        onClose={() => setPicker(null)}
        mode={picker ?? 'posts'}
        selected={posts}
        onToggle={(post) => setPosts((prev) => togglePost(prev, post))}
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
        onClose={() => setConceptOpen(false)}
        {...(canAttach ? { uploadFile } : {})}
      />
    </>
  );
}

/** A concept added on the New plan screen, before the plan exists. */
export type DraftConceptItem = ConceptForm & { key: string };

/**
 * The From / To inputs shrink to their half of the row: WebKit's date input
 * keeps an intrinsic min width (and centres its value) unless its native look
 * is reset, which on a 320px iPhone pushed To past the screen edge.
 */
export const DATE_FIT =
  'block min-w-0 appearance-none [-webkit-appearance:none] [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:min-h-[1.5em] [&::-webkit-calendar-picker-indicator]:m-0';

/** The date inputs: the field look with a slimmer side padding so the date fits at 320px. */
export const DATE_FIELD = cn(
  FIELD.replace(' px-3.5 ', ' px-2.5 '),
  DATE_FIT,
  'font-mono text-[15px]',
);

/** The sheet's form for a draft concept (its fields and files); null when gone. Pure. */
export function draftConceptForm(
  concepts: readonly DraftConceptItem[],
  key: string,
): ConceptForm | null {
  const c = concepts.find((x) => x.key === key);
  if (c === undefined) return null;
  return { title: c.title, description: c.description, date: c.date, files: [...c.files] };
}

/** The list with the draft at `key` replaced in place (same key, same position). Pure. */
export function replaceDraftConcept(
  concepts: readonly DraftConceptItem[],
  key: string,
  form: ConceptForm,
): DraftConceptItem[] {
  return concepts.map((c) => (c.key === key ? { ...form, key } : c));
}

/** The list without the draft at `key`. Pure. */
export function removeDraftConcept(
  concepts: readonly DraftConceptItem[],
  key: string,
): DraftConceptItem[] {
  return concepts.filter((c) => c.key !== key);
}

/**
 * A draft concept on the New plan screen: the whole row (but the X) opens it
 * in the concept sheet; the X removes it. Both are off while the screen is
 * locked (a share is running or the plan exists).
 */
export function DraftConceptRow(props: {
  concept: DraftConceptItem;
  locked: boolean;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  const c = props.concept;
  return (
    <div
      data-plan-draft-concept=""
      className="flex items-start rounded-lg border border-border bg-panel"
    >
      <button
        type="button"
        data-plan-draft-concept-edit=""
        aria-label={`Edit ${c.title}`}
        disabled={props.locked}
        onClick={props.onEdit}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          'flex min-h-[44px] min-w-0 flex-1 items-start gap-3 rounded-lg p-3 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent',
          NO_TOUCH_SELECT,
        )}
      >
        <span className="h-12 w-12 shrink-0 rounded-md border border-dashed border-border-strong bg-panel-3" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-plan-draft-concept-title=""
            className="truncate text-[15px] font-semibold text-fg"
          >
            {c.title}
          </span>
          <span className="line-clamp-2 text-[13px] text-fg-3">
            {c.description !== ''
              ? c.description
              : `${c.files.length} ${c.files.length === 1 ? 'file' : 'files'}`}
          </span>
          <span
            data-plan-draft-concept-date={c.date !== '' ? 'dated' : 'none'}
            className={cn('text-[13px] text-fg-3', c.date !== '' && 'font-mono')}
          >
            {c.date !== '' ? shortDay(c.date) : NO_DATE_LABEL}
          </span>
        </span>
      </button>
      <button
        type="button"
        data-plan-draft-concept-remove=""
        aria-label={`Remove ${c.title}`}
        disabled={props.locked}
        onClick={props.onRemove}
        className="m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 disabled:hover:bg-transparent"
      >
        <IconX size={18} />
      </button>
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
        <span className="rounded-lg border border-border-strong bg-panel px-3.5 py-2.5 text-sm font-medium text-fg shadow-lg">
          {props.text}
        </span>
      ) : null}
    </div>
  );
}
