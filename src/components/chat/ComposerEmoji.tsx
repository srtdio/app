// The laptop composer's emoji button (768px and up, iPad included; never on a phone) and
// its popover: an 8-column grid of 36px cells from the curated static list
// (emoji-list.ts), the 16 recents first. Glyphs are text, no images, no search.
// A pick inserts at the caret; Escape or a click outside closes it. Motion
// (docs/motion.md): it grows from the emoji button and shrinks back to it
// (laptop only, so the laptop form of rise), never a fade. Tokens only, so
// light and dark stay at parity.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ICON_SIZE, IconSmile } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { EMOJI_LIST, readRecents, rememberRecent } from '@/lib/chat/emoji-list';
import { IconButton } from '@/components/ui/IconButton';
import { centreOf, menuMoves, popoverClass } from '@/components/ui/popover-classes';
import { usePresence } from '@/lib/motion';
import type { ChatLayout } from '@/components/chat/chat-type';

/** The emoji button is a laptop (768px and up) control only; never on a phone. Pure. */
export function showsEmojiButton(layout: ChatLayout): boolean {
  return layout === 'laptop';
}

/** The recents row's heading. */
const RECENTS_HEADING = 'Recent';

export function ComposerEmoji(props: { onPick: (emoji: string) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popover = usePresence<HTMLDivElement>(
    open,
    menuMoves(() => centreOf(buttonRef.current), 'right'),
  );

  useEffect(() => {
    if (!open) return;
    setRecents(readRecents());
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
      <IconButton
        buttonRef={buttonRef}
        type="button"
        data-emoji-button=""
        label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keep the textarea's caret: the press never takes focus from it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        // buttonRef returns focus on Escape. Accent while open (aria-expanded
        // outranks the base text-fg-2 without an important override). A bare
        // 44 circle: the composer row's side buttons share one treatment (B3).
        className="rounded-full aria-expanded:text-accent"
      >
        <IconSmile size={ICON_SIZE.control} />
      </IconButton>
      {popover.rendered ? (
        <div
          ref={popover.ref}
          role="dialog"
          aria-label="Emoji"
          data-emoji-popover=""
          className={cn(
            // 8 columns of 44px cells plus the 8px padding each side (desktop only).
            'absolute bottom-full right-0 z-20 mb-2 max-h-80 w-[368px] origin-bottom-right overflow-y-auto p-2',
            popoverClass(),
          )}
        >
          {groups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h3 className="px-1 pb-1 pt-2 text-sm font-medium text-fg-3">{group.name}</h3>
              <div className="grid grid-cols-8">
                {group.emoji.map((emoji) => (
                  <IconButton
                    key={emoji}
                    type="button"
                    data-emoji-cell=""
                    label={emoji}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(emoji)}
                    className="text-2xl leading-none"
                  >
                    {emoji}
                  </IconButton>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
