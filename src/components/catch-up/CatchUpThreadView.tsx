// A thread opened full screen inside catch up (9 Nov 2026): the card frame,
// the name row and the bottom buttons hide; the top bar reads "Thread" over
// the item name, "<" returns to the exact card state. Body: the root, chat's
// one thread strip (ui RepliesSeparatorRow: "Reply in thread" focuses the
// reply box, else "N replies"), the replies oldest first, then the "Reply in
// thread" box. No reply gesture inside a thread. Pure render.

import { useRef } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import type { CatchUpMessageRow, CatchUpThread } from '@/lib/catch-up/body';
import { BoneRows, CardError, MessageRow } from '@/components/catch-up/CatchUpRows';
import type { SentMessage } from '@/components/catch-up/CatchUpCard';
import { RepliesSeparatorRow } from '@/components/chat/ThreadRail';

/** The reply box's field inside the reply slot. */
const REPLY_FIELD = 'textarea, input[type="text"], [contenteditable="true"]';

/** "1 reply" / "N replies". Pure. */
export function repliesLabel(n: number): string {
  return n === 1 ? '1 reply' : `${n} replies`;
}

export function CatchUpThreadView(props: {
  root: CatchUpMessageRow;
  thread: CatchUpThread | null | 'error';
  sent: readonly SentMessage[];
  selfName: string | null;
  timeZone?: string | undefined;
  reply: ReactNode;
  onRetryLoad: () => void;
  onRetrySend: (id: string) => void;
  viewRef?: Ref<HTMLDivElement>;
}): ReactElement {
  const replies = props.thread !== null && props.thread !== 'error' ? props.thread.replies : [];
  const count = replies.length + props.sent.filter((m) => m.state !== 'failed').length;
  const replyRef = useRef<HTMLDivElement>(null);
  // Synchronous in the tap (iOS opens the keyboard only then).
  const focusReply = (): void => {
    const field = replyRef.current?.querySelector<HTMLElement>(REPLY_FIELD);
    field?.focus({ preventScroll: true });
  };
  return (
    <div ref={props.viewRef} data-catch-up-thread="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {/* Root: 8 (row) + 4 = 12 to the strip's top hairline; replies start 8 under it. */}
        <ul className="flex flex-col pt-2">
          <MessageRow
            row={props.root}
            selfName={props.selfName}
            timeZone={props.timeZone}
            onOpenThread={null}
          />
        </ul>
        <RepliesSeparatorRow
          as="div"
          family="catch-up"
          className="mt-1"
          label={count > 0 ? repliesLabel(count) : null}
          through={false}
          onFocusReply={focusReply}
        />
        {props.thread === 'error' ? (
          <CardError onRetry={props.onRetryLoad} />
        ) : props.thread === null ? (
          <BoneRows count={2} />
        ) : (
          <ul data-catch-up-thread-replies="" className="flex flex-col pb-2">
            {replies.map((row) => (
              <MessageRow
                key={row.id}
                row={row}
                selfName={props.selfName}
                timeZone={props.timeZone}
                onOpenThread={null}
              />
            ))}
            {props.sent.map((message) => (
              <MessageRow
                key={message.id}
                row={message}
                selfName={props.selfName}
                timeZone={props.timeZone}
                onOpenThread={null}
                trailing={
                  message.state === 'failed' ? (
                    <span data-catch-up-not-sent="" className="flex items-center gap-2">
                      <Text role="secondary" className="text-bad">
                        Not sent
                      </Text>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => props.onRetrySend(message.id)}
                      >
                        Retry
                      </Button>
                    </span>
                  ) : null
                }
              />
            ))}
          </ul>
        )}
      </div>
      <div ref={replyRef} data-catch-up-thread-reply="" className="shrink-0">
        {props.reply}
      </div>
    </div>
  );
}
