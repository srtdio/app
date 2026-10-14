import type { Clip } from './media';
import { useClipPlayer } from './useClipPlayer';

interface ClipVideoProps {
  clip: Clip;
  label: string;
  className?: string;
}

/**
 * Muted looping clip that plays by itself, no controls, like an animation.
 * It stays transparent over its container's fill until a real frame is
 * decoded. No poster: the browser would show it in place of the decoded
 * frame, and the posters do not match each clip's first real frame.
 */
export function ClipVideo({ clip, label, className }: ClipVideoProps) {
  const startAt = clip.startAt ?? 0;
  const { videoRef, ready, preload } = useClipPlayer(startAt);
  return (
    <video
      ref={videoRef}
      className={className}
      data-clip={ready ? 'ready' : 'pending'}
      muted
      // Native loop restarts at 0; clips with a later first real frame loop in
      // useClipPlayer instead.
      loop={startAt <= 0}
      playsInline
      preload={preload}
      disablePictureInPicture
      disableRemotePlayback
      aria-label={label}
    >
      <source src={clip.src} type="video/mp4" />
    </video>
  );
}
