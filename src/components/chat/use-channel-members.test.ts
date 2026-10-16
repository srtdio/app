import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  channelMemberIds,
  loadChannelMembers,
  loadChannelMembersResult,
  mentionGone,
  type ChannelMemberReaders,
} from '@/components/chat/use-channel-members';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { composerBodyFor } from '@/components/chat/Composer';
import { mentionIds, serializeMentions } from '@/lib/chat/mentions';

const ANA = '11111111-1111-4111-8111-111111111111';

const ME = 'me';
const PEER = 'peer';

function readers(groupIds: string[]): ChannelMemberReaders & {
  members: ReturnType<typeof vi.fn>;
} {
  return {
    groupMemberIds: vi.fn(async () => ({ ok: true as const, data: groupIds })),
    members: vi.fn(async (_ws: string, ids: string[]) => ({
      ok: true as const,
      data: ids.map((id) => ({ userId: id, displayName: id, avatarUrl: null, role: 'agency' })),
    })),
  };
}

describe('channelMemberIds', () => {
  it('a group lists its members except me', async () => {
    const ids = await channelMemberIds(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      readers([ME, 'a', 'b']),
    );
    expect(ids).toEqual(['a', 'b']);
  });

  it('a DM lists only the other person', async () => {
    const r = readers([]);
    const ids = await channelMemberIds(
      { workspaceId: 'w', currentUserId: ME, groupId: null, peerUserId: PEER },
      r,
    );
    expect(ids).toEqual([PEER]);
    expect(r.groupMemberIds).not.toHaveBeenCalled();
  });
});

describe('loadChannelMembers', () => {
  it('reads profiles and roles in one batched call', async () => {
    const r = readers([ME, 'a', 'b']);
    const members = await loadChannelMembers(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      r,
    );
    expect(members.map((m) => m.userId)).toEqual(['a', 'b']);
    expect(r.members).toHaveBeenCalledTimes(1);
    expect(r.members).toHaveBeenCalledWith('w', ['a', 'b'], expect.any(AbortSignal));
  });

  it('a failed read yields no rows', async () => {
    const members = await loadChannelMembers(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      {
        groupMemberIds: async () => ({ ok: false, error: { code: 'unknown', message: 'x' } }),
        members: async () => ({ ok: true, data: [] }),
      },
    );
    expect(members).toEqual([]);
  });
});

describe('H1 member-list reads time out and settle as failed', () => {
  it('H1 hanging member read releases the composer after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging: ChannelMemberReaders = {
        groupMemberIds: () => new Promise(() => undefined),
        members: () => new Promise(() => undefined),
      };
      const pending = loadChannelMembersResult(
        { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
        hanging,
      );
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      const load = await pending;
      // Settled (not null), so the composer's hold releases; a failure confirms no one gone.
      expect(load).toEqual({ ok: false });
      expect(mentionGone(load, ME, 'w')(ANA)).toBe(false);
      const stored = `hi @[${ANA}] `;
      const shown = composerBodyFor(
        { text: stored, caret: stored.length },
        true,
        () => undefined,
        mentionGone(load, ME, 'w'),
      );
      expect(shown.held).toBe(false);
      expect(shown.text).toBe('hi @Former member ');
      expect(mentionIds(serializeMentions(shown.text, shown.picks))).toEqual([ANA]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('H1 thrown rejection in a member read is a failed load, never unhandled', async () => {
    const throwing: ChannelMemberReaders = {
      groupMemberIds: () => Promise.reject(new Error('down')),
      members: () => Promise.reject(new Error('down')),
    };
    await expect(
      loadChannelMembersResult(
        { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
        throwing,
      ),
    ).resolves.toEqual({ ok: false });
    await expect(
      loadChannelMembersResult(
        { workspaceId: 'w', currentUserId: ME, groupId: null, peerUserId: PEER },
        throwing,
      ),
    ).resolves.toEqual({ ok: false });
  });

  it('J3 slow first read leaves only the remaining budget for the second; total hold never exceeds 5s', async () => {
    vi.useFakeTimers();
    try {
      const r: ChannelMemberReaders = {
        groupMemberIds: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true, data: [ME, 'a'] }), READ_TIMEOUT_MS - 1_000),
          ),
        members: () => new Promise(() => undefined),
      };
      let settled = false;
      const pending = loadChannelMembersResult(
        { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
        r,
      ).then((load) => {
        settled = true;
        return load;
      });
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(pending).resolves.toEqual({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('only a successful read confirms someone gone', () => {
    const load = {
      ok: true as const,
      members: [{ userId: 'a', displayName: 'A', avatarUrl: null, role: 'agency' }],
    };
    expect(mentionGone(load, ME, 'w')('ex')).toBe(true);
    expect(mentionGone(load, ME, 'w')('a')).toBe(false);
    expect(mentionGone(null, ME, 'w')('ex')).toBe(false);
  });
});
