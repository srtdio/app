// Catch up's thread tip (10 Nov 2026): gone for good on Got it, on the first
// thread opened from a card, or after 3 catch-up opens showed it (once per
// open). Per user in localStorage (the chat hold tip's pattern); a failing
// storage falls back to once per page load.

import type { TipStorage } from '@/lib/chat/thread-tip';

export const THREAD_TIP_TEXT = 'Tap a message to reply in thread.';
export const THREAD_TIP_TEXT_LAPTOP = 'Click a message to reply in thread.';
export const COMMENT_TIP_TEXT = 'Tap a comment to reply to it.';
export const COMMENT_TIP_TEXT_LAPTOP = 'Click a comment to reply to it.';
export const THREAD_TIP_MAX_SHOWS = 3;

/** A card's words family: chat cards say thread, every other card says comment. Pure. */
export function wordsFamily(kind: string): 'chat' | 'comment' {
  return kind === 'chat-main' || kind === 'chat-thread' ? 'chat' : 'comment';
}

/** The tip's text by family and width. Pure. */
export function tipText(family: 'chat' | 'comment', laptop: boolean): string {
  if (family === 'chat') return laptop ? THREAD_TIP_TEXT_LAPTOP : THREAD_TIP_TEXT;
  return laptop ? COMMENT_TIP_TEXT_LAPTOP : COMMENT_TIP_TEXT;
}

const goneThisLoad = new Set<string>();
const keyOf = (userId: string): string => `srtd:catchUp:threadTip:${userId}`;

function safe<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}
const local = (): TipStorage | null => safe(() => window.localStorage);
const read = (userId: string, storage: TipStorage | null): string | null =>
  safe(() => storage?.getItem(keyOf(userId)) ?? null);

/** Whether the tip may show on this catch-up open. */
export function threadTipVisible(userId: string, storage = local()): boolean {
  if (userId === '' || goneThisLoad.has(userId)) return false;
  const got = read(userId, storage);
  return got !== 'done' && Number(got ?? 0) < THREAD_TIP_MAX_SHOWS;
}

/** It showed on this open (once per open). */
export function noteThreadTipShown(userId: string, storage = local()): void {
  const got = read(userId, storage);
  if (got === 'done') return;
  safe(() => storage?.setItem(keyOf(userId), String(Number(got ?? 0) + 1)));
  if (read(userId, storage) === null) goneThisLoad.add(userId);
}

/** Got it, or a thread opened from a card: never again. */
export function dismissThreadTip(userId: string, storage = local()): void {
  goneThisLoad.add(userId);
  safe(() => storage?.setItem(keyOf(userId), 'done'));
}

/** Test seam. */
export const resetThreadTip = (): void => goneThisLoad.clear();
