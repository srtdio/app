// A catch-up card's reply box: the shared ui/WritingBox (chat mode for chat
// cards, comment mode for post and brief comments) with the card's hint
// ("Reply in thread", "Message <chat>", "Reply") and the round Send once there
// is text. Sending never advances the queue (several messages are fine).
// Focus and blur are reported so the screen can switch to its typing state.
// Keys: the chat send rule (src/lib/chat/send-key.ts). The field is ui/Textarea
// (compact: 44 at rest, grows to its cap, then scrolls).

import { useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { RowSend, WritingBox } from '@/components/ui/WritingBox';
import { ICON_SIZE, IconSend } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/Textarea';
import { isSendKeydown } from '@/lib/chat/send-key';

export function CatchUpReply(props: {
  hint: string;
  mode: 'chat' | 'comment';
  laptop: boolean;
  onSend: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}): ReactElement {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function setRefs(el: HTMLTextAreaElement | null): void {
    ref.current = el;
    const outer = props.inputRef;
    if (typeof outer === 'function') outer(el);
    else if (outer !== undefined && outer !== null) {
      (outer as { current: HTMLTextAreaElement | null }).current = el;
    }
  }

  function send(): void {
    const body = text.trim();
    if (body === '') return;
    setText('');
    props.onSend(body);
  }

  return (
    <form
      data-catch-up-reply=""
      className="shrink-0 border-t border-border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onFocus={() => props.onFocusChange(true)}
      onBlur={(event) => {
        // Focus moving inside the box (Aa, emoji, Send) keeps the typing state.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        props.onFocusChange(false);
      }}
    >
      <WritingBox
        mode={props.mode}
        laptop={props.laptop}
        field={() => ref.current}
        hasText={text !== ''}
        expandTitle={props.hint}
        input={
          <Textarea
            ref={setRefs}
            formatting
            compact
            listEnter={false}
            data-catch-up-reply-input=""
            autoComplete="off"
            rows={1}
            value={text}
            placeholder={props.hint}
            aria-label={props.hint}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                isSendKeydown({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  coarsePointer: !props.laptop,
                })
              ) {
                event.preventDefault();
                send();
              }
            }}
            className="min-w-0 flex-1 self-center"
          />
        }
        send={
          text.trim() !== '' ? (
            <RowSend
              type="submit"
              label="Send"
              disabled={false}
              icon={<IconSend size={ICON_SIZE.control} />}
              onPointerDown={(event) => event.preventDefault()}
            />
          ) : undefined
        }
      />
    </form>
  );
}
