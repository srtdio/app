import { useCallback, useEffect, useRef } from 'react';
import { useOptionalToast } from '@/components/ui/toast';
import type { ToastApi, ToastOptions } from '@/components/ui/toast/types';
import { logger } from '@/lib/logger';

/** How long an Undo toast stays up before the action commits. The single source. */
export const UNDO_WINDOW_MS = 7000;

export interface UndoableAction {
  /** Toast title, e.g. "Post deleted". Also forms the default failure copy. */
  label: string;
  /** The failure toast's title when the commit fails. Default: undoFailureTitle(label). */
  failure?: string;
  /** The real write. Runs at most once: on expire, X, or flush; never after Undo. */
  commit: () => Promise<void> | void;
  /** Put the optimistic UI back. Runs on Undo and when commit fails. */
  revert?: () => void;
  /** The toast's tone (a success-tinted toast for an approval tick). */
  tone?: ToastOptions['tone'];
}

interface Pending {
  action: UndoableAction;
  settled: boolean;
  toastId: string | null;
}

// Past participles an Undo label ends a noun with ("Task deleted"), and the
// verb the failure copy needs ("Couldn't delete the task.").
const PARTICIPLE_VERB: Readonly<Record<string, string>> = {
  deleted: 'delete',
  removed: 'remove',
  archived: 'archive',
  restored: 'restore',
  moved: 'move',
  parked: 'park',
  rejected: 'reject',
  approved: 'approve',
  marked: 'mark',
  hidden: 'hide',
  closed: 'close',
  cleared: 'clear',
  sent: 'send',
  pinned: 'pin',
  unpinned: 'unpin',
  starred: 'star',
  unstarred: 'unstar',
  muted: 'mute',
  unmuted: 'unmute',
};

/**
 * Failure toast copy: "Couldn't {verb}. Try again." Never the raw error. A
 * done-label reads as its verb ("Task deleted" -> "Couldn't delete the task.",
 * "3 posts moved to Review" -> "Couldn't move 3 posts to Review.", "Marked as
 * read" -> "Couldn't mark as read."); an imperative label is the verb already
 * ("Archive Brief" -> "Couldn't archive brief."). Pure.
 */
export function undoFailureTitle(label: string): string {
  const words = label
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const at = words.findIndex((w) => PARTICIPLE_VERB[w.toLowerCase()] !== undefined);
  const verb = at >= 0 ? PARTICIPLE_VERB[(words[at] ?? '').toLowerCase()] : undefined;
  if (at < 0 || verb === undefined) return `Couldn't ${label.trim().toLowerCase()}. Try again.`;
  const subject = words.slice(0, at).join(' ').toLowerCase();
  const rest = words.slice(at + 1).join(' ');
  const object = subject === '' ? '' : /^\d/.test(subject) ? ` ${subject}` : ` the ${subject}`;
  return `Couldn't ${verb}${object}${rest !== '' ? ` ${rest}` : ''}. Try again.`;
}

/**
 * Deferred commit behind an Undo toast. The caller applies its optimistic UI,
 * then calls run(); the toast shows "Undo" with a countdown. Undo reverts and
 * the commit never runs; expiry or closing the toast commits once. Pending
 * commits flush immediately on unmount, on visibilitychange to hidden, and on
 * pagehide, so navigating away never loses them.
 */
export function useUndoableAction(): {
  run: (action: UndoableAction) => void;
  flush: () => void;
} {
  const toast = useOptionalToast();
  const toastRef = useRef<ToastApi | null>(toast);
  toastRef.current = toast;
  const pendingRef = useRef(new Set<Pending>());

  const commit = useCallback((entry: Pending): void => {
    if (entry.settled) return;
    entry.settled = true;
    pendingRef.current.delete(entry);
    const { label, revert, failure } = entry.action;
    const fail = (err: unknown): void => {
      logger.warn('undoable action commit failed', { label, error: String(err) });
      revert?.();
      toastRef.current?.show({ title: failure ?? undoFailureTitle(label) });
    };
    try {
      void Promise.resolve(entry.action.commit()).catch(fail);
    } catch (err: unknown) {
      fail(err);
    }
  }, []);

  const undo = useCallback((entry: Pending): void => {
    if (entry.settled) return;
    entry.settled = true;
    pendingRef.current.delete(entry);
    entry.action.revert?.();
  }, []);

  const flush = useCallback((): void => {
    for (const entry of [...pendingRef.current]) {
      commit(entry);
      if (entry.toastId !== null) toastRef.current?.dismiss(entry.toastId);
    }
  }, [commit]);

  const run = useCallback(
    (action: UndoableAction): void => {
      const entry: Pending = { action, settled: false, toastId: null };
      const api = toastRef.current;
      if (api === null) {
        // No toast surface means no way to undo: commit straight away.
        commit(entry);
        return;
      }
      pendingRef.current.add(entry);
      entry.toastId = api.show({
        title: action.label,
        ...(action.tone !== undefined ? { tone: action.tone } : {}),
        action: { label: 'Undo', onPress: () => undo(entry) },
        durationMs: UNDO_WINDOW_MS,
        countdown: true,
        onExpire: () => commit(entry),
      });
    },
    [commit, undo],
  );

  useEffect(() => {
    function onVisibility(): void {
      if (document.visibilityState === 'hidden') flush();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  return { run, flush };
}
