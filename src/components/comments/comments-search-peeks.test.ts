// Comments search (13 Nov 2026): every reply hit shows under its comment, not
// only the one the step bar stands on ("tweak" finds "tweaking" in a reply).
import { describe, expect, it } from 'vitest';
import type { ChatSearch } from '@/components/chat/ChatSearch';
import { peekReplies } from '@/components/comments/CommentsSearch';
import { localHits, searchRowsOf } from '@/lib/chat/in-chat-search';

const msg = (id: string, body: string) => ({ id, body, attachments: [] });
const threads = [
  {
    root: msg('c1', 'We can not write Vidyadaan'),
    replies: [msg('r1', 'Okay, tweaking'), msg('r2', 'Done')],
  },
  {
    root: msg('c2', 'we have made tweaks to the caption'),
    replies: [msg('r3', 'more tweaks soon')],
  },
];
const hitIds = localHits(searchRowsOf(threads), 'tweak');

function search(over: Partial<ChatSearch>): ChatSearch {
  return {
    open: true,
    query: 'tweak',
    words: ['tweak'],
    currentId: hitIds[0] ?? null,
    hitIds,
    steps: { count: hitIds.length, index: 0, hasMore: false },
    loading: false,
    start: () => undefined,
    close: () => undefined,
    setQuery: () => undefined,
    older: () => undefined,
    newer: () => undefined,
    ...over,
  };
}

const replies = new Map(threads.map((t) => [t.root.id, t.replies]));

describe('peekReplies', () => {
  it('word starts match: "tweak" finds tweaks and tweaking, replies included', () => {
    expect([...hitIds].sort()).toEqual(['c2', 'r1', 'r3']);
  });

  it('every reply hit shows under its comment, even when the walk stands elsewhere', () => {
    const s = search({ currentId: 'c2' });
    expect(peekReplies(s, replies, 'c1').map((r) => r.id)).toEqual(['r1']);
    expect(peekReplies(s, replies, 'c2').map((r) => r.id)).toEqual(['r3']);
  });

  it('nothing while the search is closed', () => {
    expect(peekReplies(search({ open: false }), replies, 'c1')).toEqual([]);
  });
});
