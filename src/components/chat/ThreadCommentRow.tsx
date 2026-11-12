// One comment row drawn by chat's own parts: chat's MessageRow wiring on chat's
// MessageBubble. Plan item threads (PlanItemThread) and post / brief comments
// (comments/Comments) both render through this one row, so a change to chat's
// bubble, swipe core or long-press reaches every comment surface with no
// second edit (CLAUDE.md "Work chat (Slack way)").
//
// Swipe right = the row's onReply (a plan comment focuses its box; a post
// comment opens its thread), swipe left = onDelete where wired (own post
// comments), else it rubber-bands. A hold (touch) or right-click (laptop),
// Enter / Space / Shift+F10, or the laptop chevron opens the menu. Pending and
// failed rows never swipe (chat's rule). Pure render: no reads.

import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { tintTarget } from '@/components/ui/SearchHighlight';
import { cancelPendingLongPressesWithin, useLongPress } from '@/components/ui/useLongPress';
import type { ChatLayout } from '@/components/chat/chat-type';
import {
  MessageBubble,
  createRowHold,
  isLinkTarget,
  paintRowSwipe,
  rowSwipeCanTrigger,
  swipeTapOpens,
  type BubbleMentions,
  type BubblePointerHandlers,
  type BubbleSwipe,
  type RowHold,
} from '@/components/chat/MessageBubble';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import type { ChatProfile } from '@/lib/chat-reads';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { createSwipeReplyController, type SwipeReplyController } from '@/lib/chat/swipe-reply';
import type { ThreadMessage } from '@/lib/chat/thread';
import { supabase } from '@/lib/supabase';
import { whoReactedFromRows } from '@/lib/reactions/reads';
import type { ReactionsApi } from '@/lib/reactions/use-reactions';

export interface ThreadCommentRowProps {
  message: ThreadMessage;
  head: boolean;
  tail: boolean;
  afterLabel: boolean;
  profiles: Map<string, ChatProfile>;
  workspaceId: string | null;
  me: string | null;
  layout: ChatLayout;
  highlighted: boolean;
  hoverMenu: boolean;
  coarsePointer: boolean;
  reducedMotion: boolean;
  personSource: (message: ThreadMessage) => PrivateReplyDraft | null;
  mentions: BubbleMentions;
  /** The menu (anchor: the bubble's rect; reactionsOnly: the laptop smiley). */
  onOpenMenu: (anchor: DOMRect | null, reactionsOnly?: boolean) => void;
  /** Swipe right; absent: a right swipe rubber-bands. */
  onReply: (() => void) | undefined;
  /** Swipe left (own rows that can be deleted); absent: a left swipe rubber-bands. */
  onDelete?: (() => void) | undefined;
  /** A tap on the body (not a link, picture, file, @name or "more"); absent: none. */
  onTapOpen?: (() => void) | undefined;
  onRetry: ((id: string) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  reactions: ReactionsApi;
  /** The thread view's places (chat's own); absent: the main list's row. */
  threadPlace?: 'root' | 'reply' | undefined;
  /** The head's time: 'clock' (default) or 'day' (a thread's rows say their day). */
  timeLabel?: 'clock' | 'day' | undefined;
  rowData?: { [hook: `data-${string}`]: string | undefined } | undefined;
  topLine?: ReactNode;
  bottomLine?: ReactNode;
}

export function ThreadCommentRow(props: ThreadCommentRowProps): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const deleteIconRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const swipeIconShownRef = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const bubbleRect = (): DOMRect | null => bubbleRef.current?.getBoundingClientRect() ?? null;
  const swipeRef = useRef<SwipeReplyController | null>(null);
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => rowHold.hold(),
    { ignoreMouse: true },
  );
  const open = (anchor: DOMRect | null): void => {
    clearClickSuppression();
    latest.current.onOpenMenu(anchor);
  };
  const rowHoldRef = useRef<RowHold | null>(null);
  rowHoldRef.current ??= createRowHold({
    selection: () => undefined,
    coarse: () => latest.current.coarsePointer,
    openMenu: () => open(bubbleRect()),
    cancelTimer: () => cancel(),
    cancelSwipe: () => swipeRef.current?.cancel(),
    swiping: () => swipeRef.current?.swiping() === true,
  });
  const rowHold = rowHoldRef.current;
  swipeRef.current ??= createSwipeReplyController({
    direction: 'both',
    // A tap that rolled sideways locked as a swipe: it still opens the thread.
    onTap: (target) => {
      const tapOpen = latest.current.onTapOpen;
      if (tapOpen !== undefined && swipeTapOpens(target, bubbleRef.current)) tapOpen();
    },
    onReply: () => latest.current.onReply?.(),
    onLeft: () => latest.current.onDelete?.(),
    canTrigger: (side) => {
      const p = latest.current;
      const wired = side === 'right' ? p.onReply !== undefined : p.onDelete !== undefined;
      const ok =
        wired && rowSwipeCanTrigger(side, p.message, () => latest.current.onDelete !== undefined);
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
      cancel();
      const scope = rowRef.current ?? bubbleRef.current;
      if (scope !== null) cancelPendingLongPressesWithin(scope);
      window.getSelection()?.removeAllRanges();
      if (pointerId === undefined) return;
      try {
        scope?.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone; the gesture ends on its own.
      }
    },
    enabled: () => latest.current.message.state === 'sent',
    reducedMotion: () => latest.current.reducedMotion,
  });
  const swipe = swipeRef.current;
  useEffect(() => () => swipe.dispose(), [swipe]);
  // A deep link's arrival: chat's jump tint on the row (after paint, no read on paint).
  useEffect(() => {
    const row = rowRef.current;
    if (!props.highlighted || row === null) return;
    return tintTarget(row);
  }, [props.highlighted]);
  const pointer: BubblePointerHandlers = {
    onPointerDown: (e) => {
      rowHold.pointerDown();
      if (!isLinkTarget(e.target)) handlers.onPointerDown(e);
    },
    onPointerMove: (e) => handlers.onPointerMove(e),
    onPointerUp: () => handlers.onPointerUp(),
    onPointerCancel: () => handlers.onPointerCancel(),
  };
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
  const id = props.message.id;
  return (
    <MessageBubble
      message={props.message}
      profiles={props.profiles}
      cache={sharedCardPresignCache()}
      presignEnabled={PRESIGN_ENABLED}
      showTicks={false}
      isGroup
      head={props.head}
      tail={props.tail}
      afterLabel={props.afterLabel}
      layout={props.layout}
      viewerUserId={props.me ?? undefined}
      mentions={props.mentions}
      workspaceId={props.workspaceId}
      personSource={props.personSource}
      bubbleRef={bubbleRef}
      rowRef={rowRef}
      swipe={rowSwipeRef.current}
      threadPlace={props.threadPlace}
      timeLabel={props.timeLabel}
      rowData={props.rowData}
      onTapOpen={props.onTapOpen}
      {...(props.topLine !== undefined ? { topLine: props.topLine } : {})}
      {...(props.bottomLine !== undefined ? { bottomLine: props.bottomLine } : {})}
      press={{
        handlers: pointer,
        onContextMenu: rowHold.contextMenu,
        consumeClick: () => {
          const held = consumeClickSuppression();
          const swiped = swipe.consumeClickSuppression();
          return held || swiped;
        },
        coarse: props.coarsePointer,
        onKeyOpen: () => open(bubbleRect()),
        ...(props.hoverMenu
          ? {
              onMore: () => open(bubbleRect()),
              onReact: () => {
                clearClickSuppression();
                latest.current.onOpenMenu(bubbleRect(), true);
              },
            }
          : {}),
      }}
      {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      {...(props.onDiscard !== undefined ? { onDiscard: props.onDiscard } : {})}
      reactionChips={{
        onToggle: (emoji) => props.reactions.toggle(id, emoji),
        onPick: (emoji) => props.reactions.pick(id, emoji),
        who: {
          targetId: id,
          viewerId: props.me,
          load: () =>
            whoReactedFromRows(supabase, {
              rows: props.reactions.rowsOf(id),
              workspaceId: props.workspaceId,
              known: (uid) => props.profiles.get(uid),
            }),
        },
      }}
    />
  );
}
