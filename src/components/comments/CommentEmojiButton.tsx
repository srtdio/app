// The laptop emoji button for every comment input: a 44x44 smile that opens
// chat's full searchable picker (EmojiPickerShell, laptop popover, opacity
// only) anchored to the button. Rendered only when LAPTOP_LAYOUT_QUERY matches
// (a fine hover pointer at 768px and up); touch devices have an emoji keyboard
// and never see it, so no layout shifts there. The picker body stays a lazy
// chunk: hover or focus on the button starts loadEmojiPicker() so the grid is
// usually ready by the click. Tokens only, so light and dark stay at parity.

import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { IconSmile } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { insertAtCaret } from '@/lib/chat/emoji-list';
import { LAPTOP_LAYOUT_QUERY } from '@/components/chat/chat-type';
import { EmojiPickerShell, loadEmojiPicker } from '@/components/chat/MessageActionMenu';

/** Warm the picker chunk; a failure is retried (and shown) when the picker opens. */
function preload(): void {
  loadEmojiPicker().catch(() => undefined);
}

/** The slice of a textarea the insert reads and restores. */
export interface CaretTextarea {
  selectionStart: number;
  selectionEnd: number;
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
}

/**
 * Insert `char` into a controlled textarea's `value` at its selection (a
 * selected range is replaced; no element means the end), hand the new value to
 * `setValue`, then put focus and the caret right after the insert on the next
 * frame, once React has rendered the new value.
 */
export function insertIntoTextarea(
  getTextarea: () => CaretTextarea | null,
  value: string,
  char: string,
  setValue: (next: string) => void,
): void {
  const el = getTextarea();
  const at =
    el !== null
      ? { start: el.selectionStart, end: el.selectionEnd }
      : { start: value.length, end: value.length };
  const next = insertAtCaret(value, at, char);
  setValue(next.value);
  requestAnimationFrame(() => {
    const area = getTextarea();
    if (area === null) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(next.caret, next.caret);
  });
}

export function CommentEmojiButton(props: {
  onPick: (char: string) => void;
  disabled?: boolean;
  className?: string;
}): ReactElement | null {
  const laptop = useMediaQuery(LAPTOP_LAYOUT_QUERY);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { onPick } = props;

  const close = useCallback((): void => setOpen(false), []);
  const pick = useCallback(
    (char: string): void => {
      onPick(char);
      setOpen(false);
    },
    [onPick],
  );

  // Touch has an emoji keyboard: no button, no layout change.
  if (!laptop) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-comment-emoji=""
        aria-label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        // Keep the input's caret: the press never takes focus from it.
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          const button = buttonRef.current;
          if (button === null) return;
          setAnchor(button.getBoundingClientRect());
          setOpen(true);
        }}
        className={cn(
          'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
          open ? 'text-accent' : 'text-fg-2',
          props.className,
        )}
      >
        <IconSmile size={20} />
      </button>
      <EmojiPickerShell
        open={open}
        onClose={close}
        onPick={pick}
        layout="laptop"
        anchor={anchor}
        returnFocus={buttonRef}
      />
    </>
  );
}
