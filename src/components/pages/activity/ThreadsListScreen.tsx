// Activity's Threads list (10 Nov 2026, Slack way): the Threads button in the
// Activity top bar opens it (?threads=1). One block per thread I am in, unread
// first, then newest reply first: the chat's own name and the people in the
// thread, the root, "N more replies", the latest 2 replies, Reply. Every line
// sits on the thread view's reply text column (x60: 16 gutter + 32 photo + 12).
// Blocks are split by a 12 tall panel-3 band with hairlines (approved
// exception to the flat look). Any tap opens the thread in the chat's existing
// thread view (the route Activity rows use); opening never marks it read.
//
// Paint: the list is the held threads store (useWorkspaceThreads' copy, no
// read here); the blocks' messages come from ONE batched read for every held
// thread, started after the first paint (two waves: the replies' ids and
// senders, then the shown rows, their reactions and unknown names). A block
// keeps its footprint while it fills (the thread view's placeholder rows);
// blocks read once stay held for the app load, re-read when a thread's newest
// reply changes.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactElement } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { PressableRow } from '@/components/ui/PressableRow';
import { Text } from '@/components/ui/Text';
import { ICON_SIZE, IconActivity } from '@/components/ui/icons';
import { MessageBubble, messageTimeSource } from '@/components/chat/MessageBubble';
import { ThreadViewFill } from '@/components/chat/ThreadView';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
import {
  abortable,
  withReadTimeout,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import { chatDisplayName } from '@/lib/chat/chat-name';
import { loadMessagesByIds, loadReactions } from '@/lib/chat/history';
import { mentionIds } from '@/lib/chat/mentions';
import { mergeReactions, rowToThreadMessage, type ThreadMessage } from '@/lib/chat/thread';
import { threadDayTimes } from '@/lib/chat/thread-day-times';
import { type ThreadForMeAll } from '@/lib/chat/thread-signals';
import { peekThreads, subscribeThreads } from '@/lib/catch-up/threads';
import { personAvatar, personName, resolvePeople } from '@/lib/people-names';
import type { PresignCache } from '@/lib/asset-presign';
import { appPresignCache } from '@/lib/shared-presign';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { pushIn } from '@/lib/motion';
import { mark } from '@/lib/perf-marks';
import { supabase } from '@/lib/supabase';
import { SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';

/** The screen's title. */
export const THREADS_LIST_TITLE = 'Threads';

/** The zero state ("{Things} show up here."). */
export const THREADS_LIST_EMPTY = 'Threads show up here.';

/** A DM block's second line. */
export const DIRECT_MESSAGE_LINE = 'Direct message';

/** The newest replies a block shows under its root. */
export const BLOCK_REPLIES = 2;

/** Most reply rows (ids and senders) the first wave reads across every held thread. */
const REPLY_ROWS_CAP = 1000;

/** The 44 tap of a one-line text control, from a pseudo-element (no visible padding). */
const LINE_HIT =
  "relative min-h-0 before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-['']";

/** One block's messages: its root and its newest replies (oldest first), and who is in it. */
export interface ThreadBlockData {
  root: ThreadMessage | null;
  replies: ThreadMessage[];
  /** Root sender, then repliers in order of their first reply. */
  people: string[];
  /** The newest reply when read (a newer one re-reads the block). */
  lastReplyId: string;
}

/** Unread first, then newest reply first (the proc's order, kept stable). Pure. */
export function orderThreads(threads: readonly ThreadForMeAll[]): ThreadForMeAll[] {
  return [...threads].sort(
    (a, b) => Number(b.unread) - Number(a.unread) || b.lastReplyAt.localeCompare(a.lastReplyAt),
  );
}

/** "A", "A and B", "A, B, and C", "A, B, and N others". Pure. */
export function peopleLine(names: readonly string[]): string {
  const [a, b, c] = names;
  if (a === undefined) return '';
  if (b === undefined) return a;
  if (names.length === 2) return `${a} and ${b}`;
  if (names.length === 3 && c !== undefined) return `${a}, ${b}, and ${c}`;
  return `${a}, ${b}, and ${names.length - 2} others`;
}

/** "1 more reply" / "N more replies". Pure. */
export function moreRepliesLabel(count: number): string {
  return count === 1 ? '1 more reply' : `${count} more replies`;
}

/** The replies hidden between the root and the shown ones. Pure. */
export function hiddenReplies(replyCount: number, shown: number): number {
  return Math.max(0, replyCount - shown);
}

/**
 * A block's two header lines: the chat's own name and the people in the
 * thread; a direct message reads the other person and "Direct message".
 * Never the workspace name. Pure.
 */
export function threadHeaderLines(
  chat: Pick<ChannelSummary, 'channelType' | 'title'> | undefined,
  people: readonly string[],
): { name: string; sub: string } {
  const name = chat !== undefined ? chatDisplayName(chat) : '';
  if (chat?.channelType === 'dm') return { name, sub: DIRECT_MESSAGE_LINE };
  return { name, sub: peopleLine(people) };
}

type LightRow = {
  id: string;
  thread_root_message_id: string | null;
  sender_user_id: string | null;
  created_at: string;
};

function readReplyIds(client: Client, rootIds: readonly string[]): Promise<Result<LightRow[]>> {
  return withReadTimeout(async (signal) => {
    const res = await abortable(
      client
        .from('chat_messages')
        .select('id, thread_root_message_id, sender_user_id, created_at')
        .in('thread_root_message_id', [...rootIds])
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(REPLY_ROWS_CAP),
      signal,
    );
    if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
    return { ok: true, data: (res.data ?? []) as LightRow[] };
  });
}

/**
 * Every held thread's block in one batched read (never one per thread):
 * wave 1 the replies' ids and senders (newest first), wave 2 the roots and the
 * newest 2 replies, their reactions and any unknown names. Null on failure.
 */
export async function readThreadBlocks(
  client: Client,
  workspaceId: string,
  currentUserId: string,
  threads: readonly ThreadForMeAll[],
): Promise<Map<string, ThreadBlockData> | null> {
  const rootIds = threads.map((t) => t.rootId);
  if (rootIds.length === 0) return new Map();
  const light = await readReplyIds(client, rootIds);
  if (!light.ok) {
    logger.warn('threads list: replies read failed', { error: light.error.message });
    return null;
  }
  const byRoot = new Map<string, LightRow[]>();
  for (const row of light.data) {
    if (row.thread_root_message_id === null) continue;
    const list = byRoot.get(row.thread_root_message_id) ?? [];
    list.push(row);
    byRoot.set(row.thread_root_message_id, list);
  }
  const shownIds = rootIds.flatMap((id) =>
    (byRoot.get(id) ?? []).slice(0, BLOCK_REPLIES).map((r) => r.id),
  );
  const ids = [...rootIds, ...shownIds];
  const [rows, reactions] = await Promise.all([
    loadMessagesByIds(client, ids),
    loadReactions(client, ids, currentUserId),
  ]);
  if (!rows.ok) {
    logger.warn('threads list: messages read failed', { error: rows.error.message });
    return null;
  }
  const messages = new Map(
    mergeReactions(
      rows.data.map((row) => rowToThreadMessage(row, currentUserId)),
      reactions.ok ? reactions.data : new Map(),
    ).map((m) => [m.id, m]),
  );
  const out = new Map<string, ThreadBlockData>();
  const everyone = new Set<string>();
  for (const thread of threads) {
    const root = messages.get(thread.rootId) ?? null;
    const replyRows = byRoot.get(thread.rootId) ?? [];
    const replies = replyRows
      .slice(0, BLOCK_REPLIES)
      .reverse()
      .flatMap((r) => {
        const m = messages.get(r.id);
        return m !== undefined ? [m] : [];
      });
    const people: string[] = [];
    const add = (id: string | null): void => {
      if (id !== null && !people.includes(id)) people.push(id);
    };
    add(root?.senderUserId ?? null);
    for (let i = replyRows.length - 1; i >= 0; i -= 1) add(replyRows[i]?.sender_user_id ?? null);
    people.forEach((id) => everyone.add(id));
    for (const m of [root, ...replies]) {
      if (m !== null) mentionIds(m.body).forEach((id) => everyone.add(id));
    }
    out.set(thread.rootId, { root, replies, people, lastReplyId: thread.lastReplyId });
  }
  await resolvePeople(client, workspaceId, everyone);
  return out;
}

// Blocks read this app load, by root (a reopen paints from them at once).
const heldBlocks = new Map<string, ThreadBlockData>();

/** Test seam: forget every held block. */
export function resetThreadBlocks(): void {
  heldBlocks.clear();
}

/** The held blocks for the threads, read once after the first paint for any missing or stale. */
function useThreadBlocks(
  workspaceId: string,
  currentUserId: string,
  threads: readonly ThreadForMeAll[],
): { blocks: ReadonlyMap<string, ThreadBlockData>; failed: boolean; retry: () => void } {
  const [, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const staleKey = threads
    .filter((t) => heldBlocks.get(t.rootId)?.lastReplyId !== t.lastReplyId)
    .map((t) => `${t.rootId}:${t.lastReplyId}`)
    .join(',');
  useEffect(() => {
    if (staleKey === '') return undefined;
    const stale = threads.filter((t) => heldBlocks.get(t.rootId)?.lastReplyId !== t.lastReplyId);
    let live = true;
    setFailed(false);
    void readThreadBlocks(supabase, workspaceId, currentUserId, stale).then((read) => {
      if (!live) return;
      if (read === null) {
        setFailed(true);
        return;
      }
      mark('activity:threads-list-blocks');
      for (const [id, block] of read) heldBlocks.set(id, block);
      setVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
    // `threads` is read through staleKey (its stale part) only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleKey, workspaceId, currentUserId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { blocks: heldBlocks, failed, retry };
}

function profilesOf(workspaceId: string, ids: Iterable<string>): Map<string, ChatProfile> {
  const out = new Map<string, ChatProfile>();
  for (const id of ids) {
    out.set(id, {
      userId: id,
      displayName: personName(workspaceId, id) ?? '',
      avatarUrl: personAvatar(workspaceId, id),
    });
  }
  return out;
}

/** What a block draws with: the chat parts' shared wiring. */
interface BlockWiring {
  workspaceId: string;
  currentUserId: string;
  timeZone: string | undefined;
  layout: ChatLayout;
  cache: PresignCache;
  presignEnabled: boolean;
}

/** One thread's block. Pure render of what it is handed. */
export function ThreadBlock(props: {
  thread: ThreadForMeAll;
  chat: ChannelSummary | undefined;
  block: ThreadBlockData | undefined;
  failed: boolean;
  onRetry: () => void;
  onOpen: (thread: ThreadForMeAll) => void;
  wiring: BlockWiring;
}): ReactElement {
  const { thread, chat, block, wiring } = props;
  const open = (): void => props.onOpen(thread);
  const others = (block?.people ?? []).filter((id) => id !== wiring.currentUserId);
  const names = (others.length > 0 ? others : (block?.people ?? []))
    .map((id) => personName(wiring.workspaceId, id) ?? '')
    .filter((n) => n !== '');
  const header = threadHeaderLines(chat, names);
  const shown = block === undefined ? [] : [block.root, ...block.replies];
  const messages = shown.filter((m): m is ThreadMessage => m !== null);
  const labels = threadDayTimes(
    messages.map((m) => messageTimeSource(m)),
    wiring.timeZone,
  );
  const labelOf = new Map(messages.map((m, i) => [m.id, labels[i] ?? 'clock']));
  const profiles = profilesOf(
    wiring.workspaceId,
    messages.flatMap((m) => (m.senderUserId !== null ? [m.senderUserId] : [])),
  );
  const isGroup = chat?.channelType !== 'dm';
  const hidden = block !== undefined ? hiddenReplies(thread.replyCount, block.replies.length) : 0;
  const bubble = (m: ThreadMessage): ReactElement => (
    <MessageBubble
      key={m.id}
      message={m}
      profiles={profiles}
      cache={wiring.cache}
      presignEnabled={wiring.presignEnabled}
      showTicks={false}
      isGroup={isGroup}
      head
      tail
      timeZone={wiring.timeZone}
      layout={wiring.layout}
      viewerUserId={wiring.currentUserId}
      workspaceId={wiring.workspaceId}
      threadPlace="reply"
      timeLabel={labelOf.get(m.id) ?? 'clock'}
      onTapOpen={open}
    />
  );
  return (
    <section
      data-threads-block={thread.rootId}
      data-unread={thread.unread ? '' : undefined}
      className="flex flex-col px-4 py-4"
    >
      <PressableRow
        data-threads-header=""
        aria-label={`Open thread in ${header.name || 'chat'}`}
        onClick={open}
        className={`${LINE_HIT} flex flex-col pl-11`}
      >
        <Text role="heading" className={thread.unread ? 'truncate' : 'truncate text-fg-2'}>
          {header.name || ' '}
        </Text>
        <Text role="secondary" className="text-fg-3">
          {header.sub || ' '}
        </Text>
      </PressableRow>
      {block === undefined ? (
        <ThreadViewFill loading={!props.failed} failed={props.failed} onRetry={props.onRetry} />
      ) : (
        <ul className="flex flex-col">
          {block.root !== null ? bubble(block.root) : null}
          {hidden > 0 ? (
            <li className="flex pl-11 pt-2">
              <PressableRow
                inline
                data-threads-more=""
                onClick={open}
                className={`${LINE_HIT} w-auto`}
              >
                <Text role="label" className="text-fg underline">
                  {moreRepliesLabel(hidden)}
                </Text>
              </PressableRow>
            </li>
          ) : null}
          {block.replies.map(bubble)}
        </ul>
      )}
      <div className="flex pl-11 pt-3">
        <Button variant="secondary" data-threads-reply="" onClick={open}>
          Reply
        </Button>
      </div>
    </section>
  );
}

/** The band between two blocks: 12 tall, panel-3, hairline top and bottom (approved exception). */
export function ThreadsBand(): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-threads-band=""
      className="h-3 border-y border-border bg-panel-3"
    />
  );
}

/** The list body: blocks split by bands (none after the last), or the zero state. Pure render. */
export function ThreadsListBody(props: {
  threads: readonly ThreadForMeAll[];
  chatOf: (channelId: string) => ChannelSummary | undefined;
  blocks: ReadonlyMap<string, ThreadBlockData>;
  failed: boolean;
  onRetry: () => void;
  onOpen: (thread: ThreadForMeAll) => void;
  wiring: BlockWiring;
}): ReactElement {
  if (props.threads.length === 0) {
    return (
      <EmptyState icon={<IconActivity size={ICON_SIZE.status} />} title={THREADS_LIST_EMPTY} />
    );
  }
  return (
    <div data-threads-list="" className="flex flex-col">
      {props.threads.map((thread, i) => (
        <Fragment key={thread.rootId}>
          {i > 0 ? <ThreadsBand /> : null}
          <ThreadBlock
            thread={thread}
            chat={props.chatOf(thread.channelId)}
            block={props.blocks.get(thread.rootId)}
            failed={props.failed}
            onRetry={props.onRetry}
            onOpen={props.onOpen}
            wiring={props.wiring}
          />
        </Fragment>
      ))}
    </div>
  );
}

/** The screen over the app: "<" Threads, the list under it in its own scroller. */
export function ThreadsListScreen(props: {
  workspaceId: string;
  currentUserId: string;
  timeZone?: string | undefined;
  onClose: () => void;
  onOpenThread: (thread: ThreadForMeAll) => void;
}): ReactElement {
  const { workspaceId, currentUserId } = props;
  const held = useSyncExternalStore(
    subscribeThreads,
    () => peekThreads(workspaceId),
    () => peekThreads(workspaceId),
  );
  const threads = useMemo(() => orderThreads(held ?? []), [held]);
  const { roster } = useChatStore();
  const chatOf = useCallback(
    (channelId: string) => roster.find((c) => c.channelId === channelId),
    [roster],
  );
  const { blocks, failed, retry } = useThreadBlocks(workspaceId, currentUserId, threads);
  const layout = useChatLayout();
  const wiring: BlockWiring = {
    workspaceId,
    currentUserId,
    timeZone: props.timeZone,
    layout,
    cache: appPresignCache(),
    presignEnabled: env.VITE_ASSET_READ_URL !== undefined,
  };
  // A deeper screen: it enters from the right (motion module; instant under Reduce Motion).
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    mark('activity:threads-list-paint');
    pushIn(rootRef.current);
  }, []);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={THREADS_LIST_TITLE}
      data-threads-screen=""
      className="fixed inset-0 z-sheet flex h-dvh flex-col bg-bg"
    >
      <HeaderBar
        compact
        title={THREADS_LIST_TITLE}
        onBack={props.onClose}
        className={SAFE_TOP_BAR_CLASS}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {held === null ? null : (
          <ThreadsListBody
            threads={threads}
            chatOf={chatOf}
            blocks={blocks}
            failed={failed}
            onRetry={retry}
            onOpen={props.onOpenThread}
            wiring={wiring}
          />
        )}
      </div>
    </div>
  );
}
