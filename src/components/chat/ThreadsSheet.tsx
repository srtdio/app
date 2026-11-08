// L6 (8 Nov 2026): the Threads list, built from chat_threads_for_me. Unread
// threads first (an ink dot), then read threads quieter (fg-3). Each row is
// the shared flat ui/ListCard: the root sender's square photo, name, time
// (formatAgo), the root's first line and the "N replies" tag. Tap opens the
// thread. Phone: a ui/Sheet ("<" header "Threads", rises translateY only).
// Laptop: the list takes the conversation pane with its own "<" back. Roots
// the chat has not loaded are read in one call when the list opens (never per
// row). Tokens only; light and dark at parity.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ListCard } from '@/components/ui/ListCard';
import { Text } from '@/components/ui/Text';
import { Sheet } from '@/components/ui/Sheet';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { formatAgo } from '@/lib/time';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { loadMessagesByIds } from '@/lib/chat/history';
import { replyPreview, rowToThreadMessage, type ThreadMessage } from '@/lib/chat/thread';
import { firstLineOf, repliesLabel, type ThreadForMe } from '@/lib/chat/thread-signals';
import { rootCardOf, THREAD_TITLE } from '@/lib/chat/thread-rail';

/** The sheet's title and the laptop pane's header. */
export const THREADS_TITLE = 'Threads';

/** The zero state (the "{Things} show up here." rule). */
export const THREADS_EMPTY = 'Threads show up here.';

/** One row of the list as drawn. Pure data. */
export interface ThreadsRow {
  rootId: string;
  name: string;
  src: string | undefined;
  time: string;
  preview: string;
  tag: string;
  unread: boolean;
}

/**
 * The list's rows: unread first, then read, each newest reply first (the
 * proc's order, kept stable). A root not known yet reads "Message". A root
 * carrying a card (post, brief, plan, plan item) with no text of its own
 * previews the card's title, the same name its thread screen shows. Pure.
 */
export function threadsRows(input: {
  threads: readonly ThreadForMe[];
  rootOf: (rootId: string) => ThreadMessage | undefined;
  nameOf: (userId: string | null) => string;
  photoOf: (userId: string | null) => string | undefined;
  /** The root card's held title (thread-rail threadTitleOf), or null. */
  cardTitleOf?: (root: ThreadMessage) => string | null;
  now: Date;
}): ThreadsRow[] {
  const sorted = [...input.threads].sort(
    (a, b) => Number(b.unread) - Number(a.unread) || b.lastReplyAt.localeCompare(a.lastReplyAt),
  );
  return sorted.map((t) => {
    const root = input.rootOf(t.rootId);
    const sender = root?.senderUserId ?? null;
    const preview =
      root === undefined
        ? 'Message'
        : root.deleted === true
          ? 'This message was deleted'
          : firstLineOf(root.body) ||
            (rootCardOf(root) !== null ? input.cardTitleOf?.(root) : null) ||
            replyPreview(root);
    return {
      rootId: t.rootId,
      name: root !== undefined ? input.nameOf(sender) : THREAD_TITLE,
      src: root !== undefined ? input.photoOf(sender) : undefined,
      time: formatAgo(t.lastReplyAt, input.now),
      preview,
      tag: repliesLabel(t.replyCount),
      unread: t.unread,
    };
  });
}

export function ThreadsSheet(props: {
  open: boolean;
  onClose: () => void;
  threads: readonly ThreadForMe[];
  /** The chat's loaded rows (roots looked up here first). */
  loaded: ReadonlyMap<string, ThreadMessage>;
  currentUserId: string;
  nameOf: (userId: string | null) => string;
  photoOf: (userId: string | null) => string | undefined;
  cardTitleOf?: (root: ThreadMessage) => string | null;
  onOpenThread: (rootId: string) => void;
}): ReactElement | null {
  const laptop = useIsLaptop();
  const [fetched, setFetched] = useState<Map<string, ThreadMessage>>(() => new Map());
  const askedRef = useRef(new Set<string>());
  const { open, threads, loaded, currentUserId } = props;
  // Roots not loaded: one read when the list opens.
  useEffect(() => {
    if (!open) return;
    const missing = threads
      .map((t) => t.rootId)
      .filter((id) => !loaded.has(id) && !askedRef.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => askedRef.current.add(id));
    let live = true;
    void loadMessagesByIds(supabase, missing).then((result) => {
      if (!live) return;
      if (!result.ok) {
        logger.warn('chat: thread roots read failed', { error: result.error.message });
        return;
      }
      setFetched((prev) => {
        const next = new Map(prev);
        for (const row of result.data) next.set(row.id, rowToThreadMessage(row, currentUserId));
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [open, threads, loaded, currentUserId]);
  const rows = useMemo(
    () =>
      threadsRows({
        threads,
        rootOf: (id) => loaded.get(id) ?? fetched.get(id),
        nameOf: props.nameOf,
        photoOf: props.photoOf,
        ...(props.cardTitleOf !== undefined ? { cardTitleOf: props.cardTitleOf } : {}),
        now: new Date(),
      }),
    // nameOf / photoOf read the latest profiles at render; cardTitleOf is
    // new each render so a card title that lands swaps in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, loaded, fetched, props.cardTitleOf],
  );
  const list =
    rows.length === 0 ? (
      <Text as="p" role="secondary" className="py-6 text-center text-fg-3">
        {THREADS_EMPTY}
      </Text>
    ) : (
      <ul data-threads-list="" className="flex flex-col">
        {rows.map((row) => (
          <ListCard
            key={row.rootId}
            as="li"
            data-thread-row={row.rootId}
            data-unread={row.unread ? '' : undefined}
            picture={{ kind: 'person', name: row.name, src: row.src ?? null }}
            title={row.name}
            time={row.time}
            preview={row.preview}
            tag={row.tag}
            unread={row.unread}
            muted={!row.unread}
            onPress={() => props.onOpenThread(row.rootId)}
            press={{
              'aria-label': `${row.name}: ${row.preview}. ${row.tag}${row.unread ? ', unread' : ''}`,
            }}
          />
        ))}
      </ul>
    );
  if (!laptop) {
    return (
      <Sheet open={open} onClose={props.onClose} title={THREADS_TITLE}>
        <div data-threads-sheet="">{list}</div>
      </Sheet>
    );
  }
  if (!open) return null;
  return (
    // Laptop: the list takes the conversation pane, "<" back to the chat.
    <div
      role="dialog"
      aria-label={THREADS_TITLE}
      data-threads-pane=""
      className="absolute inset-0 z-nav flex flex-col bg-bg"
    >
      <HeaderBar compact title={THREADS_TITLE} onBack={props.onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4">{list}</div>
    </div>
  );
}
