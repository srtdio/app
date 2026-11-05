// The one way a person's photo, name or @mention opens the person card. It
// wraps what the screen already renders (Avatar stays a pure picture) in a
// role="button" span, so it nests inside a PressableRow (a <button>) without
// breaking it. A tap or Enter/Space opens the card and stops there: the row
// around it keeps its own tap everywhere else. The hit area is at least 44x44
// (an invisible box centred on it), so an inline name or a 20px avatar stays
// tappable without moving the layout.
//
// The surface decides only what a tap opens: `view` 'card' (default, the inline
// message card) or 'photo' (the photo-only viewer: inside a DM only; the
// chat list's People tiles open the chat). `source` is the comment or group
// chat message the tap came from, built at tap time from what the row holds.
// The open is flushed inside the tap (flushSync) so the card's input takes
// focus within the gesture: iOS raises the keyboard only then.

import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/lib/cn';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { openPersonCard, type PersonCardHint, type PersonView } from '@/lib/person-card';

interface PersonTriggerProps extends Omit<PersonCardHint, 'source'> {
  children: ReactNode;
  /** Layout classes for the wrapper (e.g. 'shrink-0'); never visual overrides. */
  className?: string;
  /** 'block' wraps a photo or a block of text; 'inline' sits inside a line of text. */
  display?: 'inline' | 'block';
  /** What a tap opens: the card (default) or the photo-only viewer. */
  view?: PersonView;
  /** The comment or message this tap came from; called at tap time. Absent: none. */
  source?: () => PrivateReplyDraft | null;
}

/** Open the card (or with view 'photo' the viewer) for `hint`, anchored to `el`. */
export function openPersonCardFrom(
  el: HTMLElement | null,
  hint: PersonCardHint,
  view: PersonView = 'card',
): void {
  const r = el?.getBoundingClientRect();
  openPersonCard({
    ...hint,
    anchor: r !== undefined ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom } : null,
    trigger: el,
    view,
  });
}

/** The photo-only viewer for `hint` (DM rows, DM header). */
export function openPersonPhotoFrom(el: HTMLElement | null, hint: PersonCardHint): void {
  openPersonCardFrom(el, hint, 'photo');
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
  view = 'card',
  source,
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
    const el = event.currentTarget;
    const from = view === 'card' ? (source?.() ?? null) : null;
    // Painted inside the tap: the card's input focuses in the gesture (iOS keyboard).
    flushSync(() => {
      openPersonCardFrom(el, from !== null ? { ...hint, source: from } : hint, view);
    });
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
      data-person-view={view}
      onClick={open}
      onPointerDown={stop}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event);
      }}
      className={cn(
        'relative cursor-pointer focus-visible:lit-focus',
        // The invisible 44x44 minimum hit box, centred on the content.
        'after:absolute after:left-1/2 after:top-1/2 after:h-11 after:min-h-full after:w-11 after:min-w-full after:-translate-x-1/2 after:-translate-y-1/2',
        display === 'block' ? 'inline-flex shrink-0 rounded-full' : 'inline',
        className,
      )}
    >
      {children}
    </span>
  );
}
