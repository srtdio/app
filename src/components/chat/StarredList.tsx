// The starred messages list, shared by the thread header's Starred sheet, the
// chat home's Starred chip and the Contact / Group info Starred tab. Each row
// is a 16px-radius panel card: a 28px avatar, "Sender › Chat" (the chat part
// left out in a per-chat view and for DMs), the mono date and a chevron, then
// the message as a bubble (own on the accent fill, others on panel-2), text
// clamped to 3 lines (the chat home's all-chats list shows it whole), media as
// the compact summary search rows use. A tap
// opens the chat at the message. Pages are 30 rows, keyset, the next one read
// as the end scrolls in. Sender names come from what is loaded; the missing
// ones of a page are read in ONE batched read. Edit mode puts a select circle
// on each row and an "Unstar (N)" bar at the bottom: one write per chat among
// the selected rows. Every row reads the star store, so an unstar anywhere
// takes the row out here at once. Lists scroll on Y only; no motion on toggle;
// colours are tokens only, so light and dark match.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { ICON_SIZE, IconChevronLeft, IconChevronRight, IconStar } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { readProfiles, type ChannelSummary, type ChatProfile } from '@/lib/chat-reads';
import { knownMentionName, resolveMentionText, withFormer } from '@/lib/chat/mentions';
import { searchDateLabel } from '@/lib/chat/search';
import { safeTimeZone } from '@/lib/chat/time-format';
import type { Result } from '@srtdio/rpc';
import {
  listRowStarred,
  loadStarredPage,
  mergeStarredRows,
  starredQuery,
  starredRowHead,
  unstarLabel,
  useStarSnapshot,
  useStarStore,
  STAR_FAILED_TOAST,
  STARRED_EMPTY_LINE,
  STARRED_EMPTY_TITLE,
  STARRED_TITLE,
  type StarredCursor,
  type StarredPage,
  type StarredRow,
  type StarSnapshot,
  type StarStore,
  type StarTarget,
  type StarWriteResult,
} from '@/lib/chat/stars';
import { ModalPanel } from '@/components/chat/ModalPanel';

/** Typing settles this long before a narrowed list is read. */
export const STARRED_DEBOUNCE_MS = 250;

/** One page read: the chat filter, the text, the cursor. */
export type StarredPageFetch = (request: {
  channelId: string | null;
  query: string | null;
  before: StarredCursor | null;
  signal: AbortSignal;
}) => Promise<Result<StarredPage>>;

/** What one list holds. */
export interface StarredFeed {
  status: 'loading' | 'ready' | 'error';
  rows: StarredRow[];
  next: StarredCursor | null;
  loadingMore: boolean;
  moreFailed: boolean;
}

export const STARRED_LOADING: StarredFeed = {
  status: 'loading',
  rows: [],
  next: null,
  loadingMore: false,
  moreFailed: false,
};

/** A star or unstar from any surface: the store's write, the toast on failure. */
export function useStarToggle(): (
  targets: readonly StarTarget[],
  starred: boolean,
) => Promise<StarWriteResult> {
  const store = useStarStore();
  const toast = useToast();
  return useCallback(
    async (targets, starred) => {
      if (store === null) return { ok: false, message: 'stars unavailable' };
      const result = await store.toggle(targets, starred);
      if (!result.ok) toast.show({ title: STAR_FAILED_TOAST });
      return result;
    },
    [store, toast],
  );
}

/**
 * One list's pages: the first page on mount and on every change of chat or
 * text (debounced while typing), the next page on demand, and the first page
 * again (merged in, never shortening) after every accepted star. A stale
 * answer is dropped.
 */
export function useStarredFeed(params: {
  store: StarStore | null;
  channelId: string | null;
  query: string;
  fetchPage?: StarredPageFetch;
  debounceMs?: number;
}): { feed: StarredFeed; loadMore: () => void; retry: () => void } {
  const { store, channelId, fetchPage } = params;
  const debounceMs = params.debounceMs ?? STARRED_DEBOUNCE_MS;
  const query = starredQuery(params.query);
  const workspaceId = store?.workspaceId ?? null;
  const version = useStarSnapshot(store).version;
  const [feed, setFeed] = useState<StarredFeed>(STARRED_LOADING);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const gen = useRef(0);
  const [attempt, setAttempt] = useState(0);

  const fetcher = useMemo<StarredPageFetch | null>(() => {
    if (fetchPage !== undefined) return fetchPage;
    if (workspaceId === null) return null;
    return (request) =>
      loadStarredPage({
        client: supabase,
        workspaceId,
        channelId: request.channelId,
        query: request.query,
        before: request.before,
        signal: request.signal,
      });
  }, [fetchPage, workspaceId]);

  // The first page: on mount, a new chat filter or text, a retry.
  const firstKey = `${workspaceId ?? ''}|${channelId ?? ''}|${query ?? ''}|${attempt}`;
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (fetcher === null) return;
    gen.current += 1;
    const mine = gen.current;
    const controller = new AbortController();
    const typed = shownKey.current !== null;
    setFeed((prev) => ({ ...prev, status: prev.rows.length > 0 ? prev.status : 'loading' }));
    const run = (): void => {
      void fetcher({ channelId, query, before: null, signal: controller.signal }).then((result) => {
        if (mine !== gen.current) return;
        shownKey.current = firstKey;
        setFeed(
          result.ok
            ? {
                status: 'ready',
                rows: result.data.rows,
                next: result.data.next,
                loadingMore: false,
                moreFailed: false,
              }
            : { ...STARRED_LOADING, status: 'error' },
        );
      });
    };
    const timer = typed && debounceMs > 0 ? setTimeout(run, debounceMs) : null;
    if (timer === null) run();
    return () => {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
    // firstKey carries channelId, query and attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, firstKey, debounceMs]);

  // An accepted star elsewhere: the first page again, folded in.
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    if (fetcher === null || feedRef.current.status !== 'ready') return;
    const mine = gen.current;
    const controller = new AbortController();
    void fetcher({ channelId, query, before: null, signal: controller.signal }).then((result) => {
      if (mine !== gen.current || !result.ok) return;
      setFeed((prev) => ({
        ...prev,
        rows: mergeStarredRows(prev.rows, result.data.rows),
        next: prev.rows.length === 0 ? result.data.next : prev.next,
      }));
    });
    return () => controller.abort();
  }, [version, fetcher, channelId, query]);

  const loadMore = useCallback(() => {
    const current = feedRef.current;
    if (fetcher === null || current.status !== 'ready') return;
    if (current.next === null || current.loadingMore) return;
    const mine = gen.current;
    const before = current.next;
    setFeed({ ...current, loadingMore: true, moreFailed: false });
    void fetcher({ channelId, query, before, signal: new AbortController().signal }).then(
      (result) => {
        if (mine !== gen.current) return;
        setFeed((prev) =>
          result.ok
            ? {
                ...prev,
                rows: mergeStarredRows(prev.rows, result.data.rows),
                next: result.data.next,
                loadingMore: false,
              }
            : { ...prev, loadingMore: false, moreFailed: true },
        );
      },
    );
  }, [fetcher, channelId, query]);

  const retry = useCallback(() => {
    if (feedRef.current.moreFailed) {
      setFeed((prev) => ({ ...prev, moreFailed: false }));
      loadMore();
      return;
    }
    setAttempt((n) => n + 1);
  }, [loadMore]);

  return { feed, loadMore, retry };
}

/**
 * The sender ids a page needs names for: not me, not loaded, not in the
 * workspace's name registry, not asked before. Pure.
 */
export function sendersToRead(
  rows: readonly StarredRow[],
  known: (userId: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const id = row.senderUserId;
    if (id !== null && !known(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Long-press and right-click never open a native menu or callout on a row. */
function noCallout(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/** The 28px sender avatar: the photo when known, else initials on panel-3. */
function RowAvatar(props: { name: string; src: string | null }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-panel-3 text-xs font-semibold text-fg-2"
    >
      {props.src !== null ? (
        <img src={props.src} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        initialsOf(props.name)
      )}
    </span>
  );
}

export interface StarredRowViewProps {
  row: StarredRow;
  sender: string;
  /** The chat part after the sender, or null. */
  chat: string | null;
  avatarUrl: string | null;
  mine: boolean;
  date: string;
  /** The body with mentions as "@Name". */
  text: string;
  /** The whole text, the bubble growing to fit (chat home); else 3 lines. */
  fullText?: boolean;
  /** Edit mode: the row toggles its select circle instead of opening. */
  selecting?: { checked: boolean; onToggle: () => void } | undefined;
  onOpen: () => void;
}

/** One starred row card. Hook-free. */
export function StarredRowView(props: StarredRowViewProps): ReactElement {
  const { row, selecting } = props;
  const label = props.chat !== null ? `${props.sender} in ${props.chat}` : props.sender;
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-starred-row={row.id}
        aria-label={`Open starred message from ${label}`}
        {...(selecting !== undefined ? { 'aria-pressed': selecting.checked } : {})}
        onClick={selecting !== undefined ? selecting.onToggle : props.onOpen}
        onContextMenu={noCallout}
        className={cn(
          'flex min-h-[44px] w-full min-w-0 items-center gap-3 rounded-2xl border border-border bg-panel p-3 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          NO_TOUCH_SELECT,
        )}
      >
        {selecting !== undefined ? <SelectCheck checked={selecting.checked} /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <RowAvatar name={props.sender} src={props.avatarUrl} />
            <span className="min-w-0 flex-1 truncate text-base text-fg">
              <span className="font-semibold">{props.sender}</span>
              {props.chat !== null ? (
                <span data-starred-chat="" className="text-fg-3">
                  {`  ›  ${props.chat}`}
                </span>
              ) : null}
            </span>
            <span
              data-starred-date=""
              className="shrink-0 font-mono text-sm tabular-nums text-fg-3"
            >
              {props.date}
            </span>
            <IconChevronRight size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
          </span>
          <span
            data-starred-bubble={props.mine ? 'own' : 'peer'}
            className={cn(
              'max-w-[92%] self-start whitespace-pre-wrap rounded-[18px] px-3 py-2 text-lg leading-5',
              props.fullText === true
                ? 'min-w-0 [overflow-wrap:anywhere]'
                : 'line-clamp-3 break-words',
              props.mine ? 'bg-bubble-own text-accent-fg' : 'bg-panel-2 text-fg',
            )}
          >
            {props.text}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The empty state: a title and one line, no illustration. Hook-free. */
export function StarredEmpty(): ReactElement {
  return (
    <div data-starred-empty="" className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p className="text-lg font-semibold text-fg">{STARRED_EMPTY_TITLE}</p>
      <p className="text-base text-fg-2">{STARRED_EMPTY_LINE}</p>
    </div>
  );
}

/** Skeleton cards while the first page loads. */
const LOADING_ROWS = 3;

export interface StarredListProps {
  /** One chat's stars, or null for every chat. */
  channelId: string | null;
  /** The search box text; 2+ characters narrow the list. */
  query?: string;
  /** Show "› Chat" after the sender (the all-chats list). */
  showChat: boolean;
  /** Chat names and kinds (already loaded). */
  channelsById: ReadonlyMap<string, ChannelSummary>;
  /** Names and photos already loaded (the open thread's). */
  profiles?: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  onOpen: (row: StarredRow) => void;
  /** Edit mode (controlled); absent never edits. */
  editing?: boolean;
  /** Offer the inline Edit / Done control above the rows (chat home). */
  inlineEdit?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Preview: the first rows only, then this node (See all). */
  preview?: { rows: number; seeAll: ReactNode };
  /** Tests: the page read and the clock. */
  fetchPage?: StarredPageFetch;
  nowMs?: number;
  debounceMs?: number;
}

/** The stateful list. Reads the star store from context. */
export function StarredList(props: StarredListProps): ReactElement {
  const store = useStarStore();
  const snapshot = useStarSnapshot(store);
  const toggle = useStarToggle();
  const { feed, loadMore, retry } = useStarredFeed({
    store,
    channelId: props.channelId,
    query: props.query ?? '',
    ...(props.fetchPage !== undefined ? { fetchPage: props.fetchPage } : {}),
    ...(props.debounceMs !== undefined ? { debounceMs: props.debounceMs } : {}),
  });
  const workspaceId = store?.workspaceId ?? null;
  const [read, setRead] = useState<Map<string, ChatProfile>>(() => new Map());
  const asked = useRef(new Set<string>());
  const profiles = props.profiles;
  const nameOf = useMemo(
    () =>
      withFormer(
        (userId: string): string | undefined =>
          profiles?.get(userId)?.displayName ??
          read.get(userId)?.displayName ??
          knownMentionName(workspaceId, userId),
        workspaceId,
      ),
    [profiles, read, workspaceId],
  );
  // One batched read per page for senders nobody has loaded.
  const { currentUserId } = props;
  useEffect(() => {
    const ids = sendersToRead(
      feed.rows,
      (id) => id === currentUserId || asked.current.has(id) || nameOf(id) !== undefined,
    );
    if (ids.length === 0) return;
    for (const id of ids) asked.current.add(id);
    void readProfiles(supabase, ids).then((result) => {
      if (!result.ok || result.data.length === 0) return;
      setRead((prev) => {
        const next = new Map(prev);
        for (const profile of result.data) next.set(profile.userId, profile);
        return next;
      });
    });
  }, [feed.rows, currentUserId, nameOf]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const editing = props.editing === true;
  useEffect(() => {
    if (!editing) setSelected(new Set());
  }, [editing]);
  const [busy, setBusy] = useState(false);

  const sentinelRef = useRef<HTMLLIElement>(null);
  const canPage = starredCanPage(feed, props.preview !== undefined);
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || !canPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canPage, loadMore, feed.rows.length]);

  const visible = feed.rows.filter((row) => listRowStarred(snapshot, row.id));
  const selectedRows = visible.filter((row) => selected.has(row.id));
  const unstarSelected = async (): Promise<void> => {
    if (busy || selectedRows.length === 0) return;
    setBusy(true);
    // One write per chat among the selected rows (the store groups them).
    const result = await toggle(
      selectedRows.map((row) => ({ id: row.id, channelId: row.channelId })),
      false,
    );
    setBusy(false);
    if (result.ok) setSelected(new Set());
  };

  const nowMs = props.nowMs ?? Date.now();
  const zone = safeTimeZone(props.timeZone);
  return starredListView({
    listId: props.channelId ?? 'all',
    available: store !== null || props.fetchPage !== undefined,
    feed,
    snapshot,
    rowProps: (row) => {
      const channel = props.channelsById.get(row.channelId);
      const head = starredRowHead({
        senderUserId: row.senderUserId,
        currentUserId,
        nameOf,
        chatTitle: channel?.title ?? null,
        showChat: props.showChat,
        isDm: channel?.channelType === 'dm',
      });
      return {
        sender: head.sender,
        chat: head.chat,
        avatarUrl:
          row.senderUserId !== null
            ? (profiles?.get(row.senderUserId)?.avatarUrl ??
              read.get(row.senderUserId)?.avatarUrl ??
              null)
            : null,
        mine: row.senderUserId !== null && row.senderUserId === currentUserId,
        date: searchDateLabel(row.createdAt, nowMs, zone),
        text: row.body.trim() !== '' ? resolveMentionText(row.body, nameOf) : row.mediaLine,
        // The all-chats list (chat home's Starred chip) shows every line.
        fullText: props.channelId === null,
      };
    },
    editing,
    selected,
    onToggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onOpen: props.onOpen,
    ...(props.preview !== undefined ? { preview: props.preview } : {}),
    ...(props.inlineEdit === true && props.onEditingChange !== undefined
      ? { onEditingChange: props.onEditingChange }
      : {}),
    busy,
    onUnstar: () => void unstarSelected(),
    onRetry: retry,
    sentinelRef,
  });
}

/** Whether the end marker may load the next page (never in a preview). Pure. */
export function starredCanPage(feed: StarredFeed, preview: boolean): boolean {
  return (
    !preview &&
    feed.status === 'ready' &&
    feed.next !== null &&
    !feed.loadingMore &&
    !feed.moreFailed
  );
}

export interface StarredListViewProps {
  /** 'all', or the chat's id. */
  listId: string;
  /** False outside the chat page (no store): the empty state, nothing read. */
  available: boolean;
  feed: StarredFeed;
  /** The one star source: a row unstarred anywhere is left out at once. */
  snapshot: StarSnapshot;
  rowProps: (row: StarredRow) => Omit<StarredRowViewProps, 'row' | 'selecting' | 'onOpen'>;
  editing: boolean;
  selected: ReadonlySet<string>;
  onToggle: (messageId: string) => void;
  onOpen: (row: StarredRow) => void;
  preview?: { rows: number; seeAll: ReactNode };
  /** The inline Edit / Done control (chat home); absent hides it. */
  onEditingChange?: (editing: boolean) => void;
  busy: boolean;
  onUnstar: () => void;
  onRetry: () => void;
  sentinelRef?: Ref<HTMLLIElement>;
}

/** The list's tree for a given state. Hook-free so tests walk every state. */
export function starredListView(props: StarredListViewProps): ReactElement {
  const { feed, editing, selected } = props;
  const visible = feed.rows.filter((row) => listRowStarred(props.snapshot, row.id));
  const shown = props.preview !== undefined ? visible.slice(0, props.preview.rows) : visible;
  const selectedCount = visible.filter((row) => selected.has(row.id)).length;
  const canPage = starredCanPage(feed, props.preview !== undefined);
  const retryRow = (
    <li>
      <button
        type="button"
        data-starred-retry=""
        onClick={props.onRetry}
        className="flex min-h-[44px] w-full items-center justify-center rounded-[14px] px-3 text-base text-fg-2 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Couldn&apos;t load. Try again.
      </button>
    </li>
  );

  let body: ReactElement;
  if (!props.available) {
    body = <StarredEmpty />;
  } else if (feed.status === 'loading' && feed.rows.length === 0) {
    body = (
      <ul data-starred-loading="" className="flex flex-col gap-2.5">
        {Array.from({ length: LOADING_ROWS }, (_, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-2xl border border-border bg-panel p-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 shrink-0 rounded-full bg-panel-2" />
              <div className="h-3.5 w-1/3 rounded bg-panel-2" />
            </div>
            <div className="h-8 w-2/3 rounded-[18px] bg-panel-2" />
          </li>
        ))}
      </ul>
    );
  } else if (feed.status === 'error') {
    body = <ul className="flex flex-col">{retryRow}</ul>;
  } else if (visible.length === 0 && feed.next === null) {
    body = <StarredEmpty />;
  } else {
    body = (
      <ul data-starred-rows="" className="flex flex-col gap-2.5">
        {shown.map((row) => (
          <StarredRowView
            key={row.id}
            row={row}
            {...props.rowProps(row)}
            selecting={
              editing
                ? { checked: selected.has(row.id), onToggle: () => props.onToggle(row.id) }
                : undefined
            }
            onOpen={() => props.onOpen(row)}
          />
        ))}
        {feed.loadingMore ? (
          <li data-starred-more="" className="px-2 py-3">
            <div className="mx-auto h-3 w-1/3 rounded bg-panel-2" />
          </li>
        ) : null}
        {feed.moreFailed ? retryRow : null}
        {canPage ? (
          <li
            ref={props.sentinelRef}
            data-starred-sentinel=""
            aria-hidden="true"
            className="h-px"
          />
        ) : null}
      </ul>
    );
  }

  const onEditingChange = props.onEditingChange;
  const seeAll =
    props.preview !== undefined &&
    visible.length > 0 &&
    (visible.length > props.preview.rows || feed.next !== null);
  return (
    <div data-starred-list={props.listId} className="flex flex-col">
      {onEditingChange !== undefined && visible.length > 0 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="link"
            data-starred-edit={editing ? 'done' : 'edit'}
            onClick={() => onEditingChange(!editing)}
            className="min-w-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        </div>
      ) : null}
      {body}
      {seeAll ? <div className="mt-3">{props.preview?.seeAll}</div> : null}
      {editing ? (
        <div
          data-starred-bar=""
          className="sticky bottom-0 mt-3 flex items-center justify-end border-t border-border bg-panel px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3"
        >
          <Button
            variant="ghost"
            data-starred-unstar=""
            disabled={selectedCount === 0 || props.busy}
            onClick={props.onUnstar}
          >
            <IconStar size={ICON_SIZE.inline} />
            {unstarLabel(selectedCount)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The thread header's Starred page: full screen over the app (no motion, as
 * the Contact page), Back, "Starred" over the chat's name, Edit / Done, and
 * this chat's starred messages. A row closes the page and jumps to it.
 */
export function StarredSheet(props: {
  open: boolean;
  onClose: () => void;
  channelId: string;
  chatName: string;
  channelsById: ReadonlyMap<string, ChannelSummary>;
  profiles?: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  onJump: (messageId: string) => void;
  fetchPage?: StarredPageFetch;
}): ReactElement | null {
  const { open, onClose, onJump } = props;
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <ModalPanel
      aria-label={STARRED_TITLE}
      data-starred-sheet=""
      className="fixed inset-0 z-50 flex flex-col bg-bg outline-none"
    >
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-panel px-2 md:px-4">
        <IconButton label="Back" onClick={onClose}>
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-lg font-semibold leading-5 text-fg">{STARRED_TITLE}</h2>
          <span data-starred-chat-name="" className="truncate text-sm text-fg-2">
            {props.chatName}
          </span>
        </div>
        <Button
          type="button"
          variant="link"
          data-starred-edit={editing ? 'done' : 'edit'}
          onClick={() => setEditing((on) => !on)}
          className="min-w-[44px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className="mx-auto w-full max-w-2xl px-4 pt-3">
          <StarredList
            channelId={props.channelId}
            showChat={false}
            channelsById={props.channelsById}
            {...(props.profiles !== undefined ? { profiles: props.profiles } : {})}
            currentUserId={props.currentUserId}
            timeZone={props.timeZone}
            editing={editing}
            onEditingChange={setEditing}
            onOpen={(row) => {
              onClose();
              onJump(row.id);
            }}
            {...(props.fetchPage !== undefined ? { fetchPage: props.fetchPage } : {})}
          />
        </div>
      </div>
    </ModalPanel>,
    document.body,
  );
}
