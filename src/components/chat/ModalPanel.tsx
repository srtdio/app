// A chat page or sheet that is a modal dialog (FB2): role="dialog" with
// aria-modal, and X1's useModalFocus so focus moves in on open, Tab stays
// inside and focus returns to the opener on close. It is mounted only while
// its layer is open, so it owns focus for as long as it exists. Motion
// (docs/motion.md, rise): on a phone the page rises from the bottom on its
// first frame (it is painted at rest; the move is laid over it); laptop
// screen switches are instant. Never a fade.

import { useRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { useModalFocus } from '@/lib/modal-focus';
import { riseIn, useMoveOnMount } from '@/lib/motion';
import { useIsLaptop } from '@/lib/use-is-laptop';

/** The full-screen chat page box (Contact, Group info, Starred). */
export const MODAL_PAGE_CLASS = 'fixed inset-0 z-50 flex flex-col bg-bg outline-none';

export function ModalPanel(
  props: HTMLAttributes<HTMLDivElement> & { children?: ReactNode },
): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const laptop = useIsLaptop();
  useModalFocus(ref, true);
  useMoveOnMount(ref, (el) => riseIn(el), !laptop);
  return <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} {...props} />;
}
