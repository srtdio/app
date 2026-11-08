// The person card's inline composer: ui/WritingBox in comment mode with
// "Message <first name>…", the first three quick reactions on the text line
// on the right while it is empty, and the round Send (RowSend) in the row
// once there is text (reactions hide while typing, like Instagram). Focused,
// the row under the text holds Aa and emoji (no +, no @, no mic). One piece, used by the phone sheet and the laptop
// popover alike. The text lives in the chat drafts store under the person
// card's key (personDraftKey), so it survives closing and reopening the card
// for the same person and source, until it is sent. It focuses itself in its
// first layout pass: the card opens inside the tap (PersonTrigger flushes it),
// so iOS raises the keyboard with the sheet.
//
// Keys: plain Enter sends on a fine pointer; Shift+Enter is a newline, and on
// touch every Enter is a newline (the chat send rule, src/lib/chat/send-key.ts).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { RowSend, WritingBox } from '@/components/ui/WritingBox';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconSend } from '@/components/ui/icons';
import { QUICK_REACTIONS } from '@/components/chat/MessageActionMenu';
import { getDraft, setDraft } from '@/lib/chat/drafts';
import { isSendKeydown } from '@/lib/chat/send-key';
import { messagePlaceholder } from '@/lib/person-card';

/** The card's quick reactions: the first three of the message menu's row (never a second list). */
export const CARD_REACTIONS: readonly string[] = QUICK_REACTIONS.slice(0, 3);

/** Reactions show only while the box is empty; Send only once there is text. Pure. */
export function inlineControls(text: string): { reactions: boolean; send: boolean } {
  const empty = text.trim() === '';
  return { reactions: empty, send: !empty };
}

export interface PersonMessageInputProps {
  firstName: string;
  /** The drafts store key (personDraftKey: person + source). */
  draftKey: string;
  /** 'laptop' sends on Enter; 'touch' keeps Enter as a newline. */
  layout: 'touch' | 'laptop';
  /** Text or a tapped reaction. The card closes and queues; the draft is cleared here first. */
  onSend: (text: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function PersonMessageInput(props: PersonMessageInputProps): ReactElement {
  const { draftKey } = props;
  const [text, setText] = useState(() => getDraft(draftKey).text);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function setRefs(el: HTMLTextAreaElement | null): void {
    ref.current = el;
    const outer = props.inputRef;
    if (typeof outer === 'function') outer(el);
    else if (outer !== undefined && outer !== null) {
      (outer as { current: HTMLTextAreaElement | null }).current = el;
    }
  }

  // Focus in the tap's own commit (no scroll: the sheet sits on the keyboard,
  // the page never jumps), caret after any kept draft.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  // Grow with the text up to the cap, then scroll (the composer's rule).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  function change(next: string, caret: number): void {
    setText(next);
    setDraft(draftKey, { text: next, caret });
  }

  function send(value: string): void {
    const body = value.trim();
    if (body === '') return;
    // The typed text goes with the send; a reaction leaves the typed draft as it is.
    if (value === text) {
      setText('');
      setDraft(draftKey, { text: '', caret: 0 });
    }
    // Phone: the keyboard goes down with the sheet, not after its exit slide.
    if (props.layout === 'touch') ref.current?.blur();
    props.onSend(body);
  }

  const controls = inlineControls(text);
  return (
    <form
      data-person-message=""
      onSubmit={(event) => {
        event.preventDefault();
        send(text);
      }}
    >
      {/* ui/WritingBox (comment mode): field and in-line reactions on the
          text line; focused, the row: Aa, emoji ... the round Send. */}
      <WritingBox
        mode="comment"
        field={() => ref.current}
        hasText={text !== ''}
        expandTitle={messagePlaceholder(props.firstName)}
        input={
          <span className="flex min-w-0 items-center">
            <textarea
              ref={setRefs}
              data-person-message-input=""
              // A chat message, not an AutoFill target.
              autoComplete="off"
              rows={1}
              value={text}
              placeholder={messagePlaceholder(props.firstName)}
              aria-label={messagePlaceholder(props.firstName)}
              onChange={(event) => change(event.target.value, event.target.selectionStart)}
              onKeyDown={(event) => {
                if (
                  isSendKeydown({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                    coarsePointer: props.layout !== 'laptop',
                  })
                ) {
                  event.preventDefault();
                  send(text);
                }
              }}
              // 16px below md so iOS never zooms on focus; 14px from md up.
              className="max-h-32 min-w-0 flex-1 resize-none self-center overflow-y-auto bg-transparent py-2 text-input text-fg outline-none placeholder:text-fg-3 md:text-base"
            />
            {controls.reactions ? (
              <span className="flex shrink-0 items-center" data-person-reactions="">
                {CARD_REACTIONS.map((emoji) => (
                  <IconButton
                    key={emoji}
                    type="button"
                    label={`Send ${emoji}`}
                    data-person-reaction={emoji}
                    // Keep the keyboard up: the press never takes focus from the box.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => send(emoji)}
                    className="shrink-0 text-2xl"
                  >
                    <span aria-hidden="true">{emoji}</span>
                  </IconButton>
                ))}
              </span>
            ) : null}
          </span>
        }
        send={
          controls.send ? (
            <RowSend
              type="submit"
              label="Send"
              disabled={false}
              data-person-send=""
              icon={<IconSend size={ICON_SIZE.control} />}
              onPointerDown={(event) => event.preventDefault()}
            />
          ) : undefined
        }
      />
    </form>
  );
}
