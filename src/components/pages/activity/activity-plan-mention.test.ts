// An @mention in a plan item comment (event_type 'mention', entity_type
// 'plan_item'): a "mentioned you" row like a post mention, counted under the
// Mentions chip, opening the plan item at the comment (the plan_comment route).
// Post and brief mentions and plan_comment rows read as before.

import { describe, expect, it } from 'vitest';
import type { Database } from '@srtdio/schemas';
import {
  activityLine,
  entityHref,
  filterByState,
  isPlanMention,
  mapEntry,
  shortLine,
} from '@/components/pages/activity/data';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function row(over: Partial<InboxEntryRow>): InboxEntryRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'mention',
    entity_type: 'plan_item',
    entity_id: ITEM,
    scope: 'posts',
    scope_key: PLAN,
    tier: 'urgent',
    payload: { plan_id: PLAN, comment_id: COMMENT, visibility: 'everyone' },
    read_at: null,
    snoozed_until: null,
    actor_user_id: 'u-ana',
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-11-02T09:00:00.000Z',
    ...over,
  };
}

describe('plan item mentions in Activity', () => {
  it('maps as a plan row: plan_id and comment_id read from the payload', () => {
    const item = mapEntry(row({}));
    expect(isPlanMention(item)).toBe(true);
    expect(item.planId).toBe(PLAN);
    expect(item.commentId).toBe(COMMENT);
    expect(item.actorId).toBe('u-ana');
  });

  it('reads "<actor> mentioned you in a plan item"; a missing actor degrades', () => {
    const item = { ...mapEntry(row({})), actorName: 'Ana' };
    expect(activityLine(item)).toBe('Ana mentioned you in a plan item');
    expect(shortLine(item)).toBe('Ana mentioned you in a plan item');
    expect(activityLine({ ...item, actorName: null })).toBe('New mention in a plan item');
  });

  it('opens /plan/{plan}?item={item}&comment={comment}, the plan_comment route', () => {
    const item = mapEntry(row({}));
    expect(entityHref(item)).toBe(`/plan/${PLAN}?item=${ITEM}&comment=${COMMENT}`);
    const comment = mapEntry(row({ event_type: 'plan_comment' }));
    expect(entityHref(comment)).toBe(entityHref(item));
    expect(entityHref({ ...item, commentId: null })).toBe(`/plan/${PLAN}?item=${ITEM}`);
    expect(entityHref({ ...item, planId: null })).toBeNull();
  });

  it('counts under the Mentions chip, as post mentions do', () => {
    const plan = mapEntry(row({}));
    const post = mapEntry(
      row({ id: 'e2', entity_type: 'post', entity_id: 'p1', payload: { comment_id: COMMENT } }),
    );
    const other = mapEntry(row({ id: 'e3', event_type: 'plan_comment' }));
    const ids = filterByState([plan, post, other], 'mentions', Date.now()).map((i) => i.id);
    expect(ids).toEqual(['e1', 'e2']);
  });

  it('post and brief mentions and plan_comment rows are unchanged', () => {
    const post = mapEntry(
      row({ entity_type: 'post', entity_id: 'p1', payload: { comment_id: COMMENT } }),
    );
    expect(isPlanMention(post)).toBe(false);
    expect(post.planId).toBeNull();
    expect(activityLine({ ...post, actorName: 'Ana', title: 'Launch' })).toBe(
      'Ana mentioned you in Launch',
    );
    expect(entityHref(post)).toBe(`/posts/p1?comment=${COMMENT}`);
    const brief = mapEntry(
      row({ entity_type: 'brief', entity_id: 'b1', payload: { comment_id: COMMENT } }),
    );
    expect(isPlanMention(brief)).toBe(false);
    const planComment = { ...mapEntry(row({ event_type: 'plan_comment' })), actorName: 'Ana' };
    expect(activityLine(planComment)).toBe('Ana commented on a plan item');
  });
});
