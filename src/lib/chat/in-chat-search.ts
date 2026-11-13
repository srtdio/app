// Search inside one chat (13 Nov 2026, WhatsApp's way): the bar becomes a
// search box, hits are the chat's own messages newest first (chat_message_search
// with p_channel_id, the whole history, keyset pages), the step bar walks them:
// up = an older hit, down = a newer one. Pure pieces only; the hook lives in
// components/chat/ChatSearch.tsx.

/** Where the walk stands: the loaded hits (newest first) and the current one. */
export interface StepState {
  /** Hits loaded so far, newest first. */
  count: number;
  /** Index of the current hit in the loaded hits; -1 while none. */
  index: number;
  /** More (older) pages exist on the server. */
  hasMore: boolean;
}

/** The step bar's words: "4 of 28", "4 of 30+" while older pages wait; '' until a hit. Pure. */
export function stepLabel(s: StepState): string {
  if (s.index < 0 || s.count === 0) return s.count === 0 && !s.hasMore ? '0 of 0' : '';
  return `${s.index + 1} of ${s.count}${s.hasMore ? '+' : ''}`;
}

/** Up (an older hit) works while one is loaded or another page waits. Pure. */
export function canStepOlder(s: StepState): boolean {
  return s.index >= 0 && (s.index + 1 < s.count || s.hasMore);
}

/** Down (a newer hit) works past the newest. Pure. */
export function canStepNewer(s: StepState): boolean {
  return s.index > 0;
}

/** The placeholder: "Search in <chat name>". Pure. */
export function searchPlaceholder(chatName: string): string {
  const name = chatName.trim();
  return name === '' ? 'Search in this chat' : `Search in ${name}`;
}
