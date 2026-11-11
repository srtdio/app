// FN24: the chat's list loading states are skeleton rows, never a plain
// "Loading" line. Static placeholders (an avatar disc and a name bar per row,
// 44px tall; the message family's photo box and gap per layout, so a row
// lands where its placeholder was), tokens only; the label is spoken through aria-label. Each box
// is a motion Bone (top-lit sweep, never a pulse or fade).

import type { ReactElement } from 'react';
import { Bone } from '@/lib/motion';
import { cn } from '@/lib/cn';
import {
  MESSAGE_PHOTO_BOX,
  MESSAGE_PHOTO_GAP,
  readChatLayout,
  sized,
} from '@/components/chat/chat-type';

export function listSkeleton(label: string, rows = 3): ReactElement {
  // Read synchronously (never a hook: callers return this from a branch).
  const layout = readChatLayout();
  return (
    <ul data-list-skeleton="" aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={`bone-${i}`}
          aria-hidden="true"
          className={cn('flex min-h-11 items-center px-1', sized(MESSAGE_PHOTO_GAP, layout))}
        >
          <Bone
            lit="lit-avatar"
            className={cn('shrink-0 rounded-lg', sized(MESSAGE_PHOTO_BOX, layout))}
          />
          <Bone lit="flat" className="h-3 w-32 rounded" />
        </li>
      ))}
    </ul>
  );
}
