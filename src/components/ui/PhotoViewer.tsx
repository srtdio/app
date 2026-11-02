// The person photo viewer: inside a DM (its rows, its header) and on the chat
// list's People cards a person's photo opens this, never the card (there is
// nothing to message: you are already in the chat). A dark overlay (the media
// viewers' bg-overlay, not a Backdrop), the person's photo large (the shared
// Avatar at its profile role, scaled up, so the initials fallback is the same
// one), the full name under it, and an X top right. A tap outside the photo,
// Esc, or Back closes it, and focus returns to what was tapped. Paints in the
// tap's frame from the trigger's hint plus the held members cache: no read.

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { useBackGuard } from '@/lib/back-guard';
import { useEscapeLayer } from '@/lib/escape-stack';

/** The scale on the profile avatar (72px) for the large photo: 216px. */
export const PHOTO_SCALE_CLASS = 'scale-[3]';

export interface PhotoViewerProps {
  userId: string;
  name: string;
  avatarUrl: string | null;
  onClose: () => void;
  /** The tapped element, focused again on close. */
  trigger: HTMLElement | null;
}

export function PhotoViewer(props: PhotoViewerProps): ReactElement {
  const { onClose, trigger } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEscapeLayer(true, onClose);
  useBackGuard({ active: true, onBack: onClose });

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const held = active === null || active === document.body || active === closeRef.current;
      if (held && trigger !== null && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.name}
      data-photo-viewer={props.userId}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-overlay"
      // A tap anywhere but the photo and the X closes it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <IconButton
        buttonRef={closeRef}
        type="button"
        label="Close"
        data-photo-viewer-close=""
        onClick={onClose}
        className="absolute right-3 top-[max(12px,env(safe-area-inset-top))] text-overlay-fg hover:bg-overlay-surface"
      >
        <IconX size={ICON_SIZE.control} />
      </IconButton>
      <div
        className="flex flex-col items-center gap-[88px]"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <span className={PHOTO_SCALE_CLASS} data-photo-viewer-photo="">
          <Avatar
            role="profile"
            name={props.name}
            {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
          />
        </span>
        <p className="max-w-[80vw] truncate text-xl font-semibold text-overlay-fg">{props.name}</p>
      </div>
    </div>,
    document.body,
  );
}
