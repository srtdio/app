// The one way a person's photo, name or @mention opens the person card. It
// wraps what the screen already renders (Avatar stays a pure picture) in a
// role="button" span, so it nests inside a PressableRow (a <button>) without
// breaking it. A tap or Enter/Space opens the card and stops there: the row
// around it keeps its own tap everywhere else. The hit area is at least 44x44
// (an invisible box centred on it), so an inline name or a 20px avatar stays
// tappable without moving the layout.

import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { openPersonCard, type PersonCardHint } from '@/lib/person-card';

interface PersonTriggerProps extends PersonCardHint {
  children: ReactNode;
  /** Layout classes for the wrapper (e.g. 'shrink-0'); never visual overrides. */
  className?: string;
  /** 'block' wraps a photo or a block of text; 'inline' sits inside a line of text. */
  display?: 'inline' | 'block';
}

/** Open the card for `hint`, anchored to `el`. Exported for tests and the chat menu. */
export function openPersonCardFrom(el: HTMLElement | null, hint: PersonCardHint): void {
  const r = el?.getBoundingClientRect();
  openPersonCard({
    ...hint,
    anchor: r !== undefined ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : null,
    trigger: el,
  });
}

export function PersonTrigger({
  children,
  className,
  display = 'inline',
  userId,
  name,
  avatarUrl,
  username,
  former,
}: PersonTriggerProps) {
  const hint: PersonCardHint = {
    userId,
    ...(name !== undefined ? { name } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(former !== undefined ? { former } : {}),
  };
  const label = name !== undefined && name !== null && name !== '' ? name : undefined;

  function open(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void {
    event.stopPropagation();
    event.preventDefault();
    openPersonCardFrom(event.currentTarget, hint);
  }

  // A press here is the card's, not the row's (row press states, long-press, swipe).
  function stop(event: PointerEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      data-person-trigger={userId}
      onClick={open}
      onPointerDown={stop}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event);
      }}
      className={cn(
        'relative cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        // The invisible 44x44 minimum hit box, centred on the content.
        'after:absolute after:left-1/2 after:top-1/2 after:h-11 after:min-h-full after:w-11 after:min-w-full after:-translate-x-1/2 after:-translate-y-1/2',
        display === 'block' ? 'inline-flex shrink-0' : 'inline',
        className,
      )}
    >
      {children}
    </span>
  );
}
