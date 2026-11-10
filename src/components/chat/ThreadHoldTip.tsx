// The one-time thread tip (H6) above the composer. Storage rules live in
// src/lib/chat/thread-tip.ts. Tokens only, so light and dark stay at parity.
// Flat look: no frame or fill, a --border hairline above it.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ChatLayout } from '@/components/chat/chat-type';
import { Button } from '@/components/ui/Button';
import { LANE_STRIP } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
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
      data-lane="strip"
      className={cn(
        LANE_STRIP,
        'flex items-center gap-3 border-t border-border py-1 pl-3 pr-1 text-base text-fg-2',
      )}
    >
      <p className="min-w-0 flex-1 truncate">
        {layout === 'laptop' ? HOLD_TIP_TEXT_LAPTOP : HOLD_TIP_TEXT}
      </p>
      <Button type="button" variant="link" onClick={onDismiss} className="min-w-11 shrink-0">
        {HOLD_TIP_DISMISS}
      </Button>
    </div>
  );
}

// Chat opens already counted this load.
const countedOpens = new Set<string>();

/**
 * `empty`: the thread has no messages yet (a new chat, empty notes). There is
 * nothing to hold, so the tip waits and is not counted as shown.
 */
export function ThreadHoldTip({
  userId,
  layout = 'touch',
  empty = false,
  openKey,
}: {
  userId: string;
  layout?: ChatLayout;
  empty?: boolean;
  /** This chat open's key: the tip counts one show per key. */
  openKey?: string;
}): ReactElement | null {
  const [show, setShow] = useState(() => shouldShowHoldTip(userId));
  useEffect(() => {
    setShow(shouldShowHoldTip(userId));
  }, [userId]);
  // Counted once per chat open (openKey, else this mount), never per render
  // or per remount inside the same open (selection, a thread view).
  const counted = useRef(false);
  useEffect(() => {
    if (!show || empty) return;
    if (openKey !== undefined ? countedOpens.has(openKey) : counted.current) return;
    if (openKey !== undefined) countedOpens.add(openKey);
    counted.current = true;
    noteHoldTipShown(userId);
  }, [show, empty, userId, openKey]);
  if (!show || empty) return null;
  return holdTipView(() => {
    dismissHoldTip(userId);
    setShow(false);
  }, layout);
}
