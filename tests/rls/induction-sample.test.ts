// The first-time tour's sample workspace (20261017150000_induction_sample_week.sql):
// induction_sample_seed lets any active member whose tour is not finished fill the
// workspace with Kestrel & Rowe (five sample people, Shoot crew, a DM with Riya, 22 chat
// messages, 37 posts with photos, 6 briefs, an 18-file library, a client plan for this
// week, comments, annotations and the seeder's activity), flagged in
// induction_sample_rows. One live sample per workspace, one seed per person per
// workspace (induction_sample_seeds). induction_sample_clear (seeder or owner) deletes
// exactly the sample rows and keeps everyone's own work. A third person joining, or the
// sample turning two hours old (read through induction_state), clears it. Members read
// the markers; induction_state ignores sample people; sample files use no storage.

import { execFileSync } from 'node:child_process';
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
  seedUser,
  type GenericClient,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

const SAMPLE_PEOPLE = [
  '5a3b1e00-0000-4000-8000-000000000001', // Riya Menon, client
  '5a3b1e00-0000-4000-8000-000000000002', // Arjun Shah, agency
  '5a3b1e00-0000-4000-8000-000000000003', // Dev Kapoor, agency
  '5a3b1e00-0000-4000-8000-000000000004', // Neha Rao, agency
  '5a3b1e00-0000-4000-8000-000000000005', // Meera Iyer, client
];
const DEV = SAMPLE_PEOPLE[2];
const PEOPLE_SQL = `array[${SAMPLE_PEOPLE.map((p) => `'${p}'`).join(',')}]::uuid[]`;

/** Typed pass-through for direct .rpc() args; each call sets its own p_trace_id (a uuid v7). */
function rpcArgs<T>(args: T): T {
  return args;
}

type RpcResult = { data: unknown; error: { message: string } | null };

/** Procs not in the generated types until the migration is applied. */
async function rpc(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const client = clientFor(userId) as unknown as {
    rpc: (fn: string, a: Record<string, unknown>) => Promise<RpcResult>;
  };
  return client.rpc(name, rpcArgs(args));
}

/** How many rows a query returns (0 when RLS hides them). */
async function rowCount(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const res = await query;
  return ((res.data ?? []) as unknown[]).length;
}

interface Owned {
  owner: SeededUser;
  ws: SeededWorkspace;
  groupChannel: string;
}

describe.runIf(RLS_SUITE)('induction sample workspace', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let main: Owned;
  let ownPostId: string;
  const users: SeededUser[] = [];
  const workspaces: SeededWorkspace[] = [];

  /** Ground truth through psql (bypasses RLS): the first column of the first row. */
  function sql(query: string): string {
    return execFileSync('psql', [env.dbUrl, '-At', '-c', query], { encoding: 'utf8' }).trim();
  }
  const num = (query: string): number => Number(sql(query));

  /** A new owner and their real workspace (workspace_create makes the default group). */
  async function ownWorkspace(): Promise<Owned> {
    const owner = await seedUser(env, admin);
    users.push(owner);
    const created = await clientFor(owner.id).rpc(
      'workspace_create',
      rpcArgs({
        p_payload: {
          name: `Sample ${uuidv7().slice(-6)}`,
          timezone: 'Asia/Kolkata',
          platform: 'instagram',
        },
        p_trace_id: uuidv7(),
      }),
    );
    if (created.error) throw new Error(created.error.message);
    const ws = { id: String(created.data), name: 'Sample', ownerId: owner.id };
    workspaces.push(ws);
    const groupChannel = sql(
      `select c.channel_id from public.chat_channels c join public.groups g on g.id = c.entity_id ` +
        `where g.workspace_id = '${ws.id}' and g.is_default`,
    );
    return { owner, ws, groupChannel };
  }

  const markers = (wsId: string, kind?: string): number =>
    num(
      `select count(*) from public.induction_sample_rows where workspace_id = '${wsId}'` +
        (kind ? ` and kind = '${kind}'` : ''),
    );
  const tagged = (wsId: string, tag: string): string =>
    sql(
      `select row_id from public.induction_sample_rows where workspace_id = '${wsId}' and tag = '${tag}'`,
    );
  const sampleMembers = (wsId: string): number =>
    num(
      `select count(*) from public.workspace_members where workspace_id = '${wsId}' ` +
        `and user_id = any(${PEOPLE_SQL})`,
    );
  const seed = (o: Owned): Promise<RpcResult> =>
    rpc(o.owner.id, 'induction_sample_seed', { p_workspace_id: o.ws.id, p_trace_id: uuidv7() });
  const seedAs = (userId: string, wsId: string): Promise<RpcResult> =>
    rpc(userId, 'induction_sample_seed', { p_workspace_id: wsId, p_trace_id: uuidv7() });
  const clearAs = (userId: string, wsId: string): Promise<RpcResult> =>
    rpc(userId, 'induction_sample_clear', { p_workspace_id: wsId, p_trace_id: uuidv7() });
  const seedRecord = (wsId: string, userId: string): string =>
    sql(
      `select coalesce(clear_reason, 'live') from public.induction_sample_seeds ` +
        `where workspace_id = '${wsId}' and seeded_by = '${userId}'`,
    );

  /** A new user invited by the owner with `role` who has accepted. */
  async function joined(o: Owned, role: 'agency' | 'client'): Promise<SeededUser> {
    const user = await seedUser(env, admin);
    users.push(user);
    const invited = await clientFor(o.owner.id).rpc(
      'member_invite',
      rpcArgs({ p_workspace_id: o.ws.id, p_email: user.email, p_role: role, p_trace_id: uuidv7() }),
    );
    if (invited.error) throw new Error(invited.error.message);
    const accepted = await clientFor(user.id).rpc(
      'member_accept',
      rpcArgs({ p_invite_id: String(invited.data), p_trace_id: uuidv7() }),
    );
    if (accepted.error) throw new Error(accepted.error.message);
    return user;
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    main = await ownWorkspace();
    // The creator's own first post, sent for review before the look-around.
    const post = await clientFor(main.owner.id).rpc(
      'post_create',
      rpcArgs({
        p_workspace_id: main.ws.id,
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

  it('creates the five sample people once: completed profiles that cannot sign in', () => {
    expect(
      sql(
        `select string_agg(display_name || ':' || designation || ':' || username || ':' || avatar_url, ',' order by id) ` +
          `from public.users where id = any(${PEOPLE_SQL}) and profile_completed_at is not null and not email_opt_in`,
      ),
    ).toBe(
      [
        'Riya Menon:Brand manager:riya.menon.sample:/induction-sample/av-riya.jpg',
        'Arjun Shah:Creative lead:arjun.shah.sample:/induction-sample/av-arjun.jpg',
        'Dev Kapoor:Designer:dev.kapoor.sample:/induction-sample/av-dev.jpg',
        'Neha Rao:Copywriter:neha.rao.sample:/induction-sample/av-neha.jpg',
        'Meera Iyer:Marketing head:meera.iyer.sample:/induction-sample/av-meera.jpg',
      ].join(','),
    );
    expect(
      num(
        `select count(*) from auth.users where id = any(${PEOPLE_SQL}) and email like '%@sample.srtd.io' ` +
          `and email_confirmed_at is null and banned_until > now() and coalesce(encrypted_password, '') = ''`,
      ),
    ).toBe(5);
  });

  it('refuses anyone who is not an active member', async () => {
    const outsider = await seedUser(env, admin);
    users.push(outsider);
    for (const fn of ['induction_sample_seed', 'induction_sample_clear']) {
      const res = await rpc(outsider.id, fn, { p_workspace_id: main.ws.id, p_trace_id: uuidv7() });
      expect(res.error?.message).toBe('workspace_member_only');
    }
    expect(markers(main.ws.id)).toBe(0);
  });

  it('seeds the whole sample world into the owner workspace, flagged, with an audit row', async () => {
    const ws = main.ws.id;
    const bytesBefore = num(`select public.workspace_bytes_used('${ws}')`);
    const trace = uuidv7();
    const res = await rpc(main.owner.id, 'induction_sample_seed', {
      p_workspace_id: ws,
      p_trace_id: trace,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      seeded: true,
      rows: {
        member: 5,
        post: 37,
        post_version: 37,
        brief: 6,
        comment: 5,
        post_annotation: 2,
        plan: 1,
        plan_item: 8,
        plan_item_review: 10,
        chat_message: 22,
        chat_channel: 2,
        group: 1,
        inbox_entry: 6,
      },
    });

    // People: five active members with their roles, none of them the owner.
    expect(
      sql(
        `select string_agg(role, ',' order by user_id) from public.workspace_members ` +
          `where workspace_id = '${ws}' and active and user_id = any(${PEOPLE_SQL})`,
      ),
    ).toBe('client,agency,agency,agency,client');

    // Posts: 37 sample posts and the owner's own, every sample post with its photos.
    expect(num(`select count(*) from public.posts where workspace_id = '${ws}'`)).toBe(38);
    expect(
      num(
        `select count(distinct a.entity_id) from public.asset_attachments a ` +
          `join public.asset_versions v on v.id = a.asset_version_id ` +
          `where a.workspace_id = '${ws}' and a.entity_type = 'post' and v.r2_key like 'induction-sample/%'`,
      ),
    ).toBe(37);
    expect(
      num(
        `select count(*) from public.posts p where p.workspace_id = '${ws}' and p.id <> '${ownPostId}' ` +
          `and not exists (select 1 from public.post_versions v where v.post_id = p.id and v.version_number = 1)`,
      ),
    ).toBe(0);
    expect(
      num(
        `select count(*) from public.posts where workspace_id = '${ws}' and stage = 'approved' ` +
          `and approved_by = '${SAMPLE_PEOPLE[0]}'`,
      ),
    ).toBe(9);
    // The owner's own post keeps the first number; a new post still gets the next one.
    expect(num(`select number from public.posts where id = '${ownPostId}'`)).toBe(1);
    expect(
      num(
        `select count(*) from (select number from public.posts where workspace_id = '${ws}' ` +
          `union all select number from public.briefs where workspace_id = '${ws}') n`,
      ),
    ).toBe(44);
    expect(
      num(`select next_entity_number from public.workspace_counters where workspace_id = '${ws}'`),
    ).toBe(45);

    // Pink ruffle set: three slides, version 1, a caption span and a pin, four comments.
    const review = tagged(ws, 'review_post');
    expect(sql(`select title || ':' || stage from public.posts where id = '${review}'`)).toBe(
      'Pink ruffle set:review',
    );
    expect(num(`select count(*) from public.asset_attachments where entity_id = '${review}'`)).toBe(
      3,
    );
    expect(
      sql(
        `select string_agg(a.kind || ':' || coalesce(substr(p.caption, a.caption_start + 1, ` +
          `a.caption_end - a.caption_start), '') || ':' || c.body, ',' order by a.kind) ` +
          `from public.post_annotations a join public.posts p on p.id = a.post_id ` +
          `join public.comments c on c.id = a.comment_id where a.post_id = '${review}'`,
      ),
    ).toBe(
      'caption_span:drops Friday:Say lands Friday, not drops.,image_pin::Warm the skin tone here, please.',
    );
    expect(num(`select count(*) from public.comments where workspace_id = '${ws}'`)).toBe(5);
    expect(
      num(
        `select count(*) from public.comments where workspace_id = '${ws}' ` +
          `and mentions = jsonb_build_array('${main.owner.id}') and body like '@[${main.owner.id}]%'`,
      ),
    ).toBe(1);

    // Briefs: six, Disco knits drop open with three photos, two closed.
    expect(num(`select count(*) from public.briefs where workspace_id = '${ws}'`)).toBe(6);
    expect(
      num(`select count(*) from public.briefs where workspace_id = '${ws}' and status = 'closed'`),
    ).toBe(2);
    expect(
      num(
        `select count(*) from public.asset_attachments where entity_id = '${tagged(ws, 'brief')}'`,
      ),
    ).toBe(3);

    // Library: six PDFs (each with a thumbnail) and twelve photos, by Arjun.
    expect(
      num(
        `select count(*) from public.asset_versions where workspace_id = '${ws}' and kind = 'pdf' ` +
          `and r2_key like 'induction-sample/pdf-%.pdf' and uploaded_by = '${SAMPLE_PEOPLE[1]}'`,
      ),
    ).toBe(6);
    expect(
      num(
        `select count(*) from public.asset_versions where workspace_id = '${ws}' and kind = 'image' ` +
          `and r2_key like 'induction-sample/as-%.jpg'`,
      ),
    ).toBe(12);
    expect(
      num(
        `select count(*) from public.asset_renditions where workspace_id = '${ws}' and role = 'thumbnail'`,
      ),
    ).toBe(6);

    // Chat: the DM, the default group and Shoot crew; Dev's voice note with its transcript.
    expect(num(`select count(*) from public.chat_messages where workspace_id = '${ws}'`)).toBe(22);
    expect(
      num(`select count(*) from public.chat_messages where channel_id = '${main.groupChannel}'`),
    ).toBe(9);
    const voice = JSON.parse(
      sql(
        `select json_build_object('sender', sender_user_id, 'meta', attachment_meta) ` +
          `from public.chat_messages where id = '${tagged(ws, 'voice_note')}'`,
      ),
    ) as {
      sender: string;
      meta: Record<string, { mime: string; peaks: number[]; transcript: string }>;
    };
    expect(voice.sender).toBe(DEV);
    const meta = Object.values(voice.meta)[0];
    expect(meta?.mime).toBe('audio/webm');
    expect(meta?.peaks).toHaveLength(48);
    expect(meta?.transcript).toBe(
      'Riya wants the red deeper on the co-ord, and the caption under two hundred characters. Can we fix both before six?',
    );
    expect(
      num(
        `select count(*) from public.chat_messages where channel_id = '${main.groupChannel}' ` +
          `and cardinality(attachment_asset_ids) = 3 and body = 'Three options for the cover'`,
      ),
    ).toBe(1);
    expect(
      sql(
        `select name || ':' || avatar_url from public.groups where workspace_id = '${ws}' and not is_default`,
      ),
    ).toBe('Shoot crew:/induction-sample/gp-crew.jpg');

    // Plan: shared with the client, this week, eight items, its card in the group.
    const plan = tagged(ws, 'plan');
    const asOwner = asGeneric(clientFor(main.owner.id));
    expect(
      await rowCount(asOwner.from('plans').select('id').eq('id', plan).eq('audience', 'client')),
    ).toBe(1);
    expect(await rowCount(asOwner.from('plan_items').select('id').eq('plan_id', plan))).toBe(8);
    expect(
      num(
        `select count(*) from public.plans where id = '${plan}' and starts_on <= ` +
          `(now() at time zone 'Asia/Kolkata')::date and ends_on >= (now() at time zone 'Asia/Kolkata')::date`,
      ),
    ).toBe(1);
    expect(
      num(
        `select count(*) from public.chat_messages where shared_plan_ids @> array['${plan}']::uuid[]`,
      ),
    ).toBe(1);

    // Activity: the owner's six sample entries (plus the welcome), already emailed; no
    // one else got anything, and nothing was queued for the Agora sync.
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' and user_id = '${main.owner.id}'`,
      ),
    ).toBe(7);
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' ` +
          `and user_id = '${main.owner.id}' and event_type <> 'system' and email_sent_at is not null`,
      ),
    ).toBe(6);
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' and user_id <> '${main.owner.id}'`,
      ),
    ).toBe(0);
    // The only chat sync is the default group's rename to the sample name.
    expect(
      num(
        `select count(*) from public.chat_sync_events where workspace_id = '${ws}' and event_type <> 'group_rename'`,
      ),
    ).toBe(0);
    expect(
      sql(
        `select string_agg(payload->>'name', ',' order by id) from public.chat_sync_events where workspace_id = '${ws}' and event_type = 'group_rename'`,
      ),
    ).toBe('Kestrel and Rowe');

    // Storage: sample files use none of the workspace's space.
    expect(num(`select public.workspace_bytes_used('${ws}')`)).toBe(bytesBefore);
    const storage = await rpc(main.owner.id, 'workspace_storage', { p_workspace_id: ws });
    expect(storage.error).toBeNull();
    expect((storage.data as { library_bytes: number }[])[0]?.library_bytes).toBe(0);

    // Sample people are not invites.
    const state = await rpc(main.owner.id, 'induction_state', {
      p_workspace_id: ws,
      p_trace_id: uuidv7(),
    });
    expect(state.data).toMatchObject({ client_invited: false, team_invited: false });

    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', trace],
        ['action', 'induction_sample_seed'],
      ]),
    ).toBe(1);
  });

  it('is idempotent: a second seed changes nothing and returns the same ids', async () => {
    const before = markers(main.ws.id);
    const res = await seed(main);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      seeded: false,
      review_post_id: tagged(main.ws.id, 'review_post'),
      plan_id: tagged(main.ws.id, 'plan'),
    });
    expect(markers(main.ws.id)).toBe(before);
    expect(num(`select count(*) from public.posts where workspace_id = '${main.ws.id}'`)).toBe(38);
    expect(sampleMembers(main.ws.id)).toBe(5);
  });

  it('lets members read the markers, not strangers, and nobody write them', async () => {
    const read = (userId: string) =>
      rowCount(
        asGeneric(clientFor(userId))
          .from('induction_sample_rows')
          .select('row_id')
          .eq('workspace_id', main.ws.id),
      );
    expect(await read(main.owner.id)).toBe(markers(main.ws.id));
    const stranger = await seedUser(env, admin);
    users.push(stranger);
    expect(await read(stranger.id)).toBe(0);
    const write = await asGeneric(clientFor(main.owner.id))
      .from('induction_sample_rows')
      .delete()
      .eq('workspace_id', main.ws.id);
    expect(write.error).not.toBeNull();
  });

  it('clears exactly the sample: own post, own comments elsewhere, other briefs and chat stay', async () => {
    const ws = main.ws.id;
    const review = tagged(ws, 'review_post');
    const comment = (entityId: string, body: string) =>
      clientFor(main.owner.id).rpc(
        'comment_create',
        rpcArgs({
          p_workspace_id: ws,
          p_entity_type: 'post',
          p_entity_id: entityId,
          p_parent_comment_id: null,
          p_body: body,
          p_mentions: null,
          p_attachment_asset_ids: null,
          p_trace_id: uuidv7(),
        }) as never,
      );
    const onSample = await comment(review, 'Looks good to me');
    expect(onSample.error).toBeNull();
    const onOwn = await comment(ownPostId, 'A note on my own post');
    expect(onOwn.error).toBeNull();
    const otherBrief = await insertRow(g, 'briefs', {
      workspace_id: ws,
      number: 9000,
      title: 'Real brief',
      objective: 'Stays',
      created_by: main.owner.id,
    });
    const sent = await clientFor(main.owner.id).rpc(
      'chat_message_send',
      rpcArgs({
        p_id: uuidv7(),
        p_channel_id: main.groupChannel,
        p_trace_id: uuidv7(),
        p_body: 'A real message',
      }),
    );
    expect(sent.error).toBeNull();

    const trace = uuidv7();
    const res = await rpc(main.owner.id, 'induction_sample_clear', {
      p_workspace_id: ws,
      p_trace_id: trace,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      cleared: true,
      reason: 'seeder',
      linked_comments: 1,
      rows: { post: 37 },
    });

    expect(markers(ws)).toBe(0);
    expect(sampleMembers(ws)).toBe(0);
    expect(
      sql(`select string_agg(id::text, ',') from public.posts where workspace_id = '${ws}'`),
    ).toBe(ownPostId);
    expect(
      sql(`select string_agg(body, ',') from public.comments where workspace_id = '${ws}'`),
    ).toBe('A note on my own post');
    expect(
      sql(`select string_agg(id::text, ',') from public.briefs where workspace_id = '${ws}'`),
    ).toBe(String(otherBrief.id));
    expect(num(`select count(*) from public.assets where workspace_id = '${ws}'`)).toBe(0);
    expect(num(`select count(*) from public.asset_attachments where workspace_id = '${ws}'`)).toBe(
      0,
    );
    expect(num(`select count(*) from public.plans where workspace_id = '${ws}'`)).toBe(0);
    expect(num(`select count(*) from public.groups where workspace_id = '${ws}'`)).toBe(1);
    expect(num(`select count(*) from public.chat_channels where workspace_id = '${ws}'`)).toBe(1);
    expect(
      sql(`select string_agg(body, ',') from public.chat_messages where workspace_id = '${ws}'`),
    ).toBe('A real message');
    expect(
      num(
        `select count(*) from public.group_members where workspace_id = '${ws}' and user_id = any(${PEOPLE_SQL})`,
      ),
    ).toBe(0);
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' ` +
          `and (user_id = any(${PEOPLE_SQL}) or (user_id = '${main.owner.id}' and event_type <> 'system' ` +
          `and entity_id is distinct from '${ownPostId}'))`,
      ),
    ).toBe(0);
    // The owner's own already-read row for the comment on their real post stays
    // (20261018140000); the comment on the sample post never wrote one (20261018150000).
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' ` +
          `and user_id = '${main.owner.id}' and actor_user_id = '${main.owner.id}' ` +
          `and event_type = 'comment' and entity_id = '${ownPostId}' and read_at is not null`,
      ),
    ).toBe(1);
    // The only chat syncs are the default group's renames: to the sample name, then back.
    expect(
      num(
        `select count(*) from public.chat_sync_events where workspace_id = '${ws}' and event_type <> 'group_rename'`,
      ),
    ).toBe(0);
    expect(
      num(
        `select count(*) from public.chat_sync_events where workspace_id = '${ws}' and event_type = 'group_rename'`,
      ),
    ).toBe(2);
    expect(
      sql(
        `select name from public.groups where workspace_id = '${ws}' and is_default and deleted_at is null`,
      ),
    ).not.toBe('Kestrel and Rowe');
    expect(
      sql(`select clear_reason from public.induction_sample_seeds where workspace_id = '${ws}'`),
    ).toBe('seeder');
    expect(
      await countWhere(g, 'audit_log', [
        ['trace_id', trace],
        ['action', 'induction_sample_clear'],
      ]),
    ).toBe(1);
  });

  it('is idempotent and never re-seeds the same person: a second clear and seed change nothing', async () => {
    const again = await rpc(main.owner.id, 'induction_sample_clear', {
      p_workspace_id: main.ws.id,
      p_trace_id: uuidv7(),
    });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ cleared: false });
    const reseed = await seed(main);
    expect(reseed.error).toBeNull();
    expect(reseed.data).toMatchObject({ seeded: false, reason: 'seeded_before' });
    expect(markers(main.ws.id)).toBe(0);
    expect(num(`select count(*) from public.posts where workspace_id = '${main.ws.id}'`)).toBe(1);
  });

  it('keeps the sample when the owner invites a real client, and clears it when they accept', async () => {
    const o = await ownWorkspace();
    expect((await seed(o)).data).toMatchObject({ seeded: true });
    const client = await seedUser(env, admin);
    users.push(client);
    const invited = await clientFor(o.owner.id).rpc(
      'member_invite',
      rpcArgs({
        p_workspace_id: o.ws.id,
        p_email: client.email,
        p_role: 'client',
        p_trace_id: uuidv7(),
      }),
    );
    expect(invited.error).toBeNull();
    // A pending invite is not a member joining: the creator invites the approver
    // before the look-around, which still needs the sample.
    expect(markers(o.ws.id)).toBeGreaterThan(0);
    expect(sampleMembers(o.ws.id)).toBe(5);
    expect(
      sql(
        `select clear_reason from public.induction_sample_seeds where workspace_id = '${o.ws.id}'`,
      ),
    ).toBe('');
    // The first real client still sets the workspace's client domain.
    expect(sql(`select client_domain from public.workspaces where id = '${o.ws.id}'`)).toBe(
      client.email.split('@')[1],
    );
    const state = await rpc(o.owner.id, 'induction_state', {
      p_workspace_id: o.ws.id,
      p_trace_id: uuidv7(),
    });
    expect(state.data).toMatchObject({ client_invited: true, team_invited: false });

    const accepted = await clientFor(client.id).rpc(
      'member_accept',
      rpcArgs({ p_invite_id: String(invited.data), p_trace_id: uuidv7() }),
    );
    expect(accepted.error).toBeNull();
    expect(markers(o.ws.id)).toBe(0);
    expect(sampleMembers(o.ws.id)).toBe(0);
    expect(num(`select count(*) from public.posts where workspace_id = '${o.ws.id}'`)).toBe(0);
    expect(
      sql(
        `select clear_reason from public.induction_sample_seeds where workspace_id = '${o.ws.id}'`,
      ),
    ).toBe('member_joined');
  });

  it('clears the sample when an earlier invitee accepts', async () => {
    const o = await ownWorkspace();
    const teammate = await seedUser(env, admin);
    users.push(teammate);
    const invited = await clientFor(o.owner.id).rpc(
      'member_invite',
      rpcArgs({
        p_workspace_id: o.ws.id,
        p_email: teammate.email,
        p_role: 'agency',
        p_trace_id: uuidv7(),
      }),
    );
    expect(invited.error).toBeNull();
    // A pending invite has never been active: the seed still runs.
    expect((await seed(o)).data).toMatchObject({ seeded: true });
    expect(sampleMembers(o.ws.id)).toBe(5);
    const accepted = await clientFor(teammate.id).rpc(
      'member_accept',
      rpcArgs({ p_invite_id: String(invited.data), p_trace_id: uuidv7() }),
    );
    expect(accepted.error).toBeNull();
    expect(markers(o.ws.id)).toBe(0);
    expect(sampleMembers(o.ws.id)).toBe(0);
    expect(num(`select count(*) from public.chat_messages where workspace_id = '${o.ws.id}'`)).toBe(
      0,
    );
    expect(
      num(
        `select count(*) from public.workspace_members where workspace_id = '${o.ws.id}' and active`,
      ),
    ).toBe(2);
  });
  it('runs every tour in a sample: owner, then an approver, each seeded once', async () => {
    const o = await ownWorkspace();
    const teammate = await joined(o, 'agency');
    const approver = await joined(o, 'client');
    const ws = o.ws.id;

    // The owner's tour: seeded, cleared by the owner (the seeder).
    expect((await seed(o)).data).toMatchObject({ seeded: true });
    expect((await seedAs(approver.id, ws)).data).toMatchObject({
      seeded: false,
      reason: 'already_seeded',
      seeded_by: o.owner.id,
    });
    expect((await clearAs(o.owner.id, ws)).data).toMatchObject({ cleared: true, reason: 'seeder' });

    // The approver's tour, after accepting: the same world, with the approver as ME.
    expect((await seedAs(approver.id, ws)).data).toMatchObject({ seeded: true });
    expect(seedRecord(ws, approver.id)).toBe('live');
    expect(num(`select count(*) from public.posts where workspace_id = '${ws}'`)).toBe(37);
    expect(
      num(
        `select count(*) from public.inbox_entries where workspace_id = '${ws}' ` +
          `and user_id = '${approver.id}' and email_sent_at is not null and event_type <> 'system'`,
      ),
    ).toBe(6);
    expect(
      num(
        `select count(*) from public.comments where workspace_id = '${ws}' ` +
          `and mentions = jsonb_build_array('${approver.id}')`,
      ),
    ).toBe(1);
    expect(
      num(
        `select count(*) from public.chat_channels where workspace_id = '${ws}' and channel_type = 'dm' ` +
          `and '${approver.id}' in (dm_user_a, dm_user_b)`,
      ),
    ).toBe(1);
    // Shoot crew is the agency's room: the approver is not in it.
    expect(
      sql(
        `select string_agg(gm.user_id::text, ',' order by gm.user_id) from public.group_members gm ` +
          `join public.groups g on g.id = gm.group_id where g.workspace_id = '${ws}' and not g.is_default`,
      ),
    ).toBe([SAMPLE_PEOPLE[1], SAMPLE_PEOPLE[2], SAMPLE_PEOPLE[3]].join(','));
    expect(
      num(
        `select count(*) from public.chat_messages where workspace_id = '${ws}' ` +
          `and sender_user_id = '${approver.id}'`,
      ),
    ).toBeGreaterThan(0);

    // Every member reads the markers.
    const read = (userId: string) =>
      rowCount(
        asGeneric(clientFor(userId))
          .from('induction_sample_rows')
          .select('row_id')
          .eq('workspace_id', ws),
      );
    expect(await read(teammate.id)).toBe(markers(ws));
    expect(await read(approver.id)).toBe(markers(ws));

    // Seeded twice for the same person: no. Cleared by a non-seeder, non-owner: no.
    expect((await seedAs(approver.id, ws)).data).toMatchObject({
      seeded: false,
      reason: 'already_seeded',
    });
    expect((await clearAs(teammate.id, ws)).error?.message).toBe('forbidden_role');
    expect(markers(ws)).toBeGreaterThan(0);

    // The owner may clear the approver's sample; neither is seeded again here.
    expect((await clearAs(o.owner.id, ws)).data).toMatchObject({ cleared: true, reason: 'owner' });
    expect(markers(ws)).toBe(0);
    expect(sampleMembers(ws)).toBe(0);
    expect(seedRecord(ws, approver.id)).toBe('owner');
    expect((await seedAs(approver.id, ws)).data).toMatchObject({
      seeded: false,
      reason: 'seeded_before',
    });
    expect((await seed(o)).data).toMatchObject({ seeded: false, reason: 'seeded_before' });
  });

  it('lets an approver clear their own sample; a third person joining clears one', async () => {
    const o = await ownWorkspace();
    const approver = await joined(o, 'client');
    const ws = o.ws.id;
    expect((await seedAs(approver.id, ws)).data).toMatchObject({ seeded: true });
    expect((await clearAs(approver.id, ws)).data).toMatchObject({
      cleared: true,
      reason: 'seeder',
    });
    expect(markers(ws)).toBe(0);

    expect((await seed(o)).data).toMatchObject({ seeded: true });
    const third = await joined(o, 'agency');
    expect(markers(ws)).toBe(0);
    expect(sampleMembers(ws)).toBe(0);
    expect(seedRecord(ws, o.owner.id)).toBe('member_joined');

    // A finished tour is never seeded.
    sql(
      `insert into public.user_private (user_id, induction_done_at) values ('${third.id}', now()) ` +
        `on conflict (user_id) do update set induction_done_at = now()`,
    );
    expect((await seedAs(third.id, ws)).data).toMatchObject({ seeded: false, reason: 'tour_done' });
  });

  it('clears a sample older than two hours when induction_state is read', async () => {
    const o = await ownWorkspace();
    expect((await seed(o)).data).toMatchObject({ seeded: true });
    const state = () =>
      rpc(o.owner.id, 'induction_state', { p_workspace_id: o.ws.id, p_trace_id: uuidv7() });
    expect((await state()).error).toBeNull();
    expect(markers(o.ws.id)).toBeGreaterThan(0);

    sql(
      `update public.induction_sample_seeds set seeded_at = now() - interval '2 hours 1 minute' ` +
        `where workspace_id = '${o.ws.id}'`,
    );
    const trace = uuidv7();
    const res = await rpc(o.owner.id, 'induction_state', {
      p_workspace_id: o.ws.id,
      p_trace_id: trace,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ role: 'owner' });
    expect(markers(o.ws.id)).toBe(0);
    expect(sampleMembers(o.ws.id)).toBe(0);
    expect(seedRecord(o.ws.id, o.owner.id)).toBe('expired');
    expect(
      num(
        `select count(*) from public.audit_log where trace_id = '${trace}' ` +
          `and action = 'induction_sample_clear' and payload ->> 'reason' = 'expired'`,
      ),
    ).toBe(1);
  });
});
