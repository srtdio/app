import type { Clip } from './media';
import { useClipPlayer } from './useClipPlayer';

interface ClipVideoProps {
  clip: Clip;
  label: string;
  className?: string;
}

/**
 * Muted looping clip that plays by itself, no controls, like an animation.
 * It stays transparent over its container's fill until a frame is decoded,
 * so a blank video box never paints.
 */
export function ClipVideo({ clip, label, className }: ClipVideoProps) {
  const { videoRef, ready, preload } = useClipPlayer();
  return (
    <video
      ref={videoRef}
      className={className}
      data-clip={ready ? 'ready' : 'pending'}
      muted
      loop
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
