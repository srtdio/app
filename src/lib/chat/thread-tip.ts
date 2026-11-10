// The thread's tip (H6, 10 Nov 2026): "Tap a message to reply in thread."
// above the composer. It goes for good on Got it, on the first thread the user
// opens, or after it has shown in 3 chat opens (counted once per open). The flag lives in localStorage; every read and write is in a
// try/catch. When storage throws (private mode, quota, blocked), the tip is
// shown once per page load instead: the first chat that shows it marks it
// shown in memory, so later chats in the same load stay quiet.

/** The slice of Web Storage the tip uses (localStorage, or a test fake). */
export interface TipStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const HOLD_TIP_TEXT = 'Tap a message to reply in thread.';
/** The laptop wording: a mouse clicks. */
export const HOLD_TIP_TEXT_LAPTOP = 'Click a message to reply in thread.';
/** Chat opens the tip shows in before it goes for good. */
export const HOLD_TIP_MAX_SHOWS = 3;
export const HOLD_TIP_DISMISS = 'Got it';

/** The per-user storage key. Pure. */
export function holdTipKey(userId: string): string {
  return `srtd:chat:holdTip:${userId}`;
}

/** The per-user shows counter key. Pure. */
export function holdTipShowsKey(userId: string): string {
  return `srtd:chat:holdTipShows:${userId}`;
}

// Users whose tip was dismissed this load, and users it was shown to while
// storage failed (the once-per-load fallback).
const dismissedThisLoad = new Set<string>();
const shownWithoutStorage = new Set<string>();

function defaultStorage(): TipStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Read the stored flag: true seen, false not seen, null storage failed. */
function readSeen(userId: string, storage: TipStorage | null): boolean | null {
  if (storage === null) return null;
  try {
    return storage.getItem(holdTipKey(userId)) === '1';
  } catch {
    return null;
  }
}

/** Whether the tip shows for this user now. */
export function shouldShowHoldTip(
  userId: string,
  storage: TipStorage | null = defaultStorage(),
): boolean {
  if (userId === '' || dismissedThisLoad.has(userId)) return false;
  const seen = readSeen(userId, storage);
  if (seen === null) return !shownWithoutStorage.has(userId);
  return !seen;
}

/**
 * The tip painted in one chat open (call once per open): the third show
 * retires it. Under a failing storage it will not show again this load.
 */
export function noteHoldTipShown(
  userId: string,
  storage: TipStorage | null = defaultStorage(),
): void {
  if (readSeen(userId, storage) === null || storage === null) {
    shownWithoutStorage.add(userId);
    return;
  }
  try {
    const shows = (Number(storage.getItem(holdTipShowsKey(userId))) || 0) + 1;
    storage.setItem(holdTipShowsKey(userId), String(shows));
    if (shows >= HOLD_TIP_MAX_SHOWS) storage.setItem(holdTipKey(userId), '1');
  } catch {
    shownWithoutStorage.add(userId);
  }
}

/** Got it, or the first thread opened: never again for this user (best effort on storage; always for this load). */
export function dismissHoldTip(
  userId: string,
  storage: TipStorage | null = defaultStorage(),
): void {
  dismissedThisLoad.add(userId);
  if (storage === null) return;
  try {
    storage.setItem(holdTipKey(userId), '1');
  } catch {
    // Storage refused: the in-memory flag keeps it hidden for this load.
  }
}

/** Test seam: forget the in-memory flags. */
export function resetHoldTip(): void {
  dismissedThisLoad.clear();
  shownWithoutStorage.clear();
}
