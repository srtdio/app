// React issue #11538 workaround. Browser Translate and extensions move or
// replace text nodes React owns; React's next removeChild/insertBefore then
// throws NotFoundError and the root error boundary takes over the app
// (Sentry FRONTEND-N). Installed once at boot, before the first render: a
// call on a node that is no longer a child is absorbed instead of thrown.
// Normal calls go straight to the originals. Translation keeps working.

let installed = false;
let warned = false;

type DomOp = 'removeChild' | 'insertBefore';

function warnOnce(op: DomOp): void {
  if (warned) return;
  warned = true;
  // Lazy: the logger pulls in Sentry, which the guest path does not load.
  void import('@/lib/logger')
    .then(({ logger }) => logger.warn('dom: foreign node mutation', { op }))
    .catch(() => undefined);
}

export function installDomMutationGuard(): void {
  if (installed || typeof Node === 'undefined') return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  const originalInsertBefore = Node.prototype.insertBefore;

  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      warnOnce('removeChild');
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  Node.prototype.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (child !== null && child.parentNode !== this) {
      warnOnce('insertBefore');
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, child) as T;
  };
}
