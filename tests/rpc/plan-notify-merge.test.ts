// Plan edits merge into one card per editor per plan per hour
// (20261026160000_plan_notify_merge_edits.sql), exercised as the AUTHENTICATED
// role through plan_posts_add (each new item fires _plan_items_change_notify ->
// _plan_notify 'plan_updated'). The service-role admin client only seeds
// members and posts, back-dates a row past the hour, and reads inbox_entries.
//
// Covered: 3 edits by one actor within the hour leave each recipient exactly
// one live 'edited' row; an edit after the hour starts a second row; another
// actor gets a separate row; a draft (audience 'team') plan writes none;
// plan_opened (shared with client) still inserts its own row; the actor never
// gets a row. No teardown: every fixture has its own plan.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
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
type ProcName = 'plan_create' | 'plan_posts_add' | 'plan_share_with_client';

interface PlanEntry {
  id: string;
  user_id: string;
  actor_user_id: string | null;
  event_type: string;
  read_at: string | null;
  payload: Record<string, unknown>;
}

describe.runIf(RPC_SUITE)('plan edit notifications merge (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let client2: SeededUser;
  let ws: SeededWorkspace;
  let bucketId: string;

  async function call<P extends ProcName>(
    user: SeededUser,
    proc: P,
    args: Omit<Rpc[P]['Args'], 'p_trace_id'>,
  ): Promise<Rpc[P]['Returns']> {
    const full = { ...args, p_trace_id: uuidv7() } as Rpc[P]['Args'];
    const res = await clientFor(user.id).rpc(proc, full);
    if (res.error !== null) throw new Error(`${proc} failed: ${res.error.message}`);
    return res.data as Rpc[P]['Returns'];
  }

  async function newPlan(audience: 'team' | 'client'): Promise<string> {
    return call(agency, 'plan_create', {
      p_workspace_id: ws.id,
      p_title: `Plan ${randomSuffix()}`,
      p_starts_on: '2026-11-01',
      p_ends_on: '2026-11-30',
      p_audience: audience,
    });
  }

  async function seedPost(): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage: 'review',
      created_by: owner.id,
    });
    return String(post.id);
  }

  /** One plan edit by `actor`: a new post item. */
  async function edit(actor: SeededUser, planId: string): Promise<void> {
    await call(actor, 'plan_posts_add', { p_plan_id: planId, p_post_ids: [await seedPost()] });
  }

  async function entries(planId: string, eventType: string): Promise<PlanEntry[]> {
    const res = await admin
      .from('inbox_entries')
      .select('id, user_id, actor_user_id, event_type, read_at, payload')
      .eq('entity_type', 'plan')
      .eq('entity_id', planId)
      .eq('event_type', eventType)
      .is('deleted_at', null);
    if (res.error !== null) throw new Error(`inbox_entries read failed: ${res.error.message}`);
    return res.data as unknown as PlanEntry[];
  }

  const edited = (rows: PlanEntry[]): PlanEntry[] =>
    rows.filter((r) => r.payload.kind === 'edited');
  const byUser = (rows: PlanEntry[], user: SeededUser): PlanEntry[] =>
    rows.filter((r) => r.user_id === user.id);
  const users = (rows: PlanEntry[]): string[] => [...new Set(rows.map((r) => r.user_id))].sort();
  const ids = (...list: SeededUser[]): string[] => list.map((u) => u.id).sort();

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    client2 = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan notify merge ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    await seedMember(g, ws, client2, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
  });

  it('3 edits by one actor in an hour: each recipient has exactly 1 live edited row', async () => {
    const planId = await newPlan('client');
    await edit(agency, planId);
    await edit(agency, planId);
    await edit(agency, planId);
    const rows = edited(await entries(planId, 'plan_updated'));
    expect(users(rows)).toEqual(ids(owner, client, client2));
    for (const u of [owner, client, client2]) {
      const mine = byUser(rows, u);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.actor_user_id).toBe(agency.id);
      expect(mine[0]?.payload.plan_id).toBe(planId);
      expect(typeof mine[0]?.payload.plan_title).toBe('string');
      expect(typeof mine[0]?.payload.last_change_at).toBe('string');
    }
    // No per-edit rows any more.
    const all = await entries(planId, 'plan_updated');
    expect(all.filter((r) => r.payload.kind !== 'edited')).toEqual([]);
  });

  it('a merged edit never resets read_at (no re-ping)', async () => {
    const planId = await newPlan('client');
    await edit(agency, planId);
    const first = byUser(edited(await entries(planId, 'plan_updated')), client)[0];
    if (first === undefined) throw new Error('fixture');
    const readAt = '2026-10-26T09:00:00.000Z';
    const marked = await admin.from('inbox_entries').update({ read_at: readAt }).eq('id', first.id);
    if (marked.error !== null) throw new Error(`mark read failed: ${marked.error.message}`);
    await edit(agency, planId);
    const after = byUser(edited(await entries(planId, 'plan_updated')), client);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first.id);
    expect(after[0]?.read_at).not.toBeNull();
  });

  it('an edit after the hour starts a second row', async () => {
    const planId = await newPlan('client');
    await edit(agency, planId);
    const old = edited(await entries(planId, 'plan_updated'));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const aged = await admin
      .from('inbox_entries')
      .update({ created_at: twoHoursAgo })
      .in('id', old.map((r) => r.id));
    if (aged.error !== null) throw new Error(`back-date failed: ${aged.error.message}`);
    await edit(agency, planId);
    const rows = edited(await entries(planId, 'plan_updated'));
    for (const u of [owner, client, client2]) expect(byUser(rows, u)).toHaveLength(2);
  });

  it('a different actor gets a separate row', async () => {
    const planId = await newPlan('client');
    await edit(agency, planId);
    await edit(owner, planId);
    await edit(agency, planId);
    const rows = edited(await entries(planId, 'plan_updated'));
    // Both clients see one card per editor.
    for (const u of [client, client2]) {
      const mine = byUser(rows, u);
      expect(mine).toHaveLength(2);
      expect(mine.map((r) => r.actor_user_id).sort()).toEqual(ids(agency, owner));
    }
    // Each editor sees only the other's card.
    expect(byUser(rows, owner).map((r) => r.actor_user_id)).toEqual([agency.id]);
    expect(byUser(rows, agency).map((r) => r.actor_user_id)).toEqual([owner.id]);
  });

  it('a draft (audience team) plan writes no rows', async () => {
    const planId = await newPlan('team');
    await edit(agency, planId);
    await edit(agency, planId);
    await edit(agency, planId);
    expect(await entries(planId, 'plan_updated')).toEqual([]);
  });

  it('plan_opened (shared with client) still inserts its own row beside the edit', async () => {
    const planId = await newPlan('team');
    await call(agency, 'plan_share_with_client', { p_plan_id: planId });
    await edit(agency, planId);
    const opened = await entries(planId, 'plan_opened');
    expect(users(opened)).toEqual(ids(owner, client, client2));
    for (const u of [owner, client, client2]) expect(byUser(opened, u)).toHaveLength(1);
    expect(opened.every((r) => r.payload.kind === undefined)).toBe(true);
    const rows = edited(await entries(planId, 'plan_updated'));
    for (const u of [owner, client, client2]) expect(byUser(rows, u)).toHaveLength(1);
  });

  it('the actor never gets a row', async () => {
    const planId = await newPlan('client');
    await edit(agency, planId);
    await edit(agency, planId);
    expect(byUser(await entries(planId, 'plan_updated'), agency)).toEqual([]);
  });
});
