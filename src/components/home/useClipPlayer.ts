import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { readAutoplayEnv, shouldAutoplay } from './autoplay';

// A video plays only while at least this share of it is on screen.
const VISIBLE_RATIO = 0.4;

export interface ClipPlayer {
  videoRef: RefObject<HTMLVideoElement>;
  /** True when the viewer (or the autoplay rules) has the clip on hold. */
  held: boolean;
  toggle: () => void;
}

function play(video: HTMLVideoElement): void {
  const pending = video.play();
  // A rejected play (autoplay policy, detached element) just leaves the poster.
  void pending.catch(() => undefined);
}

/**
 * One hook for every homepage video: muted loops that play while at least 40%
 * visible and pause otherwise. Reduced motion, Save-Data and slow connections
 * start on hold (poster plus play button). The button toggles the hold.
 */
export function useClipPlayer(): ClipPlayer {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [held, setHeld] = useState(() => !shouldAutoplay(readAutoplayEnv()));
  const heldRef = useRef(held);

  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      if (!heldRef.current) play(video);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
          if (visible && !heldRef.current) play(video);
          else if (!visible) video.pause();
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

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      heldRef.current = false;
      setHeld(false);
      play(video);
    } else {
      heldRef.current = true;
      setHeld(true);
      video.pause();
    }
  }, []);

  return { videoRef, held, toggle };
}
