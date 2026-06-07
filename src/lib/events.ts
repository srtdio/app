/**
 * Cross-cutting shell actions are decoupled from their handlers via generic
 * window CustomEvents. The shell only dispatches; feature PRs (E/F and later)
 * attach the listeners. Names are generic, never tied to a specific bridge.
 */
export type SortedEventName =
  | 'sorted:create-post'
  | 'sorted:create-brief'
  | 'sorted:switch-workspace'
  | 'sorted:signout';

export function dispatchSorted(name: SortedEventName): void {
  window.dispatchEvent(new CustomEvent(name));
}
