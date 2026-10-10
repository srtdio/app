// chat_plan_share (20261009163000_chat_plan_share.sql), exercised as the
// AUTHENTICATED role. Any active workspace member who is in the chat may share:
// a client plan into any chat they are in (a client can forward one to another
// client); a team plan only from the agency side ('plan not available' for a
// client caller) and never into a chat with an active client member
// ('plan_not_shared_with_client'). A plan from another workspace is 'plan not
// available'; a non-member of the chat is 'not a member of this chat'. The
// same p_id twice records one row; every success writes one audit_log row
// 'chat_plan_share' with by_client. chat_message_delete clears shared_plan_ids.
//
// The service-role admin client only seeds members, channels and groups and
// reads chat_messages and audit_log back; plans are created through plan_create.
// No teardown: this suite runs no DELETE; every fixture has its own workspace.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  countWhere,
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
type MessageRow = Rpc['chat_plan_share']['Returns'];

interface Shared {
  data: MessageRow | null;
  error: { message: string } | null;
  traceId: string;
  id: string;
}

describe.runIf(RPC_SUITE)('chat_plan_share (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let agency2: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let agencyClientDm: string;
  let clientClientDm: string;
  let agencyGroup: string;
  let teamPlanId: string;
  let clientPlanId: string;
  let otherPlanId: string;

  /** One chat_plan_share call as `user`, with a fresh p_id and uuid v7 trace. */
  async function share(
    user: SeededUser,
    channelId: string,
    planId: string,
    body?: string,
    id: string = uuidv7(),
  ): Promise<Shared> {
    const traceId = uuidv7();
    const args: Rpc['chat_plan_share']['Args'] = {
      p_id: id,
      p_channel_id: channelId,
      p_plan_id: planId,
      p_trace_id: traceId,
      ...(body !== undefined ? { p_body: body } : {}),
    };
    const res = await clientFor(user.id).rpc('chat_plan_share', args);
    return {
      data: res.data ?? null,
      error: res.error === null ? null : { message: res.error.message },
      traceId,
      id,
    };
  }

  async function createPlan(
    user: SeededUser,
    workspaceId: string,
    audience: 'team' | 'client',
  ): Promise<string> {
    const args: Rpc['plan_create']['Args'] = {
      p_workspace_id: workspaceId,
      p_title: `Plan ${randomSuffix()}`,
      p_starts_on: '2026-11-01',
      p_ends_on: '2026-11-30',
      p_audience: audience,
      p_trace_id: uuidv7(),
    };
    const res = await clientFor(user.id).rpc('plan_create', args);
    if (res.error !== null || res.data === null) {
      throw new Error(`plan_create failed: ${res.error?.message ?? 'no data'}`);
    }
    return res.data;
  }

  /** An agency-only group chat: the group, its channel and its members. */
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

  function expectRefused(outcome: Shared, message: string): void {
    expect(outcome.data).toBeNull();
    expect(outcome.error?.message).toBe(message);
  }

  /** The one audit_log row for a success, with its payload. */
  async function auditPayload(outcome: Shared): Promise<Record<string, unknown>> {
    expect(outcome.error).toBeNull();
    expect(await countWhere(g, 'audit_log', [['trace_id', outcome.traceId]])).toBe(1);
    const res = await admin
      .from('audit_log')
      .select('action, outcome, entity_type, payload')
      .eq('trace_id', outcome.traceId);
    if (res.error !== null) throw new Error(`audit_log read failed: ${res.error.message}`);
    const [row] = res.data;
    if (row === undefined) throw new Error('no audit row');
    expect(row.action).toBe('chat_plan_share');
    expect(row.outcome).toBe('success');
    expect(row.entity_type).toBe('plan');
    return row.payload as Record<string, unknown>;
  }

  async function messageRows(id: string) {
    const res = await admin
      .from('chat_messages')
      .select('id, body, shared_plan_ids, deleted_at')
      .eq('id', id);
    if (res.error !== null) throw new Error(`chat_messages read failed: ${res.error.message}`);
    return res.data;
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
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan share ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Plan share other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, agency2, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    agencyClientDm = await seedDmChannel(g, ws.id, agency, client);
    clientClientDm = await seedDmChannel(g, ws.id, client, client2);
    agencyGroup = await seedGroupChannel([agency, agency2]);
    teamPlanId = await createPlan(agency, ws.id, 'team');
    clientPlanId = await createPlan(agency, ws.id, 'client');
    otherPlanId = await createPlan(outsider, other.id, 'client');
  });

  it('agency shares a client plan into a DM with a client: one row with the plan and body, audited', async () => {
    const outcome = await share(agency, agencyClientDm, clientPlanId, 'This week');
    expect(outcome.error).toBeNull();
    expect(outcome.data?.id).toBe(outcome.id);
    expect(await messageRows(outcome.id)).toEqual([
      { id: outcome.id, body: 'This week', shared_plan_ids: [clientPlanId], deleted_at: null },
    ]);
    const payload = await auditPayload(outcome);
    expect(payload).toMatchObject({
      channel_id: agencyClientDm,
      message_id: outcome.id,
      by_client: false,
    });
  });

  it('a client shares a client plan into a client-only DM: success, by_client true', async () => {
    const outcome = await share(client, clientClientDm, clientPlanId);
    expect(outcome.error).toBeNull();
    expect(await messageRows(outcome.id)).toEqual([
      { id: outcome.id, body: null, shared_plan_ids: [clientPlanId], deleted_at: null },
    ]);
    expect((await auditPayload(outcome)).by_client).toBe(true);
  });

  it("a client sharing a team plan is 'plan not available'", async () => {
    const outcome = await share(client, clientClientDm, teamPlanId);
    expectRefused(outcome, 'plan not available');
    expect(await messageRows(outcome.id)).toEqual([]);
    expect(await countWhere(g, 'audit_log', [['trace_id', outcome.traceId]])).toBe(0);
  });

  it("a non-member of the chat is 'not a member of this chat'", async () => {
    const outcome = await share(agency, clientClientDm, clientPlanId);
    expectRefused(outcome, 'not a member of this chat');
    expect(await messageRows(outcome.id)).toEqual([]);
  });

  it('a team plan into a chat with a client is plan_not_shared_with_client', async () => {
    const outcome = await share(agency, agencyClientDm, teamPlanId);
    expectRefused(outcome, 'plan_not_shared_with_client');
    expect(await messageRows(outcome.id)).toEqual([]);
  });

  it('a team plan into an agency-only group succeeds and is audited', async () => {
    const outcome = await share(agency, agencyGroup, teamPlanId);
    expect(outcome.error).toBeNull();
    expect((await messageRows(outcome.id))[0]?.shared_plan_ids).toEqual([teamPlanId]);
    expect((await auditPayload(outcome)).by_client).toBe(false);
  });

  it("a plan from another workspace is 'plan not available'", async () => {
    const outcome = await share(agency, agencyGroup, otherPlanId);
    expectRefused(outcome, 'plan not available');
    expect(await messageRows(outcome.id)).toEqual([]);
  });

  it('the same p_id twice records one row and one audit row', async () => {
    const id = uuidv7();
    const first = await share(agency, agencyGroup, clientPlanId, 'Once', id);
    const second = await share(agency, agencyGroup, clientPlanId, 'Twice', id);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data?.body).toBe('Once');
    expect(await messageRows(id)).toHaveLength(1);
    expect(await countWhere(g, 'audit_log', [['trace_id', first.traceId]])).toBe(1);
    expect(await countWhere(g, 'audit_log', [['trace_id', second.traceId]])).toBe(0);
  });

  it('chat_message_delete on the plan message clears shared_plan_ids', async () => {
    const outcome = await share(agency, agencyGroup, clientPlanId, 'To delete');
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
    expect(row?.shared_plan_ids).toBeNull();
    expect(row?.body).toBeNull();
  });
});
