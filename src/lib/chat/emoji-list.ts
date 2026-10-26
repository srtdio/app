// The composer's emoji grid on a laptop: a small static curated list (about 200
// common emoji in 6 groups). Glyphs render as text in the app's emoji font
// stack: no emoji package, no images, no word search. Recents (16, newest
// first, de-duplicated) live in localStorage behind try/catch, so blocked
// storage only loses the recents row.

/** One group of the grid. */
interface EmojiListGroup {
  name: string;
  emoji: readonly string[];
}

/** The curated groups, in grid order. */
export const EMOJI_LIST: readonly EmojiListGroup[] = [
  {
    name: 'Smileys',
    emoji: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '😂',
      '🤣',
      '😊',
      '😇',
      '🙂',
      '🙃',
      '😉',
      '😌',
      '😍',
      '🥰',
      '😘',
      '😗',
      '😋',
      '😛',
      '😜',
      '🤪',
      '😝',
      '🤗',
      '🤭',
      '🤫',
      '🤔',
      '🤐',
      '🤨',
      '😐',
      '😑',
      '😶',
      '😏',
      '😒',
      '🙄',
      '😬',
      '😮‍💨',
      '😴',
      '😷',
      '🤒',
      '🤯',
      '🥳',
      '😎',
      '🤓',
      '🧐',
      '😕',
      '😟',
      '🙁',
      '😮',
      '😲',
      '😳',
      '🥺',
      '😢',
      '😭',
      '😱',
      '😖',
      '😤',
      '😡',
      '🤬',
      '😈',
    ],
  },
  {
    name: 'Gestures',
    emoji: [
      '👍',
      '👎',
      '👌',
      '🤌',
      '✌️',
      '🤞',
      '🤟',
      '🤘',
      '🤙',
      '👈',
      '👉',
      '👆',
      '👇',
      '☝️',
      '👋',
      '🤚',
      '✋',
      '🖐️',
      '🖖',
      '👏',
      '🙌',
      '👐',
      '🤲',
      '🤝',
      '🙏',
      '✍️',
      '💪',
      '🫶',
      '👀',
      '🧠',
    ],
  },
  {
    name: 'Hearts',
    emoji: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '🤍',
      '🤎',
      '💔',
      '❤️‍🔥',
      '💕',
      '💞',
      '💓',
      '💗',
      '💖',
      '💘',
      '💝',
      '💯',
      '💢',
      '💥',
      '💫',
      '💦',
      '💬',
      '✨',
      '⭐',
      '🌟',
      '🔥',
      '⚡',
      '🎉',
    ],
  },
  {
    name: 'Work',
    emoji: [
      '✅',
      '☑️',
      '✔️',
      '❌',
      '❎',
      '⚠️',
      '❗',
      '❓',
      '⏰',
      '⏳',
      '📅',
      '📆',
      '🗓️',
      '📌',
      '📍',
      '📎',
      '🖇️',
      '📝',
      '✏️',
      '🖊️',
      '📁',
      '📂',
      '🗂️',
      '📊',
      '📈',
      '📉',
      '📋',
      '📣',
      '📢',
      '🔔',
      '🔕',
      '💡',
      '🔍',
      '🔗',
      '🔒',
      '🔓',
      '🏷️',
      '💼',
      '🧾',
      '💰',
    ],
  },
  {
    name: 'Media',
    emoji: [
      '📷',
      '📸',
      '📹',
      '🎥',
      '🎬',
      '🎞️',
      '📺',
      '📱',
      '💻',
      '🖥️',
      '⌨️',
      '🖱️',
      '🎨',
      '🖌️',
      '🖼️',
      '🎵',
      '🎶',
      '🎤',
      '🎧',
      '🎙️',
      '📰',
      '🗞️',
      '📖',
      '📚',
      '🔖',
      '✉️',
      '📧',
      '📨',
      '📩',
      '📤',
    ],
  },
  {
    name: 'Things',
    emoji: [
      '☕',
      '🍵',
      '🍕',
      '🍔',
      '🍟',
      '🌮',
      '🍰',
      '🎂',
      '🍪',
      '🍫',
      '🍿',
      '🥂',
      '🍻',
      '🍾',
      '🎁',
      '🎈',
      '🏆',
      '🥇',
      '🚀',
      '✈️',
      '🚗',
      '🏠',
      '🌍',
      '☀️',
      '🌙',
      '🌈',
      '☔',
      '❄️',
      '🌸',
      '🌻',
    ],
  },
];

/** How many recents the grid keeps. */
export const EMOJI_RECENTS_MAX = 16;

/** The localStorage key for the recents row. */
export const EMOJI_RECENTS_KEY = 'srtd.chat.emoji-recents';

/** Minimal storage surface (localStorage, or a test fake). */
export interface RecentsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

/** A pick goes first; an earlier copy is dropped; the row is capped at 16. Pure. */
export function pushRecent(recents: readonly string[], emoji: string): string[] {
  return [emoji, ...recents.filter((e) => e !== emoji)].slice(0, EMOJI_RECENTS_MAX);
}

function defaultStorage(): RecentsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored recents; empty when storage is missing, throws, or holds junk. */
export function readRecents(storage: RecentsStorage | null = defaultStorage()): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(EMOJI_RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is string => typeof e === 'string' && e !== '')
      .slice(0, EMOJI_RECENTS_MAX);
  } catch {
    return [];
  }
}

/** Record a pick and return the new row; a throwing storage keeps it in memory only. */
export function rememberRecent(
  emoji: string,
  storage: RecentsStorage | null = defaultStorage(),
): string[] {
  const next = pushRecent(readRecents(storage), emoji);
  if (storage === null) return next;
  try {
    storage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Blocked or full storage: the pick still inserts; only the row is not kept.
  }
  return next;
}

/** Sign-out: forget the recents row. Never throws. */
export function clearEmojiRecents(storage: RecentsStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    if (storage.removeItem !== undefined) storage.removeItem(EMOJI_RECENTS_KEY);
    else storage.setItem(EMOJI_RECENTS_KEY, '[]');
  } catch {
    // Blocked storage has nothing to clear.
  }
}

/**
 * Insert text at the textarea selection and return the new value plus the
 * caret just after the insert (a selected range is replaced). Pure.
 */
export function insertAtCaret(
  value: string,
  selection: { start: number; end: number },
  insert: string,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  return { value: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length };
}
