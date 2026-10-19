// A chat page or sheet that is a modal dialog (FB2): role="dialog" with
// aria-modal, and X1's useModalFocus so focus moves in on open, Tab stays
// inside and focus returns to the opener on close. It is mounted only while
// its layer is open, so it owns focus for as long as it exists.

import { useRef, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { useModalFocus } from '@/lib/modal-focus';

export function ModalPanel(
  props: HTMLAttributes<HTMLDivElement> & { children?: ReactNode },
): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true);
  return <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} {...props} />;
}
