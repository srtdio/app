import type { Clip } from './media';
import { useClipPlayer } from './useClipPlayer';

interface ClipVideoProps {
  clip: Clip;
  label: string;
  className?: string;
}

/** Muted looping clip that plays by itself, no controls, like an animation. */
export function ClipVideo({ clip, label, className }: ClipVideoProps) {
  const videoRef = useClipPlayer();
  return (
    <video
      ref={videoRef}
      className={className}
      poster={clip.poster}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      disableRemotePlayback
      aria-label={label}
    >
      <source src={clip.src} type="video/mp4" />
    </video>
  );
}
