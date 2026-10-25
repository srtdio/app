// One plan item, full page over the Plan screen (its own history step), headed
// by the kind and place ("Concept 1 of 3"). A post item is the pipeline post
// view embedded as is, its header subtitle the slot state ("Slot approved" /
// "Slot pending") and its header overflow opening the post view's own action
// sheet (Open in pipeline first, then the post's actions). A
// concept shows its library files, title and description, a status box (Agency
// for the agency side on a Draft plan, Client), the viewer's actions, and the
// comments with a composer. On a Draft plan the agency marks agency approval
// (confirmed) or asks changes; a client approves or asks changes on an Open
// plan's concept (team reviews are never shown or written on an Open plan).
// "Ask changes" opens the comment composer first (a note for the creators);
// Send records the note, then the changes review. Approve keeps its confirm.
// Opened by a Plan row's Not OK (askChanges), the note box is open and
// focused from the start, a post item included; Send writes 'changes' for
// the viewer's PLAN side, closing writes nothing.
// The agency side gets a red "Remove from plan" at the bottom (the Remove
// confirm, then plan_item_remove) and Move to another day: a move that resets
// nothing waits behind a 4s Undo strip (useUndoableAction;
// the write goes when the toast ends, never after Undo). Comments: the agency
// sees all and picks Everyone or Agency only; a client sees Everyone ones
// (RLS). A comment appends at once and keeps its text on failure. One read
// per table per open, bounded at 5s; the body paints once it settles. The
// phone page is a modal dialog: focus moves in and returns on close
// (PlanPage). Tokens only.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  planConceptEdit,
  planItemCommentCreate,
  planItemMove,
  planItemRemove,
  planItemReview,
} from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/components/ui/toast';
import { ICON_SIZE, IconArrowUp, IconLock, IconMore, IconX } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media/Thumbnail';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ActionMenu } from '@/components/ui/ActionMenu';
import {
  PlanKeepApprovalSheet,
  PlanMoveSheet,
  PlanRemoveSheet,
  PostSheetPlanRowsContext,
  RemoveFromPlanButton,
  planConceptMenuItems,
} from '@/components/chat/PlanMoveSheet';
import { flattenOrder, hasTicks, moveToEnd } from '@/lib/chat/plan-drag';
import { dayMoveToast } from '@/lib/chat/plan-keyboard-move';
import {
  ConceptSheet,
  EMPTY_CONCEPT,
  useConceptFilesRead,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { postRoute } from '@/components/chat/post-card';
import {
  COMMENT_FAILED,
  MOVE_FAILED,
  REMOVED_TOAST,
  REMOVE_FAILED,
  STATUS_LABELS,
  TEAM_STATUS_LABELS,
  TEAM_APPROVE_CONFIRM,
  TEAM_ONLY_LABEL,
  clientApproveConfirm,
  clientStatus,
  dayHeaderOf,
  itemDateLabel,
  itemKindLabel,
  itemSlotSubtitle,
  keepApprovalBody,
  keepApprovalTitle,
  moveAsksKeep,
  planWriteErrorCopy,
  reviewStatus,
  slotSide,
  stageLabel,
  type PillTone,
} from '@/components/chat/plan-card';
import {
  PlanConfirmSheet,
  PlanPage,
  PlanPill,
  ScreenFailed,
  planDayIds,
  planListGroups,
  planMoveDays,
  rowTitle,
  useScreenRead,
} from '@/components/chat/PlanScreen';
import { readProfiles } from '@/lib/chat-reads';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import {
  conceptEditArgs,
  conceptEditUnchanged,
  dispatchPlanChanged,
  readConceptFiles,
  readItemScreen,
  type CommentVisibility,
  type ItemScreenData,
  type PlanBundle,
  type PlanCommentRow,
  type PlanItemRow,
  type ReviewSide,
  type ReviewStatus,
} from '@/lib/chat/plans';
import { formatRelative, safeTimeZone } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspace } from '@/lib/workspace-context';
import { mentionIds, resolvePersonMentionText } from '@/lib/chat/mentions';
import { resolvePeople } from '@/lib/people-names';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { firstExternalUrl } from '@/lib/chat/message-links';

/** The preview card for the first external link in a concept's description. */
function ConceptLinkCard(props: { text: string }): ReactElement | null {
  const url = firstExternalUrl(props.text);
  return url !== null ? (
    <LinkPreviewCard key={url} url={url} className="mt-1 w-full max-w-[420px]" />
  ) : null;
}

// Loaded on first post item open: the post view's graph (PCS, the chat SDK)
// stays out of the chat bundle and out of node imports of this module.
const PostDetailPage = lazy(() =>
  import('@/components/pages/PostDetailPage').then((m) => ({ default: m.PostDetailPage })),
);

/** Whether a write started on `itemId` still belongs to the screen as it is now. Pure. */
export function isLiveItem(live: { itemId: string; open: boolean }, itemId: string): boolean {
  return live.open && live.itemId === itemId;
}

/** What the action row offers. Pure. */
export type ItemActions =
  | { kind: 'review'; side: ReviewSide; approveLabel: string }
  | { kind: 'none' };

/**
 * The viewer's actions on an item: a post item has none (the embedded post
 * view carries its own); on a concept the agency reviews as the team on a
 * Draft plan (never on an Open plan: no team writes there) and a client
 * reviews on an Open plan. An unknown side gets none. Pure.
 */
export function itemActions(
  side: ViewerSide,
  item: Pick<PlanItemRow, 'kind'>,
  audience: PlanBundle['plan']['audience'],
): ItemActions {
  if (item.kind === 'post') return { kind: 'none' };
  if (side === 'agency') {
    return audience === 'team'
      ? { kind: 'review', side: 'team', approveLabel: 'Mark checked' }
      : { kind: 'none' };
  }
  if (side === 'client' && audience === 'client') {
    return { kind: 'review', side: 'client', approveLabel: 'Approve' };
  }
  return { kind: 'none' };
}

/** The action buttons in order: "Ask changes", then the approve. Pure. */
export function actionLabels(actions: ItemActions): string[] {
  if (actions.kind === 'none') return [];
  return ['Ask changes', actions.approveLabel];
}

/** The agency's status row label (the review side stays 'team'). */
export const AGENCY_ROW = 'Creators';

/** "Ask changes" (FT55): the composer opens first; its hint and placeholder. */
export const ASK_CHANGES_HINT = 'Add a note on what should change, then send.';
export const ASK_CHANGES_PLACEHOLDER = 'What should change?';
export const ASK_CHANGES_SEND = 'Send and ask changes';

/**
 * What a Send does while "Ask changes" is open: the note (when typed) then the
 * changes review; with no note, the review alone. Never nothing. Pure.
 */
export function askChangesSteps(body: string, asking: boolean): Array<'comment' | 'changes'> {
  const steps: Array<'comment' | 'changes'> = [];
  if (body.trim() !== '') steps.push('comment');
  if (asking) steps.push('changes');
  return steps;
}

/** The status box rows: Pipeline (post), Agency (Draft plan only), Client. Pure. */
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
  if (side === 'agency' && bundle.plan.audience === 'team') {
    const team = overrides.team ?? reviewStatus(bundle, item.id, 'team');
    rows.push({ label: AGENCY_ROW, value: TEAM_STATUS_LABELS[team], tone: tone(team) });
  }
  const client =
    item.kind === 'concept' && overrides.client !== undefined
      ? overrides.client
      : clientStatus(bundle, item);
  rows.push({ label: 'Approvers', value: STATUS_LABELS[client], tone: tone(client) });
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
export const CONCEPT_EDIT_RESET_HINT =
  'Saving sends this back to waiting for creators and approvers.';

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
  /** Laptop: the panel's X closes the whole plan panel (Back steps to the list). */
  onDismiss?: () => void;
  /** After Remove from plan: back to the list. Defaults to onClose. */
  onRemoved?: () => void;
  /** The client approver's name (the keep sheet's title on an Open plan). */
  approverName?: string;
  /** Opened by a row's Not OK: the note box opens focused; Send writes 'changes'. */
  askChanges?: boolean;
}): ReactElement | null {
  const { bundle, item, side } = props;
  const { workspaces, workspaceId } = useWorkspace();
  // The workspace civil clock the plan days read on (device zone when unset).
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const navigate = useNavigate();
  // A post item reads nothing here: the embedded post view does its own reads.
  const { read, reload } = useScreenRead<ItemScreenData>(
    props.open && item.kind === 'concept',
    item.id,
    (signal) => readItemScreen(supabase, item, (ids, s) => readProfiles(supabase, ids, s), signal),
  );
  // Hand-typed mention tokens resolve through the shared batched name read
  // (users + workspace_members, one .in() each); the tick re-renders once it lands.
  const [, setNamesTick] = useState(0);
  const mentionedIds = useMemo(
    () =>
      read.status === 'ready'
        ? [...new Set(read.data.comments.flatMap((c: PlanCommentRow) => mentionIds(c.body)))]
        : [],
    [read],
  );
  useEffect(() => {
    if (mentionedIds.length === 0) return;
    let active = true;
    void resolvePeople(supabase, workspaceId, mentionedIds).then(() => {
      if (active) setNamesTick((n) => n + 1);
    });
    return () => {
      active = false;
    };
  }, [mentionedIds, workspaceId]);
  const [overrides, setOverrides] = useState<Partial<Record<ReviewSide, ReviewStatus>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The post item's overflow: the embedded post view's own action sheet.
  const [moreOpen, setMoreOpen] = useState(false);
  // Agency plan actions: a concept's overflow, the day list, the remove confirm.
  const [conceptMenuOpen, setConceptMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  // A Move of an Open plan's client-approved slot to another day: its day.
  const [keepFor, setKeepFor] = useState<{ day: string | null } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('everyone');
  const [pending, setPending] = useState<ShownComment[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // "Ask changes" opened the composer: Send records the note, then the review.
  const [askingChanges, setAskingChanges] = useState(false);
  const commentRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const undoable = useUndoableAction();
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  // The concept's files when the sheet opened; null when not read yet.
  const [editFiles, setEditFiles] = useState<string[] | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // Uploads go as comments' do (library origin).
  const { canAttach, uploadFile } = useCommentAttachments();
  // Files not read when the sheet opened: the sheet reads them (5s cap).
  const filesRead = useConceptFilesRead(
    props.open && editOpen && editFiles === null,
    (cancel) => readConceptFiles(supabase, item.id, cancel),
    (files) => {
      setEditFiles(files);
      setEditForm((f) => ({ ...f, files: conceptEditForm(item, files).files }));
    },
  );

  // A new item (or a fresh bundle) drops the local overrides and drafts.
  useEffect(() => setOverrides({}), [bundle]);
  useEffect(() => {
    if (props.open) return;
    setConfirmOpen(false);
    setMoreOpen(false);
    setActionError(null);
    setText('');
    setVisibility('everyone');
    setPending([]);
    setSendError(null);
    setAskingChanges(false);
    setEditOpen(false);
    setConceptMenuOpen(false);
    setMoveOpen(false);
    setRemoveOpen(false);
    setKeepFor(null);
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
    setAskingChanges(false);
    setActionError(null);
    setConfirmOpen(false);
    setOverrides({});
    setEditOpen(false);
    setMoreOpen(false);
  }, [item.id]);

  // Opened by a row's Not OK: the note box opens at once (after the resets
  // above), and focus goes to it whenever it opens (the phone keyboard comes up).
  useEffect(() => {
    if (!props.open || props.askChanges !== true) return;
    setActionError(null);
    setAskingChanges(true);
  }, [props.open, props.askChanges, item.id]);
  useEffect(() => {
    if (askingChanges) commentRef.current?.focus();
  }, [askingChanges]);

  const actions = itemActions(side, item, bundle.plan.audience);
  // The side a changes review writes: the item's own review actions, else
  // (Not OK on a row, a post item too) the viewer's PLAN side.
  const reviewSide =
    actions.kind === 'review'
      ? actions.side
      : props.askChanges === true
        ? slotSide(side, bundle.plan.audience)
        : null;
  const title = rowTitle(bundle, item);
  const description = item.kind === 'concept' ? (item.description ?? '') : '';

  /** One review write; true when it landed on this item. */
  const review = async (status: ReviewStatus): Promise<boolean> => {
    if (reviewSide === null || busy) return false;
    const forItem = item.id;
    setBusy(true);
    setActionError(null);
    const traceId = generateTraceId();
    const result = await planItemReview(supabase, {
      p_item_id: forItem,
      p_side: reviewSide,
      p_status: status,
      p_trace_id: traceId,
    });
    setBusy(false);
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return false;
    }
    if (!result.ok) {
      logger.warn('chat: plan item review failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      setActionError("Couldn't save. Try again.");
      return false;
    }
    setConfirmOpen(false);
    setOverrides((prev) => ({ ...prev, [reviewSide]: status }));
    dispatchPlanChanged(window, bundle.plan.id);
    return true;
  };
  // "Ask changes": the composer first. The field takes focus (its keyboard
  // opens on a phone); Send records the note, then the changes review.
  const askChanges = (): void => {
    setActionError(null);
    setAskingChanges(true);
    commentRef.current?.focus();
  };

  // Edit concept: one sheet (the Add concept one) for every field; the Date
  // row's Edit opens it too. Save sends the full title, description and date;
  // files go as null unless they changed. An unchanged form sends nothing.
  const date = itemDateLabel(bundle, item, timeZone);
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

  /** One comment write; true when it landed on this item. */
  const sendComment = async (body: string): Promise<boolean> => {
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
      return false;
    }
    if (!result.ok) {
      logger.warn('chat: plan comment failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setSendError(COMMENT_FAILED);
      return false;
    }
    setText('');
    setPending((prev) =>
      prev.map((p) => (p.id === localId ? { ...p, id: result.data, pending: false } : p)),
    );
    reload();
    dispatchPlanChanged(window, bundle.plan.id);
    return true;
  };
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (sending || busy) return;
    const body = text.trim();
    const steps = askChangesSteps(body, askingChanges);
    if (steps.length === 0) return;
    if (steps.includes('comment') && !(await sendComment(body))) return;
    if (steps.includes('changes')) {
      if (await review('changes')) setAskingChanges(false);
    }
  };

  // Agency plan actions. Move: to the end of the picked day (one 5-arg
  // plan_item_move with the full plan order; an Open plan's client-approved
  // slot asks "Keep the approval?" first, cancelling cancels the move);
  // Remove: plan_item_remove, then back to the list. Clients never reach
  // these (no rows render for them).
  const planActions = side === 'agency';
  const groups = planListGroups(bundle, timeZone, side);
  const currentDay = groups
    .flatMap((w) => w.days)
    .find((d) => d.items.some((i) => i.id === item.id))?.day;
  const pickDay = (day: string | null): void => {
    if (!planActions || planBusy) return;
    if (day === currentDay) {
      setMoveOpen(false);
      return;
    }
    if (moveAsksKeep(bundle, item, currentDay ?? null, day)) {
      setMoveOpen(false);
      setKeepFor({ day });
      return;
    }
    void moveItemTo(day, false);
  };
  // The one plan_item_move. True when it landed; a failure toasts its copy.
  const writeMove = async (
    day: string | null,
    keep: boolean,
    order: string[],
  ): Promise<boolean> => {
    setPlanBusy(true);
    const traceId = generateTraceId();
    const result = await planItemMove(supabase, {
      p_item_id: item.id,
      p_target_date: day,
      p_item_ids: order,
      p_keep_reviews: keep,
      p_trace_id: traceId,
    });
    setPlanBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan item move failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, MOVE_FAILED) });
      return false;
    }
    dispatchPlanChanged(window, bundle.plan.id);
    return true;
  };
  const moveItemTo = async (day: string | null, keep: boolean): Promise<void> => {
    if (!planActions || planBusy) return;
    const order = flattenOrder(moveToEnd(planDayIds(groups), item.id, day));
    const hadTicks = hasTicks(bundle, item.id);
    const spec = dayMoveToast(dayHeaderOf(day), item.kind === 'post', !keep && hadTicks);
    setMoveOpen(false);
    if (spec.undo) {
      // Nothing is reset: the write waits behind the Undo toast (4s);
      // Undo means it never goes.
      undoable.run({
        label: spec.title,
        commit: async () => {
          await writeMove(day, keep, order);
        },
      });
      return;
    }
    // A tick is reset: the agency cannot put a client's tick back, so no Undo.
    if (await writeMove(day, keep, order)) toast.show({ title: spec.title });
  };
  const removeFromPlan = async (): Promise<void> => {
    if (!planActions || planBusy) return;
    setPlanBusy(true);
    const traceId = generateTraceId();
    const result = await planItemRemove(supabase, { p_item_id: item.id, p_trace_id: traceId });
    setPlanBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan item remove failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      toast.show({ title: REMOVE_FAILED });
      return;
    }
    setRemoveOpen(false);
    toast.show({ title: REMOVED_TOAST });
    dispatchPlanChanged(window, bundle.plan.id);
    // Back to the list (the entry item included), not out of the plan.
    (props.onRemoved ?? props.onClose)();
  };
  const planRows = useMemo(
    () => (planActions ? { onMove: () => setMoveOpen(true) } : null),
    [planActions],
  );
  const removeButton = planActions ? (
    <div data-plan-remove-row="" className="px-4 pb-6 pt-2">
      <RemoveFromPlanButton busy={planBusy} onClick={() => setRemoveOpen(true)} />
    </div>
  ) : null;

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
        subtitle={itemSlotSubtitle(bundle, item, side) ?? bundle.plan.title}
        backLabel={props.backLabel ?? 'Back to plan'}
        onBack={props.onClose}
        desktopBack
        closeLabel="Close plan"
        {...(props.onDismiss !== undefined ? { onDismiss: props.onDismiss } : {})}
        onEntered={() => setRested(true)}
        {...(item.kind === 'concept' && planActions
          ? {
              action: (
                <ActionMenu
                  title={title}
                  items={planConceptMenuItems({
                    onMove: () => setMoveOpen(true),
                    onEdit: openEdit,
                  })}
                  open={props.open && conceptMenuOpen}
                  onOpenChange={setConceptMenuOpen}
                  trigger={
                    <IconButton
                      type="button"
                      label="Item actions"
                      data-plan-item-more=""
                      aria-haspopup="menu"
                      aria-expanded={conceptMenuOpen}
                      className="shrink-0 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <IconMore size={ICON_SIZE.control} />
                    </IconButton>
                  }
                />
              ),
            }
          : {})}
        {...(item.kind === 'post' && item.post_id !== null
          ? {
              action: (
                <IconButton
                  type="button"
                  label="More actions"
                  data-plan-more=""
                  onClick={() => setMoreOpen(true)}
                  className="shrink-0 text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <IconMore size={ICON_SIZE.control} />
                </IconButton>
              ),
            }
          : {})}
        footer={
          item.kind === 'post' && !askingChanges ? undefined : (
            <form
              onSubmit={(e) => void send(e)}
              className="flex flex-col gap-1.5"
              aria-label="Add a comment"
            >
              {side === 'agency' ? (
                <div className="flex gap-1.5" role="group" aria-label="Who sees the comment">
                  {(['everyone', 'team'] as const).map((v) => (
                    <Button
                      key={v}
                      type="button"
                      variant="secondary"
                      aria-pressed={visibility === v}
                      data-plan-visibility={v}
                      onClick={() => setVisibility(v)}
                      className={
                        visibility === v
                          ? v === 'team'
                            ? 'border-warn bg-warn-soft text-warn'
                            : 'border-accent bg-accent-soft text-accent'
                          : 'text-fg-2'
                      }
                    >
                      {v === 'everyone' ? 'Everyone' : TEAM_ONLY_LABEL}
                    </Button>
                  ))}
                </div>
              ) : null}
              {askingChanges ? (
                <div
                  data-plan-ask-hint=""
                  className="flex items-center gap-2 rounded-xl bg-panel-2 py-1 pl-3 pr-1 text-md text-fg-2"
                >
                  <p className="min-w-0 flex-1 py-2">{ASK_CHANGES_HINT}</p>
                  <IconButton
                    type="button"
                    label="Cancel ask changes"
                    data-plan-ask-cancel=""
                    onClick={() => setAskingChanges(false)}
                    className="shrink-0 hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <IconX size={ICON_SIZE.control} />
                  </IconButton>
                </div>
              ) : null}
              {sendError !== null ? (
                <p role="alert" className="text-md text-bad">
                  {sendError}
                </p>
              ) : null}
              {actionError !== null && askingChanges ? (
                <p role="alert" className="text-md text-bad">
                  {actionError}
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <input
                  ref={commentRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label="Comment"
                  autoComplete="off"
                  enterKeyHint="send"
                  maxLength={5000}
                  placeholder={
                    askingChanges
                      ? ASK_CHANGES_PLACEHOLDER
                      : teamNote
                        ? 'Note for creators only'
                        : 'Comment for everyone'
                  }
                  className={cn(
                    'min-h-[44px] min-w-0 flex-1 rounded-full border bg-bg px-3.5 text-input text-fg placeholder:text-fg-3 md:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    teamNote ? 'border-warn' : askingChanges ? 'border-accent' : 'border-border',
                  )}
                />
                <Button
                  type="submit"
                  variant="primary"
                  shape="round"
                  aria-label={askingChanges ? ASK_CHANGES_SEND : 'Send comment'}
                  data-plan-comment-send={askingChanges ? 'changes' : 'comment'}
                  disabled={(text.trim() === '' && !askingChanges) || sending || busy}
                  className="shrink-0"
                >
                  <IconArrowUp size={ICON_SIZE.control} />
                </Button>
              </div>
            </form>
          )
        }
      >
        {item.kind === 'post' ? (
          <>
            {item.post_id !== null ? (
              <PostSheetPlanRowsContext.Provider value={planRows}>
                <Suspense
                  fallback={<div className="m-4 h-[170px] animate-pulse rounded-lg bg-panel-2" />}
                >
                  <PostDetailPage
                    postId={item.post_id}
                    embedded
                    {...(props.highlightCommentId !== undefined
                      ? { focusCommentId: props.highlightCommentId }
                      : {})}
                    onNavigateAway={props.onClose}
                    actionsOpen={props.open && moreOpen}
                    onActionsOpenChange={setMoreOpen}
                    onOpenInPipeline={() => {
                      if (item.post_id !== null) navigate(postRoute(item.post_id));
                    }}
                  />
                </Suspense>
              </PostSheetPlanRowsContext.Provider>
            ) : null}
            {removeButton}
          </>
        ) : (
          <div className="flex flex-col gap-3.5 p-4">
            <ItemMedia read={read} />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 break-words pt-3 text-lg font-semibold text-fg">{title}</h3>
                {editable ? (
                  <Button
                    type="button"
                    variant="link"
                    data-plan-edit-concept=""
                    onClick={openEdit}
                    className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Edit
                  </Button>
                ) : null}
              </div>
              {description !== '' ? (
                <p className="whitespace-pre-wrap text-base text-fg-2">{description}</p>
              ) : null}
              <ConceptLinkCard text={description} />
            </div>
            <div
              data-plan-status=""
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3"
            >
              <div className="flex min-h-[28px] items-center justify-between gap-2">
                <span className="text-base text-fg-3">Date</span>
                <span className="flex items-center gap-1">
                  <span
                    data-plan-item-date={date.dated ? 'dated' : 'none'}
                    className={cn('text-md', date.dated ? 'font-mono text-fg-2' : 'text-fg-3')}
                  >
                    {date.label}
                  </span>
                  {editable ? (
                    <Button
                      type="button"
                      variant="link"
                      data-plan-edit-date=""
                      aria-label="Edit date"
                      onClick={openEdit}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      Edit
                    </Button>
                  ) : null}
                </span>
              </div>
              {statusRows(bundle, item, side, overrides).map((row) => (
                <div
                  key={row.label}
                  className="flex min-h-[28px] items-center justify-between gap-2"
                >
                  <span className="text-base text-fg-3">{row.label}</span>
                  <PlanPill
                    pill={{
                      label: row.value,
                      tone: row.tone,
                      side: row.label === AGENCY_ROW ? 'team' : 'client',
                    }}
                  />
                </div>
              ))}
            </div>
            {actions.kind === 'review' ? (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    data-plan-ask=""
                    aria-pressed={askingChanges}
                    disabled={busy}
                    onClick={askChanges}
                  >
                    Ask changes
                  </Button>
                  <Button
                    variant="success"
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
                {actionError !== null && !confirmOpen && !askingChanges ? (
                  <p role="alert" className="text-md text-bad">
                    {actionError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <section className="flex flex-col gap-2.5" aria-label="Comments">
              <h4 className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
                Comments
              </h4>
              {read.status === 'loading' ? (
                <div className="h-[72px] animate-pulse rounded-lg bg-panel-2" />
              ) : read.status === 'error' ? (
                <ScreenFailed onRetry={reload} />
              ) : shown.length === 0 ? (
                <p className="text-md text-fg-3">Comments show up here.</p>
              ) : (
                shown.map((c) =>
                  c.id === highlightId ? (
                    <CommentRow
                      key={c.id}
                      comment={c}
                      workspaceId={workspaceId}
                      highlighted={highlighted === c.id}
                      rowRef={highlightRef}
                    />
                  ) : (
                    <CommentRow key={c.id} comment={c} workspaceId={workspaceId} />
                  ),
                )
              )}
            </section>
            {planActions ? (
              <div data-plan-remove-row="" className="pt-2">
                <RemoveFromPlanButton busy={planBusy} onClick={() => setRemoveOpen(true)} />
              </div>
            ) : null}
          </div>
        )}
      </PlanPage>
      <PlanConfirmSheet
        open={confirmOpen}
        title={actions.kind === 'review' && actions.side === 'client' ? 'Approve' : 'Mark checked'}
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
      {planActions ? (
        <>
          <PlanMoveSheet
            open={props.open && moveOpen}
            days={planMoveDays(bundle.plan)}
            current={currentDay ?? null}
            busy={planBusy}
            onPick={pickDay}
            onClose={() => setMoveOpen(false)}
          />
          <PlanKeepApprovalSheet
            open={props.open && keepFor !== null}
            title={keepApprovalTitle(props.approverName ?? 'Member')}
            body={keepApprovalBody(dayHeaderOf(keepFor?.day ?? null))}
            onKeep={(keep) => {
              const ask = keepFor;
              setKeepFor(null);
              if (ask !== null) void moveItemTo(ask.day, keep);
            }}
            onCancel={() => setKeepFor(null)}
          />
          <PlanRemoveSheet
            open={props.open && removeOpen}
            title={title}
            busy={planBusy}
            onConfirm={() => void removeFromPlan()}
            onClose={() => setRemoveOpen(false)}
          />
        </>
      ) : null}
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
          filesState={editFiles !== null ? 'ready' : filesRead.state}
          onRetryFiles={filesRead.retry}
          {...(canAttach ? { uploadFile } : {})}
        />
      ) : null}
    </>
  );
}

function ItemMedia(props: {
  read: ReturnType<typeof useScreenRead<ItemScreenData>>['read'];
}): ReactElement {
  const { read } = props;
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
        className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border-strong bg-panel text-md text-fg-3"
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
  workspaceId: string | null;
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
      <div className="flex items-center gap-1.5">
        <span className="text-base font-medium text-fg">{c.authorName}</span>
        {team ? (
          <span className="inline-flex items-center gap-1 text-sm text-warn">
            <IconLock size={ICON_SIZE.inline} />
            {TEAM_ONLY_LABEL}
          </span>
        ) : null}
        <time className="ml-auto font-sans text-sm tabular-nums text-fg-3">
          {formatRelative(c.createdAt)}
        </time>
      </div>
      {/* No mention picker here, but a typed token reads "@username" (or "@Former member"), never raw. */}
      <p className="whitespace-pre-wrap text-base text-fg">
        {resolvePersonMentionText(c.body, props.workspaceId)}
      </p>
    </div>
  );
}
