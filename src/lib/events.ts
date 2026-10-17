/**
 * Cross-cutting shell actions are decoupled from their handlers via generic
 * window CustomEvents. The shell only dispatches; feature PRs (E/F and later)
 * attach the listeners. Names are generic, never tied to a specific bridge.
 */
export type SortedEventName =
  | 'sorted:create-post'
  | 'sorted:create-brief'
  | 'sorted:switch-workspace'
  | 'sorted:signout'
  | 'sorted:workspace-data-changed'
  | 'sorted:inbox-changed';

export function dispatchSorted(name: SortedEventName): void {
  window.dispatchEvent(new CustomEvent(name));
}

/**
 * The signout event name as a value (the union above is types only). Listeners
 * that react to signout import this constant rather than hardcoding the string.
 */
export const SIGNOUT_EVENT: SortedEventName = 'sorted:signout';

/**
 * Rows in the active workspace changed outside the person's own actions (the
 * first tour's sample week landing or clearing): lists that fetched on mount
 * re-read. Dispatched with dispatchWorkspaceDataChanged, listened to with
 * useWorkspaceDataChanged (src/lib/use-workspace-data-changed.ts).
 */
export const WORKSPACE_DATA_CHANGED_EVENT: SortedEventName = 'sorted:workspace-data-changed';
export const INBOX_CHANGED_EVENT: SortedEventName = 'sorted:inbox-changed';

/** The workspace's rows changed under the open screens: lists and badges re-read. */
export function dispatchWorkspaceDataChanged(): void {
  dispatchSorted(WORKSPACE_DATA_CHANGED_EVENT);
  dispatchSorted(INBOX_CHANGED_EVENT);
}
