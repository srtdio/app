// Density and New plan "Add from bank" (20261108010000_density_and_plan_bank.sql),
// exercised as the AUTHENTICATED role.
//
// user_density_set: writes the caller's own users.density only; the value is
// trimmed and lowercased (' Compact ' -> 'compact'); anything outside
// compact/cozy/calm is invalid_payload; anon has no EXECUTE.
//
// plan_create_with_items (8-arg, p_bank [{item_id, target_date}]): each bank
// idea goes through plan_item_from_bank, so it lands in the new plan on its
// target_date, or greatest(starts_on, today in the workspace timezone) when
// none is given. A client is forbidden_role (plan_create refuses before the
// bank step). A target_date before today is 'past_date' (plan_item_from_bank,
// 20261106110000_plan_bank_notify.sql) and the whole call rolls back. A
// duplicate item_id is invalid_payload. p_bank [] with one concept still works.
//
// Bank ideas are made the way chat-plan-item-share.test.ts makes them: a
// concept in a team plan, moved to the bank with plan_item_to_bank. The plan
// tables grant service_role no SELECT, so plan state is read back as an agency
// member through RLS. No teardown: every fixture has its own workspace.

import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  createAnonClient,
  loadRlsEnv,
  randomSuffix,
  seedMember,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

type Rpc = Database['public']['Functions'];

/** YYYY-MM-DD for today in UTC (seedWorkspace sets timezone 'UTC'). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD `days` after today (UTC); negative for the past. */
function dayOffset(days: number): string {
  const d = new Date(`${todayUtc()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe.runIf(RPC_SUITE)('user_density_set (authenticated role)', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let me: SeededUser;
  let other: SeededUser;

  async function setDensity(user: SeededUser, density: string): Promise<string | null> {
    const args: Rpc['user_density_set']['Args'] = { p_density: density, p_trace_id: uuidv7() };
    const res = await clientFor(user.id).rpc('user_density_set', args);
    return res.error === null ? null : res.error.message;
  }

  async function densityOf(user: SeededUser): Promise<string> {
    const res = await admin.from('users').select('density').eq('id', user.id).single();
    if (res.error !== null) throw new Error(`users read failed: ${res.error.message}`);
    return res.data.density;
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    me = await seedUser(env, admin);
    other = await seedUser(env, admin);
  });

  it("sets the caller's own row to 'calm'; another user's row is unchanged", async () => {
    const before = await densityOf(other);
    expect(before).toBe('cozy');
    expect(await setDensity(me, 'calm')).toBeNull();
    expect(await densityOf(me)).toBe('calm');
    expect(await densityOf(other)).toBe(before);
  });

  it("normalises ' Compact ' to 'compact'", async () => {
    expect(await setDensity(me, ' Compact ')).toBeNull();
    expect(await densityOf(me)).toBe('compact');
  });

  it("'huge' is invalid_payload and leaves the row as it was", async () => {
    expect(await setDensity(me, 'cozy')).toBeNull();
    expect(await setDensity(me, 'huge')).toBe('invalid_payload');
    expect(await densityOf(me)).toBe('cozy');
  });

  it('anon cannot execute it', async () => {
    const args: Rpc['user_density_set']['Args'] = { p_density: 'calm', p_trace_id: uuidv7() };
    const res = await createAnonClient(env).rpc('user_density_set', args);
    expect(res.error).not.toBeNull();
    const privilege = execFileSync(
      'psql',
      [
        env.dbUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
        '-c',
        "select has_function_privilege('anon', 'public.user_density_set(text, uuid)', 'EXECUTE')::text",
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(privilege).toBe('false');
  });
});

describe.runIf(RPC_SUITE)('plan_create_with_items with p_bank (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;

  interface BankEntry {
    item_id: string;
    target_date?: string;
  }

  interface CreateArgs {
    startsOn: string;
    endsOn: string;
    concepts?: Json[];
    bank: BankEntry[];
  }

  async function createWithItems(
    user: SeededUser,
    a: CreateArgs,
  ): Promise<{ planId: string | null; error: string | null }> {
    const args: Rpc['plan_create_with_items']['Args'] = {
      p_workspace_id: ws.id,
      p_title: `Plan ${randomSuffix()}`,
      p_starts_on: a.startsOn,
      p_ends_on: a.endsOn,
      p_concepts: a.concepts ?? [],
      p_posts: [],
      p_bank: a.bank as unknown as Json,
      p_trace_id: uuidv7(),
    };
    const res = await clientFor(user.id).rpc('plan_create_with_items', args);
    return {
      planId: res.error === null ? String(res.data) : null,
      error: res.error === null ? null : res.error.message,
    };
  }

  /** A team-only bank idea: a concept in a team plan, moved to the bank. */
  async function newBankIdea(): Promise<string> {
    const as = clientFor(agency.id);
    const planArgs: Rpc['plan_create']['Args'] = {
      p_workspace_id: ws.id,
      p_title: `Source ${randomSuffix()}`,
      p_starts_on: dayOffset(0),
      p_ends_on: dayOffset(30),
      p_audience: 'team',
      p_trace_id: uuidv7(),
    };
    const plan = await as.rpc('plan_create', planArgs);
    if (plan.error !== null) throw new Error(`plan_create failed: ${plan.error.message}`);
    const conceptArgs: Rpc['plan_concept_add']['Args'] = {
      p_plan_id: String(plan.data),
      p_title: `Idea ${randomSuffix()}`,
      p_description: 'An idea',
      p_attachment_version_ids: [],
      p_trace_id: uuidv7(),
    };
    const concept = await as.rpc('plan_concept_add', conceptArgs);
    if (concept.error !== null) {
      throw new Error(`plan_concept_add failed: ${concept.error.message}`);
    }
    const itemId = String(concept.data);
    const toBank: Rpc['plan_item_to_bank']['Args'] = { p_item_id: itemId, p_trace_id: uuidv7() };
    const moved = await as.rpc('plan_item_to_bank', toBank);
    if (moved.error !== null) throw new Error(`plan_item_to_bank failed: ${moved.error.message}`);
    return itemId;
  }

  async function itemRow(itemId: string) {
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('id, plan_id, target_date')
      .eq('id', itemId)
      .single();
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return res.data;
  }

  async function itemsOf(planId: string) {
    const res = await clientFor(agency.id)
      .from('plan_items')
      .select('id, kind, title')
      .eq('plan_id', planId)
      .is('deleted_at', null);
    if (res.error !== null) throw new Error(`plan_items read failed: ${res.error.message}`);
    return res.data;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    const g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan bank ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
  });

  it('a bank idea with a target_date lands in the new plan on that date', async () => {
    const ideaId = await newBankIdea();
    const target = dayOffset(5);
    const out = await createWithItems(agency, {
      startsOn: dayOffset(0),
      endsOn: dayOffset(30),
      bank: [{ item_id: ideaId, target_date: target }],
    });
    expect(out.error).toBeNull();
    expect(await itemRow(ideaId)).toEqual({ id: ideaId, plan_id: out.planId, target_date: target });
  });

  it('missing target_date: starts_on when the plan starts after today', async () => {
    const ideaId = await newBankIdea();
    const startsOn = dayOffset(10);
    const out = await createWithItems(agency, {
      startsOn,
      endsOn: dayOffset(40),
      bank: [{ item_id: ideaId }],
    });
    expect(out.error).toBeNull();
    expect(await itemRow(ideaId)).toEqual({
      id: ideaId,
      plan_id: out.planId,
      target_date: startsOn,
    });
  });

  it('missing target_date: today when the plan started before today', async () => {
    const ideaId = await newBankIdea();
    const out = await createWithItems(agency, {
      startsOn: dayOffset(-5),
      endsOn: dayOffset(25),
      bank: [{ item_id: ideaId, target_date: '' }],
    });
    expect(out.error).toBeNull();
    expect(await itemRow(ideaId)).toEqual({
      id: ideaId,
      plan_id: out.planId,
      target_date: todayUtc(),
    });
  });

  it('a client calling it with p_bank is forbidden_role; the idea stays in the bank', async () => {
    const ideaId = await newBankIdea();
    const out = await createWithItems(client, {
      startsOn: dayOffset(0),
      endsOn: dayOffset(30),
      bank: [{ item_id: ideaId, target_date: dayOffset(3) }],
    });
    expect(out.error).toBe('forbidden_role');
    expect((await itemRow(ideaId)).plan_id).toBeNull();
  });

  it('past date', async () => {
    // plan_item_from_bank raises past_date for a target_date before today; it
    // does not clamp. The whole call rolls back, so the idea stays in the bank.
    const ideaId = await newBankIdea();
    const out = await createWithItems(agency, {
      startsOn: dayOffset(-10),
      endsOn: dayOffset(20),
      bank: [{ item_id: ideaId, target_date: dayOffset(-2) }],
    });
    expect(out.error).toBe('past_date');
    expect(await itemRow(ideaId)).toEqual({ id: ideaId, plan_id: null, target_date: null });
  });

  it('a duplicate item_id in p_bank is invalid_payload', async () => {
    const ideaId = await newBankIdea();
    const out = await createWithItems(agency, {
      startsOn: dayOffset(0),
      endsOn: dayOffset(30),
      bank: [
        { item_id: ideaId, target_date: dayOffset(1) },
        { item_id: ideaId, target_date: dayOffset(2) },
      ],
    });
    expect(out.error).toBe('invalid_payload');
    expect((await itemRow(ideaId)).plan_id).toBeNull();
  });

  it("p_bank '[]' with one concept still creates the plan with that concept", async () => {
    const title = `Concept ${randomSuffix()}`;
    const out = await createWithItems(agency, {
      startsOn: dayOffset(0),
      endsOn: dayOffset(30),
      concepts: [{ title, description: 'Fresh', attachment_version_ids: [] }],
      bank: [],
    });
    expect(out.error).toBeNull();
    expect(out.planId).not.toBeNull();
    const items = await itemsOf(String(out.planId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'concept', title });
  });
});
