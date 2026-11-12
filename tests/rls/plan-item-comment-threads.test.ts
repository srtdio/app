// Plan comment threads (20261112100000_plan_item_comment_threads.sql,
// 20261112110000_plan_item_comment_files_and_threads_for_me.sql).
// plan_item_comment_send writes a main comment (p_parent_comment_id null) or a
// reply one level deep; a reply takes its main comment's visibility whatever
// p_visibility says. An approver (role client) never writes or reads a
// Creators-only ('team') comment or its files. A reply notifies only that
// thread's writers ('plan_comment', payload root_comment_id) and the mentioned
// ('mention'); a member who never wrote gets nothing. Files attach through
// asset_attachments entity_type 'plan_item_comment', so a files-only comment
// (blank body, one version) is valid while a blank one with no files is not.
// plan_item_comment_thread_read_set refuses a comment the caller cannot see
// ('comment not found') and otherwise writes the caller's own read row.
//
// plan_item_comments grants service_role no SELECT (live parity), so stored
// comment rows are read as an agency member, who sees both visibilities.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  countWhere,
  createAdminClient,
  loadRlsEnv,
  ownReadCount,
  randomSuffix,
  seedAsset,
  seedMember,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type GenericClient,
  type SeededAsset,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/**
 * Typed pass-through for direct .rpc() args. Every proc here takes its own
 * p_trace_id (a uuid v7, set at every call site). callRpc() is the app
 * wrapper and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

/** Unwrap an rpc result or throw with the proc name and message. */
function must<T>(proc: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error !== null || res.data === null) {
    throw new Error(`${proc} failed: ${res.error?.message ?? 'no data'}`);
  }
  return res.data;
}

type Visibility = 'everyone' | 'team';

interface SendResult {
  data: string | null;
  error: { message: string } | null;
}

describe.runIf(RLS_SUITE)('plan comment threads', () => {
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let writerB: SeededUser;
  let bystander: SeededUser;
  let mentioned: SeededUser;
  let approver: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let itemId: string;
  let teamFile: SeededAsset;
  let soloFile: SeededAsset;

  function as(user: SeededUser): SupabaseClient<Database> {
    return clientFor(user.id);
  }

  async function send(
    user: SeededUser,
    opts: {
      parent?: string;
      body?: string;
      visibility?: Visibility;
      versions?: string[];
    } = {},
  ): Promise<SendResult> {
    return await as(user).rpc(
      'plan_item_comment_send',
      rpcArgs({
        p_item_id: itemId,
        // The proc takes null for a main comment; the generated type says string.
        p_parent_comment_id: opts.parent ?? (null as unknown as string),
        p_body: opts.body ?? `Comment ${randomSuffix()}`,
        p_visibility: opts.visibility ?? 'everyone',
        p_attachment_version_ids: opts.versions ?? [],
        p_trace_id: uuidv7(),
      }),
    );
  }

  async function sendOk(user: SeededUser, opts: Parameters<typeof send>[1] = {}): Promise<string> {
    return must('plan_item_comment_send', await send(user, opts));
  }

  /** Stored comment row, read as the agency member (sees both visibilities). */
  async function stored(
    id: string,
  ): Promise<{ visibility: string; attachment_asset_ids: string[] | null; body: string }> {
    const res = await as(agency)
      .from('plan_item_comments')
      .select('visibility, attachment_asset_ids, body')
      .eq('id', id);
    if (res.error !== null) throw new Error(`plan_item_comments read failed: ${res.error.message}`);
    const row = res.data[0];
    if (row === undefined) throw new Error(`comment ${id} not found`);
    return row;
  }

  /** Service-role ground truth: inbox rows of one type for one user and comment. */
  function inboxCount(user: SeededUser, eventType: string, commentId: string): Promise<number> {
    return countWhere(g, 'inbox_entries', [
      ['user_id', user.id],
      ['event_type', eventType],
      ['payload->>comment_id', commentId],
    ]);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    const admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    writerB = await seedUser(env, admin);
    bystander = await seedUser(env, admin);
    mentioned = await seedUser(env, admin);
    approver = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Plan threads ${owner.email}`);
    await seedWorkspace(admin, outsider, `Plan threads other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, writerB, 'agency');
    await seedMember(g, ws, bystander, 'agency');
    await seedMember(g, ws, mentioned, 'agency');
    await seedMember(g, ws, approver, 'client');

    // A client-audience plan with one concept: the approver can read the item,
    // so only the comment's own visibility decides what they see.
    const planId = must(
      'plan_create',
      await as(agency).rpc(
        'plan_create',
        rpcArgs({
          p_workspace_id: ws.id,
          p_title: `Plan ${randomSuffix()}`,
          p_starts_on: '2026-11-01',
          p_ends_on: '2026-11-30',
          p_audience: 'client',
          p_trace_id: uuidv7(),
        }),
      ),
    );
    itemId = must(
      'plan_concept_add',
      await as(agency).rpc(
        'plan_concept_add',
        rpcArgs({
          p_plan_id: planId,
          p_title: 'Concept',
          p_description: 'A concept',
          p_attachment_version_ids: [],
          p_trace_id: uuidv7(),
        }),
      ),
    );
    teamFile = await seedAsset(g, ws.id, agency.id, 'library');
    soloFile = await seedAsset(g, ws.id, agency.id, 'library');
  });

  // No teardown, as in plans.test.ts: the container is ephemeral and every
  // fixture is scoped to its own fresh workspace and users.

  it('a member of another workspace cannot comment on the item', async () => {
    const res = await send(outsider, { body: 'from outside' });
    expect(res.error?.message).toMatch(/workspace_member_only/);
  });

  it('an approver cannot reply to, read, or read the files of a team main comment', async () => {
    const teamMain = await sendOk(agency, { visibility: 'team', versions: [teamFile.versionId] });

    const reply = await send(approver, { parent: teamMain, body: 'let me in' });
    expect(reply.error?.message).toMatch(/forbidden_role/);

    const byId: Array<readonly [string, string]> = [['id', teamMain]];
    expect(await visibleRowCount(asGeneric(as(approver)), 'plan_item_comments', byId)).toBe(0);
    expect(await ownReadCount(asGeneric(as(agency)), 'plan_item_comments', byId)).toBe(1);

    const files: Array<readonly [string, string]> = [
      ['entity_type', 'plan_item_comment'],
      ['entity_id', teamMain],
    ];
    expect(await countWhere(g, 'asset_attachments', files)).toBe(1);
    expect(await ownReadCount(asGeneric(as(agency)), 'asset_attachments', files)).toBe(1);
    expect(await visibleRowCount(asGeneric(as(approver)), 'asset_attachments', files)).toBe(0);
  });

  it('a reply takes its main comment visibility whatever p_visibility says', async () => {
    const everyoneMain = await sendOk(agency, { visibility: 'everyone' });
    const intoEveryone = await sendOk(agency, { parent: everyoneMain, visibility: 'team' });
    expect((await stored(intoEveryone)).visibility).toBe('everyone');

    const teamMain = await sendOk(agency, { visibility: 'team' });
    const intoTeam = await sendOk(agency, { parent: teamMain, visibility: 'everyone' });
    expect((await stored(intoTeam)).visibility).toBe('team');
  });

  it('a reply to a reply is refused', async () => {
    const main = await sendOk(agency);
    const reply = await sendOk(writerB, { parent: main });
    const nested = await send(agency, { parent: reply, body: 'too deep' });
    expect(nested.error?.message).toMatch(/invalid_payload/);
  });

  it('a files-only comment is stored with its files; a blank one is refused', async () => {
    const id = await sendOk(agency, { body: '   ', versions: [soloFile.versionId] });
    const row = await stored(id);
    expect(row.body).toBe('');
    expect(row.attachment_asset_ids).toEqual([soloFile.versionId]);
    expect(
      await countWhere(g, 'asset_attachments', [
        ['entity_type', 'plan_item_comment'],
        ['entity_id', id],
        ['asset_version_id', soloFile.versionId],
        ['asset_id', soloFile.assetId],
      ]),
    ).toBe(1);

    const blank = await send(agency, { body: '  ', versions: [] });
    expect(blank.error?.message).toMatch(/invalid_payload/);
  });

  it('a reply notifies only the thread writers and the mentioned', async () => {
    const main = await sendOk(agency, { visibility: 'everyone' });
    await sendOk(writerB, { parent: main });
    const reply = await sendOk(agency, {
      parent: main,
      body: `@[${mentioned.id}] have a look`,
    });

    expect(await inboxCount(writerB, 'plan_comment', reply)).toBe(1);
    const writerRow = await g
      .from('inbox_entries')
      .select('payload')
      .eq('user_id', writerB.id)
      .eq('event_type', 'plan_comment')
      .eq('payload->>comment_id', reply);
    if (writerRow.error !== null) throw new Error(`inbox read failed: ${writerRow.error.message}`);
    const rows = writerRow.data as Array<{ payload: { root_comment_id?: string } }>;
    expect(rows[0]?.payload.root_comment_id).toBe(main);

    expect(await inboxCount(mentioned, 'mention', reply)).toBe(1);
    expect(await inboxCount(mentioned, 'plan_comment', reply)).toBe(0);

    // Never wrote in the thread and not mentioned: nothing for this reply. The
    // actor gets no row for their own reply either.
    for (const user of [bystander, owner, approver, agency]) {
      expect(
        await countWhere(g, 'inbox_entries', [
          ['user_id', user.id],
          ['payload->>comment_id', reply],
        ]),
      ).toBe(0);
    }
  });

  it('thread_read_set refuses a hidden comment and writes the own read row', async () => {
    const teamMain = await sendOk(agency, { visibility: 'team' });
    const hidden = await as(approver).rpc(
      'plan_item_comment_thread_read_set',
      rpcArgs({ p_root_id: teamMain, p_trace_id: uuidv7() }),
    );
    expect(hidden.error?.message).toMatch(/comment not found/);
    expect(
      await visibleRowCount(asGeneric(as(approver)), 'plan_item_comment_thread_reads', [
        ['root_comment_id', teamMain],
      ]),
    ).toBe(0);

    const openMain = await sendOk(agency, { visibility: 'everyone' });
    await sendOk(writerB, { parent: openMain });
    const ok = await as(approver).rpc(
      'plan_item_comment_thread_read_set',
      rpcArgs({ p_root_id: openMain, p_trace_id: uuidv7() }),
    );
    expect(ok.error).toBeNull();
    expect(
      await ownReadCount(asGeneric(as(approver)), 'plan_item_comment_thread_reads', [
        ['root_comment_id', openMain],
        ['user_id', approver.id],
      ]),
    ).toBe(1);
    // Own rows only: another member's read point stays out of sight.
    expect(
      await visibleRowCount(asGeneric(as(agency)), 'plan_item_comment_thread_reads', [
        ['root_comment_id', openMain],
        ['user_id', approver.id],
      ]),
    ).toBe(0);
  });
});
