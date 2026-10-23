// The deferred reject / park commit (FB6). The post page shows the new stage
// behind an Undo toast; when the window ends this runs the real move. The page
// may already be gone by then (the undo hook flushes on unmount, on
// visibilitychange to hidden and on pagehide), so every outcome is reported
// through the APP-WIDE toast, which outlives the page, and never only through
// state the page owns. The commit never throws: a refusal and a thrown network
// error take the same path, so the undo hook's own failure toast (which fires
// only on a throw) never doubles the one shown here.
//
// Pure apart from the injected deps, so the paths are unit tested without a
// DOM: refused after unmount, refused while hidden, thrown while on the page.

import type { Stage } from '@srtdio/posts';

/** The slice of the app-wide ToastApi this commit needs. */
export interface StageMoveToast {
  show: (options: {
    title: string;
    tone?: 'error';
    action?: { label: string; onPress: () => void };
  }) => unknown;
}

/** The slice of `document` the hidden-page hold needs (tests pass a fake). */
export interface VisibilityDoc {
  visibilityState: string;
  addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
}

/**
 * Run `show` now, or, when the document is hidden (the phone switched apps
 * while the flushed request was in flight), hold it and run it once on the
 * next visibilitychange to visible, so the toast is seen rather than expiring
 * behind a hidden tab.
 */
export function showWhenVisible(doc: VisibilityDoc, show: () => void): void {
  if (doc.visibilityState !== 'hidden') {
    show();
    return;
  }
  const onChange = (): void => {
    if (doc.visibilityState === 'hidden') return;
    doc.removeEventListener('visibilitychange', onChange);
    show();
  };
  doc.addEventListener('visibilitychange', onChange);
}

const VERB: Partial<Record<Stage, string>> = { rejected: 'reject', parked: 'park' };
const DONE: Partial<Record<Stage, string>> = { rejected: 'Rejected', parked: 'Parked' };

/** "Couldn't reject {title}. It's still in review." Pure. */
export function stageMoveFailureTitle(to: Stage, postTitle: string, fromStage: Stage): string {
  return `Couldn't ${VERB[to] ?? 'move'} ${postTitle}. It's still in ${fromStage}.`;
}

/** "Rejected, but your reason didn't post." Pure. */
export function reasonFailureTitle(to: Stage): string {
  return `${DONE[to] ?? 'Moved'}, but your reason didn't post.`;
}

export interface StageMoveCommitDeps {
  to: Stage;
  /** The stage the post is still in if the move is refused. */
  fromStage: Stage;
  postTitle: string;
  /** The typed reason, posted as a comment after a landed move; null when none. */
  reason: string | null;
  /** The stage RPC. A refusal is `{ ok: false }`; a transport failure may throw. */
  transition: () => Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** The reason comment write. May throw. */
  postReason: (body: string) => Promise<{ ok: boolean }>;
  /** True while the page still shows this post. */
  stillHere: () => boolean;
  /** Put the optimistic stage back (only called while still here). */
  revert: () => void;
  /** The inline error under the stage buttons (only called while still here). */
  setInlineError: (message: string) => void;
  /** The friendly line for a refusal or a thrown error; never the raw text. */
  friendlyError: (error: unknown) => string;
  /** Refresh the page after a landed move (only called while still here). */
  afterSuccess: () => Promise<void> | void;
  /** The app-wide toast; null when there is none (nothing to show). */
  toast: StageMoveToast | null;
  /** The failure toast's "Open" action: navigate to the post. */
  openPost: () => void;
  doc: VisibilityDoc;
  log: (message: string, data: Record<string, unknown>) => void;
}

/**
 * The commit. On any refusal or thrown error: revert and set the inline error
 * if the page is still here, and ALWAYS show the app-wide failure toast with
 * Open (held while the document is hidden). A landed move whose reason comment
 * fails shows the reason toast the same way. Resolves normally in every case.
 */
export async function runStageMoveCommit(deps: StageMoveCommitDeps): Promise<void> {
  const openAction = { label: 'Open', onPress: deps.openPost };
  const fail = (error: unknown): void => {
    deps.log('post page: stage move commit failed', { to: deps.to, error: String(error) });
    if (deps.stillHere()) {
      deps.revert();
      deps.setInlineError(deps.friendlyError(error));
    }
    const title = stageMoveFailureTitle(deps.to, deps.postTitle, deps.fromStage);
    showWhenVisible(deps.doc, () => {
      deps.toast?.show({ title, tone: 'error', action: openAction });
    });
  };

  let result: { ok: true } | { ok: false; error: unknown };
  try {
    result = await deps.transition();
  } catch (error: unknown) {
    fail(error);
    return;
  }
  if (!result.ok) {
    fail(result.error);
    return;
  }

  if (deps.reason !== null) {
    let posted = false;
    try {
      posted = (await deps.postReason(deps.reason)).ok;
    } catch (error: unknown) {
      deps.log('post page: stage reason comment threw', { error: String(error) });
      posted = false;
    }
    if (!posted) {
      deps.log('post page: stage reason comment failed', { to: deps.to });
      const title = reasonFailureTitle(deps.to);
      showWhenVisible(deps.doc, () => {
        deps.toast?.show({ title, tone: 'error', action: openAction });
      });
    }
  }

  if (!deps.stillHere()) return;
  try {
    await deps.afterSuccess();
  } catch (error: unknown) {
    deps.log('post page: refresh after stage move failed', { error: String(error) });
  }
}
