// The + tray's place in ui/WritingBox: the tray (chat/ComposerTray, compact)
// opens as the top of the writing box it sits in, inside the box's one
// outline. The box owns whether the tray is open (so the + can move between
// the pill and the card without its tray closing) and the slot node the tray
// draws into. Outside a writing box there is no context and the tray keeps
// its own state.

import { createContext } from 'react';

export interface WritingTray {
  /** The tray shows (open, or still sliding out). */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The box's tray slot: the top of the box, above the text. */
  slot: HTMLElement | null;
}

export const WritingTrayContext = createContext<WritingTray | null>(null);

/** Grid columns for a tray of `count` tiles: one row, one column per tile. Pure. */
export function trayColumnsClass(count: number): string {
  const cols = [
    'grid-cols-1',
    'grid-cols-1',
    'grid-cols-2',
    'grid-cols-3',
    'grid-cols-4',
    'grid-cols-5',
    'grid-cols-6',
    'grid-cols-7',
    'grid-cols-8',
    'grid-cols-9',
    'grid-cols-10',
  ];
  return cols[Math.min(Math.max(count, 0), cols.length - 1)] ?? 'grid-cols-4';
}
