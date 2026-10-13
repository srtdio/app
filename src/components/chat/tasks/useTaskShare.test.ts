import { describe, expect, it } from 'vitest';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import { forwardTargets, snapshotState } from '@/components/chat/tasks/useTaskShare';

function msg(over: Partial<ThreadMessage>): ThreadMessage {
  return { id: 'm1', mine: true, body: 'Task list', state: 'sent', ...over } as ThreadMessage;
}

describe('snapshotState', () => {
  const before = new Set(['old']);

  it('waits until the new own bubble with the body is recorded or Not sent', () => {
    expect(snapshotState([msg({ id: 'old' })], before, 'Task list').state).toBe('waiting');
    expect(snapshotState([msg({ state: 'sending' })], before, 'Task list').state).toBe('waiting');
    expect(snapshotState([msg({ mine: false })], before, 'Task list').state).toBe('waiting');
    expect(snapshotState([msg({ body: 'other' })], before, 'Task list').state).toBe('waiting');
    const sent = snapshotState([msg({ id: 'new' })], before, 'Task list');
    expect(sent.state === 'sent' && sent.message.id).toBe('new');
    expect(snapshotState([msg({ state: 'failed' })], before, 'Task list').state).toBe('failed');
  });
});

describe('forwardTargets', () => {
  it('skips the open chat (it already has the message)', () => {
    const chats = [{ channelId: 'here' }, { channelId: 'dm' }] as ChannelSummary[];
    expect(forwardTargets(chats, 'here').map((c) => c.channelId)).toEqual(['dm']);
    expect(forwardTargets(chats, 'elsewhere')).toHaveLength(2);
  });
});
