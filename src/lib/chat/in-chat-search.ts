// Search inside one chat (13 Nov 2026, WhatsApp's way): the bar becomes a
// search box, hits are the chat's own messages newest first (chat_message_search
// with p_channel_id, the whole history, keyset pages), the step bar walks them:
// up = an older hit, down = a newer one. Pure pieces only; the hook lives in
// components/chat/ChatSearch.tsx.

import { queryWords } from '@/lib/chat/search';

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

/** One row a thread's search reads: its message id and its shown text. */
export interface SearchableRow {
  id: string;
  text: string;
}

/**
 * Search inside a thread (13 Nov 2026): the rows on screen that hold every
 * query word as the start of one of their words (the highlight's own rule),
 * newest first. `rows` come oldest first (screen order). Under 2 characters:
 * no hits. Pure.
 */
export function localHits(rows: readonly SearchableRow[], query: string): string[] {
  const asked = queryWords(query);
  if (query.trim().length < 2 || asked.length === 0) return [];
  const hits: string[] = [];
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at];
    if (row === undefined) continue;
    const words = queryWords(row.text);
    if (asked.every((q) => words.some((w) => w.startsWith(q)))) hits.push(row.id);
  }
  return hits;
}
