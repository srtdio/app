// Catch up (9 Nov 2026, Slack's way): ONE card per ITEM over the app. Phone:
// full screen on the catch-up page tone, rising from the bottom (rise, 320).
// Laptop: a centred 640 window (max 85vh) over the backdrop (dialogIn, 200).
// Top bar (no hairline, no header shade, on the page tone): round 48 "<"
// (Close catch up; inside a thread: Back to the card), "{n} left" centred
// (heading), round 48 Undo (the curved arrow; invisible, not removed, when
// there is nothing to undo; hidden while typing and inside a thread). The
// bottom row: Keep unread (Button) | Mark as read (Main, ink, never green).
// The card swipes on X with a lean (never Y); the next card settles in. A
// tap on a message's text or its "N replies" pushes the thread in full screen
// and "<" returns to the exact card state (scroll kept). Escape closes the
// menu, then the thread, then catch up. The first card paints from what
// Activity holds; only the current and next card are read, batched, in the
// background. Read only: no edit, no resolve.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import {
  dialogIn,
  dialogOut,
  itemIn,
  pushBack,
  pushIn,
  riseIn,
  riseOut,
  type Played,
} from '@/lib/motion';
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
import { planItemCommentCreate } from '@srtdio/rpc';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { useCatchUp } from '@/lib/catch-up/use-catch-up';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import {
  readCatchUpBodies,
  readCatchUpOlder,
  readCatchUpThread,
  type CatchUpBody,
  type CatchUpBodyResult,
  type CatchUpMessageRow,
  type CatchUpRow,
  type CatchUpThread,
} from '@/lib/catch-up/body';
import type { CatchUpReplyTarget, CatchUpSend } from '@/lib/catch-up/types';
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
import { CatchUpReply } from '@/components/catch-up/CatchUpReply';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';

/** Move this far (px) before a press becomes a swipe (or a scroll, if it went up or down first). */
const SWIPE_START_PX = 10;

/** The bar: 64 tall under the safe area, on the page tone, no hairline and no shade. */
export const CATCH_UP_BAR_CLASS =
  'flex h-[calc(4rem+var(--shell-safe-top,0px))] shrink-0 items-center gap-2 px-3 pt-[var(--shell-safe-top,0px)]';

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
      return { kind: 'plan-comment', itemId: item.entityId };
  }
}

/** The reply box's hint. Pure. */
export function replyHint(item: CatchUpItem, inThread: boolean): string {
  if (inThread || item.kind === 'chat-thread') return 'Reply in thread';
  if (item.kind === 'chat-main')
    return `Message ${item.lead.chatName ?? item.lead.actorName ?? 'chat'}`;
  return 'Reply';
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
  kind: 'chat' | 'comment';
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
  const cardScrollRef = useRef(0);
  const closingRef = useRef(false);

  useModalFocus(rootRef, true, { initial: () => backRef.current });

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

  // The thread: push in (X) on a phone, instant on a laptop; "<" pushes back.
  const openThread = useCallback(
    (root: CatchUpMessageRow, kind: 'chat' | 'comment', target: CatchUpReplyTarget): void => {
      if (current === null) return;
      cardScrollRef.current = cardBodyRef.current?.scrollTop ?? 0;
      setThread({ cardKey: current.key, root, kind, target, data: null });
      void readCatchUpThread(supabase, {
        workspaceId,
        kind,
        root,
        channelId: current.kind === 'chat-main' ? current.entityId : null,
      }).then((data) =>
        setThread((prev) =>
          prev !== null && prev.root.id === root.id ? { ...prev, data: data ?? 'error' } : prev,
        ),
      );
    },
    [current, workspaceId],
  );
  useLayoutEffect(() => {
    if (thread !== null && thread.data === null && !laptop) pushIn(threadRef.current);
    // Only when a thread opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.root.id]);
  const closeThread = useCallback((): void => {
    const finish = (): void => setThread(null);
    if (laptop) {
      finish();
      return;
    }
    const played = pushBack(threadRef.current);
    if (played.instant) finish();
    else void played.done.then(finish);
  }, [laptop]);
  // Back in the card: the exact scroll it had.
  useLayoutEffect(() => {
    if (thread === null && cardBodyRef.current !== null)
      cardBodyRef.current.scrollTop = cardScrollRef.current;
  }, [thread]);

  const retryThread = (): void => {
    if (thread === null) return;
    const { root, kind, target } = thread;
    openThread(root, kind, target);
  };

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
    text,
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
          : planItemCommentCreate(supabase, {
              p_item_id: target.itemId,
              p_body: send.text,
              p_visibility: 'everyone',
              p_trace_id: traceId,
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
    setTyping(false);
  };
  const typingRead = (): void => {
    inputRef.current?.blur();
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
  const barTitle = cu.done ? '' : inThread ? null : leftLabel(cu.left);
  const bar = (
    <div data-catch-up-bar="" className={cn(CATCH_UP_BAR_CLASS, laptop && 'pt-0')}>
      <IconButton
        label={inThread ? 'Back to the card' : 'Close catch up'}
        buttonRef={backRef}
        data-catch-up-back=""
        onClick={inThread ? closeThread : close}
        className={CATCH_UP_ROUND_KEY}
      >
        <IconChevronLeft size={ICON_SIZE.control} />
      </IconButton>
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center text-center">
        {barTitle !== null ? (
          <Text role="heading" as="h1" data-catch-up-left="" className="truncate font-semibold">
            {barTitle}
          </Text>
        ) : (
          <>
            <Text role="label" as="h1" data-catch-up-thread-title="">
              Thread
            </Text>
            <Text role="secondary" className="max-w-full truncate text-fg-3">
              {menuTitle()}
            </Text>
          </>
        )}
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
    const cardTarget = cardReplyTarget(current);
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
        inputRef={inputRef}
      />
    );
    body = (
      <>
        {inThread && thread !== null ? (
          <CatchUpThreadView
            viewRef={threadRef}
            root={thread.root}
            thread={thread.data}
            sent={sent.get(threadKey) ?? []}
            selfName={props.selfName}
            timeZone={props.timeZone}
            reply={replyFor(thread.target, threadKey, replyHint(current, true))}
            onRetryLoad={retryThread}
            onRetrySend={(id) => retrySend(threadKey, id)}
          />
        ) : null}
        <div
          className={cn('flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1', inThread && 'hidden')}
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
            reply={replyFor(cardTarget, key, replyHint(current, false))}
            onRetrySend={(id) => retrySend(key, id)}
            onRetryLoad={() => retryLoad(current)}
            onOpenThread={(root) =>
              openThread(
                root,
                current.kind === 'chat-main' ? 'chat' : 'comment',
                current.kind === 'chat-main'
                  ? { kind: 'chat', channelId: current.entityId, threadRootId: root.id }
                  : {
                      kind: 'comment',
                      entityType: current.kind === 'brief' ? 'brief' : 'post',
                      entityId: current.entityId,
                      parentCommentId: root.id,
                    },
              )
            }
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
        {!phoneTyping && !inThread ? (
          <div
            data-catch-up-actions=""
            className="grid shrink-0 grid-cols-2 gap-3 px-3 pb-[max(16px,env(safe-area-inset-bottom))]"
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
              variant="primary"
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
