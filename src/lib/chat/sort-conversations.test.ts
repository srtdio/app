import { describe, expect, it } from 'vitest';
import { sortChannelsByRecency, type RecencySummary } from './sort-conversations';
import type { ChannelSummary } from '@/lib/chat-reads';

function channel(over: Partial<ChannelSummary> & { channelId: string }): ChannelSummary {
  return {
    channelType: 'group',
    title: over.channelId,
    avatarUrl: null,
    agoraGroupId: 'ag',
    groupId: 'g',
    peerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function lookup(map: Record<string, number>): (id: string) => RecencySummary | undefined {
  return (id) => (id in map ? { lastMessageTs: map[id]! } : undefined);
}

function ids(channels: ChannelSummary[]): string[] {
  return channels.map((c) => c.channelId);
}

describe('sortChannelsByRecency', () => {
  it('orders channels with messages most-recent first by lastMessageTs', () => {
    const channels = [
      channel({ channelId: 'a' }),
      channel({ channelId: 'b' }),
      channel({ channelId: 'c' }),
    ];
    const result = sortChannelsByRecency(channels, lookup({ a: 100, b: 300, c: 200 }));
    expect(ids(result)).toEqual(['b', 'c', 'a']);
  });

  it('places message-less channels last, ordered by createdAt descending', () => {
    const channels = [
      channel({ channelId: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      channel({ channelId: 'msg' }),
      channel({ channelId: 'new', createdAt: '2026-05-01T00:00:00Z' }),
    ];
    // Only 'msg' has a message; a missing summary and a zero ts both count as empty.
    const result = sortChannelsByRecency(channels, lookup({ msg: 500, old: 0 }));
    expect(ids(result)).toEqual(['msg', 'new', 'old']);
  });

  it('is stable for equal lastMessageTs keys', () => {
    const channels = [
      channel({ channelId: 'x' }),
      channel({ channelId: 'y' }),
      channel({ channelId: 'z' }),
    ];
    const result = sortChannelsByRecency(channels, lookup({ x: 100, y: 100, z: 100 }));
    expect(ids(result)).toEqual(['x', 'y', 'z']);
  });

  it('is stable for equal createdAt among message-less channels', () => {
    const channels = [channel({ channelId: 'p' }), channel({ channelId: 'q' })];
    const result = sortChannelsByRecency(channels, lookup({}));
    expect(ids(result)).toEqual(['p', 'q']);
  });

  it('does not mutate the input array', () => {
    const channels = [channel({ channelId: 'a' }), channel({ channelId: 'b' })];
    const snapshot = ids(channels);
    sortChannelsByRecency(channels, lookup({ a: 1, b: 2 }));
    expect(ids(channels)).toEqual(snapshot);
  });
});
