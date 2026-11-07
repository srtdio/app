// The one exit of every viewer that opens over the app: "<" (Back) on the
// leading edge of its top bar. ImageLightbox (chat thread, chat home Photos,
// comments, plan concepts), FileViewer, PhotoViewer, the post lightbox and the
// asset lightbox all leave through it; no viewer has an X. The caller passes
// the 44px bar class for its tone (overlay ink on the dark viewers).
import type { ReactElement, RefObject } from 'react';
import { IconChevronLeft, ICON_SIZE } from '@/components/ui/icons';

export function ViewerBackButton(props: {
  onClick: () => void;
  className: string;
  buttonRef?: RefObject<HTMLButtonElement> | undefined;
}): ReactElement {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      aria-label="Back"
      onClick={props.onClick}
      className={props.className}
    >
      <IconChevronLeft size={ICON_SIZE.control} />
    </button>
  );
}
