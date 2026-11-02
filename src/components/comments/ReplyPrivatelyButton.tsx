// A comment row's Reply privately (post and brief comments, plan item
// comments): a ghost Button like its row neighbours. A tap opens the person
// card's inline message for the author with this comment as its source (the
// quote, built at tap time from what the row holds), anchored to the button:
// no navigation, no read. The card's send carries the quote
// (chat_private_reply_send). Outside a router (isolated renders) the card has
// nowhere to open its chat, so it draws nothing. Callers decide visibility
// with canReplyPrivately (src/lib/reply-privately.ts).

import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { useInRouterContext } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import { REPLY_PRIVATELY, type PrivateReplyDraft } from '@/lib/chat/private-reply';

export interface ReplyPrivatelyButtonProps {
  authorUserId: string;
  /** The quote, built at tap time from what the row already holds. */
  draft: () => PrivateReplyDraft;
  /** The row action layout class its neighbours use. */
  className?: string;
}

/** Open the inline message card for the quote's author with the quote as its source. */
export function openReplyPrivatelyCard(el: HTMLElement | null, draft: PrivateReplyDraft): void {
  // Painted inside the tap: the card's input focuses in the gesture (iOS keyboard).
  flushSync(() => {
    openPersonCardFrom(el, { userId: draft.authorUserId, name: draft.authorName, source: draft });
  });
}

export function ReplyPrivatelyButton(props: ReplyPrivatelyButtonProps): ReactElement | null {
  const routed = useInRouterContext();
  if (!routed) return null;
  return (
    <Button
      type="button"
      data-row-action="reply-privately"
      variant="ghost"
      className={props.className}
      onClick={(event) => openReplyPrivatelyCard(event.currentTarget, props.draft())}
    >
      {REPLY_PRIVATELY}
    </Button>
  );
}
