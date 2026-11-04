// The person photo viewer: inside a DM (its rows, its header) and on the chat
// list's People cards a person's photo opens this, never the card (there is
// nothing to message: you are already in the chat). A dark overlay (the media
// viewers' bg-overlay, not a Backdrop), the person's photo large (the shared
// Avatar at its profile role, scaled up, so the initials fallback is the same
// one), the full name under it, and an X top right. A tap outside the photo,
// Esc, or Back closes it, and focus returns to what was tapped. Paints in the
// tap's frame from the trigger's hint plus the held members cache: no read.
// Motion (docs/motion.md): the photo grows out of the tapped photo
// (growFromCard); a swipe down follows the finger and, past the line, rises
// out and closes, else springs back. Never a fade.

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { useBackGuard } from '@/lib/back-guard';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { SHEET_CLOSE_PX, riseIn, riseOut, useDragDismiss } from '@/lib/motion';
import { useGrowFromThumb } from '@/lib/motion/overlays';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  // A drag is not a tap: the click that ends it never closes.
  const dragged = useRef(false);
  useEscapeLayer(true, onClose);

  // Grows out of the tapped photo on the first frame (rendered in place).
  const triggerBox = trigger?.getBoundingClientRect();
  useGrowFromThumb(
    contentRef,
    triggerBox !== undefined && triggerBox.width > 0
      ? {
          left: triggerBox.left,
          top: triggerBox.top,
          width: triggerBox.width,
          height: triggerBox.height,
        }
      : null,
  );

  // Swipe down closes: follows the finger, rises out past the line.
  const drag = useDragDismiss({
    axis: 'y',
    direction: 1,
    closeAt: SHEET_CLOSE_PX,
    onMove: (offset) => {
      dragged.current = true;
      if (contentRef.current !== null)
        contentRef.current.style.transform = `translateY(${offset}px)`;
    },
    onDismiss: (offset) => {
      if (closing.current) return;
      closing.current = true;
      const el = contentRef.current;
      const played = riseOut(el, offset);
      if (el !== null) el.style.transform = '';
      if (played.instant) onClose();
      else void played.done.then(onClose);
    },
    onCancel: (offset) => {
      const el = contentRef.current;
      if (el === null) return;
      el.style.transform = '';
      if (offset !== 0) riseIn(el, offset);
    },
  });
  useBackGuard({ active: true, onBack: onClose });

  // As the other viewers: focus lands on the X, Tab stays inside, the page
  // behind is inert, and focus goes back on close (modal-focus.ts).
  useModalFocus(dialogRef, true, { initial: () => closeRef.current });
  // A tap that never focused the photo (iOS): the tapped element still gets it back.
  useEffect(() => {
    return () => {
      const active = document.activeElement;
      const held = active === null || active === document.body;
      if (held && trigger !== null && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={props.name}
      data-photo-viewer={props.userId}
      className="fixed inset-0 z-50 flex touch-none flex-col items-center justify-center bg-overlay"
      {...drag}
      // A tap anywhere but the photo and the X closes it.
      onClick={(event) => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <IconButton
        buttonRef={closeRef}
        type="button"
        label="Close"
        data-photo-viewer-close=""
        onClick={onClose}
        className="absolute right-3 top-[max(12px,env(safe-area-inset-top))] text-overlay-fg hover:bg-overlay-surface focus-visible:outline-overlay-fg"
      >
        <IconX size={ICON_SIZE.control} />
      </IconButton>
      <div
        ref={contentRef}
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
            decorative
          />
        </span>
        <p className="max-w-[80vw] truncate text-xl font-semibold text-overlay-fg">{props.name}</p>
      </div>
    </div>,
    document.body,
  );
}
