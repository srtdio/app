import { useEffect, useRef, useState, type RefObject } from 'react';

// A video plays only while at least this share of it is on screen.
const VISIBLE_RATIO = 0.4;

// Any of these counts as a user gesture, which lifts browser autoplay blocks
// (for example iOS Low Power Mode) for every clip on the page.
const GESTURES = ['pointerdown', 'touchstart', 'keydown'] as const;

// HAVE_CURRENT_DATA: a frame at the current position is decoded and paintable.
const HAVE_CURRENT_DATA = 2;

export type ClipPreload = 'auto' | 'metadata';

/**
 * The active card and its immediate neighbours load fully so the next card
 * already has a decoded frame when it comes forward; every other card loads
 * metadata only.
 */
export function preloadFor(index: number, active: readonly number[]): ClipPreload {
  return active.some((a) => Math.abs(a - index) <= 1) ? 'auto' : 'metadata';
}

interface StackMember {
  index: number;
  visible: boolean;
  setPreload: (preload: ClipPreload) => void;
}

interface Stack {
  members: Set<StackMember>;
  // Last cards seen active; kept while none is visible so the stack stays
  // warm around where the visitor left it. Starts on the first card.
  active: number[];
}

const stacks = new WeakMap<Element, Stack>();

function refreshStack(stack: Stack): void {
  const visible = [...stack.members].filter((m) => m.visible).map((m) => m.index);
  if (visible.length > 0) stack.active = visible;
  for (const member of stack.members) member.setPreload(preloadFor(member.index, stack.active));
}

/**
 * Joins the card stack the video sits in (its `.card` and that card's
 * siblings). A clip outside a card stack is its own stack: fully loaded while
 * on screen at all, metadata only otherwise, so a clip hidden by a breakpoint
 * never downloads.
 */
function joinStack(
  video: HTMLVideoElement,
  setPreload: (preload: ClipPreload) => void,
): { setVisible: (visible: boolean, onScreen: boolean) => void; leave: () => void } {
  const card = video.closest('.card');
  const parent = card?.parentElement;
  if (!card || !parent) {
    return {
      setVisible: (_visible, onScreen) => setPreload(onScreen ? 'auto' : 'metadata'),
      leave: () => undefined,
    };
  }
  let stack = stacks.get(parent);
  if (!stack) {
    stack = { members: new Set(), active: [0] };
    stacks.set(parent, stack);
  }
  const own = stack;
  const member: StackMember = {
    index: Array.prototype.indexOf.call(parent.children, card),
    visible: false,
    setPreload,
  };
  own.members.add(member);
  refreshStack(own);
  return {
    setVisible: (visible) => {
      if (member.visible === visible) return;
      member.visible = visible;
      refreshStack(own);
    },
    leave: () => {
      own.members.delete(member);
      if (own.members.size === 0) stacks.delete(parent);
    },
  };
}

export interface ClipPlayer {
  videoRef: RefObject<HTMLVideoElement>;
  /** True once a frame is decoded; the video stays hidden until then. */
  ready: boolean;
  preload: ClipPreload;
}

/**
 * One hook for every homepage video: muted loops that play on their own while
 * at least 40% visible, with no controls, so they read as animation. Off-screen
 * clips pause in place to save data and battery, and resume from the same
 * frame. If the browser refuses to autoplay, the clip starts on the visitor's
 * first tap, click or key press.
 *
 * The video is revealed only once it has a decoded frame, so an undecoded
 * (blank) video box is never shown.
 */
export function useClipPlayer(held = false): ClipPlayer {
  const videoRef = useRef<HTMLVideoElement>(null);
  const heldRef = useRef(held);
  const visibleRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [preload, setPreload] = useState<ClipPreload>('metadata');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    // Autoplay is only allowed for muted inline video; set it on the element
    // itself, not just through React props, before the first play().
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    const hasIO = typeof IntersectionObserver !== 'undefined';
    let visible = !hasIO;
    let waitingForGesture = false;

    const reveal = (): void => {
      if (video.readyState >= HAVE_CURRENT_DATA) setReady(true);
    };
    const media = ['loadeddata', 'canplay'] as const;
    for (const type of media) video.addEventListener(type, reveal);
    reveal();

    const onGesture = (): void => {
      stopWaiting();
      if (visible) play();
    };
    const stopWaiting = (): void => {
      if (!waitingForGesture) return;
      waitingForGesture = false;
      for (const type of GESTURES) window.removeEventListener(type, onGesture);
    };
    const waitForGesture = (): void => {
      if (waitingForGesture) return;
      waitingForGesture = true;
      for (const type of GESTURES) window.addEventListener(type, onGesture, { passive: true });
    };
    function play(): void {
      if (!video || heldRef.current) return;
      video.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') waitForGesture();
      });
    }

    const stack = joinStack(video, setPreload);
    const cleanup = (): void => {
      for (const type of media) video.removeEventListener(type, reveal);
      stack.leave();
      stopWaiting();
      // Pause in place: currentTime is left alone so the frame stays put.
      video.pause();
    };

    if (!hasIO) {
      visibleRef.current = true;
      stack.setVisible(true, true);
      play();
      return cleanup;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
          visibleRef.current = visible;
          stack.setVisible(visible, entry.isIntersecting);
          if (visible) play();
          else video.pause();
        }
      },
      { threshold: [0, VISIBLE_RATIO] },
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      cleanup();
    };
  }, []);

  // Held clips pause; a released clip resumes if it is on screen.
  useEffect(() => {
    heldRef.current = held;
    const video = videoRef.current;
    if (!video) return;
    if (held) video.pause();
    else if (visibleRef.current) video.play().catch(() => undefined);
  }, [held]);

  return { videoRef, ready, preload };
}
