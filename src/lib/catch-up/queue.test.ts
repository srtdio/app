import { describe, expect, it } from 'vitest';
import {
  buildCatchUpQueue,
  heldEntries,
  itemOf,
  makesCard,
  unreadIdsOf,
} from '@/lib/catch-up/queue';
import { entry } from '@/lib/catch-up/test-fixtures';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('catch up queue: one card per item', () => {
  const p1a = entry({ id: 'p1a', entity_id: 'p1', created_at: at(9), payload: { comment_id: 'c1' } });
  const p1b = entry({ id: 'p1b', entity_id: 'p1', created_at: at(11), payload: { comment_id: 'c2' } });
  const p2 = entry({ id: 'p2', entity_id: 'p2', created_at: at(10), payload: { comment_id: 'c3' } });
  const brief = entry({
    id: 'b1',
    event_type: 'brief_created',
    entity_type: 'brief',
    entity_id: 'br1',
    scope: 'briefs',
    created_at: at(8),
  });

  it('groups entries per item, newest activity first', () => {
    const q = buildCatchUpQueue({ tapped: null, held: [p1a, p1b, p2, brief], nowMs: NOW, workspaceId: 'w1' });
    expect(q.map((c) => c.key)).toEqual(['post:p1', 'post:p2', 'brief:br1']);
    expect(q[0]?.entries.map((e) => e.id)).toEqual(['p1b', 'p1a']);
    expect(q[0]?.lead.id).toBe('p1b');
  });

  it('the tapped item comes first even when older', () => {
    const q = buildCatchUpQueue({ tapped: brief, held: [p1a, p1b, p2, brief], nowMs: NOW });
    expect(q.map((c) => c.key)).toEqual(['brief:br1', 'post:p1', 'post:p2']);
  });

  it('leaves out read, snoozed and other-workspace entries', () => {
    const read = entry({ id: 'r', entity_id: 'p9', read_at: at(8) });
    const snoozed = entry({ id: 's', entity_id: 'p8', snoozed_until: '2026-11-09T00:00:00.000Z' });
    const other = entry({ id: 'o', entity_id: 'p7', workspace_id: 'w2' });
    const q = buildCatchUpQueue({ tapped: null, held: [read, snoozed, other, p2], nowMs: NOW, workspaceId: 'w1' });
    expect(q.map((c) => c.key)).toEqual(['post:p2']);
  });

  it('chat: the main chat and each thread are their own items', () => {
    const main = entry({
      id: 'm',
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: 'ch',
      payload: { message_id: 'x' },
    });
    const thread = entry({
      id: 't',
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: 'ch',
      payload: { message_id: 'y', thread_root_id: 'root' },
    });
    expect(itemOf(main)?.key).toBe('chat:ch');
    expect(itemOf(thread)?.key).toBe('thread:ch:root');
    expect(itemOf(thread)?.kind).toBe('chat-thread');
  });

  it('plan items and bank ideas', () => {
    const plan = entry({ id: 'pl', event_type: 'plan_comment', entity_type: 'plan_item', entity_id: 'i1' });
    const idea = entry({
      id: 'id',
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: 'i2',
      scope_key: 'bank',
    });
    expect(itemOf(plan)?.kind).toBe('plan-item');
    expect(itemOf(idea)?.kind).toBe('idea');
  });
});

describe('card-making entries', () => {
  it('makes cards for comments, mentions, points, plan reviews, threads, briefs for you', () => {
    for (const type of [
      'comment',
      'mention',
      'plan_comment',
      'checkpoints_added',
      'plan_review',
      'brief_created',
    ]) {
      expect(makesCard(entry({ event_type: type })), type).toBe(true);
    }
  });

  it('stage changes only to review, approved, rejected, parked', () => {
    for (const stage of ['review', 'approved', 'rejected', 'parked']) {
      expect(makesCard(entry({ event_type: 'stage_change', payload: { to_stage: stage } })), stage).toBe(true);
    }
    expect(makesCard(entry({ event_type: 'stage_change', payload: { to_stage: 'draft' } }))).toBe(false);
  });

  it('Activity-only kinds never make a card, but ride on their item card', () => {
    for (const type of ['post_deleted', 'assets_deleted', 'comment_resolved', 'task_changed', 'reminder']) {
      expect(makesCard(entry({ event_type: type })), type).toBe(false);
    }
    const quiet = entry({ id: 'q', event_type: 'comment_resolved', created_at: at(11) });
    const loud = entry({ id: 'l', event_type: 'comment', created_at: at(9), payload: { comment_id: 'c' } });
    const q = buildCatchUpQueue({ tapped: null, held: [quiet, loud], nowMs: NOW, workspaceId: 'w1' });
    expect(q).toHaveLength(1);
    expect(q[0]?.lead.id).toBe('l');
    expect(q[0] !== undefined ? unreadIdsOf(q[0]) : []).toEqual(['q', 'l']);
    // An item with only Activity-only entries is no card.
    expect(buildCatchUpQueue({ tapped: null, held: [quiet], nowMs: NOW, workspaceId: 'w1' })).toEqual([]);
  });

  it('own actions never make a card', () => {
    const mine = entry({ id: 'me', actor_user_id: 'u-me' });
    expect(makesCard(mine, 'u-me')).toBe(false);
    expect(makesCard(entry({}, { own: true }))).toBe(false);
    expect(buildCatchUpQueue({ tapped: null, held: [mine], nowMs: NOW, workspaceId: 'w1', selfId: 'u-me' })).toEqual(
      [],
    );
  });
});

describe('heldEntries', () => {
  it('keeps the first copy of each id', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    expect(heldEntries([a], [a, b], undefined).map((e) => e.id)).toEqual(['a', 'b']);
  });
});
