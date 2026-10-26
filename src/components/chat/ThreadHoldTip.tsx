// The one-time thread tip (H6) above the composer. Storage rules live in
// src/lib/chat/thread-tip.ts. Tokens only, so light and dark stay at parity.

import { useEffect, useState, type ReactElement } from 'react';
import type { ChatLayout } from '@/components/chat/chat-type';
import { Button } from '@/components/ui/Button';
import {
  HOLD_TIP_DISMISS,
  HOLD_TIP_TEXT,
  HOLD_TIP_TEXT_LAPTOP,
  dismissHoldTip,
  noteHoldTipShown,
  shouldShowHoldTip,
} from '@/lib/chat/thread-tip';

/** The tip's markup. Hook-free so it is unit tested. Laptop names the right-click. */
export function holdTipView(onDismiss: () => void, layout: ChatLayout = 'touch'): ReactElement {
  return (
    <div
      data-hold-tip=""
      role="note"
      className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-border bg-panel-2 py-1 pl-3 pr-1 text-base text-fg-2"
    >
      <p className="min-w-0 flex-1">{layout === 'laptop' ? HOLD_TIP_TEXT_LAPTOP : HOLD_TIP_TEXT}</p>
      <Button
        type="button"
        variant="link"
        onClick={onDismiss}
        className="min-w-[44px] shrink-0"
      >
        {HOLD_TIP_DISMISS}
      </Button>
    </div>
  );
}

/**
 * `empty`: the thread has no messages yet (a new chat, empty notes). There is
 * nothing to hold, so the tip waits and is not counted as shown.
 */
export function ThreadHoldTip({
  userId,
  layout = 'touch',
  empty = false,
}: {
  userId: string;
  layout?: ChatLayout;
  empty?: boolean;
}): ReactElement | null {
  const [show, setShow] = useState(() => shouldShowHoldTip(userId));
  useEffect(() => {
    setShow(shouldShowHoldTip(userId));
  }, [userId]);
  useEffect(() => {
    if (show && !empty) noteHoldTipShown(userId);
  }, [show, empty, userId]);
  if (!show || empty) return null;
  return holdTipView(() => {
    dismissHoldTip(userId);
    setShow(false);
  }, layout);
}
