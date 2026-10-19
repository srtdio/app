// The one-time caption tip under the caption: "Tip: select caption text to
// comment on it." with Got it. Dismissed per user in localStorage. Every read
// and write is wrapped, so a browser that refuses storage (private mode, a
// full quota) never throws; it just shows the tip once per page load.

export const CAPTION_TIP_TEXT = 'Tip: select caption text to comment on it.';

/** The minimal storage shape (window.localStorage, or a test double). */
export interface TipStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function captionTipKey(userId: string | null): string {
  return `sorted:caption-tip:${userId ?? 'anon'}`;
}

/** window.localStorage, or null when touching it throws or there is no window. */
function defaultStorage(): TipStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when this user dismissed the tip before. A failing storage reads false. */
export function captionTipDismissed(
  userId: string | null,
  storage: TipStorage | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(captionTipKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** Remember the dismissal. A failing storage is ignored (the tip returns next load). */
export function dismissCaptionTip(
  userId: string | null,
  storage: TipStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(captionTipKey(userId), '1');
  } catch {
    // Storage refused: the in-memory state already hides the tip for this load.
  }
}
