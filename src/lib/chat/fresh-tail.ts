// Which message rows play itemIn (docs/motion.md, move 6): only messages that
// arrive after the thread's first paint (sent or received) and land at the
// tail, after the newest row the reader already had. Never the first paint,
// a kept or cached thread, an older page prepended above, or a switch to
// another chat (the old newest row is gone). Pure, so the rule is unit tested.

/**
 * The ids to animate in: fresh keys (useFreshKeys) after the previous newest
 * id. Empty when there was no previous list or its newest row is not in this
 * one (first load, another chat).
 */
export function freshTailIds(
  prev: readonly string[] | null,
  ids: readonly string[],
  fresh: ReadonlySet<string>,
): string[] {
  if (prev === null || fresh.size === 0) return [];
  const lastPrev = prev[prev.length - 1];
  if (lastPrev === undefined) return [];
  const at = ids.indexOf(lastPrev);
  if (at < 0) return [];
  return ids.slice(at + 1).filter((id) => fresh.has(id));
}
