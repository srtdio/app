import { useEffect, useRef, type RefObject } from 'react';

// A video plays only while at least this share of it is on screen.
const VISIBLE_RATIO = 0.4;

// Any of these counts as a user gesture, which lifts browser autoplay blocks
// (for example iOS Low Power Mode) for every clip on the page.
const GESTURES = ['pointerdown', 'touchstart', 'keydown'] as const;

/**
 * One hook for every homepage video: muted loops that play on their own while
 * at least 40% visible, with no controls, so they read as animation. Off-screen
 * clips pause to save data and battery. If the browser refuses to autoplay,
 * the clip starts on the visitor's first tap, click or key press.
 */
export function useClipPlayer(): RefObject<HTMLVideoElement> {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    // Autoplay is only allowed for muted inline video; set it on the element
    // itself, not just through React props, before the first play().
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    let visible = typeof IntersectionObserver === 'undefined';
    let waitingForGesture = false;

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
      if (!video) return;
      video.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') waitForGesture();
      });
    }

    if (visible) {
      play();
      return stopWaiting;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
          if (visible) play();
          else video.pause();
        }
      },
      { threshold: [0, VISIBLE_RATIO] },
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      stopWaiting();
      video.pause();
    };
  }, []);

  return videoRef;
}
