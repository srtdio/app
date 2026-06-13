import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, DomainError, Result } from '@srtdio/rpc';

// Mock the @srtdio/rpc wrappers: the action layer must call them with the right
// p_-prefixed args and never throw on a domain failure. The supabase client is
// opaque here (the wrappers are mocked), so a bare object satisfies the type.
vi.mock('@srtdio/rpc', () => ({
  dmChannelEnsure: vi.fn(),
  groupCreate: vi.fn(),
  groupRename: vi.fn(),
  groupMemberAdd: vi.fn(),
  groupMemberRemove: vi.fn(),
  groupLeave: vi.fn(),
}));

import {
  dmChannelEnsure,
  groupCreate,
  groupLeave,
  groupMemberAdd,
  groupMemberRemove,
  groupRename,
} from '@srtdio/rpc';
import {
  addGroupMember,
  createGroupChannel,
  leaveGroupChannel,
  removeGroupMember,
  renameGroupChannel,
  startDmChannel,
} from '@/components/chat/chat-actions';

const client = {} as Client;

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

const domainFail: Result<never> = {
  ok: false,
  error: { code: 'forbidden_role', message: 'nope' } satisfies DomainError,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startDmChannel', () => {
  it('calls dmChannelEnsure with peer + workspace + trace and opens the channel on success', async () => {
    vi.mocked(dmChannelEnsure).mockResolvedValue(ok('chan-1'));
    const onOpen = vi.fn();
    const failure = await startDmChannel(
      client,
      { workspaceId: 'w1', peerUserId: 'peer', traceId: 't1' },
      onOpen,
    );
    expect(dmChannelEnsure).toHaveBeenCalledWith(client, {
      p_workspace_id: 'w1',
      p_other_user_id: 'peer',
      p_trace_id: 't1',
    });
    expect(onOpen).toHaveBeenCalledWith('chan-1');
    expect(failure).toBeNull();
  });

  it('returns the error and does not open or throw on ok:false', async () => {
    vi.mocked(dmChannelEnsure).mockResolvedValue(domainFail);
    const onOpen = vi.fn();
    const failure = await startDmChannel(
      client,
      { workspaceId: 'w1', peerUserId: 'peer', traceId: 't1' },
      onOpen,
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(failure).toEqual({ code: 'forbidden_role', message: 'nope' });
  });
});

describe('createGroupChannel', () => {
  it('creates the group with all members in a single call (no per-member loop)', async () => {
    vi.mocked(groupCreate).mockResolvedValue(ok('grp-1'));
    const onCreated = vi.fn();
    const failure = await createGroupChannel(
      client,
      { workspaceId: 'w1', name: 'Team', memberUserIds: ['a', 'b', 'c'], traceId: 't1' },
      onCreated,
    );
    expect(groupCreate).toHaveBeenCalledTimes(1);
    expect(groupCreate).toHaveBeenCalledWith(client, {
      p_workspace_id: 'w1',
      p_name: 'Team',
      p_member_user_ids: ['a', 'b', 'c'],
      p_trace_id: 't1',
    });
    // The members go in the one group_create call, never via per-member adds.
    expect(groupMemberAdd).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith('grp-1');
    expect(failure).toBeNull();
  });

  it('returns the error and does not throw on ok:false', async () => {
    vi.mocked(groupCreate).mockResolvedValue(domainFail);
    const onCreated = vi.fn();
    const failure = await createGroupChannel(
      client,
      { workspaceId: 'w1', name: 'Team', memberUserIds: ['a'], traceId: 't1' },
      onCreated,
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(failure?.message).toBe('nope');
  });
});

describe('renameGroupChannel', () => {
  it('calls groupRename with group id + name + trace', async () => {
    vi.mocked(groupRename).mockResolvedValue(ok(undefined));
    const onDone = vi.fn();
    const failure = await renameGroupChannel(
      client,
      { groupId: 'g1', name: 'Renamed', traceId: 't1' },
      onDone,
    );
    expect(groupRename).toHaveBeenCalledWith(client, {
      p_group_id: 'g1',
      p_name: 'Renamed',
      p_trace_id: 't1',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(failure).toBeNull();
  });
});

describe('addGroupMember', () => {
  it('calls groupMemberAdd with the target user id', async () => {
    vi.mocked(groupMemberAdd).mockResolvedValue(ok(undefined));
    const onDone = vi.fn();
    await addGroupMember(client, { groupId: 'g1', userId: 'u9', traceId: 't1' }, onDone);
    expect(groupMemberAdd).toHaveBeenCalledWith(client, {
      p_group_id: 'g1',
      p_user_id: 'u9',
      p_trace_id: 't1',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('removeGroupMember', () => {
  it('calls groupMemberRemove with the target user id', async () => {
    vi.mocked(groupMemberRemove).mockResolvedValue(ok(undefined));
    const onDone = vi.fn();
    await removeGroupMember(client, { groupId: 'g1', userId: 'u9', traceId: 't1' }, onDone);
    expect(groupMemberRemove).toHaveBeenCalledWith(client, {
      p_group_id: 'g1',
      p_user_id: 'u9',
      p_trace_id: 't1',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('returns the error and does not run onDone on ok:false', async () => {
    vi.mocked(groupMemberRemove).mockResolvedValue(domainFail);
    const onDone = vi.fn();
    const failure = await removeGroupMember(
      client,
      { groupId: 'g1', userId: 'u9', traceId: 't1' },
      onDone,
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(failure?.message).toBe('nope');
  });
});

describe('leaveGroupChannel', () => {
  it('calls groupLeave with the group id (no caller-supplied actor)', async () => {
    vi.mocked(groupLeave).mockResolvedValue(ok(undefined));
    const onDone = vi.fn();
    await leaveGroupChannel(client, { groupId: 'g1', traceId: 't1' }, onDone);
    expect(groupLeave).toHaveBeenCalledWith(client, { p_group_id: 'g1', p_trace_id: 't1' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
