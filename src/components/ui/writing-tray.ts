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

const COLS = ['grid-cols-1', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'] as const;
const MD_COLS = [
  'md:grid-cols-1',
  'md:grid-cols-1',
  'md:grid-cols-2',
  'md:grid-cols-3',
  'md:grid-cols-4',
  'md:grid-cols-5',
  'md:grid-cols-6',
  'md:grid-cols-7',
  'md:grid-cols-8',
  'md:grid-cols-9',
  'md:grid-cols-10',
] as const;

/**
 * Grid columns for a tray of `count` tiles: a column per tile (3 tiles: 3
 * columns, never an empty fourth). A phone fits four 44 tiles across, so a
 * longer tray (chat's 7 or 8) wraps at four there and takes one row from md
 * up. Pure.
 */
export function trayColumnsClass(count: number): string {
  const n = Math.max(1, Math.round(count));
  const base = COLS[Math.min(n, COLS.length - 1)] ?? 'grid-cols-4';
  const wide = MD_COLS[Math.min(n, MD_COLS.length - 1)] ?? 'md:grid-cols-4';
  return `${base} ${wide}`;
}
