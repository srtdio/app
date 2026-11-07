// Reply privately: open the person card's inline message for a quote's author
// with the quote as its source (no navigation, no read). Comment rows carry it
// as an icon in their action line (post screen redo, 7 Nov 2026); a tap on the
// author's photo or name still opens the same card with the same quote. The
// chat's own Reply privately (message menu) opens through openReplyPrivatelyCard.

import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconReplyPrivately } from '@/components/ui/icons';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import { REPLY_PRIVATELY, type PrivateReplyDraft } from '@/lib/chat/private-reply';

/** Open the inline message card for the quote's author with the quote as its source. */
export function openReplyPrivatelyCard(el: HTMLElement | null, draft: PrivateReplyDraft): void {
  // Painted inside the tap: the card's input focuses in the gesture (iOS keyboard).
  flushSync(() => {
    openPersonCardFrom(el, { userId: draft.authorUserId, name: draft.authorName, source: draft });
  });
}

/**
 * The comment row's Reply privately: a 44x44 icon (IconReplyPrivately, the
 * bubble with an out-arrow, the one icon for Reply privately, as in the chat
 * message menu) named "Reply privately". The
 * draft is built at tap time from what the row already holds (no read). The
 * caller shows it only where canReplyPrivately allows.
 */
export function ReplyPrivatelyButton(props: { draft: () => PrivateReplyDraft }): ReactElement {
  return (
    <IconButton
      type="button"
      label={REPLY_PRIVATELY}
      data-row-action="reply-privately"
      onClick={(event) => openReplyPrivatelyCard(event.currentTarget, props.draft())}
    >
      <IconReplyPrivately size={ICON_SIZE.inline} />
    </IconButton>
  );
}
