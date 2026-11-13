// Catch up per tab (13 Nov 2026): each tab's queue holds only its kind, the
// counts are the cards each stack would open (own entries never count), one
// read state both ways (an item opened anywhere leaves its tab's catch up; a
// read here reaches Activity through the inbox change), and old Activity
// links land on the right tab.
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));

import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { ENTITY_READ_ON_OPEN_EVENT } from '@/lib/inbox/entity-open-event';
import { entry } from '@/lib/catch-up/test-fixtures';
import {
  chatCards,
  catchUpUnreadKey,
  inboxCards,
  itemKindsOf,
  markNAsRead,
  resetTabCatchUpForTest,
  seedTabCatchUpForTest,
  tabCatchUpHref,
  tabCatchUpLine,
  tabCounts,
  tabQueue,
  TAB_CATCH_UP_TITLE,
} from '@/lib/catch-up/tab-store';
import { oldCatchUpTarget, takeCatchUpSeed } from '@/lib/catch-up/route';
import { peekKept } from '@/lib/session-read';
import type { LoadResult } from '@/components/pages/activity/data';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;

const post = entry({ id: 'p', entity_id: 'p1', created_at: at(9), payload: { comment_id: 'c1' } });
const post2 = entry({
  id: 'p2',
  entity_id: 'p2',
  created_at: at(11),
  payload: { comment_id: 'c2' },
});
const stage = entry({
  id: 'ps',
  event_type: 'stage_change',
  entity_id: 'p1',
  created_at: at(8),
  payload: { to_stage: 'approved' },
});
const brief = entry({
  id: 'b',
  event_type: 'brief_created',
  entity_type: 'brief',
  entity_id: 'br1',
  scope: 'briefs',
  created_at: at(10),
});
const planItem = entry({
  id: 'pi',
  event_type: 'plan_comment',
  entity_type: 'plan_item',
  entity_id: 'i1',
  scope: 'plan',
  scope_key: 'pl1',
  created_at: at(7),
});
const idea = entry({
  id: 'id',
  event_type: 'plan_comment',
  entity_type: 'plan_item',
  entity_id: 'i2',
  scope: 'plan',
  scope_key: 'bank',
  created_at: at(6),
});
const own = entry({ id: 'own', entity_id: 'p9', actor_user_id: 'u-me', created_at: at(11) });
const held = [post, post2, stage, brief, planItem, idea, own];

const cards = inboxCards({ held, nowMs: NOW, workspaceId: 'w1', selfId: 'u-me' });

afterEach(() => {
  resetTabCatchUpForTest();
  h.rpc.mockClear();
});

describe('each tab’s queue holds only its kind', () => {
  it('Pipeline: posts only, newest first; Briefs: briefs; Plan: plan items, then ideas', () => {
    expect(tabQueue(cards, 'post').map((c) => c.key)).toEqual(['post:p2', 'post:p1']);
    expect(tabQueue(cards, 'brief').map((c) => c.key)).toEqual(['brief:br1']);
    expect(tabQueue(cards, 'plan-item').map((c) => c.kind)).toEqual(['plan-item']);
    expect(tabQueue(cards, 'idea').map((c) => c.kind)).toEqual(['idea']);
    for (const tab of ['post', 'brief', 'plan-item', 'idea'] as const) {
      for (const card of tabQueue(cards, tab)) expect(itemKindsOf(tab)).toContain(card.kind);
    }
  });

  it('a named item goes first, the rest keep their order', () => {
    expect(tabQueue(cards, 'post', 'post:p1').map((c) => c.key)).toEqual(['post:p1', 'post:p2']);
  });

  it('counts are cards (items), own actions never count', () => {
    expect(tabCounts(cards)).toEqual({ post: 2, brief: 1, 'plan-item': 1, idea: 1, chat: 0 });
    // The post's two entries (comment + stage change) are one card.
    expect(tabQueue(cards, 'post').find((c) => c.key === 'post:p1')?.entries).toHaveLength(2);
  });

  it('Chat: unread chats (plain messages too) and unread threads; a read chat never shows', () => {
    const chat = chatCards({
      inbox: [],
      threads: [
        {
          channelId: 'c2',
          rootId: 'm1',
          replyCount: 1,
          lastReplyAt: at(5),
          lastReplyId: 'm2',
          lastReplySender: null,
          lastReplyBody: 'ok',
          unread: true,
        },
      ],
      conversations: {
        c1: {
          lastMessageText: 'hi',
          lastMessageTs: Date.parse(at(9)),
          unread: 3,
          lastMessageId: 'mm',
        },
        c3: {
          lastMessageText: 'old',
          lastMessageTs: Date.parse(at(4)),
          unread: 0,
          lastMessageId: 'mo',
        },
      },
      workspaceId: 'w1',
      selfId: 'u-me',
    });
    expect(chat.map((c) => c.key)).toEqual(['chat:c1', 'thread:c2:m1']);
    expect(tabCounts(chat).chat).toBe(2);
    expect(tabQueue([...cards, ...chat], 'chat').every((c) => c.kind.startsWith('chat'))).toBe(
      true,
    );
  });
});

describe('copy and links (approved words)', () => {
  it('names, the count line and the action', () => {
    expect(Object.values(TAB_CATCH_UP_TITLE)).toEqual([
      'Post catch up',
      'Brief catch up',
      'Plan catch up',
      'Concept catch up',
      'Chat catch up',
    ]);
    expect(tabCatchUpLine(4)).toBe('4 unread');
    expect(markNAsRead(4)).toBe('Mark 4 as read');
  });

  it('each row opens on its own tab', () => {
    expect(tabCatchUpHref('post')).toBe('/pipeline?catchup=post');
    expect(tabCatchUpHref('brief')).toBe('/briefs?catchup=brief');
    expect(tabCatchUpHref('plan-item')).toBe('/plan?catchup=plan-item');
    expect(tabCatchUpHref('idea')).toBe('/plan?catchup=idea');
    expect(tabCatchUpHref('chat')).toBe('/chat?catchup=chat');
  });

  it('old Activity links land on the right tab', () => {
    expect(oldCatchUpTarget({ catchUp: null, threads: '1', entry: null })).toBe(
      '/chat?catchup=chat',
    );
    expect(oldCatchUpTarget({ catchUp: 'threads', threads: null, entry: null })).toBe(
      '/chat?catchup=chat',
    );
    expect(oldCatchUpTarget({ catchUp: 'newest', threads: null, entry: null })).toBe(
      '/chat?catchup=chat',
    );
    expect(oldCatchUpTarget({ catchUp: 'b', threads: null, entry: brief })).toBe(
      '/briefs?catchup=brief&entry=b',
    );
    // The entry is handed over: the first card paints from it.
    expect(takeCatchUpSeed('b')?.item.id).toBe('b');
    expect(oldCatchUpTarget({ catchUp: 'gone', threads: null, entry: null })).toBe('/activity');
  });
});

describe('one read state, both ways', () => {
  const heldNow = (): string[] =>
    (
      peekKept<LoadResult>(catchUpUnreadKey('u-me', 'w1')) as { ok: true; data: { id: string }[] }
    ).data.map((e) => e.id);

  it('an item opened anywhere (Activity, a toast, a card) leaves its tab’s catch up at once, every entry of it', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...held] });
    window.dispatchEvent(
      new CustomEvent(ENTITY_READ_ON_OPEN_EVENT, { detail: { type: 'post', id: 'p1' } }),
    );
    // The comment and the stage change both go; nothing else does.
    expect(heldNow()).not.toContain('p');
    expect(heldNow()).not.toContain('ps');
    expect(heldNow()).toContain('p2');
    expect(heldNow()).toContain('b');
    await Promise.resolve();
    const call = h.rpc.mock.calls.find((c) => (c as unknown[])[0] === 'inbox_mark_read_ids') as
      | unknown[]
      | undefined;
    expect((call?.[1] as { p_ids: string[] }).p_ids.sort()).toEqual(['p', 'ps']);
  });

  it('a read here tells Activity (the inbox change event), so its dot and "N new" go', async () => {
    seedTabCatchUpForTest({ userId: 'u-me', workspaceId: 'w1', held: [...held] });
    const changed = vi.fn();
    window.addEventListener(INBOX_CHANGED_EVENT, changed);
    window.dispatchEvent(
      new CustomEvent(ENTITY_READ_ON_OPEN_EVENT, { detail: { type: 'brief', id: 'br1' } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(INBOX_CHANGED_EVENT, changed);
  });
});
