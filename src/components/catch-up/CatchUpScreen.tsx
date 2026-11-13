// Catch up (9 Nov 2026, Slack's way): ONE card per ITEM over the app. Phone:
// full screen on the catch-up page tone, rising from the bottom (rise, 320).
// Laptop: a centred 640 window (max 85vh) over the backdrop (dialogIn, 200).
// Top bar (no hairline, no header shade, on the page tone): round 48 "<"
// (Close catch up; inside a thread: Back to the card), "{n} left" centred
// (heading), round 48 Undo (the curved arrow; invisible, not removed, when
// there is nothing to undo; hidden while typing and inside a thread). The
// bottom row: Keep unread (Button) | Mark as read (Main, ink, never green).
// The card swipes on X with a lean (never Y); the next card settles in. A
// tap on a message's text or its "N replies" raises the thread sheet over the
// card (which stays put behind a scrim) with its reply field focused; "<", the
// scrim or system Back lowers it. Escape closes the menu, then the thread
// sheet, then catch up. The first card paints from what
// Activity holds; only the current and next card are read, batched, in the
// background. Read only: no edit, no resolve.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { errorText } from '@/lib/error-copy';
import { generateTraceId } from '@/lib/trace';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useModalFocus } from '@/lib/modal-focus';
import { copyText } from '@/lib/clipboard';
import { env } from '@/lib/env';
import { appPresignCache } from '@/lib/shared-presign';
import { dialogIn, dialogOut, itemIn, riseIn, riseOut, type Played } from '@/lib/motion';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  ICON_SIZE,
  IconArrowUpRight,
  IconChevronLeft,
  IconLink,
  IconReply,
} from '@/components/ui/icons';
import { Text, textRole } from '@/components/ui/Text';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { useLongPress } from '@/components/ui/useLongPress';
import { useOptionalToast } from '@/components/ui/toast';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { entityHref } from '@/components/pages/activity/data';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { personAvatar, personName } from '@/lib/people-names';
import { createComment } from '@srtdio/comments';
import { sendPlanComment } from '@/lib/chat/plans';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { useCatchUp } from '@/lib/catch-up/use-catch-up';
import {
  dismissThreadTip,
  noteThreadTipShown,
  threadTipVisible,
  tipText,
  wordsFamily,
} from '@/lib/catch-up/tip';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import {
  catchUpText,
  readCatchUpBodies,
  readCatchUpOlder,
  readCatchUpThread,
  type CatchUpBody,
  type CatchUpBodyResult,
  type CatchUpMessageRow,
  type CatchUpRow,
  type CatchUpThread,
} from '@/lib/catch-up/body';
import {
  EMPTY_DRAFT,
  type CatchUpDraft,
  type CatchUpReplyTarget,
  type CatchUpSend,
} from '@/lib/catch-up/types';
import { KEEP_UNREAD, MARK_AS_READ, UNDO, leftLabel } from '@/lib/catch-up/copy';
import {
  flyOut,
  springHome,
  swipeDecision,
  swipeTint,
  swipeTransform,
} from '@/lib/catch-up/card-swipe';
import { CatchUpCard, type SentMessage } from '@/components/catch-up/CatchUpCard';
import { CatchUpThreadView } from '@/components/catch-up/CatchUpThreadView';
import { ThreadViewHeader } from '@/components/chat/ThreadView';
import { REPLY_TITLE, type ReplyPlace } from '@/lib/chat/thread-rail';
import { CatchUpReply } from '@/components/catch-up/CatchUpReply';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';
import { useCatchUpActions } from '@/components/catch-up/CatchUpActionLayer';
import { firstName } from '@/components/catch-up/CatchUpRows';

/** Move this far (px) before a press becomes a swipe (or a scroll, if it went up or down first). */
const SWIPE_START_PX = 10;

/**
 * The page edge: 16 on a phone (12 Nov 2026: the bar's keys, the card and the
 * two buttons share the app's 16 gutter), 12 from 768 up as before.
 */
export const CATCH_UP_EDGE = 'px-4 md:px-3';

/** The bar: 64 tall under the safe area, on the page tone, no hairline and no shade. */
export const CATCH_UP_BAR_CLASS = `flex h-[calc(4rem+var(--shell-safe-top,0px))] shrink-0 items-center gap-2 ${CATCH_UP_EDGE} pt-[var(--shell-safe-top,0px)]`;

/** The bar's round 48 keys (soft grey fill): "<" and Undo. */
export const CATCH_UP_ROUND_KEY = 'h-12 w-12 rounded-full bg-fg/10';

export interface CatchUpScreenProps {
  queue: readonly CatchUpItem[];
  workspaceId: string;
  workspaceKey?: string | null;
  currentUserId: string;
  selfName: string | null;
  side?: ViewerSide;
  timeZone?: string | undefined;
  onClose: () => void;
  onRead: (ids: readonly string[]) => void;
  onUnread: (ids: readonly string[]) => void;
  onAllRead: () => void;
  /** Open the real place (the menu's "Open ..."): navigates and closes catch up. */
  onOpenPlace: (href: string) => void;
}

/** Whether a key press is the laptop's left / right decision (never while typing in a field). Pure. */
export function decisionKey(key: string, inField: boolean): 'keep' | 'read' | null {
  if (inField) return null;
  if (key === 'ArrowLeft') return 'keep';
  if (key === 'ArrowRight') return 'read';
  return null;
}

/** The menu's "Open ..." word for an item. Pure. */
export function openLabel(kind: CatchUpItem['kind']): string {
  switch (kind) {
    case 'post':
      return 'Open post';
    case 'brief':
      return 'Open brief';
    case 'plan-item':
      return 'Open plan item';
    case 'idea':
      return 'Open idea';
    default:
      return 'Open chat';
  }
}

/** Where a card's reply goes (outside a thread). Pure. */
export function cardReplyTarget(item: CatchUpItem): CatchUpReplyTarget {
  switch (item.kind) {
    case 'chat-main':
      return { kind: 'chat', channelId: item.entityId, threadRootId: null };
    case 'chat-thread':
      return { kind: 'chat', channelId: item.entityId, threadRootId: item.threadRootId };
    case 'post':
    case 'brief':
      return {
        kind: 'comment',
        entityType: item.kind,
        entityId: item.entityId,
        parentCommentId: null,
      };
    default:
      return { kind: 'plan-comment', itemId: item.entityId, parentCommentId: null };
  }
}

/** Slack's way: a post/brief card showing thread replies posts into the newest one's thread. Pure. */
export function cardThreadTarget(
  item: CatchUpItem,
  body: CatchUpBody | null,
): CatchUpReplyTarget | null {
  let newest: CatchUpMessageRow | null = null;
  for (const row of body?.rows ?? []) {
    if (
      row.kind === 'message' &&
      row.threadRoot !== undefined &&
      row.createdAt >= (newest?.createdAt ?? '')
    )
      newest = row;
  }
  const root = newest?.threadRoot;
  if ((item.kind !== 'post' && item.kind !== 'brief') || root === undefined) return null;
  return {
    kind: 'comment',
    entityType: item.kind,
    entityId: item.entityId,
    parentCommentId: root.id,
  };
}

/** The movable draft sits in the sheet's box while it is open, else in the card's. Pure. */
export function boxDraft(sheetBox: boolean, sheetOpen: boolean, draft: CatchUpDraft): CatchUpDraft {
  return sheetBox === sheetOpen ? draft : EMPTY_DRAFT;
}

/**
 * The reply box's hint. Chat cards: thread words. Comment cards: "Comment"
 * when it posts to the item, "Reply to <first name>" into a comment's replies. Pure.
 */
export function replyHint(
  item: CatchUpItem,
  inThread: boolean,
  rootAuthorName: string | null = null,
): string {
  if (wordsFamily(item.kind) === 'comment') {
    if (!inThread) return 'Comment';
    return rootAuthorName !== null ? `Reply to ${firstName(rootAuthorName)}` : 'Reply';
  }
  if (inThread || item.kind === 'chat-thread') return 'Reply in thread';
  return `Message ${item.lead.chatName ?? item.lead.actorName ?? 'chat'}`;
}

/** A thread's title by place (13 Nov 2026), the same words as every thread (REPLY_TITLE). Pure. */
export function threadTitle(item: CatchUpItem): string {
  const place: ReplyPlace =
    wordsFamily(item.kind) === 'chat'
      ? 'chat'
      : item.kind === 'brief'
        ? 'brief'
        : item.kind === 'plan-item'
          ? 'plan'
          : item.kind === 'idea'
            ? 'bank'
            : 'post';
  return REPLY_TITLE[place];
}

/** The root a card's Slack-way target posts under (its author names the box). Pure. */
export function targetRootOf(
  body: CatchUpBody | null,
  target: CatchUpReplyTarget | null,
): CatchUpMessageRow | null {
  if (target?.kind !== 'comment' || target.parentCommentId === null) return null;
  for (const row of body?.rows ?? []) {
    if (row.kind === 'message' && row.threadRoot?.id === target.parentCommentId)
      return row.threadRoot;
  }
  return null;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  locked: boolean;
}

interface OpenThread {
  cardKey: string;
  root: CatchUpMessageRow;
  kind: 'chat' | 'comment' | 'plan';
  target: CatchUpReplyTarget;
  data: CatchUpThread | null | 'error';
}

function withOlder(
  body: CatchUpBodyResult | undefined,
  hasOlder: boolean | undefined,
): CatchUpBodyResult | undefined {
  if (body === undefined || body === 'skip' || body === 'error' || hasOlder === undefined)
    return body;
  return { ...body, hasOlder };
}

export function CatchUpScreen(props: CatchUpScreenProps): ReactElement {
  const { queue, workspaceId, currentUserId } = props;
  const side = props.side ?? 'unknown';
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
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();
  const [bodies, setBodies] = useState<ReadonlyMap<string, CatchUpBodyResult>>(new Map());
  const [older, setOlder] = useState<
    ReadonlyMap<string, { rows: CatchUpRow[]; hasOlder: boolean }>
  >(new Map());
  const [sent, setSent] = useState<ReadonlyMap<string, SentMessage[]>>(new Map());
  const [typing, setTyping] = useState(false);
  const [tint, setTint] = useState<'read' | 'keep' | null>(null);
  const [flying, setFlying] = useState(false);
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [lightbox, setLightbox] = useState<{ pictures: string[]; index: number } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // The card box's text + @ picks: they move into the thread sheet's box and back.
  const [draft, setDraft] = useState<CatchUpDraft>(EMPTY_DRAFT);
  const [tipOn, setTipOn] = useState(() => threadTipVisible(currentUserId));
  const tipNotedRef = useRef(false);
  const threadInputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardBodyRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const swipedRef = useRef(false);
  const playedRef = useRef<Played | null>(null);
  const requestedRef = useRef(new Set<string>());
  const olderBusyRef = useRef(new Set<string>());
  const closingRef = useRef(false);

  useModalFocus(rootRef, true, { initial: () => backRef.current });

  // The one message action layer (strip keys and long-press): the same sheets as chat and comments.
  const actions = useCatchUpActions({
    workspaceId,
    currentUserId,
    side,
    timeZone: props.timeZone,
    linkOf: (item) => entityHref(item.lead, props.workspaceKey ?? null, side),
    // Reply in the long-press sheet: the thread opens with its box focused
    // (inside an open thread, the box takes focus).
    onReply: (target) => {
      if (threadOpenRef.current) threadInputRef.current?.focus({ preventScroll: true });
      else
        openRowThreadRef.current(
          target.row.kind === 'message' && target.row.threadRoot !== undefined
            ? target.row.threadRoot
            : target.row,
          true,
        );
    },
  });

  // Open: phone rises from the bottom, laptop grows from the centre (no fade).
  useLayoutEffect(() => {
    mark('catch-up:open');
    if (laptop) dialogIn(boxRef.current);
    else riseIn(boxRef.current);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    const played = laptop ? dialogOut(boxRef.current) : riseOut(boxRef.current);
    if (played.instant) props.onClose();
    else void played.done.then(() => props.onClose());
  }, [laptop, props]);

  const current = cu.current;
  const next = cu.next;

  // Read only the current and next card, one batched read per kind; nothing
  // waits on it (the card keeps its footprint with Bone rows meanwhile).
  useEffect(() => {
    const want = [current, next].filter(
      (item): item is CatchUpItem => item !== null && !requestedRef.current.has(item.key),
    );
    if (want.length === 0) return;
    for (const item of want) requestedRef.current.add(item.key);
    void readCatchUpBodies(supabase, {
      workspaceId,
      items: want,
      side,
      zone: props.timeZone ?? null,
    }).then((got) => {
      mark('catch-up:card-read');
      setBodies((prev) => {
        const out = new Map(prev);
        for (const [key, body] of got) out.set(key, body);
        return out;
      });
    });
  }, [current, next, workspaceId, side, props.timeZone, retryTick]);

  // A gone, hidden or already-read card is skipped silently (never an empty card).
  const currentBody = current !== null ? bodies.get(current.key) : undefined;
  useEffect(() => {
    if (current !== null && currentBody === 'skip') cu.skip(current.key);
  }, [current, currentBody, cu]);

  // The thread tip: on cards whose rows open threads, never while typing;
  // counted once per catch-up open, never per card render.
  const tipShown = tipOn && typeof currentBody === 'object' && currentBody.threads && !typing;
  useEffect(() => {
    if (!tipShown || tipNotedRef.current) return;
    tipNotedRef.current = true;
    noteThreadTipShown(currentUserId);
  }, [tipShown, currentUserId]);
  const dropTip = (): void => {
    setTipOn(false);
    dismissThreadTip(currentUserId);
  };

  // A new card rests unmoved (drop the last card's held fly-out pose), then settles in.
  useLayoutEffect(() => {
    playedRef.current?.cancel();
    playedRef.current = null;
    setTint(null);
    if (cu.index > 0) {
      mark('catch-up:card-change');
      itemIn(cardRef.current);
    }
  }, [cu.index]);

  /** Fly the card out (from `fromDx` for a swipe, 0 for a button), then decide. */
  const go = useCallback(
    (decision: 'read' | 'keep', fromDx = 0): void => {
      if (flying || current === null) return;
      setFlying(true);
      setTint(decision);
      const body = bodies.get(current.key);
      const latest =
        body !== undefined && body !== 'skip' && body !== 'error' ? body.latestReplyId : null;
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
    [flying, current, bodies, cu],
  );

  // A new card starts with an empty box (the old card's draft stays behind).
  useEffect(() => setDraft(EMPTY_DRAFT), [current?.key]);

  // The thread: on a phone a full-screen window over the card (12 Nov 2026,
  // Slack way: no scrim, starts at the top, the keyboard stays down until the
  // box is tapped; Reply from the long-press sheet focuses the box); on a
  // laptop the sheet as before, its field focused. It paints at once (Bone
  // rows); focus lands in the same tap (iOS opens the keyboard only then).
  const openThread = useCallback(
    (
      root: CatchUpMessageRow,
      kind: 'chat' | 'comment' | 'plan',
      target: CatchUpReplyTarget,
      focus = false,
    ): void => {
      if (current === null) return;
      flushSync(() => setThread({ cardKey: current.key, root, kind, target, data: null }));
      if (laptop || focus) threadInputRef.current?.focus({ preventScroll: true });
      dropTip();
      void readCatchUpThread(supabase, {
        workspaceId,
        kind,
        root,
        channelId:
          current.kind === 'chat-main' || current.kind === 'chat-thread' ? current.entityId : null,
      }).then((data) =>
        setThread((prev) =>
          prev !== null && prev.root.id === root.id ? { ...prev, data: data ?? 'error' } : prev,
        ),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, workspaceId, laptop],
  );
  // The window (phone) and the sheet (laptop) open and close in place.
  const closeThread = useCallback((then?: () => void): void => {
    setThread(null);
    then?.();
  }, []);
  // Phone system Back closes the window: one history step.
  useHistoryStep(!laptop && thread !== null, 'catchUpThread', () => closeThread());

  const retryThread = (): void => {
    if (thread === null) return;
    const { root, kind, target } = thread;
    openThread(root, kind, target);
  };

  // Where a tapped row's thread lives on the current card. A chat-thread card
  // has one thread: any row opens it (its root). Plan items and Bank ideas
  // read plan_item_comments replies and send through plan_item_comment_send.
  const openRowThread = (row: CatchUpMessageRow, focus = false): void => {
    if (current === null) return;
    const raw = bodies.get(current.key);
    const ready = raw !== undefined && raw !== 'skip' && raw !== 'error' ? raw : null;
    switch (current.kind) {
      case 'chat-main':
        openThread(
          row,
          'chat',
          { kind: 'chat', channelId: current.entityId, threadRootId: row.id },
          focus,
        );
        return;
      case 'chat-thread': {
        const root = ready?.cardRoot ?? row;
        openThread(
          root,
          'chat',
          {
            kind: 'chat',
            channelId: current.entityId,
            threadRootId: current.threadRootId ?? root.id,
          },
          focus,
        );
        return;
      }
      case 'post':
      case 'brief':
        openThread(
          row,
          'comment',
          {
            kind: 'comment',
            entityType: current.kind,
            entityId: current.entityId,
            parentCommentId: row.id,
          },
          focus,
        );
        return;
      default:
        openThread(
          row,
          'plan',
          { kind: 'plan-comment', itemId: current.entityId, parentCommentId: row.id },
          focus,
        );
    }
  };
  const openRowThreadRef = useRef(openRowThread);
  openRowThreadRef.current = openRowThread;

  // Keys: left Keep unread, right Mark as read (laptop); Escape closes the
  // menu (its own handler), then the thread, then catch up.
  const goRef = useRef(go);
  goRef.current = go;
  const closeRef = useRef(close);
  closeRef.current = close;
  const threadOpenRef = useRef(false);
  threadOpenRef.current = thread !== null;
  const closeThreadRef = useRef(closeThread);
  closeThreadRef.current = closeThread;
  const doneRef = useRef(cu.done);
  doneRef.current = cu.done;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        // A sheet or menu over the screen closes first.
        if (document.querySelector('[aria-modal="true"], [role="menu"]') !== null) return;
        event.preventDefault();
        if (threadOpenRef.current) closeThreadRef.current();
        else closeRef.current();
        return;
      }
      if (!laptop || doneRef.current || threadOpenRef.current) return;
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
    // A touch swipe ends with no click, so the flag would swallow the next
    // clean tap: every new press starts clear.
    swipedRef.current = false;
    if (flying || typing) return;
    const target = event.target;
    // A swipe may start on the rows' own tap areas (a message's text, a point);
    // never on the reply box, links, media or the card's other buttons.
    if (
      target instanceof Element &&
      (target.closest('form, a, textarea, input, video') !== null ||
        (target.closest('button') !== null &&
          target.closest('[data-catch-up-open-thread], [data-catch-up-point]') === null))
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      locked: false,
    };
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
    // The press was a swipe: the click it ends with opens nothing.
    swipedRef.current = true;
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
    kind: 'message',
    id,
    author: {
      id: currentUserId,
      name: personName(workspaceId, currentUserId) ?? props.selfName ?? 'You',
      avatarUrl: personAvatar(workspaceId, currentUserId),
    },
    createdAt: new Date().toISOString(),
    // As loaded rows read: a mention shows "@name", never the stored token.
    ...catchUpText(workspaceId, text),
    replyCount: 0,
    state: 'sending',
  });
  const setSentState = (sentKey: string, id: string, state: SentMessage['state']): void => {
    setSent((prev) => {
      const out = new Map(prev);
      out.set(
        sentKey,
        (out.get(sentKey) ?? []).map((m) => (m.id === id ? { ...m, state } : m)),
      );
      return out;
    });
  };
  const payloads = useRef(new Map<string, { send: CatchUpSend; target: CatchUpReplyTarget }>());
  const deliver = (sentKey: string, id: string): void => {
    const payload = payloads.current.get(id);
    if (payload === undefined) return;
    const { send, target } = payload;
    const traceId = generateTraceId();
    const files = [
      ...send.attachmentAssetIds,
      ...(send.voice !== null ? [send.voice.assetId] : []),
    ];
    const outcome: Promise<boolean> =
      target.kind === 'chat'
        ? sendMessageRecord({
            client: supabase,
            id,
            channelId: target.channelId,
            traceId,
            body: send.text,
            attachmentAssetIds: files,
            replyToMessageId: target.threadRootId,
            // A voice note reads back as a voice bubble (type, length, waveform).
            ...(send.voice !== null
              ? {
                  attachmentMeta: {
                    [send.voice.assetId]: {
                      mime: send.voice.mime ?? 'audio/mp4',
                      name: send.voice.name ?? 'Voice note',
                      size: send.voice.size ?? 0,
                      duration_ms: send.voice.durationMs,
                      ...(send.voice.peaks !== undefined ? { peaks: send.voice.peaks } : {}),
                    },
                  },
                }
              : {}),
          }).then((res) => res.ok)
        : target.kind === 'comment'
          ? createComment(supabase, {
              workspace_id: workspaceId,
              entity_type: target.entityType,
              entity_id: target.entityId,
              parent_comment_id: target.parentCommentId,
              body: send.text,
              ...(files.length > 0 ? { attachment_asset_ids: files } : {}),
              trace_id: traceId,
            }).then((res) => res.ok)
          : // Plan item and Bank idea: a main comment or a reply in its thread.
            sendPlanComment(supabase, {
              itemId: target.itemId,
              parentId: target.parentCommentId,
              body: send.text,
              visibility: 'everyone',
              attachmentVersionIds: [],
              traceId,
            }).then((res) => res.ok);
    void outcome.then((ok) => {
      if (!ok) logger.warn('catch-up: reply not sent', { trace_id: traceId, key: sentKey });
      setSentState(sentKey, id, ok ? 'sent' : 'failed');
    });
  };
  const send = (sentKey: string, target: CatchUpReplyTarget, payload: CatchUpSend): void => {
    const id = newMessageId();
    const message = selfMessage(id, payload.text);
    payloads.current.set(id, { send: payload, target });
    setSent((prev) => {
      const out = new Map(prev);
      out.set(sentKey, [...(out.get(sentKey) ?? []), message]);
      return out;
    });
    deliver(sentKey, id);
  };
  const retrySend = (sentKey: string, id: string): void => {
    setSentState(sentKey, id, 'sending');
    deliver(sentKey, id);
  };

  const loadOlder = (item: CatchUpItem): void => {
    if (olderBusyRef.current.has(item.key)) return;
    const body = bodies.get(item.key);
    if (body === undefined || body === 'skip' || body === 'error') return;
    const have = older.get(item.key);
    if (have !== undefined && !have.hasOlder) return;
    const first = have?.rows[0] ?? body.rows[0];
    if (first === undefined) return;
    olderBusyRef.current.add(item.key);
    void readCatchUpOlder(supabase, { workspaceId, item, beforeAt: first.createdAt, side }).then(
      (got) => {
        olderBusyRef.current.delete(item.key);
        if (got === null) return;
        setOlder((prev) => {
          const out = new Map(prev);
          out.set(item.key, {
            rows: [...got.rows, ...(prev.get(item.key)?.rows ?? [])],
            hasOlder: got.hasOlder,
          });
          return out;
        });
      },
    );
  };

  const retryLoad = (item: CatchUpItem): void => {
    requestedRef.current.delete(item.key);
    setBodies((prev) => {
      const out = new Map(prev);
      out.delete(item.key);
      return out;
    });
    setRetryTick((n) => n + 1);
  };

  const hideKeyboard = (): void => {
    inputRef.current?.blur();
    threadInputRef.current?.blur();
    setTyping(false);
  };
  const typingRead = (): void => {
    inputRef.current?.blur();
    threadInputRef.current?.blur();
    go('read');
  };

  const allRead = useLongPress(() => cu.markAll(), { ignoreMouse: true });

  const phoneTyping = typing && !laptop;
  const inThread = thread !== null && current !== null && thread.cardKey === current.key;

  const menuFor = (
    item: CatchUpItem,
    body: CatchUpBody | null,
  ): { title: string; items: ActionMenuItem[] } => {
    const href = entityHref(item.lead, props.workspaceKey ?? null, side);
    const title = body?.title ?? item.lead.title ?? item.lead.chatName ?? '';
    const items: ActionMenuItem[] =
      href === null
        ? []
        : [
            {
              id: 'open',
              label: openLabel(item.kind),
              icon: IconArrowUpRight,
              onSelect: () => props.onOpenPlace(href),
            },
            {
              id: 'copy-link',
              label: 'Copy link',
              icon: IconLink,
              onSelect: () => {
                void copyText(`${window.location.origin}${href}`).then((ok) =>
                  toastRef.current?.show(
                    ok
                      ? { title: 'Link copied' }
                      : { title: errorText('copy the link', null), tone: 'error' },
                  ),
                );
              },
            },
          ];
    return { title, items };
  };

  // Undo only after a decision on a card in this session, inside its window;
  // never before the first decision, after the undo, while typing or in a thread.
  const undoShown = cu.canUndo && !phoneTyping && !inThread;
  const bar = (
    <div data-catch-up-bar="" className={cn(CATCH_UP_BAR_CLASS, laptop && 'pt-0')}>
      <IconButton
        label="Close catch up"
        buttonRef={backRef}
        data-catch-up-back=""
        onClick={close}
        className={CATCH_UP_ROUND_KEY}
      >
        <IconChevronLeft size={ICON_SIZE.control} />
      </IconButton>
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center text-center">
        <Text role="heading" as="h1" data-catch-up-left="" className="truncate font-semibold">
          {cu.done ? '' : leftLabel(cu.left)}
        </Text>
      </div>
      <IconButton
        label={UNDO}
        data-catch-up-undo=""
        disabled={!undoShown}
        aria-hidden={!undoShown || undefined}
        tabIndex={undoShown ? 0 : -1}
        onClick={cu.undo}
        // Hidden keeps its slot (invisible) so "{n} left" stays centred.
        className={cn(CATCH_UP_ROUND_KEY, !undoShown && 'invisible')}
      >
        <IconReply size={ICON_SIZE.nav} />
      </IconButton>
    </div>
  );

  function menuTitle(): string {
    if (current === null) return '';
    const body = bodies.get(current.key);
    return body !== undefined && body !== 'skip' && body !== 'error'
      ? body.title
      : (current.lead.title ?? current.lead.chatName ?? '');
  }

  let body: ReactElement;
  if (cu.done) {
    body = <CatchUpEnd wentThrough={cu.wentThrough} onDone={close} />;
  } else if (current === null) {
    body = <div className="flex-1" />;
  } else {
    const key = current.key;
    const raw = bodies.get(key);
    const ready = raw !== undefined && raw !== 'skip' && raw !== 'error' ? raw : null;
    const inCardThread = cardThreadTarget(current, ready);
    const cardTarget = inCardThread ?? cardReplyTarget(current);
    const threadKey = thread !== null ? `${key}#${thread.root.id}` : key;
    const replyFor = (target: CatchUpReplyTarget, sentKey: string, hint: string): ReactElement => (
      <CatchUpReply
        key={sentKey}
        hint={hint}
        mode={target.kind === 'chat' ? 'chat' : 'comment'}
        laptop={laptop}
        workspaceId={workspaceId}
        target={target}
        onSend={(payload) => send(sentKey, target, payload)}
        onFocusChange={setTyping}
        inputRef={sentKey !== key ? threadInputRef : inputRef}
        draft={boxDraft(sentKey !== key, inThread, draft)}
        onDraftChange={(sentKey !== key) === inThread ? setDraft : undefined}
      />
    );
    const decide = (decision: 'keep' | 'read'): void => {
      if (inThread) closeThread(() => goRef.current(decision));
      else go(decision);
    };
    body = (
      <>
        <div
          className={cn('flex min-h-0 flex-1 flex-col pb-3 pt-1', CATCH_UP_EDGE)}
          aria-hidden={inThread || undefined}
        >
          <CatchUpCard
            key={key}
            item={current}
            body={withOlder(raw, older.get(key)?.hasOlder)}
            older={older.get(key)?.rows ?? []}
            sent={sent.get(key) ?? []}
            selfName={props.selfName}
            timeZone={props.timeZone}
            laptop={laptop}
            tint={tint}
            typing={phoneTyping ? { onHideKeyboard: hideKeyboard, onRead: typingRead } : null}
            menu={menuFor(current, ready)}
            reply={replyFor(
              cardTarget,
              key,
              replyHint(
                current,
                inCardThread !== null,
                targetRootOf(ready, inCardThread)?.author.name ?? null,
              ),
            )}
            tip={
              tipShown
                ? { text: tipText(wordsFamily(current.kind), laptop), onDismiss: dropTip }
                : null
            }
            onHoldMessage={(row, from, reactions) =>
              actions.hold({ item: current, row, reactions }, from)
            }
            onRetrySend={(id) => retrySend(key, id)}
            onRetryLoad={() => retryLoad(current)}
            onOpenThread={(root) => openRowThread(root)}
            onOpenPoint={(pointId, row) => {
              if (row.kind !== 'points') return;
              const point = row.points.find((p) => p.id === pointId);
              if (point === undefined) return;
              openThread(
                {
                  kind: 'message',
                  id: point.id,
                  author: row.author,
                  createdAt: row.createdAt,
                  text: `${point.n} · ${point.text}`,
                  replyCount: point.replyCount,
                },
                'comment',
                {
                  kind: 'comment',
                  entityType: current.kind === 'brief' ? 'brief' : 'post',
                  entityId: current.entityId,
                  parentCommentId: point.id,
                },
              );
            }}
            onNearTop={() => loadOlder(current)}
            cache={cache}
            presignEnabled={presignEnabled}
            onOpenPicture={(pictures, index) => setLightbox({ pictures, index })}
            cardRef={cardRef}
            bodyRef={cardBodyRef}
            gesture={{
              onPointerDown,
              onPointerMove,
              onPointerUp: onPointerEnd,
              onPointerCancel: onPointerEnd,
              onClickCapture: (event) => {
                if (!swipedRef.current) return;
                swipedRef.current = false;
                event.preventDefault();
                event.stopPropagation();
              },
            }}
          />
        </div>
        {inThread && laptop ? (
          // Laptop: the scrim covers the whole page (the top bar too); a tap closes the sheet.
          <div
            aria-hidden="true"
            data-catch-up-scrim=""
            className="absolute inset-0 z-sticky bg-scrim"
            onClick={() => closeThread()}
          />
        ) : null}
        {inThread && !laptop && thread !== null ? (
          // Phone (12 Nov 2026, Slack way): a full-screen window over the card,
          // no scrim, no rounded top; "<" (and system Back) returns to the card.
          <div
            data-catch-up-thread-window=""
            className="absolute inset-0 z-nav flex flex-col bg-bg pb-[env(safe-area-inset-bottom)]"
          >
            {/* The same top bar as every thread (13 Nov 2026): "<", the title by place. */}
            <div className="shrink-0 pt-[var(--shell-safe-top,0px)]">
              <ThreadViewHeader
                title={threadTitle(current)}
                subtitle={menuTitle()}
                onBack={() => closeThread()}
                backLabel="Back to the card"
                backData={{ 'data-catch-up-thread-back': '' }}
              />
            </div>
            <CatchUpThreadView
              root={thread.root}
              thread={thread.data}
              sent={sent.get(threadKey) ?? []}
              selfName={props.selfName}
              timeZone={props.timeZone}
              reply={replyFor(
                thread.target,
                threadKey,
                replyHint(current, true, thread.root.author.name),
              )}
              onRetryLoad={retryThread}
              onRetrySend={(id) => retrySend(threadKey, id)}
              reactionsOf={current}
              actions={actions.rootActions({ item: current, row: thread.root })}
              onHold={(row, from, reactions) =>
                actions.hold({ item: current, row, reactions, inThread: true }, from)
              }
            />
          </div>
        ) : null}
        <div
          ref={threadRef}
          data-catch-up-thread-sheet={inThread && laptop ? '' : undefined}
          className={
            inThread && laptop
              ? 'catch-up-card absolute inset-x-0 bottom-0 top-16 z-nav flex flex-col rounded-t-2xl border-t'
              : 'contents'
          }
        >
          {inThread && laptop && thread !== null ? (
            <>
              {/* The same top bar as every thread (13 Nov 2026). */}
              <div className="shrink-0">
                <ThreadViewHeader
                  title={threadTitle(current)}
                  subtitle={menuTitle()}
                  onBack={() => closeThread()}
                  backLabel="Back to the card"
                  backData={{ 'data-catch-up-thread-back': '' }}
                />
              </div>
              <CatchUpThreadView
                root={thread.root}
                thread={thread.data}
                sent={sent.get(threadKey) ?? []}
                selfName={props.selfName}
                timeZone={props.timeZone}
                reply={replyFor(
                  thread.target,
                  threadKey,
                  replyHint(current, true, thread.root.author.name),
                )}
                onRetryLoad={retryThread}
                onRetrySend={(id) => retrySend(threadKey, id)}
                reactionsOf={current}
                actions={actions.rootActions({ item: current, row: thread.root })}
                onHold={(row, from, reactions) =>
                  actions.hold({ item: current, row, reactions, inThread: true }, from)
                }
              />
            </>
          ) : null}
          {!phoneTyping && (laptop || !inThread) ? (
            <div
              data-catch-up-actions=""
              className={cn(
                'grid shrink-0 grid-cols-2 gap-4 pb-[max(16px,env(safe-area-inset-bottom))]',
                CATCH_UP_EDGE,
              )}
            >
              <Button
                type="button"
                variant="secondary"
                data-catch-up-keep=""
                className="h-12"
                disabled={flying}
                onClick={() => decide('keep')}
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
                variant="primary"
                data-catch-up-read=""
                className="h-12"
                disabled={flying}
                {...allRead.handlers}
                onContextMenu={(event) => event.preventDefault()}
                onClick={() => {
                  if (allRead.consumeClickSuppression()) return;
                  decide('read');
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
        </div>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Catch up"
      data-catch-up=""
      className={cn(
        'fixed inset-0 z-sheet flex',
        laptop ? 'items-center justify-center p-4' : 'h-dvh flex-col',
      )}
    >
      {laptop ? <Backdrop aria-label="Close catch up" onClick={close} /> : null}
      <div
        ref={boxRef}
        data-catch-up-box=""
        className={cn(
          'catch-up-page relative flex min-h-0 flex-col',
          laptop
            ? 'h-catch-up max-h-full w-catch-up max-w-full overflow-hidden rounded-2xl lit-overlay'
            : 'flex-1',
        )}
      >
        {bar}
        {body}
      </div>
      {actions.layer}
      {lightbox !== null ? (
        <ImageLightbox
          images={lightbox.pictures.map((id, i) => ({ assetId: id, name: `Picture ${i + 1}` }))}
          index={lightbox.index}
          cache={cache}
          presignEnabled={presignEnabled}
          onIndexChange={(index) =>
            setLightbox((prev) => (prev !== null ? { ...prev, index } : prev))
          }
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
