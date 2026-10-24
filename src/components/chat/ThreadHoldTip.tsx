// The one-time thread tip (H6) above the composer. Storage rules live in
// src/lib/chat/thread-tip.ts. Tokens only, so light and dark stay at parity.

import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import {
  HOLD_TIP_DISMISS,
  HOLD_TIP_TEXT,
  dismissHoldTip,
  noteHoldTipShown,
  shouldShowHoldTip,
} from '@/lib/chat/thread-tip';

/** The tip's markup. Hook-free so it is unit tested. */
export function holdTipView(onDismiss: () => void): ReactElement {
  return (
    <div
      data-hold-tip=""
      role="note"
      className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-border bg-panel-2 py-1 pl-3 pr-1 text-sm text-fg-2"
    >
      <p className="min-w-0 flex-1">{HOLD_TIP_TEXT}</p>
      <Button
        type="button"
        variant="link"
        onClick={onDismiss}
        className="min-w-[44px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {HOLD_TIP_DISMISS}
      </Button>
    </div>
  );
}

export function ThreadHoldTip({ userId }: { userId: string }): ReactElement | null {
  const [show, setShow] = useState(() => shouldShowHoldTip(userId));
  useEffect(() => {
    setShow(shouldShowHoldTip(userId));
  }, [userId]);
  useEffect(() => {
    if (show) noteHoldTipShown(userId);
  }, [show, userId]);
  if (!show) return null;
  return holdTipView(() => {
    dismissHoldTip(userId);
    setShow(false);
  });
}
