import { useEffect, useRef, type RefObject } from 'react';
import { readAutoplayEnv, shouldAutoplay } from './autoplay';

// A video plays only while at least this share of it is on screen.
const VISIBLE_RATIO = 0.4;

function play(video: HTMLVideoElement): void {
  const pending = video.play();
  // A rejected play (autoplay policy, iOS Low Power Mode) just leaves the poster.
  void pending.catch(() => undefined);
}

/**
 * One hook for every homepage video: muted loops that play on their own while
 * at least 40% visible, with no controls, so they read as animation. Off-screen
 * clips pause to save data and battery; reduced motion keeps the poster.
 */
export function useClipPlayer(): RefObject<HTMLVideoElement> {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !shouldAutoplay(readAutoplayEnv())) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      play(video);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) play(video);
          else video.pause();
        }
      },
      { threshold: [0, VISIBLE_RATIO] },
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, []);

  return videoRef;
}
