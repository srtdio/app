// The laptop composer's emoji button (fine pointer only; never on touch) and
// its popover: an 8-column grid of 36px cells from the curated static list
// (emoji-list.ts), the 16 recents first. Glyphs are text, no images, no search.
// A pick inserts at the caret; Escape or a click outside closes it. Tokens
// only, so light and dark stay at parity.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconSmile } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { EMOJI_LIST, readRecents, rememberRecent } from '@/lib/chat/emoji-list';
import { buttonClass } from '@/components/ui/Button';
import { popoverClass } from '@/components/ui/popover-classes';
import type { ChatLayout } from '@/components/chat/chat-type';

/** The emoji button is a laptop (fine pointer) control only; never on touch. Pure. */
export function showsEmojiButton(layout: ChatLayout): boolean {
  return layout === 'laptop';
}

/** The recents row's heading. */
export const RECENTS_HEADING = 'Recent';

export function ComposerEmoji(props: { onPick: (emoji: string) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    setRecents(readRecents());
    const raf = requestAnimationFrame(() => setShown(true));
    function onPointer(event: Event): void {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(emoji: string): void {
    setRecents(rememberRecent(emoji));
    setOpen(false);
    props.onPick(emoji);
  }

  const groups = [
    ...(recents.length > 0 ? [{ name: RECENTS_HEADING, emoji: recents }] : []),
    ...EMOJI_LIST,
  ];
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-emoji-button=""
        aria-label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keep the textarea's caret: the press never takes focus from it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        // Needs a ref (Escape returns focus): raw button on the shared recipe.
        // A 44x44 icon button (IconButton's footprint): ghost, accent while open.
        className={buttonClass(
          'ghost',
          'default',
          cn(
            'w-11 !px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            open && '!text-accent',
          ),
        )}
      >
        <IconSmile size={ICON_SIZE.control} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Emoji"
          data-emoji-popover=""
          className={cn(
            'absolute bottom-full right-0 z-20 mb-2 max-h-[320px] w-[312px] origin-bottom-right overflow-y-auto p-2',
            popoverClass(shown),
          )}
        >
          {groups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h3 className="px-1 pb-1 pt-2 text-sm font-medium text-fg-3">{group.name}</h3>
              <div className="grid grid-cols-8">
                {group.emoji.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    data-emoji-cell=""
                    aria-label={emoji}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(emoji)}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-2xl leading-none hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
