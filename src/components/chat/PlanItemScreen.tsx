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
// The agency side gets "Remove from plan" (a concept: last and red in the
// header's More menu, after Move and Edit concept; a post item: the red button
// under its Plan notes) (the Remove confirm, then plan_item_remove) and Move to
// another day: a move that resets
// nothing waits behind a 4s Undo strip (useUndoableAction;
// the write goes when the toast ends, never after Undo). Comments: one chat
// per item, every new comment visible to everyone on the plan (no visibility
// chip; Shubham, 5 Nov 2026); older creators-only notes keep their tag and stay
// agency-only (RLS). The comments read
// as a chat thread (PlanItemThread). @ tags the workspace's people (chat's
// picker above the box; members load on focus or the first "@", from the held
// cache), never me, and only the agency side on a creators-only note or a plan
// not shared with the client. A comment appends at once with chat's clock
// and the box clears; a failure leaves it as "Not sent" with Retry. One read
// per table per open, bounded at 5s; the body paints once it settles. The
// phone page is a modal dialog: focus moves in and returns on close
// (PlanPage). A concept lists its Files first (each tile opens the image
// gallery or the file viewer, loaded on tap, with its name under it), then
// the description card (links as in chat, the link preview inside it), then
// Date and Approvers, then Comments. A post item reads its comments only, in
// parallel with the embedded post (never before it), and lists them under
// "Plan notes" below the post (nothing when there are none). Comments are a
// chat with threads (12 Nov 2026): main comments with chat's replies row, a
// thread view with its reply box, files on any comment (post comments' tray,
// upload path and file parts). The comment box is chat's Composer docked full
// width at the bottom of the page (no mic), Plan's mention rules on top.
// Tokens only.
// A bank idea (no plan: opened with an item and no bundle, /plan/bank) reads
// through planItemRead (one shared session read, the kept idea paints first):
// header "Idea", subline "Bank" ("Bank · archived"), a "Came from" line when it
// left a plan, Date "No date"; no Approvers row, plan actions, reviews or Edit.
// Bank meets Plan (6 Nov 2026), concepts only: a Buckets card (chips,
// multi-pick, the pick the ink fill; the add chip turns into an inline field;
// each change autosaves through plan_item_buckets_set with "Saving… / Saved";
// a client reads Tags), and on a bank idea (agency) a Who can see this card
// (Team only / Client can see, the approvers named, Show to client through
// PR 816's warning sheet, Hide from client behind the Undo strip). More menu: a
// planned concept adds Send to chat and Move to bank (above Remove from plan;
// the write waits for the Undo strip, the screen goes back at once); a bank
// idea gets Plan it (PR 816's flow, usePlanIt), Send to chat, Show or Hide,
// Star or Unstar, Archive or Unarchive, Delete last. Send to chat is
// IdeaShareFlow (the chat picker, then chat_plan_item_share).

import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject, ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  bankIdeaEdit,
  planConceptEdit,
  planConceptLinkPost,
  planItemMove,
  planItemRemove,
  planItemBucketsSet,
  planItemReview,
  planItemToBank,
} from '@srtdio/rpc';
import { Chip } from '@/components/ui/Chip';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Input } from '@/components/ui/Input';
import { IdeaShareFlow, type IdeaShareTarget } from '@/components/chat/IdeaShareFlow';
import { BankShowSheet, usePlanIt } from '@/components/pages/plan-tab/BankList';
import {
  CLIENT_CAN_SEE,
  TEAM_ONLY,
  approverNames,
  joinNames,
} from '@/components/pages/plan-tab/bank-parts';
import {
  readPlansForPlanIt,
  removeBankIdea,
  setBankFlags,
  useBankBuckets,
} from '@/components/pages/plan-tab/use-bank-data';
import { createBucket, type BucketOption } from '@/lib/buckets';
import { MOVED_TO_BANK_LABEL, moveToBankError } from '@/lib/chat/bank-plan-copy';
import { dispatchRowToBank } from '@/lib/chat/plan-bank-extras';
import {
  ADD_BUCKET_LABEL,
  BUCKETS_LABEL,
  HIDE_FROM_CLIENT_LABEL,
  IDEA_HIDDEN_LABEL,
  NEW_BUCKET_PLACEHOLDER,
  SHOW_TO_CLIENT_LABEL,
  TEAM_ONLY_LINE,
  WHO_CAN_SEE_LABEL,
  bankIdeaMenu,
  bankIdeaMovedIn,
  bankIdeaOf,
  bucketSaveLabel,
  clientSeesLine,
  plannedConceptMenu,
  runDetachedUndo,
  toggleBucket,
  withIdeaFlags,
  withNewBucket,
  type IdeaFlags,
} from '@/lib/chat/plan-item-bank';
import { peekWorkspaceMembers, useWorkspaceMembers } from '@/lib/workspace-members';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { useToast } from '@/components/ui/toast';
import type { ViewerKind } from '@/components/ui/FileViewer';
import { FOCUS_MISSING_COPY, useFocusTarget } from '@/lib/focus-target';
import { Bone, DUR_SLOW_MS } from '@/lib/motion';
import {
  ICON_SIZE,
  IconCheck,
  IconChevronRight,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconLink,
  IconPlus,
  IconTrash,
} from '@/components/ui/icons';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { Card } from '@/components/ui/Card';
import { Text, TEXT_ROLE } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { PostPicker } from '@/components/chat/PostPicker';
import type { PostCardFields } from '@srtdio/posts';
import { Thumbnail } from '@/components/media/Thumbnail';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ActionMenu, ActionMenuTrigger, type ActionMenuItem } from '@/components/ui/ActionMenu';
import {
  PlanKeepApprovalSheet,
  PlanMoveSheet,
  PlanRemoveSheet,
  PostSheetPlanRowsContext,
  REMOVE_ROW_LABEL,
  RemoveFromPlanButton,
  planConceptMenuItems,
} from '@/components/chat/PlanMoveSheet';
import { Composer } from '@/components/chat/Composer';
import { profileNameOf } from '@/components/chat/MessageBubble';
import {
  fetchCommentFiles,
  idsToRead,
  type CommentFile,
} from '@/components/comments/comment-files';
import {
  MENTION_TEAM_NOTE,
  PlanItemThread,
  THREAD_REPLY_PLACEHOLDER,
  blockedMentions,
  isInvalidMention,
  mentionsRestricted,
  planPickerRows,
  taggableMembers,
  usePlanMentionMembers,
  type PlanCommentLinkTarget,
  type PlanReplyPrivatelyTarget,
  type ShownComment,
} from '@/components/chat/PlanItemThread';
import { flattenOrder, hasTicks, moveToEnd } from '@/lib/chat/plan-drag';
import { dayMoveToast } from '@/lib/chat/plan-keyboard-move';
import {
  CONCEPT_FILES_READ_FAILED,
  ConceptSheet,
  EMPTY_CONCEPT,
  useConceptFilesRead,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { renderMessageBody } from '@/components/chat/message-body';
import { postRoute } from '@/components/chat/post-card';
import {
  CHANGE_LINKED_POST_LABEL,
  DRAFT_NOT_READY,
  LINK_POST_LABEL,
  MOVE_FAILED,
  NO_DATE_LABEL,
  PAIR_POST_LABEL,
  POST_NOT_MADE_LABEL,
  STATUS_POST_ROW,
  UNLINK_POST_LABEL,
  canLinkPost,
  linkErrorCopy,
  linkedPost,
  postLineLabel,
  type LinkedPost,
  REMOVED_TOAST,
  REMOVE_FAILED,
  STATUS_LABELS,
  TEAM_STATUS_LABELS,
  TEAM_APPROVE_CONFIRM,
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
import { readProfiles, type ChatProfile } from '@/lib/chat-reads';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import {
  bankIdeaEditArgs,
  bankItemReadWhat,
  conceptEditArgs,
  conceptEditUnchanged,
  dispatchPlanChanged,
  planItemRead,
  readConceptFiles,
  readItemBuckets,
  readItemScreen,
  sendPlanComment,
  type CommentVisibility,
  type PlanItemRead,
  type ItemScreenData,
  type PlanBundle,
  type PlanCommentRow,
  type PlanItemFile,
  type PlanItemRow,
  type ReviewSide,
  type ReviewStatus,
} from '@/lib/chat/plans';
import {
  classifyFileKind,
  type AttachmentUploader,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import { useCoarsePointer } from '@/lib/use-is-laptop';
import { safeTimeZone } from '@/lib/time';
import { civilToday } from '@/lib/plan-week';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspace } from '@/lib/workspace-context';
import { mentionIds, mentionQuery, type MentionMember, type NameOf } from '@/lib/chat/mentions';
import { draftText, getDraft, setDraft, subscribeDrafts } from '@/lib/chat/drafts';

import { resolvePeople } from '@/lib/people-names';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { firstExternalUrl } from '@/lib/chat/message-links';
import { errorText } from '@/lib/error-copy';
import { markEntityReadOnOpen } from '@/lib/inbox/unread-entities';
import { invalidateReads, readKey, sharedRead } from '@/lib/session-read';
import type { Result } from '@srtdio/rpc';

/** The preview card for the first external link in a concept's description. */
function ConceptLinkCard(props: { text: string }): ReactElement | null {
  const url = firstExternalUrl(props.text);
  return url !== null ? (
    <LinkPreviewCard key={url} url={url} className="mt-1 w-full max-w-md" />
  ) : null;
}

// The viewers load on the first tap of a file tile, never on the item's paint.
const ImageLightbox = lazy(() =>
  import('@/components/ui/ImageLightbox').then((m) => ({ default: m.ImageLightbox })),
);
const ConceptFileViewer = lazy(() =>
  import('@/components/ui/FileViewer').then((m) => ({
    default: function ConceptFileViewer(props: {
      versionId: string;
      name: string;
      kind: ViewerKind;
      onClose: () => void;
    }): ReactElement | null {
      const { versionId } = props;
      const source = useMemo(
        () => m.remoteFileSource(sharedCardPresignCache(), versionId),
        [versionId],
      );
      return (
        <m.FileViewer name={props.name} kind={props.kind} source={source} onClose={props.onClose} />
      );
    },
  })),
);

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
export const IDEA_UPDATED = 'Idea updated';
export const CONCEPT_SAVE_FAILED = errorText('save', null);

/** Whether saving an edit resets a review: the team or client one is not waiting. Pure. */
export function conceptEditResets(team: ReviewStatus, client: ReviewStatus): boolean {
  return team !== 'waiting' || client !== 'waiting';
}

/** A concept file's shown name: its asset name, else "Concept file". Pure. */
export function conceptFileName(file: Pick<PlanItemFile, 'name'>): string {
  return file.name.trim() !== '' ? file.name : 'Concept file';
}

/** Whether a concept file opens in the image gallery (an image/* MIME, else kind image). Pure. */
export function isConceptImage(file: Pick<PlanItemFile, 'mimeType' | 'kind'>): boolean {
  if (file.mimeType !== null) return file.mimeType.toLowerCase().startsWith('image/');
  return file.kind === 'image';
}

/** The file viewer kind for a non-image concept file (PDF, video, office, other). Pure. */
export function conceptViewerKind(file: Pick<PlanItemFile, 'mimeType' | 'kind'>): ViewerKind {
  if (file.mimeType !== null) return classifyFileKind(file.mimeType);
  return file.kind === 'video' ? 'video' : 'file';
}

/** The Edit concept sheet's prefill from the item and its read files (none when unread). Pure. */
export function conceptEditForm(
  item: Pick<PlanItemRow, 'title' | 'description' | 'target_date'>,
  files: readonly PlanItemFile[] | null,
): ConceptForm {
  return {
    title: item.title ?? '',
    description: item.description ?? '',
    date: item.target_date?.slice(0, 10) ?? '',
    files: (files ?? []).map((f) => ({ versionId: f.versionId, name: conceptFileName(f) })),
  };
}

/** The laptop hint under the comment box (chat's send rule). */
export const COMMENT_SEND_HINT = 'Enter to send · Shift+Enter for a new line';

/** The post item's comments block label. */
export const PLAN_NOTES_LABEL = 'Plan notes';

/**
 * The concept's header More menu (agency only): Move to another day, Edit
 * concept, then Remove from plan, red and last. Pure.
 */
export function planItemMenuItems(props: {
  onMove: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): ActionMenuItem[] {
  return [
    ...planConceptMenuItems({ onMove: props.onMove, onEdit: props.onEdit }),
    {
      id: 'remove',
      label: REMOVE_ROW_LABEL,
      icon: IconTrash,
      tone: 'danger',
      onSelect: props.onRemove,
    },
  ];
}

/** The comment box placeholder: one chat per item, so no audience in it. */
export const COMMENT_PLACEHOLDER = 'Add a comment';

/** A bank idea's header: the title, its subline and the back label. */
export const BANK_ITEM_TITLE = 'Idea';
export const BANK_LABEL = 'Bank';
export const BANK_BACK_LABEL = 'Back to Bank';

/** A bank idea's subline: "Bank", or "Bank · archived". Pure. */
export function bankSubline(item: Pick<PlanItemRow, 'archived_at'>): string {
  return item.archived_at !== null && item.archived_at !== undefined
    ? `${BANK_LABEL} · archived`
    : BANK_LABEL;
}

/** The line under a bank idea's subline when it left a plan; null when made in the bank. Pure. */
export function cameFromLine(item: Pick<PlanItemRow, 'came_from_plan_title'>): string | null {
  const title = item.came_from_plan_title?.trim() ?? '';
  return title !== '' ? `Came from ${title}` : null;
}

/**
 * The bundle a bank idea stands in (no plan): the idea alone, no reviews, its
 * linked post's stage and info. The audience follows Who can see (team-only
 * ideas tag only the agency side). Never written or dispatched. Pure.
 */
export function bankBundleOf(
  item: PlanItemRow,
  link: Pick<PlanBundle, 'postStages' | 'postInfo'> = { postStages: {}, postInfo: {} },
): PlanBundle {
  return {
    plan: {
      id: '',
      workspace_id: '',
      title: BANK_LABEL,
      starts_on: '',
      ends_on: '',
      audience: item.show_to_client === true ? 'client' : 'team',
      created_by: null,
    },
    items: [item],
    reviews: [],
    postStages: link.postStages,
    postInfo: link.postInfo,
  };
}

/** One bank idea through the shared session read (the route and the screen join it). */
export function sharedBankItemRead(
  userId: string,
  workspaceId: string,
  itemId: string,
): Promise<Result<PlanItemRead>> {
  return sharedRead(
    readKey(userId, workspaceId, bankItemReadWhat(itemId)),
    () => planItemRead(supabase, itemId, (ids, s) => readProfiles(supabase, ids, s)),
    { isOk: (r) => r.ok },
  );
}

export function PlanItemScreen(props: {
  open: boolean;
  /** The item's plan; absent for a bank idea (no plan). */
  bundle?: PlanBundle;
  item: PlanItemRow;
  /** A bank idea's linked post stage and info (planItemRead); ignored with a bundle. */
  bankLink?: Pick<PlanBundle, 'postStages' | 'postInfo'>;
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
  /**
   * A concept's Post row: open its linked post as a post item opens (the
   * Plan screen's item, or the post alone). Absent: the pipeline route.
   */
  onOpenLinkedPost?: (postId: string) => void;
}): ReactElement | null {
  const { side } = props;
  // A bank idea's flags changed here (Show, Hide, Star, Archive) ahead of the re-read.
  const [flags, setFlags] = useState<IdeaFlags>({});
  const item = useMemo(() => withIdeaFlags(props.item, flags), [props.item, flags]);
  const bank = props.bundle === undefined;
  const bankLink = props.bankLink;
  const bundle = useMemo(
    () => props.bundle ?? bankBundleOf(item, bankLink),
    [props.bundle, item, bankLink],
  );
  const { workspaces, workspaceId } = useWorkspace();
  // The workspace civil clock the plan days read on (device zone when unset).
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const navigate = useNavigate();
  // A concept reads its comments and files; a post item its comments only (the
  // Plan notes), in parallel with the embedded post view's own reads, so the
  // post never waits for it.
  // A bank idea joins the route's shared planItemRead (one read per open).
  const bankKey =
    bank && me !== null && workspaceId !== null
      ? readKey(me, workspaceId, bankItemReadWhat(item.id))
      : null;
  const { read, reload: reloadScreen } = useScreenRead<ItemScreenData>(
    props.open,
    item.id,
    (signal) =>
      bank && me !== null && workspaceId !== null
        ? sharedBankItemRead(me, workspaceId, item.id).then(
            (r): Result<ItemScreenData> => (r.ok ? { ok: true, data: r.data.screen } : r),
          )
        : readItemScreen(supabase, item, (ids, s) => readProfiles(supabase, ids, s), signal),
  );
  const reload = (): void => {
    if (bankKey !== null) invalidateReads(bankKey);
    reloadScreen();
  };
  // A landed write: the plan's screens re-read; a bank idea's kept read goes stale.
  const planChanged = (): void => {
    if (bank) {
      if (bankKey !== null) invalidateReads(bankKey);
      return;
    }
    dispatchPlanChanged(window, bundle.plan.id);
  };
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
  const [pending, setPending] = useState<ShownComment[]>([]);
  // "Ask changes" opened the composer: Send records the note, then the review.
  const [askingChanges, setAskingChanges] = useState(false);
  // After a send: the comment to scroll to once it is listed.
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  const mentionPeople = usePlanMentionMembers(me, workspaceId);
  // The comment box is chat's Composer (12 Nov 2026): its field, for Ask
  // changes' focus; a bump remounts a box so a draft put back shows.
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [boxEpoch, setBoxEpoch] = useState(0);
  // Comment files by version id: one batched asset_versions read (post comments' read).
  const [commentFiles, setCommentFiles] = useState<Map<string, CommentFile>>(new Map());
  const coarse = useCoarsePointer();
  const toast = useToast();
  const undoable = useUndoableAction();
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  // The concept's files when the sheet opened; null when not read yet.
  const [editFiles, setEditFiles] = useState<PlanItemFile[] | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // Link a post (a concept, agency side): the picker, its single pick (by id;
  // the row when picked here), and the screen's own link ahead of the re-read
  // (undefined: none held; null: unlinked; a post: linked to it).
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkPickId, setLinkPickId] = useState<string | null>(null);
  const [linkPickRow, setLinkPickRow] = useState<PostCardFields | null>(null);
  const [linkOverride, setLinkOverride] = useState<PostCardFields | null | undefined>(undefined);
  const [linkBusy, setLinkBusy] = useState(false);
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

  // Another item drops the flags changed here.
  useEffect(() => setFlags({}), [props.item.id]);
  // A new item (or a fresh bundle) drops the local overrides and drafts.
  useEffect(() => {
    setOverrides({});
    setLinkOverride(undefined);
  }, [bundle]);
  useEffect(() => {
    if (props.open) return;
    setConfirmOpen(false);
    setMoreOpen(false);
    setActionError(null);
    setPending([]);
    setAskingChanges(false);
    setEditOpen(false);
    setConceptMenuOpen(false);
    setMoveOpen(false);
    setRemoveOpen(false);
    setKeepFor(null);
    setLinkPickerOpen(false);
  }, [props.open, item.id]);

  // Opening the item reads its comments: the Plan row marker and the Plan nav
  // badge drop, and the rows are marked read in the background.
  useEffect(() => {
    if (props.open) markEntityReadOnOpen('plan_item', item.id);
  }, [props.open, item.id]);

  // A write that lands after the viewer moved on (another item, or closed)
  // never touches the screen they are on now.
  const liveRef = useRef({ itemId: item.id, open: props.open });
  liveRef.current = { itemId: item.id, open: props.open };
  const stillOn = (itemId: string): boolean => isLiveItem(liveRef.current, itemId);
  // Another item starts clean: no draft, pending row, error or override carries over.
  useEffect(() => {
    setPending([]);
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

  // A bank idea has no reviews: no actions.
  const actions: ItemActions = bank
    ? { kind: 'none' }
    : itemActions(side, item, bundle.plan.audience);
  // The side a changes review writes: the item's own review actions, else
  // (Not OK on a row, a post item too) the viewer's PLAN side.
  const reviewSide =
    actions.kind === 'review'
      ? actions.side
      : props.askChanges === true
        ? slotSide(side, bundle.plan.audience)
        : null;
  const title = rowTitle(bundle, item);
  // Reply privately on others' comments points at this item (held data only).
  // A bank idea has no plan to point at: no Reply privately.
  const replyPrivately = useMemo<PlanReplyPrivatelyTarget | null>(
    () => (bank ? null : { planId: bundle.plan.id, itemId: item.id, whereLabel: title }),
    [bank, bundle.plan.id, item.id, title],
  );
  // A comment's Copy link: the item with ?comment= (the bank path for a bank idea).
  const commentLink = useMemo<PlanCommentLinkTarget>(
    () => ({ planId: bank ? null : bundle.plan.id, itemId: item.id }),
    [bank, bundle.plan.id, item.id],
  );
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
      setActionError(errorText('save', result.error));
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
  // plan_concept_edit edits a plan's concept (its date sits in the plan);
  // bank_idea_edit edits a bank idea (title, description, files; no date).
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
      currentFiles: editFiles !== null ? editFiles.map((f) => f.versionId) : null,
      pickedFiles: editFiles !== null ? editForm.files.map((f) => f.versionId) : null,
    };
    if (conceptEditUnchanged(item, edit)) {
      setEditOpen(false);
      return;
    }
    const forItem = item.id;
    setEditBusy(true);
    const traceId = generateTraceId();
    const result = bank
      ? await bankIdeaEdit(supabase, bankIdeaEditArgs(forItem, edit, traceId))
      : await planConceptEdit(supabase, conceptEditArgs(forItem, edit, traceId));
    setEditBusy(false);
    // A bank idea's kept read goes stale and the Bank re-reads (as its flag writes do).
    const tellBank = (): void => {
      if (bankKey !== null) invalidateReads(bankKey);
      dispatchPlanChanged(window, '');
    };
    if (!stillOn(forItem)) {
      if (result.ok) {
        if (bank) tellBank();
        else dispatchPlanChanged(window, bundle.plan.id);
      }
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan concept edit failed', {
        trace_id: traceId,
        item_id: forItem,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, CONCEPT_SAVE_FAILED) });
      return;
    }
    setEditOpen(false);
    toast.show({ title: bank ? IDEA_UPDATED : CONCEPT_UPDATED });
    reload();
    if (bank) tellBank();
    else dispatchPlanChanged(window, bundle.plan.id);
  };

  // The concept's linked post: the screen's own write first, else the read.
  const link: LinkedPost = linkViewOf(linkedPost(bundle, item, side), linkOverride);
  const linkedId = link.kind === 'linked' ? link.postId : null;
  const mayLink = canLinkPost(item, side);
  const openLinkPicker = (): void => {
    setLinkPickId(linkedId);
    setLinkPickRow(null);
    setLinkPickerOpen(true);
  };
  /** One plan_concept_link_post: a post links it, null unlinks. Shown at once; a refusal puts it back. */
  const writeLink = async (post: PostCardFields | null): Promise<void> => {
    if (linkBusy) return;
    const forItem = item.id;
    const before = linkOverride;
    setLinkBusy(true);
    setLinkOverride(post);
    const traceId = generateTraceId();
    const result = await planConceptLinkPost(supabase, {
      p_item_id: forItem,
      p_post_id: post?.id ?? null,
      p_trace_id: traceId,
    });
    setLinkBusy(false);
    if (!stillOn(forItem)) {
      if (result.ok) planChanged();
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan concept link failed', {
        trace_id: traceId,
        item_id: forItem,
        error: result.error.message,
      });
      setLinkOverride(before);
      toast.show({
        title: linkErrorCopy(result.error.message, CONCEPT_SAVE_FAILED),
        tone: 'error',
      });
      return;
    }
    // The re-read brings the Plan list's pair (and drops this screen's own link).
    planChanged();
  };
  // "Link this post": the pick, unless it is the post already linked (a no-op).
  const confirmLink = (): void => {
    const pick = linkPickRow;
    setLinkPickerOpen(false);
    if (pick === null || pick.id === linkedId) return;
    void writeLink(pick);
  };
  const openLinked = (postId: string): void => {
    if (props.onOpenLinkedPost !== undefined) props.onOpenLinkedPost(postId);
    else navigate(postRoute(postId));
  };

  const shown = useMemo<ShownComment[]>(() => {
    const recorded =
      read.status === 'ready'
        ? read.data.comments.map(
            (c: PlanCommentRow): ShownComment => ({
              id: c.id,
              authorUserId: c.author_user_id,
              mine: c.author_user_id !== null && c.author_user_id === me,
              authorName:
                c.author_user_id !== null && c.author_user_id === me
                  ? 'You'
                  : ((c.author_user_id !== null ? read.data.names[c.author_user_id] : undefined) ??
                    'Member'),
              body: c.body,
              visibility: c.visibility,
              createdAt: c.created_at,
              pending: false,
              authorKnown:
                c.author_user_id !== null && read.data.names[c.author_user_id] !== undefined,
              parentId: c.parent_comment_id ?? null,
              attachmentIds: c.attachment_asset_ids ?? null,
              readAt: c.thread_read_at ?? null,
              taskState: c.task_state ?? null,
              taskLink: c.task_link ?? null,
            }),
          )
        : [];
    const ids = new Set(recorded.map((c) => c.id));
    return [...recorded, ...pending.filter((p) => !ids.has(p.id))];
  }, [read, pending, me]);

  // Every comment file in one batched read (no N+1), after paint; a failed
  // read is asked again on the next pass (post comments' rule).
  const askedFiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (read.status !== 'ready') return;
    const needed = idsToRead(
      read.data.comments.flatMap((c: PlanCommentRow) => c.attachment_asset_ids ?? []),
      askedFiles.current,
    );
    if (needed.length === 0) return;
    for (const id of needed) askedFiles.current.add(id);
    void fetchCommentFiles(supabase, needed).then((fetched) => {
      if (fetched === null) {
        for (const id of needed) askedFiles.current.delete(id);
        return;
      }
      if (fetched.size > 0) setCommentFiles((prev) => new Map([...prev, ...fetched]));
    });
  }, [read]);

  /** Put a refused send's text back in its box (the box remounts from its draft). */
  const restoreDraft = (parentId: string | null, body: string): void => {
    // After the box's own send clears its draft (it does so right after onSend).
    queueMicrotask(() => {
      setDraft(commentChannel(item.id, parentId), { text: body, caret: body.length });
      setBoxEpoch((n) => n + 1);
    });
  };

  /**
   * One comment or reply write, chat's way: the row shows at once with the
   * clock (the box cleared itself in the same tap); picked files upload first
   * (post comments' path, library origin) and go as asset version ids; a
   * failure leaves the row as "Not sent" with Retry (chat's FailedActions); a
   * refused mention drops the row and puts the draft back with one toast.
   * True when it landed on this item. `retryId` re-sends that failed row.
   */
  const sendComment = async (
    send: {
      body: string;
      attachments: MessageAttachment[];
      parentId: string | null;
      visibility: CommentVisibility;
    },
    retryId?: string,
  ): Promise<boolean> => {
    // A fresh id per send: the box never waits, so two sends can share a millisecond.
    const localId = retryId ?? `local-${generateTraceId()}`;
    const forItem = item.id;
    const row: ShownComment = {
      id: localId,
      authorUserId: me,
      mine: true,
      authorName: 'You',
      body: send.body,
      visibility: send.visibility,
      createdAt: new Date().toISOString(),
      pending: true,
      parentId: send.parentId,
      localAttachments: send.attachments,
    };
    setPending((prev) =>
      retryId !== undefined ? prev.map((p) => (p.id === retryId ? row : p)) : [...prev, row],
    );
    if (send.parentId === null) setScrollToId(localId);
    const markFailed = (kept: MessageAttachment[]): void =>
      setPending((prev) =>
        prev.map((p) =>
          p.id === localId ? { ...p, pending: false, failed: true, localAttachments: kept } : p,
        ),
      );
    const ids: string[] = [];
    const kept: MessageAttachment[] = [];
    for (const a of send.attachments) {
      if (a.assetId !== '') {
        ids.push(a.assetId);
        kept.push(a);
        continue;
      }
      const file = a.local?.file ?? null;
      if (file === null) continue;
      const up = await uploadFile(file);
      if (!up.ok) {
        if (stillOn(forItem)) markFailed(send.attachments);
        return false;
      }
      ids.push(up.versionId);
      kept.push({ ...a, assetId: up.versionId });
    }
    const traceId = generateTraceId();
    const result = await sendPlanComment(supabase, {
      itemId: forItem,
      parentId: send.parentId,
      body: send.body,
      visibility: send.visibility,
      attachmentVersionIds: ids,
      traceId,
    });
    if (!stillOn(forItem)) {
      if (result.ok) planChanged();
      return false;
    }
    if (!result.ok) {
      logger.warn('chat: plan comment failed', {
        trace_id: traceId,
        item_id: item.id,
        error: result.error.message,
      });
      if (isInvalidMention(result.error.message)) {
        // A tag the server refused (an approver on a creators-only note): one
        // toast, the row goes and the draft comes back as typed.
        setPending((prev) => prev.filter((p) => p.id !== localId));
        if (retryId === undefined) restoreDraft(send.parentId, send.body);
        toast.show({ title: MENTION_TEAM_NOTE });
        return false;
      }
      markFailed(kept);
      return false;
    }
    if (send.parentId === null) setScrollToId(result.data);
    for (const a of kept) {
      if (a.mime === '') continue;
      setCommentFiles((prev) =>
        prev.has(a.assetId) ? prev : new Map(prev).set(a.assetId, { name: a.name, mime: a.mime }),
      );
    }
    setPending((prev) =>
      prev.map((p) =>
        p.id === localId ? { ...p, id: result.data, pending: false, localAttachments: kept } : p,
      ),
    );
    reload();
    planChanged();
    return true;
  };
  /** A failed comment's Retry: the same body and files again, on the same row. */
  const retryComment = (id: string): void => {
    const failed = pending.find((p) => p.id === id && p.failed === true);
    if (failed === undefined) return;
    void sendComment(
      {
        body: failed.body,
        attachments: failed.localAttachments ?? [],
        parentId: failed.parentId ?? null,
        visibility: failed.visibility,
      },
      id,
    );
  };
  /** A failed comment's Delete: it never left the device, so it just goes. */
  const discardComment = (id: string): void => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };
  // @ tags. Only the agency side can be tagged on a creators-only note or a
  // plan not shared with the client; never me. The members load after paint
  // (the held cache, else the one shared members read), as post comments'.
  const loadMembers = mentionPeople.load;
  useEffect(() => {
    if (props.open) loadMembers();
  }, [props.open, loadMembers]);
  const restrictedFor = (visibility: CommentVisibility): boolean =>
    side === 'agency' && mentionsRestricted(visibility, bundle.plan.audience);
  /**
   * The page box's Send (and Ask changes' steps): the note, when there is one
   * (text or files), then the changes review. New main comments go to everyone.
   */
  const sendMain = async (body: string, attachments: MessageAttachment[]): Promise<void> => {
    const steps = askChangesSteps(body, askingChanges);
    if (attachments.length > 0 && !steps.includes('comment')) steps.unshift('comment');
    if (steps.length === 0) return;
    if (
      steps.includes('comment') &&
      !(await sendComment({ body, attachments, parentId: null, visibility: 'everyone' }))
    )
      return;
    if (steps.includes('changes')) {
      if (await review('changes')) setAskingChanges(false);
    }
  };
  /** Ask changes with the box empty: the review alone; with a note, the box's own Send. */
  const askChangesSend = (): void => {
    const field = commentRef.current;
    const files = getDraft(commentChannel(item.id, null)).pendingFiles.length;
    if (field !== null && (field.value.trim() !== '' || files > 0)) {
      field.form?.requestSubmit();
      return;
    }
    void sendMain('', []);
  };
  /** One reply into an open thread (it takes its main comment's audience on the server). */
  const sendReply = (root: ShownComment, body: string, attachments: MessageAttachment[]): void => {
    if (body === '' && attachments.length === 0) return;
    void sendComment({ body, attachments, parentId: root.id, visibility: root.visibility });
  };
  const heldProfiles =
    me !== null && workspaceId !== null
      ? peekWorkspaceMembers(me, workspaceId)?.profiles
      : undefined;
  const boxNameOf = profileNameOf(new Map<string, ChatProfile>(heldProfiles ?? []), workspaceId);
  const boxShared = {
    me,
    members: mentionPeople.members,
    nameOf: boxNameOf,
    trayId: `plan-comments-${item.id}`,
    expandTitle: title,
    ...(canAttach ? { uploadFile } : {}),
  };
  const replyBox = (root: ShownComment, focus: boolean): ReactElement => (
    <PlanCommentBox
      key={`plan-thread:${root.id}:${boxEpoch}`}
      {...boxShared}
      channelId={commentChannel(item.id, root.id)}
      placeholder={THREAD_REPLY_PLACEHOLDER}
      restricted={restrictedFor(root.visibility)}
      focusOnMount={!coarse}
      focusForReply={focus}
      onSend={(body, attachments) => sendReply(root, body, attachments)}
      onRestore={(body) => restoreDraft(root.id, body)}
    />
  );

  // Agency plan actions. Move: to the end of the picked day (one 5-arg
  // plan_item_move with the full plan order; an Open plan's client-approved
  // slot asks "Keep the approval?" first, cancelling cancels the move);
  // Remove: plan_item_remove, then back to the list. Clients never reach
  // these (no rows render for them).
  const planActions = side === 'agency' && !bank;
  const groups = planListGroups(bundle, timeZone, side);
  const currentDay = groups
    .flatMap((w) => w.days)
    .find((d) => d.items.some((i) => i.id === item.id))?.day;
  // Items per plan day for the Edit concept sheet's day tiles (as the Plan
  // screen counts them), from the bundle already held: no read.
  const dayCounts: Record<string, number> = {};
  for (const d of planDayIds(groups)) if (d.day !== null) dayCounts[d.day] = d.ids.length;
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
    const forItem = item.id;
    setPlanBusy(true);
    const traceId = generateTraceId();
    const result = await planItemMove(supabase, {
      p_item_id: forItem,
      p_target_date: day,
      p_item_ids: order,
      p_keep_reviews: keep,
      p_trace_id: traceId,
    });
    setPlanBusy(false);
    // Left this item (or closed) meanwhile: no toast; the list still refreshes.
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return false;
    }
    if (!result.ok) {
      logger.warn('chat: plan item move failed', {
        trace_id: traceId,
        item_id: forItem,
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
    // writeMove is false when the viewer left this item, so no toast then.
    if (await writeMove(day, keep, order)) toast.show({ title: spec.title });
  };
  const removeFromPlan = async (): Promise<void> => {
    if (!planActions || planBusy) return;
    const forItem = item.id;
    setPlanBusy(true);
    const traceId = generateTraceId();
    const result = await planItemRemove(supabase, { p_item_id: forItem, p_trace_id: traceId });
    setPlanBusy(false);
    // Left this item (or closed) meanwhile: no close, no toast; the list still refreshes.
    if (!stillOn(forItem)) {
      if (result.ok) dispatchPlanChanged(window, bundle.plan.id);
      return;
    }
    if (!result.ok) {
      logger.warn('chat: plan item remove failed', {
        trace_id: traceId,
        item_id: forItem,
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

  // Bank meets Plan (concepts). Buckets: the picks autosave (plan_item_buckets_set
  // per change, queued so they land in order; "Saving… / Saved"); a client
  // reads them as Tags. The ids ride on the item when its read carried them
  // (a bank idea's planItemRead, the plan bundle); else one plan_item_buckets
  // select after paint. Bucket names: the Bank's session read (after paint).
  const concept = item.kind === 'concept';
  const agency = side === 'agency';
  const commentCount = read.status === 'ready' ? read.data.comments.length : 0;
  const bankBuckets = useBankBuckets({
    workspaceId,
    userId: me,
    enabled: props.open && concept,
  });
  const [picked, setPicked] = useState<string[] | null>(props.item.bucket_ids ?? null);
  const savedPicks = useRef<string[]>(props.item.bucket_ids ?? []);
  const [bucketsSaving, setBucketsSaving] = useState(0);
  const [bucketsSaved, setBucketsSaved] = useState(false);
  const bucketChain = useRef<Promise<void>>(Promise.resolve());
  const [addingBucket, setAddingBucket] = useState(false);
  const [bucketName, setBucketName] = useState('');
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [bucketBusy, setBucketBusy] = useState(false);
  useEffect(() => {
    setPicked(props.item.bucket_ids ?? null);
    savedPicks.current = props.item.bucket_ids ?? [];
    setBucketsSaved(false);
    setAddingBucket(false);
    setBucketName('');
    setBucketError(null);
    // Only another item resets the picks; a re-read of this one keeps them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.item.id]);
  // The ids arrived with a later read (the bundle) before any pick here.
  const arrivedIds = props.item.bucket_ids;
  useEffect(() => {
    if (arrivedIds === undefined) return;
    setPicked((cur) => {
      if (cur !== null) return cur;
      savedPicks.current = arrivedIds;
      return arrivedIds;
    });
  }, [arrivedIds]);
  const needBucketRead = props.open && concept && picked === null;
  useEffect(() => {
    if (!needBucketRead) return;
    let live = true;
    void readItemBuckets(supabase, [props.item.id]).then((res) => {
      if (!live) return;
      const ids = res.ok ? (res.data[props.item.id] ?? []) : [];
      savedPicks.current = ids;
      setPicked(ids);
    });
    return () => {
      live = false;
    };
  }, [needBucketRead, props.item.id]);
  const writeBuckets = (next: string[]): void => {
    setPicked(next);
    setBucketsSaving((n) => n + 1);
    const forItem = props.item.id;
    bucketChain.current = bucketChain.current.then(async () => {
      const traceId = generateTraceId();
      const res = await planItemBucketsSet(supabase, {
        p_item_id: forItem,
        p_bucket_ids: next,
        p_trace_id: traceId,
      });
      setBucketsSaving((n) => n - 1);
      if (!res.ok) {
        logger.warn('chat: plan item buckets save failed', {
          trace_id: traceId,
          item_id: forItem,
          error: res.error.message,
        });
        setPicked(savedPicks.current);
        toast.show({ title: errorText('save the buckets', res.error.message), tone: 'error' });
        return;
      }
      savedPicks.current = next;
      setBucketsSaved(true);
      planChanged();
    });
  };
  const bucketOrder = bankBuckets.buckets.map((b) => b.id);
  const pickBucket = (id: string): void => {
    if (!agency || picked === null) return;
    writeBuckets(toggleBucket(picked, id, bucketOrder));
  };
  const addBucket = async (): Promise<void> => {
    const name = bucketName.trim();
    if (name === '' || bucketBusy || workspaceId === null || picked === null) return;
    setBucketBusy(true);
    setBucketError(null);
    const res = await createBucket(supabase, workspaceId, name, generateTraceId());
    setBucketBusy(false);
    if (!res.ok) {
      setBucketError(res.error.message);
      return;
    }
    const made: BucketOption = res.data;
    bankBuckets.set([...bankBuckets.buckets.filter((b) => b.id !== made.id), made]);
    setBucketName('');
    setAddingBucket(false);
    writeBuckets(withNewBucket(picked, made.id));
  };
  const saveLabel = bucketSaveLabel({ saving: bucketsSaving > 0, savedOnce: bucketsSaved });
  const pickedBuckets = bankBuckets.buckets.filter((b) => (picked ?? []).includes(b.id));
  const bucketsCard =
    concept && (agency || pickedBuckets.length > 0) ? (
      <Card data-plan-buckets="" className="self-stretch">
        <section aria-label={BUCKETS_LABEL} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className={SECTION_LABEL}>{BUCKETS_LABEL}</h4>
            {agency && saveLabel !== null ? (
              <span
                data-plan-buckets-save={bucketsSaving > 0 ? 'saving' : 'saved'}
                aria-live="polite"
                className="text-sm text-fg-3"
              >
                {saveLabel}
              </span>
            ) : null}
          </div>
          {agency ? (
            <div className="flex flex-wrap gap-2">
              {bankBuckets.buckets.map((b) => (
                <Chip
                  key={b.id}
                  label={b.name}
                  data-plan-bucket={b.id}
                  selected={(picked ?? []).includes(b.id)}
                  disabled={picked === null}
                  onClick={() => pickBucket(b.id)}
                />
              ))}
              {addingBucket ? (
                <form
                  data-plan-bucket-new=""
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addBucket();
                  }}
                >
                  <Input
                    autoFocus
                    value={bucketName}
                    maxLength={40}
                    aria-label={NEW_BUCKET_PLACEHOLDER}
                    placeholder={NEW_BUCKET_PLACEHOLDER}
                    onChange={(e) => {
                      setBucketName(e.target.value);
                      setBucketError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setAddingBucket(false);
                        setBucketName('');
                      }
                    }}
                    className="min-w-0 flex-1"
                  />
                  <IconButton
                    type="submit"
                    label="Add"
                    data-plan-bucket-add-go=""
                    disabled={bucketName.trim() === '' || bucketBusy}
                  >
                    <IconCheck size={ICON_SIZE.nav} />
                  </IconButton>
                </form>
              ) : (
                // An action, not a filter: a Tool (chips are filters only).
                <Button
                  type="button"
                  variant="ghost"
                  data-plan-bucket-add=""
                  disabled={picked === null}
                  onClick={() => setAddingBucket(true)}
                >
                  <IconPlus size={ICON_SIZE.inline} />
                  {ADD_BUCKET_LABEL}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pickedBuckets.map((b) => (
                <Tag key={b.id} label={b.name} />
              ))}
            </div>
          )}
          {bucketError !== null ? <ErrorNote>{bucketError}</ErrorNote> : null}
        </section>
      </Card>
    ) : null;

  // Who can see this (a bank idea, agency only): Team only or Client can see,
  // the line naming the approvers (members read only while the card shows),
  // Show to client (PR 816's warning sheet) or Hide from client (Undo strip).
  const whoCard = bank && agency && concept;
  const members = useWorkspaceMembers(props.open && whoCard ? workspaceId : null);
  const approvers = useMemo(
    () => approverNames(members.rows, members.profiles),
    [members.rows, members.profiles],
  );
  const shownToClient = item.show_to_client === true;
  const [showAsk, setShowAsk] = useState(false);
  const ideaNow = bankIdeaOf(item, commentCount);
  const markBankChanged = (): void => {
    if (bankKey !== null) invalidateReads(bankKey);
    dispatchPlanChanged(window, '');
  };
  const writeFlags = (change: { show?: boolean; archived?: boolean; starred?: boolean }) =>
    setBankFlags(supabase, bankIdeaOf(item, commentCount), change).then(markBankChanged);
  const showToClient = (): void => {
    setShowAsk(false);
    const before = flags;
    setFlags((f) => ({ ...f, show_to_client: true }));
    void writeFlags({ show: true }).catch((error: unknown) => {
      setFlags(before);
      toast.show({ title: errorText('show it to the client', error), tone: 'error' });
    });
  };
  const hideFromClient = (): void => {
    const before = flags;
    setFlags((f) => ({ ...f, show_to_client: false }));
    undoable.run({
      label: IDEA_HIDDEN_LABEL,
      commit: () => writeFlags({ show: false }),
      revert: () => setFlags(before),
    });
  };
  const starIdea = (on: boolean): void => {
    const before = flags;
    setFlags((f) => ({ ...f, starred_at: on ? new Date().toISOString() : null }));
    void writeFlags({ starred: on }).catch((error: unknown) => {
      setFlags(before);
      toast.show({ title: errorText(on ? 'star' : 'unstar', error), tone: 'error' });
    });
  };
  const archiveIdea = (on: boolean): void => {
    const before = flags;
    setFlags((f) => ({ ...f, archived_at: on ? new Date().toISOString() : null }));
    undoable.run({
      label: on ? 'Idea archived' : 'Idea restored',
      commit: () => writeFlags({ archived: on }),
      revert: () => setFlags(before),
    });
  };
  // Delete and Move to bank close the screen at once; their write waits for
  // the Undo strip held by the toast provider (runDetachedUndo), never after Undo.
  const deleteIdea = (): void => {
    const forItem = props.item.id;
    runDetachedUndo(toast.show, {
      label: 'Idea deleted',
      commit: () => removeBankIdea(supabase, forItem).then(markBankChanged),
    });
    props.onClose();
  };
  const moveToBank = (): void => {
    if (!planActions || !concept) return;
    const forItem = props.item.id;
    const planId = bundle.plan.id;
    const planTitle = bundle.plan.title;
    const movedItem = item;
    // The Plan screen's row leaves at once; Undo or a failure brings it back.
    dispatchRowToBank(window, { itemId: forItem, back: false });
    runDetachedUndo(toast.show, {
      label: MOVED_TO_BANK_LABEL,
      revert: () => dispatchRowToBank(window, { itemId: forItem, back: true }),
      commit: async () => {
        const traceId = generateTraceId();
        const res = await planItemToBank(supabase, { p_item_id: forItem, p_trace_id: traceId });
        if (!res.ok) {
          logger.warn('chat: plan item move to bank failed', {
            trace_id: traceId,
            item_id: forItem,
            error: res.error.message,
          });
          dispatchRowToBank(window, { itemId: forItem, back: true });
          toast.show({ title: moveToBankError(res.error.message), tone: 'error' });
          return;
        }
        dispatchPlanChanged(window, planId, {
          kind: 'in',
          idea: bankIdeaMovedIn(movedItem, planTitle, new Date().toISOString()),
        });
      },
    });
    (props.onRemoved ?? props.onClose)();
  };
  // Plan it (a bank idea): PR 816's flow (usePlanIt); placed, the screen closes.
  const today = civilToday(new Date(), timeZone);
  const planIt = usePlanIt({
    workspaceId: workspaceId ?? '',
    today,
    getPlans: () =>
      workspaceId === null
        ? Promise.resolve({ ok: false as const, error: { message: 'no workspace' } })
        : readPlansForPlanIt(workspaceId, today),
    onPlaced: () => {
      markBankChanged();
      props.onClose();
    },
    onUnplaced: markBankChanged,
  });
  // Send to chat: the chat picker, then chat_plan_item_share (IdeaShareFlow).
  const [sendIdea, setSendIdea] = useState<IdeaShareTarget | null>(null);
  const sendToChat = (): void =>
    setSendIdea({
      id: item.id,
      title: rowTitle(bundle, item),
      commentCount,
      // A planned concept refused for the client opens its plan, never bank_idea_set.
      plan: bank ? null : { id: bundle.plan.id, title: bundle.plan.title },
    });
  const whoCanSeeCard = whoCard ? (
    <Card data-plan-who-can-see="" className="self-stretch">
      <section aria-label={WHO_CAN_SEE_LABEL} className="flex flex-col gap-2">
        <h4 className={SECTION_LABEL}>{WHO_CAN_SEE_LABEL}</h4>
        <div className="flex items-center">
          <Tag
            label={shownToClient ? CLIENT_CAN_SEE : TEAM_ONLY}
            tone={shownToClient ? 'good' : 'neutral'}
          />
        </div>
        <p data-plan-who-line="" className="text-base text-fg-2">
          {shownToClient ? clientSeesLine(joinNames(approvers)) : TEAM_ONLY_LINE}
        </p>
        <div>
          {shownToClient ? (
            <Button type="button" data-plan-who-hide="" onClick={hideFromClient}>
              <IconEyeOff size={ICON_SIZE.inline} />
              {HIDE_FROM_CLIENT_LABEL}
            </Button>
          ) : (
            <Button type="button" data-plan-who-show="" onClick={() => setShowAsk(true)}>
              <IconEye size={ICON_SIZE.inline} />
              {SHOW_TO_CLIENT_LABEL}
            </Button>
          )}
        </div>
      </section>
    </Card>
  ) : null;
  const plannedMenu = (): ActionMenuItem[] => {
    const rows = planItemMenuItems({
      onMove: () => setMoveOpen(true),
      onEdit: openEdit,
      onRemove: () => setRemoveOpen(true),
    });
    const remove = rows[rows.length - 1];
    return remove === undefined
      ? rows
      : plannedConceptMenu(rows.slice(0, -1), remove, {
          onSendToChat: sendToChat,
          onMoveToBank: moveToBank,
        });
  };
  const bankMenu =
    bank && agency && concept
      ? bankIdeaMenu(item, {
          onPlanIt: () => planIt.start(ideaNow),
          onEdit: openEdit,
          onSendToChat: sendToChat,
          onShow: () => setShowAsk(true),
          onHide: hideFromClient,
          onStar: starIdea,
          onArchive: archiveIdea,
          onDelete: deleteIdea,
        })
      : null;
  const conceptMenu: ActionMenuItem[] | null = concept && planActions ? plannedMenu() : bankMenu;

  // The linked comment (concept items; a post item's comments land inside the
  // embedded post page): once its row renders, scroll to it and ring it briefly
  // (useFocusTarget, keyed by id, so a second link on this open item lands too).
  // The read lists everything it can show, so a ready read without it means
  // deleted or not visible: one toast, the item stays open.
  const highlightId = props.highlightCommentId ?? null;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const commentsRef = useRef<HTMLElement>(null);
  // The phone page pushes in (pushIn, 280 ms): the link lands once it is at
  // rest, read off its transform each frame (never transitionend, which can be
  // missed). Ceiling SLIDE_SETTLE_MS: past it the link lands anyway. The only
  // hold on this path.
  const [slidIn, setSlidIn] = useState(false);
  useEffect(() => {
    if (!props.open) {
      setSlidIn(false);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const check = (): void => {
      const page = commentsRef.current?.closest('[data-plan-page]') ?? null;
      const transform = page !== null ? getComputedStyle(page).transform : 'none';
      const atRest = transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
      if ((page !== null && atRest) || performance.now() - start > SLIDE_SETTLE_MS) {
        setSlidIn(true);
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [props.open]);
  // A linked reply: the page lands on its main comment and its thread opens at it.
  const linkedReplyRoot =
    highlightId !== null ? (shown.find((c) => c.id === highlightId)?.parentId ?? null) : null;
  const landingId = linkedReplyRoot ?? highlightId;
  useFocusTarget({
    targetId: props.open && slidIn && item.kind !== 'post' ? landingId : null,
    findElement: (id) =>
      commentsRef.current?.querySelector<HTMLElement>(`[data-plan-comment-id="${id}"]`) ?? null,
    absent: read.status === 'ready' && !shown.some((c) => c.id === highlightId),
    onMissing: () => toast.show({ title: FOCUS_MISSING_COPY, tone: 'error' }),
    highlight: () => {
      setHighlighted(landingId);
      const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
      return () => {
        clearTimeout(timer);
        setHighlighted(null);
      };
    },
  });

  // After a send the thread scrolls to the new comment (its pending row, then
  // the recorded one). Opening still starts at the top.
  useEffect(() => {
    if (scrollToId === null) return;
    const page = dockRef.current?.closest('[data-plan-page]') ?? null;
    const row = page?.querySelector<HTMLElement>(`[data-plan-comment-id="${scrollToId}"]`) ?? null;
    if (row === null) return;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    setScrollToId(null);
  }, [scrollToId, shown]);

  // The comment box: chat's Composer docked full width at the bottom of the
  // page (sticky under the content, its own dock edge), "Ask changes" hint
  // and its error above it. A post item shows it only while asking changes.
  const commentDock = (
    <div ref={dockRef} data-plan-comments-composer="" className="sticky bottom-0 z-sticky mt-auto">
      {askingChanges ? (
        <div
          data-plan-ask-hint=""
          className={cn(
            'flex flex-col border-t border-border bg-panel py-1 text-md text-fg-2',
            GUTTER,
          )}
        >
          <p className="py-2">{ASK_CHANGES_HINT}</p>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              data-plan-ask-send=""
              disabled={busy}
              onClick={askChangesSend}
              className="min-w-0 px-3"
            >
              <span className="truncate">{ASK_CHANGES_SEND}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Cancel ask changes"
              data-plan-ask-cancel=""
              onClick={() => setAskingChanges(false)}
              className="shrink-0 px-3"
            >
              Clear
            </Button>
          </div>
          {actionError !== null ? (
            <p role="alert" className="pb-2 text-md text-bad">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}
      <PlanCommentBox
        key={`plan-main:${item.id}:${boxEpoch}`}
        {...boxShared}
        channelId={commentChannel(item.id, null)}
        inputRef={commentRef}
        placeholder={askingChanges ? ASK_CHANGES_PLACEHOLDER : COMMENT_PLACEHOLDER}
        restricted={restrictedFor('everyone')}
        onSend={(body, attachments) => void sendMain(body, attachments)}
        onRestore={(body) => restoreDraft(null, body)}
      />
    </div>
  );

  return (
    <>
      <PlanPage
        open={props.open}
        testId="item"
        title={bank ? BANK_ITEM_TITLE : itemKindLabel(bundle.items, item)}
        subtitle={
          bank ? bankSubline(item) : (itemSlotSubtitle(bundle, item, side) ?? bundle.plan.title)
        }
        backLabel={props.backLabel ?? (bank ? BANK_BACK_LABEL : 'Back to plan')}
        onBack={props.onClose}
        desktopBack
        closeLabel="Close plan"
        {...(props.onDismiss !== undefined ? { onDismiss: props.onDismiss } : {})}
        {...(conceptMenu !== null
          ? {
              action: (
                <ActionMenu
                  title={title}
                  items={conceptMenu}
                  open={props.open && conceptMenuOpen}
                  onOpenChange={setConceptMenuOpen}
                  trigger={
                    <ActionMenuTrigger
                      type="button"
                      label="Item actions"
                      data-plan-item-more=""
                      aria-expanded={conceptMenuOpen}
                    />
                  }
                />
              ),
            }
          : {})}
        {...(item.kind === 'post' && item.post_id !== null
          ? {
              action: (
                // Opens the embedded Post detail's ⋯ menu (its trigger is null).
                <ActionMenuTrigger
                  type="button"
                  data-plan-more=""
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(true)}
                />
              ),
            }
          : {})}
      >
        {item.kind === 'post' ? (
          <>
            {item.post_id !== null ? (
              <PostSheetPlanRowsContext.Provider value={planRows}>
                <Suspense fallback={<Bone lit="flat" as="div" className="m-4 h-44 rounded-lg" />}>
                  <PostDetailPage
                    postId={item.post_id}
                    embedded
                    {...(props.highlightCommentId !== undefined
                      ? { focusCommentId: props.highlightCommentId }
                      : {})}
                    onNavigateAway={props.onClose}
                    actionsOpen={props.open && moreOpen}
                    onActionsOpenChange={setMoreOpen}
                  />
                </Suspense>
              </PostSheetPlanRowsContext.Provider>
            ) : null}
            <PlanNotes
              notes={read.status === 'ready' ? shown : []}
              workspaceId={workspaceId}
              me={me}
              replyPrivately={replyPrivately}
              linkTo={commentLink}
              onRetry={retryComment}
              onDiscard={discardComment}
              files={commentFiles}
              threadSubtitle={title}
              replyBox={replyBox}
              canTask={side === 'agency'}
              itemId={item.id}
            />
            {removeButton}
            {askingChanges ? commentDock : null}
          </>
        ) : (
          <div className={cn('flex flex-col gap-4 py-4', GUTTER)}>
            {bank && cameFromLine(item) !== null ? (
              <p data-plan-came-from="" className="-mt-1 text-sm text-fg-3">
                {cameFromLine(item)}
              </p>
            ) : null}
            <section data-plan-files="" aria-label="Files" className="flex flex-col gap-2">
              <h4 className={SECTION_LABEL}>Files</h4>
              <ItemMedia read={read} onRetry={reload} />
            </section>
            <Card data-plan-description-card="" className="self-stretch">
              <div className="flex items-start justify-between gap-2">
                <Text as="h3" role="heading" className="min-w-0 break-words py-3">
                  {title}
                </Text>
                {editable ? (
                  <Button
                    type="button"
                    variant="link"
                    data-plan-edit-concept=""
                    onClick={openEdit}
                    className="shrink-0"
                  >
                    <IconEdit size={ICON_SIZE.inline} />
                    Edit
                  </Button>
                ) : null}
              </div>
              {description !== '' ? (
                <div
                  data-plan-description=""
                  className="whitespace-pre-wrap break-words text-base text-fg-2"
                >
                  {renderMessageBody(description, false)}
                </div>
              ) : null}
              <ConceptLinkCard text={description} />
            </Card>
            {bucketsCard}
            {whoCanSeeCard}
            <Card data-plan-status="" className="self-stretch">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <span className="text-base text-fg-3">Date</span>
                <span className="flex items-center gap-1">
                  <span
                    data-plan-item-date={!bank && date.dated ? 'dated' : 'none'}
                    className={cn(
                      'text-md',
                      !bank && date.dated ? 'font-mono text-fg-2' : 'text-fg-3',
                    )}
                  >
                    {bank ? NO_DATE_LABEL : date.label}
                  </span>
                  {editable && !bank ? (
                    <Button
                      type="button"
                      variant="link"
                      data-plan-edit-date=""
                      aria-label="Edit date"
                      onClick={openEdit}
                      className="-mr-2"
                    >
                      <IconEdit size={ICON_SIZE.inline} />
                      Edit
                    </Button>
                  ) : null}
                </span>
              </div>
              {(bank ? [] : statusRows(bundle, item, side, overrides)).map((row) => (
                <div key={row.label} className="flex min-h-7 items-center justify-between gap-2">
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
              <PostStatusRow link={link} onOpen={openLinked} />
            </Card>
            {side === 'agency' ? (
              <LinkActions
                linked={link.kind === 'linked'}
                mayLink={mayLink}
                busy={linkBusy}
                onLink={openLinkPicker}
                onUnlink={() => void writeLink(null)}
              />
            ) : null}
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
            <section ref={commentsRef} className="flex flex-col gap-3" aria-label="Comments">
              <h4 className={SECTION_LABEL}>Comments</h4>
              {read.status === 'loading' ? (
                <Bone lit="flat" as="div" className="h-18 rounded-lg" />
              ) : read.status === 'error' ? (
                <ScreenFailed onRetry={reload} />
              ) : shown.length === 0 ? (
                <p className="text-md text-fg-3">Comments show up here.</p>
              ) : (
                <PlanItemThread
                  comments={shown}
                  workspaceId={workspaceId}
                  me={me}
                  highlightedId={highlighted}
                  replyPrivately={replyPrivately}
                  linkTo={commentLink}
                  onRetry={retryComment}
                  onDiscard={discardComment}
                  files={commentFiles}
                  threadSubtitle={title}
                  replyBox={replyBox}
                  openReplyId={linkedReplyRoot !== null ? highlightId : null}
                  canTask={side === 'agency'}
                  unreadItemId={item.id}
                />
              )}
            </section>
          </div>
        )}
        {item.kind !== 'post' ? commentDock : null}
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
      {side === 'agency' && item.kind === 'concept' ? (
        <PostPicker
          open={props.open && linkPickerOpen}
          mode="link"
          onClose={() => setLinkPickerOpen(false)}
          selected={NO_POSTS}
          onToggle={ignorePick}
          selectedBriefs={NO_BRIEFS}
          onToggleBrief={ignorePick}
          linkDay={item.target_date?.slice(0, 10) ?? null}
          linkSelectedId={linkPickId}
          onLinkSelect={(post) => {
            setLinkPickId(post.id);
            setLinkPickRow(post);
          }}
          onLinkConfirm={confirmLink}
        />
      ) : null}
      {agency && concept ? (
        <IdeaShareFlow
          idea={sendIdea}
          onClose={() => setSendIdea(null)}
          onShown={() => {
            setFlags((f) => ({ ...f, show_to_client: true }));
            markBankChanged();
          }}
        />
      ) : null}
      {bank && agency && concept ? (
        <>
          {planIt.sheets}
          <BankShowSheet
            idea={showAsk ? bankIdeaOf(item, commentCount) : null}
            workspaceId={workspaceId ?? ''}
            onClose={() => setShowAsk(false)}
            onShow={showToClient}
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
          note={!bank && editResets ? CONCEPT_EDIT_RESET_HINT : null}
          filesState={editFiles !== null ? 'ready' : filesRead.state}
          onRetryFiles={filesRead.retry}
          range={{ startsOn: bundle.plan.starts_on, endsOn: bundle.plan.ends_on }}
          today={civilToday(new Date(), timeZone)}
          dayCounts={dayCounts}
          noDate={bank}
          {...(canAttach ? { uploadFile } : {})}
        />
      ) : null}
    </>
  );
}

/** The link picker's unused multi-select props (link mode selects by id). */
const NO_POSTS: readonly PostCardFields[] = [];
const NO_BRIEFS: readonly [] = [];
function ignorePick(): void {}

/**
 * The concept's link as shown: the screen's own write (a post, or null for
 * unlinked) over the read, so a tap shows at once and the re-read settles it. Pure.
 */
export function linkViewOf(read: LinkedPost, own: PostCardFields | null | undefined): LinkedPost {
  if (own === undefined) return read;
  if (own === null) return { kind: 'none' };
  return {
    kind: 'linked',
    postId: own.id,
    stage: own.stage,
    info: { title: own.title ?? '', format: own.format ?? null },
  };
}

/**
 * The status box's Post row: "Not made yet"; "Not ready to view yet" for a
 * post the viewer cannot read (inert); else the post's title and its stage
 * (the POST line's name), tappable to open the post.
 */
export function PostStatusRow(props: {
  link: LinkedPost;
  onOpen: (postId: string) => void;
}): ReactElement {
  const { link } = props;
  if (link.kind !== 'linked') {
    return (
      <div
        data-plan-status-post={link.kind}
        className="flex min-h-7 items-center justify-between gap-2"
      >
        <span className="text-base text-fg-3">{STATUS_POST_ROW}</span>
        <span className="text-md text-fg-3">
          {link.kind === 'hidden' ? DRAFT_NOT_READY : POST_NOT_MADE_LABEL}
        </span>
      </div>
    );
  }
  const title = link.info.title !== '' ? link.info.title : PAIR_POST_LABEL;
  return (
    <PressableRow
      type="button"
      data-plan-status-post="linked"
      aria-label={`Open ${title}`}
      onClick={() => props.onOpen(link.postId)}
      className="-mx-2 flex items-center justify-between gap-2 px-2"
    >
      <span className="shrink-0 text-base text-fg-3">{STATUS_POST_ROW}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span data-plan-status-post-title="" className="min-w-0 truncate text-md text-fg">
          {title}
        </span>
        <Tag
          label={postLineLabel(link.stage)}
          {...(isTagDot(link.stage) ? { dot: link.stage } : {})}
          className="shrink-0"
        />
        <span aria-hidden="true" className="shrink-0 text-fg-3">
          <IconChevronRight size={ICON_SIZE.inline} />
        </span>
      </span>
    </PressableRow>
  );
}

/**
 * The agency's link buttons under the status box: "Link a post" on a concept
 * with no link (OK'd or not); with a link, "Change linked post" and "Unlink
 * post". Nothing else ever shows.
 */
export function LinkActions(props: {
  linked: boolean;
  mayLink: boolean;
  busy: boolean;
  onLink: () => void;
  onUnlink: () => void;
}): ReactElement | null {
  if (!props.linked) {
    if (!props.mayLink) return null;
    return (
      <Button
        variant="secondary"
        data-plan-link-post=""
        disabled={props.busy}
        onClick={props.onLink}
        className="w-full md:w-auto"
      >
        <IconLink size={ICON_SIZE.inline} />
        {LINK_POST_LABEL}
      </Button>
    );
  }
  return (
    <div className={cn('grid gap-2', props.mayLink ? 'grid-cols-2' : 'grid-cols-1')}>
      {props.mayLink ? (
        <Button
          variant="ghost"
          data-plan-change-link=""
          disabled={props.busy}
          onClick={props.onLink}
        >
          {CHANGE_LINKED_POST_LABEL}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        data-plan-unlink-post=""
        disabled={props.busy}
        onClick={props.onUnlink}
      >
        {UNLINK_POST_LABEL}
      </Button>
    </div>
  );
}

/**
 * A linked post that is not a post item in the plan, opened from its pair or
 * the concept's Post row: the post view embedded as a post item shows it (its
 * own ⋯ actions, Open in pipeline), headed "Post for this concept".
 */
export function LinkedPostPage(props: {
  open: boolean;
  postId: string;
  subtitle: string;
  onClose: () => void;
  onDismiss?: () => void;
}): ReactElement | null {
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!props.open) setMoreOpen(false);
  }, [props.open]);
  return (
    <PlanPage
      open={props.open}
      testId="linked-post"
      title={PAIR_POST_LABEL}
      subtitle={props.subtitle}
      backLabel="Back to plan"
      onBack={props.onClose}
      desktopBack
      closeLabel="Close plan"
      {...(props.onDismiss !== undefined ? { onDismiss: props.onDismiss } : {})}
      action={
        <ActionMenuTrigger
          type="button"
          data-plan-more=""
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        />
      }
    >
      <Suspense fallback={<Bone lit="flat" as="div" className="m-4 h-44 rounded-lg" />}>
        <PostDetailPage
          postId={props.postId}
          embedded
          onNavigateAway={props.onClose}
          actionsOpen={props.open && moreOpen}
          onActionsOpenChange={setMoreOpen}
        />
      </Suspense>
    </PlanPage>
  );
}

/** The section label style (design rules: sm/600 uppercase, fg-2). */
const SECTION_LABEL = TEXT_ROLE.section;

/**
 * The concept's files: the loading box (its size kept, so nothing jumps), the
 * failed copy with Retry, "No files", or a tile per file (a button: an image
 * opens the gallery of every image at it, any other file the file viewer),
 * each with its name under it.
 */
function ItemMedia(props: {
  read: ReturnType<typeof useScreenRead<ItemScreenData>>['read'];
  onRetry: () => void;
}): ReactElement {
  const { read } = props;
  // The open viewer: an image index in the gallery, or one file.
  const [gallery, setGallery] = useState<number | null>(null);
  const [fileOpen, setFileOpen] = useState<PlanItemFile | null>(null);
  const files = read.status === 'ready' ? read.data.files : [];
  const images = useMemo(() => files.filter(isConceptImage), [files]);
  if (read.status === 'error') {
    return (
      <div data-plan-media="failed" className="flex min-h-18 items-center justify-between gap-3">
        <p className="text-base text-fg-2">{CONCEPT_FILES_READ_FAILED}</p>
        <Button variant="ghost" data-plan-media-retry="" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (read.status !== 'ready') {
    return (
      <div data-plan-media="loading">
        <Bone lit="lit-media" as="div" className="h-44 rounded-lg" />
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div data-plan-media="empty" className="flex min-h-11 items-center text-md text-fg-3">
        No files
      </div>
    );
  }
  const open = (file: PlanItemFile): void => {
    if (isConceptImage(file)) {
      setGallery(
        Math.max(
          0,
          images.findIndex((i) => i.versionId === file.versionId),
        ),
      );
      return;
    }
    setFileOpen(file);
  };
  return (
    <>
      <div data-plan-media="files" className="grid grid-cols-3 gap-2">
        {files.map((file) => {
          const name = conceptFileName(file);
          return (
            <PressableRow
              key={file.versionId}
              type="button"
              data-plan-file={file.versionId}
              data-plan-file-kind={isConceptImage(file) ? 'image' : conceptViewerKind(file)}
              aria-label={`Open ${name}`}
              title={name}
              onClick={() => open(file)}
              className="flex min-w-0 flex-col gap-1"
            >
              <span className="block w-full overflow-hidden rounded-picture bg-panel-2">
                <Thumbnail
                  assetVersionId={file.versionId}
                  cache={sharedCardPresignCache()}
                  presignEnabled={PRESIGN_ENABLED}
                  fallback={{ kind: 'glyph' }}
                  alt=""
                />
              </span>
              <span data-plan-file-name="" className="block w-full truncate text-sm text-fg-3">
                {name}
              </span>
            </PressableRow>
          );
        })}
      </div>
      {gallery !== null && images.length > 0 ? (
        <Suspense fallback={null}>
          <ImageLightbox
            images={images.map((i) => ({ assetId: i.versionId, name: conceptFileName(i) }))}
            index={Math.min(gallery, images.length - 1)}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            onIndexChange={setGallery}
            onClose={() => setGallery(null)}
          />
        </Suspense>
      ) : null}
      {fileOpen !== null ? (
        <Suspense fallback={null}>
          <ConceptFileViewer
            versionId={fileOpen.versionId}
            name={conceptFileName(fileOpen)}
            kind={conceptViewerKind(fileOpen)}
            onClose={() => setFileOpen(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * A post item's plan notes (its plan comments, e.g. a Not OK note) under the
 * embedded post: the "Plan notes" label and the comments as a chat with
 * threads (PlanItemThread). Nothing at all while there are none (or the read
 * has not landed), so nothing shifts above.
 */
function PlanNotes(props: {
  notes: ShownComment[];
  workspaceId: string | null;
  me: string | null;
  replyPrivately: PlanReplyPrivatelyTarget | null;
  linkTo: PlanCommentLinkTarget;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  files: ReadonlyMap<string, CommentFile>;
  threadSubtitle: string;
  replyBox: (root: ShownComment, focus: boolean) => ReactElement;
  canTask: boolean;
  /** The plan item: its New lines. */
  itemId: string;
}): ReactElement | null {
  if (props.notes.length === 0) return null;
  return (
    <section
      data-plan-notes=""
      aria-label={PLAN_NOTES_LABEL}
      className="flex flex-col gap-3 px-4 pb-2 pt-4"
    >
      <h4 className={SECTION_LABEL}>{PLAN_NOTES_LABEL}</h4>
      <PlanItemThread
        comments={props.notes}
        workspaceId={props.workspaceId}
        me={props.me}
        replyPrivately={props.replyPrivately}
        linkTo={props.linkTo}
        onRetry={props.onRetry}
        onDiscard={props.onDiscard}
        files={props.files}
        threadSubtitle={props.threadSubtitle}
        replyBox={props.replyBox}
        canTask={props.canTask}
        unreadItemId={props.itemId}
      />
    </section>
  );
}

/** A comment box's draft key: the item's box, or one thread's reply box. Pure. */
export function commentChannel(itemId: string, rootId: string | null): string {
  return rootId === null ? `plan-comments:${itemId}` : `plan-comment-thread:${rootId}`;
}

/** The tray tiles a plan comment can store (post comments' three). */
const COMMENT_TRAY_TILES = ['photos', 'file', 'assets'] as const;

/**
 * One Plan comment box: chat's Composer as post comments use it (the "+"
 * tray with Photos, File and Assets, no mic, chat's @ picker), with Plan's
 * mention rules on top. Only the agency side can be tagged on a restricted
 * note; when an approver matching the open "@" run is left out, or the text
 * still tags one, MENTION_TEAM_NOTE shows above the box (the draft is read
 * from the Composer's own draft store, no state of its own), and a Send that
 * still tags one puts the text back instead of sending. Pure render plus the
 * draft subscription: no read.
 */
function PlanCommentBox(props: {
  channelId: string;
  placeholder: string;
  restricted: boolean;
  me: string | null;
  members: MentionMember[] | null;
  nameOf: NameOf;
  trayId: string;
  expandTitle: string;
  uploadFile?: AttachmentUploader;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  focusOnMount?: boolean;
  focusForReply?: boolean;
  onSend: (body: string, attachments: MessageAttachment[]) => void;
  /** Put a refused body back in this box. */
  onRestore: (body: string) => void;
}): ReactElement {
  const { channelId } = props;
  const text = useSyncExternalStore(subscribeDrafts, () => draftText(channelId));
  const caret = useSyncExternalStore(subscribeDrafts, () => getDraft(channelId).caret);
  const taggable = useMemo(
    () => taggableMembers(props.members ?? [], props.me, props.restricted),
    [props.members, props.me, props.restricted],
  );
  const open = mentionQuery(text, caret);
  const hidden =
    open !== null && props.members !== null
      ? planPickerRows(props.members, open.query, props.me, props.restricted).hiddenApprovers
      : false;
  const blocked = blockedMentions(text, props.members, props.restricted);
  const note =
    hidden || blocked.length > 0 ? (
      <p
        {...(blocked.length > 0
          ? { 'data-plan-mention-blocked': '' }
          : { 'data-plan-mention-note': '' })}
        role="status"
        className="px-3 text-sm text-warn"
      >
        {MENTION_TEAM_NOTE}
      </p>
    ) : undefined;
  return (
    <Composer
      channelId={channelId}
      disabled={false}
      placeholder={props.placeholder}
      voice={false}
      tray={{ tiles: COMMENT_TRAY_TILES, trayId: props.trayId }}
      viewerUserId={props.me ?? undefined}
      expandTitle={props.expandTitle}
      mentions={{
        members: taggable,
        ready: props.members !== null,
        isGroup: false,
        selfId: props.me,
        nameOf: props.nameOf,
      }}
      {...(props.uploadFile !== undefined ? { uploadFile: props.uploadFile } : {})}
      {...(props.inputRef !== undefined ? { inputRef: props.inputRef } : {})}
      {...(props.focusOnMount !== undefined ? { focusOnMount: props.focusOnMount } : {})}
      {...(props.focusForReply !== undefined ? { focusForReply: props.focusForReply } : {})}
      {...(note !== undefined ? { quoteStrip: note } : {})}
      onSend={(sent, attachments) => {
        const body = sent.trim();
        if (body === '' && attachments.length === 0) return;
        // A restricted note that still tags an approver: the text comes back, nothing sends.
        if (blockedMentions(body, props.members, props.restricted).length > 0) {
          props.onRestore(body);
          return;
        }
        props.onSend(body, attachments);
      }}
    />
  );
}

/** The most a linked comment waits for the item page's slide in to come to rest. */
const SLIDE_SETTLE_MS = DUR_SLOW_MS * 4;

/** How long a deep-linked comment stays highlighted. */
const HIGHLIGHT_MS = 2400;
