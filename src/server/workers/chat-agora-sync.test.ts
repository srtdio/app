import { describe, expect, it, vi } from 'vitest';

import {
  SYNC_EVENT_BATCH_SIZE,
  drainSyncEvents,
  healthResponse,
  mapChangePayload,
  processEvent,
  reconcile,
  runScheduled,
  toSyncEvent,
  type ChangePayload,
  type SyncDeps,
  type SyncEventRow,
  type SyncReader,
} from './chat-agora-sync';
import {
  AgoraRestError,
  MAX_AGORA_BODY_CHARS,
  REGISTER_BATCH_SIZE,
  createAgoraGroupApi,
  isAddMemberIdempotent,
  isRemoveMemberIdempotent,
  type AgoraGroupApi,
  type TracedFetchFn,
} from './chat-agora-rest';
import { toAgoraUsername } from './agora-identity';

const CHANNEL = 'group__11111111-1111-7111-8111-111111111111__grp';
const OTHER_CHANNEL = 'group__11111111-1111-7111-8111-111111111111__other';
const GROUP_ID = '99999999-9999-7999-8999-999999999999';
const CREATOR = '44444444-4444-7444-8444-444444444444';
const MEMBER = '55555555-5555-7555-8555-555555555555';
const AGORA_GROUP_ID = '170000000000000001';
const OTHER_AGORA_GROUP_ID = '170000000000000002';

function fakeAgora(overrides: Partial<AgoraGroupApi> = {}): {
  agora: AgoraGroupApi;
  ensureUsers: ReturnType<typeof vi.fn>;
  createGroup: ReturnType<typeof vi.fn>;
  addMember: ReturnType<typeof vi.fn>;
  removeMember: ReturnType<typeof vi.fn>;
  updateGroupName: ReturnType<typeof vi.fn>;
} {
  const ensureUsers = vi.fn<(usernames: string[], traceId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const createGroup = vi.fn(() => Promise.resolve(AGORA_GROUP_ID));
  const addMember = vi.fn(() => Promise.resolve());
  const removeMember = vi.fn(() => Promise.resolve());
  const updateGroupName = vi.fn(() => Promise.resolve());
  const agora = {
    ensureUsers,
    createGroup,
    addMember,
    removeMember,
    updateGroupName,
    ...overrides,
  };
  return { agora, ensureUsers, createGroup, addMember, removeMember, updateGroupName };
}

function fakeReader(overrides: Partial<SyncReader> = {}): {
  reader: SyncReader;
  markSynced: ReturnType<typeof vi.fn>;
  getChannelAgoraGroupIds: ReturnType<typeof vi.fn>;
  markSyncEventProcessed: ReturnType<typeof vi.fn>;
  markSyncEventFailed: ReturnType<typeof vi.fn>;
} {
  const markSynced = vi.fn(() => Promise.resolve());
  const getChannelAgoraGroupIds = vi.fn(() =>
    Promise.resolve(
      new Map<string, string | null>([
        [CHANNEL, AGORA_GROUP_ID],
        [OTHER_CHANNEL, OTHER_AGORA_GROUP_ID],
      ]),
    ),
  );
  const markSyncEventProcessed = vi.fn(() => Promise.resolve());
  const markSyncEventFailed = vi.fn(() => Promise.resolve());
  const reader: SyncReader = {
    getGroup: () => Promise.resolve({ name: 'Marketing', createdBy: CREATOR }),
    getGroupMemberIds: () => Promise.resolve([CREATOR, MEMBER]),
    markSynced,
    listUnsyncedChannels: () => Promise.resolve([]),
    listPendingSyncEvents: () => Promise.resolve([]),
    getChannelAgoraGroupIds,
    markSyncEventProcessed,
    markSyncEventFailed,
    countStuckSyncEvents: () => Promise.resolve(0),
    countPendingSyncEvents: () => Promise.resolve(0),
    countPendingSyncEventsForChannels: () => Promise.resolve(0),
    listUnsyncedGroupChannelIds: () => Promise.resolve([]),
    ...overrides,
  };
  return {
    reader,
    markSynced,
    getChannelAgoraGroupIds,
    markSyncEventProcessed,
    markSyncEventFailed,
  };
}

function deps(reader: SyncReader, agora: AgoraGroupApi): SyncDeps {
  return {
    reader,
    agora,
    newTraceId: () => 'trace-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function eventRow(over: Partial<SyncEventRow> = {}): SyncEventRow {
  return {
    id: '01990000-0000-7000-8000-000000000001',
    eventType: 'member_add',
    channelId: CHANNEL,
    userId: MEMBER,
    payload: {},
    attempts: 0,
    ...over,
  };
}

describe('mapChangePayload', () => {
  const base = (over: Partial<ChangePayload>): ChangePayload => ({
    table: '',
    eventType: 'INSERT',
    new: {},
    old: {},
    ...over,
  });

  it('maps a chat_channels INSERT', () => {
    const event = mapChangePayload(
      base({
        table: 'chat_channels',
        eventType: 'INSERT',
        new: { channel_id: CHANNEL, channel_type: 'group', entity_id: GROUP_ID },
      }),
    );
    expect(event).toEqual({
      kind: 'channel_insert',
      channelId: CHANNEL,
      channelType: 'group',
      groupId: GROUP_ID,
      agoraGroupId: null,
    });
  });

  it('ignores unwatched changes (membership and renames flow through the outbox)', () => {
    expect(mapChangePayload(base({ table: 'posts', eventType: 'INSERT' }))).toBeNull();
    expect(
      mapChangePayload(
        base({ table: 'chat_channels', eventType: 'UPDATE', new: { channel_id: CHANNEL } }),
      ),
    ).toBeNull();
    expect(
      mapChangePayload(
        base({
          table: 'group_members',
          eventType: 'INSERT',
          new: { group_id: GROUP_ID, user_id: MEMBER },
        }),
      ),
    ).toBeNull();
    expect(
      mapChangePayload(
        base({
          table: 'groups',
          eventType: 'UPDATE',
          new: { id: GROUP_ID, name: 'New' },
          old: { name: 'Old' },
        }),
      ),
    ).toBeNull();
  });
});

describe('toSyncEvent', () => {
  it('maps member_add / member_remove / group_rename outbox rows', () => {
    expect(toSyncEvent(eventRow({ eventType: 'member_add' }), AGORA_GROUP_ID)).toEqual({
      kind: 'member_add',
      agoraGroupId: AGORA_GROUP_ID,
      userId: MEMBER,
    });
    expect(toSyncEvent(eventRow({ eventType: 'member_remove' }), AGORA_GROUP_ID)).toEqual({
      kind: 'member_remove',
      agoraGroupId: AGORA_GROUP_ID,
      userId: MEMBER,
    });
    expect(
      toSyncEvent(
        eventRow({ eventType: 'group_rename', userId: null, payload: { name: 'Renamed' } }),
        AGORA_GROUP_ID,
      ),
    ).toEqual({ kind: 'group_rename', agoraGroupId: AGORA_GROUP_ID, name: 'Renamed' });
  });

  it('throws on a malformed row so the drain records a failed attempt', () => {
    expect(() => toSyncEvent(eventRow({ userId: null }), AGORA_GROUP_ID)).toThrow(/user_id/);
    expect(() =>
      toSyncEvent(eventRow({ eventType: 'group_rename', payload: {} }), AGORA_GROUP_ID),
    ).toThrow(/payload\.name/);
    expect(() => toSyncEvent(eventRow({ eventType: 'nope' }), AGORA_GROUP_ID)).toThrow(
      /unsupported/,
    );
  });
});

describe('processEvent', () => {
  it('group channel insert: creates the Agora group with mapped usernames, marks synced', async () => {
    const { reader, markSynced } = fakeReader();
    const { agora, createGroup } = fakeAgora();
    await processEvent(
      {
        kind: 'channel_insert',
        channelId: CHANNEL,
        channelType: 'group',
        groupId: GROUP_ID,
        agoraGroupId: null,
      },
      deps(reader, agora),
    );

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(createGroup.mock.calls[0]![0]).toEqual({
      name: 'Marketing',
      ownerUsername: toAgoraUsername(CREATOR),
      memberUsernames: [toAgoraUsername(CREATOR), toAgoraUsername(MEMBER)],
    });
    expect(markSynced).toHaveBeenCalledWith(CHANNEL, AGORA_GROUP_ID, 'trace-1');
  });

  it('dm channel insert: marks synced with a null group id, no Agora create', async () => {
    const { reader, markSynced } = fakeReader();
    const { agora, createGroup } = fakeAgora();
    await processEvent(
      {
        kind: 'channel_insert',
        channelId: 'dm__x',
        channelType: 'dm',
        groupId: null,
        agoraGroupId: null,
      },
      deps(reader, agora),
    );

    expect(createGroup).not.toHaveBeenCalled();
    expect(markSynced).toHaveBeenCalledWith('dm__x', null, 'trace-1');
  });

  it('group channel insert is idempotent: an already-synced redelivery skips create', async () => {
    const { reader, markSynced } = fakeReader();
    const { agora, createGroup } = fakeAgora();
    await processEvent(
      {
        kind: 'channel_insert',
        channelId: CHANNEL,
        channelType: 'group',
        groupId: GROUP_ID,
        agoraGroupId: AGORA_GROUP_ID,
      },
      deps(reader, agora),
    );

    expect(createGroup).not.toHaveBeenCalled();
    expect(markSynced).toHaveBeenCalledWith(CHANNEL, AGORA_GROUP_ID, 'trace-1');
  });

  it('member_add: adds the mapped username to the Agora group', async () => {
    const { reader } = fakeReader();
    const { agora, addMember } = fakeAgora();
    await processEvent(
      { kind: 'member_add', agoraGroupId: AGORA_GROUP_ID, userId: MEMBER },
      deps(reader, agora),
    );

    expect(addMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
  });

  it('member_remove: removes the mapped username from the Agora group', async () => {
    const { reader } = fakeReader();
    const { agora, removeMember } = fakeAgora();
    await processEvent(
      { kind: 'member_remove', agoraGroupId: AGORA_GROUP_ID, userId: MEMBER },
      deps(reader, agora),
    );

    expect(removeMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
  });

  it('group_rename: updates the Agora group name', async () => {
    const { reader } = fakeReader();
    const { agora, updateGroupName } = fakeAgora();
    await processEvent(
      { kind: 'group_rename', agoraGroupId: AGORA_GROUP_ID, name: 'Renamed' },
      deps(reader, agora),
    );

    expect(updateGroupName).toHaveBeenCalledWith(AGORA_GROUP_ID, 'Renamed', 'trace-1');
  });

  it('swallows an Agora failure (logs, does not throw)', async () => {
    const { reader } = fakeReader();
    const { agora } = fakeAgora({
      addMember: () => Promise.reject(new Error('agora down')),
    });
    const d = deps(reader, agora);
    await expect(
      processEvent({ kind: 'member_add', agoraGroupId: AGORA_GROUP_ID, userId: MEMBER }, d),
    ).resolves.toBeUndefined();
    expect(d.log.error).toHaveBeenCalled();
  });
});

describe('reconcile', () => {
  const DM_CHANNEL = 'dm__22222222-2222-7222-8222-222222222222';

  it('syncs an unsynced batch: creates the group, stamps the group and the dm', async () => {
    const { reader, markSynced } = fakeReader({
      listUnsyncedChannels: () =>
        Promise.resolve([
          {
            channelId: DM_CHANNEL,
            channelType: 'dm',
            entityId: null,
            agoraGroupId: null,
          },
          {
            channelId: CHANNEL,
            channelType: 'group',
            entityId: GROUP_ID,
            agoraGroupId: null,
          },
        ]),
    });
    const { agora, createGroup } = fakeAgora();
    await reconcile(deps(reader, agora));

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(createGroup.mock.calls[0]![0]).toEqual({
      name: 'Marketing',
      ownerUsername: toAgoraUsername(CREATOR),
      memberUsernames: [toAgoraUsername(CREATOR), toAgoraUsername(MEMBER)],
    });
    expect(markSynced).toHaveBeenCalledTimes(2);
    expect(markSynced).toHaveBeenCalledWith(CHANNEL, AGORA_GROUP_ID, 'trace-1');
    expect(markSynced).toHaveBeenCalledWith(DM_CHANNEL, null, 'trace-1');
  });

  it('W1: registers the owner and every member in one call before createGroup', async () => {
    const { reader } = fakeReader({
      listUnsyncedChannels: () =>
        Promise.resolve([
          { channelId: CHANNEL, channelType: 'group', entityId: GROUP_ID, agoraGroupId: null },
        ]),
    });
    const { agora, ensureUsers, createGroup } = fakeAgora();
    await reconcile(deps(reader, agora));

    expect(ensureUsers).toHaveBeenCalledTimes(1);
    expect(new Set(ensureUsers.mock.calls[0]![0])).toEqual(
      new Set([toAgoraUsername(CREATOR), toAgoraUsername(MEMBER)]),
    );
    expect(ensureUsers.mock.invocationCallOrder[0]!).toBeLessThan(
      createGroup.mock.invocationCallOrder[0]!,
    );
  });

  it('W1: a register failure skips createGroup and leaves the channel unsynced', async () => {
    const { reader, markSynced } = fakeReader({
      listUnsyncedChannels: () =>
        Promise.resolve([
          { channelId: CHANNEL, channelType: 'group', entityId: GROUP_ID, agoraGroupId: null },
        ]),
    });
    const { agora, createGroup } = fakeAgora({
      ensureUsers: () => Promise.reject(new AgoraRestError('register_users', 500, 'boom')),
    });
    await reconcile(deps(reader, agora));

    expect(createGroup).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
  });

  it('W2: logs an Agora failure with status, truncated body, channel_id, operation, trace id', async () => {
    const { reader } = fakeReader({
      listUnsyncedChannels: () =>
        Promise.resolve([
          { channelId: CHANNEL, channelType: 'group', entityId: GROUP_ID, agoraGroupId: null },
        ]),
    });
    const longBody = 'x'.repeat(2_000);
    const { agora } = fakeAgora({
      createGroup: () => Promise.reject(new AgoraRestError('create_group', 400, longBody)),
    });
    const d = deps(reader, agora);
    await reconcile(d);

    expect(d.log.error).toHaveBeenCalledWith(
      'chat_agora_sync event failed',
      expect.objectContaining({
        trace_id: 'trace-1',
        channel_id: CHANNEL,
        operation: 'create_group',
        status: 400,
        body: 'x'.repeat(MAX_AGORA_BODY_CHARS),
      }),
    );
  });

  it('skips an unsynced group whose creator is null: no create, no stamp', async () => {
    const { reader, markSynced } = fakeReader({
      getGroup: () => Promise.resolve({ name: 'Orphan', createdBy: null }),
      listUnsyncedChannels: () =>
        Promise.resolve([
          {
            channelId: CHANNEL,
            channelType: 'group',
            entityId: GROUP_ID,
            agoraGroupId: null,
          },
        ]),
    });
    const { agora, createGroup } = fakeAgora();
    await reconcile(deps(reader, agora));

    expect(createGroup).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
  });
});

describe('drainSyncEvents', () => {
  it('member_add success: calls addMember and stamps the row processed', async () => {
    const row = eventRow();
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora, addMember } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(addMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
    expect(markSyncEventProcessed).toHaveBeenCalledWith(row.id);
    expect(markSyncEventFailed).not.toHaveBeenCalled();
  });

  it('member_remove success: calls removeMember and stamps the row processed', async () => {
    const row = eventRow({ eventType: 'member_remove' });
    const { reader, markSyncEventProcessed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora, removeMember } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(removeMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
    expect(markSyncEventProcessed).toHaveBeenCalledWith(row.id);
  });

  it('group_rename: calls the REST helper with payload.name and stamps processed', async () => {
    const row = eventRow({ eventType: 'group_rename', userId: null, payload: { name: 'Renamed' } });
    const { reader, markSyncEventProcessed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora, updateGroupName } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(updateGroupName).toHaveBeenCalledWith(AGORA_GROUP_ID, 'Renamed', 'trace-1');
    expect(markSyncEventProcessed).toHaveBeenCalledWith(row.id);
  });

  it('"already a member" and "not a member" Agora responses count as success', async () => {
    const responses = [
      new Response('', { status: 200 }),
      new Response('user is already a member of the group', { status: 400 }),
      new Response('user not found', { status: 404 }),
    ];
    let i = 0;
    const fetchImpl: TracedFetchFn = () =>
      Promise.resolve(responses[i++] ?? new Response('', { status: 200 }));
    const agora = createAgoraGroupApi(
      { appId: 'app', appCertificate: 'cert', restUrl: 'https://rest.agora/org/app' },
      fetchImpl,
    );
    const rows = [
      eventRow({ id: 'evt-add', eventType: 'member_add' }),
      eventRow({ id: 'evt-remove', eventType: 'member_remove' }),
    ];
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve(rows),
    });
    await drainSyncEvents(deps(reader, agora));

    expect(markSyncEventProcessed).toHaveBeenCalledTimes(2);
    expect(markSyncEventProcessed).toHaveBeenCalledWith('evt-add');
    expect(markSyncEventProcessed).toHaveBeenCalledWith('evt-remove');
    expect(markSyncEventFailed).not.toHaveBeenCalled();
  });

  it('failure: increments attempts, records last_error, logs event id + trace id, row stays pending', async () => {
    const row = eventRow({ attempts: 3 });
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora } = fakeAgora({ addMember: () => Promise.reject(new Error('agora down')) });
    const d = deps(reader, agora);
    await drainSyncEvents(d);

    expect(markSyncEventProcessed).not.toHaveBeenCalled();
    expect(markSyncEventFailed).toHaveBeenCalledTimes(1);
    expect(markSyncEventFailed).toHaveBeenCalledWith(row.id, 4, 'Error: agora down');
    expect(d.log.error).toHaveBeenCalledWith(
      'chat_agora_sync outbox event failed',
      expect.objectContaining({ trace_id: 'trace-1', event_id: row.id, attempts: 4 }),
    );
  });

  it('a malformed row is a failed attempt, not a silent drop', async () => {
    const row = eventRow({ eventType: 'group_rename', payload: {} });
    const { reader, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora, updateGroupName } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(updateGroupName).not.toHaveBeenCalled();
    expect(markSyncEventFailed).toHaveBeenCalledWith(row.id, 1, expect.stringContaining('name'));
  });

  it('unsynced channel (agora_group_id null): row is skipped untouched, no Agora call', async () => {
    const row = eventRow();
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
      getChannelAgoraGroupIds: () => Promise.resolve(new Map([[CHANNEL, null]])),
    });
    const { agora, addMember } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(addMember).not.toHaveBeenCalled();
    expect(markSyncEventProcessed).not.toHaveBeenCalled();
    expect(markSyncEventFailed).not.toHaveBeenCalled();
  });

  it('loads the channels for the batch with a single query over the distinct ids', async () => {
    const rows = [
      eventRow({ id: 'e1', channelId: CHANNEL }),
      eventRow({ id: 'e2', channelId: OTHER_CHANNEL }),
      eventRow({ id: 'e3', channelId: CHANNEL, eventType: 'member_remove' }),
    ];
    const { reader, getChannelAgoraGroupIds, markSyncEventProcessed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve(rows),
    });
    const { agora, addMember, removeMember } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(getChannelAgoraGroupIds).toHaveBeenCalledTimes(1);
    expect(getChannelAgoraGroupIds).toHaveBeenCalledWith([CHANNEL, OTHER_CHANNEL]);
    expect(addMember).toHaveBeenCalledWith(
      OTHER_AGORA_GROUP_ID,
      toAgoraUsername(MEMBER),
      'trace-1',
    );
    expect(removeMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
    expect(markSyncEventProcessed).toHaveBeenCalledTimes(3);
  });

  it('keeps per-channel order: after a failure, later rows for that channel wait; other channels proceed', async () => {
    const rows = [
      eventRow({ id: 'e1', channelId: CHANNEL, eventType: 'member_add' }),
      eventRow({ id: 'e2', channelId: OTHER_CHANNEL, eventType: 'member_add' }),
      eventRow({ id: 'e3', channelId: CHANNEL, eventType: 'member_remove' }),
    ];
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve(rows),
    });
    const { agora, removeMember } = fakeAgora({
      addMember: (groupId: string) =>
        groupId === AGORA_GROUP_ID ? Promise.reject(new Error('agora down')) : Promise.resolve(),
    });
    await drainSyncEvents(deps(reader, agora));

    expect(markSyncEventFailed).toHaveBeenCalledTimes(1);
    expect(markSyncEventFailed.mock.calls[0]![0]).toBe('e1');
    expect(removeMember).not.toHaveBeenCalled();
    expect(markSyncEventProcessed).toHaveBeenCalledTimes(1);
    expect(markSyncEventProcessed).toHaveBeenCalledWith('e2');
  });

  it('W1: registers every member_add user in one bulk call before any addMember', async () => {
    const OTHER_MEMBER = '66666666-6666-7666-8666-666666666666';
    const rows = [
      eventRow({ id: 'e1', channelId: CHANNEL, userId: MEMBER }),
      eventRow({ id: 'e2', channelId: OTHER_CHANNEL, userId: OTHER_MEMBER }),
      eventRow({ id: 'e3', channelId: CHANNEL, userId: MEMBER, eventType: 'member_remove' }),
    ];
    const { reader } = fakeReader({ listPendingSyncEvents: () => Promise.resolve(rows) });
    const { agora, ensureUsers, addMember } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(ensureUsers).toHaveBeenCalledTimes(1);
    expect(ensureUsers).toHaveBeenCalledWith(
      [toAgoraUsername(MEMBER), toAgoraUsername(OTHER_MEMBER)],
      'trace-1',
    );
    expect(ensureUsers.mock.invocationCallOrder[0]!).toBeLessThan(
      addMember.mock.invocationCallOrder[0]!,
    );
    expect(addMember).toHaveBeenCalledTimes(2);
  });

  it('W1: when the bulk register fails, each member_add registers its own user first', async () => {
    const row = eventRow();
    const { reader, markSyncEventProcessed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const ensureUsers = vi
      .fn<(usernames: string[], traceId: string) => Promise<void>>(() => Promise.resolve())
      .mockRejectedValueOnce(new AgoraRestError('register_users', 503, 'busy'));
    const { agora, addMember } = fakeAgora({ ensureUsers });
    await drainSyncEvents(deps(reader, agora));

    expect(ensureUsers).toHaveBeenCalledTimes(2);
    expect(ensureUsers.mock.calls[1]![0]).toEqual([toAgoraUsername(MEMBER)]);
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(markSyncEventProcessed).toHaveBeenCalledWith(row.id);
  });

  it('W2: logs an Agora failure with status, truncated body, channel_id, operation, trace id', async () => {
    const row = eventRow();
    const { reader, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora } = fakeAgora({
      addMember: () => Promise.reject(new AgoraRestError('add_member', 403, 'y'.repeat(900))),
    });
    const d = deps(reader, agora);
    await drainSyncEvents(d);

    expect(d.log.error).toHaveBeenCalledWith(
      'chat_agora_sync outbox event failed',
      expect.objectContaining({
        trace_id: 'trace-1',
        event_id: row.id,
        channel_id: CHANNEL,
        operation: 'add_member',
        status: 403,
        body: 'y'.repeat(MAX_AGORA_BODY_CHARS),
      }),
    );
    expect(markSyncEventFailed).toHaveBeenCalledWith(row.id, 1, expect.stringContaining('403'));
  });

  it('W4: head-of-line rows for an unsynced channel are deferred and do not block or consume the cap', async () => {
    const UNSYNCED = 'group__11111111-1111-7111-8111-111111111111__unsynced';
    const blocked = Array.from({ length: 150 }, (_, n) =>
      eventRow({ id: `u${n}`, channelId: UNSYNCED }),
    );
    const ready = Array.from({ length: 150 }, (_, n) =>
      eventRow({
        id: `r${n}`,
        channelId: n % 2 === 0 ? CHANNEL : OTHER_CHANNEL,
        eventType: 'group_rename',
        userId: null,
        payload: { name: `n${n}` },
      }),
    );
    const getChannelAgoraGroupIds = vi.fn<(ids: string[]) => Promise<Map<string, string | null>>>(
      () =>
        Promise.resolve(
          new Map<string, string | null>([
            [UNSYNCED, null],
            [CHANNEL, AGORA_GROUP_ID],
            [OTHER_CHANNEL, OTHER_AGORA_GROUP_ID],
          ]),
        ),
    );
    const { reader, markSyncEventProcessed, markSyncEventFailed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve([...blocked, ...ready]),
      getChannelAgoraGroupIds,
    });
    const { agora, updateGroupName } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    // A single channels query over the distinct channel ids.
    expect(getChannelAgoraGroupIds).toHaveBeenCalledTimes(1);
    expect(getChannelAgoraGroupIds).toHaveBeenCalledWith([UNSYNCED, CHANNEL, OTHER_CHANNEL]);
    // Per-run cap: exactly SYNC_EVENT_BATCH_SIZE processed, in created_at order.
    expect(markSyncEventProcessed).toHaveBeenCalledTimes(SYNC_EVENT_BATCH_SIZE);
    expect(markSyncEventProcessed.mock.calls.map((c: unknown[]) => c[0])).toEqual(
      ready.slice(0, SYNC_EVENT_BATCH_SIZE).map((r) => r.id),
    );
    expect(updateGroupName).toHaveBeenCalledTimes(SYNC_EVENT_BATCH_SIZE);
    // Deferred rows are untouched.
    expect(markSyncEventFailed).not.toHaveBeenCalled();
  });

  it('W5: a markSyncEventFailed error is logged and the batch continues', async () => {
    const rows = [
      eventRow({ id: 'e1', channelId: CHANNEL }),
      eventRow({ id: 'e2', channelId: OTHER_CHANNEL }),
    ];
    const { reader, markSyncEventProcessed } = fakeReader({
      listPendingSyncEvents: () => Promise.resolve(rows),
      markSyncEventFailed: () => Promise.reject(new Error('db write failed')),
    });
    const { agora } = fakeAgora({
      addMember: (groupId: string) =>
        groupId === AGORA_GROUP_ID ? Promise.reject(new Error('agora down')) : Promise.resolve(),
    });
    const d = deps(reader, agora);
    await expect(drainSyncEvents(d)).resolves.toBeUndefined();

    expect(d.log.error).toHaveBeenCalledWith(
      'chat_agora_sync outbox mark failed errored',
      expect.objectContaining({ trace_id: 'trace-1', event_id: 'e1' }),
    );
    expect(markSyncEventProcessed).toHaveBeenCalledWith('e2');
  });

  it('an empty outbox makes no channel query', async () => {
    const { reader, getChannelAgoraGroupIds } = fakeReader();
    const { agora } = fakeAgora();
    await drainSyncEvents(deps(reader, agora));

    expect(getChannelAgoraGroupIds).not.toHaveBeenCalled();
  });
});

describe('runScheduled', () => {
  it('runs the outbox drain even when reconcile throws', async () => {
    const row = eventRow();
    const { reader, markSyncEventProcessed } = fakeReader({
      listUnsyncedChannels: () => Promise.reject(new Error('db down')),
      listPendingSyncEvents: () => Promise.resolve([row]),
    });
    const { agora } = fakeAgora();
    const d = deps(reader, agora);
    await expect(runScheduled(d)).resolves.toBeUndefined();

    expect(d.log.error).toHaveBeenCalledWith(
      'chat_agora_sync reconcile failed',
      expect.objectContaining({ trace_id: 'trace-1' }),
    );
    expect(markSyncEventProcessed).toHaveBeenCalledWith(row.id);
  });
});

describe('healthResponse', () => {
  it('W6: reports pending, deferred, stuck counts and unsynced channel ids', async () => {
    const forChannels = vi.fn<(ids: string[]) => Promise<number>>(() => Promise.resolve(2));
    const { reader } = fakeReader({
      countStuckSyncEvents: () => Promise.resolve(3),
      countPendingSyncEvents: () => Promise.resolve(7),
      countPendingSyncEventsForChannels: forChannels,
      listUnsyncedGroupChannelIds: () => Promise.resolve([CHANNEL, OTHER_CHANNEL]),
    });
    const { agora } = fakeAgora();
    const response = await healthResponse(deps(reader, agora));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'chat-agora-sync',
      pending_sync_events: 7,
      deferred_sync_events: 2,
      stuck_sync_events: 3,
      unsynced_channel_ids: [CHANNEL, OTHER_CHANNEL],
    });
    expect(forChannels).toHaveBeenCalledTimes(1);
    expect(forChannels).toHaveBeenCalledWith([CHANNEL, OTHER_CHANNEL]);
  });

  it('returns 503 when the count cannot be read', async () => {
    const { reader } = fakeReader({
      countStuckSyncEvents: () => Promise.reject(new Error('db down')),
    });
    const { agora } = fakeAgora();
    const response = await healthResponse(deps(reader, agora));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe('createAgoraGroupApi', () => {
  const config = { appId: 'app', appCertificate: 'cert', restUrl: 'https://rest.agora/org/app/' };

  function fetchReturning(responses: Response[]): {
    fetchImpl: TracedFetchFn;
    calls: Array<{ url: string; init: RequestInit; traceId: string }>;
  } {
    const calls: Array<{ url: string; init: RequestInit; traceId: string }> = [];
    let i = 0;
    const fetchImpl: TracedFetchFn = (url, init, traceId) => {
      calls.push({ url, init, traceId });
      return Promise.resolve(responses[i++] ?? new Response('', { status: 200 }));
    };
    return { fetchImpl, calls };
  }

  it('createGroup returns Agora groupid and posts the mapped roster', async () => {
    const { fetchImpl, calls } = fetchReturning([
      new Response(JSON.stringify({ data: { groupid: AGORA_GROUP_ID } }), { status: 200 }),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    const groupId = await api.createGroup(
      { name: 'Marketing', ownerUsername: 'u_owner', memberUsernames: ['u_owner', 'u_member'] },
      'trace-1',
    );

    expect(groupId).toBe(AGORA_GROUP_ID);
    expect(calls[0]!.url).toBe('https://rest.agora/org/app/chatgroups');
    const body = JSON.parse(String(calls[0]!.init.body)) as { owner: string; members: string[] };
    expect(body.owner).toBe('u_owner');
    // The owner is auto-added by Agora; it is not duplicated in the roster.
    expect(body.members).toEqual(['u_member']);
  });

  it('addMember treats an "already a member" response as success', async () => {
    const { fetchImpl } = fetchReturning([
      new Response('user is already a member of the group', { status: 400 }),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.addMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).resolves.toBeUndefined();
  });

  it('removeMember treats a "not found" response as success', async () => {
    const { fetchImpl } = fetchReturning([new Response('user not found', { status: 404 })]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.removeMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).resolves.toBeUndefined();
  });

  it.each(['already', 'already in', 'exist', 'ALREADY IN GROUP', 'User Exists'])(
    'W3: addMember treats a body containing %j as success',
    async (phrase) => {
      expect(isAddMemberIdempotent(400, phrase)).toBe(true);
      const { fetchImpl } = fetchReturning([new Response(phrase, { status: 400 })]);
      const api = createAgoraGroupApi(config, fetchImpl);
      await expect(api.addMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).resolves.toBeUndefined();
    },
  );

  it.each([
    'not a member',
    'not in group',
    'not in the group',
    'user_not_found',
    'not found',
    'does not exist',
    'not exist',
    'User Not A Member',
  ])('W3: removeMember treats a body containing %j as success', async (phrase) => {
    expect(isRemoveMemberIdempotent(400, phrase)).toBe(true);
    const { fetchImpl } = fetchReturning([new Response(phrase, { status: 400 })]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.removeMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).resolves.toBeUndefined();
  });

  it('W3: a 404 is success for both addMember and removeMember', async () => {
    expect(isAddMemberIdempotent(404, '')).toBe(true);
    expect(isRemoveMemberIdempotent(404, '')).toBe(true);
    const { fetchImpl } = fetchReturning([
      new Response('', { status: 404 }),
      new Response('', { status: 404 }),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.addMember(AGORA_GROUP_ID, 'u', 'trace-1')).resolves.toBeUndefined();
    await expect(api.removeMember(AGORA_GROUP_ID, 'u', 'trace-1')).resolves.toBeUndefined();
  });

  it('W3: matching is per operation (remove phrases do not excuse add, and vice versa)', async () => {
    expect(isAddMemberIdempotent(400, 'not a member')).toBe(false);
    expect(isRemoveMemberIdempotent(400, 'user is already in the group')).toBe(false);
    const { fetchImpl } = fetchReturning([
      new Response('forbidden', { status: 403 }),
      new Response('forbidden', { status: 403 }),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.addMember(AGORA_GROUP_ID, 'u', 'trace-1')).rejects.toBeInstanceOf(
      AgoraRestError,
    );
    await expect(api.removeMember(AGORA_GROUP_ID, 'u', 'trace-1')).rejects.toMatchObject({
      operation: 'remove_member',
      status: 403,
      body: 'forbidden',
    });
  });

  it('W1: ensureUsers bulk-registers in chunks of REGISTER_BATCH_SIZE via POST /users', async () => {
    const { fetchImpl, calls } = fetchReturning([]);
    const api = createAgoraGroupApi(config, fetchImpl);
    const names = Array.from({ length: REGISTER_BATCH_SIZE + 5 }, (_, n) => `u_${n}`);
    await api.ensureUsers([...names, 'u_0'], 'trace-1');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://rest.agora/org/app/users');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.traceId).toBe('trace-1');
    const first = JSON.parse(String(calls[0]!.init.body)) as Array<{ username: string }>;
    expect(first.map((u) => u.username)).toEqual(names.slice(0, REGISTER_BATCH_SIZE));
    const second = JSON.parse(String(calls[1]!.init.body)) as Array<{ username: string }>;
    expect(second.map((u) => u.username)).toEqual(names.slice(REGISTER_BATCH_SIZE));
  });

  it('W1: ensureUsers treats duplicates as success, falling back per user on a bulk duplicate', async () => {
    const dup = () => new Response('duplicate_unique_property_exists', { status: 400 });
    const { fetchImpl, calls } = fetchReturning([
      dup(),
      dup(),
      new Response('', { status: 200 }),
      dup(),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.ensureUsers(['a', 'b'], 'trace-1')).resolves.toBeUndefined();
    await expect(api.ensureUsers(['c'], 'trace-1')).resolves.toBeUndefined();

    expect(calls).toHaveLength(4);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ username: 'a' });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ username: 'b' });
  });

  it('W1: ensureUsers throws an AgoraRestError on a genuine failure', async () => {
    const { fetchImpl } = fetchReturning([new Response('unauthorized', { status: 401 })]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.ensureUsers(['a'], 'trace-1')).rejects.toMatchObject({
      operation: 'register_users',
      status: 401,
      body: 'unauthorized',
    });
  });

  it('addMember throws on a genuine (non-idempotent) failure', async () => {
    const { fetchImpl } = fetchReturning([new Response('internal error', { status: 500 })]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.addMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).rejects.toThrow();
  });

  it('updateGroupName PUTs the new groupname with the trace id and throws on failure', async () => {
    const { fetchImpl, calls } = fetchReturning([
      new Response('', { status: 200 }),
      new Response('internal error', { status: 500 }),
    ]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(
      api.updateGroupName(AGORA_GROUP_ID, 'Renamed', 'trace-1'),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`https://rest.agora/org/app/chatgroups/${AGORA_GROUP_ID}`);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.traceId).toBe('trace-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ groupname: 'Renamed' });
    await expect(api.updateGroupName(AGORA_GROUP_ID, 'Renamed', 'trace-1')).rejects.toThrow();
  });
});
