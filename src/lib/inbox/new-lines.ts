// "New" and "New reply" lines on comments (13 Nov 2026): posts, briefs, Plan
// items and Bank ideas. "New" sits above the first unread top-level comment;
// "New reply" sits above each older top-level comment whose thread holds an
// unread reply. The marks come from the unread targets the shell already
// holds (useEntityNewMarks), so the lines paint with the comments, no wait.
// The screen opens on the first line, top to bottom.

import { useState, type RefObject } from 'react';
import { useFocusTarget } from '@/lib/focus-target';
import type { NewMarks } from '@/lib/inbox/unread-entities';

/** The pill's words. */
export type NewLineLabel = 'New' | 'New reply';

/** One top-level comment as the line placement needs it. */
export interface NewLineRoot {
  id: string;
  authorId: string | null;
  createdAt: string;
}

/** Epoch ms of a Postgres or ISO time; fractions cut to ms (WebKit-safe). Pure. */
function ms(at: string): number {
  const iso = at
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Which top-level comments get a line above them, in list order. "New": the
 * first root by someone else at or after firstNewAt. "New reply": every root
 * listed in replyRootIds that sits above the "New" line (below it, the root is
 * already under "New"). My own roots never take "New". Pure.
 */
export function newLinePlaces(
  roots: readonly NewLineRoot[],
  me: string | null,
  marks: NewMarks | null,
): ReadonlyMap<string, NewLineLabel> {
  const out = new Map<string, NewLineLabel>();
  if (marks === null) return out;
  const from = marks.firstNewAt !== null ? ms(marks.firstNewAt) : Number.NaN;
  let newAt = roots.length;
  if (!Number.isNaN(from)) {
    const i = roots.findIndex((r) => r.authorId !== me && ms(r.createdAt) >= from);
    if (i >= 0) newAt = i;
  }
  const replyRoots = new Set(marks.replyRootIds);
  for (let i = 0; i < newAt; i += 1) {
    const root = roots[i];
    if (root !== undefined && replyRoots.has(root.id)) out.set(root.id, 'New reply');
  }
  const first = roots[newAt];
  if (first !== undefined) out.set(first.id, 'New');
  return out;
}

/** The landing's key (one line target per screen). */
const NEW_LINE_TARGET = 'new-line';

/** No tint on a New line landing: the line itself is the signal. */
const NO_TINT = (): (() => void) => () => undefined;

/**
 * Open on the first New line, once per screen open: when the comments are in,
 * the unread targets are known and no comment link is landing, the first line
 * is centred in its scroller through the shared comment landing
 * (useFocusTarget: kept centred while images and rows settle, stops at the
 * first touch), without the tint. Decided once per open, so a comment landing
 * live never moves the page. Reads nothing; never waits.
 */
export function useLandOnNewLine(
  listRef: RefObject<HTMLElement>,
  options: { ready: boolean; hasLines: boolean; linked: boolean },
): void {
  const [land, setLand] = useState<boolean | null>(null);
  const { ready, hasLines, linked } = options;
  if (land === null && ready) setLand(hasLines && !linked);
  useFocusTarget({
    targetId: land === true ? NEW_LINE_TARGET : null,
    findElement: () => listRef.current?.querySelector<HTMLElement>('[data-new-line]') ?? null,
    onMissing: () => undefined,
    highlight: NO_TINT,
  });
}
