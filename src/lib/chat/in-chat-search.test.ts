import { describe, expect, it } from 'vitest';
import {
  canStepNewer,
  canStepOlder,
  localHits,
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

describe('search inside a thread: hits from the rows on screen (13 Nov 2026)', () => {
  const rows = [
    { id: 'root', text: 'Can we open on the product, not the team?' },
    { id: 'r1', text: 'Yes, the hero shot goes first.' },
    { id: 'r2', text: 'Swapped it in the cut. Shot list.pdf' },
  ];

  it('returns the rows holding every word as a word start, newest first', () => {
    expect(localHits(rows, 'the')).toEqual(['r2', 'r1', 'root']);
    expect(localHits(rows, 'sho')).toEqual(['r2', 'r1']);
    expect(localHits(rows, 'hero first')).toEqual(['r1']);
    expect(localHits(rows, 'HERO')).toEqual(['r1']);
  });

  it('matches file names and never a word middle', () => {
    expect(localHits(rows, 'list')).toEqual(['r2']);
    expect(localHits(rows, 'ero')).toEqual([]);
  });

  it('asks nothing under 2 characters', () => {
    expect(localHits(rows, 't')).toEqual([]);
    expect(localHits(rows, '  ')).toEqual([]);
  });
});
