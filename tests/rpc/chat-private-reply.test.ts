// chat_private_reply_send through the @srtdio/rpc wrapper (chatPrivateReplySend),
// as the AUTHENTICATED role. A valid Reply privately (a group message quoted in
// the DM with its author) returns the chat_messages row with private_reply set;
// a refusal comes back as an error Result carrying the proc's message. The
// access rules themselves are covered in tests/rls/chat-private-reply.test.ts.
//
// The service-role admin client only seeds members, the group, its message and
// the DM. No teardown: this suite runs no DELETE; the fixtures live in their
// own workspace.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  chatPrivateReplySend,
  type ChatPrivateReplySendArgs,
  type Client,
  type DomainError,
  type Result,
} from '../../packages/rpc/src/index';

const RPC_SUITE = process.env.RPC_SUITE === '1';

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function expectError<T>(result: Result<T>): DomainError {
  if (result.ok) throw new Error('expected an error result, got ok');
  return result.error;
}

describe.runIf(RPC_SUITE)('chatPrivateReplySend (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let ws: SeededWorkspace;
  let groupName: string;
  let groupChannel: string;
  let dm: string;
  let sourceId: string;

  function args(channelId: string, id: string = uuidv7()): ChatPrivateReplySendArgs {
    return {
      p_id: id,
      p_channel_id: channelId,
      p_trace_id: uuidv7(),
      p_source_kind: 'chat',
      p_source_id: sourceId,
      p_body: 'On it, thanks.',
    };
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Private reply rpc ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');

    groupName = `Grp ${randomSuffix()}`;
    const group = await insertRow(g, 'groups', {
      workspace_id: ws.id,
      name: groupName,
      created_by: owner.id,
    });
    groupChannel = `group__${ws.id}__${String(group.id)}`;
    await insertRow(g, 'chat_channels', {
      channel_id: groupChannel,
      workspace_id: ws.id,
      channel_type: 'group',
      entity_id: group.id,
    });
    for (const member of [owner, agency]) {
      await insertRow(g, 'group_members', {
        group_id: group.id,
        user_id: member.id,
        workspace_id: ws.id,
      });
    }
    sourceId = crypto.randomUUID();
    await insertRow(g, 'chat_messages', {
      id: sourceId,
      channel_id: groupChannel,
      workspace_id: ws.id,
      sender_user_id: owner.id,
      body: 'Can we tighten the hook?',
      agora_event_id: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    dm = await seedDmChannel(g, ws.id, agency, owner);
  });

  it('a valid send returns the DM row with private_reply', async () => {
    const client: Client = clientFor(agency.id);
    const sent = args(dm);
    const row = expectOk(await chatPrivateReplySend(client, sent));
    expect(row.id).toBe(sent.p_id);
    expect(row.channel_id).toBe(dm);
    expect(row.sender_user_id).toBe(agency.id);
    expect(row.body).toBe('On it, thanks.');
    expect(row.private_reply).toMatchObject({
      kind: 'chat',
      source_id: sourceId,
      author_user_id: owner.id,
      excerpt: 'Can we tighten the hook?',
      where_label: groupName,
      link: { channel_id: groupChannel, message_id: sourceId },
    });
  });

  it('the same p_id twice keeps one row with its quote', async () => {
    const client: Client = clientFor(agency.id);
    const id = uuidv7();
    const first = expectOk(await chatPrivateReplySend(client, args(dm, id)));
    const second = expectOk(await chatPrivateReplySend(client, args(dm, id)));
    expect(second.id).toBe(first.id);
    expect(second.private_reply).toEqual(first.private_reply);
    const res = await admin.from('chat_messages').select('id').eq('id', id);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
  });

  it('a refusal is an error Result with the proc message', async () => {
    const error = expectError(await chatPrivateReplySend(clientFor(agency.id), args(groupChannel)));
    expect(error.message).toBe('private reply needs a direct chat');
  });
});
