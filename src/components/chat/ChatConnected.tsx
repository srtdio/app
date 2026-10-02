import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useMediaQuery } from '@/lib/use-media-query';
import { useWorkspace } from '@/lib/workspace-context';
import {
  listGroupMemberIds,
  readMentionProfiles,
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
import { loadScope, type ChatLoadStatus } from '@/lib/chat/chat-store';
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
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { useChatThread } from '@/lib/chat/use-chat-thread';
import { useChatMarks } from '@/lib/chat/use-chat-marks';
import { useChatTyping } from '@/lib/chat/use-chat-typing';
import { visibleTypingIds } from '@/lib/chat/typing';
import { useChatPresence } from '@/lib/chat/use-chat-presence';
import { ROSTER_READ_BUDGET_MS, useChatStore } from '@/components/chat/ChatStoreProvider';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat } from '@/components/ui/icons';
import { ChannelList } from '@/components/chat/ChannelList';
import {
  MessageThread,
  threadCardIds,
  threadOpeningSkeleton,
} from '@/components/chat/MessageThread';
import { SharedCardsProvider } from '@/components/chat/PostCard';
import { useChatLayout } from '@/components/chat/chat-type';
import { NewChatSheet } from '@/components/chat/NewChatSheet';
import { GroupInfoSheet, type GroupInfoTabsWiring } from '@/components/chat/GroupInfoSheet';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { startDmChannel } from '@/components/chat/chat-actions';
import { mentionGone, useChannelMembersState } from '@/components/chat/use-channel-members';
import { knownMentionName, mentionIds, rememberMentionProfiles } from '@/lib/chat/mentions';
import { useToast } from '@/components/ui/toast';
import type { Result } from '@srtdio/rpc';

interface ChatConnectedProps {
  client: ChatConnection | null;
  status: ChatStatus;
  workspaceId: string;
  currentUserId: string;
}

const DESKTOP_QUERY = '(min-width: 768px)';

const NO_MESSAGES: ThreadMessage[] = [];

/** The toast when opening a DM from a mention fails; the raw error is only logged. */
export const MENTION_DM_FAILED = "Couldn't open that chat, try again";

/**
 * The user ids a thread's first paint needs names for: every sender, the DM
 * peer, and every @mention in a body or a reply quote, minus the ones already
 * held. One batched read covers them all (no per-token fetch). Pure.
 */
export function profileIdsNeeded(
  messages: readonly ThreadMessage[],
  peerUserId: string | null,
  held: ReadonlyMap<string, unknown>,
): string[] {
  const needed = new Set<string>();
  const add = (id: string | null): void => {
    if (id !== null && !held.has(id)) needed.add(id);
  };
  for (const message of messages) {
    add(message.senderUserId);
    for (const id of rowNameIds(message)) add(id);
  }
  add(peerUserId);
  return [...needed];
}

/**
 * Where the thread's profile reads left each id they asked about. `unknown`:
 * a read succeeded without it (an ex-member); it renders "@Unknown member" for
 * good and is never read again. `failed`: its last read failed; it renders
 * "@Unknown member" inert for now and rides along on the next read.
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

/** The jump the open chat takes: the pending one only while it is for this chat. Pure. */
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

export function ChatConnected(props: ChatConnectedProps): ReactElement {
  const { client, status, workspaceId, currentUserId } = props;
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const { workspaces } = useWorkspace();
  // The workspace civil clock every timestamp renders on; the browser's own zone
  // only when the workspace has none.
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const timeZone = workspaceTimeZone(workspace?.timezone);

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

  // The open thread lives in ?channel={channelId} (replace, never push), so the
  // shell hides the mobile chrome in the same render the thread opens. Opening
  // and closing set the state and the param in one batch; only 'channel' is
  // touched, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The latest workspace and ?channel=, and whether the page is still mounted,
  // for answers that land after the render that asked.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
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
    (channelId: string | null) => {
      setSearchParams(
        (prev) => {
          if ((prev.get('channel') ?? null) === channelId) return prev;
          const next = new URLSearchParams(prev);
          if (channelId === null) next.delete('channel');
          else next.set('channel', channelId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const openChannel = useCallback(
    (channel: ChannelSummary) => {
      setSelected(channel);
      writeChannelParam(channel.channelId);
    },
    [writeChannelParam],
  );
  const closeChannel = useCallback(() => {
    setSelected(null);
    writeChannelParam(null);
  }, [writeChannelParam]);

  // Email deep-link: ?channel={channelId} selects that channel once the store's
  // roster is ready, once per distinct id. The param stays while the thread is
  // open; an id not in the roster is stripped so the chrome comes back.
  const selectedFromParam = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(() => {
    if (loadStatus !== 'ready') return;
    const channel = searchParams.get('channel');
    if (channel === null || channel === '') {
      selectedFromParam.current = null;
      return;
    }
    if (selectedFromParam.current === channel) return;
    selectedFromParam.current = channel;
    const step = deepLinkStep(searchParams, roster);
    const linkParams = new URLSearchParams(searchParams);
    // ?message= is consumed once: the thread takes it, the url drops it. A link
    // to a chat not (yet) in my list keeps no earlier jump.
    setPendingJump(step.jump);
    if (searchParams.has('message')) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('message');
          return next;
        },
        { replace: true },
      );
    }
    if (selectedRef.current?.channelId === channel) return;
    if (step.open !== null) {
      setSelected(step.open);
      return;
    }
    // Not in the snapshot: re-read the list once; toast only if still absent.
    // The answer applies only on the same mounted page, workspace and link.
    const started: DeepLinkRefreshContext = { mounted: true, workspaceId, channel };
    void deepLinkAfterRefresh(linkParams, roster, reloadRoster, ROSTER_READ_BUDGET_MS).then(
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
        writeChannelParam(null);
        toastRef.current.show({ title: CHAT_UNAVAILABLE_TOAST });
      },
    );
  }, [
    loadStatus,
    roster,
    searchParams,
    setSearchParams,
    writeChannelParam,
    reloadRoster,
    workspaceId,
  ]);

  // A workspace switch forgets which link was handled: a link whose re-read
  // was discarded by the switch is resolved again in the new workspace (open
  // it, or toast and strip it), never left on the opening skeleton.
  useEffect(() => {
    selectedFromParam.current = null;
  }, [workspaceId]);

  // A ?channel= that disappears by any route other than closeChannel (browser
  // back, external navigation) closes the thread below md so the chrome returns.
  // Only the present -> absent transition counts, so an open that sets state
  // before its param lands never reads as a close. Desktop keeps its selection.
  const channelParam = searchParams.get('channel') || null;
  const prevChannelParam = useRef(channelParam);
  useEffect(() => {
    const prev = prevChannelParam.current;
    prevChannelParam.current = channelParam;
    if (prev === null || channelParam !== null || isDesktop) return;
    if (selectedRef.current !== null) setSelected(null);
  }, [channelParam, isDesktop]);

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

  const onGroupChanged = useCallback(() => {
    void refreshChannels(selected?.channelId ?? null);
  }, [refreshChannels, selected]);

  const onGroupLeft = useCallback(() => {
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
  // A pending Activity jump belongs to one chat: switching away or closing
  // before it ran drops it, so reopening that chat later never jumps.
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
  // is ready by selecting that channel, then clear the request.
  const pendingOpen = chatStore.pendingOpenConversationId;
  useEffect(() => {
    if (pendingOpen === null || loadStatus !== 'ready') return;
    const found = roster.find((channel) => channel.channelId === pendingOpen);
    if (found !== undefined) openChannel(found);
    clearPendingOpen();
  }, [pendingOpen, loadStatus, roster, clearPendingOpen, openChannel]);

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
    const step = openChannelAfterRoster(selectedRef.current, roster, reloaded);
    if (step.kind === 'update') setSelected(step.channel);
    else if (step.kind === 'close') {
      setGroupInfoOpen(false);
      closeChannel();
    }
  }, [roster, rosterReload, scope, loadStatus, closeChannel]);

  // A group's member ids, so its typing row only names members and an unsynced
  // group's live traffic reaches each of them. Tagged with the group they
  // belong to; another group's set never applies. Re-read on every roster
  // re-read (a member added or removed elsewhere).
  const selectedGroupId = selected?.channelType === 'group' ? (selected.groupId ?? null) : null;
  // What the open chat shows (header, group info, target): its row in the
  // roster the list renders from, so a rename or photo lands in the header and
  // the tile in the same commit.
  const shown = useMemo(() => shownChannel(selected, roster), [selected, roster]);
  const [groupMembers, setGroupMembers] = useState<{
    groupId: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    if (selectedGroupId === null) return;
    let cancelled = false;
    void withReadTimeout((signal) =>
      listGroupMemberIds(supabase, { groupId: selectedGroupId, signal }),
    ).then((result) => {
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
  const marks = useChatMarks({ client, channelId: selectedChannelId, target, currentUserId });
  const refetchMarks = marks.refetch;
  // Every catch-up refreshes the unread counts and re-reads the channel's marks.
  const onCaughtUp = useCallback(() => {
    refreshUnreadCounts();
    refetchMarks();
  }, [refreshUnreadCounts, refetchMarks]);
  const onMessagesDeleted = useCallback(() => refreshPreviews(), [refreshPreviews]);
  const thread = useChatThread({
    client,
    status,
    channelId: selectedChannelId,
    target,
    currentUserId,
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
  const threadCurrent = threadChannelId === selectedChannelId;

  const typing = useChatTyping({ client, target, channelId: selectedChannelId, currentUserId });

  const typingUserIds = visibleTypingIds({
    ids: typing.typingUserIds,
    isGroup: selected?.channelType === 'group',
    peerUserId: selected?.peerUserId ?? null,
    memberIds: openMemberIds,
  });
  const presence = useChatPresence({ client, peerUserId: selected?.peerUserId ?? null });

  // Resolve sender and @mention display info in one batched read per set of
  // new ids (no N+1). The first page of a chat is held until its names are in,
  // and a live row or an older page is held until the read for its names
  // settles, so no mention ever paints as "@Unknown member" and then swaps.
  const firstPageIn = !thread.loading && threadCurrent;
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
  const needed = profileIdsNeeded(thread.messages, selected?.peerUserId ?? null, profiles);
  const unsettled = needed.filter((id) => !nameReads.unknown.has(id) && !nameReads.failed.has(id));
  useEffect(() => {
    const retry = retryFailedFor !== null && retryFailedFor === selectedChannelId;
    if (retry) setRetryFailedFor(null);
    if (inFlight.current.workspaceId !== workspaceId) {
      inFlight.current = { workspaceId, ids: new Set() };
    }
    const flight = inFlight.current.ids;
    const ids = idsToRead(
      profileIdsNeeded(thread.messages, selected?.peerUserId ?? null, profiles),
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
    void readMentionProfiles(supabase, {
      workspaceId: forWorkspace,
      userIds: ids,
      timeoutMs: READ_TIMEOUT_MS,
    }).then((result) => {
      for (const id of ids) flight.delete(id);
      // An answer for a workspace no longer open is dropped.
      if (!mounted.current || workspaceIdRef.current !== forWorkspace) return;
      if (!result.ok) {
        logger.warn('chat: profile read failed', { error: result.error.message });
      } else {
        rememberMentionProfiles(forWorkspace, result.data);
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
    nameReads,
    retryFailedFor,
    selectedChannelId,
    workspaceId,
  ]);
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
  const namesReady = namesSettled === selectedChannelId;
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

  const onBack = closeChannel;

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
    closeChannel();
  };

  const isGroup = selected?.channelType === 'group';
  const infoGroupId = isGroup ? (selected?.groupId ?? null) : null;

  return (
    <div className="flex h-full min-h-0">
      {showList ? (
        <div className="h-full w-full border-border md:w-72 md:border-r">
          <ChannelList
            channels={roster}
            status={loadStatus}
            onRetry={retryLoad}
            selectedChannelId={selected?.channelId ?? null}
            onSelect={openChannel}
            onNewChat={() => setNewChatOpen(true)}
            timeZone={timeZone}
            onDeleteChats={onDeleteChats}
            workspaceId={workspaceId}
          />
        </div>
      ) : null}
      {showThread ? (
        <div className="h-full min-w-0 flex-1">
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
              <MessageThread
                key={selected.channelId}
                title={(shown ?? selected).title}
                channelId={selected.channelId}
                avatarUrl={(shown ?? selected).avatarUrl}
                {...(!isGroup && workspace !== undefined ? { subtitle: workspace.name } : {})}
                {...(!isGroup ? { role: (shown ?? selected).role ?? null } : {})}
                isGroup={isGroup}
                profiles={profiles}
                messages={threadCurrent ? threadMessages : NO_MESSAGES}
                loading={thread.loading || !threadCurrent || !namesReady}
                loadFailed={threadCurrent && thread.loadFailed}
                onRetryLoad={thread.retryLoad}
                loadingOlder={thread.loadingOlder}
                hasMore={thread.hasMore}
                onLoadOlder={thread.loadOlder}
                onNewestVisible={thread.markNewestVisible}
                timeZone={timeZone}
                canSend
                onSend={thread.send}
                onRetry={thread.retry}
                typingUserIds={typingUserIds}
                onTyping={typing.notifyTyping}
                onToggleReaction={thread.toggleReaction}
                marks={marks.marks}
                marksLoaded={marks.loaded}
                marksFailed={marks.failed}
                markedMessages={marks.markedMessages}
                onSetMark={marks.setMark}
                onResolveMark={marks.resolve}
                onReopenMark={marks.reopen}
                currentUserId={currentUserId}
                onDeleteMessages={thread.deleteMessages}
                onEditMessage={thread.editMessage}
                forwardChannels={roster}
                onForward={thread.forward}
                onEnsureLoaded={thread.ensureLoaded}
                mentionMembers={mentionMembers}
                mentionGone={mentionGone(membersLoad, currentUserId, workspaceId)}
                mentions={{
                  peerUserId: selected.channelType === 'dm' ? (selected.peerUserId ?? null) : null,
                  onOpen: onOpenMention,
                }}
                initialMessageId={initialJumpFor(pendingJump, selected.channelId)}
                onInitialJumpTaken={() => setPendingJump(null)}
                showTicks={selected.channelType === 'dm'}
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
                          workspaceName={workspace?.name}
                          groupId={infoGroupId}
                          groupName={(shown ?? selected).title}
                          avatarUrl={(shown ?? selected).avatarUrl}
                          createdBy={(shown ?? selected).createdBy ?? null}
                          viewerRole={
                            mentionMembers?.find((m) => m.userId === currentUserId)?.role ?? null
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
            </SharedCardsProvider>
          ) : (
            <div className="flex h-full flex-col justify-center bg-bg">
              <EmptyState icon={<IconChat size={22} />} title="Select a conversation" />
            </div>
          )}
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
}
