// Catch up (Slack's way): one card per notification over the app. Phone: full
// screen on the canvas token. Laptop: the same card in a centred 560 x 680 box
// over the scrim (a floating layer: lit-overlay). The bar: "<" Back, "<N>
// left", Undo (4 s). The bottom: Keep unread and Mark as read, 50/50; a
// long-press on Mark as read marks every queued entry read (one call) and
// ends. Laptop keys: left = Keep unread, right = Mark as read, Escape = Back,
// with the key hints in the buttons. The card swipes on X with a lean (rotate
// up to 6deg, never Y); the stack below never moves. While the reply box is
// focused on a phone the bar and the buttons hide (the keyboard is up) and the
// card's top row shows hide-keyboard and the green check (Mark as read and
// next). Sending never advances. The first card paints from the entry
// Activity holds; only the current and next chat cards are read, batched.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { errorText } from '@/lib/error-copy';
import { generateTraceId } from '@/lib/trace';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useModalFocus } from '@/lib/modal-focus';
import { SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';
import type { Played } from '@/lib/motion';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChevronDown } from '@/components/ui/icons';
import { Text, textRole } from '@/components/ui/Text';
import { TRAILING_PULL } from '@/components/ui/layout';
import { useLongPress } from '@/components/ui/useLongPress';
import { useOptionalToast } from '@/components/ui/toast';
import type { ActivityItem } from '@/components/pages/activity/data';
import { personAvatar, personName } from '@/lib/people-names';
import { createComment } from '@srtdio/comments';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { useCatchUp } from '@/lib/catch-up/use-catch-up';
import { readCatchUpChat, type CatchUpChatContent } from '@/lib/catch-up/reads';
import {
  KEEP_UNREAD,
  MARK_AS_READ,
  UNDO,
  catchUpCardKind,
  catchUpReplyHint,
  isChatCard,
  leftLabel,
} from '@/lib/catch-up/copy';
import { flyOut, springHome, swipeDecision, swipeTint, swipeTransform } from '@/lib/catch-up/card-swipe';
import { CatchUpCard, TypingCheck, type SentMessage } from '@/components/catch-up/CatchUpCard';
import { CatchUpReply } from '@/components/catch-up/CatchUpReply';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';

/** Move this far (px) before a press becomes a swipe (or a scroll, if it went up or down first). */
const SWIPE_START_PX = 10;

export interface CatchUpScreenProps {
  queue: readonly ActivityItem[];
  workspaceId: string;
  currentUserId: string;
  selfName: string | null;
  onClose: () => void;
  onRead: (ids: readonly string[]) => void;
  onUnread: (ids: readonly string[]) => void;
  onAllRead: () => void;
}

/** Whether a key press is the laptop's left / right decision (never while typing in a field). Pure. */
export function decisionKey(key: string, inField: boolean): 'keep' | 'read' | null {
  if (inField) return null;
  if (key === 'ArrowLeft') return 'keep';
  if (key === 'ArrowRight') return 'read';
  return null;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  locked: boolean;
}

export function CatchUpScreen(props: CatchUpScreenProps): ReactElement {
  const { queue, workspaceId, currentUserId } = props;
  const laptop = useIsLaptop();
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const cu = useCatchUp(queue, {
    workspaceId,
    onRead: props.onRead,
    onUnread: props.onUnread,
    onAllRead: props.onAllRead,
    onFailed: (action) => toastRef.current?.show({ title: errorText(action, null), tone: 'error' }),
  });
  const [contents, setContents] = useState<ReadonlyMap<string, CatchUpChatContent>>(new Map());
  const [sent, setSent] = useState<ReadonlyMap<string, SentMessage[]>>(new Map());
  const [typing, setTyping] = useState(false);
  const [tint, setTint] = useState<'read' | 'keep' | null>(null);
  const [flying, setFlying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const playedRef = useRef<Played | null>(null);
  const requestedRef = useRef(new Set<string>());

  useModalFocus(rootRef, true, { initial: () => backRef.current });

  // Read only what the current and next card need (chat cards), one batched
  // read for both; nothing waits on it (the card paints from the entry).
  const current = cu.current;
  const next = cu.next;
  useEffect(() => {
    const want = [current, next].filter(
      (item): item is ActivityItem =>
        item !== null &&
        isChatCard(catchUpCardKind(item)) &&
        !requestedRef.current.has(item.id),
    );
    if (want.length === 0) return;
    for (const item of want) requestedRef.current.add(item.id);
    // Kept for the screen's life (an Undo back to a card paints it at once).
    void readCatchUpChat(supabase, workspaceId, want).then((got) => {
      if (got.size === 0) return;
      setContents((prev) => {
        const out = new Map(prev);
        for (const [id, content] of got) out.set(id, content);
        return out;
      });
    });
  }, [current, next, workspaceId]);

  // A new card rests unmoved: drop the last card's held fly-out pose before paint.
  useLayoutEffect(() => {
    playedRef.current?.cancel();
    playedRef.current = null;
    setTint(null);
  }, [cu.index]);

  const content = current !== null ? contents.get(current.id) : undefined;

  /** Fly the card out (from `fromDx` for a swipe, 0 for a button), then decide. */
  const go = useCallback(
    (decision: 'read' | 'keep', fromDx = 0): void => {
      if (flying || current === null) return;
      setFlying(true);
      setTint(decision);
      const latest = contents.get(current.id)?.latestReplyId ?? null;
      const played = flyOut(cardRef.current, decision, fromDx);
      playedRef.current = played;
      const finish = (): void => {
        setFlying(false);
        setTyping(false);
        cu.decide(decision === 'read', latest);
      };
      if (played.instant) finish();
      else void played.done.then(finish);
    },
    [flying, current, contents, cu],
  );

  // Laptop keys: left Keep unread, right Mark as read, Escape Back.
  const goRef = useRef(go);
  goRef.current = go;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const doneRef = useRef(cu.done);
  doneRef.current = cu.done;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        // A sheet over the screen (the emoji sheet) closes first.
        if (document.querySelector('[aria-modal="true"]') !== null) return;
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (!laptop || doneRef.current) return;
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
      const decision = decisionKey(event.key, inField);
      if (decision === null) return;
      event.preventDefault();
      goRef.current(decision);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [laptop]);

  // The swipe: X only, a lean with it; a press that goes up or down first scrolls.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (flying || typing) return;
    const target = event.target;
    if (target instanceof Element && target.closest('form, button, a, textarea, input') !== null) {
      return;
    }
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, locked: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const el = cardRef.current;
    if (drag === null || el === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.locked) {
      if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) > Math.abs(dx)) {
        dragRef.current = null;
        return;
      }
      if (Math.abs(dx) < SWIPE_START_PX) return;
      drag.locked = true;
      el.setPointerCapture?.(event.pointerId);
    }
    drag.dx = dx;
    el.style.transform = swipeTransform(dx, el.offsetWidth);
    const nextTint = swipeTint(dx, el.offsetWidth);
    setTint((prev) => (prev === nextTint ? prev : nextTint));
  };
  const onPointerEnd = (): void => {
    const drag = dragRef.current;
    const el = cardRef.current;
    dragRef.current = null;
    if (drag === null || !drag.locked || el === null) return;
    el.style.transform = '';
    const decision = swipeDecision(drag.dx, el.offsetWidth);
    if (decision !== null) {
      go(decision, drag.dx);
      return;
    }
    setTint(null);
    springHome(el, drag.dx);
  };

  // Sending: optimistic, never advances. A failure reads "Not sent" with Retry.
  const selfMessage = (id: string, text: string): SentMessage => ({
    id,
    senderId: currentUserId,
    senderName: personName(workspaceId, currentUserId) ?? 'You',
    senderAvatarUrl: personAvatar(workspaceId, currentUserId),
    createdAt: new Date().toISOString(),
    text,
    state: 'sending',
  });
  const setSentState = (entryId: string, id: string, state: SentMessage['state']): void => {
    setSent((prev) => {
      const out = new Map(prev);
      out.set(
        entryId,
        (out.get(entryId) ?? []).map((m) => (m.id === id ? { ...m, state } : m)),
      );
      return out;
    });
  };
  const deliver = (item: ActivityItem, message: SentMessage): void => {
    const traceId = generateTraceId();
    const kind = catchUpCardKind(item);
    const outcome: Promise<boolean> = isChatCard(kind)
      ? item.entityId === null
        ? Promise.resolve(false)
        : sendMessageRecord({
            client: supabase,
            id: message.id,
            channelId: item.entityId,
            traceId,
            body: message.text,
            attachmentAssetIds: [],
            replyToMessageId: kind === 'chat-main' ? null : (item.threadRootId ?? null),
          }).then((res) => res.ok)
      : item.entityId === null || (item.entityType !== 'post' && item.entityType !== 'brief')
        ? Promise.resolve(false)
        : createComment(supabase, {
            workspace_id: workspaceId,
            entity_type: item.entityType,
            entity_id: item.entityId,
            parent_comment_id: item.commentId,
            body: message.text,
            trace_id: traceId,
          }).then((res) => res.ok);
    void outcome.then((ok) => {
      if (!ok) logger.warn('catch-up: reply not sent', { trace_id: traceId, entry_id: item.id });
      setSentState(item.id, message.id, ok ? 'sent' : 'failed');
    });
  };
  const send = (text: string): void => {
    if (current === null) return;
    const message = selfMessage(newMessageId(), text);
    setSent((prev) => {
      const out = new Map(prev);
      out.set(current.id, [...(out.get(current.id) ?? []), message]);
      return out;
    });
    deliver(current, message);
  };
  const retry = (id: string): void => {
    if (current === null) return;
    const message = sent.get(current.id)?.find((m) => m.id === id);
    if (message === undefined) return;
    setSentState(current.id, id, 'sending');
    deliver(current, message);
  };

  const hideKeyboard = (): void => {
    inputRef.current?.blur();
    setTyping(false);
  };
  const typingRead = (): void => {
    inputRef.current?.blur();
    go('read');
  };

  const allRead = useLongPress(() => cu.markAll(), { ignoreMouse: true });

  const phoneTyping = typing && !laptop;
  const hint = current !== null ? catchUpReplyHint(current) : null;
  const kind = current !== null ? catchUpCardKind(current) : null;

  const bar = (
    <HeaderBar
      compact
      onBack={props.onClose}
      backProps={{ buttonRef: backRef, 'data-catch-up-back': '' }}
      title={cu.done ? '' : leftLabel(cu.left)}
      titleSlot={
        <Text role="title" as="h1" data-catch-up-left="" className="truncate text-center">
          {cu.done ? '' : leftLabel(cu.left)}
        </Text>
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          data-catch-up-undo=""
          disabled={!cu.canUndo}
          aria-hidden={!cu.canUndo}
          tabIndex={cu.canUndo ? 0 : -1}
          onClick={cu.undo}
          className={cn(TRAILING_PULL, !cu.canUndo && 'invisible')}
        >
          {UNDO}
        </Button>
      }
      className={laptop ? 'rounded-t-2xl' : SAFE_TOP_BAR_CLASS}
    />
  );

  const typingRow =
    typing && current !== null ? (
      <div data-catch-up-typing="" className="flex shrink-0 items-center justify-between px-2 pt-2">
        {!laptop ? (
          <IconButton
            type="button"
            label="Hide keyboard"
            data-catch-up-hide-keyboard=""
            onPointerDown={(event) => event.preventDefault()}
            onClick={hideKeyboard}
            className="rounded-full border"
          >
            <IconChevronDown size={ICON_SIZE.control} />
          </IconButton>
        ) : (
          <span />
        )}
        <TypingCheck onPress={typingRead} />
      </div>
    ) : null;

  const body = cu.done ? (
    <CatchUpEnd wentThrough={cu.wentThrough} onDone={props.onClose} />
  ) : current !== null ? (
    <>
      <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
        <CatchUpCard
          key={current.id}
          item={current}
          content={content}
          sent={sent.get(current.id) ?? []}
          selfName={props.selfName}
          tint={tint}
          typingRow={typingRow}
          reply={
            hint !== null && kind !== null ? (
              <CatchUpReply
                hint={hint}
                mode={kind === 'comment' ? 'comment' : 'chat'}
                laptop={laptop}
                onSend={send}
                onFocusChange={setTyping}
                inputRef={inputRef}
              />
            ) : null
          }
          onRetry={retry}
          cardRef={cardRef}
          gesture={{
            onPointerDown,
            onPointerMove,
            onPointerUp: onPointerEnd,
            onPointerCancel: onPointerEnd,
          }}
        />
      </div>
      {!phoneTyping ? (
        <div
          data-catch-up-actions=""
          className="grid shrink-0 grid-cols-2 gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))]"
        >
          <Button
            type="button"
            variant="secondary"
            data-catch-up-keep=""
            disabled={flying}
            onClick={() => go('keep')}
          >
            {KEEP_UNREAD}
            {laptop ? (
              <span aria-hidden="true" className={textRole('meta')}>
                ←
              </span>
            ) : null}
          </Button>
          <Button
            type="button"
            variant="success"
            data-catch-up-read=""
            disabled={flying}
            {...allRead.handlers}
            onContextMenu={(event) => event.preventDefault()}
            onClick={() => {
              if (allRead.consumeClickSuppression()) return;
              go('read');
            }}
          >
            {MARK_AS_READ}
            {laptop ? (
              <span aria-hidden="true" className={textRole('meta', 'text-current')}>
                →
              </span>
            ) : null}
          </Button>
        </div>
      ) : null}
    </>
  ) : (
    <div className="flex-1" />
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Catch up"
      data-catch-up=""
      className={cn(
        'fixed inset-0 z-sheet flex',
        laptop ? 'items-center justify-center p-4' : 'h-dvh flex-col bg-bg',
      )}
    >
      {laptop ? <Backdrop aria-label="Back" onClick={props.onClose} /> : null}
      <div
        data-catch-up-box=""
        className={cn(
          'relative flex min-h-0 flex-col',
          laptop
            ? 'h-catch-up max-h-full w-catch-up max-w-full rounded-2xl border bg-bg lit-overlay'
            : 'flex-1',
        )}
      >
        {!phoneTyping ? bar : null}
        {body}
      </div>
    </div>
  );
}
