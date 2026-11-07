// The "<" exit of a full-screen viewer opened from a comment (FileViewer,
// ImageLightbox backBar mode). Kept in its own file so each viewer file holds
// one exit kind: the viewers keep their X for chat, this is the "<" one.
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
