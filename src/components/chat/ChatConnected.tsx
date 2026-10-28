import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/cn';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useWorkspace, workspaceDisplayName } from '@/lib/workspace-context';
import { chatDisplayName } from '@/lib/chat/chat-name';
import {
  peekMentionProfiles,
  readGroupMemberIdsShared,
  readMentionProfilesShared,
  startChatMembers,
} from '@/lib/chat/open-members';
import { peekWorkspaceMembers } from '@/lib/workspace-members';
import {
  READ_TIMEOUT_MS,
  withReadTimeout,
  type ChannelSummary,
  type ChatProfile,
  type MentionProfile,
} from '@/lib/chat-reads';
import {
  fanoutTarget,
  sameTarget,
  targetFromSummary,
  type ChannelTarget,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { loadScope, selectHidden, type ChatLoadStatus } from '@/lib/chat/chat-store';
import {
  openChannelAfterRoster,
  reloadedFor,
  resolveLiveTarget,
  shownChannel,
  rosterSignalTargets,
  sendRosterSignal,
  withRosterSignal,
  type RosterChange,
} from '@/lib/chat/roster-signal';
import { generateTraceId } from '@/lib/trace';
import { clearChannelRecord } from '@/lib/chat/record';
import { runClearChannels, type ClearRunResult } from '@/lib/chat/clear-flow';
import { safeTimeZone } from '@/lib/time';
import { PREWARM_LIMIT, prewarmChats, useChatThread } from '@/lib/chat/use-chat-thread';
import { readChatOpenBundle } from '@/lib/chat/history';
import { readPlanBundles } from '@/lib/chat/plans';
import { notePlanShapes, planCardsSized } from '@/lib/chat/plan-shapes';
import { whenIdle } from '@/lib/chunk-reload';
import { useChatMarks } from '@/lib/chat/use-chat-marks';
import { chatKey, forgetRememberedThread, kickoffChatOpen, openCache } from '@/lib/chat/open-cache';
import { joinChatBundle, pressChatBundle } from '@/lib/chat/open-bundle';
import { resolveViewerSide } from '@/lib/chat/viewer-role';
import { createStarStore, StarStoreContext, useChannelStars } from '@/lib/chat/stars';
import { useChatTyping } from '@/lib/chat/use-chat-typing';
import { visibleTypingIds } from '@/lib/chat/typing';
import { useChatPresence } from '@/lib/chat/use-chat-presence';
import { ROSTER_READ_BUDGET_MS, useChatStore } from '@/components/chat/ChatStoreProvider';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconChat } from '@/components/ui/icons';
import { ChannelList, visibleChannels } from '@/components/chat/ChannelList';
import {
  MessageThread,
  profileNameOf,
  threadCardIds,
  threadOpeningSkeleton,
} from '@/components/chat/MessageThread';
import {
  ChatScheduleProvider,
  type ChatSchedule,
  type ScheduleOutcome,
} from '@/components/chat/ScheduleContext';
import { ScheduledListSheet } from '@/components/chat/ScheduledListSheet';
import {
  cancelScheduledMessage,
  mapScheduleError,
  readScheduledMessages,
  rowMentions,
  scheduleMessage,
  sendScheduledNow,
  updateScheduledMessage,
  type ScheduledRow,
  type ScheduleWriteResult,
} from '@/lib/chat/scheduled';
import { newMessageId } from '@/lib/chat/message-id';
import { SharedCardsProvider } from '@/components/chat/PostCard';
import { PlanCardsProvider, type OpenPlanRequest } from '@/components/chat/PlanCardsProvider';
import { PlanComposeScreen, PlanSharedNotice } from '@/components/chat/PlanComposeScreen';
import { PlanPickerSheet } from '@/components/chat/PlanPickerSheet';
import { PlanScreen } from '@/components/chat/PlanScreen';
import { PLAN_SHARED_TOAST } from '@/components/chat/plan-card';
import { useChatLayout } from '@/components/chat/chat-type';
import { NewChatSheet } from '@/components/chat/NewChatSheet';
import { GroupInfoSheet, type GroupInfoTabsWiring } from '@/components/chat/GroupInfoSheet';
import { leaveSelectionThen } from '@/lib/chat/forward';
import {
  chatEntryFrom,
  entryUsr,
  hasPreviousEntry,
  HISTORY_STEP_KEYS,
  openedFromList,
  useHistoryStep,
} from '@/lib/chat/use-history-step';
import { hasSearchJump, readSearchJump, withoutSearchJump } from '@/lib/search/jump';
import { startDmChannel } from '@/components/chat/chat-actions';
import { mentionGone, useChannelMembersState } from '@/components/chat/use-channel-members';
import { channelHasClient } from '@/components/chat/ComposerTray';
import {
  knownMentionName,
  mentionIds,
  mentionTargets,
  rememberMentionProfiles,
  rememberMentionRead,
} from '@/lib/chat/mentions';
import { useToast } from '@/components/ui/toast';
import { ReminderProvider } from '@/components/chat/ReminderContext';
import { ChatReminderSheet } from '@/components/chat/ReminderSheet';
import { SavedFromProvider, type SavedFromWiring } from '@/components/chat/NotesBits';
import { useNotes } from '@/lib/chat/use-notes';
import { useCurrentProfile } from '@/lib/use-current-profile';
import {
  isNotes,
  liveClientFor,
  saveToNotesEntry,
  SAVED_TO_NOTES_TOAST,
  withNotesFirst,
} from '@/lib/chat/notes';
import {
  readSavedSources,
  savedFromLine,
  savedSourceIds,
  type SavedSource,
} from '@/lib/chat/saved-from';
import type { ForwardSendResult } from '@/components/chat/ForwardPicker';
import type { Result } from '@srtdio/rpc';

interface ChatConnectedProps {
  client: ChatConnection | null;
  status: ChatStatus;
  workspaceId: string;
  currentUserId: string;
}

const NO_MESSAGES: ThreadMessage[] = [];
const NO_PLAN_IDS: readonly string[] = [];

const NO_SCHEDULED: ScheduledRow[] = [];

/**
 * A chat tap: the open's one chat_open_bundle call starts now (open-cache's
 * kickoff over the app's reads), with the viewer side, so nothing waits for
 * the thread to mount. The hooks' first rounds join it.
 */
export function startChatOpen(userId: string, workspaceId: string, channelId: string): void {
  const key = chatKey(userId, workspaceId, channelId);
  if (key === null) return;
  kickoffChatOpen(key, {
    bundle: (k) => void joinChatBundle(k),
    viewerSide: () => void resolveViewerSide(supabase, workspaceId, userId),
  });
  // The members the names and the pickers answer from, in parallel with the
  // page (joined by them, and by the next chat's open, while fresh). A warm
  // app members cache answers instead: nothing is read.
  if (peekWorkspaceMembers(userId, workspaceId) === null) {
    void startChatMembers(supabase, userId, workspaceId);
  }
}

/**
 * A press on a chat row (pointerdown, before the tap): the open's one
 * chat_open_bundle call starts now (or a held pre-warm is left for the tap,
 * nothing read). The tap's kickoff joins it: one bundle read for both.
 */
export function pressChatOpen(userId: string, workspaceId: string, channelId: string): void {
  const key = chatKey(userId, workspaceId, channelId);
  if (key === null) return;
  void pressChatBundle(key);
}

/**
 * The names a tapped chat's remembered page needs (its senders, @mentions and
 * DM peer not held yet), answered now from the held workspace members, so its
 * first frame paints with them instead of waiting on the names read. Null
 * when there is no remembered page, nothing is needed, or the held members
 * cannot answer every id (the names read runs as before). The answer is the
 * one that read gives from the same members, membership included.
 */
export function heldOpenNames(input: {
  page: { rows: readonly ThreadMessage[] } | undefined;
  peerUserId: string | null;
  held: ReadonlyMap<string, unknown>;
  peek: (ids: readonly string[]) => MentionProfile[] | null;
}): { ids: string[]; profiles: MentionProfile[] } | null {
  if (input.page === undefined) return null;
  const ids = profileIdsNeeded({
    messages: input.page.rows,
    peerUserId: input.peerUserId,
    held: input.held,
  });
  if (ids.length === 0) return null;
  const profiles = input.peek(ids);
  return profiles !== null ? { ids, profiles } : null;
}

const NO_TYPING: string[] = [];

/**
 * When the pre-warm runs: only once the list is ready, only while the tab is
 * visible (a hidden tab waits for visible), and only at idle, after paint.
 * Returns the cancel. Injected so tests drive it without a browser.
 */
export function schedulePrewarm(input: {
  ready: boolean;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  idle: (task: () => void) => () => void;
  run: () => void;
}): () => void {
  if (!input.ready) return () => {};
  let cancelIdle: (() => void) | null = null;
  let stopListening: (() => void) | null = null;
  const start = (): void => {
    if (!input.visible() || cancelIdle !== null) return;
    stopListening?.();
    stopListening = null;
    cancelIdle = input.idle(input.run);
  };
  stopListening = input.onVisibilityChange(start);
  start();
  return () => {
    cancelIdle?.();
    stopListening?.();
  };
}

/** Whether the device asks to save data (Save-Data); false where the browser does not say. */
function saveDataOn(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/** What the open notes thread knows about its saved copies' sources. */
interface SavedState {
  /** workspace:channel the sources belong to. */
  key: string;
  /** Source id to its row, or null when it came back unreadable. */
  sources: ReadonlyMap<string, SavedSource | null>;
  /** Ids whose last read failed (no line yet; asked again on the next open). */
  failed: ReadonlySet<string>;
}

const NO_SAVED: SavedState = { key: '', sources: new Map(), failed: new Set() };

/** The toast when opening a DM from a mention fails; the raw error is only logged. */
/**
 * The chat list pane's classes. While the docked plan panel is open the list
 * is set aside in place (invisible, absolute, never unmounted) so it returns on
 * close with its scroll, and the thread beside it keeps its own scroll (same
 * element, it only widens):
 * - 768 to 891px: the open panel takes the list's room.
 * - 1180 to 1439px: the thread takes the list's place beside the panel.
 * From 1440px all three panes show; 892 to 1179px the panel overlays.
 */
export function chatListPaneClass(planPanelOpen: boolean): string {
  return cn(
    'h-full w-full border-border md:w-72 md:border-r xl:w-[352px]',
    planPanelOpen &&
      'max-[891px]:pointer-events-none max-[891px]:invisible max-[891px]:absolute max-[891px]:inset-y-0 max-[891px]:left-0',
    planPanelOpen &&
      'min-[1180px]:max-[1439px]:pointer-events-none min-[1180px]:max-[1439px]:invisible min-[1180px]:max-[1439px]:absolute min-[1180px]:max-[1439px]:inset-y-0 min-[1180px]:max-[1439px]:left-0',
  );
}

export const MENTION_DM_FAILED = "Couldn't open that chat. Try again.";

/**
 * The user ids a thread's first paint needs names for: every sender, the DM
 * peer, and every @mention in a body or a reply quote, plus anyone shown as
 * typing, minus the ones already held. One batched read covers them all (no
 * per-token fetch). Pure.
 */
export function profileIdsNeeded(input: {
  messages: readonly ThreadMessage[];
  peerUserId: string | null;
  held: ReadonlyMap<string, unknown>;
  typingUserIds?: readonly string[];
}): string[] {
  const { messages, peerUserId, held, typingUserIds = [] } = input;
  const needed = new Set<string>();
  const add = (id: string | null): void => {
    if (id !== null && !held.has(id)) needed.add(id);
  };
  for (const message of messages) {
    add(message.senderUserId);
    for (const id of rowNameIds(message)) add(id);
  }
  for (const id of typingUserIds) add(id);
  add(peerUserId);
  return [...needed];
}

/**
 * Where the thread's profile reads left each id they asked about. `unknown`:
 * a read succeeded without it (an ex-member); it renders "@Former member" for
 * good and is never read again. `failed`: its last read failed; it renders
 * nothing extra (inert) for now and rides along on the next read.
 */
export interface NameReads {
  unknown: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}

export const NO_NAME_READS: NameReads = { unknown: new Set(), failed: new Set() };

/** The ids a row's first paint names: its @mentions, its quote's author and the quote's @mentions. */
export function rowNameIds(message: ThreadMessage): string[] {
  const ids = mentionIds(message.body);
  if (message.reply !== null) {
    if (message.reply.authorUserId !== null) ids.push(message.reply.authorUserId);
    ids.push(...mentionIds(message.reply.preview));
  }
  return ids;
}

const NO_PROFILES: Map<string, ChatProfile> = new Map();

const NOTHING_PAINTED: ReadonlySet<string> = new Set();

/** An own bubble not yet in the record (optimistic or in the outbox). */
function ownSend(message: ThreadMessage): boolean {
  return message.mine && message.state !== 'sent';
}

/**
 * The rows that may paint: each id a row names is known, or its read settled
 * (unknown or failed). A row still waiting on a read is held back, so a live
 * row or an older page never paints "@Unknown member" and then changes. A held
 * row queues every later row behind it (they release together, in order), so
 * a row never lands above a newer one already on screen. Never held: a row
 * already painted (`painted`, so a switch or a retry never takes one away) and
 * my own sends (their unresolved names draw inert until they arrive). An own
 * send releases every row held ahead of it in the same pass, so it always
 * paints below them. An older page's rows release together as one batch.
 * The same array comes back when nothing is held. Pure.
 */
export function paintableMessages(
  messages: ThreadMessage[],
  isKnown: (userId: string) => boolean,
  reads: NameReads,
  painted: ReadonlySet<string> = NOTHING_PAINTED,
): ThreadMessage[] {
  const settled = (id: string): boolean =>
    isKnown(id) || reads.unknown.has(id) || reads.failed.has(id);
  // An older page (unpainted rows above the first painted one) releases as
  // one batch: all of it once every row in it has settled, else none of it.
  const firstPainted = messages.findIndex((m) => painted.has(m.id));
  const olderSettled =
    firstPainted > 0 &&
    messages.slice(0, firstPainted).every((m) => ownSend(m) || rowNameIds(m).every(settled));
  const shown = new Set<string>();
  let held: string[] = [];
  for (const [index, m] of messages.entries()) {
    if (index < firstPainted && !ownSend(m)) {
      if (olderSettled) shown.add(m.id);
      else held.push(m.id);
    } else if (ownSend(m)) {
      // My own send never paints above rows held ahead of it: they release
      // now, in order (unresolved names draw inert), and my row paints last.
      for (const id of held) shown.add(id);
      held = [];
      shown.add(m.id);
    } else if (painted.has(m.id)) shown.add(m.id);
    else if (held.length === 0 && rowNameIds(m).every(settled)) shown.add(m.id);
    else held.push(m.id);
  }
  return shown.size === messages.length ? messages : messages.filter((m) => shown.has(m.id));
}

/**
 * Fold a mention profile read in: like applyProfileRead, except a read whose
 * membership half failed (member null) counts as failed for every asked id, so
 * their mentions keep the failed-read behaviour (inert, retried) while the
 * profiles themselves are kept for senders. Pure.
 */
export function applyMentionProfileRead(
  reads: NameReads,
  requested: readonly string[],
  result: Result<MentionProfile[]>,
): NameReads {
  if (result.ok && result.data.some((p) => p.member === null)) {
    return applyProfileRead(reads, requested, {
      ok: false,
      error: { code: 'unknown', message: 'membership unknown' },
    });
  }
  return applyProfileRead(reads, requested, result);
}

/**
 * The ids the next batched read asks for: every needed id never read (and not
 * in flight), plus, alongside them, the ones whose last read failed (a retry).
 * Empty when nothing new is needed, so a failure never loops; `retryFailed`
 * (a chat was opened) asks for the failed ones on their own. They stay failed
 * (so their rows stay painted) until the read answers. Pure.
 */
export function idsToRead(
  needed: readonly string[],
  reads: NameReads,
  inFlight: ReadonlySet<string>,
  retryFailed = false,
): string[] {
  const fresh = needed.filter(
    (id) => !reads.unknown.has(id) && !reads.failed.has(id) && !inFlight.has(id),
  );
  if (fresh.length === 0 && !retryFailed) return [];
  const retry = [...reads.failed].filter((id) => !inFlight.has(id) && !fresh.includes(id));
  return [...fresh, ...retry];
}

/**
 * Fold one read's outcome in. Success: the ids it did not return are unknown
 * (ex-members) and none of the asked ids stays failed. Failure: the asked ids
 * are failed, never unknown, so the next read retries them. Pure.
 */
export function applyProfileRead(
  reads: NameReads,
  requested: readonly string[],
  result: Result<ChatProfile[]>,
): NameReads {
  const failed = new Set(reads.failed);
  if (!result.ok) {
    for (const id of requested) failed.add(id);
    return { unknown: reads.unknown, failed };
  }
  const returned = new Set(result.data.map((p) => p.userId));
  const unknown = new Set(reads.unknown);
  for (const id of requested) {
    failed.delete(id);
    if (!returned.has(id)) unknown.add(id);
  }
  return { unknown, failed };
}

/**
 * The deep link's jump target: ?message= only counts alongside the ?channel= it
 * belongs to. Pure.
 */
export function messageParamTarget(
  params: URLSearchParams,
): { channelId: string; messageId: string } | null {
  const channelId = params.get('channel');
  const messageId = params.get('message');
  if (channelId === null || channelId === '' || messageId === null || messageId === '') return null;
  return { channelId, messageId };
}

/** The toast when a deep link names a chat that is not in my list. */
export const CHAT_UNAVAILABLE_TOAST = "That chat isn't available";

/**
 * What a ?channel= deep link does once the roster is ready: open that chat
 * (with its ?message= jump, if any), or, when the chat is not in my list, say
 * so and stay on the list (no jump is kept). Pure.
 */
export function deepLinkStep(
  params: URLSearchParams,
  roster: readonly ChannelSummary[],
): {
  open: ChannelSummary | null;
  jump: { channelId: string; messageId: string } | null;
  unavailable: boolean;
} {
  const channelId = params.get('channel');
  const found = roster.find((c) => c.channelId === channelId) ?? null;
  return {
    open: found,
    jump: found !== null ? messageParamTarget(params) : null,
    unavailable: found === null,
  };
}

/**
 * The pending jump after the open chat changed: kept only while it is for the
 * chat now open, so switching away or closing before it ran drops it. Pure.
 */
export function pendingJumpAfter(
  pending: { channelId: string; messageId: string } | null,
  selectedChannelId: string | null,
): { channelId: string; messageId: string } | null {
  return pending !== null && pending.channelId === selectedChannelId ? pending : null;
}

/**
 * A deep link whose chat is not in my list re-reads the list once before
 * saying it is unavailable (a chat made moments ago may not be in the snapshot
 * yet). A failed re-read, or one still unanswered after `timeoutMs` (the
 * reload's own budget in the app), counts as absent. Pure over the injected
 * reload.
 */
export async function deepLinkAfterRefresh(
  params: URLSearchParams,
  roster: readonly ChannelSummary[],
  reload: () => Promise<readonly ChannelSummary[] | null>,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<ReturnType<typeof deepLinkStep>> {
  const step = deepLinkStep(params, roster);
  if (step.open !== null) return step;
  const next = await withReadTimeout(async (): Promise<Result<readonly ChannelSummary[]>> => {
    const list = await reload();
    return list !== null
      ? { ok: true, data: list }
      : { ok: false, error: { code: 'unknown', message: 'roster reload failed' } };
  }, timeoutMs);
  return deepLinkStep(params, next.ok ? next.data : []);
}

/** Where a deep-link refresh started, and where the page is when it answers. */
export interface DeepLinkRefreshContext {
  mounted: boolean;
  workspaceId: string | null;
  channel: string | null;
}

/**
 * What a deep-link refresh's answer does: it applies only while the page is
 * still mounted on the same workspace with the same ?channel=; otherwise it is
 * dropped silently (no open, no toast). Pure.
 */
export function deepLinkRefreshOutcome(
  step: ReturnType<typeof deepLinkStep>,
  started: DeepLinkRefreshContext,
  now: DeepLinkRefreshContext,
): 'open' | 'toast' | 'discard' {
  if (!now.mounted || now.workspaceId !== started.workspaceId || now.channel !== started.channel)
    return 'discard';
  return step.open !== null ? 'open' : 'toast';
}

/**
 * The chat being opened before its row is known: a ?channel= deep link (an
 * email link, an Activity tap, a reload inside the thread) or a toast's open
 * request, while nothing is selected yet. Its pane paints the thread skeleton
 * from the first frame, never the list or "Select a conversation". A failed
 * list load, or a link that turns out unknown or unreadable (the param is
 * stripped), opens nothing: chat home shows. Pure.
 */
export function openingChannelId(input: {
  selectedChannelId: string | null;
  channelParam: string | null;
  pendingOpen: string | null;
  loadStatus: ChatLoadStatus;
}): string | null {
  if (input.loadStatus === 'error') return null;
  // A link to another chat while one is open (A open, link to B): B's
  // skeleton at once, never another frame of A.
  if (input.channelParam !== null && input.channelParam !== input.selectedChannelId) {
    return input.channelParam;
  }
  if (input.selectedChannelId !== null) return null;
  return input.pendingOpen;
}

/**
 * The chat a ?channel= deep link opens before the list is in: its bundle,
 * viewer side and members start at mount (startChatOpen), in parallel with
 * the list load, never after it. Once per link (`started`: the last one
 * kicked off). Nothing while a chat is selected, for Personal notes (their own
 * path), or once the list is ready or failed (the deep-link step opens it, or
 * toasts). A link the list then says is not visible never mounts a thread for
 * it, so its stashed reads are never applied (they are keyed by the chat). Pure.
 */
export function earlyDeepLinkOpen(input: {
  channelParam: string | null;
  selectedChannelId: string | null;
  notesChannelId: string | null;
  loadStatus: ChatLoadStatus;
  started: string | null;
}): string | null {
  const channel = input.channelParam;
  if (channel === null || channel === '') return null;
  if (input.loadStatus === 'ready' || input.loadStatus === 'error') return null;
  if (input.selectedChannelId !== null || channel === input.notesChannelId) return null;
  return channel === input.started ? null : channel;
}

/**
 * Whether the open chat paints its skeleton. Stars are not a part: rows
 * paint, and star badges appear when the stars read settles (remembered
 * stars still paint in the first frame). Pure.
 */
export function chatThreadLoading(input: {
  threadCurrent: boolean;
  notesFailed: boolean;
  pageLoading: boolean;
  namesReady: boolean;
  scheduledSettled: boolean;
  notesOpen: boolean;
  notesStatusReady: boolean;
  notesReady: boolean;
  savedReady: boolean;
}): boolean {
  return (
    !input.threadCurrent ||
    (!input.notesFailed &&
      (input.pageLoading ||
        !input.namesReady ||
        !input.scheduledSettled ||
        (input.notesOpen && !input.notesStatusReady) ||
        (input.notesReady && !input.savedReady)))
  );
}

/** The jump the open chat takes: the pending one only while it is for this chat. Pure. */
/** The latest loaded message carrying a card for this plan, or null (Go to card). Pure. */
export function latestPlanCardId(
  messages: ReadonlyArray<{ id: string; sharedPlanIds?: string[] | undefined }>,
  planId: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && (m.sharedPlanIds ?? []).includes(planId)) return m.id;
  }
  return null;
}

export function initialJumpFor(
  pending: { channelId: string; messageId: string } | null,
  channelId: string,
): string | null {
  return pending?.channelId === channelId ? pending.messageId : null;
}

/** What opening a DM from a tapped mention needs. */
export interface MentionDmDeps {
  workspaceId: string;
  /** The existing open-or-create DM function (startDmChannel), bound to its client. */
  start: (
    params: { workspaceId: string; peerUserId: string; traceId: string },
    onOpen: (channelId: string) => void,
  ) => Promise<{ message: string } | null>;
  /** Select and open the DM once it exists. */
  onOpen: (channelId: string) => void;
  onFailed: (traceId: string, message: string) => void;
}

/** Open (or create) my DM with a mentioned person, one fresh trace per tap. */
export async function openMentionDm(userId: string, deps: MentionDmDeps): Promise<void> {
  const traceId = generateTraceId();
  const failure = await deps.start(
    { workspaceId: deps.workspaceId, peerUserId: userId, traceId },
    deps.onOpen,
  );
  if (failure !== null) deps.onFailed(traceId, failure.message);
}

/**
 * Resolve the open chat's Agora target defensively; a bad row yields no target.
 * A group not synced to Agora yet fans out per member once its member ids are
 * loaded (none while they are not, or above 50 recipients).
 */
function safeTarget(
  channel: ChannelSummary | null,
  memberIds: readonly string[] | null,
  currentUserId: string,
): ChannelTarget | null {
  if (channel === null) return null;
  try {
    const direct = targetFromSummary(channel);
    if (direct !== null || channel.channelType !== 'group' || memberIds === null) return direct;
    return fanoutTarget(channel.channelId, memberIds, currentUserId);
  } catch (error) {
    logger.error('chat: failed to derive channel target', { error: String(error) });
    return null;
  }
}

/** How a chat's ?channel= is written: an open is a history step, a strip or auto-close is not. */
export type ChannelWrite = 'push' | 'replace';

/**
 * Why ?channel= is written, and so how. An open (list, notes, search hit,
 * starred row, @mention, new DM, saved line, toast) pushes one step; a toast's
 * pending open takes the /chat entry its press already pushed; a chat closing
 * on its own, a cold open's back arrow and an unknown link replace. Pure.
 */
export function channelWriteFor(
  why: 'open' | 'pendingOpen' | 'autoClose' | 'coldBack' | 'unknown',
): ChannelWrite {
  return why === 'open' ? 'push' : 'replace';
}

/**
 * Whether a ?channel= change closes the open chat: only present -> absent
 * (back to the list), on every layout. Pure.
 */
export function closesOnParamLoss(prev: string | null, next: string | null): boolean {
  return prev !== null && next === null;
}

/**
 * The chat header's back arrow (and the opening skeleton's): the same as the
 * back swipe while an in-app entry sits below, else (a cold open from an
 * outside link) the chat list in place. Pure.
 */
export function chatBackAction(historyState: unknown): 'pop' | 'list' {
  return hasPreviousEntry(historyState) ? 'pop' : 'list';
}

/**
 * A chat closing on its own (left, removed, deleted, unknown link): opened
 * from the bare chat list (the entry below), it pops back to that entry, so
 * no two list entries sit in a row; otherwise it replaces its own entry with
 * the list. Pure.
 */
export function autoCloseAction(historyState: unknown): 'pop' | 'replace' {
  return openedFromList(historyState) ? 'pop' : 'replace';
}

export function ChatConnected(props: ChatConnectedProps): ReactElement {
  const { client, status, workspaceId, currentUserId } = props;
  const isDesktop = useIsLaptop();
  const { workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  // Every chat screen shows the workspace as "<Brand> - <Platform>"; stored group names stay as they are.
  const workspaceLabel = workspace !== undefined ? workspaceDisplayName(workspace) : undefined;
  // The workspace civil clock the plan logic (plan weeks, today) reads; the
  // device zone when the workspace has none. Visible times read the viewer's
  // device zone (src/lib/time.ts), never this.
  const timeZone = safeTimeZone(workspace?.timezone);

  const [selected, setSelected] = useState<ChannelSummary | null>(null);
  // The thread's profiles belong to one workspace: another workspace starts
  // from none, so names and membership are read again there.
  const [profileState, setProfileState] = useState<{
    workspaceId: string;
    profiles: Map<string, ChatProfile>;
  }>(() => ({ workspaceId, profiles: new Map() }));
  const profiles = profileState.workspaceId === workspaceId ? profileState.profiles : NO_PROFILES;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  // An Activity mention's ?message=: the thread opens with it in view.
  const [pendingJump, setPendingJump] = useState<{ channelId: string; messageId: string } | null>(
    null,
  );
  // A search jump's words for the chat it opens (the message, a task or the
  // group itself): the thread takes them once and keeps them until it closes.
  const [pendingWords, setPendingWords] = useState<{
    channelId: string;
    words: readonly string[];
  } | null>(null);
  // The first page paints once its names (senders and @mentions) are in.
  const [namesSettled, setNamesSettled] = useState<string | null>(null);
  const toast = useToast();

  const {
    state: chatStore,
    loadStatus,
    roster,
    retryLoad,
    reloadRoster,
    rosterReload,
    groupMembers: groupMemberCache,
    setActive,
    markConversationRead,
    updateOwnMessage,
    updateEditedMessage,
    refreshUnreadCounts,
    refreshPreviews,
    clearPendingOpen,
    outbox,
    clearConversation,
  } = useChatStore();
  const layout = useChatLayout();
  // Personal notes: built from the session (never waits on a read), ensured
  // once per workspace per session in the background.
  // The notes avatar is the user's own photo: the profile AppLayout already
  // reads (one shared store), so no read here and none per row.
  const { profile: ownProfile } = useCurrentProfile();
  const notes = useNotes({
    workspaceId,
    currentUserId,
    avatarUrl: ownProfile?.avatar_url ?? null,
  });
  const notesChat = notes.summary;
  // Every chat the page resolves against: notes first (forward picker, deep
  // links, search hit names), then the roster.
  const chatRoster = useMemo(() => withNotesFirst(roster, notesChat), [roster, notesChat]);

  // The open thread lives in ?channel={channelId}, so the shell hides the
  // mobile chrome in the same render the thread opens. Every open pushes one
  // history step (back returns to where it was opened from); strips and a
  // chat closing on its own replace. Opening and closing set the state and the
  // param in one batch; only 'channel' is touched, preserving any sibling
  // deep-link param. Layers inside a chat are steps of their own
  // (lib/chat/use-history-step); leaveSelectionThen closes them before any
  // open or close, so the param is always written from the chat's own entry.
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // The status drawer restores only on a Back to this history entry.
  const locationKey = useLocation().key;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The latest workspace and ?channel=, and whether the page is still mounted,
  // for answers that land after the render that asked.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  const channelParamRef = useRef(searchParams.get('channel'));
  channelParamRef.current = searchParams.get('channel');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const writeChannelParam = useCallback(
    (channelId: string | null, mode: ChannelWrite) => {
      // Already there: no entry (a push would leave a duplicate step).
      if ((channelParamRef.current || null) === channelId) return;
      const fromBareList = (channelParamRef.current || null) === null;
      channelParamRef.current = channelId;
      // A push records whether it came from the bare list; a replace keeps the
      // entry's own record.
      const state =
        mode === 'push'
          ? chatEntryFrom(fromBareList, window.history.state)
          : entryUsr(window.history.state);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (channelId === null) next.delete('channel');
          else next.set('channel', channelId);
          return next;
        },
        { replace: mode === 'replace', state },
      );
    },
    [setSearchParams],
  );
  const openChannel = useCallback(
    (channel: ChannelSummary, mode: ChannelWrite = channelWriteFor('open')) => {
      // The chat already open (a group edit's re-read): update its row only;
      // its layers (group info) stay open. The param write is a no-op while it
      // matches; it lands only if the param was lost meanwhile (a toast's /chat).
      if (selectedRef.current?.channelId === channel.channelId) {
        setSelected(channel);
        writeChannelParam(channel.channelId, mode);
        return;
      }
      leaveSelectionThen(() => {
        setSelected(channel);
        writeChannelParam(channel.channelId, mode);
      });
    },
    [writeChannelParam],
  );
  // A message search hit: the chat opens at that message (the jump and its
  // highlight) with the in-chat bar on the query. seq repeats a same-chat tap.
  const [searchRequest, setSearchRequest] = useState<{
    channelId: string;
    messageId: string;
    query: string;
    seq: number;
    jumpOnly?: boolean;
    /** A search jump: a message that is gone opens the chat with no toast. */
    quiet?: boolean;
  } | null>(null);
  // Leave the chat's entry for the list without a dead or duplicate step:
  // pop to the bare list it was opened from, else replace it with the list.
  // A pop closes the chat when it lands (the param-loss effect below).
  const dropChannelEntry = useCallback(() => {
    if (autoCloseAction(window.history.state) === 'pop') {
      navigate(-1);
      return;
    }
    setSelected(null);
    writeChannelParam(null, channelWriteFor('autoClose'));
  }, [navigate, writeChannelParam]);
  // The chat closing on its own (left, removed, deleted) or a cold open's back
  // arrow. Once per chat: a second close while the first is still landing (a
  // leave, then the roster re-read that drops the group) would pop twice.
  const closingRef = useRef<string | null>(null);
  const closeChannel = useCallback(() => {
    const closing = selectedRef.current?.channelId ?? null;
    if (closing !== null && closingRef.current === closing) return;
    closingRef.current = closing;
    leaveSelectionThen(() => {
      // A hit's jump not taken yet (backed out while loading) never fires later.
      setSearchRequest(null);
      dropChannelEntry();
    });
  }, [dropChannelEntry]);
  // Only ever counts up: a taken request goes back to null, and the next tap
  // in the same open chat must still read as new.
  const searchSeqRef = useRef(0);
  const openSearchHit = useCallback(
    (channel: ChannelSummary, messageId: string, query: string) => {
      searchSeqRef.current += 1;
      setSearchRequest({
        channelId: channel.channelId,
        messageId,
        query,
        seq: searchSeqRef.current,
      });
      openChannel(channel);
    },
    [openChannel],
  );
  // A starred row: the chat opens at that message (the same jump and
  // highlight as a search hit), without the in-chat search bar.
  const openStarredMessage = useCallback(
    (channel: ChannelSummary, messageId: string) => {
      searchSeqRef.current += 1;
      setSearchRequest({
        channelId: channel.channelId,
        messageId,
        query: '',
        seq: searchSeqRef.current,
        jumpOnly: true,
      });
      openChannel(channel);
    },
    [openChannel],
  );

  // Email deep-link: ?channel={channelId} selects that channel once the store's
  // roster is ready, once per distinct id. The param stays while the thread is
  // open; an id not in the roster is stripped so the chrome comes back.
  const selectedFromParam = useRef<string | null>(null);
  // ?message= is consumed once: a replace that keeps the entry's own record.
  const stripMessageParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        // The search jump's own keys go with it (taken once, like ?message=).
        const next = withoutSearchJump(prev);
        next.delete('message');
        return next;
      },
      { replace: true, state: entryUsr(window.history.state) },
    );
  }, [setSearchParams]);
  // A task alert's ?task= (Notifications): the chat opens with its task sheet up and that
  // item expanded. Consumed once, like ?message= (a replace keeps the entry).
  const [pendingTask, setPendingTask] = useState<{ channelId: string; taskId: string } | null>(
    null,
  );
  const taskParam = searchParams.get('task');
  const taskChannelParam = searchParams.get('channel');
  useEffect(() => {
    if (taskParam === null || taskParam === '') return;
    if (taskChannelParam !== null && taskChannelParam !== '') {
      setPendingTask({ channelId: taskChannelParam, taskId: taskParam });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('task');
        return next;
      },
      { replace: true, state: entryUsr(window.history.state) },
    );
  }, [taskParam, taskChannelParam, setSearchParams]);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // A deep link on a cold mount: the open's reads start from the URL now,
  // not after the list load (the step below still selects the row once the
  // list is ready, or re-reads it and toasts).
  const earlyOpenRef = useRef<string | null>(null);
  const earlyChannel = earlyDeepLinkOpen({
    channelParam: searchParams.get('channel'),
    selectedChannelId: selected?.channelId ?? null,
    notesChannelId: notesChat.channelId,
    loadStatus,
    started: earlyOpenRef.current,
  });
  useLayoutEffect(() => {
    if (earlyChannel === null || earlyOpenRef.current === earlyChannel) return;
    earlyOpenRef.current = earlyChannel;
    startChatOpen(currentUserId, workspaceId, earlyChannel);
  }, [earlyChannel, currentUserId, workspaceId]);
  // A layout effect: back or forward onto another chat's entry selects it
  // before the next paint (no frame of the old chat or a skeleton).
  useLayoutEffect(() => {
    // Notes never wait on the roster: they open from the session-built id.
    if (loadStatus !== 'ready' && searchParams.get('channel') !== notesChat.channelId) return;
    const channel = searchParams.get('channel');
    if (channel === null || channel === '') {
      selectedFromParam.current = null;
      return;
    }
    // A search jump's words (q=) ride along with the link; the thread marks them.
    const jumpWords = readSearchJump(searchParams).words;
    const carriesWords = hasSearchJump(searchParams);
    if (selectedFromParam.current === channel) {
      // The open chat's own link with a ?message= (a toast for this chat, or a
      // search result in it): jump to it in place, then drop the param; no step added.
      const messageId = searchParams.get('message');
      if (messageId !== null && messageId !== '' && selectedRef.current?.channelId === channel) {
        searchSeqRef.current += 1;
        setSearchRequest({
          channelId: channel,
          messageId,
          query: '',
          seq: searchSeqRef.current,
          jumpOnly: true,
          quiet: jumpWords.length > 0,
        });
        stripMessageParam();
      }
      if (carriesWords) {
        setPendingWords({ channelId: channel, words: jumpWords });
        stripMessageParam();
      }
      return;
    }
    selectedFromParam.current = channel;
    setPendingWords(carriesWords ? { channelId: channel, words: jumpWords } : null);
    const step = deepLinkStep(searchParams, chatRoster);
    const linkParams = new URLSearchParams(searchParams);
    // ?message= is consumed once: the thread takes it, the url drops it. A link
    // to a chat not (yet) in my list keeps no earlier jump.
    setPendingJump(step.jump);
    if (searchParams.has('message') || carriesWords) stripMessageParam();
    if (selectedRef.current?.channelId === channel) return;
    if (step.open !== null) {
      mark('chat:deeplink:select');
      setSelected(step.open);
      return;
    }
    // Not in the snapshot: re-read the list once; toast only if still absent.
    // The answer applies only on the same mounted page, workspace and link.
    const started: DeepLinkRefreshContext = { mounted: true, workspaceId, channel };
    const reloadWithNotes = async (): Promise<readonly ChannelSummary[] | null> => {
      const next = await reloadRoster();
      return next !== null ? withNotesFirst(next, notesChat) : null;
    };
    void deepLinkAfterRefresh(linkParams, chatRoster, reloadWithNotes, ROSTER_READ_BUDGET_MS).then(
      (again) => {
        if (selectedFromParam.current !== channel) return;
        const outcome = deepLinkRefreshOutcome(again, started, {
          mounted: mountedRef.current,
          workspaceId: workspaceIdRef.current,
          channel: channelParamRef.current,
        });
        if (outcome === 'discard') return;
        if (outcome === 'open' && again.open !== null) {
          setPendingJump(again.jump);
          setSelected(again.open);
          return;
        }
        dropChannelEntry();
        toastRef.current.show({ title: CHAT_UNAVAILABLE_TOAST });
      },
    );
  }, [
    loadStatus,
    chatRoster,
    notesChat,
    searchParams,
    dropChannelEntry,
    stripMessageParam,
    reloadRoster,
    workspaceId,
  ]);

  // A workspace switch forgets which link was handled: a link whose re-read
  // was discarded by the switch is resolved again in the new workspace (open
  // it, or toast and strip it), never left on the opening skeleton.
  useEffect(() => {
    selectedFromParam.current = null;
  }, [workspaceId]);

  // A ?channel= that disappears by any route other than closeChannel (back,
  // external navigation) closes the thread, on a laptop too, before the next
  // paint (the list paints at once). Only the present -> absent transition
  // counts, so an open that sets state before its param lands never reads as
  // a close.
  const channelParam = searchParams.get('channel') || null;
  const prevChannelParam = useRef(channelParam);
  useLayoutEffect(() => {
    const prev = prevChannelParam.current;
    prevChannelParam.current = channelParam;
    if (!closesOnParamLoss(prev, channelParam)) return;
    if (selectedRef.current !== null) setSelected(null);
  }, [channelParam]);

  // Re-read the store's roster after a mutation. When channelId is given, the
  // matching (possibly newly created) channel is selected and opened.
  const refreshChannels = useCallback(
    async (channelId: string | null): Promise<void> => {
      const next = await reloadRoster();
      if (next === null || channelId === null) return;
      const found = next.find((channel) => channel.channelId === channelId);
      if (found !== undefined) openChannel(found);
    },
    [reloadRoster, openChannel],
  );

  const onDmReady = useCallback(
    (channelId: string) => {
      setNewChatOpen(false);
      // A thread selecting messages exits that first (history.back()).
      leaveSelectionThen(() => void refreshChannels(channelId));
    },
    [refreshChannels],
  );

  // Tell the others about a group change after its RPC succeeded: a roster
  // command to the right people, fire-and-forget (5s per send, failure only
  // logged). Never awaited by the action or the UI.
  // Sends started in one workspace are aborted on a switch or unmount: nothing
  // more goes out and late results are ignored.
  const clientRef = useRef(client);
  clientRef.current = client;
  const signalAbortRef = useRef<AbortController>(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    signalAbortRef.current = controller;
    return () => controller.abort();
  }, [workspaceId]);
  const signalRoster = useCallback(
    async (channel: ChannelSummary, change: RosterChange): Promise<void> => {
      const signal = signalAbortRef.current.signal;
      const connection = clientRef.current;
      if (connection === null || signal.aborted) return;
      const groupTarget =
        change.kind === 'created'
          ? null
          : await resolveLiveTarget(channel, currentUserId, groupMemberCache);
      if (signal.aborted) return;
      await sendRosterSignal({
        connection: connection as ThreadConnection,
        createCmd: createCmdMessage,
        targets: rosterSignalTargets(change, groupTarget, currentUserId),
        channelId: channel.channelId,
        kind: change.kind,
        onError: (context) => logger.warn('chat: roster signal failed', context),
        signal,
      });
    },
    [currentUserId, groupMemberCache],
  );

  // A new group: the sheet closes and the list re-reads at once; its members
  // are told once the new chat's id is known from that re-read.
  const onGroupCreated = useCallback(
    (groupId: string, memberUserIds: string[]) => {
      setNewChatOpen(false);
      withRosterSignal(
        () => {},
        async () => {
          const signal = signalAbortRef.current.signal;
          const next = await reloadRoster();
          if (signal.aborted) return;
          const channel = next?.find((c) => c.groupId === groupId);
          if (channel === undefined) return;
          await signalRoster(channel, { kind: 'created', memberUserIds });
        },
        (context) => logger.warn('chat: roster signal failed', context),
      )();
    },
    [reloadRoster, signalRoster],
  );

  // A group edit only refreshes data: the open chat's row follows the re-read
  // (the roster effect below); a re-read never opens a chat the user has left.
  const onGroupChanged = useCallback(() => {
    void refreshChannels(null);
  }, [refreshChannels]);

  const onGroupLeft = useCallback(() => {
    // A chat left is forgotten now, so the page this thread leaves is never kept.
    forgetRememberedThread(
      chatKey(currentUserIdRef.current, workspaceIdRef.current, selectedRef.current?.channelId),
    );
    setGroupInfoOpen(false);
    closeChannel();
    void refreshChannels(null);
  }, [refreshChannels, closeChannel]);

  // Delete chats for me: one trace for the action, one proc call per chat in
  // order, stopping at the first failure. Each accepted clear empties the card
  // and drops its unrecorded sends at once; an open thread goes back to the list.
  const onDeleteChats = useCallback(
    async (list: ChannelSummary[]): Promise<ClearRunResult<ChannelSummary>> => {
      const traceId = generateTraceId();
      const result = await runClearChannels({
        channels: list,
        clear: (channelId) => clearChannelRecord({ client: supabase, channelId, traceId }),
        onCleared: (channel) => {
          clearConversation(channel.channelId, Date.now());
          if (selectedRef.current?.channelId === channel.channelId) closeChannel();
        },
      });
      if (!result.ok) {
        logger.warn('chat: delete chat failed', {
          trace_id: traceId,
          channel_id: result.failed.channelId,
          error: result.message,
        });
      }
      return result;
    },
    [clearConversation, closeChannel],
  );

  // Keep the live store's active conversation in step with the open channel:
  // opening one zeroes its badge locally (the thread records the read cursor);
  // leaving or unmounting clears it.
  const selectedChannelId = selected?.channelId ?? null;
  // The chat list's unread count as this chat opened (before it is zeroed),
  // for the reading layer's jump pill when the run starts above loaded history.
  const [unreadAtOpen, setUnreadAtOpen] = useState<{ channelId: string | null; unread: number }>(
    () => ({
      channelId: selectedChannelId,
      unread:
        selectedChannelId !== null ? (chatStore.conversations[selectedChannelId]?.unread ?? 0) : 0,
    }),
  );
  if (unreadAtOpen.channelId !== selectedChannelId) {
    setUnreadAtOpen({
      channelId: selectedChannelId,
      unread:
        selectedChannelId !== null ? (chatStore.conversations[selectedChannelId]?.unread ?? 0) : 0,
    });
  }
  // A pending Activity jump belongs to one chat: switching away or closing
  // before it ran drops it, so reopening that chat later never jumps.
  // A close in flight belongs to the chat it closes: any open or close ends it.
  useEffect(() => {
    closingRef.current = null;
  }, [selectedChannelId]);
  const jumpChannelRef = useRef(selectedChannelId);
  useEffect(() => {
    if (jumpChannelRef.current === selectedChannelId) return;
    jumpChannelRef.current = selectedChannelId;
    setPendingJump((prev) => pendingJumpAfter(prev, selectedChannelId));
  }, [selectedChannelId]);
  useEffect(() => {
    if (selectedChannelId === null) {
      setActive(null);
      return;
    }
    setActive(selectedChannelId);
    markConversationRead(selectedChannelId);
    return () => setActive(null);
  }, [selectedChannelId, setActive, markConversationRead]);

  // A toast press asks the store to open a channel; consume it once the roster
  // is ready by selecting that channel, then clear the request. The press
  // already pushed /chat: the chat takes that entry (one step, not two).
  const pendingOpen = chatStore.pendingOpenConversationId;
  useEffect(() => {
    if (pendingOpen === null || loadStatus !== 'ready') return;
    const found = chatRoster.find((channel) => channel.channelId === pendingOpen);
    if (found !== undefined) openChannel(found, channelWriteFor('pendingOpen'));
    clearPendingOpen();
  }, [pendingOpen, loadStatus, chatRoster, clearPendingOpen, openChannel]);

  // Pre-warm: once the list is ready and the tab visible, at idle (after the
  // list painted), the top chats' open reads run and are kept as the pages
  // an open leaves behind, so the first tap paints with no skeleton. Once
  // per list load (this mount and scope); no await, hold or gate on any
  // paint path; skipped under Save-Data. A switch or leave drops what lands.
  const prewarmInputRef = useRef({ roster, chatStore });
  prewarmInputRef.current = { roster, chatStore };
  const prewarmedRef = useRef<string | null>(null);
  useEffect(() => {
    const scopeId = `${currentUserId}:${workspaceId}`;
    if (prewarmedRef.current === scopeId) return;
    let live = true;
    const cancel = schedulePrewarm({
      ready: loadStatus === 'ready',
      visible: () => document.visibilityState === 'visible',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      idle: (task) => whenIdle(task),
      run: () => {
        if (!live) return;
        prewarmedRef.current = scopeId;
        const { roster: listed, chatStore: listState } = prewarmInputRef.current;
        const keys = visibleChannels(
          listed,
          (id) => listState.conversations[id],
          (id) => selectHidden(listState, id),
          '',
        ).flatMap((channel) => {
          const key = chatKey(currentUserId, workspaceId, channel.channelId);
          return key !== null ? [key] : [];
        });
        void prewarmChats(keys, {
          read: (key) =>
            withReadTimeout((signal) =>
              readChatOpenBundle(
                supabase,
                {
                  traceId: generateTraceId(),
                  workspaceId: key.workspaceId,
                  channelId: key.channelId,
                  since: null,
                },
                signal,
              ),
            ),
          saveData: saveDataOn,
          current: () => live,
        }).then(() => {
          if (!live || saveDataOn()) return;
          // The plan cards on the top chats' kept pages: their shapes (never
          // their data) from one batched read, so a kept open's cards are
          // sized in its first frame (plan-shapes.ts).
          const top = keys.slice(0, PREWARM_LIMIT);
          const kept = top.flatMap((key) => openCache.recall(key, 'thread')?.rows ?? []);
          const planIds = [...new Set(kept.flatMap((m) => m.sharedPlanIds ?? []))].filter(
            (id) => !planCardsSized(currentUserId, workspaceId, [id]),
          );
          if (planIds.length === 0) return;
          void withReadTimeout((signal) =>
            readPlanBundles(supabase, planIds, signal, undefined, workspaceId),
          ).then((result) => {
            mark('chat:prewarm:shapes');
            if (live && result.ok) notePlanShapes(currentUserId, workspaceId, planIds, result.data);
          });
        });
        // The members the first tap's names answer from (the same one shared
        // load the tap would start), so a pre-warmed chat's first frame has
        // its names too. Joined while fresh; skipped under Save-Data.
        if (!saveDataOn() && peekWorkspaceMembers(currentUserId, workspaceId) === null) {
          void startChatMembers(supabase, currentUserId, workspaceId);
        }
      },
    });
    return () => {
      live = false;
      cancel();
    };
  }, [loadStatus, workspaceId, currentUserId]);

  // Keyed on the channel the send was recorded in, which may no longer be open.
  const onOwnMessage = useCallback(
    (channelId: string, text: string, ts: number, messageId?: string) =>
      updateOwnMessage(channelId, text, ts, messageId),
    [updateOwnMessage],
  );

  // The open chat's row follows every roster re-read: a rename, photo or sync
  // updates it in place (same object when nothing changed), and a chat that is
  // gone after a re-read applied for THIS workspace (removed from the group)
  // closes to chat home before the next paint. A re-read from a previous
  // workspace never closes a chat.
  const rosterVersion = rosterReload.version;
  const seenRosterVersion = useRef(rosterVersion);
  const scope = loadScope(workspaceId, currentUserId);
  useLayoutEffect(() => {
    const reloaded = reloadedFor(seenRosterVersion.current, rosterReload, scope);
    seenRosterVersion.current = rosterReload.version;
    if (loadStatus !== 'ready') return;
    const step = openChannelAfterRoster(selectedRef.current, chatRoster, reloaded);
    if (step.kind === 'update') setSelected(step.channel);
    else if (step.kind === 'close') {
      // Removed or gone: forgotten before the thread leaves, so it keeps nothing.
      forgetRememberedThread(
        chatKey(currentUserIdRef.current, workspaceIdRef.current, selectedRef.current?.channelId),
      );
      setGroupInfoOpen(false);
      closeChannel();
    }
  }, [chatRoster, rosterReload, scope, loadStatus, closeChannel]);

  // A group's member ids, so its typing row only names members and an unsynced
  // group's live traffic reaches each of them. Tagged with the group they
  // belong to; another group's set never applies. Re-read on every roster
  // re-read (a member added or removed elsewhere).
  const selectedGroupId = selected?.channelType === 'group' ? (selected.groupId ?? null) : null;
  // What the open chat shows (header, group info, target): its row in the
  // roster the list renders from, so a rename or photo lands in the header and
  // the tile in the same commit.
  const shown = useMemo(() => shownChannel(selected, chatRoster), [selected, chatRoster]);
  // The open chat is Personal notes: no Agora at all (no client handed to the
  // thread, marks or typing), no schedule, marks, @ picker or reading layer.
  const notesOpen = isNotes(selected);
  const notesReady = notesOpen && notes.status === 'ready';
  // Opening notes after its ensure failed tries again (the open waits 5s).
  const notesRetry = notes.retry;
  const notesFailed = notesOpen && notes.status === 'failed';
  const retriedOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!notesOpen) {
      retriedOpenRef.current = null;
      return;
    }
    if (!notesFailed || retriedOpenRef.current === selectedChannelId) return;
    retriedOpenRef.current = selectedChannelId;
    notesRetry();
  }, [notesOpen, notesFailed, notesRetry, selectedChannelId]);
  const liveClient = liveClientFor(selected, client);
  const [groupMembers, setGroupMembers] = useState<{
    groupId: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    if (selectedGroupId === null) return;
    let cancelled = false;
    // Shared with the mention picker's read of the same group (one request).
    void readGroupMemberIdsShared(supabase, { groupId: selectedGroupId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        logger.warn('chat: group member read failed', { error: result.error.message });
        return;
      }
      groupMemberCache.set(selectedGroupId, result.data);
      setGroupMembers({ groupId: selectedGroupId, ids: new Set(result.data) });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedGroupId, rosterVersion, groupMemberCache]);
  const openMemberIds =
    groupMembers !== null && groupMembers.groupId === selectedGroupId ? groupMembers.ids : null;

  // The same target object while it routes the same way, so a rename or photo
  // change never re-subscribes the thread, typing or marks.
  const computedTarget = useMemo(
    () => safeTarget(shown, openMemberIds === null ? null : [...openMemberIds], currentUserId),
    [shown, openMemberIds, currentUserId],
  );
  const targetRef = useRef(computedTarget);
  if (!sameTarget(targetRef.current, computedTarget)) targetRef.current = computedTarget;
  const target = targetRef.current;
  const marks = useChatMarks({
    client: liveClient,
    channelId: notesOpen ? null : selectedChannelId,
    target,
    currentUserId,
    workspaceId,
  });
  const refetchMarks = marks.refetch;
  // Stars: one store per workspace (nothing carries across), the open chat's
  // starred ids read with its first page (the thread waits for both), again
  // on focus, the tab turning visible and every catch-up.
  const starStore = useMemo(() => createStarStore({ workspaceId }), [workspaceId]);
  const stars = useChannelStars({ store: starStore, channelId: selectedChannelId });
  const refetchStars = stars.refetch;
  // A chat whose messages page is remembered reopens without waiting on reads
  // whose last answer is already on screen: its scheduled rows (remembered),
  // re-read in place. Stars never hold the rows: the store's remembered stars
  // paint in the first frame, the rest when the stars read settles.
  const rememberedOpen = useMemo(() => {
    const key = chatKey(currentUserId, workspaceId, selectedChannelId);
    return key !== null && openCache.recall(key, 'thread') !== undefined;
  }, [currentUserId, workspaceId, selectedChannelId]);
  // A remembered chat's marks as last settled, for its first frame, only while
  // fresh (the marks hook sets the same ones in its effect, then revalidates;
  // older ones are never painted).
  const marksLoaded = marks.loaded;
  const rememberedMarks = useMemo(() => {
    if (!rememberedOpen || marksLoaded) return undefined;
    const key = chatKey(currentUserId, workspaceId, selectedChannelId);
    return key !== null ? openCache.recallFresh(key, 'marks') : undefined;
  }, [rememberedOpen, marksLoaded, currentUserId, workspaceId, selectedChannelId]);
  // Every catch-up refreshes the unread counts and re-reads the channel's marks and stars.
  const onCaughtUp = useCallback(() => {
    refreshUnreadCounts();
    refetchMarks();
    refetchStars();
  }, [refreshUnreadCounts, refetchMarks, refetchStars]);
  const onMessagesDeleted = useCallback(() => refreshPreviews(), [refreshPreviews]);
  const thread = useChatThread({
    client: liveClient,
    status,
    // Notes load once its row is ensured (at most 5s); then Postgres only,
    // caught up on open, window focus and tab visible.
    channelId: notesOpen && !notesReady ? null : selectedChannelId,
    catchUpOnFocus: notesOpen,
    target,
    currentUserId,
    // Keys the chat's remembered page (this user, this workspace, this chat).
    workspaceId,
    peerUserId: selected?.peerUserId ?? null,
    channelType: selected?.channelType ?? null,
    onOwnMessage,
    onCaughtUp,
    onMessagesDeleted,
    onMessageEdited: updateEditedMessage,
    outbox,
    resolveTarget: (channel) => resolveLiveTarget(channel, currentUserId, groupMemberCache),
  });
  // The thread hook resets its messages in an effect after a switch, so the
  // first render for a new channel still holds the previous chat's rows. Until
  // that reset has committed, the thread gets the loading skeleton instead:
  // never a frame of the old chat. Declared after useChatThread so both land
  // in the same re-render.
  const [threadChannelId, setThreadChannelId] = useState(selectedChannelId);
  useEffect(() => setThreadChannelId(selectedChannelId), [selectedChannelId]);
  // The hook switches its rows while rendering (a remembered page is the first
  // frame), so its own channel says the rows are this chat's at once.
  const threadCurrent =
    threadChannelId === selectedChannelId ||
    (selectedChannelId !== null && thread.channelId === selectedChannelId);

  const typing = useChatTyping({
    client: liveClient,
    target,
    channelId: notesOpen ? null : selectedChannelId,
    currentUserId,
  });

  const typingChannelType = selected?.channelType;
  const typingPeerUserId = selected?.peerUserId ?? null;
  const typingUserIds = useMemo(
    () =>
      visibleTypingIds({
        ids: typing.typingUserIds,
        isGroup: typingChannelType === 'group',
        peerUserId: typingPeerUserId,
        memberIds: openMemberIds,
      }),
    [typing.typingUserIds, typingChannelType, typingPeerUserId, openMemberIds],
  );
  const presence = useChatPresence({ client, peerUserId: selected?.peerUserId ?? null });

  // Resolve sender and @mention display info in one batched read per set of
  // new ids (no N+1). The first page of a chat is held until its names are in,
  // and a live row or an older page is held until the read for its names
  // settles, so no mention ever paints as "@Unknown member" and then swaps.
  const firstPageIn = !thread.loading && threadCurrent && (!notesOpen || notesReady);
  const [nameReadState, setNameReadState] = useState<{ workspaceId: string; reads: NameReads }>(
    () => ({ workspaceId, reads: NO_NAME_READS }),
  );
  const nameReads = nameReadState.workspaceId === workspaceId ? nameReadState.reads : NO_NAME_READS;
  // Reads in flight, per workspace: a switch starts a fresh set, so the new
  // workspace never waits on (or skips) ids asked for in the old one.
  const inFlight = useRef({ workspaceId, ids: new Set<string>() });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Opening a chat retries the ids whose last read failed, in place: they stay
  // failed (their rows stay painted, inert) until the read answers.
  const [retryFailedFor, setRetryFailedFor] = useState<string | null>(null);
  useEffect(() => setRetryFailedFor(selectedChannelId), [selectedChannelId]);
  // The hold (unsettled) counts messages and the DM peer only: a typing-only id
  // is read in the same batch below but never holds the first page.
  const needed = profileIdsNeeded({
    messages: thread.messages,
    peerUserId: selected?.peerUserId ?? null,
    held: profiles,
  });
  const unsettled = needed.filter((id) => !nameReads.unknown.has(id) && !nameReads.failed.has(id));
  useEffect(() => {
    const retry = retryFailedFor !== null && retryFailedFor === selectedChannelId;
    if (retry) setRetryFailedFor(null);
    if (inFlight.current.workspaceId !== workspaceId) {
      inFlight.current = { workspaceId, ids: new Set() };
    }
    const flight = inFlight.current.ids;
    const ids = idsToRead(
      profileIdsNeeded({
        messages: thread.messages,
        peerUserId: selected?.peerUserId ?? null,
        held: profiles,
        typingUserIds,
      }),
      nameReads,
      flight,
      retry,
    );
    if (ids.length === 0) return;
    for (const id of ids) flight.add(id);
    // A hang is a failed read after 5s (and a rejection is one at once), so a
    // held row, the first page and the initial jump always go on. Membership
    // comes in the same pass: a readable profile is not proof of membership.
    // Each of the two reads has its own 5s budget (in parallel): a failed or
    // hung membership read still stores the profiles, with membership unknown.
    const forWorkspace = workspaceId;
    // Answered from the shared workspace members cache when it is warm.
    mark('chat:names:start');
    void readMentionProfilesShared(supabase, {
      userId: currentUserId,
      workspaceId: forWorkspace,
      userIds: ids,
      timeoutMs: READ_TIMEOUT_MS,
    }).then((result) => {
      mark('chat:names:end');
      for (const id of ids) flight.delete(id);
      // An answer for a workspace no longer open is dropped.
      if (!mounted.current || workspaceIdRef.current !== forWorkspace) return;
      if (!result.ok) {
        logger.warn('chat: profile read failed', { error: result.error.message });
      } else {
        // With membership known, an asked id the read did not return is a
        // confirmed former member (the only case that reads "Former member").
        if (result.data.some((p) => p.member === null)) {
          rememberMentionProfiles(forWorkspace, result.data);
        } else {
          rememberMentionRead(forWorkspace, ids, result.data);
        }
        setProfileState((prev) => {
          const next = new Map(prev.workspaceId === forWorkspace ? prev.profiles : undefined);
          for (const profile of result.data) next.set(profile.userId, profile);
          return { workspaceId: forWorkspace, profiles: next };
        });
      }
      setNameReadState((prev) => ({
        workspaceId: forWorkspace,
        reads: applyMentionProfileRead(
          prev.workspaceId === forWorkspace ? prev.reads : NO_NAME_READS,
          ids,
          result,
        ),
      }));
    });
  }, [
    thread.messages,
    selected,
    profiles,
    typingUserIds,
    nameReads,
    retryFailedFor,
    selectedChannelId,
    workspaceId,
    currentUserId,
  ]);
  // A tap on a chat whose page is remembered: its names, when the held
  // members answer them all, land in the same commit as the selection (the
  // names read's own answer, membership included), so its first frame is the
  // rows, never the skeleton while that read runs. Else the read above runs.
  const seedOpenNames = (channel: ChannelSummary): void => {
    const key = chatKey(currentUserId, workspaceId, channel.channelId);
    const named = heldOpenNames({
      page: key !== null ? openCache.recall(key, 'thread') : undefined,
      peerUserId: channel.peerUserId,
      held: profiles,
      peek: (ids) => peekMentionProfiles(currentUserId, workspaceId, ids),
    });
    if (named === null) return;
    mark('chat:names:held');
    const forWorkspace = workspaceId;
    rememberMentionRead(forWorkspace, named.ids, named.profiles);
    setProfileState((prev) => {
      const next = new Map(prev.workspaceId === forWorkspace ? prev.profiles : undefined);
      for (const profile of named.profiles) next.set(profile.userId, profile);
      return { workspaceId: forWorkspace, profiles: next };
    });
    setNameReadState((prev) => ({
      workspaceId: forWorkspace,
      reads: applyMentionProfileRead(
        prev.workspaceId === forWorkspace ? prev.reads : NO_NAME_READS,
        named.ids,
        { ok: true, data: named.profiles },
      ),
    }));
  };
  const firstPageSettled = firstPageIn && unsettled.length === 0;
  useEffect(() => {
    if (firstPageSettled) setNamesSettled(selectedChannelId);
  }, [firstPageSettled, selectedChannelId]);
  // Every row once painted stays painted (ids are unique across chats), so a
  // switch, a retry or a held row ahead never takes one off the screen.
  const painted = useRef(new Set<string>());
  const threadMessages = useMemo(() => {
    const rows = paintableMessages(
      thread.messages,
      (id) => profiles.has(id) || knownMentionName(workspaceId, id) !== undefined,
      nameReads,
      painted.current,
    );
    for (const row of rows) painted.current.add(row.id);
    return rows;
  }, [thread.messages, profiles, nameReads, workspaceId]);
  // Settled names latch in an effect; a first page whose names are all known
  // is ready in the same render (a reopen paints in its first frame).
  const namesReady = namesSettled === selectedChannelId || firstPageSettled;

  // The viewer's scheduled messages in the open chat (RLS: own rows only).
  // Read in parallel with the thread's first page; the thread keeps its
  // skeleton until this read settles too, so the strip paints in the same
  // frame as the messages and never pops in after. A failed or timed-out read
  // settles with what was known. Re-read on chat open, every schedule action
  // and the tab becoming visible.
  const [scheduled, setScheduled] = useState<{
    channelId: string | null;
    rows: ScheduledRow[];
    settled: boolean;
  }>({ channelId: null, rows: NO_SCHEDULED, settled: false });
  const scheduledSeq = useRef(0);
  const refetchScheduled = useCallback((channelId: string, open = false): void => {
    scheduledSeq.current += 1;
    const seq = scheduledSeq.current;
    const key = chatKey(currentUserIdRef.current, workspaceIdRef.current, channelId);
    // An open's read is the open's chat bundle's part (no read of its own);
    // every later one (a schedule action, the tab returning) reads.
    const joined = open && key !== null ? openCache.join(key, 'scheduled') : null;
    void (
      joined ?? withReadTimeout((signal) => readScheduledMessages(supabase, { channelId, signal }))
    ).then((result) => {
      if (!mountedRef.current || seq !== scheduledSeq.current) return;
      // Remembered only for the user and workspace still open (a late answer
      // never re-scopes the memory).
      const current = chatKey(currentUserIdRef.current, workspaceIdRef.current, channelId);
      if (key !== null && current !== null && result.ok && current.userId === key.userId) {
        if (current.workspaceId === key.workspaceId) {
          openCache.remember(key, 'scheduled', result.data);
        }
      }
      if (!result.ok) {
        logger.warn('chat: scheduled read failed', {
          channel_id: channelId,
          error: result.error.message,
        });
      }
      mark('chat:scheduled:end');
      setScheduled((prev) => ({
        channelId,
        rows: result.ok ? result.data : prev.channelId === channelId ? prev.rows : NO_SCHEDULED,
        settled: true,
      }));
    });
  }, []);
  useEffect(() => {
    if (selectedChannelId !== null && !notesOpen) refetchScheduled(selectedChannelId, true);
  }, [selectedChannelId, refetchScheduled, notesOpen]);
  useEffect(() => {
    if (selectedChannelId === null || notesOpen) return;
    const channelId = selectedChannelId;
    function onVisible(): void {
      if (document.visibilityState === 'visible') refetchScheduled(channelId);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [selectedChannelId, refetchScheduled, notesOpen]);
  // The open's bundle failed (the thread showed Retry) and a later one landed:
  // the parts that failed with it (marks, scheduled rows) are read again.
  const threadFailedRef = useRef<{ channelId: string | null; failed: boolean }>({
    channelId: null,
    failed: false,
  });
  const threadLoadFailed = thread.loadFailed;
  useEffect(() => {
    const prev = threadFailedRef.current;
    threadFailedRef.current = { channelId: selectedChannelId, failed: threadLoadFailed };
    if (selectedChannelId === null || notesOpen) return;
    if (prev.channelId !== selectedChannelId || !prev.failed || threadLoadFailed) return;
    refetchMarks();
    refetchScheduled(selectedChannelId);
  }, [threadLoadFailed, selectedChannelId, notesOpen, refetchMarks, refetchScheduled]);
  // A remembered chat's scheduled rows as last read, for its first frame
  // (until this open's own state for it is set), only while fresh: older rows
  // are never painted, the open waits for its read as a cold open does.
  const rememberedScheduled = useMemo(() => {
    if (!rememberedOpen) return undefined;
    const key = chatKey(currentUserId, workspaceId, selectedChannelId);
    return key !== null ? openCache.recallFresh(key, 'scheduled') : undefined;
  }, [rememberedOpen, currentUserId, workspaceId, selectedChannelId]);
  const scheduledOwn = scheduled.settled && scheduled.channelId === selectedChannelId;
  // Notes never schedule: nothing to read, nothing to wait for.
  const scheduledSettled = notesOpen || scheduledOwn || rememberedScheduled !== undefined;
  const scheduledRows =
    scheduledSettled && !notesOpen
      ? scheduledOwn
        ? scheduled.rows
        : (rememberedScheduled ?? NO_SCHEDULED)
      : NO_SCHEDULED;
  // Notes: the saved copies' "Saved from" lines of the first page paint with
  // it. One batched source read per loaded page (and one batched name read
  // for their senders), never one per row.
  const savedKey = notesOpen ? `${workspaceId}:${selectedChannelId ?? ''}` : '';
  const [savedState, setSavedState] = useState<SavedState>(NO_SAVED);
  const saved = savedState.key === savedKey ? savedState : NO_SAVED;
  const savedAsked = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  // Each open asks again for the sources whose last read failed.
  useEffect(() => {
    savedAsked.current = { key: '', ids: new Set() };
    setSavedState((prev) => (prev.failed.size === 0 ? prev : { ...prev, failed: new Set() }));
  }, [selectedChannelId]);
  useEffect(() => {
    if (!notesOpen || savedKey === '') return;
    if (savedAsked.current.key !== savedKey) savedAsked.current = { key: savedKey, ids: new Set() };
    const asked = savedAsked.current.ids;
    const known = new Set([...asked, ...saved.sources.keys()]);
    const ids = savedSourceIds(thread.messages, known);
    if (ids.length === 0) return;
    for (const id of ids) asked.add(id);
    const forKey = savedKey;
    const forWorkspace = workspaceId;
    void readSavedSources(supabase, {
      ids,
      knownName: (id) => profilesRef.current.has(id),
    }).then((result) => {
      if (!mountedRef.current || savedAsked.current.key !== forKey) return;
      if (!result.ok) {
        logger.warn('chat: saved sources read failed', { error: result.error.message });
      } else if (result.data.profiles.length > 0) {
        const read = result.data.profiles;
        setProfileState((prev) => {
          const next = new Map(prev.workspaceId === forWorkspace ? prev.profiles : undefined);
          for (const profile of read)
            if (!next.has(profile.userId)) next.set(profile.userId, profile);
          return { workspaceId: forWorkspace, profiles: next };
        });
      }
      setSavedState((prev) => {
        const base = prev.key === forKey ? prev : { ...NO_SAVED, key: forKey };
        if (!result.ok) {
          const failed = new Set(base.failed);
          for (const id of ids) failed.add(id);
          return { ...base, failed };
        }
        const byId = new Map(result.data.sources.map((source) => [source.id, source] as const));
        const sources = new Map(base.sources);
        for (const id of ids) sources.set(id, byId.get(id) ?? null);
        return { ...base, sources };
      });
    });
  }, [notesOpen, savedKey, thread.messages, saved.sources, workspaceId]);
  const savedPending = notesOpen
    ? savedSourceIds(thread.messages, new Set([...saved.sources.keys(), ...saved.failed])).length >
      0
    : false;
  const firstSavedSettled = notesOpen && firstPageIn && !savedPending;
  const [savedSettledFor, setSavedSettledFor] = useState<string | null>(null);
  useEffect(() => {
    if (firstSavedSettled) setSavedSettledFor(selectedChannelId);
  }, [firstSavedSettled, selectedChannelId]);
  const savedReady = !notesOpen || savedSettledFor === selectedChannelId;
  // Notes whose ensure failed: never the skeleton, the Retry state shows.
  const threadLoading = chatThreadLoading({
    threadCurrent,
    notesFailed,
    pageLoading: thread.loading,
    namesReady,
    scheduledSettled,
    notesOpen,
    notesStatusReady: notes.status === 'ready',
    notesReady,
    savedReady,
  });
  // A message turned tombstone (deleted here or by its sender) loses its star.
  useEffect(() => {
    const gone = thread.messages.filter((m) => m.deleted === true).map((m) => m.id);
    if (gone.length > 0) starStore.drop(gone);
  }, [thread.messages, starStore]);
  const [scheduledListOpen, setScheduledListOpen] = useState(false);
  // The chat's own sheets are history steps too: back closes only the sheet.
  useHistoryStep(scheduledListOpen && selected !== null, HISTORY_STEP_KEYS.scheduledList, () =>
    setScheduledListOpen(false),
  );
  useHistoryStep(groupInfoOpen && selected !== null, HISTORY_STEP_KEYS.groupInfo, () =>
    setGroupInfoOpen(false),
  );
  useHistoryStep(newChatOpen, HISTORY_STEP_KEYS.newChat, () => setNewChatOpen(false));
  useEffect(() => setScheduledListOpen(false), [selectedChannelId]);
  // Plans: the New plan screen and the Plan screen (the Item screen is the
  // Plan screen's own step). Each open layer is one history step; a chat
  // switch closes both.
  const [planComposeOpen, setPlanComposeOpen] = useState(false);
  // "Share a plan" (the Plan tile), with the plans this chat already holds.
  const [planPicker, setPlanPicker] = useState<{ inChat: readonly string[] } | null>(null);
  const [openPlan, setOpenPlan] = useState<OpenPlanRequest | null>(null);
  // The item the Plan screen opens at (the status drawer's item rows); null: the plan.
  const [openPlanItem, setOpenPlanItem] = useState<string | null>(null);
  const [planShown, setPlanShown] = useState(false);
  useHistoryStep(planComposeOpen && selected !== null, HISTORY_STEP_KEYS.planCompose, () =>
    setPlanComposeOpen(false),
  );
  useHistoryStep(planShown && selected !== null, HISTORY_STEP_KEYS.plan, () => setPlanShown(false));
  useEffect(() => {
    setPlanComposeOpen(false);
    setPlanPicker(null);
    setPlanShown(false);
  }, [selectedChannelId]);
  // "Plan shared" shows above the composer (never over a plan page header).
  // A monotonic count tagged with its chat: another chat reads 0 (hidden).
  const [planShares, setPlanShares] = useState<{ channelId: string | null; count: number }>({
    channelId: null,
    count: 0,
  });
  const onOpenPlan = useCallback((request: OpenPlanRequest) => {
    setOpenPlan(request);
    setOpenPlanItem(null);
    setPlanShown(true);
  }, []);
  const onOpenPlanItem = useCallback((request: OpenPlanRequest & { itemId: string }) => {
    setOpenPlan({ planId: request.planId, senderName: request.senderName });
    setOpenPlanItem(request.itemId);
    setPlanShown(true);
  }, []);
  // "Go to card" on the Plan screen: the thread scrolls to that plan's latest
  // loaded card and highlights it (seq repeats a same-card tap).
  const [cardJump, setCardJump] = useState<{
    channelId: string;
    messageId: string;
    seq: number;
  } | null>(null);
  // A chat switch drops it, so returning to that chat never jumps again.
  useEffect(() => setCardJump(null), [selectedChannelId]);
  // The last one sent or cancelled: nothing left to show.
  useEffect(() => {
    if (scheduledSettled && scheduledRows.length === 0) setScheduledListOpen(false);
  }, [scheduledSettled, scheduledRows.length]);
  const selectedChannelType = selected?.channelType ?? undefined;

  /** A schedule write's failure: logged, refetched, and mapped (null: silent). */
  const scheduleFailure = useCallback(
    (channelId: string, traceId: string, what: string, message: string): string | null => {
      logger.warn(`chat: ${what} failed`, {
        trace_id: traceId,
        channel_id: channelId,
        error: message,
      });
      return mapScheduleError(message);
    },
    [],
  );
  const runScheduledWrite = useCallback(
    async <T,>(
      channelId: string,
      what: string,
      write: (traceId: string) => Promise<ScheduleWriteResult<T>>,
    ): Promise<{ ok: true; row: T; traceId: string } | { ok: false; copy: string | null }> => {
      const traceId = generateTraceId();
      const result = await write(traceId);
      refetchScheduled(channelId);
      if (result.ok) return { ok: true, row: result.row, traceId };
      return { ok: false, copy: scheduleFailure(channelId, traceId, what, result.message) };
    },
    [refetchScheduled, scheduleFailure],
  );

  const scheduleDraft = useCallback<ChatSchedule['schedule']>(
    async (draft, sendAt): Promise<ScheduleOutcome> => {
      const channelId = selectedRef.current?.channelId;
      if (channelId === undefined) return { ok: false, copy: mapScheduleError('no chat') };
      const result = await runScheduledWrite(channelId, 'schedule', (traceId) =>
        scheduleMessage({
          client: supabase,
          id: newMessageId(),
          channelId,
          sendAt,
          traceId,
          body: draft.body,
          mentions: mentionTargets(draft.body, selectedRef.current?.channelType),
          attachmentAssetIds: draft.attachmentAssetIds,
          attachmentMeta: draft.attachmentMeta,
          sharedPostIds: draft.sharedPostIds,
          sharedBriefIds: draft.sharedBriefIds,
          replyToMessageId: draft.replyToMessageId,
        }),
      );
      return result.ok ? { ok: true } : { ok: false, copy: result.copy };
    },
    [runScheduledWrite],
  );

  const showScheduleError = useCallback(
    (copy: string | null): void => {
      if (copy !== null) toast.show({ title: copy });
    },
    [toast],
  );
  const addSentRow = thread.addSentRow;
  const scheduledActions = useMemo(
    () => ({
      onSendNow: async (row: ScheduledRow): Promise<void> => {
        const result = await runScheduledWrite(row.channel_id, 'scheduled send now', (traceId) =>
          sendScheduledNow({ client: supabase, id: row.id, traceId }),
        );
        if (!result.ok) {
          showScheduleError(result.copy);
          return;
        }
        await addSentRow(result.row, result.traceId);
      },
      onSaveBody: async (row: ScheduledRow, body: string): Promise<boolean> => {
        const result = await runScheduledWrite(row.channel_id, 'scheduled edit', (traceId) =>
          updateScheduledMessage({
            client: supabase,
            id: row.id,
            sendAt: new Date(row.send_at),
            body,
            mentions: mentionTargets(body, selectedChannelType),
            traceId,
          }),
        );
        if (!result.ok) showScheduleError(result.copy);
        return result.ok;
      },
      onRetime: async (row: ScheduledRow, sendAt: Date): Promise<boolean> => {
        const result = await runScheduledWrite(row.channel_id, 'scheduled retime', (traceId) =>
          updateScheduledMessage({
            client: supabase,
            id: row.id,
            sendAt,
            body: row.body ?? '',
            mentions: rowMentions(row),
            traceId,
          }),
        );
        if (!result.ok) showScheduleError(result.copy);
        return result.ok;
      },
      onCancel: async (row: ScheduledRow): Promise<boolean> => {
        const result = await runScheduledWrite(row.channel_id, 'scheduled cancel', (traceId) =>
          cancelScheduledMessage({
            client: supabase,
            id: row.id,
            channelId: row.channel_id,
            traceId,
          }),
        );
        if (!result.ok) showScheduleError(result.copy);
        return result.ok;
      },
    }),
    [runScheduledWrite, showScheduleError, addSentRow, selectedChannelType],
  );
  // Every shared post and brief across the loaded messages: the thread's cards
  // read them in one batch per kind and share the results.
  const cardIds = useMemo(() => threadCardIds(threadMessages), [threadMessages]);

  // The @ picker's people: the group's members, or the DM's other person.
  // A failed or timed-out member read settles as failed: the composer's hold
  // releases, and only a successful read may drop a stored mention.
  const membersLoad = useChannelMembersState({
    workspaceId,
    currentUserId,
    groupId: selectedGroupId,
    peerUserId: selected?.channelType === 'dm' ? (selected.peerUserId ?? null) : null,
  });
  const mentionMembers = membersLoad === null ? null : membersLoad.ok ? membersLoad.members : [];
  // A client among the chat's other active members (null while the list is
  // loading or failed): the composer's Draft tile and hash picker gate on it.
  const hasClient = channelHasClient(
    membersLoad !== null && membersLoad.ok ? membersLoad.members : null,
  );

  // Tapping a mentioned name opens my DM with them (created on first use).
  const onOpenMention = useCallback(
    (userId: string) =>
      void openMentionDm(userId, {
        workspaceId,
        start: (params, onOpen) => startDmChannel(supabase, params, onOpen),
        onOpen: onDmReady,
        onFailed: (traceId, message) => {
          logger.warn('chat: mention dm open failed', { trace_id: traceId, error: message });
          toast.show({ title: MENTION_DM_FAILED });
        },
      }),
    [workspaceId, onDmReady, toast],
  );

  // The header arrow: back to where the chat was opened from (a cold open: the list).
  const onBack = useCallback((): void => {
    if (chatBackAction(window.history.state) === 'pop') navigate(-1);
    else closeChannel();
  }, [navigate, closeChannel]);
  // A hit's jump belongs to its chat: any route that leaves or switches the
  // chat (browser back, a toast, a deep link) drops it before it can fire later.
  const selectedChannelForSearch = selected?.channelId ?? null;
  useEffect(() => {
    setSearchRequest((prev) =>
      prev !== null && prev.channelId !== selectedChannelForSearch ? null : prev,
    );
  }, [selectedChannelForSearch]);

  const chatName = selected !== null ? chatDisplayName(shown ?? selected) : '';
  const readsLoading = thread.readState.status === 'loading';
  const scheduleWiring = useMemo<ChatSchedule | null>(
    () =>
      selectedChannelId === null || notesOpen
        ? null
        : {
            channelId: selectedChannelId,
            chatName,
            rows: scheduledRows,
            // The strip paints with the thread's first page, never after it.
            stripVisible: !threadLoading && !readsLoading,
            schedule: scheduleDraft,
            openList: () => setScheduledListOpen(true),
            refetch: () => refetchScheduled(selectedChannelId),
          },
    [
      selectedChannelId,
      notesOpen,
      chatName,
      scheduledRows,
      threadLoading,
      readsLoading,
      scheduleDraft,
      refetchScheduled,
    ],
  );
  const scheduleNameOf = useMemo(
    () => profileNameOf(profiles, workspaceId),
    [profiles, workspaceId],
  );

  // Save to notes: through the store's outbox (the same retries as any send,
  // never a visible failure), after this session's ensure (a failed one still
  // queues it: the outbox keeps trying). The toast opens notes.
  const outboxEnqueue = outbox.enqueue;
  const ensureNotes = notes.ensured;
  const saveToNotes = useCallback(
    (message: ThreadMessage) => {
      const entry = saveToNotesEntry(message, newMessageId());
      const target = notesChat;
      const forWorkspace = workspaceId;
      // A workspace switch before the ensure answers drops it: the outbox is
      // the new workspace's by then.
      void ensureNotes().then(() => {
        if (workspaceIdRef.current === forWorkspace) outboxEnqueue(target.channelId, entry);
      });
      toast.show({
        title: SAVED_TO_NOTES_TOAST,
        onPress: () => leaveSelectionThen(() => openChannel(target)),
      });
    },
    [notesChat, ensureNotes, outboxEnqueue, toast, openChannel, workspaceId],
  );
  // A forward that includes notes waits on its ensure first.
  const threadForward = thread.forward;
  const forwardWithNotes = useCallback(
    async (
      messages: readonly ThreadMessage[],
      targets: ChannelSummary[],
    ): Promise<ForwardSendResult> => {
      if (targets.some((t) => isNotes(t))) await ensureNotes();
      return threadForward(messages, targets);
    },
    [ensureNotes, threadForward],
  );
  const rosterById = useMemo(
    () => new Map(chatRoster.map((c) => [c.channelId, c] as const)),
    [chatRoster],
  );
  // The saved line's tap: the existing ?channel=&message= deep link.
  const openSavedSource = useCallback<SavedFromWiring['onOpen']>(
    (line) => {
      // An open: one step, back returns to notes.
      leaveSelectionThen(() => {
        channelParamRef.current = line.channelId;
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('channel', line.channelId);
          next.set('message', line.messageId);
          return next;
        });
      });
    },
    [setSearchParams],
  );
  const savedWiring = useMemo<SavedFromWiring | null>(
    () =>
      notesOpen
        ? {
            lineFor: (message) => {
              const id = message.forwardedFromId;
              if (id === undefined) return null;
              return savedFromLine({
                source: saved.sources.has(id) ? (saved.sources.get(id) ?? null) : undefined,
                channelsById: rosterById,
                nameOf: (userId) => profiles.get(userId)?.displayName,
                currentUserId,
              });
            },
            onOpen: openSavedSource,
          }
        : null,
    [notesOpen, saved.sources, rosterById, profiles, currentUserId, openSavedSource],
  );

  const opening = openingChannelId({
    selectedChannelId: selected?.channelId ?? null,
    channelParam,
    pendingOpen,
    loadStatus,
  });
  const showList = isDesktop || (selected === null && opening === null);
  const showThread = isDesktop || selected !== null || opening !== null;
  // Back out of a chat still opening: drop the link and any pending open.
  const onBackFromOpening = (): void => {
    clearPendingOpen();
    onBack();
  };

  const isGroup = selected?.channelType === 'group';
  const planPanelOpen =
    isDesktop &&
    selected !== null &&
    ((openPlan !== null && planShown) || (planComposeOpen && !notesOpen));
  const infoGroupId = isGroup ? (selected?.groupId ?? null) : null;

  const surface = (
    <div className="relative flex h-full min-h-0">
      {showList ? (
        <div className={chatListPaneClass(planPanelOpen)}>
          <ChannelList
            channels={roster}
            status={loadStatus}
            onRetry={retryLoad}
            selectedChannelId={selected?.channelId ?? null}
            onSelect={(channel: ChannelSummary) => {
              mark('chat:tap');
              // A plain open drops any hit's jump not taken yet.
              setSearchRequest(null);
              // Every read the open needs starts now, before the thread mounts.
              if (selected?.channelId !== channel.channelId && !isNotes(channel)) {
                startChatOpen(currentUserId, workspaceId, channel.channelId);
                seedOpenNames(channel);
              }
              openChannel(channel);
            }}
            onPressIn={(channel: ChannelSummary) => {
              if (selected?.channelId === channel.channelId || isNotes(channel)) return;
              pressChatOpen(currentUserId, workspaceId, channel.channelId);
            }}
            onNewChat={() => setNewChatOpen(true)}
            onDeleteChats={onDeleteChats}
            workspaceId={workspaceId}
            onOpenSearchHit={openSearchHit}
            onOpenStarred={openStarredMessage}
            notes={notesChat}
          />
        </div>
      ) : null}
      {showThread ? (
        <div
          className={cn(
            'relative h-full min-w-0 flex-1',
            // The docked plan panel (440px) takes the right; from 1180px the
            // thread narrows so it covers nothing (below, it overlays).
            planPanelOpen && 'min-[1180px]:mr-[440px]',
          )}
        >
          {opening !== null ? (
            threadOpeningSkeleton(layout, isDesktop ? undefined : onBackFromOpening)
          ) : selected !== null ? (
            <SharedCardsProvider
              workspaceId={workspaceId}
              channelId={selected.channelId}
              postIds={cardIds.postIds}
              briefIds={cardIds.briefIds}
              status={status}
            >
              <PlanCardsProvider
                workspaceId={workspaceId}
                channelId={selected.channelId}
                userId={currentUserId}
                planIds={cardIds.planIds}
                chatTitle={chatDisplayName(shown ?? selected)}
                onOpenPlan={onOpenPlan}
                onRowHere={(row, traceId) => void thread.addSentRow(row, traceId)}
                status={status}
              >
                <ChatScheduleProvider value={scheduleWiring}>
                  <SavedFromProvider value={savedWiring}>
                    <MessageThread
                      key={selected.channelId}
                      title={chatDisplayName(shown ?? selected)}
                      channelId={selected.channelId}
                      rootCreatedAt={thread.rootCreatedAt}
                      avatarUrl={(shown ?? selected).avatarUrl}
                      {...(!isGroup && !notesOpen && workspaceLabel !== undefined
                        ? { subtitle: workspaceLabel }
                        : {})}
                      {...(!isGroup && !notesOpen
                        ? { role: (shown ?? selected).role ?? null }
                        : {})}
                      notes={notesOpen}
                      {...(!notesOpen ? { onSaveToNotes: saveToNotes } : {})}
                      isGroup={isGroup}
                      profiles={profiles}
                      messages={threadCurrent ? threadMessages : NO_MESSAGES}
                      loading={threadLoading}
                      loadFailed={threadCurrent && (thread.loadFailed || notesFailed)}
                      onRetryLoad={notesFailed ? notesRetry : thread.retryLoad}
                      loadingOlder={thread.loadingOlder}
                      hasMore={thread.hasMore}
                      onLoadOlder={thread.loadOlder}
                      onNewestVisible={thread.markNewestVisible}
                      timeZone={timeZone}
                      canSend
                      onSend={thread.send}
                      onRetry={thread.retry}
                      typingUserIds={notesOpen ? NO_TYPING : typingUserIds}
                      {...(!notesOpen ? { onTyping: typing.notifyTyping } : {})}
                      onToggleReaction={thread.toggleReaction}
                      {...(notesOpen
                        ? { marksLoaded: true }
                        : {
                            marks: rememberedMarks?.marks ?? marks.marks,
                            marksLoaded: marks.loaded || rememberedMarks !== undefined,
                            marksFailed: marks.failed,
                            markedMessages: rememberedMarks?.markedMessages ?? marks.markedMessages,
                            onSetMark: marks.setMark,
                            onResolveMark: marks.resolve,
                            onReopenMark: marks.reopen,
                          })}
                      currentUserId={currentUserId}
                      onDeleteMessages={thread.deleteMessages}
                      onEditMessage={thread.editMessage}
                      forwardChannels={chatRoster}
                      onForward={forwardWithNotes}
                      onEnsureLoaded={thread.ensureLoaded}
                      {...(!notesOpen
                        ? {
                            mentionMembers,
                            mentionGone: mentionGone(membersLoad, currentUserId, workspaceId),
                          }
                        : {})}
                      mentions={{
                        peerUserId:
                          selected.channelType === 'dm' ? (selected.peerUserId ?? null) : null,
                        onOpen: onOpenMention,
                      }}
                      channelHasClient={hasClient}
                      {...(!notesOpen
                        ? {
                            onOpenPlanCompose: (inChat: readonly string[]) =>
                              setPlanPicker({ inChat }),
                          }
                        : {})}
                      onOpenPlanItem={onOpenPlanItem}
                      onNavigate={navigate}
                      locationKey={locationKey}
                      cardJump={cardJump?.channelId === selected.channelId ? cardJump : null}
                      initialMessageId={initialJumpFor(pendingJump, selected.channelId)}
                      onInitialJumpTaken={() => setPendingJump(null)}
                      initialTaskId={
                        pendingTask?.channelId === selected.channelId ? pendingTask.taskId : null
                      }
                      onInitialTaskTaken={() => setPendingTask(null)}
                      searchRequest={
                        searchRequest?.channelId === selected.channelId ? searchRequest : null
                      }
                      onSearchRequestTaken={() => setSearchRequest(null)}
                      initialSearchWords={
                        pendingWords?.channelId === selected.channelId ? pendingWords.words : null
                      }
                      onInitialSearchWordsTaken={() => setPendingWords(null)}
                      showTicks={selected.channelType === 'dm'}
                      {...(threadCurrent && !notesOpen ? { readState: thread.readState } : {})}
                      peerUserId={
                        selected.channelType === 'dm' ? (selected.peerUserId ?? null) : null
                      }
                      unreadAtOpen={
                        unreadAtOpen.channelId === selected.channelId ? unreadAtOpen.unread : 0
                      }
                      {...(selected.peerUserId != null ? { presence } : {})}
                      {...(isDesktop ? {} : { onBack })}
                      {...(isGroup ? { onOpenInfo: () => setGroupInfoOpen(true) } : {})}
                      {...(infoGroupId !== null
                        ? {
                            renderGroupInfo: (tabs: GroupInfoTabsWiring) => (
                              <GroupInfoSheet
                                open={groupInfoOpen}
                                onClose={() => setGroupInfoOpen(false)}
                                workspaceId={workspaceId}
                                workspaceName={workspaceLabel}
                                groupId={infoGroupId}
                                groupName={chatDisplayName(shown ?? selected)}
                                avatarUrl={(shown ?? selected).avatarUrl}
                                createdBy={(shown ?? selected).createdBy ?? null}
                                viewerRole={
                                  mentionMembers?.find((m) => m.userId === currentUserId)?.role ??
                                  null
                                }
                                currentUserId={currentUserId}
                                onChanged={onGroupChanged}
                                signalRoster={(change) => signalRoster(shown ?? selected, change)}
                                membersVersion={rosterVersion}
                                onLeft={onGroupLeft}
                                tabs={tabs}
                              />
                            ),
                          }
                        : {})}
                    />
                  </SavedFromProvider>
                </ChatScheduleProvider>
                <ScheduledListSheet
                  open={scheduledListOpen}
                  onClose={() => setScheduledListOpen(false)}
                  rows={scheduledRows}
                  nameOf={scheduleNameOf}
                  {...scheduledActions}
                />
                {!notesOpen ? (
                  <PlanPickerSheet
                    open={planPicker !== null}
                    workspaceId={workspaceId}
                    workspaceName={workspaceLabel ?? ''}
                    timeZone={timeZone}
                    inChatPlanIds={planPicker?.inChat ?? NO_PLAN_IDS}
                    onClose={() => setPlanPicker(null)}
                    onNewPlan={() => setPlanComposeOpen(true)}
                    onOpenPlan={(planId) => onOpenPlan({ planId, senderName: '' })}
                  />
                ) : null}
                {!notesOpen ? (
                  <PlanComposeScreen
                    open={planComposeOpen}
                    workspaceId={workspaceId}
                    timeZone={timeZone}
                    onClose={() => setPlanComposeOpen(false)}
                    onCreated={(planId, stale) => {
                      // A create from a form since closed opens nothing.
                      if (stale) return;
                      setPlanComposeOpen(false);
                      onOpenPlan({ planId, senderName: '' });
                    }}
                  />
                ) : null}
                {openPlan !== null ? (
                  <PlanScreen
                    key={`${openPlan.planId}:${openPlanItem ?? ''}`}
                    open={planShown}
                    planId={openPlan.planId}
                    {...(openPlanItem !== null ? { initialItemId: openPlanItem } : {})}
                    senderName={openPlan.senderName}
                    chatTitle={chatDisplayName(shown ?? selected)}
                    chat={{
                      channelId: selected.channelId,
                      name: chatDisplayName(shown ?? selected),
                      hasClient,
                      cardPlanIds: cardIds.planIds,
                      onSent: (row, traceId) => {
                        void thread.addSentRow(row, traceId);
                        setPlanShares((prev) => ({
                          channelId: row.channel_id,
                          count: prev.count + 1,
                        }));
                      },
                      onGoToCard: (planId) => {
                        setPlanShown(false);
                        const messageId = latestPlanCardId(threadMessages, planId);
                        if (messageId !== null) {
                          setCardJump((prev) => ({
                            channelId: selected.channelId,
                            messageId,
                            seq: (prev?.seq ?? 0) + 1,
                          }));
                        }
                      },
                    }}
                    onClose={() => setPlanShown(false)}
                  />
                ) : null}
              </PlanCardsProvider>
            </SharedCardsProvider>
          ) : (
            <div className="flex h-full flex-col justify-center bg-bg">
              <EmptyState icon={<IconChat size={ICON_SIZE.tray} />} title="Select a conversation" />
            </div>
          )}
          <PlanSharedNotice
            shareCount={
              planShares.channelId !== null && planShares.channelId === selectedChannelId
                ? planShares.count
                : 0
            }
            text={PLAN_SHARED_TOAST}
          />
        </div>
      ) : null}

      <NewChatSheet
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        onDmReady={onDmReady}
        onGroupCreated={onGroupCreated}
      />
    </div>
  );

  // The message menu's Remind me and its sheet.
  return (
    <StarStoreContext.Provider value={starStore}>
      <ReminderProvider
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        openChannelId={selected?.channelId ?? null}
        messages={threadCurrent ? threadMessages : NO_MESSAGES}
        nameOf={scheduleNameOf}
      >
        {surface}
        <ChatReminderSheet />
      </ReminderProvider>
    </StarStoreContext.Provider>
  );
}
