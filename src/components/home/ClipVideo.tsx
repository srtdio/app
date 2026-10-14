import type { Clip } from './media';
import { useClipPlayer } from './useClipPlayer';

interface ClipVideoProps {
  clip: Clip;
  label: string;
  className?: string;
}

/** Muted looping clip with the prototype's 44x44 pause/play button. */
export function ClipVideo({ clip, label, className }: ClipVideoProps) {
  const { videoRef, held, toggle } = useClipPlayer();
  return (
    <>
      <video
        ref={videoRef}
        className={className}
        poster={clip.poster}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
      >
        <source src={clip.src} type="video/mp4" />
      </video>
      <button
        className={held ? 'clip-btn paused' : 'clip-btn'}
        type="button"
        aria-label={held ? 'Play animation' : 'Pause animation'}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path className="ps" d="M9 6v12M15 6v12" />
          <path className="pl" d="M8 5.5l11 6.5-11 6.5z" />
        </svg>
      </button>
    </>
  );
}
