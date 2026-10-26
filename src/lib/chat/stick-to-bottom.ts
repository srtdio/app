/**
 * Stick-to-bottom for the chat thread (WhatsApp behaviour), as pure decisions
 * the thread wires to its events, observers and refs. The thread keeps an
 * INTENT to stay on the latest message rather than asking "is it at the bottom
 * now": only the reader's own gestures change it, so late growth (cards, marks,
 * badges, fonts, the composer) re-pins while it holds and never yanks a reader
 * who scrolled up to read history.
 */
import { NEAR_BOTTOM_THRESHOLD_PX } from '@/lib/chat/scroll';
import type { MessageState } from '@/lib/chat/thread';

/** The scroll geometry of the thread list. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Who moved the list last: 'user' after a touch, wheel, scroll key or scrollbar
 * press; 'program' once the thread itself scrolls (a pin, a jump, the
 * older-page restore), whose scroll events never change the intent.
 */
export type ScrollSource = 'user' | 'program';

/** The unseen px below the fold; 0 when pinned to the latest message. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/**
 * The intent after a scroll event: a user gesture that leaves the view more
 * than 120px from the bottom lets go, one within 120px takes hold again; a
 * programmatic scroll keeps whatever it was.
 */
export function intentAfterScroll(input: {
  intent: boolean;
  source: ScrollSource;
  distanceFromBottom: number;
}): boolean {
  if (input.source === 'program') return input.intent;
  return input.distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
}

/**
 * How long the list must go without a scroll event, after the finger lifts,
 * before a flick counts as settled (momentum scrolling has stopped).
 */
export const SCROLL_SETTLE_MS = 150;

/**
 * Whether a touch flick is still moving the list: a finger is down, or a scroll
 * event from the touch gesture landed within the last {@link SCROLL_SETTLE_MS}
 * (momentum after touchend). `msSinceTouchScroll` is null once settled.
 */
export function flickInProgress(input: {
  touching: boolean;
  msSinceTouchScroll: number | null;
}): boolean {
  if (input.touching) return true;
  return input.msSinceTouchScroll !== null && input.msSinceTouchScroll < SCROLL_SETTLE_MS;
}

/**
 * What a change in content height or list height does: pin to the bottom while
 * the intent holds, unless a pending jump owns the position or an older page is
 * being restored under the reader. During a flick a pin would fight the finger
 * or the momentum, so it defers until the scroll settles.
 */
export function sizeChangeAction(input: {
  intent: boolean;
  pendingJump: boolean;
  olderPageRestore: boolean;
  flicking: boolean;
}): 'pin' | 'leave' | 'defer' {
  if (input.pendingJump || input.olderPageRestore) return 'leave';
  if (!input.intent) return 'leave';
  return input.flicking ? 'defer' : 'pin';
}

/**
 * The decision once a deferred flick settles: the settled position is the
 * reader's (a user scroll), so within 120px of the bottom the intent holds and
 * the list pins; further up it lets go. `restoring` is a pending jump or an
 * older-page restore, which still own the position.
 */
export function settleDecision(input: {
  intent: boolean;
  distanceFromBottom: number;
  restoring: boolean;
}): { intent: boolean; action: 'pin' | 'leave' } {
  const intent = intentAfterScroll({
    intent: input.intent,
    source: 'user',
    distanceFromBottom: input.distanceFromBottom,
  });
  const action = sizeChangeAction({
    intent,
    pendingJump: input.restoring,
    olderPageRestore: false,
    flicking: false,
  });
  return { intent, action: action === 'pin' ? 'pin' : 'leave' };
}

/**
 * Whether the older-page anchor still holds once a load ends: a load that
 * brought no rows or failed (the flag went false with the messages unchanged)
 * lets go, so size-change pinning works again. A load that changed the
 * messages is restored by the new-rows pass, which clears the anchor itself.
 */
export function anchorAfterOlderLoad(input: {
  anchored: boolean;
  loadEnded: boolean;
  messagesChanged: boolean;
}): boolean {
  if (!input.anchored) return false;
  return !(input.loadEnded && !input.messagesChanged);
}

/**
 * The intent when the newest message changes: an own send from THIS device
 * (still in this device's outbox: 'sending' or 'failed') always takes hold
 * again (the reader wants to see it land); anything else, own messages from
 * another device included, keeps the intent.
 */
export function intentAfterNewest(input: {
  intent: boolean;
  newest: { id: string; mine: boolean; state: MessageState } | undefined;
  previousNewestId: string | null;
}): boolean {
  const newest = input.newest;
  if (newest === undefined || newest.id === input.previousNewestId) return input.intent;
  return sentFromThisDevice(newest) ? true : input.intent;
}

/**
 * An own message this device is sending: the outbox renders it 'sending' (or
 * 'failed' with Retry) before the server records it; a message by the same
 * user from another device arrives already 'sent'.
 */
export function sentFromThisDevice(message: { mine: boolean; state: MessageState }): boolean {
  return message.mine && message.state !== 'sent';
}

/**
 * What the new-rows pass does: nothing when the intent has let go; an own send
 * from this device pins at once (even mid-flick: the reader just sent it);
 * anything else (an incoming message, a status re-render) never pins while a
 * flick is moving the list and defers to the settle instead.
 */
export function newRowsAction(input: {
  intent: boolean;
  flicking: boolean;
  ownLocalSend: boolean;
}): 'pin' | 'defer' | 'leave' {
  if (!input.intent) return 'leave';
  if (input.ownLocalSend) return 'pin';
  return input.flicking ? 'defer' : 'pin';
}

/** The slice of Window the touch-end listeners use. */
interface TouchEndTarget {
  addEventListener: (type: 'touchend' | 'touchcancel', listener: () => void) => void;
  removeEventListener: (type: 'touchend' | 'touchcancel', listener: () => void) => void;
}

/**
 * Listen for the end of every touch on the window, not the list: a row
 * removed under the finger (a tombstone, a re-grouped run) takes its touchend
 * with it, which would leave the flick "touching" forever and freeze
 * auto-follow. Returns the teardown (both listeners removed).
 */
export function listenTouchEnd(target: TouchEndTarget, onEnd: () => void): () => void {
  const listener = (): void => onEnd();
  target.addEventListener('touchend', listener);
  target.addEventListener('touchcancel', listener);
  return () => {
    target.removeEventListener('touchend', listener);
    target.removeEventListener('touchcancel', listener);
  };
}

/** A thread opens holding the bottom, before any gesture. */
export function openingIntent(): boolean {
  return true;
}

/** Keys that scroll a focused list: arrows, pages, Home / End and Space. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/** Whether a keydown on the list is a scroll gesture. */
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}
