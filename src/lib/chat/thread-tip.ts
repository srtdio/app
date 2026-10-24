// The thread's one-time tip (H6): "Tip: press and hold a message to reply,
// copy or delete." shown above the composer until the user taps Got it, once
// per user. The flag lives in localStorage; every read and write is in a
// try/catch. When storage throws (private mode, quota, blocked), the tip is
// shown once per page load instead: the first chat that shows it marks it
// shown in memory, so later chats in the same load stay quiet.

/** The slice of Web Storage the tip uses (localStorage, or a test fake). */
export interface TipStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const HOLD_TIP_TEXT = 'Tip: press and hold a message to reply, copy or delete.';
/** The laptop wording: a mouse right-clicks instead of holding. */
export const HOLD_TIP_TEXT_LAPTOP = 'Tip: right-click a message to reply, copy or delete.';
export const HOLD_TIP_DISMISS = 'Got it';

/** The per-user storage key. Pure. */
export function holdTipKey(userId: string): string {
  return `srtd:chat:holdTip:${userId}`;
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

/** The tip painted: under a failing storage it will not show again this load. */
export function noteHoldTipShown(
  userId: string,
  storage: TipStorage | null = defaultStorage(),
): void {
  if (readSeen(userId, storage) === null) shownWithoutStorage.add(userId);
}

/** Got it: never again for this user (best effort on storage; always for this load). */
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
