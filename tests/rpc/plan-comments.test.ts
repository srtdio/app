// plan_item_comment_create and the plan_review inbox fan-out
// (20261009205500_plan_item_comments.sql), exercised as the AUTHENTICATED role.
// The service-role admin client only seeds members and reads audit_log and
// inbox_entries back; plans are built through the plan procs.
//
// Covered: a client writes 'everyone' on a client plan (one audit row); a client
// writing 'team', or on a team plan, is forbidden_role; an empty body is
// invalid_payload; an agency 'team' comment notifies only the other agency-side
// members; an agency 'everyone' comment on a client plan notifies every other
// member (event_type plan_comment, entity_type plan_item, scope posts,
// scope_key = plan id); plan_item_review approved writes plan_review rows (team
// side to agency only); status 'waiting' writes no inbox row.
// No teardown: this suite runs no DELETE; every fixture has its own workspace.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  countWhere,
  createAdminClient,
  loadRlsEnv,
  randomSuffix,
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
type ProcName =
  | 'plan_create'
  | 'plan_concept_add'
  | 'plan_item_comment_create'
  | 'plan_item_review';

interface Outcome<T> {
  data: T | null;
  error: { message: string } | null;
  traceId: string;
}

interface InboxRow {
  user_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  scope: string;
  scope_key: string | null;
  actor_user_id: string | null;
}

describe.runIf(RPC_SUITE)('plan item comments (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let ws: SeededWorkspace;
  let teamPlanId: string;
  let clientPlanId: string;

  /**
   * Call one proc as `user` with a fresh uuid v7 trace (passed as the proc's
   * own p_trace_id; callRpc() is the app wrapper and does not apply).
   */
  async function call<P extends ProcName>(
    user: SeededUser,
    proc: P,
    args: Omit<Rpc[P]['Args'], 'p_trace_id'>,
  ): Promise<Outcome<Rpc[P]['Returns']>> {
    const traceId = uuidv7();
    const full = { ...args, p_trace_id: traceId } as Rpc[P]['Args'];
    const res = await clientFor(user.id).rpc(proc, full);
    return {
      data: (res.data ?? null) as Rpc[P]['Returns'] | null,
      error: res.error === null ? null : { message: res.error.message },
      traceId,
    };
  }

  function ok<T>(proc: string, outcome: Outcome<T>): T {
    if (outcome.error !== null) throw new Error(`${proc} failed: ${outcome.error.message}`);
    return outcome.data as T;
  }

  function refusedWith<T>(outcome: Outcome<T>, message: string): void {
    expect(outcome.data).toBeNull();
    expect(outcome.error?.message).toBe(message);
  }

  /** Exactly one audit_log row for this success, action = the proc name. */
  async function expectAudited<T>(proc: ProcName, outcome: Outcome<T>): Promise<void> {
    expect(outcome.error).toBeNull();
    expect(await countWhere(g, 'audit_log', [['trace_id', outcome.traceId]])).toBe(1);
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', outcome.traceId],
        ['action', proc],
        ['outcome', 'success'],
      ]),
    ).toBe(1);
  }

  async function newPlan(audience: 'team' | 'client'): Promise<string> {
    return ok(
      'plan_create',
      await call(agency, 'plan_create', {
        p_workspace_id: ws.id,
        p_title: `Plan ${randomSuffix()}`,
        p_starts_on: '2026-11-01',
        p_ends_on: '2026-11-30',
        p_audience: audience,
      }),
    );
  }

  /** A fresh concept per test, so its inbox rows are counted in isolation. */
  async function newConcept(planId: string): Promise<string> {
    return ok(
      'plan_concept_add',
      await call(agency, 'plan_concept_add', {
        p_plan_id: planId,
        p_title: `Concept ${randomSuffix()}`,
        p_description: 'A concept',
        p_attachment_version_ids: [],
      }),
    );
  }

  function comment(
    user: SeededUser,
    itemId: string,
    visibility: string,
    body = `Comment ${randomSuffix()}`,
  ): Promise<Outcome<string>> {
    return call(user, 'plan_item_comment_create', {
      p_item_id: itemId,
      p_body: body,
      p_visibility: visibility,
    });
  }

  async function inboxRows(itemId: string, eventType: string): Promise<InboxRow[]> {
    const res = await admin
      .from('inbox_entries')
      .select('user_id, event_type, entity_type, entity_id, scope, scope_key, actor_user_id')
      .eq('entity_id', itemId)
      .eq('event_type', eventType);
    if (res.error !== null) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return res.data;
  }

  function recipients(rows: InboxRow[]): string[] {
    return rows.map((r) => r.user_id).sort();
  }

  function sorted(...users: SeededUser[]): string[] {
    return users.map((u) => u.id).sort();
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan comments ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    teamPlanId = await newPlan('team');
    clientPlanId = await newPlan('client');
  });

  it("a client writes an 'everyone' comment on a client plan: ok, one audit row", async () => {
    const itemId = await newConcept(clientPlanId);
    const outcome = await comment(client, itemId, 'everyone');
    expect(typeof outcome.data).toBe('string');
    await expectAudited('plan_item_comment_create', outcome);
    expect(recipients(await inboxRows(itemId, 'plan_comment'))).toEqual(
      sorted(owner, agency, client2),
    );
  });

  it("a client writing a 'team' comment is forbidden_role", async () => {
    const itemId = await newConcept(clientPlanId);
    const outcome = await comment(client, itemId, 'team');
    refusedWith(outcome, 'forbidden_role');
    expect(await countWhere(g, 'audit_log', [['trace_id', outcome.traceId]])).toBe(0);
    expect(await inboxRows(itemId, 'plan_comment')).toEqual([]);
  });

  it('a client commenting on a team plan is forbidden_role', async () => {
    const itemId = await newConcept(teamPlanId);
    refusedWith(await comment(client, itemId, 'everyone'), 'forbidden_role');
    expect(await inboxRows(itemId, 'plan_comment')).toEqual([]);
  });

  it('an empty body is invalid_payload', async () => {
    const itemId = await newConcept(clientPlanId);
    refusedWith(await comment(agency, itemId, 'everyone', '   '), 'invalid_payload');
    refusedWith(await comment(agency, itemId, 'everyone', ''), 'invalid_payload');
    expect(await inboxRows(itemId, 'plan_comment')).toEqual([]);
  });

  it("an agency 'team' comment notifies only the other agency-side members", async () => {
    const itemId = await newConcept(clientPlanId);
    const outcome = await comment(agency, itemId, 'team');
    await expectAudited('plan_item_comment_create', outcome);
    const rows = await inboxRows(itemId, 'plan_comment');
    expect(recipients(rows)).toEqual(sorted(owner));
    for (const user of [client, client2]) {
      expect(rows.some((r) => r.user_id === user.id)).toBe(false);
    }
  });

  it("an agency 'everyone' comment on a client plan notifies every other member, scoped to the plan", async () => {
    const itemId = await newConcept(clientPlanId);
    const outcome = await comment(agency, itemId, 'everyone');
    await expectAudited('plan_item_comment_create', outcome);
    const rows = await inboxRows(itemId, 'plan_comment');
    expect(recipients(rows)).toEqual(sorted(owner, client, client2));
    for (const row of rows) {
      expect(row).toMatchObject({
        event_type: 'plan_comment',
        entity_type: 'plan_item',
        entity_id: itemId,
        scope: 'posts',
        scope_key: clientPlanId,
        actor_user_id: agency.id,
      });
    }
  });

  it('plan_item_review approved writes plan_review rows; the team side reaches agency only', async () => {
    const itemId = await newConcept(clientPlanId);
    const team = await call(agency, 'plan_item_review', {
      p_item_id: itemId,
      p_side: 'team',
      p_status: 'approved',
    });
    await expectAudited('plan_item_review', team);
    expect(recipients(await inboxRows(itemId, 'plan_review'))).toEqual(sorted(owner));

    const clientSide = await call(client, 'plan_item_review', {
      p_item_id: itemId,
      p_side: 'client',
      p_status: 'approved',
    });
    await expectAudited('plan_item_review', clientSide);
    const rows = await inboxRows(itemId, 'plan_review');
    // owner from the team review, then owner, agency and client2 from the client one.
    expect(recipients(rows)).toEqual([...sorted(owner), ...sorted(owner, agency, client2)].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        entity_type: 'plan_item',
        scope: 'posts',
        scope_key: clientPlanId,
      });
    }
  });

  it("plan_item_review with status 'waiting' writes no inbox row", async () => {
    const itemId = await newConcept(clientPlanId);
    const outcome = await call(agency, 'plan_item_review', {
      p_item_id: itemId,
      p_side: 'team',
      p_status: 'waiting',
    });
    await expectAudited('plan_item_review', outcome);
    expect(await inboxRows(itemId, 'plan_review')).toEqual([]);
  });
});
