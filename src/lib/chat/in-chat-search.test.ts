import { describe, expect, it } from 'vitest';
import {
  canStepNewer,
  canStepOlder,
  searchPlaceholder,
  stepLabel,
} from '@/lib/chat/in-chat-search';

describe('search inside a chat: the step bar (13 Nov 2026)', () => {
  it('counts the current hit over the loaded hits, "+" while older pages wait', () => {
    expect(stepLabel({ count: 28, index: 3, hasMore: false })).toBe('4 of 28');
    expect(stepLabel({ count: 30, index: 0, hasMore: true })).toBe('1 of 30+');
    expect(stepLabel({ count: 0, index: -1, hasMore: false })).toBe('0 of 0');
    expect(stepLabel({ count: 0, index: -1, hasMore: true })).toBe('');
  });

  it('up walks to an older hit (or the next page), down to a newer one', () => {
    expect(canStepOlder({ count: 3, index: 0, hasMore: false })).toBe(true);
    expect(canStepOlder({ count: 3, index: 2, hasMore: false })).toBe(false);
    expect(canStepOlder({ count: 3, index: 2, hasMore: true })).toBe(true);
    expect(canStepOlder({ count: 0, index: -1, hasMore: false })).toBe(false);
    expect(canStepNewer({ count: 3, index: 0, hasMore: false })).toBe(false);
    expect(canStepNewer({ count: 3, index: 2, hasMore: false })).toBe(true);
  });

  it('the field names the chat', () => {
    expect(searchPlaceholder('Launch crew')).toBe('Search in Launch crew');
    expect(searchPlaceholder('  ')).toBe('Search in this chat');
  });
});
