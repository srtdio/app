// Thread entries in Activity: a thread's first reply on a card (system /
// thread_started) and a chat mention inside a thread.

import { describe, expect, it } from 'vitest';
import {
  THREAD_STARTED_EVENT,
  activityLine,
  entityHref,
  filterByState,
  isThreadStarted,
} from '@/components/pages/activity/data';
import { activityKind } from '@/components/pages/activity/ActivityCard';
import { entry } from '@/lib/catch-up/test-fixtures';

const startedRow = {
  event_type: 'system',
  entity_type: 'chat_channel',
  entity_id: 'c1',
  scope: 'groups',
  payload: {
    kind: 'thread_started',
    message_id: 'm2',
    thread_root_id: 'm1',
    card_kind: 'post',
    card_id: 'p1',
  },
};

describe('thread_started', () => {
  it('lifts system/thread_started to its display type with its card', () => {
    const item = entry(startedRow);
    expect(item.eventType).toBe(THREAD_STARTED_EVENT);
    expect(isThreadStarted(item)).toBe(true);
    expect(item.cardKind).toBe('post');
    expect(item.cardId).toBe('p1');
    expect(item.threadRootId).toBe('m1');
  });

  it('reads "<Actor> started a thread on <card title>", else in <chat name>', () => {
    const item = entry(startedRow, { actorName: 'Priya', title: 'Watch launch' });
    expect(activityLine(item)).toBe('Priya started a thread on Watch launch');
    const untitled = entry(startedRow, { actorName: 'Priya', title: null, chatName: 'Launch' });
    expect(activityLine(untitled)).toBe('Priya started a thread in Launch');
  });

  it('wears its own tag and counts under All and Unread, not Mentions', () => {
    const item = entry(startedRow);
    expect(activityKind(item)).toBe('Thread');
    const now = Date.parse('2026-11-08T12:00:00.000Z');
    expect(filterByState([item], 'all', now)).toHaveLength(1);
    expect(filterByState([item], 'unread', now)).toHaveLength(1);
    expect(filterByState([item], 'mentions', now)).toHaveLength(0);
  });

  it('opens the thread at the reply (the chat jump opens a reply in its thread)', () => {
    expect(entityHref(entry(startedRow))).toBe('/chat?channel=c1&message=m2');
  });
});

describe('a chat mention in a thread', () => {
  const row = {
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    payload: { message_id: 'm2', thread_root_id: 'm1' },
  };

  it('reads "mentioned you in a thread in <chat>" (DM: "in a thread")', () => {
    const group = entry(row, { actorName: 'Priya', channelType: 'group', title: 'Launch' });
    expect(activityLine(group)).toBe('Priya mentioned you in a thread in Launch');
    const dm = entry(row, { actorName: 'Priya', channelType: 'dm', title: null });
    expect(activityLine(dm)).toBe('Priya mentioned you in a thread');
  });

  it('without a thread root the line is unchanged', () => {
    const plain = entry(
      { ...row, payload: { message_id: 'm2' } },
      { actorName: 'Priya', channelType: 'group', title: 'Launch' },
    );
    expect(activityLine(plain)).toBe('Priya mentioned you in Launch');
  });

  it('lands on the thread view at the message', () => {
    expect(entityHref(entry(row))).toBe('/chat?channel=c1&message=m2');
  });
});
