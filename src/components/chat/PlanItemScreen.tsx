// One plan item, full page over the Plan screen (its own history step): the
// kind and place ("Concept 1 of 3"), the media (a concept's library files, or
// the post's own card), title and description, a status box (Pipeline for a
// post, Team for the agency side, Client), the viewer's actions, and the
// comments with a composer. The agency marks team approval (confirmed) or asks
// changes; a client approves or asks changes on a concept; on a post a client
// only opens the post (its sheet approves, unchanged). Comments: the agency
// sees all and picks Everyone or Team only; a client sees Everyone ones (RLS).
// A comment appends at once and keeps its text on failure. One read per table
// per open, bounded at 5s; the body paints once it settles. Tokens only.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactElement, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { planConceptEdit, planItemCommentCreate, planItemReview } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/toast';
import { IconArrowUp, IconLock } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media/Thumbnail';
import {
  PRESIGN_ENABLED,
  SharedPostCards,
  approverRolesOf,
  sharedCardPresignCache,
  useThreadCardCache,
} from '@/components/chat/PostCard';
import { PostSheet } from '@/components/chat/PostSheet';
import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { indexPostsById, postRoute, sharedPostViews } from '@/components/chat/post-card';
import {
  COMMENT_FAILED,
  STATUS_LABELS,
  TEAM_APPROVE_CONFIRM,
  TEAM_ONLY_LABEL,
  clientApproveConfirm,
  clientStatus,
  itemDateLabel,
  itemKindLabel,
  reviewStatus,
  stageLabel,
  type PillTone,
} from '@/components/chat/plan-card';
import {
  PlanConfirmSheet,
  PlanPage,
  PlanPill,
  ScreenFailed,
  rowTitle,
  useScreenRead,
} from '@/components/chat/PlanScreen';
import { readProfiles } from '@/lib/chat-reads';
import {
  conceptEditArgs,
  conceptEditUnchanged,
  dispatchPlanChanged,
  readItemScreen,
  type CommentVisibility,
  type ItemScreenData,
  type PlanBundle,
  type PlanCommentRow,
  type PlanItemRow,
  type ReviewSide,
  type ReviewStatus,
} from '@/lib/chat/plans';
import { formatClockTime, workspaceTimeZone } from '@/lib/chat/time-format';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import type { PresignDeps } from '@/lib/asset-presign';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';

/** Whether a write started on `itemId` still belongs to the screen as it is now. Pure. */
export function isLiveItem(live: { itemId: string; open: boolean }, itemId: string): boolean {
  return live.open && live.itemId === itemId;
}

/** What the action row offers. Pure. */
export type ItemActions =
  | { kind: 'review'; side: ReviewSide; approveLabel: string; openInPipeline: boolean }
  | { kind: 'open-post' }
  | { kind: 'none' };

/**
 * The viewer's actions on an item: the agency reviews as the team (a post item
 * also opens in Pipeline); a client reviews a concept on a client plan, and
 * only opens a post item. An unknown side gets none. Pure.
 */
export function itemActions(
  side: ViewerSide,
  item: Pick<PlanItemRow, 'kind'>,
  audience: PlanBundle['plan']['audience'],
): ItemActions {
  if (side === 'agency') {
    return {
      kind: 'review',
      side: 'team',
      approveLabel: 'Team approve',
      openInPipeline: item.kind === 'post',
    };
  }
  if (side === 'client') {
    if (item.kind === 'post') return { kind: 'open-post' };
    if (audience === 'client') {
      return { kind: 'review', side: 'client', approveLabel: 'Approve', openInPipeline: false };
    }
  }
  return { kind: 'none' };
}

/**
 * The action buttons in order: the agency on a post item gets "Open in
 * pipeline" and "Team approve" only (changes are asked in Pipeline). Pure.
 */
export function actionLabels(actions: ItemActions): string[] {
  if (actions.kind === 'open-post') return ['Open post'];
  if (actions.kind === 'none') return [];
  return [actions.openInPipeline ? 'Open in pipeline' : 'Ask changes', actions.approveLabel];
}

/** The status box rows: Pipeline (post), Team (agency), Client. Pure. */
export function statusRows(
  bundle: PlanBundle,
  item: PlanItemRow,
  side: ViewerSide,
  overrides: Partial<Record<ReviewSide, ReviewStatus>> = {},
): Array<{ label: string; value: string; tone: PillTone }> {
  const rows: Array<{ label: string; value: string; tone: PillTone }> = [];
  if (item.kind === 'post' && item.post_id !== null) {
    rows.push({
      label: 'Pipeline',
      value: stageLabel(bundle.postStages[item.post_id]),
      tone: 'neutral',
    });
  }
  const tone = (s: ReviewStatus): PillTone =>
    s === 'approved' ? 'good' : s === 'changes' ? 'review' : 'neutral';
  if (side === 'agency') {
    const team = overrides.team ?? reviewStatus(bundle, item.id, 'team');
    rows.push({ label: 'Team', value: STATUS_LABELS[team], tone: tone(team) });
  }
  const client =
    item.kind === 'concept' && overrides.client !== undefined
      ? overrides.client
      : clientStatus(bundle, item);
  rows.push({ label: 'Client', value: STATUS_LABELS[client], tone: tone(client) });
  return rows;
}

/**
 * Whether the viewer can edit this item: the agency, on a concept. A client
 * never can; a post is edited in the post itself. Pure.
 */
export function canEditConcept(side: ViewerSide, item: Pick<PlanItemRow, 'kind'>): boolean {
  return side === 'agency' && item.kind === 'concept';
}

/** The muted line above Save when an edit would reset a review. */
export const CONCEPT_EDIT_RESET_HINT = 'Saving sends this back to waiting for team and client.';

/** Toasts after an Edit concept save. */
export const CONCEPT_UPDATED = 'Concept updated';
export const CONCEPT_SAVE_FAILED = "Couldn't save. Try again.";

/** Whether saving an edit resets a review: the team or client one is not waiting. Pure. */
export function conceptEditResets(team: ReviewStatus, client: ReviewStatus): boolean {
  return team !== 'waiting' || client !== 'waiting';
}

/** The Edit concept sheet's prefill from the item and its read files (none when unread). Pure. */
export function conceptEditForm(
  item: Pick<PlanItemRow, 'title' | 'description' | 'target_date'>,
  files: readonly string[] | null,
): ConceptForm {
  return {
    title: item.title ?? '',
    description: item.description ?? '',
    date: item.target_date?.slice(0, 10) ?? '',
    files: (files ?? []).map((versionId, i) => ({ versionId, name: `File ${i + 1}` })),
  };
}

/** A comment shown in the list: a recorded row, or a pending own one. */
interface ShownComment {
  id: string;
  authorName: string;
  body: string;
  visibility: CommentVisibility;
  createdAt: string;
  pending: boolean;
}

const presignDeps: PresignDeps = {
  endpoint: env.VITE_ASSET_READ_URL ?? null,
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  fetcher: (input, init) => fetchWithTrace(input, init),
};

export function PlanItemScreen(props: {
  open: boolean;
  bundle: PlanBundle;
  item: PlanItemRow;
  side: ViewerSide;
  /** The header back label; "Back to plan" when absent (the chat). */
  backLabel?: string;
  /** A comment to scroll to and briefly highlight once listed; none when absent. */
  highlightCommentId?: string;
  onClose: () => void;
}): ReactElement | null {
  const { bundle, item, side } = props;
  const { workspaces, workspaceId } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const navigate = useNavigate();
  const { read, reload } = useScreenRead<ItemScreenData>(props.open, item.id, (signal) =>
    readItemScreen(supabase, item, (ids, s) => readProfiles(supabase, ids, s), signal),
  );
  const [overrides, setOverrides] = useState<Partial<Record<ReviewSide, ReviewStatus>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [postSheetOpen, setPostSheetOpen] = useState(false);
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('everyone');
  const [pending, setPending] = useState<ShownComment[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  // The concept's files when the sheet opened; null when not read yet.
  const [editFiles, setEditFiles] = useState<string[] | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // A new item (or a fresh bundle) drops the local overrides and drafts.
  useEffect(() => setOverrides({}), [bundle]);
  useEffect(() => {
    if (props.open) return;
    setConfirmOpen(false);
    setPostSheetOpen(false);
    setActionError(null);
    setText('');
    setVisibility('everyone');
    setPending([]);
    setSendError(null);
    setEditOpen(false);
  }, [props.open, item.id]);

  // A write that lands after the viewer moved on (another item, or closed)
  // never touches the screen they are on now.
  const liveRef = useRef({ itemId: item.id, open: props.open });
  liveRef.current = { itemId: item.id, open: props.open };
  const stillOn = (itemId: string): boolean => isLiveItem(liveRef.current, itemId);
  // Another item starts clean: no draft, pending row, error or override carries over.
  useEffect(() => {
    setText('');
    setPending([]);
    setSendError(null);
    setActionError(null);
    setConfirmOpen(false);
    setOverrides({});
    setEditOpen(false);
  }, [item.id]);

  const actions = itemActions(side, item, bundle.plan.audience);
  const title = rowTitle(bundle, item);
  const description = item.kind === 'concept' ? (item.description ?? '') : '';

  const review = async (status: ReviewStatus): Promise<void> => {
    if (actions.kind !== 'review' || busy) return;
    const forItem = item.id;
    setBusy(true);
    setActionError(null);
    const traceId = generateTraceId();
    const result = await planItemReview(supabase, {
      p_item_id: forItem,
      p_side: actions.side,
      p_status: status,
      p_trace_id: traceId,
    });
    setBusy(false);
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan item review failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      setActionError("Couldn't save. Try again.");
      return;
    }
    setConfirmOpen(false);
    setOverrides((prev) => ({ ...prev, [actions.side]: status }));
    dispatchPlanChanged(window, bundle.plan.id);
  };

  // Edit concept: one sheet (the Add concept one) for every field; the Date
  // row's Edit opens it too. Save sends the full title, description and date;
  // files go as null unless they changed. An unchanged form sends nothing.
  const date = itemDateLabel(bundle, item);
  const editable = canEditConcept(side, item);
  const editResets = conceptEditResets(
    overrides.team ?? reviewStatus(bundle, item.id, 'team'),
    overrides.client ?? reviewStatus(bundle, item.id, 'client'),
  );
  const openEdit = (): void => {
    const files = read.status === 'ready' ? read.data.files : null;
    setEditFiles(files);
    setEditForm(conceptEditForm(item, files));
    setEditOpen(true);
  };
  const saveEdit = async (): Promise<void> => {
    if (editBusy) return;
    const edit = {
      title: editForm.title.trim(),
      description: editForm.description.trim(),
      targetDate: editForm.date === '' ? null : editForm.date,
      currentFiles: editFiles,
      pickedFiles: editFiles !== null ? editForm.files.map((f) => f.versionId) : null,
    };
    if (conceptEditUnchanged(item, edit)) {
      setEditOpen(false);
      return;
    }
    const forItem = item.id;
    setEditBusy(true);
    const traceId = generateTraceId();
    const result = await planConceptEdit(supabase, conceptEditArgs(forItem, edit, traceId));
    setEditBusy(false);
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan concept edit failed', {
        trace_id: traceId,
        item_id: forItem,
        error: result.error.message,
      });
      toast.show({ title: CONCEPT_SAVE_FAILED });
      return;
    }
    setEditOpen(false);
    toast.show({ title: CONCEPT_UPDATED });
    reload();
    dispatchPlanChanged(window, bundle.plan.id);
  };

  const shown = useMemo<ShownComment[]>(() => {
    const recorded =
      read.status === 'ready'
        ? read.data.comments.map((c: PlanCommentRow) => ({
            id: c.id,
            authorName:
              c.author_user_id !== null && c.author_user_id === me
                ? 'You'
                : ((c.author_user_id !== null ? read.data.names[c.author_user_id] : undefined) ??
                  'Member'),
            body: c.body,
            visibility: c.visibility,
            createdAt: c.created_at,
            pending: false,
          }))
        : [];
    const ids = new Set(recorded.map((c) => c.id));
    return [...recorded, ...pending.filter((p) => !ids.has(p.id))];
  }, [read, pending, me]);

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const body = text.trim();
    if (body === '' || sending) return;
    const vis: CommentVisibility = side === 'agency' ? visibility : 'everyone';
    const localId = `local-${Date.now()}`;
    const forItem = item.id;
    setSending(true);
    setSendError(null);
    setPending((prev) => [
      ...prev,
      {
        id: localId,
        authorName: 'You',
        body,
        visibility: vis,
        createdAt: new Date().toISOString(),
        pending: true,
      },
    ]);
    const traceId = generateTraceId();
    const result = await planItemCommentCreate(supabase, {
      p_item_id: forItem,
      p_body: body,
      p_visibility: vis,
      p_trace_id: traceId,
    });
    setSending(false);
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan comment failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setSendError(COMMENT_FAILED);
      return;
    }
    setText('');
    setPending((prev) =>
      prev.map((p) => (p.id === localId ? { ...p, id: result.data, pending: false } : p)),
    );
    reload();
    dispatchPlanChanged(window, bundle.plan.id);
  };

  // The deep-linked comment: once the read lists it, scroll to it and
  // highlight it briefly. Not listed (deleted, hidden): nothing happens.
  const highlightId = props.highlightCommentId ?? null;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const highlightDone = useRef(false);
  const listed = read.status === 'ready' && shown.some((c) => c.id === highlightId);
  // The page slides in on translateY: the linked comment scrolls and lights
  // up once the slide has ended (PlanPage's onEntered), never mid-slide.
  const [rested, setRested] = useState(false);
  useEffect(() => {
    if (!props.open) setRested(false);
  }, [props.open]);
  useEffect(() => {
    if (highlightId === null || !props.open || !rested || !listed || highlightDone.current) {
      return;
    }
    highlightDone.current = true;
    setHighlighted(highlightId);
    highlightRef.current?.scrollIntoView({ block: 'center' });
  }, [highlightId, props.open, rested, listed]);
  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const teamNote = side === 'agency' && visibility === 'team';
  return (
    <>
      <PlanPage
        open={props.open}
        testId="item"
        title={itemKindLabel(bundle.items, item)}
        subtitle={bundle.plan.title}
        backLabel={props.backLabel ?? 'Back to plan'}
        onBack={props.onClose}
        onEntered={() => setRested(true)}
        footer={
          <form
            onSubmit={(e) => void send(e)}
            className="flex flex-col gap-1.5"
            aria-label="Add a comment"
          >
            {side === 'agency' ? (
              <div className="flex gap-1.5" role="group" aria-label="Who sees the comment">
                {(['everyone', 'team'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={visibility === v}
                    data-plan-visibility={v}
                    onClick={() => setVisibility(v)}
                    className={cn(
                      'min-h-[44px] rounded-full border px-3 text-[13px] font-medium',
                      visibility === v
                        ? v === 'team'
                          ? 'border-warn bg-warn-soft text-warn'
                          : 'border-accent bg-accent-soft text-accent'
                        : 'border-border text-fg-2',
                    )}
                  >
                    {v === 'everyone' ? 'Everyone' : TEAM_ONLY_LABEL}
                  </button>
                ))}
              </div>
            ) : null}
            {sendError !== null ? (
              <p role="alert" className="text-[13px] text-bad">
                {sendError}
              </p>
            ) : null}
            <div className="flex items-center gap-1.5">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Comment"
                autoComplete="off"
                maxLength={5000}
                placeholder={teamNote ? 'Note for the team only' : 'Comment for everyone'}
                className={cn(
                  'min-h-[44px] min-w-0 flex-1 rounded-full border bg-bg px-3.5 text-base text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  teamNote ? 'border-warn' : 'border-border',
                )}
              />
              <button
                type="submit"
                aria-label="Send comment"
                disabled={text.trim() === '' || sending}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-50"
              >
                <IconArrowUp size={20} />
              </button>
            </div>
          </form>
        }
      >
        <div className="flex flex-col gap-3.5 p-4">
          <ItemMedia item={item} read={read} />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 break-words pt-[9px] text-xl font-semibold leading-[26px] text-fg">
                {title}
              </h3>
              {editable ? (
                <button
                  type="button"
                  data-plan-edit-concept=""
                  onClick={openEdit}
                  className="min-h-[44px] min-w-[44px] shrink-0 rounded-md px-2 text-[15px] font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Edit
                </button>
              ) : null}
            </div>
            {description !== '' ? (
              <p className="whitespace-pre-wrap text-[15px] leading-[21px] text-fg-2">
                {description}
              </p>
            ) : null}
          </div>
          <div
            data-plan-status=""
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3"
          >
            <div className="flex min-h-[28px] items-center justify-between gap-2">
              <span className="text-sm text-fg-3">Date</span>
              <span className="flex items-center gap-1">
                <span
                  data-plan-item-date={date.dated ? 'dated' : 'none'}
                  className={cn('text-[13px]', date.dated ? 'font-mono text-fg-2' : 'text-fg-3')}
                >
                  {date.label}
                </span>
                {editable ? (
                  <button
                    type="button"
                    data-plan-edit-date=""
                    aria-label="Edit date"
                    onClick={openEdit}
                    className="min-h-[44px] min-w-[44px] rounded-md px-2 text-[13px] font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                  >
                    Edit
                  </button>
                ) : null}
              </span>
            </div>
            {statusRows(bundle, item, side, overrides).map((row) => (
              <div key={row.label} className="flex min-h-[28px] items-center justify-between gap-2">
                <span className="text-sm text-fg-3">{row.label}</span>
                <PlanPill
                  pill={{
                    label: row.value,
                    tone: row.tone,
                    side: row.label === 'Team' ? 'team' : 'client',
                  }}
                />
              </div>
            ))}
          </div>
          {actions.kind === 'review' ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {actions.openInPipeline ? (
                  <Button
                    size="lg"
                    data-plan-pipeline=""
                    onClick={() => {
                      if (item.post_id !== null) navigate(postRoute(item.post_id));
                    }}
                  >
                    Open in pipeline
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    data-plan-ask=""
                    disabled={busy}
                    onClick={() => void review('changes')}
                  >
                    Ask changes
                  </Button>
                )}
                <Button
                  size="lg"
                  variant="primary"
                  data-plan-approve=""
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setConfirmOpen(true);
                  }}
                >
                  {actions.approveLabel}
                </Button>
              </div>
              {actionError !== null && !confirmOpen ? (
                <p role="alert" className="text-[13px] text-bad">
                  {actionError}
                </p>
              ) : null}
            </div>
          ) : actions.kind === 'open-post' ? (
            <Button
              size="lg"
              variant="primary"
              data-plan-open-post=""
              onClick={() => setPostSheetOpen(true)}
            >
              Open post
            </Button>
          ) : null}
          <section className="flex flex-col gap-2.5" aria-label="Comments">
            <h4 className="text-[15px] font-semibold text-fg">Comments</h4>
            {read.status === 'loading' ? (
              <div className="h-[72px] animate-pulse rounded-lg bg-panel-2" />
            ) : read.status === 'error' ? (
              <ScreenFailed onRetry={reload} />
            ) : shown.length === 0 ? (
              <p className="text-[13px] text-fg-3">No comments yet.</p>
            ) : (
              shown.map((c) =>
                c.id === highlightId ? (
                  <CommentRow
                    key={c.id}
                    comment={c}
                    timeZone={timeZone}
                    highlighted={highlighted === c.id}
                    rowRef={highlightRef}
                  />
                ) : (
                  <CommentRow key={c.id} comment={c} timeZone={timeZone} />
                ),
              )
            )}
          </section>
        </div>
      </PlanPage>
      <PlanConfirmSheet
        open={confirmOpen}
        title={actions.kind === 'review' && actions.side === 'client' ? 'Approve' : 'Team approve'}
        message={
          actions.kind === 'review' && actions.side === 'client'
            ? clientApproveConfirm(title)
            : TEAM_APPROVE_CONFIRM
        }
        confirmLabel={actions.kind === 'review' ? actions.approveLabel : 'Approve'}
        busy={busy}
        error={confirmOpen ? actionError : null}
        onConfirm={() => void review('approved')}
        onCancel={() => setConfirmOpen(false)}
      />
      {editable ? (
        <ConceptSheet
          open={props.open && editOpen}
          mode="edit"
          form={editForm}
          onChange={setEditForm}
          onSubmit={() => void saveEdit()}
          onClose={() => {
            // A save in flight keeps the sheet (and the typed values) open.
            if (!editBusy) setEditOpen(false);
          }}
          busy={editBusy}
          note={editResets ? CONCEPT_EDIT_RESET_HINT : null}
          filesReady={editFiles !== null}
        />
      ) : null}
      {actions.kind === 'open-post' && item.post_id !== null ? (
        <ItemPostSheet
          open={postSheetOpen}
          postId={item.post_id}
          side={side}
          timeZone={timeZone}
          onClose={() => setPostSheetOpen(false)}
        />
      ) : null}
    </>
  );
}

function ItemMedia(props: {
  item: PlanItemRow;
  read: ReturnType<typeof useScreenRead<ItemScreenData>>['read'];
}): ReactElement {
  const { item, read } = props;
  if (item.kind === 'post' && item.post_id !== null) {
    return (
      <div data-plan-media="post" className="flex justify-center">
        <SharedPostCards postIds={[item.post_id]} />
      </div>
    );
  }
  if (read.status !== 'ready') {
    return (
      <div data-plan-media="loading" className="h-[170px] animate-pulse rounded-lg bg-panel-2" />
    );
  }
  const files = read.data.files;
  if (files.length === 0) {
    return (
      <div
        data-plan-media="empty"
        className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border-strong bg-panel text-[13px] text-fg-3"
      >
        No files
      </div>
    );
  }
  return (
    <div data-plan-media="files" className="grid grid-cols-3 gap-1.5">
      {files.map((versionId) => (
        <div key={versionId} className="overflow-hidden rounded-md border border-border bg-panel-2">
          <Thumbnail
            assetVersionId={versionId}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            fallback={{ kind: 'glyph' }}
            alt="Concept file"
          />
        </div>
      ))}
    </div>
  );
}

/** How long a deep-linked comment stays highlighted. */
const HIGHLIGHT_MS = 2400;

function CommentRow(props: {
  comment: ShownComment;
  timeZone: string;
  highlighted?: boolean;
  rowRef?: RefObject<HTMLDivElement>;
}): ReactElement {
  const c = props.comment;
  const team = c.visibility === 'team';
  return (
    <div
      {...(props.rowRef !== undefined ? { ref: props.rowRef, 'data-plan-comment-id': c.id } : {})}
      {...(props.highlighted === true ? { 'data-plan-comment-highlight': '' } : {})}
      data-plan-comment={c.visibility}
      className={cn(
        'flex flex-col gap-1 rounded-lg border px-3 py-2.5',
        team ? 'border-warn bg-warn-soft' : 'border-border bg-panel',
        c.pending && 'opacity-70',
        props.highlighted === true &&
          'ring-2 ring-accent transition-shadow duration-slow motion-reduce:transition-none',
      )}
    >
      <div className="flex items-center gap-1.5 text-[13px]">
        <span className="font-semibold text-fg">{c.authorName}</span>
        {team ? (
          <span className="inline-flex items-center gap-1 text-xs text-warn">
            <IconLock size={12} />
            {TEAM_ONLY_LABEL}
          </span>
        ) : null}
        <time className="ml-auto font-mono text-xs text-fg-3">
          {formatClockTime(c.createdAt, props.timeZone)}
        </time>
      </div>
      <p className="whitespace-pre-wrap text-[15px] leading-[21px] text-fg">{c.body}</p>
    </div>
  );
}

const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_VERSION = (): number => 0;

/** The client's "Open post": the post's existing sheet (approve and comment there). */
function ItemPostSheet(props: {
  open: boolean;
  postId: string;
  side: ViewerSide;
  timeZone: string;
  onClose: () => void;
}): ReactElement | null {
  const cache = useThreadCardCache();
  const { workspaceKey } = useWorkspace();
  const postId = props.postId;
  useEffect(() => {
    cache?.request({ postIds: [postId] });
  }, [cache, postId]);
  const version = useSyncExternalStore(
    cache?.subscribe ?? NO_SUBSCRIBE,
    cache?.version ?? NO_VERSION,
  );
  const view = useMemo(() => {
    if (cache === null) return null;
    const snap = cache.posts([postId]);
    const [first] = sharedPostViews(
      [postId],
      indexPostsById(snap.posts),
      snap.names,
      approverRolesOf(cache),
    );
    return first !== undefined && first.kind === 'post' ? first : null;
    // Keyed by the id and the cache version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, postId, version]);
  if (view === null) return null;
  return (
    <PostSheet
      open={props.open}
      onClose={props.onClose}
      view={view}
      side={props.side}
      workspaceKey={workspaceKey}
      timeZone={props.timeZone}
      cache={sharedCardPresignCache()}
      deps={presignDeps}
      presignEnabled={PRESIGN_ENABLED}
    />
  );
}
