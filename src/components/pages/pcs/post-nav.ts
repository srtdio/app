// Where the post page's Back goes (FT13): one step back when there is in-app
// history to return to, else the pipeline. React Router keeps the history
// index in history.state.idx (0 on the entry the app was opened on); a null
// or foreign state (a cold deep link) has no in-app history. Pure.

export function hasInAppHistory(historyState: unknown): boolean {
  if (typeof historyState !== 'object' || historyState === null) return false;
  const idx = (historyState as { idx?: unknown }).idx;
  return typeof idx === 'number' && idx > 0;
}
