import { describe, expect, it } from 'vitest';
import { EMOJI_LIST } from '@/lib/chat/emoji-list';
import { EMOJI_NAMES, emojiLabel, searchEmoji } from '@/lib/chat/emoji-names';

describe('emoji names', () => {
  it('every emoji in every group has a non-empty lowercase entry', () => {
    for (const group of EMOJI_LIST) {
      for (const emoji of group.emoji) {
        const words = EMOJI_NAMES[emoji];
        expect(words, `${group.name} ${emoji}`).toBeDefined();
        expect(words?.trim(), `${group.name} ${emoji}`).not.toBe('');
        expect(words, `${group.name} ${emoji}`).toBe(words?.toLowerCase());
      }
    }
  });

  it('has no entry for a glyph the list does not hold', () => {
    const listed = new Set(EMOJI_LIST.flatMap((g) => g.emoji));
    expect(Object.keys(EMOJI_NAMES).filter((e) => !listed.has(e))).toEqual([]);
  });

  it("searchEmoji('fire') includes 🔥", () => {
    expect(searchEmoji('fire', EMOJI_LIST)).toContain('🔥');
  });

  it('is case-insensitive and matches a word prefix', () => {
    expect(searchEmoji('FIR', EMOJI_LIST)).toContain('🔥');
    expect(searchEmoji('thumb', EMOJI_LIST)).toEqual(['👍', '👎']);
    // "ire" is inside "fire" but starts no word.
    expect(searchEmoji('ire', EMOJI_LIST)).not.toContain('🔥');
  });

  it('every typed word must match', () => {
    expect(searchEmoji('red heart', EMOJI_LIST)).toEqual(['❤️']);
  });

  it('an empty or blank query finds nothing', () => {
    expect(searchEmoji('', EMOJI_LIST)).toEqual([]);
    expect(searchEmoji('   ', EMOJI_LIST)).toEqual([]);
  });

  it('keeps group order and never repeats a glyph', () => {
    const twice = [...EMOJI_LIST, ...EMOJI_LIST];
    expect(searchEmoji('love', twice)).toEqual(searchEmoji('love', EMOJI_LIST));
  });

  it('emojiLabel is the first keyword, else the glyph', () => {
    expect(emojiLabel('🔥')).toBe('fire');
    expect(emojiLabel('🦄')).toBe('🦄');
  });
});
