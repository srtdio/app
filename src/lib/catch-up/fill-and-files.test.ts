// Catch up, 16 Nov 2026: a card reads from its first unread row (the New line
// is always drawn, 50 new open with it on top), and comment / chat photos
// show on cards (Manisha's photo on a post comment was missing).

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import type { Client } from '@srtdio/rpc';
import {
  CATCH_UP_PAGE,
  CATCH_UP_UNREAD_MAX,
  chatFilesOf,
  firstUnreadEntry,
  rowFileIds,
  topLevelComments,
  unreadSinceOf,
  withFiles,
  type CatchUpMessageRow,
} from '@/lib/catch-up/body';
import { fillScrollTop } from '@/lib/catch-up/text';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';

const at = (m: number): string => new Date(Date.UTC(2026, 10, 16, 9, m)).toISOString();

describe('catch up reads from the first unread row', () => {
  it('starts 5 minutes before the oldest unread entry, never at my own', () => {
    const card = cardOf(
      entry({ id: 'e3', created_at: at(30), payload: { comment_id: 'c3' } }),
      entry({ id: 'e2', created_at: at(20), payload: { comment_id: 'c2' } }),
    );
    expect(unreadSinceOf(card)).toBe(at(15));
  });

  it('has no start when nothing is unread', () => {
    const card = cardOf(
      entry({ id: 'e1', created_at: at(20), read_at: at(25), payload: { comment_id: 'c1' } }),
    );
    expect(unreadSinceOf(card)).toBeNull();
  });

  it('reads every unread comment plus one page before it, never only the newest 20', async () => {
    const calls: string[] = [];
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      entity_id: 'p1',
      created_at: at(i),
    }));
    const client = {
      from: () => {
        const q: { gte?: string; lt?: string; limit?: number } = {};
        const b = {
          select: () => b,
          eq: () => b,
          is: () => b,
          order: () => b,
          gte: (_c: string, v: string) => {
            q.gte = v;
            return b;
          },
          lt: (_c: string, v: string) => {
            q.lt = v;
            return b;
          },
          limit: async (n: number) => {
            q.limit = n;
            calls.push(q.gte !== undefined ? `gte:${n}` : `lt:${n}`);
            const data =
              q.gte !== undefined
                ? rows.filter((r) => r.created_at >= (q.gte ?? '')).slice(0, n)
                : rows
                    .filter((r) => r.created_at < (q.lt ?? ''))
                    .reverse()
                    .slice(0, n);
            return { data, error: null };
          },
        };
        return b;
      },
    } as unknown as Client;
    const got = await topLevelComments(client, ['p1'], new Map([['p1', at(5)]]));
    expect(calls.sort()).toEqual([`gte:${CATCH_UP_UNREAD_MAX}`, `lt:${CATCH_UP_PAGE}`].sort());
    // Newest first, all 45 unread (05..49) and the 5 before them.
    expect(got.data).toHaveLength(50);
    expect(got.data[0]?.id).toBe('c49');
    expect(got.data[49]?.id).toBe('c0');
    expect(got.olderFull.has('p1')).toBe(false);
  });

  it('opens 50 new with the New line on top (fill rule)', () => {
    expect(fillScrollTop({ newTop: 120, contentHeight: 4000, bodyHeight: 500 })).toBe(120);
    // Everything fits: from the top, spare room below.
    expect(fillScrollTop({ newTop: 120, contentHeight: 400, bodyHeight: 500 })).toBe(0);
  });

  it('a chat card starts at its oldest unread message in the same thread', () => {
    const msg = (id: string, m: number, root: string | null) =>
      entry(
        { id, event_type: 'mention', entity_type: 'chat_channel', created_at: at(m) },
        { entityId: 'ch1', messageId: `m-${id}`, threadRootId: root },
      );
    const newest = msg('e2', 30, null);
    const oldest = msg('e1', 10, null);
    const card = { ...cardOf(newest), cardEntries: [newest, oldest] };
    expect(firstUnreadEntry(card).id).toBe(oldest.id);
  });
});

describe('catch up draws comment and chat files', () => {
  const row = (over: Partial<CatchUpMessageRow> = {}): CatchUpMessageRow => ({
    kind: 'message',
    id: 'c1',
    author: { id: 'u1', name: 'Manisha', avatarUrl: null },
    createdAt: at(1),
    text: 'Caption addition',
    replyCount: 0,
    ...over,
  });

  it('collects every file id (thread roots too) for one batched read', () => {
    const rows = [
      row({ fileIds: ['v1'] }),
      row({ id: 'r1', threadRoot: row({ fileIds: ['v2'] }) }),
    ];
    expect(rowFileIds(rows)).toEqual(['v1', 'v2']);
  });

  it('fills a comment photo from the read details', () => {
    const files = new Map([['v1', { name: 'photo.jpg', mime: 'image/jpeg' }]]);
    const [got] = withFiles([row({ fileIds: ['v1'] })], files);
    expect(got?.kind === 'message' ? got.files : null).toEqual([
      { assetId: 'v1', name: 'photo.jpg', mime: 'image/jpeg' },
    ]);
  });

  it('a row without files gets none', () => {
    const [got] = withFiles([row()], new Map());
    expect(got?.kind === 'message' ? got.files : 'x').toBeUndefined();
  });

  it('reads chat files from attachment_meta', () => {
    expect(chatFilesOf({ v9: { name: 'a.png', mime: 'image/png' } }, ['v9'])).toEqual({
      files: [{ assetId: 'v9', name: 'a.png', mime: 'image/png' }],
    });
    expect(chatFilesOf(null, [])).toEqual({});
  });
});
