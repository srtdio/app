// The comment thread's layer, lifted out of comments/Comments.tsx (12 Nov
// 2026) unchanged so post / brief comments and Plan item / Bank idea comments
// draw one thread: chat's ThreadViewFrame (phone: a portal over the page with
// "<"; laptop: the side panel), the bottom-anchored scroller, ThreadViewFill
// and the reply box docked under it. useCommentThreadStick keeps the open
// thread at its latest reply (chat's stick-to-bottom decisions, no second
// scroll core). CommentForwardLayer is chat's Forward picker for one comment's
// text and stored files (forwardComment). Pure render plus the scroller's own
// listeners: no read on paint.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { ThreadViewFill, ThreadViewFrame } from '@/components/chat/ThreadView';
import { commentForwardFiles, type CommentFile } from '@/components/comments/comment-files';
import { SidePanel } from '@/components/ui/SidePanel';
import { useRosterSafe } from '@/components/ui/use-open-person-dm';
import { forwardComment } from '@/lib/chat/forward-comment';
import { newMessageId } from '@/lib/chat/message-id';
import { sendMessageRecord } from '@/lib/chat/record';
import {
  distanceFromBottom,
  intentAfterScroll,
  newRowsAction,
  openingIntent,
  sizeChangeAction,
  type ScrollSource,
} from '@/lib/chat/stick-to-bottom';
import { supabase } from '@/lib/supabase';
import { useIsLaptop } from '@/lib/use-is-laptop';

/**
 * A comment thread opens at the latest reply (Thread polish 1, 11 Nov 2026):
 * chat's stick-to-bottom decisions (src/lib/chat/stick-to-bottom.ts, no
 * second scroll core) on the thread's scroller. On open it is set in a layout
 * effect, before the first paint (a thread shorter than the pane stays at the
 * top: there is nothing to scroll). While the viewer is at the end it stays
 * there when a reply lands, they send, the reply box grows or the keyboard
 * opens (visualViewport); once they scroll up it never moves them. A linked
 * reply (focusId) owns the opening position. No await, timer or read.
 */
export function useCommentThreadStick(input: {
  scrollRef: RefObject<HTMLDivElement>;
  rootId: string | null;
  landing: boolean;
  /** Changes when a reply lands (count and newest id). */
  rowsKey: string;
  /** This device's own sends still pending in the open thread. */
  ownPending: number;
}): void {
  const { scrollRef, rootId, landing, rowsKey, ownPending } = input;
  const intentRef = useRef(openingIntent());
  const programRef = useRef(false);
  const pin = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || distanceFromBottom(el) === 0) return;
    programRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);
  // Open: at the end before the first paint.
  useLayoutEffect(() => {
    if (rootId === null) return;
    intentRef.current = landing ? false : openingIntent();
    if (intentRef.current) pin();
    // Only a new thread re-opens; a landing change inside it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, pin]);
  // A reply lands, or the viewer sends from this device (takes hold again).
  const ownRef = useRef(ownPending);
  useLayoutEffect(() => {
    const ownLocalSend = ownPending > ownRef.current;
    ownRef.current = ownPending;
    if (rootId === null) return;
    if (ownLocalSend) intentRef.current = true;
    if (newRowsAction({ intent: intentRef.current, flicking: false, ownLocalSend }) === 'pin') {
      pin();
    }
  }, [rowsKey, ownPending, rootId, pin]);
  // Size: the rows grow (pictures, chips), the pane shrinks (reply box, keyboard).
  useEffect(() => {
    const el = scrollRef.current;
    if (rootId === null || el === null) return;
    const onSize = (): void => {
      const action = sizeChangeAction({
        intent: intentRef.current,
        pendingJump: false,
        olderPageRestore: false,
        flicking: false,
      });
      if (action === 'pin') pin();
    };
    const onScroll = (): void => {
      const source: ScrollSource = programRef.current ? 'program' : 'user';
      programRef.current = false;
      intentRef.current = intentAfterScroll({
        intent: intentRef.current,
        source,
        distanceFromBottom: distanceFromBottom(el),
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onSize) : null;
    observer?.observe(el);
    const list = el.firstElementChild;
    if (list !== null) observer?.observe(list);
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    viewport?.addEventListener('resize', onSize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      viewport?.removeEventListener('resize', onSize);
    };
  }, [rootId, scrollRef, pin]);
}

/**
 * The open thread: chat's ThreadViewFrame with the bottom-anchored scroller
 * (its rows: the root, chat's "N replies" strip, the replies), ThreadViewFill
 * and the reply box under it. Laptop: the side panel (fillBeside: beside the
 * post column); phone: a portal over the page.
 */
export function CommentThreadLayer(props: {
  title: string;
  subtitle: string | undefined;
  rootId: string;
  scrollRef: RefObject<HTMLDivElement>;
  /** The rows inside the thread's list (root, strip, replies). */
  rows: ReactNode;
  /** The reply box (chat's Composer). */
  composer: ReactNode;
  onRetry: () => void;
  /** The frame's "<" finished closing. */
  onClosed: () => void;
  /** The laptop panel's close. */
  onClose: () => void;
  fillBeside?: (() => number | null) | undefined;
  /** Extra data hooks on the scroller (a Plan thread marks itself). */
  scrollerData?: { [hook: `data-${string}`]: string | undefined } | undefined;
}): ReactElement {
  const laptop = useIsLaptop();
  const frame = (
    <ThreadViewFrame
      title={props.title}
      subtitle={props.subtitle}
      selecting={false}
      onClosed={props.onClosed}
    >
      <div
        ref={props.scrollRef}
        data-comment-thread={props.rootId}
        data-thread-anchor-bottom=""
        {...props.scrollerData}
        // 12 Nov 2026: the content sits on the reply box. A flex column
        // whose list takes margin-top auto: a short thread's spare room
        // is at the top; on overflow the margin is 0 (CSS only).
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {/* pb-3: 12 between the last row (its chips included) and the reply box. */}
        <ul className="mt-auto flex shrink-0 flex-col pb-3 pt-4">{props.rows}</ul>
      </div>
      <ThreadViewFill loading={false} failed={false} onRetry={props.onRetry} />
      <div data-comment-thread-composer="">{props.composer}</div>
    </ThreadViewFrame>
  );
  return laptop ? (
    <SidePanel
      open
      bare
      title={props.title}
      onClose={props.onClose}
      {...(props.fillBeside !== undefined ? { fillBeside: props.fillBeside } : {})}
    >
      {frame}
    </SidePanel>
  ) : (
    createPortal(
      <div data-comment-thread-layer="" className="fixed inset-0 z-sheet">
        {frame}
      </div>,
      document.body,
    )
  );
}

/**
 * Forward one comment (the replies bar's key, the sheet's tile): chat's
 * picker, mounted while open; the send is one chat message with the
 * comment's text and its files as stored (forwardComment). The files are read
 * after the picker's Send, never on a tap. Success and failure feedback are
 * the picker's own.
 */
export function CommentForwardLayer(props: {
  /** The text the message carries, resolved at Send (names known by then). */
  body: () => string;
  attachmentIds: readonly string[];
  files: ReadonlyMap<string, CommentFile>;
  newTrace: () => string;
  onClose: () => void;
}): ReactElement {
  const roster = useRosterSafe();
  return (
    <ForwardPicker
      historyStep
      open
      onClose={props.onClose}
      channels={roster}
      onSend={(chats) =>
        forwardComment({
          targets: chats,
          load: async () => {
            const attachments = await commentForwardFiles(
              supabase,
              props.attachmentIds,
              props.files,
            );
            if (attachments === null) return null;
            return { body: props.body(), attachments };
          },
          send: (record) => sendMessageRecord({ client: supabase, ...record }),
          newId: newMessageId,
          newTrace: props.newTrace,
        })
      }
      onSent={props.onClose}
    />
  );
}
