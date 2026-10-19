// FN24: the chat's list loading states are skeleton rows, never a plain
// "Loading" line. Static placeholders (an avatar disc and a name bar per row,
// 44px tall), tokens only; the label is spoken through aria-label.

import type { ReactElement } from 'react';

export function listSkeleton(label: string, rows = 3): ReactElement {
  return (
    <ul data-list-skeleton="" aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} aria-hidden="true" className="flex min-h-[44px] items-center gap-3 px-1">
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-panel-2" />
          <span className="h-3.5 w-32 animate-pulse rounded bg-panel-2" />
        </li>
      ))}
    </ul>
  );
}
