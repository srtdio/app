// The creator's sample week (20261017150000_induction_sample_week.sql):
// induction_sample_seed puts one brief, one team plan holding one review post,
// the plan's card and one voice note with its transcript (default group) into
// the caller's own workspace, flagged in induction_sample_rows; a second seed
// changes nothing. induction_sample_clear deletes exactly those rows (the
// creator's own post, other briefs and chat stay), and a second clear changes
// nothing. Only the workspace owner may call either; only the owner reads the
// markers. Both write audit_log with the caller's trace id.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  seedMember,
  seedUser,
  type GenericClient,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/** Typed pass-through for direct .rpc() args; each call sets its own p_trace_id (a uuid v7). */
function rpcArgs<T>(args: T): T {
  return args;
}

type RpcResult = { data: unknown; error: { message: string } | null };

/** The two procs are not in the generated types until the migration is applied. */
/** The first row a query returns; throws on an error or no row. */
async function firstRow<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const res = await query;
  if (res.error) throw new Error(res.error.message);
  const row = ((res.data ?? []) as T[])[0];
  if (row === undefined) throw new Error('no row');
  return row;
}

/** How many rows a query returns (0 when RLS hides them). */
async function rowCount(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const res = await query;
  return ((res.data ?? []) as unknown[]).length;
}

async function rpc(
  userId: string,
  name: 'induction_sample_seed' | 'induction_sample_clear',
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const client = clientFor(userId) as unknown as {
    rpc: (fn: string, a: Record<string, unknown>) => Promise<RpcResult>;
  };
  return client.rpc(name, rpcArgs(args));
}

describe.runIf(RLS_SUITE)('induction sample week', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let channelId: string;
  let ownPostId: string;
  const users: SeededUser[] = [];
  const workspaces: SeededWorkspace[] = [];

  async function rowsOf(table: string, column: string, value: string): Promise<number> {
    return countWhere(g, table, [[column, value]]);
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    users.push(owner, agency, outsider);
    // A real workspace: workspace_create makes the counters, the default group and its channel.
    const created = await clientFor(owner.id).rpc(
      'workspace_create',
      rpcArgs({
        p_payload: { name: `Sample ${uuidv7().slice(-6)}`, timezone: 'UTC', platform: 'instagram' },
        p_trace_id: uuidv7(),
      }),
    );
    if (created.error) throw new Error(created.error.message);
    ws = { id: String(created.data), name: 'Sample', ownerId: owner.id };
    workspaces.push(ws);
    await seedMember(g, ws, agency, 'agency');
    const group = await firstRow<{ id: string }>(
      g.from('groups').select('id').eq('workspace_id', ws.id).eq('is_default', true),
    );
    const channel = await firstRow<{ channel_id: string }>(
      g.from('chat_channels').select('channel_id').eq('entity_id', group.id),
    );
    channelId = channel.channel_id;
    // The creator's own first post, sent for review before the look-around.
    const post = await clientFor(owner.id).rpc(
      'post_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_payload: { title: 'Launch day', caption: 'Our first post', format: 'single_image' },
        p_trace_id: uuidv7(),
      }),
    );
    if (post.error) throw new Error(post.error.message);
    ownPostId = String(post.data);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  it('refuses anyone but the workspace owner', async () => {
    const asAgency = await rpc(agency.id, 'induction_sample_seed', {
      p_workspace_id: ws.id,
      p_trace_id: uuidv7(),
    });
    expect(asAgency.error?.message).toBe('forbidden_role');
    const asOutsider = await rpc(outsider.id, 'induction_sample_clear', {
      p_workspace_id: ws.id,
      p_trace_id: uuidv7(),
    });
    expect(asOutsider.error?.message).toBe('workspace_member_only');
    expect(await rowsOf('induction_sample_rows', 'workspace_id', ws.id)).toBe(0);
  });

  it('seeds the sample week into the owner workspace, flagged, with an audit row', async () => {
    const trace = uuidv7();
    const res = await rpc(owner.id, 'induction_sample_seed', {
      p_workspace_id: ws.id,
      p_trace_id: trace,
    });
    expect(res.error).toBeNull();
    const out = res.data as { seeded: boolean; brief_id: string; post_id: string; plan_id: string };
    expect(out.seeded).toBe(true);

    const post = await firstRow(g.from('posts').select('stage, brief_id').eq('id', out.post_id));
    expect(post).toMatchObject({ stage: 'review', brief_id: out.brief_id });
    // plans and plan_items grant SELECT to authenticated only: read them as the owner.
    const asOwner = asGeneric(clientFor(owner.id));
    const plan = await firstRow(asOwner.from('plans').select('audience').eq('id', out.plan_id));
    expect(plan).toMatchObject({ audience: 'team' });
    expect(
      await rowCount(
        asOwner
          .from('plan_items')
          .select('id')
          .eq('plan_id', out.plan_id)
          .eq('post_id', out.post_id),
      ),
    ).toBe(1);
    const chat = await g
      .from('chat_messages')
      .select('sender_user_id, shared_plan_ids, attachment_meta')
      .eq('channel_id', channelId);
    const rows = (chat.data ?? []) as {
      sender_user_id: string | null;
      shared_plan_ids: string[] | null;
      attachment_meta: Record<string, { mime: string; transcript: string }> | null;
    }[];
    expect(rows.some((r) => r.shared_plan_ids?.includes(out.plan_id))).toBe(true);
    const voice = rows.find((r) => r.attachment_meta !== null);
    expect(voice?.sender_user_id).toBeNull();
    const meta = Object.values(voice?.attachment_meta ?? {})[0];
    expect(meta?.mime).toBe('audio/mp4');
    expect(meta?.transcript).toContain('Thursday');

    expect(await rowsOf('induction_sample_rows', 'workspace_id', ws.id)).toBe(6);
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', trace],
        ['action', 'induction_sample_seed'],
      ]),
    ).toBe(1);
  });

  it('is idempotent: a second seed changes nothing and returns the same ids', async () => {
    const before = await rowsOf('posts', 'workspace_id', ws.id);
    const first = await firstRow<{ row_id: string }>(
      g.from('induction_sample_rows').select('row_id').eq('workspace_id', ws.id).eq('kind', 'post'),
    );
    const res = await rpc(owner.id, 'induction_sample_seed', {
      p_workspace_id: ws.id,
      p_trace_id: uuidv7(),
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      seeded: false,
      post_id: first.row_id,
    });
    expect(await rowsOf('posts', 'workspace_id', ws.id)).toBe(before);
    expect(await rowsOf('induction_sample_rows', 'workspace_id', ws.id)).toBe(6);
  });

  it('lets only the owner read the markers', async () => {
    const read = (userId: string) =>
      rowCount(
        asGeneric(clientFor(userId))
          .from('induction_sample_rows')
          .select('row_id')
          .eq('workspace_id', ws.id),
      );
    expect(await read(owner.id)).toBe(6);
    expect(await read(agency.id)).toBe(0);
    const write = await asGeneric(clientFor(owner.id))
      .from('induction_sample_rows')
      .delete()
      .eq('workspace_id', ws.id);
    expect(write.error).not.toBeNull();
  });

  it('clears exactly the sample rows: the own post, other briefs and chat stay', async () => {
    const otherBrief = await insertRow(g, 'briefs', {
      workspace_id: ws.id,
      number: 9000,
      title: 'Real brief',
      objective: 'Stays',
      created_by: owner.id,
    });
    const sent = await clientFor(owner.id).rpc(
      'chat_message_send',
      rpcArgs({
        p_id: uuidv7(),
        p_channel_id: channelId,
        p_trace_id: uuidv7(),
        p_body: 'A real message',
      }),
    );
    expect(sent.error).toBeNull();
    const markers = await g
      .from('induction_sample_rows')
      .select('kind, row_id')
      .eq('workspace_id', ws.id);
    const ids = (markers.data ?? []) as { kind: string; row_id: string }[];
    const idOf = (kind: string): string => ids.find((m) => m.kind === kind)?.row_id ?? '';

    const planRows = (): Promise<number> =>
      rowCount(asGeneric(clientFor(owner.id)).from('plans').select('id').eq('id', idOf('plan')));
    expect(await planRows()).toBe(1);

    const trace = uuidv7();
    const res = await rpc(owner.id, 'induction_sample_clear', {
      p_workspace_id: ws.id,
      p_trace_id: trace,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      cleared: true,
      chat_messages: 2,
      plan_items: 1,
      plans: 1,
      posts: 1,
      briefs: 1,
    });
    expect(await rowsOf('posts', 'id', idOf('post'))).toBe(0);
    expect(await rowsOf('post_versions', 'post_id', idOf('post'))).toBe(0);
    expect(await rowsOf('briefs', 'id', idOf('brief'))).toBe(0);
    expect(await planRows()).toBe(0);
    expect(await rowsOf('induction_sample_rows', 'workspace_id', ws.id)).toBe(0);

    expect(await rowsOf('posts', 'id', ownPostId)).toBe(1);
    expect(await rowsOf('briefs', 'id', String(otherBrief.id))).toBe(1);
    expect(await rowsOf('chat_messages', 'channel_id', channelId)).toBe(1);
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', trace],
        ['action', 'induction_sample_clear'],
      ]),
    ).toBe(1);
  });

  it('is idempotent: a second clear changes nothing', async () => {
    const res = await rpc(owner.id, 'induction_sample_clear', {
      p_workspace_id: ws.id,
      p_trace_id: uuidv7(),
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ cleared: false });
    expect(await rowsOf('posts', 'id', ownPostId)).toBe(1);
  });
});
