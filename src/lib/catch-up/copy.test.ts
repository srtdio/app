import { describe, expect, it } from 'vitest';
import {
  catchUpCardKind,
  catchUpKicker,
  catchUpReplyHint,
  catchUpTitle,
  endLine,
  keptLine,
  leftLabel,
  unreadHeading,
} from '@/lib/catch-up/copy';
import { entry } from '@/lib/catch-up/test-fixtures';

const threadMention = entry(
  {
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    payload: { message_id: 'm2', thread_root_id: 'm1' },
  },
  { chatName: 'Launch', actorName: 'Priya', channelType: 'group' },
);
const mainMention = entry(
  {
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    payload: { message_id: 'm3' },
  },
  { chatName: 'Launch', actorName: 'Priya', channelType: 'group' },
);
const started = entry(
  {
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
  },
  { chatName: 'Launch', actorName: 'Priya', title: 'Watch launch' },
);
const comment = entry(
  { event_type: 'comment', payload: { comment_id: 'k1' } },
  { title: 'Watch launch', actorName: 'Priya' },
);
const stage = entry(
  { event_type: 'stage_change', payload: { to_stage: 'approved' } },
  { title: 'Watch launch', actorName: 'Priya' },
);

describe('catch up copy', () => {
  it('kinds', () => {
    expect(catchUpCardKind(threadMention)).toBe('chat-thread');
    expect(catchUpCardKind(mainMention)).toBe('chat-main');
    expect(catchUpCardKind(started)).toBe('thread-started');
    expect(catchUpCardKind(comment)).toBe('comment');
    expect(catchUpCardKind(stage)).toBe('entity');
  });

  it('kickers and titles', () => {
    expect(catchUpKicker(threadMention)).toBe('Thread in Launch');
    expect(catchUpTitle(threadMention, 'Watch launch')).toBe('Watch launch');
    expect(catchUpTitle(threadMention)).toBe('Thread');
    expect(catchUpKicker(mainMention)).toBe('Launch');
    expect(catchUpTitle(mainMention)).toBe('Launch');
    expect(catchUpKicker(started)).toBe('Thread on a post · Launch');
    expect(catchUpKicker({ ...started, cardKind: 'item' })).toBe('Thread on an idea · Launch');
    expect(catchUpTitle(started)).toBe('Watch launch');
    // Non-chat cards reuse the Activity line: no new copy.
    expect(catchUpKicker(stage)).toBe('Priya approved Watch launch');
    expect(catchUpTitle(stage)).toBe('Watch launch');
  });

  it('the welcome row names its workspace under the welcome line, never twice', () => {
    const welcome = entry({
      event_type: 'system',
      entity_type: null,
      entity_id: null,
      payload: { kind: 'welcome', workspace_name: 'Northwind', platform: 'instagram' },
    });
    expect(catchUpTitle(welcome)).toBe('Northwind');
    expect(catchUpKicker(welcome)).not.toBe(catchUpTitle(welcome));
  });

  it('reply box hints only for chat and comment cards', () => {
    expect(catchUpReplyHint(threadMention)).toBe('Reply in thread');
    expect(catchUpReplyHint(started)).toBe('Reply in thread');
    expect(catchUpReplyHint(mainMention)).toBe('Message Launch');
    expect(catchUpReplyHint(comment)).toBe('Reply');
    expect(catchUpReplyHint(stage)).toBeNull();
  });

  it('counts', () => {
    expect(leftLabel(3)).toBe('3 left');
    expect(unreadHeading(12)).toBe('12 unread');
    expect(endLine(1)).toBe('You went through 1 update.');
    expect(endLine(5)).toBe('You went through 5 updates.');
    expect(keptLine(1)).toBe('1 update kept unread.');
    expect(keptLine(4)).toBe('4 updates kept unread.');
  });
});
