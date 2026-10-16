import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  createGroupSyncCheck,
  readGroupSyncRows,
  unsyncedGroupChannelIds,
  type GroupSyncRow,
} from '@/lib/chat/group-sync-check';

function summary(
  channelId: string,
  channelType: ChannelSummary['channelType'],
  agoraGroupId: string | null,
): ChannelSummary {
  return {
    channelId,
    channelType,
    title: channelId,
    avatarUrl: null,
    agoraGroupId,
    groupId: channelType === 'group' ? `g-${channelId}` : null,
    peerUserId: channelType === 'dm' ? 'peer' : null,
    role: null,
    createdAt: '2026-10-16T00:00:00Z',
  } as ChannelSummary;
}

function row(channelId: string, agoraGroupId: string | null): GroupSyncRow {
  return {
    channel_id: channelId,
    agora_group_id: agoraGroupId,
    last_synced_at: agoraGroupId === null ? null : '2026-10-16T00:01:00Z',
  };
}

function setup(roster: ChannelSummary[], rows: GroupSyncRow[]) {
  const read = vi.fn(async (ids: readonly string[]): Promise<Result<GroupSyncRow[]>> => {
    void ids;
    return { ok: true, data: rows };
  });
  const reload = vi.fn();
  const check = createGroupSyncCheck({ roster: () => roster, read, reload });
  return { check, read, reload };
}

describe('unsyncedGroupChannelIds', () => {
  it('lists only group channels with a null agoraGroupId', () => {
    expect(
      unsyncedGroupChannelIds([
        summary('g1', 'group', null),
        summary('g2', 'group', 'agora-2'),
        summary('d1', 'dm', null),
        summary('notes__u1', 'group', null),
        summary('g3', 'group', null),
      ]),
    ).toEqual(['g1', 'g3']);
  });
});

describe('createGroupSyncCheck', () => {
  it('unsynced group: one batched read of exactly those ids, then a roster reload when an id appears', async () => {
    const { check, read, reload } = setup(
      [
        summary('g1', 'group', null),
        summary('g2', 'group', 'agora-2'),
        summary('g3', 'group', null),
        summary('d1', 'dm', null),
      ],
      [row('g1', 'agora-1'), row('g3', null)],
    );
    await expect(check.run()).resolves.toBe('reloaded');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(['g1', 'g3']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('all groups synced: no read, no reload', async () => {
    const { check, read, reload } = setup(
      [summary('g1', 'group', 'agora-1'), summary('g2', 'group', 'agora-2')],
      [],
    );
    await expect(check.run()).resolves.toBe('none');
    expect(read).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('DM and notes channels with a null id are ignored: no read', async () => {
    const { check, read, reload } = setup(
      [summary('d1', 'dm', null), summary('notes__u1', 'notes', null), summary('g1', 'group', 'a')],
      [],
    );
    await expect(check.run()).resolves.toBe('none');
    expect(read).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('id still null: read, but no roster reload', async () => {
    const { check, read, reload } = setup([summary('g1', 'group', null)], [row('g1', null)]);
    await expect(check.run()).resolves.toBe('pending');
    expect(read).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a failed read keeps the roster and reports the error', async () => {
    const onError = vi.fn();
    const reload = vi.fn();
    const check = createGroupSyncCheck({
      roster: () => [summary('g1', 'group', null)],
      read: async () => ({ ok: false, error: { code: 'unknown', message: 'boom' } }),
      reload,
      onError,
    });
    await expect(check.run()).resolves.toBe('failed');
    expect(reload).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ error: 'boom' });
  });

  it('overlapping runs share one read', async () => {
    let resolve: (r: Result<GroupSyncRow[]>) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<Result<GroupSyncRow[]>>((r) => {
          resolve = r;
        }),
    );
    const reload = vi.fn();
    const check = createGroupSyncCheck({
      roster: () => [summary('g1', 'group', null)],
      read,
      reload,
    });
    const first = check.run();
    await expect(check.run()).resolves.toBe('busy');
    resolve({ ok: true, data: [row('g1', 'agora-1')] });
    await expect(first).resolves.toBe('reloaded');
    expect(read).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('disposed (workspace switch, unmount) mid-read: no reload', async () => {
    let resolve: (r: Result<GroupSyncRow[]>) => void = () => {};
    const reload = vi.fn();
    const check = createGroupSyncCheck({
      roster: () => [summary('g1', 'group', null)],
      read: () =>
        new Promise<Result<GroupSyncRow[]>>((r) => {
          resolve = r;
        }),
      reload,
    });
    const pending = check.run();
    check.dispose();
    resolve({ ok: true, data: [row('g1', 'agora-1')] });
    await expect(pending).resolves.toBe('none');
    expect(reload).not.toHaveBeenCalled();
    await expect(check.run()).resolves.toBe('none');
  });
});

describe('readGroupSyncRows', () => {
  it('reads chat_channels once with an IN clause on the given ids', async () => {
    const calls: { table: string; columns: string; column: string; ids: string[] }[] = [];
    const client = {
      from: (table: string) => ({
        select: (columns: string) => ({
          in: (column: string, ids: string[]) => {
            calls.push({ table, columns, column, ids });
            return Promise.resolve({ data: [row('g1', 'agora-1')], error: null });
          },
        }),
      }),
    };
    const result = await readGroupSyncRows(client as never, ['g1', 'g3']);
    expect(result).toEqual({ ok: true, data: [row('g1', 'agora-1')] });
    expect(calls).toEqual([
      {
        table: 'chat_channels',
        columns: 'channel_id, agora_group_id, last_synced_at',
        column: 'channel_id',
        ids: ['g1', 'g3'],
      },
    ]);
  });
});
