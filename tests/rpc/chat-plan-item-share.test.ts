// chat_plan_item_share (20261106090000_chat_plan_item_share.sql), exercised as
// the AUTHENTICATED role: a team-only bank idea goes into an agency-only group
// (one row carrying shared_plan_item_ids, audited) and is refused into a chat
// with an active client member ('idea_not_shared_with_client'); a client
// cannot share a team-only idea ('idea not available'). chat_message_delete
// clears shared_plan_item_ids on the tombstone.
//
// The service-role admin client only seeds members, channels and groups and
// reads chat_messages back; the idea is created through bank_idea_create.
// No teardown: this suite runs no DELETE; the fixture has its own workspace.

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

const RPC_SUITE = process.env.RPC_SUITE === '1';

type Rpc = Database['public']['Functions'];

describe.runIf(RPC_SUITE)('chat_plan_item_share (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let agency2: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let ws: SeededWorkspace;
  let agencyClientDm: string;
  let clientClientDm: string;
  let agencyGroup: string;
  let ideaId: string;

  async function share(
    user: SeededUser,
    channelId: string,
    itemId: string,
    id: string = uuidv7(),
  ): Promise<{ id: string; error: string | null }> {
    const args: Rpc['chat_plan_item_share']['Args'] = {
      p_id: id,
      p_channel_id: channelId,
      p_item_id: itemId,
      p_trace_id: uuidv7(),
    };
    const res = await clientFor(user.id).rpc('chat_plan_item_share', args);
    return { id, error: res.error === null ? null : res.error.message };
  }

  async function messageRows(id: string) {
    const res = await admin
      .from('chat_messages')
      .select('id, body, shared_plan_item_ids, deleted_at')
      .eq('id', id);
    if (res.error !== null) throw new Error(`chat_messages read failed: ${res.error.message}`);
    return res.data;
  }

  async function seedGroupChannel(members: readonly SeededUser[]): Promise<string> {
    const group = await insertRow(g, 'groups', {
      workspace_id: ws.id,
      name: `Grp ${randomSuffix()}`,
      created_by: owner.id,
    });
    const channelId = `group__${ws.id}__${String(group.id)}`;
    await insertRow(g, 'chat_channels', {
      channel_id: channelId,
      workspace_id: ws.id,
      channel_type: 'group',
      entity_id: group.id,
    });
    for (const member of members) {
      await insertRow(g, 'group_members', {
        group_id: group.id,
        user_id: member.id,
        workspace_id: ws.id,
      });
    }
    return channelId;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    agency2 = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Idea share ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, agency2, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    agencyClientDm = await seedDmChannel(g, ws.id, agency, client);
    clientClientDm = await seedDmChannel(g, ws.id, client, client2);
    agencyGroup = await seedGroupChannel([agency, agency2]);
    // The idea itself is seeded as a row (a team-only bank concept): this
    // spec is about chat_plan_item_share and chat_message_delete, not
    // bank_idea_create.
    const idea = await insertRow(g, 'plan_items', {
      workspace_id: ws.id,
      plan_id: null,
      kind: 'concept',
      position: 0,
      title: `Idea ${randomSuffix()}`,
      created_by: agency.id,
      show_to_client: false,
    });
    ideaId = String(idea.id);
  });

  it('a team-only idea into an agency-only group: one row carrying the idea', async () => {
    const outcome = await share(agency, agencyGroup, ideaId);
    expect(outcome.error).toBeNull();
    expect(await messageRows(outcome.id)).toEqual([
      { id: outcome.id, body: null, shared_plan_item_ids: [ideaId], deleted_at: null },
    ]);
  });

  it('a team-only idea into a chat with a client is idea_not_shared_with_client', async () => {
    const outcome = await share(agency, agencyClientDm, ideaId);
    expect(outcome.error).toBe('idea_not_shared_with_client');
    expect(await messageRows(outcome.id)).toEqual([]);
  });

  it("a client sharing a team-only idea is 'idea not available'", async () => {
    const outcome = await share(client, clientClientDm, ideaId);
    expect(outcome.error).toBe('idea not available');
    expect(await messageRows(outcome.id)).toEqual([]);
  });

  it('chat_message_delete on the idea message clears shared_plan_item_ids', async () => {
    const outcome = await share(agency, agencyGroup, ideaId);
    expect(outcome.error).toBeNull();
    const args: Rpc['chat_message_delete']['Args'] = {
      p_message_ids: [outcome.id],
      p_channel_id: agencyGroup,
      p_trace_id: uuidv7(),
    };
    const res = await clientFor(agency.id).rpc('chat_message_delete', args);
    expect(res.error).toBeNull();
    const [row] = await messageRows(outcome.id);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.shared_plan_item_ids).toBeNull();
    expect(row?.body).toBeNull();
  });
});
