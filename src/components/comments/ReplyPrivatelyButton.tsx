// Reply privately: open the person card's inline message for a quote's author
// with the quote as its source (no navigation, no read). The chat's own Reply
// privately (message menu) opens through openReplyPrivatelyCard. Comments no
// longer offer Reply privately (comment action bar, 8 Nov 2026).

import { flushSync } from 'react-dom';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';

/** Open the inline message card for the quote's author with the quote as its source. */
export function openReplyPrivatelyCard(el: HTMLElement | null, draft: PrivateReplyDraft): void {
  // Painted inside the tap: the card's input focuses in the gesture (iOS keyboard).
  flushSync(() => {
    openPersonCardFrom(el, { userId: draft.authorUserId, name: draft.authorName, source: draft });
  });
}
