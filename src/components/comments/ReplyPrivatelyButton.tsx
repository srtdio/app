// A comment row's Reply privately (post and brief comments, plan item
// comments): a ghost Button like its row neighbours. A tap writes the quote on
// the DM's draft (setPrivateReplyDraft) right before the DM opens, through the
// one open-my-DM path (useOpenPersonDm: the cached DM opens with no read).
// Outside a router (isolated renders) there is nowhere to open, so it draws
// nothing. Callers decide visibility with canReplyPrivately (src/lib/reply-privately.ts).

import type { ReactElement } from 'react';
import { useInRouterContext } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useOpenPersonDm } from '@/components/ui/use-open-person-dm';
import { setPrivateReplyDraft } from '@/lib/chat/drafts';
import { REPLY_PRIVATELY, type PrivateReplyDraft } from '@/lib/chat/private-reply';

export interface ReplyPrivatelyButtonProps {
  authorUserId: string;
  /** The quote, built at tap time from what the row already holds. */
  draft: () => PrivateReplyDraft;
  /** The row action layout class its neighbours use. */
  className?: string;
}

function ReplyPrivatelyRouted(props: ReplyPrivatelyButtonProps): ReactElement {
  const openDm = useOpenPersonDm();
  return (
    <Button
      type="button"
      data-row-action="reply-privately"
      variant="ghost"
      className={props.className}
      onClick={() => {
        const draft = props.draft();
        openDm(props.authorUserId, {
          beforeOpen: (channelId) => setPrivateReplyDraft(channelId, draft),
        });
      }}
    >
      {REPLY_PRIVATELY}
    </Button>
  );
}

export function ReplyPrivatelyButton(props: ReplyPrivatelyButtonProps): ReactElement | null {
  const routed = useInRouterContext();
  return routed ? <ReplyPrivatelyRouted {...props} /> : null;
}
