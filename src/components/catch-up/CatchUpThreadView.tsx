// A thread opened full screen inside catch up (9 Nov 2026): the card frame,
// the name row and the bottom buttons hide; the top bar is every thread's
// (title by place over the item name, 13 Nov 2026), "<" returns to the exact
// card state. Body: the root (36 photo on phone, 12 under the bar, name
// over its date, the text full width on the 16 gutter), chat's
// one thread strip (ui RepliesSeparatorRow: "Reply in thread" focuses the
// reply box, else "N replies"), the replies oldest first, then the "Reply in
// thread" box. No reply gesture inside a thread. Pure render.

import { useRef } from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import type { CatchUpMessageRow, CatchUpThread } from '@/lib/catch-up/body';
import {
  BoneRows,
  CATCH_UP_ROW_X,
  CardError,
  LongText,
  MessageRow,
} from '@/components/catch-up/CatchUpRows';
import type { SentMessage } from '@/components/catch-up/CatchUpCard';
import {
  RepliesSeparatorRow,
  ThreadRootHead,
  type RootActions,
} from '@/components/chat/ThreadRail';
import { cn } from '@/lib/cn';
import type { ReactionsApi } from '@/lib/reactions/use-reactions';
import { threadWhen } from '@/lib/time';
import {
  CatchUpRowReactions,
  useCatchUpReactions,
  type CatchUpReactionSource,
} from '@/components/catch-up/CatchUpReactions';

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
  /** The card the thread belongs to: its rows' reactions (one batched read). Absent: none. */
  reactionsOf?: CatchUpReactionSource | undefined;
  /** The strip's keys on the root (to-do, forward, more): the one message action layer. */
  actions?: RootActions | undefined;
  /** Long-press / right-click a reply: the same layer. */
  onHold?:
    | ((row: CatchUpMessageRow, from: HTMLElement, reactions: ReactionsApi) => void)
    | undefined;
}): ReactElement {
  const replies = props.thread !== null && props.thread !== 'error' ? props.thread.replies : [];
  const source = props.reactionsOf;
  const reactionIds = [props.root.id, ...replies.map((r) => r.id)];
  const reactions = useCatchUpReactions(
    source ?? { kind: 'post', entityId: '', workspaceId: '' },
    source !== undefined ? reactionIds : [],
    props.thread,
  );
  const rowReactions = (id: string, flush = false) =>
    source !== undefined ? (
      <CatchUpRowReactions id={id} api={reactions} workspaceId={source.workspaceId} flush={flush} />
    ) : undefined;
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
        {/* Root: 12 under the top bar (every thread, 13 Nov 2026); 12 from its last
            text line to the strip's top hairline; replies start 8 under it. */}
        <ul className="flex flex-col">
          <li
            data-catch-up-message={props.root.id}
            data-thread-root=""
            className={cn('relative flex flex-col gap-2 pb-3 pt-3', CATCH_UP_ROW_X)}
          >
            <ThreadRootHead
              name={props.root.author.name}
              avatarUrl={props.root.author.avatarUrl}
              when={threadWhen(props.root.createdAt, 'date', new Date(), props.timeZone)}
              dateTime={props.root.createdAt}
            />
            <LongText text={props.root.text} selfName={props.selfName} />
            {/* Chips sit under the root text, above the strip (12 to it stays the li's pb-3). */}
            {rowReactions(props.root.id, true)}
          </li>
        </ul>
        <RepliesSeparatorRow
          as="div"
          family="catch-up"
          label={count > 0 ? repliesLabel(count) : null}
          through={false}
          actions={props.actions}
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
                threadTime
                reactions={rowReactions(row.id)}
                onHold={
                  props.onHold !== undefined
                    ? (from) => props.onHold?.(row, from, reactions)
                    : undefined
                }
              />
            ))}
            {props.sent.map((message) => (
              <MessageRow
                key={message.id}
                row={message}
                selfName={props.selfName}
                timeZone={props.timeZone}
                onOpenThread={null}
                threadTime
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
