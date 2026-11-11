import { mark } from '@/lib/perf-marks';
import { stripFormat } from '@srtdio/comments';
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { useUndoableAction, type UndoableAction } from '@/lib/use-undoable-action';
import {
  OLDER_LOAD_FAILED,
  channelOlderKey,
  threadOlderKey,
  useOlderPageFailed,
} from '@/lib/chat/older-page-status';
import { ThreadHoldTip } from '@/components/chat/ThreadHoldTip';
import { flushSync } from 'react-dom';
import { isNearBottom } from '@/lib/chat/scroll';
import { centreDelta, holdActive, JUMP_HOLD_MS, recentreNeeded } from '@/components/chat/jump-hold';
import { isFormerMember, resolveMentionText, type MentionMember } from '@/lib/chat/mentions';
import { logger } from '@/lib/logger';
import { insertedInside } from '@/lib/chat/catch-up';
import {
  centreOn,
  createIdCallbacks,
  createStableCache,
  cropToWindow,
  extendDown,
  extendUp,
  isLive,
  isMounted,
  latestWindow,
  MAX_MOUNTED,
  STEP,
  trimWindow,
  useOptionalCallback,
  useStableCallback,
  useThreadWindow,
  windowEdge,
} from '@/lib/chat/thread-window';
import {
  distanceFromBottom,
  anchorAfterOlderLoad,
  flickInProgress,
  intentAfterNewest,
  intentAfterScroll,
  isScrollKey,
  listenTouchEnd,
  newRowsAction,
  openingIntent,
  sentFromThisDevice,
  SCROLL_SETTLE_MS,
  settleDecision,
  sizeChangeAction,
  type ScrollSource,
} from '@/lib/chat/stick-to-bottom';
import { currentOrigin } from '@/lib/chat/message-links';
import { bodyLinkClass, markSearchWords, renderMessageBody } from '@/components/chat/message-body';
import { Avatar } from '@/components/ui/Avatar';
import { LANE_BOTTOM_CLEAR, LANE_TOP_CLEAR } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { ICON_SIZE, IconChat, IconChevronLeft, IconInfo } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import {
  cancelPendingLongPressesWithin,
  LONG_PRESS_MS,
  MOVE_CANCEL_PX,
} from '@/components/ui/useLongPress';
import { useToast } from '@/components/ui/toast';
import {
  deleteChoices,
  deleteConfirmCopy,
  purgeChatFiles,
  selectionDeleteChoices,
  type PurgeChatOutcome,
} from '@/lib/chat/delete-flow';
import { useDeleteForMe } from '@/lib/chat/use-delete-for-me';
import { DeleteSheet } from '@/components/chat/DeleteSheet';
import { cn } from '@/lib/cn';
import { useCoarsePointer, useHoverPointer, usePrefersReducedMotion } from '@/lib/use-is-laptop';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import { replyPreview, targetFromSummary, type ThreadMessage } from '@/lib/chat/thread';
import { splitAlbum, type ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import {
  canOfferTranscribe,
  transcribeVoiceNote,
  useVoiceRecord,
} from '@/lib/chat/transcript-store';
import { formatAgo, rowWhen, threadWhen } from '@/lib/time';
import { getDraft, setDraft, strippedReply, type DraftReply } from '@/lib/chat/drafts';
import {
  HEADER_LINE_TYPE,
  HEADER_NAME_TYPE,
  HEADER_PAD,
  NO_TOUCH_SELECT,
  sized,
  TYPING_ROW_TYPE,
  useChatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';
import { createSwipeReplyController, type SwipeReplyController } from '@/lib/chat/swipe-reply';
import type { PresignCache } from '@/lib/asset-presign';
import { Bone, itemIn, pop, useFreshKeys } from '@/lib/motion';
import { freshTailIds } from '@/lib/chat/fresh-tail';
import { roleLabel } from '@/components/pages/settings/members-data';
import {
  Composer,
  focusComposerInput,
  type ComposerInput,
  type ComposerProps,
  type ComposerSend,
  type EditingDraft,
} from '@/components/chat/Composer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import {
  ImageLightbox,
  type LightboxDetails,
  type LightboxImage,
} from '@/components/ui/ImageLightbox';
import { ThreadViewFill, ThreadViewFrame } from '@/components/chat/ThreadView';
import { dismissHoldTip } from '@/lib/chat/thread-tip';
import { ThreadsSheet } from '@/components/chat/ThreadsSheet';
import {
  RepliesRow,
  RepliesSeparatorRow,
  ThreadChipRow,
  type RootActions,
} from '@/components/chat/ThreadRail';
import { useChipBatch, type PostRefPost } from '@/components/chat/PostRefChip';
import {
  MessageActionMenu,
  isIdeaMessage,
  isPlanMessage,
  ownMessageActions,
  selectionForwardable,
  scheduleWindowBoundary,
} from '@/components/chat/MessageActionMenu';
import { useCancelUpload, useChatStore, useServerNow } from '@/components/chat/ChatStoreProvider';
import { ideaCardStore, ideaTitleOf } from '@/components/chat/PlanItemCard';
import { useSharedCardCache, type ThreadCardCache } from '@/components/chat/PostCard';
import { PaintLogOverlay, paintLog, paintLogOn } from '@/components/chat/PaintLog';
import { planTitleOf, usePlanCards } from '@/components/chat/PlanCardsProvider';
import { ChatStatus, ThreadsStripItem } from '@/components/chat/StatusTicker';
import { planProgress, todayInZone } from '@/components/chat/plan-card';
import { briefRoute } from '@/lib/chat/briefs';
import { useOpenPosts, type UseOpenPosts } from '@/lib/chat/use-open-posts';
import {
  peekStatusRound,
  useStatusCounts,
  type UseStatusCounts,
} from '@/lib/chat/use-status-counts';
import { chatKey, openCache, OPEN_HOLD_MS } from '@/lib/chat/open-cache';
import { notePlanShapes, planCardsSized } from '@/lib/chat/plan-shapes';
import type { PlanBundle } from '@/lib/chat/plans';
import {
  currentSharedPlans,
  drawerKeys,
  openPostsHeading,
  openTasksOf,
  planSummaries,
  statusBar,
  statusReady,
  type StatusBar,
  type StatusInput,
} from '@/lib/chat/status-bar';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { ContactSheet } from '@/components/chat/ContactSheet';
import type { GroupInfoTabsWiring } from '@/components/chat/GroupInfoSheet';
import { SelectionBar, SelectionHeader, deleteOneConfirm } from '@/components/chat/SelectionBar';
import {
  canReplyPrivatelyInChat,
  chatPrivateReplyDraft,
  privateReplyHref,
  type PrivateReply,
  type PrivateReplyDraft,
} from '@/lib/chat/private-reply';
import { ForwardPicker, type ForwardSendResult } from '@/components/chat/ForwardPicker';
import { TaskEventLine, type TaskLineContext } from '@/components/chat/tasks/TaskEventLine';
import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import { useChatTasks } from '@/components/chat/tasks/useChatTasks';
import {
  eventsInWindow,
  hasUnseenChanges,
  readTasksSeen,
  shareSnapshot,
  tasksSeenKey,
  writeTasksSeen,
  TASK_TITLE_MAX,
  type TaskEvent,
} from '@/lib/chat/tasks';
import { NotesAvatar, useSavedFrom } from '@/components/chat/NotesBits';
import { canSaveToNotes, NOTES_PLACEHOLDER, NOTES_TILE_LINE } from '@/lib/chat/notes';
import {
  BURIED_STEPS_LIMIT,
  buriedStepCount,
  enterHistoryStep,
  HISTORY_STEP_KEYS,
  resetHistorySteps,
  useHistoryStep,
  type HistoryStepWindow,
} from '@/lib/chat/use-history-step';
import {
  canForward,
  clearSelectionLeave,
  deleteSelectionBlock,
  pruneThreadSelection,
  scheduleSelectionBoundary,
  selectedForForward,
  threadSelectable,
  threadSelectionRole,
  toggleSelected,
} from '@/lib/chat/forward';
import type { FindOlderOutcome } from '@/lib/chat/use-chat-thread';
import {
  aboutState,
  PAGE_HYDRATION_WAIT_MS,
  admitRows,
  chipPostIds,
  chipTargetFor,
  createCardExpectation,
  holdingFirstPage,
  hydrationDeadline,
  newestCardFor,
  parentIndexOf,
  rowReady,
  type PageGate,
} from '@/lib/chat/post-refs';
import {
  NO_RAIL,
  awaitsRootHydration,
  createThreadCounts,
  freezeMemberships,
  isRootCard,
  localReplyCounts,
  rootCardOf,
  THREAD_TITLE,
  threadTitleOf,
  type RootCardTitles,
  membershipOf,
  pageCountRoots,
  railPlans,
  renderedMembership,
  replyCountLabel,
  rootCardPost,
  rowGeometry,
  threadReplyCount,
  withThreadRoot,
  type MembershipMap,
  type ThreadCounts,
  type RailItem,
  type RailPlan,
  type ThreadMembership,
} from '@/lib/chat/thread-rail';
import { loadThreadReplyCounts } from '@/lib/chat/history';
import { threadViewRows, useThreadView } from '@/lib/chat/use-thread-view';
import {
  chatOpenTarget,
  firstUnreadReply,
  isTopLevel,
  threadsStripLabel,
  loadThreadsForMe,
  localThreadReadAt,
  mainChatMessages,
  rememberThreadRead,
  repliesInfoByRoot,
  repliesLabel,
  markChatUnread,
  markThreadUnread,
  setThreadRead,
  threadRootOf,
  withThreadRead,
  withThreadUnread,
  type ThreadForMe,
} from '@/lib/chat/thread-signals';
import { applyEdit, applyReactionOp, markMessagesDeleted } from '@/lib/chat/thread';
import { generateTraceId } from '@/lib/trace';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import {
  glowTarget,
  highlightNodes,
  JUMP_SETTLE_MS,
  SearchWordsContext,
} from '@/components/ui/SearchHighlight';
import type { ThreadReadState } from '@/lib/chat/use-chat-thread';
import {
  firstUnread,
  readByLabel,
  readByTarget,
  readersOf,
  seenLineTarget,
  type FirstUnread,
} from '@/lib/chat/read-receipts';
import {
  defaultWhoReactedLoad,
  LatestButton,
  MessageInfoSheet,
  ReadByLine,
  SeenLine,
  UnreadDivider,
  UnreadPill,
  WhoReactedSheet,
  type WhoReactedLoad,
} from '@/components/chat/ReadingLayer';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import {
  applyRemovedOverlay,
  createRemovedFilesStore,
  canRemoveFile,
  canRemoveSingleFile,
  removeMediaAria,
  removedCountsOf,
  removedFilesLabel,
  removedFilesStore,
  rereadRemovedRows,
  runRemoveFiles,
  subscribeFilesRemoved,
  type RemovableFile,
  type RemoveFilesOutcome,
} from '@/lib/chat/remove-files';
import { useChat } from '@/lib/chat/chat-context';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import type { ChatConnection } from '@/lib/chat/types';
import { errorText } from '@/lib/error-copy';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import {
  type BubblePointerHandlers,
  type BubbleSwipe,
  paintRowSwipe,
  rowSwipeCanTrigger,
  isTranscribable,
  isVoiceOnly,
  type BubbleChip,
  type BubblePostRefs,
  type RowSelection,
  senderName,
  messageTimeSource,
  type BubbleMeta,
  canDiscardFailed,
  preventDefault,
  type BubbleMentions,
  MENTION_ME_PEER,
  profileNameOf,
  isLinkTarget,
  type RowRail,
  MessageBubble,
  type ThreadRow,
  threadRows,
  type RowHold,
  createRowHold,
  DateLine,
} from '@/components/chat/MessageBubble';

// MessageBubble and its pieces live in MessageBubble.tsx; re-exported here so
// every importer keeps its path.

/** No plan card cache (outside a chat): nothing to subscribe to. */
const noCardSubscribe = (): (() => void) => () => {};
const noCardVersion = (): number => 0;

/**
 * The card titles the device already holds, by kind: posts from the chip
 * batch, briefs from the chat's card cache, plans from the plan card cache,
 * plan items (concepts, bank ideas) from the idea card store. Lookups only,
 * never a read. Pure over its inputs.
 */
export function heldCardTitles(
  postTitle: (id: string) => string | null,
  briefs: ThreadCardCache | null,
  plans: ReturnType<typeof usePlanCards>,
): RootCardTitles {
  return {
    post: postTitle,
    brief: (id) => briefs?.briefs([id]).briefs.find((b) => b.id === id)?.title ?? null,
    plan: (id) => planTitleOf(plans, { sharedPlanIds: [id] }),
    item: (id) => ideaTitleOf({ sharedPlanItemIds: [id] }),
  };
}

/**
 * The thread screen's frame titled by its root card (threadTitleOf) over the
 * chat's name. It alone subscribes to the plan, brief and idea card caches,
 * so a title landing re-renders the header, never the chat; the list and
 * composer are the caller's children (same elements, no re-render).
 */
function ThreadViewTitled(props: {
  root: ThreadMessage | undefined;
  postTitle: (id: string) => string | null;
  subtitle: string;
  selecting: boolean;
  onClosed: () => void;
  behindRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactElement {
  const plans = usePlanCards();
  useSyncExternalStore(
    plans?.cache.subscribe ?? noCardSubscribe,
    plans?.cache.version ?? noCardVersion,
  );
  const briefs = useSharedCardCache();
  const ideas = ideaCardStore();
  useSyncExternalStore(ideas.subscribe, ideas.version, ideas.version);
  const title = threadTitleOf(props.root, heldCardTitles(props.postTitle, briefs, plans));
  return (
    <ThreadViewFrame
      title={title}
      subtitle={props.subtitle}
      selecting={props.selecting}
      onClosed={props.onClosed}
      behindRef={props.behindRef}
    >
      {props.children}
    </ThreadViewFrame>
  );
}

export {
  type BubblePointerHandlers,
  type BubbleSwipe,
  SWIPE_ROW_TOUCH,
  SwipeReplyIcon,
  SwipeDeleteIcon,
  paintRowSwipe,
  rowSwipeCanTrigger,
  keyOpensMenu,
  isTranscribable,
  isVoiceOnly,
  SELECTING_TEXT_BODY,
  hasAlbum,
  cardRefsFor,
  type RowSelection,
  metaIsEmpty,
  bodyMetaOf,
  messageTimeSource,
  bubbleTimeLabel,
  EDITED_LABEL,
  bubbleStatus,
  bubbleMeta,
  metaTick,
  MetaGlyph,
  BubbleMetaView,
  MetaSpacer,
  FailedLine,
  canDiscardFailed,
  canRetryFailed,
  FailedActions,
  bubbleCorners,
  bubbleClass,
  tombstoneClass,
  DELETE_FOR_ME_ROW,
  SELECTION_ROW_OFFSET,
  SELECTED_ROW_TINT,
  type BubbleMentions,
  mentionsMe,
  MENTION_ME_PEER,
  mentionClass,
  profileNameOf,
  renderBodyWithMentions,
  isLinkTarget,
  bodyText,
  metaPlacement,
  lastCardKind,
  isCardOnly,
  FAILED_RETRY_CLASS,
  type RowRail,
  railRowClass,
  MessageBubble,
  ForwardedLabel,
  type ThreadRow,
  threadRows,
  type RowHold,
  createRowHold,
  DateLine,
} from '@/components/chat/MessageBubble';

interface MessageThreadProps {
  title: string;
  /** The open channel; a DM's header opens the Contact sheet over its reads. */
  channelId?: string;
  /** Header avatar src (the DM peer's); absent or null falls back to initials. */
  avatarUrl?: string | null;
  /** The workspace name, the tail of a DM header's resting second line. */
  subtitle?: string;
  /** The DM peer's raw workspace role; labelled via roleLabel, null when unknown. */
  role?: string | null;
  /** Sender display info keyed by Sorted user id; batched read, never per-row. */
  profiles: Map<string, ChatProfile>;
  messages: ThreadMessage[];
  /** A thread root's created_at when read (the reply counts read's lower bound); absent: unbounded. */
  rootCreatedAt?: (rootId: string) => string | undefined;
  loading: boolean;
  /** The latest page failed or timed out: "Couldn't load messages" + Retry, never the empty state. */
  loadFailed?: boolean;
  /** Re-run the latest-page load (the failed state's Retry). */
  onRetryLoad?: () => void;
  /** An older page is loading (scroll-to-top); renders a slim row at the top. */
  loadingOlder?: boolean;
  /** Whether scrolling to the top should request an older page. */
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** The newest message is on screen; the thread advances the read cursor. */
  onNewestVisible?: () => void;
  /**
   * The workspace IANA zone the plan logic reads "today" on (the status
   * ticker's current plans). Visible times read the viewer's device clock.
   */
  timeZone: string;
  /** False when sending is impossible (no channel selected). */
  canSend: boolean;
  onSend: ComposerSend;
  /**
   * The chat page's per-chat wiring (the status strip, its reads and tasks);
   * absent in Personal notes and bare renders.
   */
  chatPage?: boolean;
  /** The caller's user id; the pin board names their own stamps "You". */
  currentUserId?: string;
  /** Delete own messages for everyone; absent hides "Select". */
  onDeleteMessages?: (
    messageIds: readonly string[],
    /** The chat the ids belong to (a delete committed after its Undo window). */
    channelId?: string,
  ) => Promise<{ ok: true; toast?: string } | { ok: false; message: string }>;
  /**
   * Edit the body of an own message; absent hides "Edit". Resolves ok, or the
   * mapped failure copy ("Edit window has closed (15 min)", ...).
   */
  onEditMessage?: (
    messageId: string,
    body: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Load older pages until a message is present (jump-to). */
  onEnsureLoaded?: (messageId: string) => Promise<FindOlderOutcome>;
  /**
   * Re-run a failed send with the same message id; on a send whose files were
   * lost to a reload it is the Remove (the thread drops the entry).
   */
  onRetry?: (messageId: string) => void;
  /**
   * Delete a failed own send (never recorded): it leaves this device's outbox
   * and the thread. Defaults to the chat store's outbox for this channel when
   * a provider is present.
   */
  onDiscard?: (messageId: string) => void;
  /**
   * The stop square on an own uploading send: cancel it (its bubble goes). Defaults to
   * the chat store's outbox for this channel when a provider is present.
   */
  onCancelUpload?: (messageId: string) => void;
  /** Present on small screens only; renders a back affordance to the list. */
  onBack?: () => void;
  /** Present for group channels only; opens the group management panel. */
  onOpenInfo?: () => void;
  /**
   * Group channels only: renders the group info page with the chat info tabs
   * wiring this thread holds (the same values the DM Contact page receives).
   */
  renderGroupInfo?: (tabs: GroupInfoTabsWiring) => ReactNode;
  /** True for group channels; drives per-run avatars and sender names. Absent = DM. */
  isGroup?: boolean;
  /** Sorted user ids currently typing (peers only); drives the indicator row. */
  typingUserIds: string[];
  /** Forwarded to the composer so each keystroke broadcasts a typing signal. */
  onTyping?: () => void;
  /** DM peer presence; absent for groups. Drives only the online dot on the header photo. */
  presence?: { online: boolean; lastTimeMs: number | null; available: boolean };
  /** True only for DM threads; gates seen ticks on own bubbles. */
  showTicks?: boolean;
  /** Add or remove the current user's reaction on a message. */
  onToggleReaction?: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  /** Chats the forward picker lists (every chat the caller is in); absent hides Forward. */
  forwardChannels?: readonly ChannelSummary[];
  /** Forward messages to chats; absent hides Forward. */
  onForward?: (
    messages: readonly ThreadMessage[],
    targets: ChannelSummary[],
  ) => Promise<ForwardSendResult>;
  /**
   * The @ picker's people for this chat (never the viewer); absent turns @ off.
   * Null while they load: the composer keeps a stored body's tokens untouched.
   */
  mentionMembers?: readonly MentionMember[] | null;
  /**
   * Whether this chat has a client among its other active members; null or
   * absent while unknown. Passed to the composer only (the Draft tile and the
   * hash picker's drafts).
   */
  channelHasClient?: boolean | null;
  /**
   * The main composer's Plan tile: opens "Share a plan" with the plans this
   * chat already holds a card for (loaded thread and ticker). Absent: the tile stays off.
   */
  onOpenPlanCompose?: (inChatPlanIds: readonly string[]) => void;
  /** In-app navigation for the status drawer (a brief, the Briefs page). */
  onNavigate?: (to: string) => void;
  /** The router location key: the status drawer restores only on a Back to it. */
  locationKey?: string;
  /** The status drawer's plan item rows: open the Plan screen at that item. */
  onOpenPlanItem?: (request: { planId: string; senderName: string; itemId: string }) => void;
  /**
   * True for a stored mention's person a successful member read confirmed has
   * left; only those drop from a restored draft or an edit. Absent: none.
   */
  mentionGone?: (userId: string) => boolean;
  /** Bubble @mentions: a tap opens the shared person card for that person. */
  mentions?: BubbleMentions;
  /** Open with this message in view (an Activity mention); a miss toasts, the chat stays at the bottom. */
  initialMessageId?: string | null;
  /** Open with the task sheet up and this item expanded (a bell task row); null: none. */
  initialTaskId?: string | null;
  /** The thread took initialTaskId (the sheet opened): the caller drops it. */
  onInitialTaskTaken?: () => void;
  /**
   * "Go to card" from the Plan screen: scroll to this plan card message and
   * highlight it briefly; each new seq jumps again.
   */
  cardJump?: { messageId: string; seq: number } | null;
  /** The thread took initialMessageId (its jump runs, found or miss): the caller drops it. */
  onInitialJumpTaken?: () => void;
  /**
   * A jump to a message (a search hit, a link, Show in chat): the jump and its
   * highlight. seq makes a repeat in the same chat run again.
   */
  searchRequest?: {
    messageId: string;
    seq: number;
    /** A search jump: a message that is gone opens the chat with no toast. */
    quiet?: boolean;
  } | null;
  /** The thread took searchRequest: the caller drops it. */
  onSearchRequestTaken?: () => void;
  /**
   * A search jump's words (the palette): marked in the bubbles and the header's
   * name until the chat closes. Taken once on mount.
   */
  initialSearchWords?: readonly string[] | null;
  /** The thread took initialSearchWords: the caller drops them. */
  onInitialSearchWordsTaken?: () => void;
  /** The channel's read cursors (Seen, Read by, the unread divider); absent: none of them. */
  readState?: ThreadReadState;
  /** The DM peer whose cursor drives the Seen line; absent or null for groups. */
  peerUserId?: string | null;
  /** The chat list's unread count when this chat opened (the pill's count past loaded history). */
  unreadAtOpen?: number;
  /** Who-reacted reader; defaults to Supabase. */
  loadReactors?: WhoReactedLoad;
  /**
   * Personal notes: the notes header (not tappable, no second line), Delete
   * with no window, the "Note" placeholder, and no "Save to notes".
   */
  notes?: boolean;
  /** Menu "Save to notes" in any other chat; absent hides it. */
  onSaveToNotes?: (message: ThreadMessage) => void;
  /**
   * Group chats: menu "Reply privately" on someone else's message opens my DM
   * with them carrying this quote (use-open-person-dm); absent hides the row.
   */
  onReplyPrivately?: (senderUserId: string, quote: PrivateReplyDraft) => void;
}

/**
 * The long-press menu's Delete rule for one live message: an own message in
 * its window (any age in Personal notes) deletes for everyone; Delete for me
 * is offered on any sent, live message outside Personal notes where the chat
 * has it. `forMeOnly`: the sheet shows only "Delete for me". Pure; the menu
 * and the row's left swipe both read it.
 */
export function messageDeleteOffer(input: {
  message: Pick<ThreadMessage, 'mine' | 'state' | 'createdAt' | 'body' | 'deleted'>;
  nowMs: number;
  notes: boolean;
  canDeleteForMe: boolean;
}): { canDelete: boolean; forMeOnly: boolean } {
  const own = ownMessageActions(input.message, input.nowMs, input.notes);
  const forMe =
    input.canDeleteForMe &&
    !input.notes &&
    input.message.state === 'sent' &&
    input.message.deleted !== true;
  return { canDelete: own.canDelete || forMe, forMeOnly: forMe && !own.canDelete };
}

/**
 * What sits under the thread header: the status strip (the chat page's
 * threads, not while selecting), else nothing.
 */
export function threadStripSlot(input: { chatPage: boolean; selecting: boolean }): 'loops' | null {
  return input.chatPage && !input.selecting ? 'loops' : null;
}

/**
 * The status ticker's bar: null (the inert empty slot) until the posts round,
 * the viewer side, the shared plans and the open briefs
 * have all settled, so the first painted bar is final; then each read that
 * failed is left out (null) and the rest are counted. `open` are the
 * workspace's current shared plans, ending soonest first.
 */
export function tickerBar(input: {
  openPosts: Pick<UseOpenPosts, 'ready' | 'count' | 'failed'>;
  side: { side: ViewerSide; ready: boolean };
  status: UseStatusCounts;
  open: readonly PlanBundle[];
  /**
   * This chat's open tasks, from the list the thread already holds (no read
   * of its own); null while that list is not in (its item then waits, and
   * the bar never says nothing is open).
   */
  openTasks: number | null;
}): StatusBar | null {
  const ready = statusReady({
    posts: input.openPosts.ready,
    side: input.side.ready,
    plans: input.status.plans.ready,
    briefs: input.status.briefs.ready,
  });
  if (!ready) return null;
  const counts: StatusInput = {
    plans: input.status.plans.failed ? null : planSummaries(input.open, planProgress),
    posts: input.openPosts.failed ? null : input.openPosts.count,
    briefs: input.status.briefs.failed ? null : input.status.briefs.count,
    tasks: input.openTasks,
    side: input.side.side,
  };
  return statusBar(counts);
}

/**
 * Whether a chat open's parts that paint with its first page have settled:
 * the viewer side, the ticker's inputs and the bundles of the plan cards on
 * the page (each ok or failed). Pure.
 */
export function openHoldSettled(parts: {
  side: boolean;
  ticker: boolean;
  cards: boolean;
}): boolean {
  // Task lines are not a part: rows paint first and the lines slot in when
  // their read lands (the list may shift once; the bottom pin holds).
  return parts.side && parts.ticker && parts.cards;
}

/**
 * Whether the open hold keeps the first page off screen now, until the hold
 * is done (released or capped). A cold open holds until all its parts settle.
 * A kept open (the chat's page was remembered: opened before or pre-warmed)
 * holds only for the parts that would move its rows when they land
 * (`keptPartsSettled`: plan cards of unknown shape); with those
 * in hand its rows are the first frame. Pure.
 */
export function openHoldApplies(input: {
  keptOpen: boolean;
  holdDone: boolean;
  partsSettled: boolean;
  keptPartsSettled: boolean;
}): boolean {
  if (input.holdDone) return false;
  return input.keptOpen ? !input.keptPartsSettled : !input.partsSettled;
}

/**
 * The jump pill's next state, or null to leave it. Decided once the first
 * unread is known and the open pin has landed: while the list still means to
 * stick to the bottom but is not there yet (the pin is pending), the divider's
 * place is not final, so nothing settles; the pin's own scroll event asks
 * again. Pure.
 */
export function nextPill(input: {
  pill: 'unknown' | 'show' | 'done';
  unread: { kind: 'loaded' | 'beyond' } | null | undefined;
  where: 'above' | 'visible' | 'below' | 'missing';
  pinPending: boolean;
}): 'show' | 'done' | null {
  const { pill, unread, where } = input;
  if (pill === 'done' || unread === undefined) return null;
  if (unread === null) return 'done';
  if (input.pinPending) return null;
  if (where === 'visible') return 'done';
  if (pill === 'show') return null;
  if (unread.kind === 'beyond') return 'show';
  if (where === 'above') return 'show';
  if (where === 'below') return 'done';
  return null;
}

/** How long a page row waits for its task lines before it paints without them. */
export const TASK_LINES_WAIT_MS = 2_000;

/**
 * Whether a page row's task lines are in (every change at or after its time
 * is read), or its wait ran out. Pure.
 */
export function taskLinesReady(
  rowTime: number,
  since: number,
  nowMs: number,
  covers: (ms: number) => boolean,
): boolean {
  if (!(rowTime > 0) || covers(rowTime)) return true;
  return nowMs - since >= TASK_LINES_WAIT_MS;
}

/**
 * Each voice-only message's auto-play successor: the message directly below it
 * when that is also a live voice-only note from the same sender. One pass.
 */
export function nextVoiceIds(messages: readonly ThreadMessage[]): Map<string, string> {
  const next = new Map<string, string>();
  for (let i = 0; i + 1 < messages.length; i += 1) {
    const here = messages[i];
    const below = messages[i + 1];
    if (here === undefined || below === undefined) continue;
    if (here.deleted === true || below.deleted === true) continue;
    if (!isVoiceOnly(here) || !isVoiceOnly(below)) continue;
    if (here.senderUserId === null || here.senderUserId !== below.senderUserId) continue;
    next.set(here.id, below.id);
  }
  return next;
}

/** Whether the menu may offer "Transcribe": a recorded message whose one attachment is audio. */
/** L12: the longest task title a message gives (the spec's 280, capped by the table's 200). */
export const TASK_FROM_MESSAGE_MAX = Math.min(280, TASK_TITLE_MAX);

/**
 * L12: a task's title from a message: its text (format stripped, first 280
 * characters, capped by the table's limit); a file-only message uses the file
 * name; empty when it has neither. Pure.
 */
export function taskTitleOf(message: Pick<ThreadMessage, 'body' | 'attachments'>): string {
  const text = stripFormat(message.body).replace(/\s+/g, ' ').trim();
  if (text !== '') return text.slice(0, TASK_FROM_MESSAGE_MAX).trim();
  const file = message.attachments[0];
  const name = file !== undefined ? file.name.trim() : '';
  return name.slice(0, TASK_FROM_MESSAGE_MAX);
}

/**
 * Whether the menu offers "Select" (select part of the body text in place): a
 * recorded, live message with a typed body (plain, reply, forwarded, or a
 * caption on media or cards), never a voice note alone. Pure.
 */
export function canSelectMessageText(
  message: Pick<
    ThreadMessage,
    'state' | 'deleted' | 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'
  >,
): boolean {
  return (
    message.state === 'sent' &&
    message.deleted !== true &&
    message.body.trim() !== '' &&
    !isVoiceOnly(message)
  );
}

/** Back leaves text selection first (its own history step). */
export const SELECT_TEXT_HISTORY_KEY = 'chatSelectText';

/**
 * Select a bubble's whole body text (the displayed text: mentions read
 * "@Name"; the invisible meta spacer is left out). Runs inside the user's tap
 * so iOS shows the handles. Returns whether a range was set.
 */
export function selectBodyText(body: Element): boolean {
  const doc = body.ownerDocument;
  const selection = doc.getSelection();
  if (selection === null) return false;
  const range = doc.createRange();
  range.selectNodeContents(body);
  const spacer = body.querySelector(':scope > [data-meta-spacer]');
  if (spacer !== null) range.setEndBefore(spacer);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Drop the document selection when it sits in the selecting body (or the body
 * is gone): a caret in the composer is never touched.
 */
export function clearBodySelection(body: Element | null): void {
  const selection = body?.ownerDocument.getSelection() ?? document.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const at = selection.anchorNode;
  if (body === null || at === null || !at.isConnected || body.contains(at)) {
    selection.removeAllRanges();
  }
}

/**
 * How far around the selecting body a touch still counts as on it: the iOS
 * drag handles (and their knobs) reach past the text into the bubble's
 * padding and below the last line.
 */
export const SELECT_TEXT_HANDLE_SLOP_PX = 24;

/** A press that moves further than this is a drag (a handle, a scroll), never a tap. */
export const SELECT_TEXT_TAP_MOVE_PX = 10;

/**
 * Whether a finished press ends text selection: only a tap (released within
 * SELECT_TEXT_TAP_MOVE_PX of where it went down) that went down clearly
 * outside the body (beyond SELECT_TEXT_HANDLE_SLOP_PX). Dragging a handle,
 * scrolling, or a press the browser cancelled (a native handle drag) never
 * ends it. Pure.
 */
export function tapEndsTextSelect(input: {
  down: { x: number; y: number };
  up: { x: number; y: number };
  body: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
}): boolean {
  const { down, up, body } = input;
  if (Math.hypot(up.x - down.x, up.y - down.y) > SELECT_TEXT_TAP_MOVE_PX) return false;
  const slop = SELECT_TEXT_HANDLE_SLOP_PX;
  const near =
    down.x >= body.left - slop &&
    down.x <= body.right + slop &&
    down.y >= body.top - slop &&
    down.y <= body.bottom + slop;
  return !near;
}

/** Whether an element has scrolled fully out of the list's visible box. */
export function outOfView(
  el: Pick<DOMRect, 'top' | 'bottom'>,
  list: Pick<DOMRect, 'top' | 'bottom'>,
): boolean {
  return el.bottom <= list.top || el.top >= list.bottom;
}

/**
 * What the thread's one image viewer shows for a message: its album images (a
 * local preview stands in for an own instant send still uploading), plus the
 * bottom bar's sender and when it was sent, short (formatAgo: "just now",
 * "5m", "Yesterday", "Mon"; relative to `now`).
 * Pure.
 */
export function threadLightbox(
  message: ThreadMessage,
  profiles: Map<string, ChatProfile>,
  now: Date = new Date(),
): { images: LightboxImage[]; details: LightboxDetails } {
  const images = splitAlbum(message.attachments).images.map((a) => {
    const src = a.local?.previewUrl;
    return { assetId: a.assetId, name: a.name, ...(src != null ? { src } : {}) };
  });
  return {
    images,
    details: {
      sender: senderName(message, profiles),
      time: formatAgo(messageTimeSource(message), now),
    },
  };
}

/**
 * The viewer's images with the bin on each one the viewer may remove (own,
 * recorded; canRemoveFile): its label reads "Remove photo" and its
 * tap removes just that file. Unchanged without a remove handler. Pure.
 */
export function withRemovableImages(
  data: { images: LightboxImage[]; details: LightboxDetails },
  message: ThreadMessage,
  onRemoveFiles: ((files: RemovableFile[]) => void) | undefined,
  viewerId: string,
): { images: LightboxImage[]; details: LightboxDetails } {
  if (onRemoveFiles === undefined || message.state !== 'sent') return data;
  const byAsset = new Map(message.attachments.map((a) => [a.assetId, a] as const));
  return {
    ...data,
    images: data.images.map((image) => {
      const attachment = byAsset.get(image.assetId);
      if (attachment === undefined || !canRemoveFile(message, attachment, viewerId)) {
        return image;
      }
      return {
        ...image,
        removeLabel: removeMediaAria(attachment.mime),
        onRemove: () =>
          onRemoveFiles([
            { messageId: message.id, assetId: attachment.assetId, mime: attachment.mime },
          ]),
      };
    }),
  };
}

/**
 * Decision 128: a Reply (menu, swipe, laptop chevron, right-click) focuses the
 * composer first, synchronously inside the same user event (iOS WebKit opens
 * the keyboard only then), and only then sets the reply. Pure.
 */
export function replyWithFocus<T>(
  input: () => ComposerInput | null,
  setReply: (target: T) => void,
): (target: T) => void {
  return (target) => {
    focusComposerInput(input());
    setReply(target);
  };
}

/** The chip for a message, from its target and the batch lookup; undefined keeps the quote. */
export function bubbleChip(
  target: { postId: string; cardMessageId: string } | null,
  post: PostRefPost | null | undefined,
  context: {
    onOpenCard: (cardMessageId: string) => void;
  },
): BubbleChip | undefined {
  if (target === null || post == null) return undefined;
  return {
    kind: 'chip',
    post,
    onTap: () => context.onOpenCard(target.cardMessageId),
  };
}

/** Toast when the About post turns out not to be readable here. */
export const ABOUT_UNAVAILABLE_TOAST = 'That post is not available here';

/** Toast when a share cannot be sent (no open conversation). */
export const SHARE_UNAVAILABLE_TOAST = errorText('share', null);

/** Toast when a thread's root or first page cannot be read; the chat stays as it is. */
let tipOpens = 0;
const nextTipOpenSeq = (): number => ++tipOpens;
const THREAD_OPEN_FAILED_TOAST = errorText('open this thread', null);

/** The thread view composer's placeholder. */
/** L4: the thread composer's hint. */
export const THREAD_REPLY_PLACEHOLDER = 'Reply';

/**
 * The About reply a send may carry: only while the About bar shows its post.
 * Pending (the read is in flight) or gone (RLS, failed read) carries none.
 */
export function aboutReplyFor(
  about: { cardMessageId: string } | null,
  post: PostRefPost | null | undefined,
  card: ThreadMessage | undefined,
): ReplyQuote | null {
  return aboutState(post) === 'visible' ? aboutQuote(about, card) : null;
}

/**
 * The reply quote the About card stands for in a send: the card message's
 * sender and preview when it is loaded, else a generic card label.
 */
export function aboutQuote(
  about: { cardMessageId: string } | null,
  card: ThreadMessage | undefined,
): ReplyQuote | null {
  if (about === null) return null;
  return {
    id: about.cardMessageId,
    authorUserId: card?.senderUserId ?? null,
    preview: card !== undefined ? replyPreview(card) : 'Shared post',
  };
}

/** Scroll positions within this many px of the top request the older page. */
const LOAD_OLDER_THRESHOLD_PX = 80;

/** How long a jumped-to message stays highlighted. */
const JUMP_HIGHLIGHT_MS = 2000;

/** Toast when jump-to cannot bring the message into the loaded history. */
export const JUMP_NOT_LOADED_TOAST = 'Message is older than loaded history';

/**
 * A jump that did not land (not loaded within its budget, failed, or not in
 * history): the pending target clears, the stick-to-bottom intent goes back to
 * what it was before the jump, and the not-loaded toast shows. Null on found. Pure.
 */
export function jumpMiss(
  outcome: FindOlderOutcome,
  stickBefore: boolean,
): { stick: boolean; toast: string } | null {
  return outcome === 'found' ? null : { stick: stickBefore, toast: JUMP_NOT_LOADED_TOAST };
}

/** A DM header's second line while the peer is typing. */
export const HEADER_TYPING = 'typing…';

/**
 * The DM header's second line: 'typing…' while the peer types, else
 * "<role label> · <workspace>" (the workspace alone when the role is unknown,
 * the role alone without a workspace name). Online shows only as the dot on the
 * header photo; there is never presence or last-seen text. Groups keep no
 * second line.
 */
export function dmHeaderLine(input: {
  isGroup: boolean;
  peerTyping: boolean;
  role: string | null;
  workspaceName: string | undefined;
}): string | null {
  if (input.isGroup) return null;
  if (input.peerTyping) return HEADER_TYPING;
  const role = input.role !== null ? roleLabel(input.role) : null;
  if (input.workspaceName !== undefined) {
    return role !== null ? `${role} · ${input.workspaceName}` : input.workspaceName;
  }
  return role;
}

/**
 * The thread header's second line: in notes the static "Only you can see
 * this" (never role, typing or online), else the DM line (groups: none). Pure.
 */
export function threadHeaderLine(
  input: Parameters<typeof dmHeaderLine>[0] & { notes: boolean },
): string | null {
  if (input.notes) return NOTES_TILE_LINE;
  return dmHeaderLine(input);
}

/**
 * The DM header photo's presence: 'online' draws the 10px good dot (panel ring)
 * at its bottom-right while the peer is present and presence is known.
 */
export function headerAvatarPresence(
  presence: { online: boolean; available: boolean } | undefined,
): 'online' | undefined {
  return presence !== undefined && presence.available && presence.online ? 'online' : undefined;
}

/**
 * Human label for who is typing, capped so the row never grows: one or two known
 * names are spelled out, otherwise a count or a generic phrase. Returns null
 * when nobody is typing so the indicator renders nothing.
 */
function typingLabel(ids: string[], profiles: Map<string, ChatProfile>): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const name = profiles.get(ids[0] as string)?.displayName;
    return `${name ?? 'Someone'} is typing`;
  }
  if (ids.length === 2) {
    const a = profiles.get(ids[0] as string)?.displayName;
    const b = profiles.get(ids[1] as string)?.displayName;
    return a !== undefined && b !== undefined ? `${a} and ${b} are typing` : '2 people are typing';
  }
  return 'Several people are typing';
}

/**
 * Slim, non-scrolling typing row shown just above the composer. The three dots
 * are still (motion never fades or pulses, docs/motion.md); all colours are
 * design tokens so light and dark are at parity.
 */
function TypingIndicator(props: {
  ids: string[];
  profiles: Map<string, ChatProfile>;
}): ReactElement | null {
  const label = typingLabel(props.ids, props.profiles);
  if (label === null) return null;
  return (
    <div
      data-typing-row=""
      role="status"
      className={cn('flex shrink-0 items-center gap-2 px-4 py-2 text-fg-3', TYPING_ROW_TYPE)}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3" />
      </span>
      <span>{label}</span>
    </div>
  );
}

/**
 * The header's photo and name block. With `onOpenContact` it is one 44px-tall
 * button spanning both: a DM opens the Contact sheet, a group opens Group info.
 * Without the handler it is the plain block. The photo is the shared Avatar at
 * its header role (a group's rounded square, a person's circle), with the
 * shared initials fallback. Hook-free.
 */
export function ThreadHeaderIdentity(props: {
  isGroup: boolean;
  title: string;
  avatarUrl: string | null;
  presence: 'online' | undefined;
  headerLine: string | null;
  layout: ChatLayout;
  onOpenContact?: () => void;
  /** Personal notes: the notes avatar (own photo + badge, or the notebook) in place of a photo. */
  notes?: boolean;
  /** A search jump's words, marked in the name (the shared highlight). */
  searchWords?: readonly string[];
  /**
   * A DM's other person: their photo opens the photo-only viewer (the name
   * keeps opening Contact info). Absent in groups and notes.
   */
  photoUserId?: string | null;
}): ReactElement {
  const face =
    props.notes === true ? (
      <NotesAvatar role="header" src={props.avatarUrl} surface="panel" />
    ) : props.isGroup ? (
      <Avatar
        name={props.title}
        role="header"
        kind="group"
        {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
      />
    ) : (
      <Avatar
        name={props.title}
        role="header"
        {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
        presence={props.presence}
      />
    );
  const photoUserId = props.photoUserId ?? null;
  const photo =
    photoUserId !== null && props.notes !== true && !props.isGroup ? (
      <PersonTrigger
        userId={photoUserId}
        name={props.title}
        avatarUrl={props.avatarUrl}
        display="block"
        view="photo"
      >
        {face}
      </PersonTrigger>
    ) : (
      face
    );
  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className={cn('block truncate text-fg', sized(HEADER_NAME_TYPE, props.layout))}>
        {(props.searchWords ?? []).length > 0
          ? highlightNodes(props.title, props.searchWords ?? [])
          : props.title}
      </span>
      {props.headerLine !== null ? (
        <span
          data-header-line=""
          className={cn('truncate text-fg-3', sized(HEADER_LINE_TYPE, props.layout))}
        >
          {props.headerLine}
        </span>
      ) : null}
    </span>
  );
  if (props.onOpenContact !== undefined) {
    return (
      <PressableRow
        type="button"
        {...(props.isGroup ? { 'data-group-info-open': '' } : { 'data-contact-open': '' })}
        aria-label={
          props.isGroup ? `Group info for ${props.title}` : `Contact info for ${props.title}`
        }
        onClick={props.onOpenContact}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        {photo}
        {text}
      </PressableRow>
    );
  }
  return (
    <>
      {photo}
      {text}
    </>
  );
}

// renderMessageBody, bodyLinkClass and markSearchWords live in message-body.tsx
// (the Plan item screen renders descriptions with them without importing this
// module); re-exported here so every importer keeps its path.
export { bodyLinkClass, markSearchWords, renderMessageBody };

/** A searched word in a bubble: the shared search highlight (SearchHighlight.tsx). */
export { SEARCH_MARK_CLASS } from '@/components/ui/SearchHighlight';

/**
 * Whether the thread takes its initial (Activity) jump now: there is one, it
 * was not taken yet, and the rows are on screen (the skeleton has no row to
 * reveal, so a jump then would be lost). Pure.
 */
export function initialJumpDue(input: {
  messageId: string | null;
  done: boolean;
  bodyLoading: boolean;
}): boolean {
  return input.messageId !== null && !input.done && !input.bodyLoading;
}

/** The own-row mention-of-me look: the same as a peer's since L1 (MessageBubble.tsx). */
export const MENTION_ME_OWN = MENTION_ME_PEER;

/**
 * A group bubble's sender photo and name open the inline message card with
 * that message as its source (the card's context line and the quote its send
 * carries). Null outside a group. Stable for the thread's life (it reads the
 * latest props at tap time), so it never re-renders a memoised row.
 */
const PersonSourceContext = createContext<
  ((message: ThreadMessage) => PrivateReplyDraft | null) | null
>(null);

/**
 * Who reacted to a message (the thread's one reader: names it already holds,
 * the rest in one batched read): a chip's laptop hover popover asks it. Stable
 * for the thread's life. Null: no hover names.
 */
const ReactorLoadContext = createContext<WhoReactedLoad | null>(null);

/** The info glyph (a circled "i") for the group info button. */
export function InfoGlyph(props: { size?: number }): ReactElement {
  return (
    <span data-info-glyph="" className="flex">
      <IconInfo size={props.size ?? ICON_SIZE.control} />
    </span>
  );
}

/**
 * The message list: a flex column so the leading spacer (mt-auto) takes the
 * slack above the first message and a short thread pins to the bottom. Never
 * justify-end on the scroll container; the spacer collapses to 0 on overflow.
 */
/**
 * The thread's scroll box. Its scroll padding keeps the floating lanes clear
 * (ui/layout LANE_TOP_CLEAR, LANE_BOTTOM_CLEAR): a row it lands on (a jump, a
 * quote) never parks its title or time under the unread pill or the latest
 * button. overflow-x-hidden: overflow-y auto alone computes overflow-x auto,
 * so an own bubble swiped right past the box's edge made the list a sideways
 * scroller mid-gesture (iOS could pan it, and the scroll cancelled the swipe);
 * hidden clips it and never pans.
 */
export const THREAD_LIST_CLASS = cn(
  'flex flex-1 flex-col overflow-y-auto overflow-x-hidden py-2',
  LANE_TOP_CLEAR,
  LANE_BOTTOM_CLEAR,
  NO_TOUCH_SELECT,
);

/**
 * The list's children in order: the bottom-pin spacer, the older-page row, then
 * the grouped rows. A message row learns whether it sits directly under a day
 * pill (afterLabel) so the pill carries the gap. With `loadOlder` (the thread
 * view) a 44px "Load older" row sits at the top instead of the scroll-to-top
 * request. Pure.
 */
export function threadListItems(
  rows: readonly ThreadRow[],
  loadingOlder: boolean,
  renderMessage: (
    row: Extract<ThreadRow, { kind: 'message' }>,
    afterLabel: boolean,
  ) => ReactElement,
  loadOlder?: () => void,
  /** The size table the day pills are drawn with. */
  layout: ChatLayout = 'touch',
  /** A touch-first pointer: Load older suppresses the native callout menu. */
  coarse = false,
  /** Task change lines; absent: none are drawn. */
  renderTask?: (row: Extract<ThreadRow, { kind: 'task' }>) => ReactElement,
  /** The last older page failed (FT41): its Retry; the row replaces Load older. */
  retryOlder?: () => void,
  /**
   * The thread view (8 Nov 2026): its content starts at the top, so the
   * spacer takes no slack (no bottom-anchored gap). The main chat keeps the
   * bottom pin.
   */
  topAligned = false,
): ReactElement[] {
  const items: ReactElement[] = [
    <li
      key="thread-spacer"
      aria-hidden="true"
      data-thread-spacer=""
      {...(topAligned ? { 'data-thread-top': '' } : {})}
      className={topAligned ? undefined : 'mt-auto'}
    />,
  ];
  if (retryOlder !== undefined && !loadingOlder) {
    items.push(olderLoadErrorRow(retryOlder));
  } else if (loadOlder !== undefined && !loadingOlder) {
    items.push(
      <li key="load-older" className="flex justify-center px-4">
        <Button
          type="button"
          variant="link"
          data-load-older=""
          onClick={loadOlder}
          {...(coarse ? { onContextMenu: preventDefault } : {})}
          className={NO_TOUCH_SELECT}
        >
          Load older
        </Button>
      </li>,
    );
  }
  if (loadingOlder) {
    items.push(
      // FN24: a skeleton bubble, not a plain line; the words stay for screen readers.
      <li key="loading-older" aria-busy="true" className="flex flex-col gap-2 px-4 py-2">
        <span className="sr-only">Loading earlier messages</span>
        {/* L1: two text lines on the left (no bubbles); a sweep, never a pulse. */}
        <Bone lit="flat" className="h-9 w-48 rounded-lg" />
        <Bone lit="flat" className="h-9 w-36 rounded-lg" />
      </li>,
    );
  }
  rows.forEach((row, i) => {
    if (row.kind === 'day') {
      items.push(<DateLine key={row.key} label={row.label} layout={layout} />);
    } else if (row.kind === 'task') {
      if (renderTask !== undefined) items.push(renderTask(row));
    } else items.push(renderMessage(row, i > 0 && rows[i - 1]?.kind !== 'message'));
  });
  return items;
}

/**
 * Thin wrapper that owns the long-press / right-click and swipe-to-reply wiring
 * for one bubble and keeps MessageBubble pure. The bubble's rect is captured on
 * open so the floating action menu can anchor to it. Swipe frames are painted
 * straight onto the bubble and icon (translateX, scale, opacity), no re-render.
 */
interface MessageRowProps {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  tail: boolean;
  afterLabel: boolean;
  layout: ChatLayout;
  viewerUserId?: string | undefined;
  mentions?: BubbleMentions | undefined;
  /** The open workspace: mention names resolve from its registry only. */
  workspaceId?: string | null | undefined;
  meta: BubbleMeta;
  /**
   * Open the menu: its anchor rect and the pressed bubble (drawn above the dim);
   * `reactionsOnly` (the laptop smiley) shows just the reactions row.
   */
  onOpen: (
    message: ThreadMessage,
    rect: DOMRect | null,
    held: HTMLElement | null,
    reactionsOnly?: boolean,
  ) => void;
  onRetry?: (messageId: string) => void;
  onDiscard?: (messageId: string) => void;
  /** A tombstone's Delete for me (hide it for the viewer). */
  onHideMessage?: (message: ThreadMessage) => void;
  onCancelUpload?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  onOpenPrivateReply?: (reply: PrivateReply) => void;
  selection?: RowSelection;
  /** Fine pointer device: the in-bubble chevron and the smiley. */
  hoverMenu: boolean;
  /** Coarse (touch-first) pointer: long-press owns the menu, contextmenu is suppressed. */
  coarsePointer: boolean;
  /** prefers-reduced-motion: the swipe resets without a spring. */
  reducedMotion: boolean;
  /** Swiped right past the threshold: the same reply path as the menu's Reply. */
  onSwipeReply: (message: ThreadMessage) => void;
  /**
   * Inside a thread view: no reply gesture. A right swipe is not taken at all
   * (no movement, no icon); the left swipe (Delete) stays.
   */
  replyBlocked?: boolean;
  /** Swiped left past the threshold: the long-press menu's Delete (its sheet, confirm or Undo). */
  onSwipeDelete?: (message: ThreadMessage) => void;
  /** Whether the menu offers Delete on this message now (the left swipe's canTrigger). */
  canSwipeDelete?: (message: ThreadMessage) => boolean;
  onOpenImage: (message: ThreadMessage, index: number) => void;
  postRefs?: BubblePostRefs | undefined;
  /** A member of a card's thread (no quote, no chip). */
  threadMember?: boolean | undefined;
  /** The thread view's root or reply geometry (MessageBubble threadPlace); absent in the main chat. */
  threadPlace?: 'root' | 'reply' | undefined;
  /** The row's piece of the thread rail. */
  rail?: RowRail | undefined;
  /** A voice-only row: the voice note right below from the same sender. */
  nextVoiceId?: string | null | undefined;
  /** Tap-to-transcribe on a received voice note; absent hides the link. */
  onTranscribe?: ((message: ThreadMessage) => void) | undefined;
  quoted?: ThreadMessage | undefined;
  /** A chip's long-press (phone) opens who reacted (the thread's sheet). */
  onOpenReactions?: (message: ThreadMessage) => void;
  /** A chip tap or a drawer pick: the chat's reaction add / remove. */
  onToggleReaction?: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  /** The menu's Select is active on this row's body (no hold, menu or swipe). */
  selectingText?: boolean;
}

/**
 * Memoised: the list hands every row stable props (ids, the row's own cached
 * objects and callbacks that take the message), so a list render that leaves
 * a row's message alone never re-renders its bubble.
 */
const MessageRow = memo(function MessageRow(props: MessageRowProps): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const deleteIconRef = useRef<HTMLSpanElement>(null);
  // The row: the swipe's grab area and pointer capture; in selection mode its
  // own gesture's target.
  const rowRef = useRef<HTMLLIElement>(null);
  // The locked way can fire: its icon shows (false: the rubber band, no icon).
  const swipeIconShownRef = useRef(true);
  const selecting = props.selection !== undefined;
  const latest = useRef(props);
  latest.current = props;
  const bubbleRect = (): DOMRect | null => bubbleRef.current?.getBoundingClientRect() ?? null;
  const swipeRef = useRef<SwipeReplyController | null>(null);
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  // A completed long-press ends any pending swipe for that touch.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => rowHold.hold(),
    { ignoreMouse: true },
  );
  const rowHoldRef = useRef<RowHold | null>(null);
  rowHoldRef.current ??= createRowHold({
    selection: () => latest.current.selection,
    coarse: () => latest.current.coarsePointer,
    openMenu: () => open(bubbleRect()),
    cancelTimer: () => cancel(),
    cancelSwipe: () => swipeRef.current?.cancel(),
    swiping: () => swipeRef.current?.swiping() === true,
  });
  const rowHold = rowHoldRef.current;
  if (swipeRef.current === null) {
    swipeRef.current = createSwipeReplyController({
      // Right = Reply, left = Delete, on own and others' rows alike.
      direction: 'both',
      onReply: () => latest.current.onSwipeReply(latest.current.message),
      onLeft: () => latest.current.onSwipeDelete?.(latest.current.message),
      takes: (side) => side !== 'right' || latest.current.replyBlocked !== true,
      canTrigger: (side) => {
        const ok = rowSwipeCanTrigger(side, latest.current.message, latest.current.canSwipeDelete);
        swipeIconShownRef.current = ok;
        return ok;
      },
      onFrame: (frame) =>
        paintRowSwipe(
          bubbleRef.current,
          iconRef.current,
          deleteIconRef.current,
          frame,
          swipeIconShownRef.current,
        ),
      onStart: (pointerId) => {
        // A swipe never opens a menu: stop the bubble's hold timer (8px < its
        // 10px) and any hold inside this row (a post card's), which never
        // sees the captured moves; holds anywhere else are left alone. Drop
        // any text selection the press started.
        cancel();
        const scope = rowRef.current ?? bubbleRef.current;
        if (scope !== null) cancelPendingLongPressesWithin(scope);
        window.getSelection()?.removeAllRanges();
        if (pointerId === undefined) return;
        try {
          // The row, the grab area, keeps the moves wherever the finger goes.
          scope?.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; the gesture ends on its own.
        }
      },
      enabled: () =>
        latest.current.selection === undefined &&
        latest.current.selectingText !== true &&
        latest.current.message.state === 'sent',
      reducedMotion: () => latest.current.reducedMotion,
    });
  }
  const swipe = swipeRef.current;
  useEffect(() => {
    return () => {
      swipe.dispose();
    };
  }, [swipe]);
  // Selection mode: the row's own pointer gesture decides every toggle.
  const gestureRef = useRef<SelectionGesture | null>(null);
  gestureRef.current ??= createSelectionGesture({
    selection: () => latest.current.selection,
    coarse: () => latest.current.coarsePointer,
  });
  const gesture = gestureRef.current;
  // A row that turns into a tombstone renders a new <li>: attach to that one.
  const tombstone = props.message.deleted === true;
  useEffect(() => {
    const row = rowRef.current;
    if (!selecting || row === null) return;
    return gesture.attach(row);
  }, [selecting, gesture, tombstone]);
  function open(anchor: DOMRect | null, reactionsOnly = false): void {
    if (latest.current.selection !== undefined || latest.current.selectingText === true) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    const current = latest.current;
    current.onOpen(current.message, anchor, bubbleRef.current, reactionsOnly);
  }
  // The bubble's hold (long-press). The swipe sits on the row (rowSwipe):
  // the bubble's presses reach it by bubbling, so it hears every press on the
  // row, the bubble's included.
  const pointer: BubblePointerHandlers = {
    onPointerDown: (e) => {
      rowHold.pointerDown();
      // A press on a body link never arms the long-press menu; the swipe still
      // only starts past 8px, so a tap under that is the link's. In selection
      // mode the row's own gesture toggles it (links included); the hold here
      // never opens the menu.
      if (selecting || !isLinkTarget(e.target)) handlers.onPointerDown(e);
    },
    onPointerMove: (e) => handlers.onPointerMove(e),
    onPointerUp: () => handlers.onPointerUp(),
    onPointerCancel: () => handlers.onPointerCancel(),
  };
  // Stable for the row's life: the memoised bubble never re-renders for it.
  const rowSwipeRef = useRef<BubbleSwipe | null>(null);
  rowSwipeRef.current ??= {
    iconRef,
    deleteIconRef,
    handlers: {
      onPointerDown: (e) => swipe.handlers.onPointerDown(e),
      onPointerMove: (e) => swipe.handlers.onPointerMove(e),
      onPointerUp: (e) => swipe.handlers.onPointerUp(e),
      onPointerCancel: () => swipe.handlers.onPointerCancel(),
    },
    consumeClick: () => swipe.consumeClickSuppression(),
  };
  const rowSwipe = rowSwipeRef.current;
  // A search jump's words: matched words in this bubble draw as <mark>.
  const searchWords = useContext(SearchWordsContext);
  const personSource = useContext(PersonSourceContext);
  const savedFrom = useSavedFrom();
  const meta = props.meta;
  // Small touches (docs/motion.md, pop from .9, ease-pop): a reaction that
  // lands on a row already on screen. A row's first paint never pops.
  const reactionCount = props.message.reactions.reduce((sum, r) => sum + r.count, 0);
  usePopOnRise(props.message.id, '[data-reaction-chips]', reactionCount);
  // The chips' taps (9 Nov 2026: chips, not the badge): toggle mine, the
  // drawer's pick (adds), who reacted (phone sheet / laptop hover names).
  const reactorLoad = useContext(ReactorLoadContext);
  const { onToggleReaction, onOpenReactions, viewerUserId } = props;
  const messageForChips = props.message;
  const reactionChips = useMemo(():
    | Parameters<typeof MessageBubble>[0]['reactionChips']
    | undefined => {
    if (onToggleReaction === undefined) return undefined;
    const id = messageForChips.id;
    const mineOf = (emoji: string): boolean =>
      messageForChips.reactions.some((r) => r.emoji === emoji && r.mine);
    return {
      onToggle: (emoji) => onToggleReaction(id, emoji, mineOf(emoji)),
      onPick: (emoji) => {
        if (!mineOf(emoji)) onToggleReaction(id, emoji, false);
      },
      ...(onOpenReactions !== undefined ? { onWho: () => onOpenReactions(messageForChips) } : {}),
      ...(reactorLoad !== null
        ? {
            who: {
              targetId: id,
              viewerId: viewerUserId ?? null,
              load: async () => {
                const result = await reactorLoad(id);
                return result.ok
                  ? {
                      ok: true as const,
                      data: { ...result.data, former: new Set(result.data.former ?? []) },
                    }
                  : result;
              },
            },
          }
        : {}),
    };
  }, [onToggleReaction, onOpenReactions, reactorLoad, viewerUserId, messageForChips]);
  return (
    <MessageBubble
      searchWords={searchWords}
      personSource={personSource}
      savedFrom={savedFrom}
      message={props.message}
      profiles={props.profiles}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      showTicks={props.showTicks}
      isGroup={props.isGroup}
      head={props.head}
      tail={props.tail}
      afterLabel={props.afterLabel}
      layout={props.layout}
      viewerUserId={props.viewerUserId}
      mentions={props.mentions}
      workspaceId={props.workspaceId}
      meta={meta}
      nextVoiceId={props.nextVoiceId}
      {...(props.onTranscribe !== undefined
        ? { onTranscribe: () => props.onTranscribe?.(props.message) }
        : {})}
      quoted={props.quoted}
      bubbleRef={bubbleRef}
      rowRef={rowRef}
      // Tap to open the thread (GOAL 1): as swipe right, never in the thread
      // view, while selecting or on a deleted row.
      onTapOpen={
        selecting || props.replyBlocked === true || props.message.deleted === true
          ? undefined
          : () => latest.current.onSwipeReply(latest.current.message)
      }
      swipe={rowSwipe}
      press={{
        handlers: pointer,
        onContextMenu: rowHold.contextMenu,
        consumeClick: () => {
          // Read both so neither flag lingers into the next tap.
          const held = consumeClickSuppression();
          const swiped = swipe.consumeClickSuppression();
          return held || swiped;
        },
        coarse: props.coarsePointer,
        onKeyOpen: () => open(bubbleRect()),
        // Chevron, right-click and long-press all open the same one-box menu.
        ...(props.hoverMenu
          ? { onMore: () => open(bubbleRect()), onReact: () => open(bubbleRect(), true) }
          : {}),
      }}
      {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      {...(props.onDiscard !== undefined ? { onDiscard: props.onDiscard } : {})}
      {...(props.onHideMessage !== undefined && tombstone
        ? { onDeleteForMe: () => props.onHideMessage?.(props.message) }
        : {})}
      {...(props.onCancelUpload !== undefined ? { onCancelUpload: props.onCancelUpload } : {})}
      {...(props.onJumpToMessage !== undefined ? { onJumpToMessage: props.onJumpToMessage } : {})}
      {...(props.onOpenPrivateReply !== undefined
        ? { onOpenPrivateReply: props.onOpenPrivateReply }
        : {})}
      {...(props.selection !== undefined ? { selection: props.selection } : {})}
      selectingText={props.selectingText === true}
      onOpenImage={(index) => props.onOpenImage(props.message, index)}
      postRefs={props.postRefs}
      threadMember={props.threadMember}
      threadPlace={props.threadPlace}
      rail={props.rail}
      reactionChips={reactionChips}
    />
  );
});

/** The pointer fields the selection gesture reads (a DOM PointerEvent has them). */
interface GesturePointer {
  clientX: number;
  clientY: number;
  button: number;
  pointerType: string;
}

function gesturePointer(event: Event): GesturePointer {
  const e = event as Partial<GesturePointer>;
  return {
    clientX: e.clientX ?? 0,
    clientY: e.clientY ?? 0,
    button: e.button ?? 0,
    pointerType: e.pointerType ?? 'mouse',
  };
}

/** One row's selection-mode gesture; see createSelectionGesture. */
export interface SelectionGesture {
  /** Listen on the row (capture phase); returns the detach, which also stops the hold timer. */
  attach: (row: EventTarget) => () => void;
}

/**
 * The selection-mode gesture of one row, on real DOM events so it is tested
 * with dispatched events. A press released within 10 px toggles the row once;
 * a press that moves further (a scroll or a drag) or is cancelled never
 * toggles and leaves nothing armed. A touch or pen hold (450 ms, still)
 * toggles instead, and on a coarse pointer a contextmenu that beats the timer
 * acts as that hold; the release and the click after a hold do nothing. Every
 * click on the row is swallowed in capture (nothing inside opens); a click
 * with no press before it (the keyboard on the circle) toggles.
 */
export function createSelectionGesture(deps: {
  selection: () => RowSelection | undefined;
  coarse: () => boolean;
  holdMs?: number;
  moveTolerancePx?: number;
}): SelectionGesture {
  const holdMs = deps.holdMs ?? LONG_PRESS_MS;
  const tolerance = deps.moveTolerancePx ?? MOVE_CANCEL_PX;
  let start: { x: number; y: number } | null = null;
  let moved = false;
  let held = false;
  let swallowClick = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const toggle = (): void => {
    const selection = deps.selection();
    if (selection?.role === 'selectable') selection.onToggle();
  };
  const hold = (): void => {
    stopTimer();
    held = true;
    swallowClick = true;
    toggle();
  };

  const onPointerDown = (event: Event): void => {
    const p = gesturePointer(event);
    if (deps.selection() === undefined || p.button !== 0) return;
    stopTimer();
    start = { x: p.clientX, y: p.clientY };
    moved = false;
    held = false;
    swallowClick = false;
    if (p.pointerType !== 'mouse') timer = setTimeout(hold, holdMs);
  };
  const onPointerMove = (event: Event): void => {
    if (start === null || moved) return;
    const p = gesturePointer(event);
    if (Math.hypot(p.clientX - start.x, p.clientY - start.y) > tolerance) {
      moved = true;
      stopTimer();
    }
  };
  const onPointerUp = (): void => {
    stopTimer();
    if (start === null) return;
    start = null;
    // This press decided; the click that trails it is swallowed.
    swallowClick = true;
    if (!moved && !held) toggle();
  };
  const onPointerCancel = (): void => {
    stopTimer();
    start = null;
    moved = false;
  };
  const onContextMenu = (event: Event): void => {
    if (deps.selection() === undefined) return;
    event.preventDefault();
    if (deps.coarse() && start !== null && !moved && !held) hold();
  };
  const onClick = (event: Event): void => {
    if (deps.selection() === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    toggle();
  };

  const listeners: [string, (event: Event) => void][] = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel],
    ['contextmenu', onContextMenu],
    ['click', onClick],
  ];
  return {
    attach: (row) => {
      // One abort removes every listener (capture phase, before anything inside).
      const controller = new AbortController();
      for (const [type, listener] of listeners) {
        row.addEventListener(type, listener, { capture: true, signal: controller.signal });
      }
      return () => {
        controller.abort();
        stopTimer();
        start = null;
        held = false;
        swallowClick = false;
      };
    },
  };
}

/** What a thread list needs to draw card threads. */
interface ThreadBodyThreads {
  /** A row's thread as it renders now (decided at its first paint). */
  memberOf: (message: ThreadMessage) => ThreadMembership | null;
  /** A thread's reply count, null when unknown. */
  countOf: (rootId: string) => number | null;
  /** The post a root's chip names (null: not visible). */
  postOf: (rootId: string) => PostRefPost | null;
  onOpen: (rootId: string) => void;
  /** The thread view: its root card (indented 29px, with the separator under it). */
  viewRootId?: string | undefined;
  /** The thread view's strip with no replies: focus its reply box. */
  onFocusReply?: (() => void) | undefined;
}

/**
 * The rail plan over a rendered list: day pills and the unread divider end a
 * run (the divider is a full-width line the rail never crosses). Pure.
 */
export function listRailPlans(
  rows: readonly ThreadRow[],
  unreadFirstId: string | null,
  memberOf: (message: ThreadMessage) => ThreadMembership | null,
): Map<string, RailPlan> {
  const items: RailItem<ThreadMessage>[] = [];
  for (const row of rows) {
    if (row.kind !== 'message') {
      items.push({ kind: 'break' });
      continue;
    }
    if (row.message.id === unreadFirstId) items.push({ kind: 'break' });
    items.push({ kind: 'message', message: row.message });
  }
  return railPlans(items, memberOf);
}

/** L3: one root's replies row as the main chat draws it (RepliesRow). */
export interface RepliesRowData {
  label: string;
  repliers: { id: string; name: string; src?: string | undefined }[];
  /** The last reply's time (rowWhen): "Today at 10:12 AM". */
  time: string;
  unread: boolean;
  onOpen: () => void;
}

/** The thread list's props (the chat's list and the thread view's list). */
type ThreadBodyProps = Parameters<typeof ThreadBody>[0];

function ThreadBody(
  props: Pick<
    MessageThreadProps,
    | 'messages'
    | 'loading'
    | 'loadFailed'
    | 'onRetryLoad'
    | 'loadingOlder'
    | 'hasMore'
    | 'onLoadOlder'
    | 'onNewestVisible'
    | 'profiles'
    | 'onToggleReaction'
    | 'onRetry'
    | 'onDiscard'
    | 'onCancelUpload'
  > & {
    cache: PresignCache;
    layout: ChatLayout;
    /** The viewer's user id, for quotes of their own deleted messages. */
    viewerUserId?: string | undefined;
    /** Tappable @mentions in bubbles. */
    mentions?: BubbleMentions | undefined;
    /** The open workspace: mention names resolve from its registry only. */
    workspaceId?: string | null | undefined;
    presignEnabled: boolean;
    showTicks: boolean;
    isGroup: boolean;
    onReply: (message: ThreadMessage) => void;
    /** Present while selection mode is on. */
    selection?: { selected: ReadonlySet<string>; onToggle: (id: string) => void };
    /**
     * Menu "Forward" picked: selection mode with the message ticked (true), or
     * the picker for just this message (false); absent hides it.
     */
    onForwardMessage?: (message: ThreadMessage) => boolean;
    /** Menu "Edit" picked; absent hides it. */
    onEditMessage?: (message: ThreadMessage) => void;
    /**
     * Menu "Delete" picked (`nowMs`: when the menu opened, server time): the
     * delete sheet, or in Personal notes the single-message confirm; absent hides it.
     */
    onDeleteMessage?: (message: ThreadMessage, nowMs: number) => void;
    /** Delete for me is available: Delete shows on every sent message, not only own ones. */
    canDeleteForMe?: boolean;
    /** A tombstone's Delete for me (its one menu row); absent leaves tombstones inert. */
    onHideMessage?: (message: ThreadMessage) => void;
    onChangePriority?: (messageId: string) => void;
    /** A jump-to request (seq makes a repeat of the same id fire again). */
    /** quiet: a search jump whose message is gone opens the chat with no toast. */
    jumpRequest: { id: string; seq: number; quiet?: boolean } | null;
    onEnsureLoaded?: (messageId: string) => Promise<FindOlderOutcome>;
    /** A message's post chip (undefined keeps its quote). */
    chipFor?: (message: ThreadMessage) => BubbleChip | undefined;
    onTalkAbout?: (postId: string, messageId: string) => void;
    /** Inside the gesture that ends a Talk about: focus the composer. */
    onTalkAboutFocus?: () => void;
    /** The thread view: a "Load older" row at the top instead of scroll-to-top paging. */
    loadOlderRow?: boolean;
    /** Which list's older-page outcome to read (older-page-status.ts); absent: never failed. */
    olderKey?: string;
    /** Card threads: the rail, chips and "N replies"; absent draws none. */
    threads?: ThreadBodyThreads;
    /**
     * L3: the main chat's replies row under a thread root (null: none). Absent
     * in the thread screen, which shows its "N replies" separator instead.
     */
    repliesFor?: (message: ThreadMessage) => RepliesRowData | null;
    /** L4: the thread screen: no reply quote or post chip on a reply (every reply targets the root). */
    hideQuotes?: boolean;
    /** L11: menu "Mark unread"; absent hides it. */
    onMarkUnread?: (message: ThreadMessage) => void;
    /** L12: menu "Add to Tasks"; absent hides it. */
    onAddToTask?: (message: ThreadMessage) => void;
    /** L13: menu "Copy link"; absent hides it. */
    onCopyLink?: (message: ThreadMessage) => void;
    /** Menu "Transcribe" picked on a voice note; absent hides the row. */
    onTranscribe?: (message: ThreadMessage) => void;
    /**
     * The reading layer: the first unread (undefined until known), the DM Seen
     * slot and the group Read by slot. Absent renders none of them.
     */
    reading?: {
      unread: FirstUnread | null | undefined;
      seen: { messageId: string; readAt: string | null } | null;
      readBy: { messageId: string; label: string } | null;
    };
    onJumpFirstUnread?: () => void;
    onOpenReadInfo?: () => void;
    /** A reaction badge tapped: the who-reacted sheet; absent keeps the menu. */
    onOpenReactions?: (message: ThreadMessage) => void;
    /** Personal notes: Delete has no window and carries no hint. */
    notes?: boolean;
    /** Menu "Save to notes" picked; absent hides it. */
    onSaveToNotes?: (message: ThreadMessage) => void;
    /**
     * Menu "Reply privately" (group chats): open my DM with the sender carrying
     * the quote, and whether the sender left (no row then); absent hides it.
     */
    replyPrivately?: {
      open: (message: ThreadMessage) => void;
      senderGone: (userId: string) => boolean;
      /** The quote of a message (the sender card's source); absent: none. */
      draft?: (message: ThreadMessage) => PrivateReplyDraft | null;
    };
    /** A bubble's Reply privately quote tapped (its href); absent: the quote is static. */
    onOpenPrivateReplyHref?: (href: string) => void;
    /** The chat's task changes for the loaded window (thread lines); absent: none. */
    taskLines?: { events: readonly TaskEvent[]; ctx: TaskLineContext } | undefined;
    /**
     * Remove own files behind the Undo (menu "Remove file", the viewer bin);
     * absent hides both.
     */
    onRemoveFiles?: ((files: RemovableFile[]) => void) | undefined;
  },
): ReactElement {
  const { onNewestVisible, jumpRequest } = props;
  // Auto-play chain: each voice note's same-sender voice note right below.
  const voiceNext = useMemo(() => nextVoiceIds(props.messages), [props.messages]);
  // Reply quotes read the quoted message's media from the loaded thread (no fetch).
  const messagesById = useMemo(
    () => new Map(props.messages.map((m) => [m.id, m] as const)),
    [props.messages],
  );
  // The mounted window (thread-window.ts): the latest STEP rows on open, STEP
  // more each way as the reader nears an edge, never more than MAX_MOUNTED.
  // Every lookup (quotes, the menu, the viewer, voice chains) still reads the
  // whole loaded list; only the rendered rows are windowed.
  const ids = useMemo(() => props.messages.map((m) => m.id), [props.messages]);
  const { win, set: setWin } = useThreadWindow(ids);
  const total = props.messages.length;
  const live = isLive(win, total);
  const winRef = useRef(win);
  winRef.current = win;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const shown = useMemo(
    () => props.messages.slice(win.start, win.end),
    [props.messages, win.start, win.end],
  );
  // The open menu: its message, anchor, held bubble and the server moment its
  // rows were judged at (the edit and delete windows). While it is open, one
  // timeout for the message's next window boundary re-judges them.
  const planCards = usePlanCards();
  const [menu, setMenu] = useState<{
    message: ThreadMessage;
    rect: DOMRect | null;
    held: HTMLElement | null;
    openedAt: number;
    /** The laptop smiley: just the reactions row. */
    reactionsOnly: boolean;
  } | null>(null);
  // The open menu's voice-note state: its Transcribe row follows this device's store.
  const menuVoice = useVoiceRecord(menu?.message.id);
  // The menu's Select: the one message whose body text is selectable in place.
  const [selectingTextId, setSelectingTextId] = useState<string | null>(null);
  // The thread's one image viewer: which message's album, at which image.
  const [viewer, setViewer] = useState<{ messageId: string; index: number } | null>(null);
  // A message deleted (live, or by us) while its menu is open closes the menu.
  const menuId = menu?.message.id ?? null;
  useEffect(() => {
    if (menuId === null) return;
    const current = props.messages.find((m) => m.id === menuId);
    if (current === undefined || current.deleted === true) setMenu(null);
  }, [props.messages, menuId]);
  // Server time (device clock plus the store's offset), never the device clock alone.
  const serverNow = useServerNow();
  const menuCreatedAt = menu?.message.createdAt ?? null;
  const menuOpenedAt = menu?.openedAt ?? null;
  useEffect(() => {
    if (menuCreatedAt === null || menuOpenedAt === null) return;
    return scheduleWindowBoundary({
      createdAt: menuCreatedAt,
      now: serverNow,
      onBoundary: () => setMenu((m) => (m !== null ? { ...m, openedAt: serverNow() } : m)),
    });
  }, [menuCreatedAt, menuOpenedAt, serverNow]);
  const hoverMenu = useHoverPointer();
  const coarsePointer = useCoarsePointer();
  // Users who asked for less motion: the swipe resets without a spring.
  const reducedMotion = usePrefersReducedMotion();
  const toast = useToast();
  const listRef = useRef<HTMLUListElement>(null);
  // itemIn (docs/motion.md): a message that arrives after first paint (sent
  // or received) rises 8px into place at the tail. The first paint, a kept or
  // cached thread, an older page and a chat switch never move.
  const freshIds = useFreshKeys(ids);
  const prevIdsRef = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const prev = prevIdsRef.current;
    prevIdsRef.current = ids;
    const list = listRef.current;
    if (list === null) return;
    for (const id of freshTailIds(prev, ids, freshIds)) {
      itemIn(list.querySelector(rowSelector(id)));
    }
  }, [ids, freshIds]);
  // FT41: the last older page failed; Retry keeps the reader where they were.
  const olderFailed = useOlderPageFailed(props.olderKey ?? null);
  const retryOlder = (): void => {
    const el = listRef.current;
    if (el !== null && anchorHeightRef.current === null) anchorHeightRef.current = el.scrollHeight;
    props.onLoadOlder?.();
  };
  /** The selecting bubble's body element, read from the list. */
  const selectingBody = useCallback((id: string): Element | null => {
    return (
      listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"] [data-msg-body]`) ?? null
    );
  }, []);
  /**
   * Select, inside the menu row's tap: the body turns selectable now (flushSync)
   * and its whole text is selected in the same gesture; the user then drags
   * the native handles.
   */
  const startTextSelect = (id: string): void => {
    flushSync(() => setSelectingTextId(id));
    const body = selectingBody(id);
    if (body !== null) selectBodyText(body);
  };
  const exitTextSelect = useCallback((): void => setSelectingTextId(null), []);
  // Back leaves text selection first, staying in the chat.
  useHistoryStep(selectingTextId !== null, SELECT_TEXT_HISTORY_KEY, exitTextSelect);
  // Text selection ends on a tap outside the body (tapEndsTextSelect: never a
  // handle drag, a scroll or a cancelled press), Escape, or a scroll that
  // takes the bubble out of view; leaving drops the selection. Every listener
  // goes with one abort.
  useEffect(() => {
    if (selectingTextId === null) return;
    const id = selectingTextId;
    const list = listRef.current;
    const started = selectingBody(id);
    const controller = new AbortController();
    const { signal } = controller;
    // The press in progress (by pointer id): where it went down.
    const presses = new Map<number, { x: number; y: number }>();
    document.addEventListener(
      'pointerdown',
      (event) => presses.set(event.pointerId, { x: event.clientX, y: event.clientY }),
      { capture: true, signal },
    );
    document.addEventListener(
      'pointerup',
      (event) => {
        const down = presses.get(event.pointerId);
        presses.delete(event.pointerId);
        if (down === undefined) return;
        const body = selectingBody(id);
        if (body === null) return;
        const up = { x: event.clientX, y: event.clientY };
        if (tapEndsTextSelect({ down, up, body: body.getBoundingClientRect() })) exitTextSelect();
      },
      { capture: true, signal },
    );
    document.addEventListener('pointercancel', (event) => presses.delete(event.pointerId), {
      capture: true,
      signal,
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') exitTextSelect();
      },
      { signal },
    );
    list?.addEventListener(
      'scroll',
      () => {
        const body = selectingBody(id);
        if (body === null || outOfView(body.getBoundingClientRect(), list.getBoundingClientRect()))
          exitTextSelect();
      },
      { passive: true, signal },
    );
    return () => {
      controller.abort();
      clearBodySelection(selectingBody(id) ?? started);
    };
  }, [selectingTextId, selectingBody, exitTextSelect]);
  // Multi-select, or the message going away (deleted, another thread), ends it.
  const selectingMulti = props.selection !== undefined;
  useEffect(() => {
    if (selectingTextId === null) return;
    const current = props.messages.find((m) => m.id === selectingTextId);
    if (selectingMulti || current === undefined || !canSelectMessageText(current)) {
      setSelectingTextId(null);
    }
  }, [selectingMulti, selectingTextId, props.messages]);
  // Stick-to-bottom: the intent to stay on the latest message (true on open,
  // after an own send; only the reader's gestures let go of it), and who moved
  // the list last. The thread remounts per channel, so each chat opens pinned.
  const stickRef = useRef(openingIntent());
  const sourceRef = useRef<ScrollSource>('program');
  // The scroll height before an older page was requested, so the prepended rows
  // do not move what the reader was looking at.
  const anchorHeightRef = useRef<number | null>(null);
  // The first row at the last new-rows pass: a change means an older page painted.
  const firstIdRef = useRef<string | null>(shown[0]?.id ?? null);
  const newestIdRef = useRef<string | null>(null);
  // The newest message last seen by the pin, to tell an own send from a re-render.
  const lastIdRef = useRef<string | null>(null);
  // A jump target waiting for its older page to render.
  const pendingJumpRef = useRef<string | null>(null);
  // The ids at the last new-rows pass, and the first row on screen (its Y)
  // while the reader is away from the bottom: a row filled into a gap above
  // (catch-up reading back a dropped live row) keeps that row where it was.
  const shownIdsRef = useRef<readonly string[]>(shown.map((m) => m.id));
  const viewAnchorRef = useRef<RowAnchor | null>(null);
  // The first row on screen before the window let go of rows at its far side;
  // the next pass puts it back where it was (no-op when only rows below went).
  const trimAnchorRef = useRef<RowAnchor | null>(null);
  // One observer over the list and every row: any height change re-pins.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<Set<Element>>(new Set());
  /** Every scroll the thread makes itself: its scroll events never change the intent. */
  const programScroll = useCallback((scroll: (el: HTMLUListElement) => void): void => {
    const el = listRef.current;
    if (el === null) return;
    sourceRef.current = 'program';
    // ?paintlog=1 only: the scrolls the thread makes itself.
    const before = paintLogOn() ? Math.round(el.scrollTop) : null;
    scroll(el);
    if (before !== null) paintLog(`thread program scroll ${before} -> ${Math.round(el.scrollTop)}`);
  }, []);
  const pin = useCallback((): void => {
    // The newest row is not mounted (the reader paged far up, or jumped): the
    // latest rows mount first; their new-rows pass pins again on the newest.
    if (!isLive(winRef.current, idsRef.current.length)) {
      setWin(latestWindow(idsRef.current.length));
    }
    programScroll((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, [programScroll, setWin]);
  /** Px below the fold, as far as the stick intent goes: unmounted newer rows are never "near the bottom". */
  const bottomDistance = useCallback(
    (el: HTMLElement): number =>
      isLive(winRef.current, idsRef.current.length)
        ? distanceFromBottom(el)
        : Number.POSITIVE_INFINITY,
    [],
  );
  /**
   * A loaded message outside the window: mount the window around it (its
   * new-rows pass then reveals it). False when it is not loaded or is mounted.
   */
  const recentreOn = useCallback(
    (id: string): boolean => {
      const at = idsRef.current.indexOf(id);
      if (at < 0 || isMounted(winRef.current, at)) return false;
      setWin(centreOn(idsRef.current.length, at));
      return true;
    },
    [setWin],
  );
  // Selection entry and exit: the pressed row keeps its screen Y while the
  // check column comes and goes (taken when the menu entry runs and again just
  // before exit, restored before paint); a thread pinned at entry re-pins on
  // exit. While selecting the list never follows new messages.
  const selectionScrollRef = useRef<SelectionScroll | null>(null);
  selectionScrollRef.current ??= createSelectionScroll();
  const selectionScroll = selectionScrollRef.current;
  const anchorSelection = (message: ThreadMessage): void => {
    selectionScroll.anchorEntry(listRef.current, message.id);
  };
  const selectingNow = props.selection !== undefined;
  const selectingRef = useRef(selectingNow);
  // Exit: read the anchor row's Y from the layout still on screen (this render
  // has not committed yet).
  if (selectingRef.current && !selectingNow) selectionScroll.beforeExit(listRef.current);
  selectingRef.current = selectingNow;
  const selectionMountedRef = useRef(false);
  useLayoutEffect(() => {
    if (!selectionMountedRef.current) {
      selectionMountedRef.current = true;
      return;
    }
    if (selectingNow) {
      const anchor = selectionScroll.entered(stickRef.current);
      // The anchored row wins over stick-to-bottom until selection ends.
      stickRef.current = false;
      if (anchor !== null) programScroll((el) => void restoreRowAnchor(el, anchor));
      return;
    }
    const plan = selectionScroll.exited();
    if (plan.pin) {
      stickRef.current = true;
      pin();
      return;
    }
    const anchor = plan.anchor;
    if (anchor !== null) programScroll((el) => void restoreRowAnchor(el, anchor));
  }, [selectingNow, selectionScroll, programScroll, pin]);
  /** A user gesture on the list: the next scroll events are the reader's. */
  const userGesture = (): void => {
    sourceRef.current = 'user';
  };
  // A touch flick: the finger is down, or momentum is still scrolling (a scroll
  // event from the touch gesture in the last 150ms). A size change meanwhile
  // defers its pin until the list settles, then decides on the settled spot.
  const touchingRef = useRef(false);
  const touchScrollAtRef = useRef<number | null>(null);
  const deferredPinRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const scheduleSettle = useCallback((): void => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (touchingRef.current) return;
      touchScrollAtRef.current = null;
      const el = listRef.current;
      if (!deferredPinRef.current || el === null) return;
      deferredPinRef.current = false;
      const settled = settleDecision({
        intent: stickRef.current,
        distanceFromBottom: bottomDistance(el),
        restoring: pendingJumpRef.current !== null || anchorHeightRef.current !== null,
      });
      stickRef.current = settled.intent;
      if (settled.action === 'pin') pin();
    }, SCROLL_SETTLE_MS);
  }, [pin, bottomDistance]);
  const touchStart = (): void => {
    userGesture();
    touchingRef.current = true;
  };
  // Touch ends are heard on the window (a row removed under the finger takes
  // its own touchend with it); only a touch that started on the list counts.
  const touchEndRef = useRef<() => void>(() => {});
  touchEndRef.current = (): void => {
    if (!touchingRef.current) return;
    touchingRef.current = false;
    touchScrollAtRef.current = Date.now();
    scheduleSettle();
  };
  useEffect(() => listenTouchEnd(window, () => touchEndRef.current()), []);
  const ensureLoadedRef = useRef(props.onEnsureLoaded);
  ensureLoadedRef.current = props.onEnsureLoaded;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // The arrival tint on the jumped-to row (the shared glow): cleared on the next
  // jump and on unmount, so no timer outlives the thread.
  const glowCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => glowCleanupRef.current?.(), []);
  // The jump hold (jump-hold.ts): the jumped-to row, its offset in the list's
  // content when last looked at, and when the hold ends. Rows above it that
  // change height after the jump (a card resolving from its skeleton) keep it
  // centred; a reader gesture lets go.
  const jumpHoldRef = useRef<{ id: string; offset: number; until: number } | null>(null);
  const jumpSettleTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (jumpSettleTimerRef.current !== null) window.clearTimeout(jumpSettleTimerRef.current);
    },
    [],
  );
  const checkJumpHold = useCallback(
    (settle: boolean): void => {
      const hold = jumpHoldRef.current;
      const list = listRef.current;
      if (hold === null || list === null) return;
      const el = list.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(hold.id)}"]`);
      if (
        el == null ||
        !holdActive({ source: sourceRef.current, now: Date.now(), until: hold.until })
      ) {
        jumpHoldRef.current = null;
        return;
      }
      const listBox = list.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      const offset = row.top - listBox.top + list.scrollTop;
      const moved = offset - hold.offset;
      hold.offset = offset;
      if (!recentreNeeded({ moved, settle, list: listBox, row })) return;
      const delta = centreDelta(listBox, row);
      // Instant, before paint: the row lands where the jump meant it to.
      programScroll((l) => {
        l.scrollTop += delta;
      });
    },
    [programScroll],
  );
  /**
   * Scroll a loaded message to the centre and tint its row for JUMP_HIGHLIGHT_MS
   * (the shared glow: a fade after, none under reduced motion); false when it is
   * not rendered.
   */
  const reveal = useCallback(
    (id: string, highlightMs: number): boolean => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
      if (el == null) return false;
      // A jump lets go of the bottom.
      stickRef.current = false;
      sourceRef.current = 'program';
      glowCleanupRef.current?.();
      glowCleanupRef.current = highlightMs > 0 ? glowTarget(el) : null;
      const list = listRef.current;
      if (list !== null) {
        const offset =
          el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
        jumpHoldRef.current = { id, offset, until: Date.now() + JUMP_HOLD_MS };
        // Once the smooth scroll should have landed, a row it left outside the
        // list (under the header or the composer) is centred in one frame.
        if (jumpSettleTimerRef.current !== null) window.clearTimeout(jumpSettleTimerRef.current);
        jumpSettleTimerRef.current = window.setTimeout(() => {
          jumpSettleTimerRef.current = null;
          checkJumpHold(true);
        }, JUMP_SETTLE_MS);
      }
      return true;
    },
    [checkJumpHold],
  );
  // Jump-to: reveal at once when loaded, else page older history (capped) and
  // reveal once the page carrying it renders.
  useEffect(() => {
    if (jumpRequest === null) return;
    const id = jumpRequest.id;
    const quiet = jumpRequest.quiet === true;
    if (reveal(id, JUMP_HIGHLIGHT_MS)) return;
    // Loaded but outside the window: the window mounts around it and its
    // new-rows pass reveals it (no read).
    if (recentreOn(id)) {
      pendingJumpRef.current = id;
      stickRef.current = false;
      return;
    }
    const ensure = ensureLoadedRef.current;
    if (ensure === undefined) {
      if (!quiet) toastRef.current.show({ title: JUMP_NOT_LOADED_TOAST });
      return;
    }
    pendingJumpRef.current = id;
    // A jump that does not land gives the bottom back as it was.
    const stickBefore = stickRef.current;
    stickRef.current = false;
    void ensure(id).then((outcome) => {
      if (pendingJumpRef.current !== id) return;
      const miss = jumpMiss(outcome, stickBefore);
      if (miss !== null) {
        pendingJumpRef.current = null;
        stickRef.current = miss.stick;
        if (miss.stick) pin();
        // A search jump to a message that is gone opens the chat as usual, no error.
        if (!quiet) toastRef.current.show({ title: miss.toast });
        return;
      }
      if (reveal(id, JUMP_HIGHLIGHT_MS)) pendingJumpRef.current = null;
      else recentreOn(id);
    });
  }, [jumpRequest, reveal, pin, recentreOn]);
  // New rows: a pending jump owns the position while its pages land; an older
  // page keeps the reader where they were; else an own send takes hold of the
  // bottom again and, while the intent holds, the list pins instantly before
  // paint (open included, so the first paint is final).
  // The window counts as new rows too: its first row and ids are the mounted
  // ones; the newest and the intent read the whole loaded list.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || props.messages.length === 0) return;
    const last = props.messages[props.messages.length - 1];
    const first = shown[0]?.id ?? null;
    const prepended = first !== firstIdRef.current;
    firstIdRef.current = first;
    const filledGap = insertedInside(shownIdsRef.current, shown);
    shownIdsRef.current = shown.map((m) => m.id);
    const viewAnchor = viewAnchorRef.current;
    if (filledGap && !stickRef.current && viewAnchor !== null) {
      programScroll((list) => void restoreRowAnchor(list, viewAnchor));
    }
    // The window let go of rows at its far side: the reader's row stays put
    // (a direct scroll, so the reader's own gesture keeps owning the list).
    const trimAnchor = trimAnchorRef.current;
    trimAnchorRef.current = null;
    if (trimAnchor !== null && !stickRef.current) restoreRowAnchor(el, trimAnchor);
    if (pendingJumpRef.current !== null) {
      anchorHeightRef.current = null;
      if (reveal(pendingJumpRef.current, JUMP_HIGHLIGHT_MS)) pendingJumpRef.current = null;
      else recentreOn(pendingJumpRef.current);
      return;
    }
    if (anchorHeightRef.current !== null) {
      const anchor = anchorHeightRef.current;
      // The older page may still be held: the compensation waits for the
      // render its rows paint in, so the viewport never moves.
      const step = olderPageAnchorStep({
        anchorHeight: anchor,
        prepended,
        scrollHeight: el.scrollHeight,
      });
      anchorHeightRef.current = step.anchorHeight;
      if (step.scrollBy !== 0) {
        programScroll((list) => {
          list.scrollTop += step.scrollBy;
        });
      }
      if (step.anchorHeight === null) return;
    }
    const newestChanged = last !== undefined && last.id !== lastIdRef.current;
    stickRef.current = intentAfterNewest({
      intent: stickRef.current,
      newest: last,
      previousNewestId: lastIdRef.current,
    });
    lastIdRef.current = last?.id ?? null;
    // While selecting, new messages arrive without moving the list.
    if (selectingRef.current) return;
    // An own local send pins now; anything else waits out a flick (the
    // settle pins it if the reader is still near the bottom).
    const touchScrollAt = touchScrollAtRef.current;
    const action = newRowsAction({
      intent: stickRef.current,
      flicking: flickInProgress({
        touching: touchingRef.current,
        msSinceTouchScroll: touchScrollAt !== null ? Date.now() - touchScrollAt : null,
      }),
      ownLocalSend: newestChanged && last !== undefined && sentFromThisDevice(last),
    });
    if (action === 'leave') return;
    if (action === 'defer') {
      deferredPinRef.current = true;
      if (!touchingRef.current && settleTimerRef.current === null) scheduleSettle();
      return;
    }
    // Not mounted yet (a window up in history): pin mounts the latest rows
    // and their pass lands here again to pin and count the newest as seen.
    if (!isLive(winRef.current, props.messages.length)) {
      pin();
      return;
    }
    pin();
    if (last !== undefined && newestIdRef.current !== last.id) {
      newestIdRef.current = last.id;
      onNewestVisible?.();
    }
  }, [
    props.messages,
    shown,
    onNewestVisible,
    reveal,
    pin,
    programScroll,
    scheduleSettle,
    recentreOn,
  ]);
  // Never more than MAX_MOUNTED rows: after any commit over it (an older page
  // or STEP mounted above, STEP below, live rows), the rows farthest from the
  // first row on screen unmount; its Y is restored by the next new-rows pass.
  // An older-page restore in flight finishes first; a pending jump keeps the
  // top (where its pages land).
  useLayoutEffect(() => {
    const list = listRef.current;
    const w = winRef.current;
    if (list === null || w.end - w.start <= MAX_MOUNTED || anchorHeightRef.current !== null) return;
    const anchor = firstVisibleRow(list);
    const at = anchor !== null ? idsRef.current.indexOf(anchor.id) : -1;
    const visible =
      pendingJumpRef.current !== null
        ? w.start
        : at >= 0
          ? at
          : stickRef.current
            ? w.end - 1
            : w.start;
    const next = trimWindow(w, visible);
    if (next.start === w.start && next.end === w.end) return;
    trimAnchorRef.current = anchor;
    setWin(next);
  });
  // A short window (its rows do not fill the list) with loaded rows above
  // mounts STEP more at once: there is no scroll to page it up with.
  useLayoutEffect(() => {
    const list = listRef.current;
    const w = winRef.current;
    if (list === null || w.start <= 0 || anchorHeightRef.current !== null) return;
    if (pendingJumpRef.current !== null || w.end - w.start + STEP > MAX_MOUNTED) return;
    // A list with no size (not laid out yet, or hidden) has nothing to fill.
    if (list.clientHeight === 0) return;
    if (list.scrollHeight - list.clientHeight > LOAD_OLDER_THRESHOLD_PX) return;
    anchorHeightRef.current = list.scrollHeight;
    setWin(extendUp(w));
  });
  // After every commit (and on scroll), the first row on screen while away from
  // the bottom; pinned threads need none.
  useLayoutEffect(() => {
    const list = listRef.current;
    viewAnchorRef.current = list !== null && !stickRef.current ? firstVisibleRow(list) : null;
  });
  // Pin on any size change: every row and the list itself are observed (rows
  // as they mount and unmount), so late growth (cards, badges, the
  // typing row, the composer, a font swap) re-pins before paint while the
  // intent holds. Runs after every commit to follow the rows.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === 'undefined') return;
    const observer =
      observerRef.current ??
      new ResizeObserver(() => {
        if (selectingRef.current) return;
        checkJumpHold(false);
        const touchScrollAt = touchScrollAtRef.current;
        const action = sizeChangeAction({
          intent: stickRef.current,
          pendingJump: pendingJumpRef.current !== null,
          olderPageRestore: anchorHeightRef.current !== null,
          flicking: flickInProgress({
            touching: touchingRef.current,
            msSinceTouchScroll: touchScrollAt !== null ? Date.now() - touchScrollAt : null,
          }),
        });
        if (action === 'pin') pin();
        if (action === 'defer') {
          deferredPinRef.current = true;
          if (!touchingRef.current && settleTimerRef.current === null) scheduleSettle();
        }
      });
    observerRef.current = observer;
    const observed = observedRef.current;
    for (const node of observed) {
      if (node === list || node.parentNode === list) continue;
      observer.unobserve(node);
      observed.delete(node);
    }
    for (const node of [list, ...Array.from(list.children)]) {
      if (observed.has(node)) continue;
      observer.observe(node);
      observed.add(node);
    }
  });
  // Scroll-to-latest: shown only while the thread is not stuck to the bottom,
  // with a count of others' messages that arrived meanwhile. It only reads the
  // stick intent; the rules above stay the only ones that change it.
  const [showLatest, setShowLatest] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const countedNewestRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const msgs = props.messages;
    const last = msgs[msgs.length - 1];
    const prevId = countedNewestRef.current;
    countedNewestRef.current = last?.id ?? null;
    setShowLatest(!stickRef.current);
    if (stickRef.current) {
      setNewCount(0);
      return;
    }
    if (prevId === null || last === undefined || last.id === prevId) return;
    const at = msgs.findIndex((m) => m.id === prevId);
    if (at < 0) return;
    const added = msgs.slice(at + 1).filter((m) => !m.mine).length;
    if (added > 0) setNewCount((n) => n + added);
  }, [props.messages]);
  const toLatest = (): void => {
    pendingJumpRef.current = null;
    stickRef.current = true;
    setNewCount(0);
    setShowLatest(false);
    // Decision 43: an instant pin, never a smooth scroll.
    pin();
    const last = props.messages[props.messages.length - 1];
    if (last !== undefined && newestIdRef.current !== last.id) {
      newestIdRef.current = last.id;
      onNewestVisible?.();
    }
  };
  // The jump pill: decided once the first unread is known and its divider has
  // laid out (before paint, after the open pin): shown only when the run starts
  // above the viewport, hidden for good once the divider has been on screen.
  const unread = props.reading?.unread;
  const [pill, setPill] = useState<'unknown' | 'show' | 'done'>('unknown');
  const dividerWhere = (): 'above' | 'visible' | 'below' | 'missing' => {
    const list = listRef.current;
    const divider = list?.querySelector('[data-unread-divider]');
    if (list == null) return 'missing';
    if (divider == null) {
      // A loaded first unread outside the window sits where its rows would.
      if (unread == null || unread.kind !== 'loaded') return 'missing';
      const at = idsRef.current.indexOf(unread.firstId);
      if (at >= 0 && at < winRef.current.start) return 'above';
      if (at >= winRef.current.end) return 'below';
      return 'missing';
    }
    const lr = list.getBoundingClientRect();
    const dr = divider.getBoundingClientRect();
    if (lr.height > 0 && dr.bottom <= lr.top) return 'above';
    if (lr.height > 0 && dr.top >= lr.bottom) return 'below';
    return 'visible';
  };
  const updatePill = (): void => {
    const list = listRef.current;
    const next = nextPill({
      pill,
      unread,
      where: dividerWhere(),
      // The open pin has not landed yet: the divider's place is not final.
      pinPending: stickRef.current && list != null && bottomDistance(list) > 1,
    });
    if (next !== null) setPill(next);
  };
  const updatePillRef = useRef(updatePill);
  updatePillRef.current = updatePill;
  useLayoutEffect(() => updatePillRef.current());
  // An older-page load that ended with no new rows (empty or failed) lets go of
  // the anchor, else size-change pinning would stay off for good.
  const loadingOlder = props.loadingOlder === true;
  const wasLoadingOlderRef = useRef(loadingOlder);
  const messagesAtLoadRef = useRef(props.messages);
  useLayoutEffect(() => {
    const wasLoading = wasLoadingOlderRef.current;
    wasLoadingOlderRef.current = loadingOlder;
    if (loadingOlder && !wasLoading) messagesAtLoadRef.current = props.messages;
    const anchored = anchorAfterOlderLoad({
      anchored: anchorHeightRef.current !== null,
      loadEnded: wasLoading && !loadingOlder,
      messagesChanged: props.messages !== messagesAtLoadRef.current,
    });
    if (!anchored) anchorHeightRef.current = null;
  }, [loadingOlder, props.messages]);
  useEffect(() => {
    const observed = observedRef.current;
    return () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      observed.clear();
    };
  }, []);
  // A quote tapped whose message is loaded but outside the window: the window
  // mounts around it, then the scroll runs on that commit.
  const pendingQuoteRef = useRef<string | null>(null);
  const scrollToMessage = (id: string): void => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) {
      if (recentreOn(id)) {
        stickRef.current = false;
        pendingQuoteRef.current = id;
        return;
      }
      toast.show({ title: 'That message is not loaded here' });
      return;
    }
    stickRef.current = false;
    sourceRef.current = 'program';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const flash = el.querySelector('[data-bubble]') ?? el;
    // The focus line, never a box-shadow over the bubble's light; on my own
    // bubble [data-own] turns it on-bubble ink.
    const ring = ['lit-focus'];
    flash.classList.add(...ring);
    window.setTimeout(() => flash.classList.remove(...ring), 1200);
  };
  const onJumpToMessage = useStableCallback(scrollToMessage);
  // A bubble's Reply privately quote: the group message, comment or plan comment it quotes.
  const openPrivateReplyHref = props.onOpenPrivateReplyHref;
  const onOpenPrivateReply = useStableCallback((reply: PrivateReply): void => {
    const href = privateReplyHref(reply.link);
    if (href !== null) openPrivateReplyHref?.(href);
  });
  useLayoutEffect(() => {
    const id = pendingQuoteRef.current;
    if (id === null) return;
    pendingQuoteRef.current = null;
    onJumpToMessage(id);
  }, [shown, onJumpToMessage]);
  // Every row prop is stable (MessageRow is memoised): callbacks keep one
  // identity and take the message or its id; a row's object props come from
  // per-row caches that keep the last object while its contents are the same.
  const onOpenRow = useStableCallback(
    (m: ThreadMessage, rect: DOMRect | null, held: HTMLElement | null, reactionsOnly?: boolean) => {
      if (m.deleted === true) return;
      // Another menu opening ends text selection.
      setSelectingTextId(null);
      setMenu({
        message: m,
        rect,
        held,
        openedAt: serverNow(),
        reactionsOnly: reactionsOnly === true,
      });
    },
  );
  const onOpenImage = useCallback(
    (m: ThreadMessage, index: number) => setViewer({ messageId: m.id, index }),
    [],
  );
  // The thread view's divider acts on its ROOT exactly as the root's
  // long-press sheet does: Add to Tasks, Forward, and More (the sheet itself).
  // An action the sheet would not offer is not drawn.
  const rootActionsFor = (m: ThreadMessage): RootActions => {
    const live = m.state === 'sent' && m.deleted !== true;
    const plan = isPlanMessage(m) || isIdeaMessage(m);
    const addToTask = props.onAddToTask;
    const forward = props.onForwardMessage;
    return {
      ...(addToTask !== undefined && live && !plan && taskTitleOf(m) !== ''
        ? { onTasks: () => addToTask(m) }
        : {}),
      ...(forward !== undefined && canForward(m) && !plan
        ? {
            onForward: () => {
              anchorSelection(m);
              if (forward(m) !== true) selectionScroll.cancelEntry();
            },
          }
        : {}),
      // The sheet opens only with an anchor: the ⋮ button's own box.
      ...(m.deleted !== true
        ? { onMore: (from: HTMLElement) => onOpenRow(m, from.getBoundingClientRect(), null) }
        : {}),
    };
  };
  const onSwipeReply = useStableCallback(props.onReply);
  // Swipe left: exactly the long-press menu's Delete (its rule, its sheet).
  const canSwipeDelete = useStableCallback(
    (m: ThreadMessage): boolean =>
      props.onDeleteMessage !== undefined &&
      messageDeleteOffer({
        message: m,
        nowMs: serverNow(),
        notes: props.notes === true,
        canDeleteForMe: props.canDeleteForMe === true,
      }).canDelete,
  );
  const onSwipeDelete = useStableCallback((m: ThreadMessage): void => {
    if (!canSwipeDelete(m)) return;
    setSelectingTextId(null);
    props.onDeleteMessage?.(m, serverNow());
  });
  const onTranscribeRow = useOptionalCallback(props.onTranscribe);
  const onRetryRow = useOptionalCallback(props.onRetry);
  const onHideRow = useOptionalCallback(props.onHideMessage);
  const onDiscardRow = useOptionalCallback(props.onDiscard);
  const onCancelUploadRow = useOptionalCallback(props.onCancelUpload);
  const onOpenReactionsRow = useOptionalCallback(props.onOpenReactions);
  const onToggleReactionRow = useOptionalCallback(props.onToggleReaction);
  const onTalkAboutRow = useOptionalCallback(props.onTalkAbout);
  const onTalkAboutFocusRow = useOptionalCallback(props.onTalkAboutFocus);
  const onOpenMention = useOptionalCallback(props.mentions?.onOpen);
  const mentionPeer = props.mentions?.peerUserId ?? null;
  const rowMentions = useMemo<BubbleMentions | undefined>(
    () =>
      onOpenMention !== undefined ? { peerUserId: mentionPeer, onOpen: onOpenMention } : undefined,
    [onOpenMention, mentionPeer],
  );
  // The latest selection and chips, read by each row's stable toggle and tap.
  const selectionRef = useRef(props.selection);
  selectionRef.current = props.selection;
  const chipsRef = useRef(new Map<string, BubbleChip>());
  const rowCachesRef = useRef<{
    meta: (id: string, value: BubbleMeta) => BubbleMeta;
    rail: (id: string, value: RowRail | undefined) => RowRail | undefined;
    selection: (id: string, value: RowSelection) => RowSelection;
    chip: (id: string, value: BubbleChip | undefined) => BubbleChip | undefined;
    postRefs: (id: string, value: BubblePostRefs) => BubblePostRefs;
    toggle: (id: string) => () => void;
    chipTap: (id: string) => () => void;
  } | null>(null);
  rowCachesRef.current ??= {
    meta: createStableCache<BubbleMeta>(),
    rail: createStableCache<RowRail | undefined>(),
    selection: createStableCache<RowSelection>(),
    chip: createStableCache<BubbleChip | undefined>(),
    postRefs: createStableCache<BubblePostRefs>(),
    toggle: createIdCallbacks((id) => selectionRef.current?.onToggle(id)),
    chipTap: createIdCallbacks((id) => chipsRef.current.get(id)?.onTap()),
  };
  const rowCaches = rowCachesRef.current;
  // The group sender's card source: Reply privately's quote, when the message
  // offers it (someone else's recorded message from a current member).
  const personSourceRef = useRef<((message: ThreadMessage) => PrivateReplyDraft | null) | null>(
    null,
  );
  const sourceProvider = props.replyPrivately;
  personSourceRef.current =
    sourceProvider?.draft !== undefined
      ? (message: ThreadMessage) =>
          canReplyPrivatelyInChat({
            mine: message.mine,
            senderUserId: message.senderUserId,
            isGroup: props.isGroup,
            notes: props.notes === true,
            senderRemoved:
              message.senderUserId !== null && sourceProvider.senderGone(message.senderUserId),
            state: message.state,
            ...(message.deleted !== undefined ? { deleted: message.deleted } : {}),
          })
            ? (sourceProvider.draft?.(message) ?? null)
            : null
      : null;
  const personSource = useCallback(
    (message: ThreadMessage): PrivateReplyDraft | null =>
      personSourceRef.current?.(message) ?? null,
    [],
  );
  if (props.loading) return threadSkeleton();
  if (props.loadFailed === true && props.messages.length === 0) {
    return threadLoadError(props.onRetryLoad);
  }
  if (props.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        {props.notes === true ? (
          <EmptyState
            icon={<IconChat size={ICON_SIZE.tray} />}
            title={NOTES_EMPTY_TITLE}
            description={NOTES_EMPTY_LINE}
          />
        ) : (
          <EmptyState icon={<IconChat size={ICON_SIZE.tray} />} title="Messages show up here." />
        )}
      </div>
    );
  }
  const nowMs = Date.now();
  // A plan card message: no Forward, Save to notes or Edit; Copy copies its title.
  // An idea card message follows the same rules.
  const menuPlan = menu !== null && (isPlanMessage(menu.message) || isIdeaMessage(menu.message));
  const menuPlanTitle =
    menu === null
      ? null
      : isPlanMessage(menu.message)
        ? planTitleOf(planCards, menu.message)
        : isIdeaMessage(menu.message)
          ? ideaTitleOf(menu.message)
          : null;
  const menuOwn =
    menu !== null
      ? ownMessageActions(menu.message, menu.openedAt, props.notes === true)
      : { canEdit: false, canDelete: false };
  const menuFailed = menu !== null && canDiscardFailed(menu.message);
  // Delete (for everyone in the window) and Delete for me: the shared rule a
  // row's left swipe reads too.
  const menuDelete =
    menu !== null && !menuFailed
      ? messageDeleteOffer({
          message: menu.message,
          nowMs: menu.openedAt,
          notes: props.notes === true,
          canDeleteForMe: props.canDeleteForMe === true,
        })
      : { canDelete: false, forMeOnly: false };
  const replyPrivately = props.replyPrivately;
  const menuSender = menu?.message.senderUserId ?? null;
  const menuReplyPrivately =
    menu !== null &&
    replyPrivately !== undefined &&
    canReplyPrivatelyInChat({
      mine: menu.message.mine,
      senderUserId: menuSender,
      isGroup: props.isGroup,
      notes: props.notes === true,
      senderRemoved: menuSender !== null && replyPrivately.senderGone(menuSender),
      state: menu.message.state,
      ...(menu.message.deleted !== undefined ? { deleted: menu.message.deleted } : {}),
    });
  const viewerMessage =
    viewer !== null ? props.messages.find((m) => m.id === viewer.messageId) : undefined;
  const viewerData =
    viewerMessage !== undefined
      ? withRemovableImages(
          threadLightbox(viewerMessage, props.profiles, new Date(nowMs)),
          viewerMessage,
          props.onRemoveFiles,
          props.viewerUserId ?? '',
        )
      : null;
  // More -> "Remove file": an own message with exactly one file.
  const onRemoveFiles = props.onRemoveFiles;
  const menuRemoveFile =
    menu !== null &&
    onRemoveFiles !== undefined &&
    canRemoveSingleFile(menu.message, props.viewerUserId ?? '')
      ? menu.message.attachments[0]
      : undefined;
  // Card threads: decided per row at first paint; the rail, its chips and
  // "N replies" are hidden while selecting (rows then keep today's place).
  const memberOf = props.threads?.memberOf;
  const threads = props.selection === undefined ? props.threads : undefined;
  // The window's rows, grouped with one loaded message past each edge so the
  // edge rows keep their true head, tail and day pill.
  const lead = props.messages[win.start - 1];
  const trail = props.messages[win.end];
  // Set by the thread view's root row as it renders: the next row starts under the strip.
  let afterStrip = false;
  const listRows = cropToWindow(
    threadRows(
      props.messages.slice(
        lead !== undefined ? win.start - 1 : win.start,
        trail !== undefined ? win.end + 1 : win.end,
      ),
      nowMs,
      undefined,
      {
        showTicks: props.showTicks,
        days: props.threads?.viewRootId === undefined,
        ...(props.taskLines !== undefined ? { taskEvents: props.taskLines.events } : {}),
      },
    ),
    (row) => (row.kind === 'message' ? row.message.id : null),
    lead?.id ?? null,
    trail?.id ?? null,
  );
  const taskCtx = props.taskLines?.ctx;
  const plans =
    threads !== undefined
      ? listRailPlans(listRows, unread?.kind === 'loaded' ? unread.firstId : null, threads.memberOf)
      : new Map<string, RailPlan>();
  return (
    <PersonSourceContext.Provider value={sourceProvider?.draft !== undefined ? personSource : null}>
      <div data-thread-viewport="" className="relative flex min-h-0 flex-1 flex-col">
        <ul
          ref={listRef}
          // New messages are read out politely as they arrive.
          role="log"
          aria-live="polite"
          aria-label="Messages"
          onTouchStart={touchStart}
          onTouchMove={userGesture}
          onWheel={userGesture}
          onKeyDown={(e) => {
            if (isScrollKey(e.key)) userGesture();
          }}
          onPointerDown={(e) => {
            // A press on the list itself (not a row) is its scrollbar.
            if (e.target === e.currentTarget) userGesture();
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            viewAnchorRef.current = stickRef.current ? null : firstVisibleRow(el);
            if (touchingRef.current || touchScrollAtRef.current !== null) {
              touchScrollAtRef.current = Date.now();
              if (!touchingRef.current) scheduleSettle();
            }
            stickRef.current = intentAfterScroll({
              intent: stickRef.current,
              source: sourceRef.current,
              distanceFromBottom: bottomDistance(el),
            });
            setShowLatest(!stickRef.current);
            if (stickRef.current) setNewCount(0);
            updatePill();
            // Near an edge of the window with loaded rows past it: STEP more
            // mount that way (rows above keep the reader in place through the
            // older-page restore). The first loaded row's edge pages as before.
            const edge =
              sourceRef.current === 'user' && anchorHeightRef.current === null
                ? windowEdge({
                    win: winRef.current,
                    total: idsRef.current.length,
                    scrollTop: el.scrollTop,
                    distanceFromBottom: distanceFromBottom(el),
                    viewport: el.clientHeight,
                    edgePx: LOAD_OLDER_THRESHOLD_PX,
                  })
                : 'none';
            if (edge === 'up') {
              anchorHeightRef.current = el.scrollHeight;
              setWin(extendUp(winRef.current));
            } else if (edge === 'down') {
              setWin(extendDown(winRef.current, idsRef.current.length));
            }
            if (live && isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
              const last = props.messages[props.messages.length - 1];
              if (last !== undefined && newestIdRef.current !== last.id) {
                newestIdRef.current = last.id;
                props.onNewestVisible?.();
              }
            }
            if (
              sourceRef.current === 'user' &&
              winRef.current.start === 0 &&
              el.scrollTop <= LOAD_OLDER_THRESHOLD_PX &&
              props.hasMore === true &&
              props.loadingOlder !== true &&
              // A failed page waits for its Retry: scrolling never re-fires it.
              !olderFailed &&
              anchorHeightRef.current === null
            ) {
              anchorHeightRef.current = el.scrollHeight;
              props.onLoadOlder?.();
            }
          }}
          className={THREAD_LIST_CLASS}
        >
          {props.loadFailed === true ? threadLoadErrorRow(props.onRetryLoad) : null}
          {threadListItems(
            listRows,
            props.loadingOlder === true,
            (row, afterLabelIn) => {
              // The first reply under the thread strip: the strip carries the gap (8),
              // and it always heads (photo, name, time) under the strip.
              const firstUnderStrip = afterStrip;
              const afterLabel = afterLabelIn || afterStrip;
              afterStrip = false;
              const plan = plans.get(row.message.id) ?? NO_RAIL;
              const chipRoot = plan.chipRoot;
              const viewRoot = threads?.viewRootId === row.message.id;
              const rootCard = isRootCard(row.message);
              // A left root card keeps its shifted place from its first paint,
              // so its first reply never moves it.
              // 9 Nov 2026 (rule 1): the thread view's root keeps the text
              // column (no 29px shift), so the strip's label lines up under it.
              const rowRail: RowRail | undefined =
                threads !== undefined &&
                !viewRoot &&
                (plan.role !== null || (rootCard && !row.message.mine))
                  ? {
                      role: plan.role,
                      geometry: rowGeometry({
                        role: plan.role,
                        mine: row.message.mine,
                        isGroup: props.isGroup,
                        photo: props.isGroup && !row.message.mine && row.head,
                        selecting: false,
                        viewRoot,
                        rootCard,
                      }),
                    }
                  : undefined;
              // L4: the thread screen's root (any message, not only a card)
              // heads the "N replies" separator; the main chat draws the
              // replies row instead (repliesFor).
              // 9 Nov 2026: the one thread strip shows at 0 too ("Reply in thread").
              const strip = threads !== undefined && viewRoot;
              // 9 Nov 2026: the thread view's root and replies (threadWhen times).
              const inView = threads?.viewRootId !== undefined;
              const threadPlace = inView ? (viewRoot ? 'root' : 'reply') : undefined;
              const rowMeta = inView
                ? {
                    ...row.meta,
                    time: threadWhen(row.message.time, viewRoot ? 'date' : 'relative'),
                  }
                : row.meta;
              const replies = strip ? replyCountLabel(threads.countOf(row.message.id)) : null;
              if (strip) afterStrip = true;
              const repliesRow =
                props.repliesFor !== undefined && props.selection === undefined
                  ? props.repliesFor(row.message)
                  : null;
              const openThread = (rootId: string): void => threads?.onOpen(rootId);
              const id = row.message.id;
              // The chip as drawn: its post, and a tap that runs the latest chip's.
              const chipNow = props.chipFor?.(row.message);
              if (chipNow !== undefined) chipsRef.current.set(id, chipNow);
              else chipsRef.current.delete(id);
              const chip = rowCaches.chip(
                id,
                chipNow !== undefined
                  ? { kind: 'chip', post: chipNow.post, onTap: rowCaches.chipTap(id) }
                  : undefined,
              );
              return (
                <Fragment key={row.message.id}>
                  {unread?.kind === 'loaded' && unread.firstId === row.message.id ? (
                    <UnreadDivider count={unread.count} />
                  ) : null}
                  {threads !== undefined && chipRoot !== null ? (
                    <ThreadChipRow
                      post={threads.postOf(chipRoot)}
                      count={threads.countOf(chipRoot)}
                      coarse={coarsePointer}
                      onOpen={() => openThread(chipRoot)}
                    />
                  ) : null}
                  {/* One broken message never blanks the thread: it shows a line instead. */}
                  <ErrorBoundary
                    name="chat-message"
                    fallback={
                      <p
                        data-message-fallback=""
                        className={cn(
                          'px-4 py-1 text-sm text-fg-3',
                          row.message.mine && 'text-right',
                        )}
                      >
                        {"Couldn't show this message"}
                      </p>
                    }
                  >
                    <MessageRow
                      message={row.message}
                      profiles={props.profiles}
                      cache={props.cache}
                      presignEnabled={props.presignEnabled}
                      showTicks={props.showTicks}
                      isGroup={props.isGroup}
                      head={row.head || firstUnderStrip}
                      tail={row.tail}
                      afterLabel={afterLabel}
                      layout={props.layout}
                      viewerUserId={props.viewerUserId}
                      mentions={rowMentions}
                      workspaceId={props.workspaceId}
                      meta={rowCaches.meta(id, rowMeta)}
                      onOpen={onOpenRow}
                      onOpenImage={onOpenImage}
                      hoverMenu={hoverMenu}
                      coarsePointer={coarsePointer}
                      reducedMotion={reducedMotion}
                      onSwipeReply={onSwipeReply}
                      replyBlocked={props.threads?.viewRootId !== undefined}
                      onSwipeDelete={onSwipeDelete}
                      canSwipeDelete={canSwipeDelete}
                      onJumpToMessage={onJumpToMessage}
                      {...(openPrivateReplyHref !== undefined ? { onOpenPrivateReply } : {})}
                      nextVoiceId={voiceNext.get(row.message.id) ?? null}
                      onTranscribe={onTranscribeRow}
                      quoted={
                        row.message.reply !== null
                          ? messagesById.get(row.message.reply.id)
                          : undefined
                      }
                      postRefs={rowCaches.postRefs(id, {
                        chip,
                        onTalkAbout: onTalkAboutRow,
                        onTalkAboutFocus: onTalkAboutFocusRow,
                      })}
                      threadMember={props.hideQuotes === true || memberOf?.(row.message) != null}
                      threadPlace={threadPlace}
                      rail={rowCaches.rail(id, rowRail)}
                      {...(props.selection !== undefined
                        ? {
                            selection: rowCaches.selection(id, {
                              ...rowSelection(row.message, props.selection),
                              onToggle: rowCaches.toggle(id),
                            }),
                          }
                        : {})}
                      {...(onRetryRow !== undefined ? { onRetry: onRetryRow } : {})}
                      {...(onDiscardRow !== undefined && props.selection === undefined
                        ? { onDiscard: onDiscardRow }
                        : {})}
                      {...(onHideRow !== undefined && props.selection === undefined
                        ? { onHideMessage: onHideRow }
                        : {})}
                      {...(onCancelUploadRow !== undefined
                        ? { onCancelUpload: onCancelUploadRow }
                        : {})}
                      {...(onOpenReactionsRow !== undefined && props.selection === undefined
                        ? { onOpenReactions: onOpenReactionsRow }
                        : {})}
                      {...(onToggleReactionRow !== undefined && props.selection === undefined
                        ? { onToggleReaction: onToggleReactionRow }
                        : {})}
                      selectingText={selectingTextId === row.message.id}
                    />
                  </ErrorBoundary>
                  {repliesRow !== null ? (
                    <RepliesRow
                      label={repliesRow.label}
                      repliers={repliesRow.repliers}
                      time={repliesRow.time}
                      unread={repliesRow.unread}
                      coarse={coarsePointer}
                      onOpen={() => repliesRow.onOpen()}
                    />
                  ) : null}
                  {strip ? (
                    <RepliesSeparatorRow
                      label={replies}
                      through={plan.continues}
                      coarse={coarsePointer}
                      family="chat"
                      className="mb-2 mt-3"
                      onFocusReply={threads?.onFocusReply}
                      actions={rootActionsFor(row.message)}
                    />
                  ) : null}
                  {props.reading?.seen?.messageId === row.message.id ? (
                    <SeenLine readAt={props.reading.seen.readAt} rail={plan.continues} />
                  ) : null}
                  {props.reading?.readBy?.messageId === row.message.id ? (
                    <ReadByLine
                      label={props.reading.readBy.label}
                      onOpen={() => props.onOpenReadInfo?.()}
                      rail={plan.continues}
                    />
                  ) : null}
                </Fragment>
              );
            },
            // The thread view's Load older reads the older page: only once
            // the window is at the first loaded row (above it, scrolling up
            // mounts the loaded rows).
            props.loadOlderRow === true && props.hasMore === true && win.start === 0
              ? () => {
                  const el = listRef.current;
                  if (el === null || anchorHeightRef.current !== null) return;
                  // The prepended page keeps the reader where they were.
                  anchorHeightRef.current = el.scrollHeight;
                  props.onLoadOlder?.();
                }
              : undefined,
            props.layout,
            coarsePointer,
            taskCtx !== undefined
              ? (row) => <TaskEventLine key={row.key} line={row.line} ctx={taskCtx} />
              : undefined,
            olderFailed && props.loadingOlder !== true && win.start === 0 ? retryOlder : undefined,
            props.threads?.viewRootId !== undefined,
          )}
        </ul>
        {unread !== undefined && unread !== null && pill !== 'unknown' ? (
          <UnreadPill
            count={unread.count}
            visible={pill === 'show'}
            onJump={() => props.onJumpFirstUnread?.()}
          />
        ) : null}
        <LatestButton visible={showLatest} count={newCount} onTap={toLatest} />
      </div>
      <MessageActionMenu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.rect ?? null}
        mine={menu?.message.mine ?? false}
        canReact={menu !== null && menu.message.state === 'sent'}
        reactionsOnly={menu?.reactionsOnly === true}
        canEdit={props.onEditMessage !== undefined && menuOwn.canEdit && !menuPlan}
        onEdit={() => {
          if (menu) props.onEditMessage?.(menu.message);
        }}
        canDelete={
          (props.onDeleteMessage !== undefined && menuDelete.canDelete) ||
          (menuFailed && props.onDiscard !== undefined)
        }
        onDelete={() => {
          if (!menu) return;
          // A failed send never left the device: it goes at once, no confirm.
          if (menuFailed) props.onDiscard?.(menu.message.id);
          else props.onDeleteMessage?.(menu.message, menu.openedAt);
        }}
        failedSend={menuFailed}
        deleteForMeOnly={menuDelete.forMeOnly}
        notes={props.notes === true}
        canSaveToNotes={
          menu !== null &&
          props.onSaveToNotes !== undefined &&
          canSaveToNotes(menu.message) &&
          !menuPlan
        }
        onSaveToNotes={() => {
          if (menu) props.onSaveToNotes?.(menu.message);
        }}
        canRemoveFile={menuRemoveFile !== undefined}
        onRemoveFile={() => {
          if (menu === null || menuRemoveFile === undefined) return;
          onRemoveFiles?.([
            {
              messageId: menu.message.id,
              assetId: menuRemoveFile.assetId,
              mime: menuRemoveFile.mime,
            },
          ]);
        }}
        currentReaction={menu ? (menu.message.reactions.find((r) => r.mine)?.emoji ?? null) : null}
        canCopy={menu ? menu.message.body.trim() !== '' || menuPlanTitle !== null : false}
        canTranscribe={
          menu !== null &&
          props.onTranscribe !== undefined &&
          isTranscribable(menu.message) &&
          canOfferTranscribe(menuVoice.record, menuVoice.pending)
        }
        onTranscribe={() => {
          if (menu) props.onTranscribe?.(menu.message);
        }}
        canForward={
          menu !== null &&
          props.onForwardMessage !== undefined &&
          canForward(menu.message) &&
          !menuPlan
        }
        onForward={() => {
          if (!menu) return;
          anchorSelection(menu.message);
          // The picker opened without selection: nothing to restore.
          if (props.onForwardMessage?.(menu.message) !== true) selectionScroll.cancelEntry();
        }}
        canSelectText={
          menu !== null && props.selection === undefined && canSelectMessageText(menu.message)
        }
        onSelectText={() => {
          if (menu) startTextSelect(menu.message.id);
        }}
        onReact={(emoji) => {
          if (menu && menu.message.state === 'sent')
            props.onToggleReaction?.(
              menu.message.id,
              emoji,
              menu.message.reactions.find((r) => r.mine)?.emoji === emoji,
            );
        }}
        canReply={props.threads?.viewRootId === undefined}
        onReply={() => {
          if (menu) props.onReply(menu.message);
        }}
        canMarkUnread={
          menu !== null &&
          props.onMarkUnread !== undefined &&
          menu.message.state === 'sent' &&
          menu.message.deleted !== true
        }
        onMarkUnread={() => {
          if (menu) props.onMarkUnread?.(menu.message);
        }}
        canAddToTasks={
          menu !== null &&
          props.onAddToTask !== undefined &&
          menu.message.state === 'sent' &&
          menu.message.deleted !== true &&
          !menuPlan &&
          taskTitleOf(menu.message) !== ''
        }
        onAddToTasks={() => {
          if (menu) props.onAddToTask?.(menu.message);
        }}
        canCopyLink={
          menu !== null && props.onCopyLink !== undefined && menu.message.state === 'sent'
        }
        onCopyLink={() => {
          if (menu) props.onCopyLink?.(menu.message);
        }}
        canReplyPrivately={menuReplyPrivately}
        replyPrivatelyName={menu !== null ? senderName(menu.message, props.profiles) : ''}
        onReplyPrivately={() => {
          if (menu !== null && menuReplyPrivately) replyPrivately?.open(menu.message);
        }}
        onCopy={() => {
          if (menu) {
            // A plan card with no text copies the plan's title.
            const text =
              menu.message.body.trim() === '' && menuPlanTitle !== null
                ? menuPlanTitle
                : resolveMentionText(
                    menu.message.body,
                    profileNameOf(props.profiles, props.workspaceId ?? null),
                  );
            void copyText(text).then((ok) =>
              toast.show({ title: ok ? 'Message copied' : COPY_FAILED }),
            );
          }
        }}
      />
      {viewer !== null && viewerData !== null && viewerData.images.length > 0 ? (
        <ImageLightbox
          images={viewerData.images}
          index={Math.min(viewer.index, viewerData.images.length - 1)}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
          details={viewerData.details}
          onIndexChange={(index) =>
            setViewer((prev) => (prev !== null ? { ...prev, index } : prev))
          }
          onClose={() => setViewer(null)}
        />
      ) : null}
    </PersonSourceContext.Provider>
  );
}

/** The latest page failed or timed out: one line and a 44px Retry, in place of the empty state. */
export function threadLoadError(onRetry: (() => void) | undefined): ReactElement {
  return (
    <div data-thread-load-error="" className="flex flex-1 flex-col justify-center">
      <EmptyState
        icon={<IconChat size={ICON_SIZE.tray} />}
        title="Couldn't load messages"
        {...(onRetry !== undefined
          ? {
              action: (
                <Button variant="ghost" className="min-w-11" onClick={onRetry}>
                  Retry
                </Button>
              ),
            }
          : {})}
      />
    </div>
  );
}

/**
 * The history failed but the chat has pending or failed sends on screen: the
 * same line and 44px Retry as a row above them, so the sends stay visible.
 */
export function threadLoadErrorRow(onRetry: (() => void) | undefined): ReactElement {
  return (
    <li
      key="load-failed"
      data-thread-load-error=""
      className="flex items-center justify-center gap-3 px-4 py-2 text-base text-fg-2"
    >
      <span>Couldn&apos;t load messages</span>
      {onRetry !== undefined ? (
        <Button variant="ghost" className="min-w-11" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </li>
  );
}

/** FN22: the empty Personal notes chat. */
export const NOTES_EMPTY_TITLE = 'Your private notes live here.';
export const NOTES_EMPTY_LINE = 'Only you can see them.';

/**
 * FT41: an older page that failed to load. The line and a 44px Retry sit at
 * the top of the list in place of Load older; the loaded rows stay below.
 */
export function olderLoadErrorRow(onRetry: () => void): ReactElement {
  return (
    <li
      key="older-load-failed"
      role="alert"
      data-older-load-error=""
      className="flex items-center justify-center gap-3 px-4 py-2 text-base text-fg-2"
    >
      <span>{OLDER_LOAD_FAILED}</span>
      <Button variant="ghost" className="min-w-11" onClick={onRetry}>
        Retry
      </Button>
    </li>
  );
}

/**
 * iOS Safari 26 (and every WebKit iOS or in-app browser) tints its own top bar
 * from a solid fixed element at the top edge, else the canvas (--bg). A phone
 * chat thread is locked (src/lib/scroll-mode.ts): the Topbar is hidden and the
 * header sits inside <main>, so this strip, the status bar inset tall, in the
 * header's own fill and just under it (the header is z-1, lit-header), gives
 * Safari --panel to sample. Same surface as the header: no lit-* of its own,
 * no blur, no opacity. 0px tall where there is no inset (laptop, Playwright).
 * Phone only (src/lib/bar-tint.ts).
 */
export function ThreadTopStrip({ layout }: { layout: ChatLayout }): ReactElement | null {
  if (layout === 'laptop') return null;
  return (
    <div
      aria-hidden="true"
      data-thread-top-strip=""
      className="pointer-events-none fixed inset-x-0 top-0 z-base h-[env(safe-area-inset-top,0px)] bg-panel"
    />
  );
}

/**
 * A chat being opened before its row is known (a deep link, an Activity tap,
 * a reload inside the thread): the thread's own header and message
 * placeholders from the first frame, never another screen first.
 */
export function threadOpeningSkeleton(
  layout: ChatLayout = 'touch',
  onBack?: () => void,
): ReactElement {
  return (
    <div data-thread-opening="" aria-busy="true" className="flex h-full min-h-0 flex-col bg-bg">
      <ThreadTopStrip layout={layout} />
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-3 border-b bg-panel lit-header',
          sized(HEADER_PAD, layout),
        )}
      >
        {onBack !== undefined ? (
          <IconButton label="Back to conversations" onClick={onBack}>
            <IconChevronLeft size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        <Bone lit="lit-avatar" as="div" className="h-9 w-9 shrink-0 rounded-lg" />
        <Bone lit="flat" as="div" className="h-3 w-32 rounded" />
      </div>
      {threadSkeleton()}
    </div>
  );
}

/** The distinct shared post, brief and plan ids across a thread's messages (deleted ones skipped). Pure. */
export function threadCardIds(messages: readonly ThreadMessage[]): {
  postIds: string[];
  briefIds: string[];
  planIds: string[];
} {
  const posts = new Set<string>();
  const briefs = new Set<string>();
  const plans = new Set<string>();
  for (const m of messages) {
    if (m.deleted === true) continue;
    for (const id of m.sharedPostIds) posts.add(id);
    for (const id of m.sharedBriefIds) briefs.add(id);
    for (const id of m.sharedPlanIds ?? []) plans.add(id);
  }
  return { postIds: [...posts], briefIds: [...briefs], planIds: [...plans] };
}

/** Placeholder bubble widths for the loading thread, alternating sides. */
export const THREAD_SKELETON_WIDTHS = ['w-[55%]', 'w-[40%]', 'w-[70%]', 'w-[45%]', 'w-[60%]'];

/**
 * The loading thread: five bubble-shaped boxes alternating other / own side
 * (a top-lit sweep, never a pulse), no text, never the empty state. Only when
 * nothing is held for the chat; a kept or cached thread paints its rows.
 */
export function threadSkeleton(): ReactElement {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading messages"
      className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-4"
    >
      {THREAD_SKELETON_WIDTHS.map((width, i) => (
        <li key={width} data-skeleton-bubble={i % 2 === 1 ? 'own' : 'other'} className="flex">
          {/* L1: every skeleton line on the left, flat, no bubble light. */}
          <Bone lit="flat" className={cn('h-10 rounded-lg', width)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Selection-mode state for one row: any recorded, live message can be checked;
 * deleted and pending ones show nothing.
 */
export function rowSelection(
  message: ThreadMessage,
  selection: { selected: ReadonlySet<string>; onToggle: (id: string) => void },
): RowSelection {
  return {
    role: threadSelectionRole(message),
    checked: selection.selected.has(message.id),
    onToggle: () => selection.onToggle(message.id),
  };
}

/** The selection a menu Select, Forward or Delete opens with: that message ticked when it can be. */
export function selectionOnEntry(message: ThreadMessage): Set<string> {
  return threadSelectable(message) ? new Set([message.id]) : new Set();
}

/**
 * Whether the menu's Forward enters selection mode (the message ticked) rather
 * than opening the picker for it alone: always, where selection mode exists.
 */
export function forwardEntersSelection(
  message: ThreadMessage,
  selectionAvailable: boolean,
): boolean {
  return selectionAvailable && threadSelectable(message);
}

/**
 * One new-rows pass while an older-page load holds its anchor (the list's
 * scrollHeight when the load began). When the older rows painted (the first
 * row changed) the list scrolls by the height they added and the anchor is
 * done. Otherwise (the page is still held; rows changed below) nothing scrolls
 * and the anchor re-bases on the current height, so later growth below never
 * counts toward the compensation. Pure.
 */
export function olderPageAnchorStep(input: {
  anchorHeight: number;
  prepended: boolean;
  scrollHeight: number;
}): { scrollBy: number; anchorHeight: number | null } {
  if (input.prepended)
    return { scrollBy: input.scrollHeight - input.anchorHeight, anchorHeight: null };
  return { scrollBy: 0, anchorHeight: input.scrollHeight };
}

/** The slice of the thread list selection anchoring reads (the <ul>, or a test fake). */
export interface AnchorList {
  scrollTop: number;
  querySelector: (selectors: string) => { getBoundingClientRect: () => { top: number } } | null;
}

/** A row's on-screen Y, taken before the selection column appears. */
export interface RowAnchor {
  id: string;
  top: number;
}

function rowSelector(id: string): string {
  return `[data-msg-id="${id.replace(/["\\]/g, '\\$&')}"]`;
}

/** Pop `part` of the message's row(s) on screen (the main list and an open thread view). */
function popRowPart(id: string, part: string): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`${rowSelector(id)} ${part}`).forEach((el) => pop(el));
}

/** Pop a row's part when `value` grows after the row's first paint (a reaction). */
function usePopOnRise(id: string, part: string, value: number): void {
  const prev = useRef(value);
  useLayoutEffect(() => {
    if (value > prev.current) popRowPart(id, part);
    prev.current = value;
  }, [id, part, value]);
}

/**
 * The first message row whose bottom is below the list's top edge, and its
 * screen Y (rows are in order, so a binary search over their bottoms); null
 * when no row is rendered.
 */
export function firstVisibleRow(list: HTMLElement): RowAnchor | null {
  const rows = list.querySelectorAll<HTMLElement>('[data-msg-id]');
  const top = list.getBoundingClientRect().top;
  let lo = 0;
  let hi = rows.length - 1;
  let found: HTMLElement | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid];
    if (row === undefined) break;
    if (row.getBoundingClientRect().bottom > top) {
      found = row;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const id = found?.dataset.msgId;
  return found === null || id === undefined ? null : { id, top: found.getBoundingClientRect().top };
}

/** The row's current screen Y, or null when it is not rendered. */
export function captureRowAnchor(list: AnchorList, id: string): RowAnchor | null {
  const row = list.querySelector(rowSelector(id));
  return row === null ? null : { id, top: row.getBoundingClientRect().top };
}

/**
 * After the 60px check column rewraps the bubbles, scroll (instantly) so the
 * anchored row is back at its screen Y. Returns the scroll change.
 */
export function restoreRowAnchor(list: AnchorList, anchor: RowAnchor): number {
  const row = list.querySelector(rowSelector(anchor.id));
  if (row === null) return 0;
  const delta = row.getBoundingClientRect().top - anchor.top;
  if (delta !== 0) list.scrollTop += delta;
  return delta;
}

/** Selection mode's scroll bookkeeping; see createSelectionScroll. */
export interface SelectionScroll {
  /** A menu entry (Select, Forward, Delete) on this row: remember where it sits. */
  anchorEntry: (list: AnchorList | null, id: string) => void;
  /** Menu Forward opened the picker without entering selection: forget the anchor. */
  cancelEntry: () => void;
  /**
   * Selection turned on: record whether the thread was pinned to the bottom,
   * and hand back the anchor to restore (null when none was taken).
   */
  entered: (pinned: boolean) => RowAnchor | null;
  /** Selection is turning off; the old layout is still on screen: re-take the anchor row's Y. */
  beforeExit: (list: AnchorList | null) => void;
  /** Selection turned off: re-pin when it was pinned at entry, else restore the anchor (if any). */
  exited: () => { pin: true } | { pin: false; anchor: RowAnchor | null };
  /** The anchor waiting to be restored (tests). */
  pending: () => RowAnchor | null;
}

/**
 * Selection entry and exit keep the reader's place: entry restores the pressed
 * row's screen Y after the check column rewraps the bubbles; exit restores the
 * same row's Y, or re-pins to the latest message when the thread was pinned at
 * entry. The anchor is dropped on every exit and when Forward opens the picker
 * without entering selection. Framework-free.
 */
export function createSelectionScroll(): SelectionScroll {
  let anchor: RowAnchor | null = null;
  let anchorId: string | null = null;
  let pinnedAtEntry = false;
  return {
    anchorEntry: (list, id) => {
      anchor = list !== null ? captureRowAnchor(list, id) : null;
      anchorId = id;
    },
    cancelEntry: () => {
      anchor = null;
      anchorId = null;
    },
    entered: (pinned) => {
      pinnedAtEntry = pinned;
      const taken = anchor;
      anchor = null;
      return taken;
    },
    beforeExit: (list) => {
      anchor = list !== null && anchorId !== null ? captureRowAnchor(list, anchorId) : null;
    },
    exited: () => {
      const taken = anchor;
      const pin = pinnedAtEntry;
      anchor = null;
      anchorId = null;
      pinnedAtEntry = false;
      return pin ? { pin: true } : { pin: false, anchor: taken };
    },
    pending: () => anchor,
  };
}

/** The history.state key that marks the entry selection mode pushed. */
export const SELECTION_HISTORY_KEY = 'chatSelection';

/** The slice of window selection history needs (the real window, or a test fake). */
export type SelectionHistoryWindow = HistoryStepWindow;

/** One selection mode's history entry; see enterSelectionHistory. */
export interface SelectionHistory {
  /**
   * Cancel, Escape, the header chevron: pop the marker; its popstate exits,
   * then runs `then` (a channel switch). Repeat calls while leaving are ignored.
   */
  cancel: (then?: () => void) => void;
  /** Selection ended another way (delete, forward) or the thread unmounts. */
  dispose: () => void;
}

/** How many buried markers the guard remembers (the most recent ones). */
export const BURIED_MARKERS_LIMIT = BURIED_STEPS_LIMIT;

/** How many markers are buried (tests). */
export function buriedMarkerCount(): number {
  return buriedStepCount();
}

/**
 * Selection mode's history entry (WhatsApp: system back and the iOS swipe-back
 * leave selection first): one step of the shared mechanism
 * (lib/chat/use-history-step), under its own key. Entering pushes one entry
 * at the same URL (the ?channel= included); a popstate off it exits selection
 * and stays in the chat. cancel() leaves through history.back(), so the marker
 * never lingers, and only once however often it is pressed; dispose() pops it
 * too when selection ended some other way, and a marker buried under a
 * navigation is skipped if ever landed on. While open, a channel switch
 * (leaveSelectionThen) goes through cancel() first; a dispose() while that
 * back() is pending still runs the switch once the pop lands.
 */
export function enterSelectionHistory(
  win: SelectionHistoryWindow,
  onExit: () => void,
): SelectionHistory {
  return enterHistoryStep(win, SELECTION_HISTORY_KEY, onExit);
}

/** Test seam: forget buried markers, open steps and the guard. */
export function resetSelectionHistory(): void {
  resetHistorySteps();
  clearSelectionLeave(null);
}

/** The thread pane: header (+ optional back), message list, and composer. */
/**
 * The chat store's outbox settle, or null outside a provider (unit tests
 * render the thread bare). The context read runs on every render either way.
 */
function useOutboxSettle(): ((channelId: string, id: string) => void) | null {
  try {
    return useChatStore().outbox.settle;
  } catch {
    return null;
  }
}

/**
 * Which failed sends were deleted here: they leave the outbox (so a reload
 * never brings them back) and the rows this thread draws, at once.
 */
export function withoutDiscarded(
  messages: ThreadMessage[],
  discarded: ReadonlySet<string>,
): ThreadMessage[] {
  if (discarded.size === 0) return messages;
  return messages.filter((m) => !discarded.has(m.id));
}

/**
 * Whether a menu Delete goes behind a 4s Undo (FT39) instead of the confirm:
 * a single message with no files (text, links, shared cards). A message with
 * files keeps the confirm. Pure.
 */
export function deleteHasUndo(message: Pick<ThreadMessage, 'attachments' | 'state'>): boolean {
  return message.state === 'sent' && message.attachments.length === 0;
}

/** The menu Delete's sheet target: one message, and whether it offers "Delete for everyone". */
interface DeleteSheetTarget {
  message: ThreadMessage;
  everyone: boolean;
}

/** Time since a message's server created_at at `nowMs`, or null when it has none. Pure. */
export function messageAgeMs(
  message: Pick<ThreadMessage, 'createdAt'>,
  nowMs: number,
): number | null {
  if (message.createdAt === '') return null;
  const created = Date.parse(message.createdAt);
  return Number.isNaN(created) ? null : nowMs - created;
}

/** The Undo toast's title for a deleted message. */
export const MESSAGE_DELETED_UNDO = 'Message deleted';

/** Lay local tombstones (a delete inside its Undo window) over the list. Pure. */
export function withUndoTombstones(
  messages: ThreadMessage[],
  tombstoned: ReadonlySet<string>,
): ThreadMessage[] {
  if (tombstoned.size === 0) return messages;
  return markMessagesDeleted(messages, [...tombstoned]);
}

/**
 * The live chat connection, or null outside a ChatProvider (tests, previews)
 * or before it opens. useChat throws outside a provider; the hook itself
 * always runs, so the hook order never changes.
 */
function useLiveChatClient(): ChatConnection | null {
  try {
    return useChat().client;
  } catch {
    return null;
  }
}

/**
 * One removal behind the Undo strip: the files leave the overlay store at once
 * (every surface updates); the strip reads "1 photo removed"; the commit runs
 * the record, purge and signal; Undo puts the files back. A refused record
 * brings back only the files it refused and toasts its copy ("Couldn't
 * remove. Only your own files can be removed."). No confirm.
 */
export function removeFilesAction(input: {
  store: Pick<ReturnType<typeof createRemovedFilesStore>, 'add'>;
  channelId: string;
  files: RemovableFile[];
  remove: () => Promise<RemoveFilesOutcome>;
  showToast: (title: string) => void;
}): UndoableAction {
  let undo = input.store.add(input.channelId, input.files);
  return {
    label: removedFilesLabel(removedCountsOf(input.files.map((f) => f.mime))),
    commit: async () => {
      const result = await input.remove();
      if (result.ok) return;
      undo();
      undo = input.store.add(input.channelId, result.removed);
      input.showToast(result.message);
    },
    revert: () => undo(),
  };
}

/** The chat's purge-chat call for removed files (as use-chat-thread's delete path). */
async function purgeRemovedFiles(
  workspaceId: string | null,
  assetIds: string[],
  traceId: string,
): Promise<PurgeChatOutcome> {
  const endpoint = env.VITE_ASSET_UPLOAD_URL;
  if (endpoint === undefined || endpoint === '' || workspaceId === null) {
    return { ok: false, error: 'purge-chat not configured' };
  }
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
  if (token === '') return { ok: false, error: 'no session' };
  return purgeChatFiles({
    endpoint,
    token,
    workspaceId,
    assetIds,
    fetcher: (input, init) => fetchWithTrace(input, init, traceId),
  });
}

/** The view's extra seam: tombstone a row locally (on) or bring it back (off). */
type MessageThreadViewProps = MessageThreadProps & {
  tombstone?: (messageId: string, on: boolean) => void;
};

export function MessageThread(props: MessageThreadProps): ReactElement {
  const settle = useOutboxSettle();
  const [discarded, setDiscarded] = useState<ReadonlySet<string>>(() => new Set());
  // Deletes waiting out their Undo window (and kept once committed, until the
  // list itself carries the tombstone).
  const [tombstoned, setTombstoned] = useState<ReadonlySet<string>>(() => new Set());
  const tombstone = useCallback((messageId: string, on: boolean) => {
    setTombstoned((prev) => {
      if (prev.has(messageId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);
  const channelId = props.channelId;
  const propDiscard = props.onDiscard;
  const onDiscard = useMemo<((messageId: string) => void) | undefined>(() => {
    if (propDiscard !== undefined) return propDiscard;
    if (settle === null || channelId === undefined) return undefined;
    return (messageId: string) => {
      settle(channelId, messageId);
      setDiscarded((prev) => new Set(prev).add(messageId));
    };
  }, [propDiscard, settle, channelId]);
  // Files removed in this chat (here behind the Undo, or live by a peer): every
  // bubble, the viewer and the counts read them at once.
  const removedOverlay = useSyncExternalStore(
    removedFilesStore.subscribe,
    () => removedFilesStore.get(channelId ?? ''),
    () => removedFilesStore.get(channelId ?? ''),
  );
  const messages = useMemo(
    () =>
      applyRemovedOverlay(
        withUndoTombstones(withoutDiscarded(props.messages, discarded), tombstoned),
        removedOverlay,
      ),
    [props.messages, discarded, tombstoned, removedOverlay],
  );
  // A peer removed files: re-read those rows (never the payload) into the overlay.
  const liveClient = useLiveChatClient();
  useEffect(() => {
    if (liveClient === null || channelId === undefined) return;
    return subscribeFilesRemoved(liveClient, ({ messageIds, fromUserId }) => {
      void rereadRemovedRows(supabase, { channelId, messageIds, fromUserId }).then((read) => {
        if (read.ok) removedFilesStore.applyRows(channelId, read.data);
        else logger.warn('chat: files removed re-read failed', { error: read.error.message });
      });
    });
  }, [liveClient, channelId]);
  return (
    <MessageThreadView
      {...props}
      messages={messages}
      tombstone={tombstone}
      {...(onDiscard !== undefined ? { onDiscard } : {})}
    />
  );
}

function MessageThreadView(props: MessageThreadViewProps): ReactElement {
  const { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe } =
    useChatAttachments();
  // Transcribe on tap: this device only. The Worker fetches the audio from the
  // same presigned URL the player uses; the result lives in the transcript store.
  const onTranscribe = useCallback(
    (message: ThreadMessage): void => {
      const only = message.attachments[0];
      if (only === undefined) return;
      void transcribeVoiceNote({
        messageId: message.id,
        // The transcriber fetches the audio from storage itself: a storage URL.
        fetchAudio: async () => (await presignCache.storageUrl(only.assetId)).url,
        transcribe,
      });
    },
    [presignCache, transcribe],
  );
  // Everything per chat is keyed on the channel id (the parent also remounts
  // the thread per channel), never the title.
  const channelId = props.channelId;
  // The stop square on an own uploading send: the caller's handler, else this chat's outbox.
  const storeCancel = useCancelUpload();
  const propCancel = props.onCancelUpload;
  const onCancelUpload = useMemo<((messageId: string) => void) | undefined>(() => {
    if (propCancel !== undefined) return propCancel;
    if (storeCancel === null || channelId === undefined) return undefined;
    return (messageId: string) => {
      storeCancel(channelId, messageId);
    };
  }, [propCancel, storeCancel, channelId]);
  const channelKey = channelId ?? props.title;
  // The reply chip is part of this chat's draft: it starts from the draft map
  // on the first render (a switch back paints it on its first frame).
  const [replyDraft, setReplyDraftState] = useState<DraftReply | null>(() =>
    channelId !== undefined ? getDraft(channelId).reply : null,
  );
  const setReplyDraft = (next: DraftReply | null): void => {
    setReplyDraftState(next);
    if (channelId !== undefined) setDraft(channelId, { reply: next });
  };
  // A mouse or trackpad (input, not layout): the composer takes the cursor when the chat opens.
  const finePointer = useHoverPointer();
  // The size table by width: touch (phones) or laptop (768px and up, iPad included).
  const layout = useChatLayout();
  // The post the conversation is about: sends with no reply draft reply to its
  // card message. Independent of the reply draft; only its X clears it.
  const [aboutDraft, setAboutDraft] = useState<{ postId: string; cardMessageId: string } | null>(
    null,
  );
  // Card threads: each row's thread is decided once, at its first paint.
  const frozenRef = useRef<MembershipMap>(new Map());
  // Reply counts of root cards that are not loaded: one read per history page.
  const [countsVersion, setCountsVersion] = useState(0);
  const countsRef = useRef<ThreadCounts | null>(null);
  const rootCreatedAtRef = useRef(props.rootCreatedAt);
  rootCreatedAtRef.current = props.rootCreatedAt;
  countsRef.current ??= createThreadCounts((rootIds) =>
    channelId !== undefined
      ? loadThreadReplyCounts(supabase, channelId, rootIds, generateTraceId(), (id) =>
          rootCreatedAtRef.current?.(id),
        )
      : Promise.resolve({ ok: true, data: new Map() }),
  );
  const counts = countsRef.current;
  // The open card thread (full screen over the chat) and its reply draft.
  const threadView = useThreadView({ channelId, currentUserId: props.currentUserId ?? '' });
  const [, setViewReply] = useState<DraftReply | null>(null);
  const view = threadView.view;
  // L3: a Reply opens the thread with its composer focused.
  const [viewFocus, setViewFocus] = useState(false);
  // L5/L6b: the threads I am in, one chat_threads_for_me call started with the
  // chat (in parallel with the first history page, never awaited before the
  // first paint); a later reply from someone else reads it again.
  const [threadsForMe, setThreadsForMe] = useState<{
    channelId: string;
    rows: ThreadForMe[];
  } | null>(null);
  const latestReplyKey = useMemo(() => {
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const m = props.messages[i];
      if (m !== undefined && typeof m.threadRootId === 'string' && !m.mine) return m.id;
    }
    return null;
  }, [props.messages]);
  // L6b: whether this chat's first page has painted, and the threads-for-me
  // answer when it landed before that paint (only then may the chat open
  // straight onto the Threads sheet; a later answer shows the strip item only).
  const paintedRef = useRef<string | null>(null);
  const earlyThreadsRef = useRef<{ channelId: string; rows: ThreadForMe[] } | null>(null);
  const [threadsOpen, setThreadsOpen] = useState(false);
  useEffect(() => {
    if (channelId === undefined || props.notes === true) return;
    let live = true;
    void loadThreadsForMe(supabase, channelId, generateTraceId()).then((result) => {
      if (!live) return;
      if (!result.ok) {
        logger.warn('chat: threads for me read failed', { error: result.error.message });
        return;
      }
      if (paintedRef.current !== channelId) {
        earlyThreadsRef.current = { channelId, rows: result.data };
      }
      setThreadsForMe({ channelId, rows: result.data });
    });
    return () => {
      live = false;
    };
  }, [channelId, props.notes, latestReplyKey]);
  const myThreads =
    threadsForMe !== null && threadsForMe.channelId === channelId ? threadsForMe.rows : null;
  // The view's replies the chat has not loaded (older than its pages).
  const viewOnly = useMemo(() => {
    if (view === null) return [];
    const loaded = new Set(props.messages.map((m) => m.id));
    return view.fetched.filter((m) => !loaded.has(m.id));
  }, [view, props.messages]);
  // The open thread: its root, then its replies oldest first (the chat's loaded
  // rows win over the view's own copies, so live arrivals and own sends show).
  // The view's own rows (older than the chat's pages) take the removed-files
  // overlay too; the chat's rows already carry it.
  const viewOverlay = useSyncExternalStore(
    removedFilesStore.subscribe,
    () => removedFilesStore.get(channelId ?? ''),
    () => removedFilesStore.get(channelId ?? ''),
  );
  const viewParts = useMemo(() => {
    if (view === null) return null;
    const parts = threadViewRows(view, props.messages);
    const [root, ...replies] = applyRemovedOverlay([parts.root, ...parts.replies], viewOverlay);
    return root !== undefined ? { root, replies } : parts;
  }, [view, props.messages, viewOverlay]);
  const viewMessages = useMemo(
    () => (viewParts !== null ? [viewParts.root, ...viewParts.replies] : []),
    [viewParts],
  );
  // Every message an action can name: the chat's loaded rows and the view's own.
  const actionable = useMemo(
    () => (viewOnly.length > 0 ? [...props.messages, ...viewOnly] : props.messages),
    [props.messages, viewOnly],
  );
  // A share just sent: its card message becomes the About once the outbox bubble lands.
  const cardWaitRef = useRef(createCardExpectation());
  const cardWait = cardWaitRef.current;
  // Which rows are on screen: page rows wait for their chips, arrivals never do.
  const gateRef = useRef<PageGate | null>(null);
  // Bumped when a page row's hydration wait runs out, so it goes on without it.
  const [hydrationTick, setHydrationTick] = useState(0);
  const { workspaceId, workspaces } = useWorkspace();
  // The Tasks sheet's This week ends on the workspace week start (the zone is
  // props.timeZone); derived the way the Briefs and Pipeline surfaces do.
  const workspaceWeekStart = workspaces.find((w) => w.id === workspaceId)?.week_start_day ?? 1;
  const toast = useToast();
  const chatPage = props.chatPage === true;
  // The chat's task list (never in Personal notes; only where the chat page
  // wires the per-chat reads): read with the first page, so its change lines
  // paint with the messages, never after them.
  const taskChannel = props.notes === true || !chatPage ? null : (channelId ?? null);
  const taskSummary = useMemo(
    () => (props.forwardChannels ?? []).find((c) => c.channelId === taskChannel) ?? null,
    [props.forwardChannels, taskChannel],
  );
  const taskTargetKey =
    taskSummary === null
      ? ''
      : `${taskSummary.channelType}:${taskSummary.agoraGroupId ?? ''}:${taskSummary.peerUserId ?? ''}`;
  const taskTarget = useMemo(() => {
    if (taskSummary === null) return null;
    try {
      return targetFromSummary(taskSummary);
    } catch {
      return null;
    }
    // The same target while it routes the same way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskTargetKey]);
  const chatTasks = useChatTasks({
    channelId: taskChannel,
    currentUserId: props.currentUserId ?? '',
    target: taskTarget,
    profiles: props.profiles,
  });
  // `seenAtOpen`: this device's seen time when the sheet opened (its dots are
  // the changes after it); the new seen time is written when the sheet closes.
  const [taskSheet, setTaskSheet] = useState<{
    open: boolean;
    focus: string | null;
    seenAtOpen: number | null;
    prefill: string | null;
  }>({ open: false, focus: null, seenAtOpen: null, prefill: null });
  const seenKey = taskChannel !== null ? tasksSeenKey(taskChannel) : null;
  const [seenMs, setSeenMs] = useState<{ key: string | null; ms: number | null }>(() => ({
    key: seenKey,
    ms: seenKey !== null ? readTasksSeen(seenKey) : null,
  }));
  const seenNow =
    seenMs.key === seenKey ? seenMs.ms : seenKey !== null ? readTasksSeen(seenKey) : null;
  const taskUnseen = hasUnseenChanges(chatTasks.events, props.currentUserId ?? '', seenNow);
  const refetchTasks = chatTasks.refetch;
  const openTasks = useCallback(
    (focus: string | null, prefill: string | null = null): void => {
      setTaskSheet({
        open: true,
        focus,
        seenAtOpen: seenKey !== null ? readTasksSeen(seenKey) : null,
        prefill,
      });
      refetchTasks();
    },
    [seenKey, refetchTasks],
  );
  const closeTasks = useCallback((): void => {
    if (seenKey !== null) {
      const now = Date.now();
      writeTasksSeen(seenKey, now);
      setSeenMs({ key: seenKey, ms: now });
    }
    setTaskSheet((prev) => (prev.open ? { ...prev, open: false } : prev));
  }, [seenKey]);
  // Leaving the chat closes its sheet.
  useEffect(() => {
    setTaskSheet({ open: false, focus: null, seenAtOpen: null, prefill: null });
  }, [taskChannel]);
  // One layer, one back step: back from the sheet is the thread.
  useHistoryStep(taskSheet.open, 'chatTasks', closeTasks);
  // Open loops: posts in review (two reads per thread open) and the viewer's side.
  const viewerSide = useViewerSide(workspaceId);
  const openPosts = useOpenPosts(workspaceId, channelKey, undefined, {
    userId: props.currentUserId ?? null,
    channelId: channelId ?? null,
  });
  // The status ticker's plans and briefs (only on the chat page).
  const livePlanIds = useMemo(
    () => [...new Set(props.messages.flatMap((m) => m.sharedPlanIds ?? []))],
    [props.messages],
  );
  const statusCounts = useStatusCounts({
    workspaceId: chatPage ? workspaceId : null,
    channelId: channelId ?? null,
    livePlanIds,
    userId: props.currentUserId ?? null,
  });
  const statusPlanCards = usePlanCards();
  // Read only (no subscription here): ThreadViewTitled re-renders the header alone.
  const briefCards = useSharedCardCache(false);
  // Chat open, paint together: the first page waits (at most OPEN_HOLD_MS from
  // the tap, else from this mount) for the viewer side, the ticker's
  // inputs and the bundles of the plan cards on it, so they all paint in one
  // frame. Once released it never holds again; whatever is still loading then
  // keeps its same-size placeholder and fills in place.
  const [openAt] = useState(() => {
    const key = chatKey(props.currentUserId, workspaceId, channelId);
    const tapped = key !== null ? openCache.openedAt(key) : null;
    const now = Date.now();
    return tapped !== null && now - tapped < OPEN_HOLD_MS ? tapped : now;
  });
  const [openHoldDone, setOpenHoldDone] = useState(false);
  // The ticker's reads are fresh shared reads (this chat's or another's within
  // the window), so it paints at once (never the inert slot) while the page
  // loads. Older than the window they are not held: it waits as a cold open.
  const [tickerRemembered] = useState(
    () => peekStatusRound(props.currentUserId, workspaceId, channelId ?? null) !== undefined,
  );
  const pageCards = useMemo(() => threadCardIds(props.messages), [props.messages]);
  const pagePlanIds = pageCards.planIds;
  // A chat whose page is remembered (opened before, or pre-warmed) paints its
  // kept rows in the first frame while nothing on it can change height after:
  // every plan card on it is known to be a full card (its skeleton is the
  // card's exact 217px). The ticker's pending slot and the side-dependent
  // cards keep their same-size placeholders and fill in place. A card of
  // unknown or other shape keeps it on the cold open's hold (same cap).
  const [keptOpen] = useState(() => {
    const key = chatKey(props.currentUserId, workspaceId, channelId);
    return key !== null && openCache.recall(key, 'thread') !== undefined;
  });
  const cardsSnapshot =
    statusPlanCards !== null && pagePlanIds.length > 0
      ? statusPlanCards.cache.snapshot(pagePlanIds)
      : null;
  const cardsSettled = cardsSnapshot === null || !cardsSnapshot.loading;
  const viewerId = props.currentUserId ?? null;
  const cardsSized =
    cardsSettled ||
    (viewerId !== null &&
      workspaceId !== null &&
      planCardsSized(viewerId, workspaceId, pagePlanIds));
  // Each settled plan read teaches the shapes the next kept open sizes from.
  useEffect(() => {
    if (cardsSnapshot === null || cardsSnapshot.loading) return;
    if (viewerId === null || workspaceId === null) return;
    notePlanShapes(viewerId, workspaceId, pagePlanIds, cardsSnapshot.bundles, cardsSnapshot.failed);
  }, [cardsSnapshot, pagePlanIds, viewerId, workspaceId]);
  const openPartsSettled = openHoldSettled({
    // The side words the ticker and the post and plan cards: only they wait on it.
    side:
      viewerSide.ready || (!chatPage && pagePlanIds.length === 0 && pageCards.postIds.length === 0),
    ticker: !chatPage || (openPosts.ready && statusCounts.plans.ready && statusCounts.briefs.ready),
    cards: cardsSettled,
  });
  const openHeld = openHoldApplies({
    keptOpen,
    holdDone: openHoldDone,
    partsSettled: openPartsSettled,
    keptPartsSettled: cardsSized,
  });
  const onOpenPlanCompose = props.onOpenPlanCompose;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bumped when the selection's Delete window boundary passes (a re-render).
  const [selectionTick, setSelectionTick] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [jumpRequest, setJumpRequest] = useState<{
    id: string;
    seq: number;
    quiet?: boolean;
  } | null>(null);
  // A palette jump's words: marked in the bubbles and on the header's name (a
  // group found by name), until the chat closes.
  const [headerWords, setHeaderWords] = useState<readonly string[]>([]);
  const [forwardFor, setForwardFor] = useState<ThreadMessage[] | null>(null);
  // The own message being edited in the composer.
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  // Server time for the delete window (device clock plus the store's offset).
  const serverNow = useServerNow();

  // The message being edited was deleted or left the thread: stop editing it.
  const editingId = editing?.messageId ?? null;
  useEffect(() => {
    if (editingId === null) return;
    const target = actionable.find((m) => m.id === editingId);
    if (target === undefined || target.deleted === true) setEditing(null);
  }, [actionable, editingId]);

  // Unmount: stop waiting on a share's card.
  useEffect(() => () => cardWait.clear(), [cardWait]);

  // The card a share queued has landed in the list: it is what the chat is about now.
  useEffect(() => {
    const found = cardWait.resolve(props.messages);
    if (found !== null) setAboutDraft(found);
  }, [props.messages, cardWait]);

  const onDeleteMessages = props.onDeleteMessages;
  const onEditMessage = props.onEditMessage;
  const startEdit = (message: ThreadMessage): void => {
    setEditing({
      messageId: message.id,
      initialText: message.body,
      hasOtherContent:
        message.attachments.length > 0 ||
        message.sharedPostIds.length > 0 ||
        message.sharedBriefIds.length > 0 ||
        isPlanMessage(message) ||
        isIdeaMessage(message),
    });
  };
  const onForward = props.onForward;
  const forwardChannels = props.forwardChannels;
  const canForwardHere = onForward !== undefined && forwardChannels !== undefined;
  const exitSelection = (): void => {
    setSelecting(false);
    setSelected(new Set());
  };
  // Selection mode owns one history entry: back exits it and stays in the chat.
  const selectionHistoryRef = useRef<SelectionHistory | null>(null);
  useEffect(() => {
    if (!selecting) return;
    const entry = enterSelectionHistory(window, () => {
      setSelecting(false);
      setSelected(new Set());
    });
    selectionHistoryRef.current = entry;
    return () => {
      selectionHistoryRef.current = null;
      entry.dispose();
    };
  }, [selecting]);
  /** Cancel, Escape and the header chevron: through history.back(). */
  const cancelSelection = (): void => {
    const entry = selectionHistoryRef.current;
    if (entry !== null) entry.cancel();
    else exitSelection();
  };
  /**
   * Menu Forward or Delete: selection mode opens with that message
   * ticked (when it can be).
   */
  const enterSelection = (message: ThreadMessage): void => {
    setEditing(null);
    setSelecting(true);
    setSelected(selectionOnEntry(message));
  };
  // Menu Delete on one message: the single-message confirm, no selection mode.
  const [deleteOneFor, setDeleteOneFor] = useState<ThreadMessage | null>(null);
  const [deleteOneBusy, setDeleteOneBusy] = useState(false);
  const confirmDeleteOne = async (): Promise<void> => {
    if (deleteOneFor === null || onDeleteMessages === undefined || deleteOneBusy) return;
    const ids = [deleteOneFor.id];
    setDeleteOneBusy(true);
    const result = await onDeleteMessages(ids);
    setDeleteOneBusy(false);
    setDeleteOneFor(null);
    if (!result.ok) {
      toast.show({ title: result.message });
      return;
    }
    threadView.update((rows) => markMessagesDeleted(rows, ids));
    if (result.toast !== undefined) toast.show({ title: result.toast });
  };
  // FT39: a text-only message deletes behind a 4s Undo. It reads as a
  // tombstone here at once; the delete for everyone runs through the same
  // path as the confirm once the window ends (or the chat is left). Undo, or a
  // refused delete, brings the row back.
  const undoable = useUndoableAction();
  const tombstone = props.tombstone;
  const deleteWithUndo = (message: ThreadMessage): void => {
    if (onDeleteMessages === undefined) return;
    const id = message.id;
    const original = message;
    // Bound now: the commit may run after the chat was left (unmount flush).
    const forChannel = props.channelId;
    tombstone?.(id, true);
    threadView.update((rows) => markMessagesDeleted(rows, [id]));
    const revert = (): void => {
      tombstone?.(id, false);
      threadView.update((rows) => rows.map((r) => (r.id === id ? original : r)));
    };
    undoable.run({
      label: MESSAGE_DELETED_UNDO,
      commit: async () => {
        const result =
          forChannel !== undefined
            ? await onDeleteMessages([id], forChannel)
            : await onDeleteMessages([id]);
        if (!result.ok) {
          revert();
          toast.show({ title: result.message });
          return;
        }
        if (result.toast !== undefined) toast.show({ title: result.toast });
      },
      revert,
    });
  };
  // Delete for me: the sheet's second choice (and a tombstone's only one).
  // Hidden at once behind the "Deleted for you" Undo; written when it ends.
  const deleteForMe = useDeleteForMe({ userId: props.currentUserId, workspaceId });
  const canDeleteForMe =
    channelId !== undefined &&
    props.notes !== true &&
    props.currentUserId !== undefined &&
    workspaceId !== null;
  const hideForMe = (messages: readonly ThreadMessage[]): void => {
    if (channelId === undefined) return;
    const sent = messages.filter((m) => m.state === 'sent');
    deleteForMe(sent.map((m) => ({ messageId: m.id, channelId })));
  };
  // The menu Delete's sheet: one message, "Delete for everyone" when it qualifies.
  const [deleteSheetFor, setDeleteSheetFor] = useState<DeleteSheetTarget | null>(null);
  // Today's delete for everyone: a 4s Undo for text, the files confirm otherwise.
  const deleteForEveryone = (message: ThreadMessage): void => {
    if (deleteHasUndo(message)) deleteWithUndo(message);
    else setDeleteOneFor(message);
  };
  // Remove files, keep the message: the files go at once (the overlay), behind
  // the Undo strip; the record, purge and signal run when the window ends (or
  // the chat is left). Undo, or a refused record, brings back what was refused.
  const liveClient = useLiveChatClient();
  const removeTarget = useMemo(() => {
    const summary = (forwardChannels ?? []).find((c) => c.channelId === channelId);
    if (summary === undefined || props.notes === true) return null;
    try {
      return targetFromSummary(summary);
    } catch {
      return null;
    }
  }, [forwardChannels, channelId, props.notes]);
  const removeFilesWithUndo = (files: RemovableFile[]): void => {
    // Bound now: the commit may run after the chat was left (unmount flush).
    const forChannel = channelId;
    if (forChannel === undefined || files.length === 0) return;
    const forWorkspace = workspaceId;
    const connection = liveClient;
    const target = removeTarget;
    const action = removeFilesAction({
      store: removedFilesStore,
      channelId: forChannel,
      files,
      showToast: (title) => toast.show({ title }),
      remove: async () => {
        const traceId = generateTraceId();
        const result = await runRemoveFiles(
          {
            client: supabase,
            purgeChat: (assetIds) => purgeRemovedFiles(forWorkspace, assetIds, traceId),
            onPurgeFailed: (error) =>
              logger.warn('chat: purge-chat failed', { trace_id: traceId, error }),
            signal:
              connection !== null && target !== null
                ? (ext) =>
                    sendSignal({
                      connection: connection as TypingConnection,
                      target,
                      createCmd: createCmdMessage,
                      ext,
                    })
                : undefined,
            onSignalFailed: (error) =>
              logger.warn('chat: files removed signal failed', {
                trace_id: traceId,
                error: String(error),
              }),
          },
          { channelId: forChannel, files, traceId },
        );
        if (!result.ok) {
          logger.warn('chat: remove files failed', {
            trace_id: traceId,
            removed: result.removed.length,
            error: result.error,
          });
        }
        return result;
      },
    });
    undoable.run(action);
  };
  // Only where the viewer can act on their own messages (the same gate as Delete).
  const canRemoveHere = channelId !== undefined && onDeleteMessages !== undefined;
  const onRemoveFiles = canRemoveHere ? removeFilesWithUndo : undefined;
  // Escape leaves selection mode (the laptop's Cancel).
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"], [role="menu"]'))
        return;
      selectionHistoryRef.current?.cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selecting]);
  // The composers' inputs: a Reply focuses them inside the user's own event.
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const viewComposerInputRef = useRef<HTMLTextAreaElement | null>(null);
  // L3/L14: Reply (sheet tile, swipe right, laptop right-click) opens that
  // message's thread with its composer focused; no quote-reply in the main chat.
  const openThreadRef = useRef<(rootId: string, focus?: boolean, gesture?: boolean) => void>(
    () => undefined,
  );
  const handleReply = (message: ThreadMessage): void => {
    openThreadRef.current(threadRootOf(message), true, true);
  };
  // The quoted message became a tombstone: the reply chip loses its text and
  // reads the deleted label (the draft map is stripped by the store too).
  const replyQuoteId =
    replyDraft !== null && replyDraft.deleted !== true ? replyDraft.quote.id : null;
  const replyQuoteDeleted =
    replyQuoteId !== null &&
    props.messages.some((m) => m.id === replyQuoteId && m.deleted === true);
  useEffect(() => {
    if (!replyQuoteDeleted) return;
    setReplyDraftState((prev) => (prev !== null ? strippedReply(prev) : prev));
    if (channelId !== undefined) {
      const current = getDraft(channelId).reply;
      if (current !== null) setDraft(channelId, { reply: strippedReply(current) });
    }
  }, [replyQuoteDeleted, channelId]);
  const notes = props.notes === true;
  const headerLine = threadHeaderLine({
    notes,
    isGroup: props.isGroup === true,
    peerTyping: props.typingUserIds.length > 0,
    role: props.role ?? null,
    workspaceName: props.subtitle,
  });
  const canOpenContact = !notes && props.isGroup !== true && props.channelId !== undefined;
  // The Contact sheet's role line is the header's resting line: never typing,
  // so it reads "role · workspace" from the same source.
  const contactRoleLine = dmHeaderLine({
    isGroup: false,
    peerTyping: false,
    role: props.role ?? null,
    workspaceName: props.subtitle,
  });
  const jumpTo = (id: string): void =>
    setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));

  // Thread lookups: every loaded row, plus the open thread's root (a reply sent
  // from the view lands in the chat with its root known even when the chat has
  // not loaded the card).
  const loadedIds = useMemo(() => new Set(props.messages.map((m) => m.id)), [props.messages]);
  const known = useMemo(() => {
    const byId = new Map<string, ThreadMessage>(props.messages.map((m) => [m.id, m]));
    if (view !== null && !byId.has(view.rootId)) byId.set(view.rootId, view.root);
    return byId;
  }, [props.messages, view]);
  // Chips: one batch over every chip's post, plus the thread cards' and the About posts.
  const parentIndex = useMemo(() => parentIndexOf(props.messages), [props.messages]);
  const chipIds = useMemo(
    () => chipPostIds(props.messages, parentIndex),
    [props.messages, parentIndex],
  );
  const threadPostIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of props.messages) {
      if (typeof m.threadRootId !== 'string') continue;
      const post = rootCardPost(m.threadRootId, m, known);
      if (typeof post === 'string') ids.add(post);
    }
    const viewCard = view !== null ? rootCardOf(view.root) : null;
    if (viewCard?.kind === 'post') ids.add(viewCard.id);
    return [...ids];
  }, [props.messages, known, view]);
  const batchIds = useMemo(
    () =>
      [...chipIds, ...threadPostIds, aboutDraft?.postId].filter(
        (id): id is string => id !== undefined,
      ),
    [chipIds, threadPostIds, aboutDraft?.postId],
  );
  const { postRef, chipSettled } = useChipBatch(batchIds);
  const sharedInChat = useMemo(
    () => new Set(props.messages.flatMap((m) => m.sharedPostIds)),
    [props.messages],
  );
  // A page row also waits for the task lines of its time (capped), so an
  // older page's lines paint in the same commit as its rows, before the
  // page-anchor step, and never insert after it.
  const taskCovers = chatTasks.covers;
  // First paint final, page by page: the rows of a page being loaded (the first
  // page, an older one) go on screen together once each is hydrated, its chip
  // post is settled and (a reply in a card thread whose card is not loaded)
  // the page's one counts read is in, so a chip, a rail or a fallback quote
  // paints with them and the bottom snap happens after. Anything that arrives
  // after a page is in (own sends, live rows, state changes on shown rows) is
  // never held.
  const admitted = useMemo(() => {
    const nowMs = Date.now();
    const next = admitRows(
      gateRef.current,
      channelKey,
      props.messages,
      (row, since) =>
        rowReady(row, since, {
          parentIndex,
          chipSettled,
          nowMs,
          loaded: loadedIds,
          countSettled: counts.settled,
          threadPost: (gated) => {
            const message = known.get(gated.id);
            const member =
              message !== undefined ? membershipOf(message, known, frozenRef.current) : null;
            return member != null ? member.postId : null;
          },
        }) && taskLinesReady(row.time, since, nowMs, taskCovers),
      nowMs,
    );
    gateRef.current = next.gate;
    // The cut's own moment: a deadline at or before it was judged by this cut.
    return { ...next, nowMs };
    // hydrationTick re-runs the cut once a hydration wait has run out;
    // countsVersion once a page's counts read is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    channelKey,
    props.messages,
    parentIndex,
    chipSettled,
    hydrationTick,
    countsVersion,
    loadedIds,
    known,
    taskCovers,
  ]);
  const onScreen = admitted.rows;
  // Each row's thread, decided as it goes on screen and kept from then on.
  const frozen = useMemo(
    () => freezeMemberships(onScreen, known, frozenRef.current),
    [onScreen, known],
  );
  // The page's counts read: once every page row's root is hydrated, the
  // not-loaded card roots of the page, in one call (none per row).
  const localCounts = useMemo(() => localReplyCounts(props.messages), [props.messages]);
  const localCountsRef = useRef(localCounts);
  localCountsRef.current = localCounts;
  useEffect(() => {
    const pending = admitted.gate.pending;
    const pageRows = props.messages.filter((m) => pending.has(m.id));
    const nowMs = Date.now();
    // A row whose root read has run out of time no longer holds the read back.
    const roots = pageCountRoots(pageRows, loadedIds, counts.requested, (row) => {
      const since = pending.get(row.id) ?? nowMs;
      return awaitsRootHydration(row, loadedIds) && nowMs - since < PAGE_HYDRATION_WAIT_MS;
    });
    if (roots.length === 0) return;
    void counts
      .request(roots, (rootId) => localCountsRef.current.get(rootId) ?? 0)
      ?.then(() => setCountsVersion((v) => v + 1));
  }, [admitted, props.messages, loadedIds, counts]);
  /** A thread's reply count; null when unknown (a counts read that failed or timed out). */
  const countOf = (rootId: string): number | null =>
    threadReplyCount({
      rootLoaded: loadedIds.has(rootId),
      local: localCounts.get(rootId) ?? 0,
      entry: counts.get(rootId),
    });
  const memberOf = (message: ThreadMessage): ThreadMembership | null =>
    renderedMembership(message.id, frozen, known);
  // Opened from an Activity mention: once the first page is on screen (not the
  // skeleton, so the row can be revealed), jump to that message through the
  // same path (older pages load via ensureLoaded; a miss toasts and the chat
  // stays at the bottom). Once per open; the caller then drops it, so reopening
  // the chat later never jumps again.
  const initialMessageId = props.initialMessageId ?? null;
  const initialJumpDone = useRef(false);
  // The first page also waits for the channel's read cursors (5s bound), so
  // the unread divider, Seen and Read by lines paint with it, never after.
  const pageLoading =
    props.loading || holdingFirstPage(admitted.gate) || props.readState?.status === 'loading';
  const bodyLoading = pageLoading || openHeld;
  // The hold's cap, and its release latched once the first page is out.
  useEffect(() => {
    if (openHoldDone) return;
    if (!pageLoading && !openHeld && keptOpen) {
      paintLog(`open hold skipped, kept rows sized, ${Date.now() - openAt}ms after the tap`);
      mark('chat:hold:kept');
      setOpenHoldDone(true);
      return;
    }
    if (!pageLoading && !openHeld) {
      paintLog(`open hold released, all settled, ${Date.now() - openAt}ms after the tap`);
      mark('chat:hold:release');
      setOpenHoldDone(true);
      return;
    }
    const timer = setTimeout(
      () => {
        paintLog(`open hold capped at ${OPEN_HOLD_MS}ms (page ${pageLoading ? 'loading' : 'in'})`);
        mark('chat:hold:cap');
        setOpenHoldDone(true);
      },
      Math.max(0, openAt + OPEN_HOLD_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [openHoldDone, pageLoading, openHeld, openAt, keptOpen]);
  // Go to card: the same jump and highlight as a deep link, once per seq.
  const cardJump = props.cardJump ?? null;
  const cardJumpSeq = useRef<number | null>(null);
  useEffect(() => {
    if (cardJump === null || bodyLoading || cardJumpSeq.current === cardJump.seq) return;
    cardJumpSeq.current = cardJump.seq;
    setJumpRequest((prev) => ({ id: cardJump.messageId, seq: (prev?.seq ?? 0) + 1 }));
  }, [cardJump, bodyLoading]);
  const onInitialJumpTaken = props.onInitialJumpTaken;
  // A search jump's words: marked in the bubbles (and the header's name) until
  // this chat closes; the jump to its message is quiet when the message is gone.
  const initialSearchWords = props.initialSearchWords ?? null;
  const onInitialSearchWordsTaken = props.onInitialSearchWordsTaken;
  // Latched: the caller drops the words once taken, the jump may still be waiting on the page.
  const fromSearchRef = useRef(false);
  useEffect(() => {
    if (initialSearchWords === null) return;
    if (initialSearchWords.length > 0) fromSearchRef.current = true;
    setHeaderWords(initialSearchWords);
    onInitialSearchWordsTaken?.();
  }, [initialSearchWords, onInitialSearchWordsTaken]);
  useEffect(() => {
    const id = initialMessageId;
    if (id === null) return;
    if (!initialJumpDue({ messageId: id, done: initialJumpDone.current, bodyLoading })) return;
    initialJumpDone.current = true;
    const quiet = fromSearchRef.current || (initialSearchWords?.length ?? 0) > 0;
    setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1, quiet }));
    onInitialJumpTaken?.();
  }, [initialMessageId, bodyLoading, onInitialJumpTaken, initialSearchWords]);
  // A message jump: once the rows are on screen, jump to it (the same jump and
  // highlight as a deep link).
  const searchRequest = props.searchRequest ?? null;
  const onSearchRequestTaken = props.onSearchRequestTaken;
  const searchSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (searchRequest === null || bodyLoading) return;
    if (searchSeqRef.current === searchRequest.seq) return;
    searchSeqRef.current = searchRequest.seq;
    const { messageId } = searchRequest;
    const quiet = searchRequest.quiet === true;
    setJumpRequest((prev) => ({ id: messageId, seq: (prev?.seq ?? 0) + 1, quiet }));
    onSearchRequestTaken?.();
  }, [searchRequest, bodyLoading, onSearchRequestTaken]);
  const gatedIndex = useMemo(() => parentIndexOf(onScreen), [onScreen]);
  // L3: thread replies never show in the main chat; its list, unread line,
  // Seen and Read by read the top-level messages only.
  const shownMessages = useMemo(() => mainChatMessages(onScreen), [onScreen]);
  // A bell task row: once the first page is on screen, the sheet opens on
  // that item (once per link; the caller then drops it).
  const initialTaskId = props.initialTaskId ?? null;
  const onInitialTaskTaken = props.onInitialTaskTaken;
  useEffect(() => {
    if (initialTaskId === null || bodyLoading || taskChannel === null) return;
    openTasks(initialTaskId);
    onInitialTaskTaken?.();
  }, [initialTaskId, bodyLoading, taskChannel, openTasks, onInitialTaskTaken]);
  // Task lines cover the loaded window; older pages bring their older changes.
  // Every loaded row (held ones too): their events are read before they show.
  const oldestLoaded = props.messages[0];
  const ensureTaskEvents = chatTasks.ensureEventsSince;
  useEffect(() => {
    if (oldestLoaded !== undefined) ensureTaskEvents(oldestLoaded.createdAt);
  }, [oldestLoaded, ensureTaskEvents]);
  // A held row whose lines are not in yet re-cuts the page at its cap.
  useEffect(() => {
    let earliest: number | null = null;
    for (const message of props.messages) {
      const since = admitted.gate.pending.get(message.id);
      if (since === undefined || taskCovers(message.time)) continue;
      earliest = earliest === null ? since : Math.min(earliest, since);
    }
    if (earliest === null) return;
    const handle = setTimeout(
      () => setHydrationTick((t) => t + 1),
      Math.max(0, earliest + TASK_LINES_WAIT_MS - Date.now()),
    );
    return () => clearTimeout(handle);
  }, [admitted, props.messages, taskCovers]);
  // Lines show for the rows on screen only: a held older page's lines come
  // with its rows, in the same commit.
  const oldestShown = onScreen[0];
  const rowsHeld = oldestLoaded !== undefined && oldestLoaded.id !== oldestShown?.id;
  const olderPageHeld = rowsHeld && oldestShown !== undefined;
  const windowEvents = useMemo(
    () =>
      eventsInWindow(
        chatTasks.events,
        oldestShown !== undefined ? oldestShown.time : null,
        props.hasMore === true || rowsHeld,
      ),
    [chatTasks.events, oldestShown, props.hasMore, rowsHeld],
  );
  const taskLineCtx: TaskLineContext = {
    tasksById: chatTasks.lineTasks,
    nameOf: chatTasks.nameOf,
    onOpenTask: (taskId) => openTasks(taskId),
  };
  // Reading layer. Everything comes from the channel's cursors (one batched
  // read) and renders only once they are in, so nothing paints then moves.
  const readState = props.readState;
  const readingOn = readState !== undefined;
  const readsReady = readingOn && readState.status === 'ready';
  const readPositions = readState?.positions;
  const seenPeer = props.isGroup === true ? null : (props.peerUserId ?? null);
  const seen = useMemo(
    () =>
      readsReady && seenPeer !== null && readPositions !== undefined
        ? seenLineTarget(shownMessages, readPositions.get(seenPeer))
        : null,
    [readsReady, seenPeer, readPositions, shownMessages],
  );
  const groupMembers = props.isGroup === true ? (props.mentionMembers ?? null) : null;
  const readBy = useMemo(() => {
    if (!readsReady || groupMembers === null || readPositions === undefined) return null;
    const target = readByTarget(shownMessages);
    if (target === null) return null;
    const readers = readersOf(
      target,
      readPositions,
      groupMembers.map((m) => m.userId),
    );
    const label = readByLabel(readers.read.length, readers.read.length + readers.unread.length);
    return label === null ? null : { message: target, ...readers, label };
  }, [readsReady, groupMembers, readPositions, shownMessages]);
  const [readInfoOpen, setReadInfoOpen] = useState(false);
  // The first unread as the open cursor puts it, frozen once known (the divider
  // stays put until the chat is left; live arrivals never move it). A run that
  // starts above loaded history stays live until its pages load.
  const computedUnread: FirstUnread | null | undefined =
    !readingOn || bodyLoading || readState.status === 'loading'
      ? undefined
      : readState.status === 'failed'
        ? null
        : firstUnread({
            messages: shownMessages,
            open: readState.open,
            hasMore: props.hasMore === true,
            unreadAtOpen: props.unreadAtOpen ?? 0,
          });
  const [frozenUnread, setFrozenUnread] = useState<{ value: FirstUnread | null } | null>(null);
  if (
    frozenUnread === null &&
    computedUnread !== undefined &&
    (computedUnread === null || computedUnread.kind === 'loaded')
  ) {
    setFrozenUnread({ value: computedUnread });
  }
  // L11: a Mark unread on a main-chat message moves my "New" line above it.
  const [markedUnread, setMarkedUnread] = useState<{ channelId: string; firstId: string } | null>(
    null,
  );
  const markedId =
    markedUnread !== null && markedUnread.channelId === channelId ? markedUnread.firstId : null;
  const markedHere = markedId !== null;
  const markedFirst = markedId !== null ? shownMessages.findIndex((m) => m.id === markedId) : -1;
  const unread: FirstUnread | null | undefined =
    markedId !== null && markedFirst >= 0
      ? {
          kind: 'loaded',
          firstId: markedId,
          count: Math.max(
            1,
            shownMessages.slice(markedFirst).filter((m) => !m.mine && m.deleted !== true).length,
          ),
        }
      : !readingOn
        ? undefined
        : frozenUnread !== null
          ? frozenUnread.value
          : computedUnread;
  // L6b open rule (B), decided once as the first page paints: unread
  // top-level messages open at the "New" line (as today); else unread threads
  // (known before this paint) open straight onto the Threads sheet; else the
  // chat opens as today. Never holds the paint.
  useEffect(() => {
    if (channelId === undefined || bodyLoading || paintedRef.current === channelId) return;
    paintedRef.current = channelId;
    const early = earlyThreadsRef.current;
    const target = chatOpenTarget({
      unreadTopLevel: unread != null && (unread.kind === 'beyond' || unread.count > 0) ? 1 : 0,
      threads: early !== null && early.channelId === channelId ? early.rows : null,
      painted: false,
    });
    earlyThreadsRef.current = null;
    if (target === 'threads' && initialMessageId === null) setThreadsOpen(true);
    // Once per chat open, at the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, bodyLoading]);
  // Pill tap: a loaded run jumps through the jump path; a run above the
  // loaded pages first pages back to the cursor message (5s bound), then jumps.
  // A miss leaves the pill as it is and shows nothing else.
  const [unreadJumpPending, setUnreadJumpPending] = useState(false);
  const jumpFirstUnread = (): void => {
    if (unread === undefined || unread === null) return;
    if (unread.kind === 'loaded') {
      jumpTo(unread.firstId);
      return;
    }
    const ensure = props.onEnsureLoaded;
    if (ensure === undefined) return;
    void ensure(unread.cursorId).then((outcome) => {
      if (outcome === 'found') setUnreadJumpPending(true);
    });
  };
  const loadedFirstUnread = unread?.kind === 'loaded' ? unread.firstId : null;
  useEffect(() => {
    if (!unreadJumpPending || loadedFirstUnread === null) return;
    setUnreadJumpPending(false);
    setJumpRequest((prev) => ({ id: loadedFirstUnread, seq: (prev?.seq ?? 0) + 1 }));
  }, [unreadJumpPending, loadedFirstUnread]);
  // Who reacted: names from the loaded profiles and members first, the rest in
  // one batched read.
  const [reactionsFor, setReactionsFor] = useState<string | null>(null);
  // Read through refs, so the reader stays the same across renders and an open
  // sheet is never reloaded by a re-render.
  const profilesForReactors = useRef(props.profiles);
  profilesForReactors.current = props.profiles;
  const membersForReactors = useRef(props.mentionMembers);
  membersForReactors.current = props.mentionMembers;
  const defaultReactorLoad = useMemo(
    () =>
      defaultWhoReactedLoad(workspaceId, (id) => {
        const known = profilesForReactors.current.get(id);
        if (known !== undefined) return known;
        const member = membersForReactors.current?.find((m) => m.userId === id);
        return member !== undefined
          ? { userId: member.userId, displayName: member.displayName, avatarUrl: member.avatarUrl }
          : undefined;
      }),
    [workspaceId],
  );
  const reactorLoad = props.loadReactors ?? defaultReactorLoad;
  useEffect(() => {
    // A deadline the cut already judged (at or before its moment) needs no
    // timer again; one after it always gets one, however late this effect runs.
    const deadline = hydrationDeadline(
      admitted.gate,
      props.messages,
      parentIndex,
      loadedIds,
      admitted.nowMs,
    );
    if (deadline === null) return;
    const handle = setTimeout(
      () => setHydrationTick((t) => t + 1),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(handle);
  }, [admitted, props.messages, parentIndex, loadedIds]);

  // Selection, jumps and the forward source read the list that is on screen
  // (and the open thread view's own rows).
  const selectable = useMemo(() => {
    if (viewMessages.length === 0) return shownMessages;
    const shown = new Set(shownMessages.map((m) => m.id));
    const extra = viewMessages.filter((m) => !shown.has(m.id));
    return extra.length > 0 ? [...shownMessages, ...extra] : shownMessages;
  }, [shownMessages, viewMessages]);
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneThreadSelection(prev, selectable);
      return next.size === prev.size ? prev : next;
    });
  }, [selectable]);
  const messagesById = useMemo(() => new Map(selectable.map((m) => [m.id, m])), [selectable]);

  // The About post resolved to nothing (RLS, failed read): drop it and say so.
  const aboutPost = aboutDraft !== null ? postRef(aboutDraft.postId) : undefined;
  const aboutGone = aboutDraft !== null && aboutState(aboutPost) === 'gone';
  useEffect(() => {
    if (!aboutGone) return;
    setAboutDraft(null);
    toast.show({ title: ABOUT_UNAVAILABLE_TOAST });
  }, [aboutGone, toast]);

  /** Wait for the card of a share about to be sent; false (and a toast) when it cannot be. */
  const expectCard = (postId: string): boolean => {
    if (cardWait.expect(props.messages, postId, props.canSend)) return true;
    toast.show({ title: SHARE_UNAVAILABLE_TOAST });
    return false;
  };
  /** Talk about a card already in the thread: it becomes the About and flashes. */
  const talkAbout = (postId: string, cardMessageId: string): void => {
    cardWait.clear();
    setAboutDraft({ postId, cardMessageId });
    jumpTo(cardMessageId);
  };
  /**
   * Bring a post into the conversation: its newest loaded card becomes the
   * About (and is jumped to); with none, a card message is sent now through the
   * share path and becomes the About once the outbox assigns its id.
   */
  const bringPost = (postId: string): void => {
    const card = newestCardFor(props.messages, postId);
    if (card !== null) {
      talkAbout(postId, card.id);
      return;
    }
    if (!expectCard(postId)) return;
    props.onSend('', [], [postId], null, []);
  };
  const chipFor = (message: ThreadMessage): BubbleChip | undefined => {
    const target = chipTargetFor(message, gatedIndex);
    return bubbleChip(target, target !== null ? postRef(target.postId) : null, {
      onOpenCard: jumpTo,
    });
  };
  /**
   * Open a card's thread (tap, swipe, Reply, "N replies", a chip): a loaded
   * root paints the view at once (placeholders until the first page); only
   * an unknown root waits for its read, and a root not found toasts. A newer
   * open supersedes an older one (no gate). From a gesture the view mounts in
   * that event (flushSync) so the composer's focus raises the iPhone keyboard.
   */
  const openThread = (rootId: string, focus = false, gesture = false): void => {
    let opening: Promise<boolean> = Promise.resolve(false);
    const start = (): void => {
      setViewFocus(focus);
      setEditing(null);
      setViewReply(null);
      opening = threadView.open(rootId, props.messages);
    };
    if (gesture) flushSync(start);
    else start();
    if (gesture && focus) viewComposerInputRef.current?.focus({ preventScroll: true });
    void opening
      .catch(() => false)
      .then((opened) => {
        // false only when the root is not found: today's toast, nothing moves.
        if (opened) dismissHoldTip(props.currentUserId ?? '');
        else toast.show({ title: THREAD_OPEN_FAILED_TOAST });
      });
  };
  const closeThread = (): void => {
    if (selecting) cancelSelection();
    setEditing(null);
    setViewReply(null);
    threadView.close();
  };
  // Each layer is one history step (lib/chat/use-history-step): back closes
  // only that layer through its own close (the thread view through its Close,
  // so the fade runs) and stays in the chat; its own close pops the step.
  // rootRef: the chat pane (the push's "behind"); the thread view is its sibling.
  const rootRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // One chat open = one tip show (GOAL 6): a key per mount and chat.
  const [tipOpenSeq] = useState(nextTipOpenSeq);
  useHistoryStep(view !== null, HISTORY_STEP_KEYS.threadView, () => {
    const close = shellRef.current?.querySelector<HTMLButtonElement>('[data-thread-view-close]');
    if (close !== null && close !== undefined) close.click();
    else closeThread();
  });
  useHistoryStep(contactOpen, HISTORY_STEP_KEYS.contact, () => setContactOpen(false));
  useHistoryStep(readInfoOpen && readBy !== null, HISTORY_STEP_KEYS.readInfo, () =>
    setReadInfoOpen(false),
  );
  const threadPostOf = (rootId: string): PostRefPost | null => {
    const root = known.get(rootId);
    const postId =
      root !== undefined
        ? root.sharedPostIds[0]
        : actionable.find((m) => m.threadRootId === rootId)?.rootPostIds?.[0];
    return postId !== undefined ? (postRef(postId) ?? null) : null;
  };
  openThreadRef.current = openThread;
  // L3: each loaded root's replies row (one pass over the loaded rows; the
  // unread dot from the threads-for-me read). No call per row.
  const repliesInfo = useMemo(
    () =>
      repliesInfoByRoot(
        actionable,
        (rootId) => myThreads?.some((t) => t.rootId === rootId && t.unread) === true,
      ),
    [actionable, myThreads],
  );
  const profileNameFor = (userId: string | null): string =>
    userId === null
      ? 'Member'
      : userId === props.currentUserId
        ? (props.profiles.get(userId)?.displayName ?? 'You')
        : (props.profiles.get(userId)?.displayName ?? 'Member');
  const repliesFor = (message: ThreadMessage): RepliesRowData | null => {
    const info = repliesInfo.get(message.id);
    if (info === undefined || info.count === 0) return null;
    return {
      label: repliesLabel(info.count),
      repliers: info.repliers.map((id) => {
        const src = props.profiles.get(id)?.avatarUrl;
        return { id, name: profileNameFor(id), ...(src != null ? { src } : {}) };
      }),
      // The same loaded rows as the count: it moves with every reply, no read.
      time: info.last !== null ? rowWhen(info.last.time) : '',
      unread: info.unread,
      onOpen: () => openThread(message.id, true, true),
    };
  };
  // L4/L7: the thread screen's "New" line, decided once as the thread opens
  // (from the threads-for-me flag and this device's read point), then the
  // thread is marked read to its newest reply (chat_thread_read_set).
  const [viewNewLine, setViewNewLine] = useState<{ rootId: string; firstId: string | null } | null>(
    null,
  );
  const viewRootKey = view?.rootId ?? null;
  const viewReplies = viewParts?.replies;
  useEffect(() => {
    if (viewRootKey === null || viewReplies === undefined || channelId === undefined) return;
    if (viewNewLine?.rootId !== viewRootKey) {
      const unread = myThreads?.some((t) => t.rootId === viewRootKey && t.unread) === true;
      setViewNewLine({
        rootId: viewRootKey,
        firstId: firstUnreadReply(viewReplies, { unread, readAt: localThreadReadAt(viewRootKey) }),
      });
    }
    const newest = viewReplies[viewReplies.length - 1];
    if (newest === undefined || newest.state !== 'sent') return;
    rememberThreadRead(viewRootKey, newest.time);
    setThreadsForMe((prev) =>
      prev !== null ? { ...prev, rows: withThreadRead(prev.rows, viewRootKey) } : prev,
    );
    void setThreadRead({
      client: supabase,
      channelId,
      rootId: viewRootKey,
      messageId: newest.id,
      traceId: generateTraceId(),
    }).then((result) => {
      if (!result.ok) logger.warn('chat: thread read set failed', { error: result.message });
    });
    // The newest reply id is the trigger: reading to the bottom marks it read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRootKey, viewReplies?.[viewReplies.length - 1]?.id, channelId]);
  const viewUnread: FirstUnread | null =
    viewNewLine !== null && viewNewLine.rootId === viewRootKey && viewNewLine.firstId !== null
      ? {
          kind: 'loaded',
          firstId: viewNewLine.firstId,
          count: (viewReplies ?? []).filter(
            (m, i, all) => i >= all.findIndex((r) => r.id === viewNewLine.firstId) && !m.mine,
          ).length,
        }
      : null;
  // L13: a jump (deep link, search, Activity) to a thread reply opens its
  // thread with that reply highlighted; the main chat never holds replies.
  const jumpTarget = jumpRequest !== null ? known.get(jumpRequest.id) : undefined;
  const jumpIsReply = jumpTarget !== undefined && !isTopLevel(jumpTarget);
  const mainJump = jumpIsReply ? null : jumpRequest;
  const [viewJump, setViewJump] = useState<{ id: string; seq: number } | null>(null);
  const routedJumpRef = useRef<number | null>(null);
  useEffect(() => {
    if (jumpRequest === null || jumpTarget === undefined || !jumpIsReply) return;
    if (routedJumpRef.current === jumpRequest.seq) return;
    routedJumpRef.current = jumpRequest.seq;
    openThread(threadRootOf(jumpTarget));
    setViewJump({ id: jumpTarget.id, seq: jumpRequest.seq });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest, jumpIsReply]);
  // L3: a Talk about (a post's card) opens that card's thread, never a quote bar.
  useEffect(() => {
    if (aboutDraft === null) return;
    setAboutDraft(null);
    openThread(aboutDraft.cardMessageId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aboutDraft]);
  const mainThreads: ThreadBodyThreads = {
    memberOf,
    countOf,
    postOf: threadPostOf,
    onOpen: openThread,
  };
  // The open thread: its root, then its replies oldest first (the chat's loaded
  // rows win over the view's own copies, so live arrivals and own sends show).
  const viewRoot = viewParts?.root;
  // A thread on any card (post, brief, plan, plan item) takes the card's
  // title from the caches the device already holds (no read here: the root's
  // own card read fills them); "Thread" until then and for a root with no
  // card. The chat's name is always the second line.
  const viewPostTitle = (id: string): string | null => postRef(id)?.title ?? null;
  const cardTitles = heldCardTitles(viewPostTitle, briefCards, statusPlanCards);
  const viewTitle = threadTitleOf(viewRoot, cardTitles);
  /** A thread list row's card title (the same rule as the view's title), or null. */
  const threadCardTitle = (root: ThreadMessage): string | null => {
    const title = threadTitleOf(root, cardTitles);
    return title === THREAD_TITLE ? null : title;
  };
  const viewSubtitle = props.title;
  // The view's count: the chat's own when it has the root loaded (or the
  // counts read's), else the view's rows once it has read them all.
  const viewCount = ((): number | null => {
    if (view === null || viewParts === null) return null;
    if (loadedIds.has(view.rootId)) return countOf(view.rootId);
    // Every reply read: the view counts them itself.
    if (!view.hasMore) return localReplyCounts(viewParts.replies).get(view.rootId) ?? 0;
    return countOf(view.rootId);
  })();
  const viewThreads: ThreadBodyThreads | undefined =
    view !== null
      ? {
          // L3: no rail, chips or inline replies any more (post cards too).
          memberOf: () => null,
          countOf: () => viewCount,
          postOf: threadPostOf,
          onOpen: openThread,
          viewRootId: view.rootId,
          onFocusReply: () => focusComposerInput(viewComposerInputRef.current),
        }
      : undefined;
  /** Swipe or menu Reply inside the view: the reply bar names that member. */
  // L3: inside a thread, Reply just focuses the composer (no nested threads).
  const viewHandleReply = (): void => {
    focusComposerInput(viewComposerInputRef.current);
  };
  /** A send from the view replies to the root (or the member its reply bar names). */
  const viewSend: ComposerSend = (text, attachments, sharedPostIds, reply, sharedBriefIds) => {
    if (viewRoot === undefined) return;
    // L3: every thread reply records reply_to_message_id = the root (no
    // nested threads); the server trigger keeps thread_root_message_id.
    void reply;
    const quote = {
      id: viewRoot.id,
      authorUserId: viewRoot.senderUserId,
      preview: replyPreview(viewRoot),
    };
    props.onSend(text, attachments, sharedPostIds, withThreadRoot(quote, viewRoot), sharedBriefIds);
  };
  // A reaction in the view also lands on the view's own copy of a row the chat has not loaded.
  const onToggleReaction = props.onToggleReaction;
  const viewToggleReaction =
    onToggleReaction !== undefined
      ? (messageId: string, emoji: string, currentlyMine: boolean): void => {
          onToggleReaction(messageId, emoji, currentlyMine);
          threadView.update((rows) =>
            applyReactionOp(rows, {
              messageId,
              emoji,
              op: currentlyMine ? 'remove' : 'add',
              mine: true,
            }),
          );
        }
      : undefined;
  // The composer's send: always top level (L3). A one-post share (paperclip
  // or pasted link) still waits for its card; a several-post share clears it.
  const composerSend: ComposerSend = (
    text,
    attachments,
    sharedPostIds,
    reply,
    sharedBriefIds,
    privateReply,
  ) => {
    const [shared] = sharedPostIds;
    if (sharedPostIds.length === 1 && shared !== undefined) expectCard(shared);
    if (sharedPostIds.length > 1) {
      cardWait.clear();
      setAboutDraft(null);
    }
    // L3: the main chat never sends a quote reply (Reply opens the thread); a
    // stored draft quote from before is dropped, so a send stays top level.
    void reply;
    const rooted = null;
    // Reply privately's quote rides as the sixth argument only when attached.
    if (privateReply !== undefined) {
      props.onSend(text, attachments, sharedPostIds, rooted, sharedBriefIds, privateReply);
      return;
    }
    props.onSend(text, attachments, sharedPostIds, rooted, sharedBriefIds);
  };
  // Delete follows the 30 minute window on server time; the bar says why not.
  // One timeout re-computes it when the earliest selected own message ages out.
  useEffect(() => {
    // Notes delete at any age: no window boundary to wait for.
    if (!selecting || notes) return;
    return scheduleSelectionBoundary({
      selected,
      messages: selectable,
      now: serverNow,
      onBoundary: () => setSelectionTick((t) => t + 1),
    });
  }, [selecting, selected, selectable, serverNow, selectionTick, notes]);
  const deleteBlock = selecting
    ? deleteSelectionBlock(selected, selectable, serverNow(), notes)
    : null;
  const stripSlot = threadStripSlot({ chatPage, selecting });
  // L5 (4): "N threads" + dot after the strip's items while a thread is unread.
  const threadsStrip = myThreads !== null ? threadsStripLabel(myThreads) : null;
  // The status ticker: the workspace's shared plans current today on its
  // clock (every chat, shared here or not), then the bar.
  const statusOpenPlans = currentSharedPlans(
    statusCounts.plans.bundles,
    todayInZone(new Date(), props.timeZone),
  );
  // This chat's open tasks: the list useChatTasks already holds for the
  // thread's task lines and the tray dot (remembered per chat, read with the
  // first page), so the ticker reads nothing more.
  const statusTasks = useMemo(() => openTasksOf(chatTasks.tasks), [chatTasks.tasks]);
  const statusBarState = tickerBar({
    openPosts,
    side: viewerSide,
    status: statusCounts,
    open: statusOpenPlans,
    openTasks: chatTasks.loadState === 'ready' ? statusTasks.length : null,
  });
  const planSender = (planId: string): string => {
    const shared = props.messages.find((m) => (m.sharedPlanIds ?? []).includes(planId));
    return shared !== undefined ? senderName(shared, props.profiles) : '';
  };
  const openPlanHere = (planId: string): void =>
    statusPlanCards?.openPlan({ planId, senderName: planSender(planId) });
  // Selection Delete outside notes: "Delete for everyone" only when every
  // selected message qualifies; "Delete for me" always.
  const selectedMessages = [...selected].flatMap((id) => {
    const message = messagesById.get(id);
    return message !== undefined ? [message] : [];
  });
  const selectionNow = selecting ? serverNow() : 0;
  const selectionForMe =
    selecting && canDeleteForMe
      ? {
          everyone:
            deleteBlock === null &&
            selectionDeleteChoices(
              selectedMessages.map((m) => ({
                mine: m.mine && m.state === 'sent' && m.deleted !== true,
                ageMs: messageAgeMs(m, selectionNow),
              })),
            ).everyone,
          onDeleteForMe: () => {
            hideForMe(selectedMessages);
            exitSelection();
          },
        }
      : undefined;
  // Selection mode's bar: in place of the composer, in the chat or the open thread.
  const selectionBar =
    selecting && onDeleteMessages !== undefined ? (
      <SelectionBar
        count={selected.size}
        block={selectionForMe !== undefined ? null : deleteBlock}
        canDelete={selected.size > 0 && (selectionForMe !== undefined || deleteBlock === null)}
        {...(selectionForMe !== undefined ? { forMe: selectionForMe } : {})}
        {...(canForwardHere && selectionForwardable(selected, selectable)
          ? { onForward: () => setForwardFor(selectedForForward(selected, selectable)) }
          : {})}
        notes={notes}
        confirmCopy={deleteConfirmCopy(
          [...selected].flatMap((id) => {
            const message = messagesById.get(id);
            return message !== undefined ? [message] : [];
          }),
        )}
        onDelete={async () => {
          // Committed chunks become tombstones (and leave the selection);
          // a failed chunk's ids stay selected for another try.
          const ids = [...selected];
          const result = await onDeleteMessages(ids);
          if (result.ok) {
            threadView.update((rows) => markMessagesDeleted(rows, ids));
            exitSelection();
          }
          return result;
        }}
      />
    ) : null;
  /**
   * What both composers share. Only the surface on top (`active`) edits: an
   * edit started in the thread view runs in its composer, never the chat's.
   */
  const composerShared = (active: boolean): Omit<ComposerProps, 'onSend'> => ({
    disabled: !props.canSend,
    channelHasClient: props.channelHasClient ?? null,
    viewerUserId: props.currentUserId,
    ...(canAttach ? { uploadFile } : {}),
    ...(active && editing !== null && onEditMessage !== undefined
      ? {
          editing,
          onEdit: async (text: string) => {
            const result = await onEditMessage(editing.messageId, text);
            if (result.ok) {
              const editedAt = new Date(serverNow()).toISOString();
              threadView.update((rows) =>
                applyEdit(rows, { messageId: editing.messageId, body: text, editedAt }),
              );
              setEditing(null);
            }
            return result;
          },
        }
      : {}),
    onCancelEdit: () => setEditing(null),
    ...(props.mentionMembers !== undefined
      ? {
          mentions: {
            members: props.mentionMembers ?? [],
            ready: props.mentionMembers !== null,
            isGroup: props.isGroup === true,
            ...(props.mentionGone !== undefined ? { gone: props.mentionGone } : {}),
            selfId: props.currentUserId ?? null,
            nameOf: profileNameOf(props.profiles, workspaceId),
          },
        }
      : {}),
  });
  // What the chat's list and the thread view's list share: one bubble, one
  // menu, the same selection, edit and delete windows and reactions.
  // Reply privately (group chats only): the quote of the held message, then my DM with its sender.
  const onReplyPrivatelyProp = props.onReplyPrivately;
  const replyPrivatelyDraft =
    channelId !== undefined && props.isGroup === true && !notes
      ? (message: ThreadMessage): PrivateReplyDraft | null =>
          message.senderUserId === null
            ? null
            : chatPrivateReplyDraft({
                channelId,
                messageId: message.id,
                authorUserId: message.senderUserId,
                authorName: senderName(message, props.profiles),
                excerpt: replyPreview(message),
                groupName: props.title,
              })
      : undefined;
  const replyPrivatelyOpen =
    onReplyPrivatelyProp !== undefined && replyPrivatelyDraft !== undefined
      ? (message: ThreadMessage): void => {
          const quote = replyPrivatelyDraft(message);
          if (quote === null || message.senderUserId === null) return;
          onReplyPrivatelyProp(message.senderUserId, quote);
        }
      : undefined;
  // L11: Mark unread. A main-chat message moves my chat cursor to just
  // before it (chat_mark_unread; the chat turns unread with its count in the
  // chat list) and my "New" line moves above it; reading on does not move the
  // cursor forward again until the chat is left. A thread reply moves the
  // thread's read point (chat_thread_mark_unread). Private to me, from the
  // database, so every device follows.
  const markUnread = (message: ThreadMessage): void => {
    if (channelId === undefined) return;
    const traceId = generateTraceId();
    if (isTopLevel(message)) {
      setMarkedUnread({ channelId, firstId: message.id });
      void markChatUnread({ client: supabase, channelId, messageId: message.id, traceId }).then(
        (result) => {
          if (!result.ok) {
            logger.warn('chat: mark unread failed', { error: result.message });
            toast.show({ title: errorText('mark this unread', null) });
          }
        },
      );
      return;
    }
    const rootId = threadRootOf(message);
    rememberThreadRead(rootId, message.time - 1, true);
    setThreadsForMe((prev) =>
      prev !== null ? { ...prev, rows: withThreadUnread(prev.rows, rootId) } : prev,
    );
    void markThreadUnread({
      client: supabase,
      channelId,
      rootId,
      messageId: message.id,
      traceId,
    }).then((result) => {
      if (!result.ok) {
        logger.warn('chat: thread mark unread failed', { error: result.message });
        toast.show({ title: errorText('mark this unread', null) });
      }
    });
  };
  // L12: Add to Tasks (8 Nov 2026): opens this chat's Tasks sheet with the
  // message's text (a file-only message: the file name) in the add field.
  // Nothing is saved until the person adds it there.
  const addToTask = (message: ThreadMessage): void => {
    const title = taskTitleOf(message);
    if (title === '') return;
    openTasks(null, title);
  };
  // L13: Copy link: the open-chat-at-message route (a reply opens its thread
  // with the reply highlighted; membership is checked on open).
  const copyLink = (message: ThreadMessage): void => {
    if (channelId === undefined) return;
    const url = `${currentOrigin() ?? ''}${chatMessageHref(channelId, message.id)}`;
    void copyText(url).then((ok) => toast.show({ title: ok ? 'Link copied' : COPY_FAILED }));
  };
  const bodyActions: Omit<
    ThreadBodyProps,
    'messages' | 'loading' | 'onReply' | 'jumpRequest' | 'threads'
  > = {
    layout,
    ...(channelId !== undefined && notes !== true
      ? { onMarkUnread: markUnread, onCopyLink: copyLink }
      : {}),
    ...(taskChannel !== null && !selecting ? { onAddToTask: addToTask } : {}),
    viewerUserId: props.currentUserId,
    mentions: props.mentions,
    workspaceId,
    ...((onDeleteMessages !== undefined || canDeleteForMe) && !selecting
      ? {
          onDeleteMessage: (message: ThreadMessage, nowMs: number) => {
            const choices = deleteChoices({
              mine: message.mine && message.state === 'sent' && message.deleted !== true,
              ageMs: messageAgeMs(message, nowMs),
              notes,
              failed: false,
            });
            // Personal notes keeps its single Delete, exactly as before.
            if (choices.kind === 'notes') {
              if (onDeleteMessages !== undefined) deleteForEveryone(message);
              return;
            }
            if (choices.kind !== 'sheet') return;
            const everyone = choices.everyone && onDeleteMessages !== undefined;
            if (!canDeleteForMe) {
              if (everyone) deleteForEveryone(message);
              return;
            }
            setDeleteSheetFor({ message, everyone });
          },
          canDeleteForMe,
        }
      : {}),
    ...(canDeleteForMe && !selecting
      ? { onHideMessage: (message: ThreadMessage) => hideForMe([message]) }
      : {}),
    ...(onEditMessage !== undefined && !selecting ? { onEditMessage: startEdit } : {}),
    ...(onRemoveFiles !== undefined && !selecting ? { onRemoveFiles } : {}),
    ...(canForwardHere && !selecting
      ? {
          onForwardMessage: (message: ThreadMessage): boolean => {
            // Where selection exists, Forward enters it with the message ticked.
            if (forwardEntersSelection(message, onDeleteMessages !== undefined)) {
              enterSelection(message);
              return true;
            }
            setForwardFor([message]);
            return false;
          },
        }
      : {}),
    ...(selecting
      ? {
          selection: {
            selected,
            onToggle: (id: string) => setSelected((prev) => toggleSelected(prev, id)),
          },
        }
      : {}),
    profiles: props.profiles,
    cache: presignCache,
    ...(canTranscribe ? { onTranscribe } : {}),
    presignEnabled,
    showTicks: props.showTicks ?? false,
    isGroup: props.isGroup ?? false,
    ...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {}),
    ...(props.onDiscard !== undefined ? { onDiscard: props.onDiscard } : {}),
    ...(onCancelUpload !== undefined ? { onCancelUpload } : {}),
    ...(props.onToggleReaction !== undefined && !selecting
      ? { onOpenReactions: (message: ThreadMessage) => setReactionsFor(message.id) }
      : {}),
    notes,
    ...(props.onSaveToNotes !== undefined && !notes && !selecting
      ? { onSaveToNotes: props.onSaveToNotes }
      : {}),
    ...(replyPrivatelyOpen !== undefined && !selecting
      ? {
          replyPrivately: {
            open: replyPrivatelyOpen,
            senderGone: (userId: string) =>
              isFormerMember(workspaceId ?? null, userId) || props.mentionGone?.(userId) === true,
            ...(replyPrivatelyDraft !== undefined ? { draft: replyPrivatelyDraft } : {}),
          },
        }
      : {}),
    ...(props.onNavigate !== undefined ? { onOpenPrivateReplyHref: props.onNavigate } : {}),
  };
  const pane = (
    <div ref={rootRef} className="relative flex h-full flex-col bg-bg">
      <ThreadTopStrip layout={layout} />
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-3 border-b bg-panel lit-header',
          sized(HEADER_PAD, layout),
        )}
      >
        {selecting ? (
          <>
            {props.onBack !== undefined ? (
              <IconButton label="Cancel selection" onClick={cancelSelection}>
                <IconChevronLeft size={ICON_SIZE.control} />
              </IconButton>
            ) : null}
            <SelectionHeader count={selected.size} onCancel={cancelSelection} layout={layout} />
          </>
        ) : (
          <>
            {props.onBack !== undefined ? (
              <IconButton label="Back to conversations" onClick={props.onBack}>
                <IconChevronLeft size={ICON_SIZE.control} />
              </IconButton>
            ) : null}
            <ThreadHeaderIdentity
              isGroup={props.isGroup === true}
              title={props.title}
              avatarUrl={props.avatarUrl ?? null}
              presence={headerAvatarPresence(props.presence)}
              headerLine={headerLine}
              layout={layout}
              notes={notes}
              searchWords={headerWords}
              {...(!notes && props.isGroup !== true && (props.peerUserId ?? null) !== null
                ? { photoUserId: props.peerUserId ?? null }
                : {})}
              {...(canOpenContact
                ? { onOpenContact: () => setContactOpen(true) }
                : props.isGroup === true && props.onOpenInfo !== undefined
                  ? { onOpenContact: props.onOpenInfo }
                  : {})}
            />
            {/* FT46: no Info icon; the identity tap opens Group info. */}
          </>
        )}
      </div>
      {stripSlot === 'loops' ? (
        <ChatStatus
          channelId={channelId}
          bar={openHeld || (pageLoading && !tickerRemembered) ? null : statusBarState}
          drawer={{
            keys:
              statusBarState !== null && statusBarState.kind === 'items'
                ? drawerKeys(statusBarState.items)
                : [],
            side: viewerSide.side,
            workspaceZone: props.timeZone,
            plans: statusOpenPlans,
            posts: {
              heading: openPostsHeading(viewerSide.side),
              rows: openPosts.posts ?? [],
              count: openPosts.count ?? 0,
            },
            briefs: { rows: statusCounts.briefs.rows, count: statusCounts.briefs.count },
            tasks: { rows: statusTasks, count: statusTasks.length },
          }}
          actions={{
            onOpenPlan: openPlanHere,
            onOpenPlanItem: (planId, itemId) => {
              if (props.onOpenPlanItem !== undefined) {
                props.onOpenPlanItem({ planId, senderName: planSender(planId), itemId });
              } else openPlanHere(planId);
            },
            onOpenTask: (taskId) => openTasks(taskId),
            onSeeAllTasks: () => openTasks(null),
          }}
          navigate={(to) => {
            if (props.onNavigate !== undefined) props.onNavigate(to);
            else window.location.assign(to);
          }}
          briefRoute={briefRoute}
          locationKey={props.locationKey}
          {...(threadsStrip !== null
            ? {
                trailing: (
                  <ThreadsStripItem label={threadsStrip} onOpen={() => setThreadsOpen(true)} />
                ),
              }
            : {})}
        />
      ) : null}
      <SearchWordsContext.Provider value={headerWords}>
        <ReactorLoadContext.Provider value={reactorLoad}>
          <ThreadBody
            {...bodyActions}
            jumpRequest={mainJump}
            {...(props.onEnsureLoaded !== undefined
              ? { onEnsureLoaded: props.onEnsureLoaded }
              : {})}
            messages={shownMessages}
            repliesFor={repliesFor}
            chipFor={chipFor}
            onTalkAbout={talkAbout}
            onTalkAboutFocus={() => focusComposerInput(composerInputRef.current)}
            threads={mainThreads}
            loading={bodyLoading}
            {...(channelId !== undefined ? { olderKey: channelOlderKey(channelId) } : {})}
            {...(props.loadFailed !== undefined ? { loadFailed: props.loadFailed } : {})}
            {...(props.onRetryLoad !== undefined ? { onRetryLoad: props.onRetryLoad } : {})}
            onReply={handleReply}
            // An older page held for its task lines is still loading: the page
            // anchor holds until its rows and lines paint together.
            {...(props.loadingOlder !== undefined || olderPageHeld
              ? { loadingOlder: props.loadingOlder === true || olderPageHeld }
              : {})}
            {...(props.hasMore !== undefined ? { hasMore: props.hasMore } : {})}
            {...(props.onLoadOlder !== undefined ? { onLoadOlder: props.onLoadOlder } : {})}
            {...(props.onNewestVisible !== undefined && !markedHere
              ? { onNewestVisible: props.onNewestVisible }
              : {})}
            {...(props.onToggleReaction !== undefined
              ? { onToggleReaction: props.onToggleReaction }
              : {})}
            reading={{
              unread,
              seen,
              readBy:
                readBy !== null ? { messageId: readBy.message.id, label: readBy.label } : null,
            }}
            onJumpFirstUnread={jumpFirstUnread}
            onOpenReadInfo={() => setReadInfoOpen(true)}
            {...(taskChannel !== null
              ? { taskLines: { events: windowEvents, ctx: taskLineCtx } }
              : {})}
          />
        </ReactorLoadContext.Provider>
      </SearchWordsContext.Provider>
      <WhoReactedSheet
        messageId={reactionsFor}
        onClose={() => setReactionsFor(null)}
        viewerId={props.currentUserId ?? null}
        load={reactorLoad}
        onRemove={(messageId, emoji) => props.onToggleReaction?.(messageId, emoji, true)}
      />
      {readBy !== null ? (
        <MessageInfoSheet
          open={readInfoOpen}
          onClose={() => setReadInfoOpen(false)}
          createdAt={readBy.message.createdAt}
          nowMs={serverNow()}
          read={readBy.read}
          unread={readBy.unread}
          members={groupMembers ?? []}
        />
      ) : null}
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      {view === null && selectionBar === null && (props.currentUserId ?? '') !== '' ? (
        <ThreadHoldTip
          userId={props.currentUserId ?? ''}
          layout={layout}
          empty={props.messages.length === 0}
          openKey={`${channelId ?? ''}:${tipOpenSeq}`}
        />
      ) : null}
      {view === null && selectionBar !== null ? (
        selectionBar
      ) : (
        <Composer
          key={channelKey}
          channelId={channelId}
          expandTitle={props.title}
          inputRef={composerInputRef}
          focusOnMount={finePointer && view === null}
          onSend={composerSend}
          onTyping={props.onTyping}
          onCancelReply={() => setReplyDraft(null)}
          // L3: no quote strip in the main chat; Reply opens the thread.
          {...(notes ? { placeholder: NOTES_PLACEHOLDER } : {})}
          {...(notes ? { notes: true } : {})}
          onCancelAbout={() => setAboutDraft(null)}
          {...(taskChannel !== null
            ? { tasks: { unseen: taskUnseen, onOpen: () => openTasks(null) } }
            : {})}
          sharedPostIds={sharedInChat}
          onBringPost={bringPost}
          {...(onOpenPlanCompose !== undefined && !notes
            ? {
                onOpenPlanCompose: () =>
                  onOpenPlanCompose([
                    ...new Set([
                      ...livePlanIds,
                      ...statusCounts.plans.bundles.map((b) => b.plan.id),
                    ]),
                  ]),
              }
            : {})}
          {...composerShared(view === null)}
        />
      )}
      {canOpenContact && props.channelId !== undefined ? (
        // Namespaced: the Composer above is keyed by the same channel id, and
        // two siblings sharing a key make React leak a Composer copy whenever a
        // slot before them changes (the DM "composer repeated" bug).
        <ContactSheet
          key={`contact:${props.channelId}`}
          open={contactOpen}
          onClose={() => setContactOpen(false)}
          channelId={props.channelId}
          title={props.title}
          avatarUrl={props.avatarUrl ?? null}
          roleLine={contactRoleLine}
          profiles={props.profiles}
          currentUserId={props.currentUserId ?? ''}
          cache={presignCache}
          presignEnabled={presignEnabled}
          {...(onRemoveFiles !== undefined ? { onRemoveFiles } : {})}
        />
      ) : null}
      {props.isGroup === true && props.channelId !== undefined
        ? props.renderGroupInfo?.({
            channelId: props.channelId,
            profiles: props.profiles,
            currentUserId: props.currentUserId ?? '',
            cache: presignCache,
            presignEnabled,
            ...(onRemoveFiles !== undefined ? { onRemoveFiles } : {}),
          })
        : null}
      {onForward !== undefined && forwardChannels !== undefined ? (
        <ForwardPicker
          historyStep
          open={forwardFor !== null && forwardFor.length > 0}
          onClose={() => setForwardFor(null)}
          channels={forwardChannels}
          onSend={(targets) =>
            // A source deleted while the picker was open is no longer forwardable.
            onForward(
              (forwardFor ?? []).filter((m) => messagesById.has(m.id)),
              targets,
            )
          }
          onSent={() => {
            setForwardFor(null);
            exitSelection();
          }}
        />
      ) : null}
      {deleteOneConfirm({
        open: deleteOneFor !== null,
        busy: deleteOneBusy,
        notes,
        copy: deleteOneFor !== null ? deleteConfirmCopy([deleteOneFor]) : null,
        onCancel: () => setDeleteOneFor(null),
        onConfirm: () => void confirmDeleteOne(),
      })}
      <DeleteSheet
        open={deleteSheetFor !== null}
        count={1}
        everyone={deleteSheetFor?.everyone === true}
        onEveryone={() => {
          if (deleteSheetFor !== null) deleteForEveryone(deleteSheetFor.message);
        }}
        onForMe={() => {
          if (deleteSheetFor !== null) hideForMe([deleteSheetFor.message]);
        }}
        onClose={() => setDeleteSheetFor(null)}
      />
      {taskChannel !== null ? (
        <SearchWordsContext.Provider value={headerWords}>
          <TaskSheet
            open={taskSheet.open}
            onClose={closeTasks}
            tasks={chatTasks}
            currentUserId={props.currentUserId ?? ''}
            side={
              viewerSide.side === 'client'
                ? 'client'
                : viewerSide.side === 'agency' || viewerSide.ready
                  ? 'agency'
                  : null
            }
            seenMs={taskSheet.seenAtOpen}
            focusTaskId={taskSheet.focus}
            prefill={taskSheet.prefill}
            timeZone={props.timeZone}
            weekStartDay={workspaceWeekStart}
            {...(onForward !== undefined && forwardChannels !== undefined
              ? {
                  share: {
                    channels: forwardChannels,
                    openChannelId: taskChannel,
                    messages: props.messages,
                    // The plain composer send (outbox): never the about quote.
                    send: (text: string) => props.onSend(text, [], [], null, []),
                    // The long-press Forward's own function.
                    forward: onForward,
                    snapshot: () =>
                      shareSnapshot({
                        chatName: props.title,
                        tasks: chatTasks.tasks,
                        nowMs: Date.now(),
                      }),
                    onShared: jumpTo,
                  },
                }
              : {})}
          />
        </SearchWordsContext.Provider>
      ) : null}
      {myThreads !== null ? (
        <ThreadsSheet
          open={threadsOpen && !selecting}
          onClose={() => setThreadsOpen(false)}
          threads={myThreads}
          loaded={known}
          currentUserId={props.currentUserId ?? ''}
          nameOf={profileNameFor}
          cardTitleOf={threadCardTitle}
          photoOf={(userId) =>
            userId !== null ? (props.profiles.get(userId)?.avatarUrl ?? undefined) : undefined
          }
          onOpenThread={(rootId) => {
            setThreadsOpen(false);
            openThread(rootId, true, true);
          }}
        />
      ) : null}
      <PaintLogOverlay />
    </div>
  );
  return (
    <div ref={shellRef} className="relative h-full">
      {pane}
      {view !== null && viewParts !== null && viewThreads !== undefined ? (
        <ThreadViewTitled
          key={`thread:${view.rootId}`}
          root={viewRoot}
          postTitle={viewPostTitle}
          subtitle={viewSubtitle}
          selecting={selecting}
          onClosed={closeThread}
          behindRef={rootRef}
        >
          <ReactorLoadContext.Provider value={reactorLoad}>
            <ThreadBody
              {...bodyActions}
              {...(viewToggleReaction !== undefined
                ? { onToggleReaction: viewToggleReaction }
                : {})}
              jumpRequest={viewJump !== null && viewJump.id !== view.rootId ? viewJump : null}
              messages={viewMessages}
              chipFor={chipFor}
              threads={viewThreads}
              loading={false}
              onReply={viewHandleReply}
              reading={{ unread: viewUnread, seen: null, readBy: null }}
              hideQuotes
              loadingOlder={threadView.loadingOlder}
              hasMore={view.hasMore}
              onLoadOlder={threadView.loadOlder}
              olderKey={threadOlderKey(view.rootId)}
              loadOlderRow
            />
          </ReactorLoadContext.Provider>
          <ThreadViewFill
            loading={view.loading === true}
            failed={view.failed === true}
            onRetry={threadView.retry}
          />
          {selectionBar ?? (
            <Composer
              key={`thread:${view.rootId}`}
              expandTitle={viewTitle}
              inputRef={viewComposerInputRef}
              focusOnMount={finePointer}
              focusForReply={viewFocus}
              onSend={viewSend}
              placeholder={THREAD_REPLY_PLACEHOLDER}
              onCancelReply={() => setViewReply(null)}
              {...composerShared(true)}
            />
          )}
        </ThreadViewTitled>
      ) : null}
    </div>
  );
}
