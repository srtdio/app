import type { Clip } from './media';
import { useClipPlayer } from './useClipPlayer';

interface ClipVideoProps {
  clip: Clip;
  label: string;
  className?: string;
  /** Default true. A rail clip plays once so the rail can move on when it ends. */
  loop?: boolean;
  /** While true the clip stays paused, even on screen. */
  held?: boolean;
  onEnded?: () => void;
}

/**
 * Muted clip that plays by itself, no controls, like an animation.
 * It stays transparent over its container's fill until a frame is decoded,
 * so a blank video box never paints.
 */
export function ClipVideo({
  clip,
  label,
  className,
  loop = true,
  held = false,
  onEnded,
}: ClipVideoProps) {
  const { videoRef, ready, preload } = useClipPlayer(held);
  return (
    <video
      ref={videoRef}
      className={className}
      data-clip={ready ? 'ready' : 'pending'}
      muted
      loop={loop}
      playsInline
      preload={preload}
      disablePictureInPicture
      disableRemotePlayback
      aria-label={label}
      onEnded={onEnded}
    >
      <source src={clip.src} type="video/mp4" />
    </video>
  );
}
