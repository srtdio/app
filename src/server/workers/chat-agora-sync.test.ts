import { describe, expect, it, vi } from 'vitest';

import {
  mapChangePayload,
  processEvent,
  reconcile,
  type ChangePayload,
  type SyncDeps,
  type SyncReader,
} from './chat-agora-sync';
import { createAgoraGroupApi, type AgoraGroupApi, type TracedFetchFn } from './chat-agora-rest';
import { toAgoraUsername } from './agora-identity';

const CHANNEL = 'group__11111111-1111-7111-8111-111111111111__grp';
const GROUP_ID = '99999999-9999-7999-8999-999999999999';
const CREATOR = '44444444-4444-7444-8444-444444444444';
const MEMBER = '55555555-5555-7555-8555-555555555555';
const AGORA_GROUP_ID = '170000000000000001';

function fakeAgora(overrides: Partial<AgoraGroupApi> = {}): {
  agora: AgoraGroupApi;
  createGroup: ReturnType<typeof vi.fn>;
  addMember: ReturnType<typeof vi.fn>;
  removeMember: ReturnType<typeof vi.fn>;
  updateGroupName: ReturnType<typeof vi.fn>;
} {
  const createGroup = vi.fn(() => Promise.resolve(AGORA_GROUP_ID));
  const addMember = vi.fn(() => Promise.resolve());
  const removeMember = vi.fn(() => Promise.resolve());
  const updateGroupName = vi.fn(() => Promise.resolve());
  const agora = { createGroup, addMember, removeMember, updateGroupName, ...overrides };
  return { agora, createGroup, addMember, removeMember, updateGroupName };
}

function fakeReader(overrides: Partial<SyncReader> = {}): {
  reader: SyncReader;
  markSynced: ReturnType<typeof vi.fn>;
} {
  const markSynced = vi.fn(() => Promise.resolve());
  const reader: SyncReader = {
    getGroup: () => Promise.resolve({ name: 'Marketing', createdBy: CREATOR }),
    getGroupMemberIds: () => Promise.resolve([CREATOR, MEMBER]),
    getChannelByGroupId: () =>
      Promise.resolve({ channelId: CHANNEL, agoraGroupId: AGORA_GROUP_ID }),
    markSynced,
    listUnsyncedChannels: () => Promise.resolve([]),
    ...overrides,
  };
  return { reader, markSynced };
}

function deps(reader: SyncReader, agora: AgoraGroupApi): SyncDeps {
  return {
    reader,
    agora,
    newTraceId: () => 'trace-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

  it('maps group_members INSERT and DELETE', () => {
    expect(
      mapChangePayload(
        base({
          table: 'group_members',
          eventType: 'INSERT',
          new: { group_id: GROUP_ID, user_id: MEMBER },
        }),
      ),
    ).toEqual({ kind: 'member_insert', groupId: GROUP_ID, userId: MEMBER });
    expect(
      mapChangePayload(
        base({
          table: 'group_members',
          eventType: 'DELETE',
          old: { group_id: GROUP_ID, user_id: MEMBER },
        }),
      ),
    ).toEqual({ kind: 'member_delete', groupId: GROUP_ID, userId: MEMBER });
  });

  it('maps a groups UPDATE only when the name changed', () => {
    expect(
      mapChangePayload(
        base({
          table: 'groups',
          eventType: 'UPDATE',
          new: { id: GROUP_ID, name: 'New' },
          old: { name: 'Old' },
        }),
      ),
    ).toEqual({ kind: 'group_rename', groupId: GROUP_ID, name: 'New' });
    expect(
      mapChangePayload(
        base({
          table: 'groups',
          eventType: 'UPDATE',
          new: { id: GROUP_ID, name: 'Same' },
          old: { name: 'Same' },
        }),
      ),
    ).toBeNull();
  });

  it('ignores unwatched changes', () => {
    expect(mapChangePayload(base({ table: 'posts', eventType: 'INSERT' }))).toBeNull();
    expect(
      mapChangePayload(
        base({ table: 'chat_channels', eventType: 'UPDATE', new: { channel_id: CHANNEL } }),
      ),
    ).toBeNull();
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

  it('member insert with a synced group: adds the member to the Agora group', async () => {
    const { reader } = fakeReader();
    const { agora, addMember } = fakeAgora();
    await processEvent(
      { kind: 'member_insert', groupId: GROUP_ID, userId: MEMBER },
      deps(reader, agora),
    );

    expect(addMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
  });

  it('member insert with an unsynced group: deferred no-op, no crash', async () => {
    const { reader } = fakeReader({
      getChannelByGroupId: () => Promise.resolve({ channelId: CHANNEL, agoraGroupId: null }),
    });
    const { agora, addMember } = fakeAgora();
    await processEvent(
      { kind: 'member_insert', groupId: GROUP_ID, userId: MEMBER },
      deps(reader, agora),
    );

    expect(addMember).not.toHaveBeenCalled();
  });

  it('member delete: removes the member from the Agora group', async () => {
    const { reader } = fakeReader();
    const { agora, removeMember } = fakeAgora();
    await processEvent(
      { kind: 'member_delete', groupId: GROUP_ID, userId: MEMBER },
      deps(reader, agora),
    );

    expect(removeMember).toHaveBeenCalledWith(AGORA_GROUP_ID, toAgoraUsername(MEMBER), 'trace-1');
  });

  it('group rename with a synced group: updates the Agora group name', async () => {
    const { reader } = fakeReader();
    const { agora, updateGroupName } = fakeAgora();
    await processEvent(
      { kind: 'group_rename', groupId: GROUP_ID, name: 'Renamed' },
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
      processEvent({ kind: 'member_insert', groupId: GROUP_ID, userId: MEMBER }, d),
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

  it('addMember throws on a genuine (non-idempotent) failure', async () => {
    const { fetchImpl } = fetchReturning([new Response('internal error', { status: 500 })]);
    const api = createAgoraGroupApi(config, fetchImpl);
    await expect(api.addMember(AGORA_GROUP_ID, 'u_member', 'trace-1')).rejects.toThrow();
  });
});
