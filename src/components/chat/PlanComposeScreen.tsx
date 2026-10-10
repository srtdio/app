// The New plan screen (full page, one history step), opened from the tray's
// Plan tile. Title, From and To (this Monday to Sunday in the workspace zone
// by default, at most 92 days), who can see it (Client and team, or Team only),
// concepts (title, description, up to 20 library files) and posts from
// Pipeline (drafts too, for a team plan in a chat with no client). Nothing is
// written until "Share in chat": then plan_create, each concept in order, the
// posts in one call, and chat_plan_share, in sequence with one trace id. A
// failed step keeps what was created and offers Retry, which resumes from that
// step (the form locks once the plan exists, so a retry never adds a concept
// twice). On success the screen closes, the card lands in the thread and a
// toast says "Plan shared". Tokens only; translateY motion only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PostCardFields } from '@srtdio/posts';
import { chatPlanShare, planConceptAdd, planCreate, planPostsAdd } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { IconX } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media/Thumbnail';
import { AssetPicker } from '@/components/chat/AssetPicker';
import { PostPicker } from '@/components/chat/PostPicker';
import { togglePost } from '@/components/chat/post-picker';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ConceptDateField, PlanPage } from '@/components/chat/PlanScreen';
import {
  AUDIENCE_HINTS,
  CONCEPT_FILES_MAX,
  DRAFT_PROBLEM_COPY,
  NO_DATE_LABEL,
  PLAN_TITLE_MAX,
  defaultPlanRange,
  draftProblem,
  draftsButtonShown,
  shortDay,
  stageLabel,
  teamPlanBlocked,
} from '@/components/chat/plan-card';
import type { LibraryAsset } from '@/lib/chat/asset-picker';
import { newMessageId } from '@/lib/chat/message-id';
import {
  PLAN_SHARE_FAILED,
  TEAM_PLAN_CLIENT_CHAT,
  conceptAddArgs,
  createShareEpoch,
  initialShareProgress,
  runPlanShare,
  type DraftConcept,
  type PlanAudience,
  type PlanDraft,
  type ShareEpoch,
  type ShareProgress,
} from '@/lib/chat/plans';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

/** A concept being added in the sheet (files keep their names for the chips). */
interface ConceptForm {
  title: string;
  description: string;
  files: LibraryAsset[];
  /** "YYYY-MM-DD", or '' for no date. */
  date: string;
}

const EMPTY_CONCEPT: ConceptForm = { title: '', description: '', files: [], date: '' };

const FIELD =
  'min-h-[48px] w-full rounded-lg border border-border bg-panel px-3.5 text-base text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';

export function PlanComposeScreen(props: {
  open: boolean;
  workspaceId: string;
  channelId: string;
  timeZone: string;
  /** A client among the chat's members; null while unknown. */
  channelHasClient: boolean | null;
  onClose: () => void;
  /** The share landed: the recorded message row and the trace it carried. */
  /**
   * The share landed: the recorded message row and the trace it carried.
   * `stale` is true when the screen was closed (or reopened) meanwhile: the
   * row still goes into the thread, but the current form is left alone.
   */
  onShared: (row: ChatMessageRow, traceId: string, stale: boolean) => void;
}): ReactElement | null {
  const [title, setTitle] = useState('');
  const [range, setRange] = useState(() => defaultPlanRange(new Date(), props.timeZone));
  const [audience, setAudience] = useState<PlanAudience>('client');
  const [concepts, setConcepts] = useState<Array<ConceptForm & { key: string }>>([]);
  const [posts, setPosts] = useState<PostCardFields[]>([]);
  const [picker, setPicker] = useState<'posts' | 'drafts' | null>(null);
  const [conceptOpen, setConceptOpen] = useState(false);
  const [conceptForm, setConceptForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [assetsOpen, setAssetsOpen] = useState(false);
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
    setAudience('client');
    setConcepts([]);
    setPosts([]);
    setPicker(null);
    setConceptOpen(false);
    setConceptForm(EMPTY_CONCEPT);
    setAssetsOpen(false);
    setProgress(initialShareProgress(newMessageId()));
    setBusy(false);
    setError(null);
    setTriedShare(false);
    traceRef.current = null;
  }, [open, timeZone]);

  // Once the plan exists the form is fixed: a retry resumes, never re-adds.
  const locked = progress.planId !== null || busy;
  const problem = draftProblem({ title, startsOn: range.startsOn, endsOn: range.endsOn });
  const showDrafts = draftsButtonShown(audience, props.channelHasClient);
  // A Team only plan is never shared into a chat that has (or may have) a
  // client: Share stays off and nothing is written. The server check stays as
  // the fallback.
  const teamBlocked = teamPlanBlocked(audience, props.channelHasClient);
  // A client plan holds no drafts: switching drops any picked ones.
  const shownPosts = useMemo(
    () => (audience === 'client' ? posts.filter((p) => p.stage !== 'draft') : posts),
    [audience, posts],
  );

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

  const share = async (): Promise<void> => {
    setTriedShare(true);
    if (busy || problem !== null || teamBlocked) return;
    const token = epoch.current();
    setBusy(true);
    setError(null);
    const traceId = traceRef.current ?? generateTraceId();
    traceRef.current = traceId;
    const draft: PlanDraft = {
      workspaceId: props.workspaceId,
      channelId: props.channelId,
      title: title.trim(),
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      audience,
      concepts: concepts.map(
        (c): DraftConcept => ({
          key: c.key,
          title: c.title.trim(),
          description: c.description.trim(),
          versionIds: c.files.map((f) => f.versionId),
          targetDate: c.date !== '' ? c.date : null,
        }),
      ),
      postIds: shownPosts.map((p) => p.id),
    };
    let row: ChatMessageRow | null = null;
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
        share: async (planId, channelId, messageId, trace) => {
          const shared = await chatPlanShare(supabase, {
            p_id: messageId,
            p_channel_id: channelId,
            p_plan_id: planId,
            p_trace_id: trace,
          });
          if (shared.ok) row = shared.data;
          return shared;
        },
      },
      draft,
      progress,
      traceId,
    );
    if (!mounted.current || !epoch.isCurrent(token)) {
      // The form this share started from is gone: only the landed row counts.
      if (result.ok && row !== null) props.onShared(row, traceId, true);
      return;
    }
    setBusy(false);
    setProgress(result.progress);
    if (!result.ok) {
      logger.warn('chat: plan share failed', {
        trace_id: traceId,
        step: result.step,
        plan_id: result.progress.planId,
        error: result.message,
      });
      setError(result.copy);
      return;
    }
    if (row !== null) props.onShared(row, traceId, false);
  };

  const addConcept = (): void => {
    const t = conceptForm.title.trim();
    if (t === '' || t.length > PLAN_TITLE_MAX) return;
    setConcepts((prev) => [...prev, { ...conceptForm, key: newMessageId() }]);
    setConceptForm(EMPTY_CONCEPT);
    setConceptOpen(false);
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
        data-plan-share=""
        className="min-h-[50px] w-full"
        disabled={busy || problem !== null || teamBlocked}
        onClick={() => void share()}
      >
        {busy ? 'Sharing…' : error === PLAN_SHARE_FAILED ? 'Retry' : 'Share in chat'}
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
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-[13px] text-fg-3">{label}</span>
                  <input
                    type="date"
                    data-plan-date={field}
                    value={range[field]}
                    disabled={locked}
                    onChange={(e) => setRange((r) => ({ ...r, [field]: e.target.value }))}
                    className={cn(FIELD, 'font-mono text-[15px]')}
                  />
                </label>
              ))}
            </div>
            {problem === 'dates' || problem === 'too_long' ? (
              <p className="text-[13px] text-bad">{DRAFT_PROBLEM_COPY[problem]}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-fg-3">Who can see it</span>
            <div
              role="group"
              aria-label="Who can see it"
              className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-panel p-1"
            >
              {(
                [
                  ['client', 'Client and team'],
                  ['team', 'Team only'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={audience === value}
                  data-plan-audience={value}
                  disabled={locked}
                  onClick={() => setAudience(value)}
                  className={cn(
                    'min-h-[44px] rounded-md text-[15px] font-medium disabled:opacity-60',
                    audience === value ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:bg-panel-2',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[13px] leading-[18px] text-fg-3">{AUDIENCE_HINTS[audience]}</p>
            {teamBlocked ? (
              <p
                role="status"
                data-plan-team-blocked=""
                className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-[13px] leading-[18px] text-warn"
              >
                {TEAM_PLAN_CLIENT_CHAT}
              </p>
            ) : null}
          </div>

          <section className="flex flex-col gap-2" aria-label="Concepts">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-fg">Concepts</h3>
              <span className="text-[13px] text-fg-3">Ideas before they are posts</span>
            </div>
            {shownConcepts.map((c) => (
              <div
                key={c.key}
                data-plan-draft-concept=""
                className="flex items-start gap-3 rounded-lg border border-border bg-panel p-3"
              >
                <span className="h-12 w-12 shrink-0 rounded-md border border-dashed border-border-strong bg-panel-3" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-semibold text-fg">{c.title}</span>
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
                {!locked ? (
                  <button
                    type="button"
                    aria-label={`Remove ${c.title}`}
                    onClick={() => setConcepts((prev) => prev.filter((x) => x.key !== c.key))}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-panel-2"
                  >
                    <IconX size={18} />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              data-plan-add-concept=""
              disabled={locked}
              onClick={() => {
                setConceptForm(EMPTY_CONCEPT);
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
            {shownPosts.map((p) => (
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
            {showDrafts ? (
              <button
                type="button"
                data-plan-add-drafts=""
                disabled={locked}
                onClick={() => setPicker('drafts')}
                className="min-h-[44px] rounded-lg border border-dashed border-border-strong text-[15px] font-medium text-accent disabled:opacity-60"
              >
                + Add drafts
              </button>
            ) : null}
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
        channelHasClient={audience === 'team' ? props.channelHasClient : true}
      />

      <Sheet
        open={props.open && conceptOpen}
        onClose={() => setConceptOpen(false)}
        title="Add concept"
        footer={
          <div className="grid w-full grid-cols-2 gap-2">
            <Button size="lg" variant="ghost" onClick={() => setConceptOpen(false)}>
              Cancel
            </Button>
            <Button
              size="lg"
              variant="primary"
              data-plan-concept-save=""
              disabled={conceptForm.title.trim() === ''}
              onClick={addConcept}
            >
              Add
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-3">Title</span>
            <input
              data-plan-concept-title=""
              value={conceptForm.title}
              maxLength={PLAN_TITLE_MAX}
              autoComplete="off"
              onChange={(e) => setConceptForm((f) => ({ ...f, title: e.target.value }))}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-3">Description</span>
            <textarea
              data-plan-concept-description=""
              value={conceptForm.description}
              maxLength={5000}
              rows={3}
              onChange={(e) => setConceptForm((f) => ({ ...f, description: e.target.value }))}
              className={cn(FIELD, 'py-2.5')}
            />
          </label>
          <ConceptDateField
            value={conceptForm.date}
            onChange={(date) => setConceptForm((f) => ({ ...f, date }))}
          />
          {conceptForm.files.length > 0 ? (
            <div className="grid grid-cols-4 gap-1.5">
              {conceptForm.files.map((f) => (
                <div
                  key={f.versionId}
                  data-plan-concept-file=""
                  className="relative overflow-hidden rounded-md border border-border bg-panel-2"
                >
                  <Thumbnail
                    assetVersionId={f.versionId}
                    cache={sharedCardPresignCache()}
                    presignEnabled={PRESIGN_ENABLED}
                    fallback={{ kind: 'glyph' }}
                    alt={f.name}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <Button
            size="lg"
            data-plan-concept-files=""
            disabled={conceptForm.files.length >= CONCEPT_FILES_MAX}
            onClick={() => setAssetsOpen(true)}
          >
            Add files
          </Button>
        </div>
      </Sheet>

      <AssetPicker
        open={props.open && assetsOpen}
        onClose={() => setAssetsOpen(false)}
        onConfirm={(picks) => {
          setAssetsOpen(false);
          setConceptForm((f) => {
            const seen = new Set(f.files.map((x) => x.versionId));
            const next = [...f.files, ...picks.filter((p) => !seen.has(p.versionId))];
            return { ...f, files: next.slice(0, CONCEPT_FILES_MAX) };
          });
        }}
      />
    </>
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
