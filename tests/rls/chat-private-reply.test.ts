// Reply privately (20261102130000_chat_private_reply.sql): chat_private_reply_send
// sends a DM that quotes someone's words and stores a snapshot of the source in
// chat_messages.private_reply. Exercised as the AUTHENTICATED role:
//
//   R1. A channel that is not a DM is refused ('private reply needs a direct chat').
//   R2. A DM that is not between the caller and the source's author is refused
//       ('private reply must go to the author').
//   R3. A source the caller cannot see is refused ('private reply source not
//       accessible'): a client quoting a comment on a draft post; a client
//       quoting a creators-only ('team') plan item comment, and an 'everyone'
//       comment inside a team (agency-only) plan; a person outside a group
//       quoting that group's message.
//   R4. Quoting your own words is refused ('private reply must go to the author').
//   A1. A group message quoted in the DM with its author: the row stores
//       private_reply {kind, source_id, author_user_id, excerpt, where_label,
//       source_created_at, link}.
//   A2. A review post comment (excerpt capped at 280 characters) and A3. an
//       'everyone' client plan comment, quoted by a client to the agency author.
//
// A refusal writes no chat_messages row. Seeding goes through the service role
// (members, channels, groups, posts, comments, group messages); plans and plan
// comments go through their procs as an agency member (the plan tables grant
// service_role no INSERT). No teardown: this suite runs no DELETE; the fixtures
// live in their own workspace and the container is ephemeral.

import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  clientFor,
  countWhere,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
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

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Rpc = Database['public']['Functions'];
type SendArgs = Rpc['chat_private_reply_send']['Args'];
type MessageRow = Rpc['chat_private_reply_send']['Returns'];

const NEEDS_DM = 'private reply needs a direct chat';
const TO_AUTHOR = 'private reply must go to the author';
const NOT_ACCESSIBLE = 'private reply source not accessible';

interface Sent {
  id: string;
  data: MessageRow | null;
  error: { message: string } | null;
}

/** The snapshot as the server writes it (private_reply jsonb). */
interface Snapshot {
  kind: string;
  source_id: string;
  author_user_id: string;
  excerpt: string;
  where_label: string;
  source_created_at: string | null;
  link: Record<string, string>;
}

function must<T>(proc: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error !== null || res.data === null) {
    throw new Error(`${proc} failed: ${res.error?.message ?? 'no data'}`);
  }
  return res.data;
}

describe.runIf(RLS_SUITE)('chat_private_reply_send (Reply privately)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let ws: SeededWorkspace;
  let groupName: string;
  let groupChannel: string;
  let agencyOwnerDm: string;
  let agencyClientDm: string;
  let clientOwnerDm: string;
  let ownerGroupMessage: string;
  let agencyGroupMessage: string;
  let reviewPostTitle: string;
  let reviewComment: string;
  let reviewPostId: string;
  let draftComment: string;
  let clientPlanId: string;
  let clientConceptId: string;
  let conceptTitle: string;
  let everyoneComment: string;
  let teamComment: string;
  let teamPlanComment: string;

  const longBody = `Swap the cover for the morning shot. ${'x'.repeat(400)}`;

  async function send(
    user: SeededUser,
    channelId: string,
    kind: string,
    sourceId: string,
    body = `reply ${randomSuffix()}`,
  ): Promise<Sent> {
    const id = crypto.randomUUID();
    const args: SendArgs = {
      p_id: id,
      p_channel_id: channelId,
      p_trace_id: uuidv7(),
      p_source_kind: kind,
      p_source_id: sourceId,
      p_body: body,
    };
    const res = await clientFor(user.id).rpc('chat_private_reply_send', args);
    return {
      id,
      data: res.data ?? null,
      error: res.error === null ? null : { message: res.error.message },
    };
  }

  async function expectRefused(outcome: Sent, message: string): Promise<void> {
    expect(outcome.data).toBeNull();
    expect(outcome.error?.message).toBe(message);
    expect(await countWhere(g, 'chat_messages', [['id', outcome.id]])).toBe(0);
  }

  /** The stored private_reply of one message, read back through the service role. */
  async function storedSnapshot(id: string): Promise<Snapshot | null> {
    const res = await admin.from('chat_messages').select('private_reply').eq('id', id);
    if (res.error !== null) throw new Error(`chat_messages read failed: ${res.error.message}`);
    const [row] = res.data;
    if (row === undefined) throw new Error(`no chat_messages row ${id}`);
    return row.private_reply as unknown as Snapshot | null;
  }

  async function seedGroup(
    members: readonly SeededUser[],
  ): Promise<{ channelId: string; name: string }> {
    const name = `Grp ${randomSuffix()}`;
    const group = await insertRow(g, 'groups', { workspace_id: ws.id, name, created_by: owner.id });
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
    return { channelId, name };
  }

  async function seedGroupMessage(
    channelId: string,
    sender: SeededUser,
    body: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(g, 'chat_messages', {
      id,
      channel_id: channelId,
      workspace_id: ws.id,
      sender_user_id: sender.id,
      body,
      agora_event_id: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    return id;
  }

  async function seedPost(bucketId: string, stage: string, title: string): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: owner.id,
    });
    return String(post.id);
  }

  async function seedComment(postId: string, author: SeededUser, body: string): Promise<string> {
    const comment = await insertRow(g, 'comments', {
      workspace_id: ws.id,
      entity_type: 'post',
      entity_id: postId,
      author_user_id: author.id,
      body,
    });
    return String(comment.id);
  }

  async function createPlan(audience: 'team' | 'client'): Promise<string> {
    const args: Rpc['plan_create']['Args'] = {
      p_workspace_id: ws.id,
      p_title: `Plan ${randomSuffix()}`,
      p_starts_on: '2026-11-01',
      p_ends_on: '2026-11-30',
      p_audience: audience,
      p_trace_id: uuidv7(),
    };
    return must('plan_create', await clientFor(agency.id).rpc('plan_create', args));
  }

  async function addConcept(planId: string, title: string): Promise<string> {
    const args: Rpc['plan_concept_add']['Args'] = {
      p_plan_id: planId,
      p_title: title,
      p_description: 'A concept',
      p_attachment_version_ids: [],
      p_trace_id: uuidv7(),
    };
    return must('plan_concept_add', await clientFor(agency.id).rpc('plan_concept_add', args));
  }

  async function planComment(itemId: string, visibility: 'everyone' | 'team'): Promise<string> {
    const args: Rpc['plan_item_comment_create']['Args'] = {
      p_item_id: itemId,
      p_body: `Plan note ${randomSuffix()}`,
      p_visibility: visibility,
      p_trace_id: uuidv7(),
    };
    return must(
      'plan_item_comment_create',
      await clientFor(agency.id).rpc('plan_item_comment_create', args),
    );
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Private reply ${owner.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');

    // An agency-only group: the owner and the agency member, not the client.
    const group = await seedGroup([owner, agency]);
    groupChannel = group.channelId;
    groupName = group.name;
    ownerGroupMessage = await seedGroupMessage(groupChannel, owner, 'Can we tighten the hook?');
    agencyGroupMessage = await seedGroupMessage(groupChannel, agency, 'Pushing a new version.');

    agencyOwnerDm = await seedDmChannel(g, ws.id, agency, owner);
    agencyClientDm = await seedDmChannel(g, ws.id, agency, client);
    clientOwnerDm = await seedDmChannel(g, ws.id, client, owner);

    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    reviewPostTitle = `Review ${randomSuffix()}`;
    reviewPostId = await seedPost(String(bucket.id), 'review', reviewPostTitle);
    const draftPostId = await seedPost(String(bucket.id), 'draft', `Draft ${randomSuffix()}`);
    reviewComment = await seedComment(reviewPostId, agency, longBody);
    draftComment = await seedComment(draftPostId, agency, 'Draft caption note');

    clientPlanId = await createPlan('client');
    conceptTitle = `Concept ${randomSuffix()}`;
    clientConceptId = await addConcept(clientPlanId, conceptTitle);
    everyoneComment = await planComment(clientConceptId, 'everyone');
    teamComment = await planComment(clientConceptId, 'team');
    const teamPlanId = await createPlan('team');
    const teamConceptId = await addConcept(teamPlanId, `Team concept ${randomSuffix()}`);
    teamPlanComment = await planComment(teamConceptId, 'everyone');
  });

  it('R1: a group channel is not a direct chat', async () => {
    await expectRefused(await send(agency, groupChannel, 'chat', ownerGroupMessage), NEEDS_DM);
  });

  it('R2: a DM with someone other than the author is refused', async () => {
    // Owner wrote it; the agency member sends it to the client.
    await expectRefused(await send(agency, agencyClientDm, 'chat', ownerGroupMessage), TO_AUTHOR);
  });

  it('R3a: a client cannot quote a comment on a draft post', async () => {
    await expectRefused(
      await send(client, agencyClientDm, 'comment', draftComment),
      NOT_ACCESSIBLE,
    );
  });

  it("R3b: a client cannot quote a creators-only ('team') plan comment", async () => {
    await expectRefused(
      await send(client, agencyClientDm, 'plan_comment', teamComment),
      NOT_ACCESSIBLE,
    );
  });

  it('R3c: a client cannot quote a comment inside a team (agency-only) plan', async () => {
    await expectRefused(
      await send(client, agencyClientDm, 'plan_comment', teamPlanComment),
      NOT_ACCESSIBLE,
    );
  });

  it('R3d: a person outside the group cannot quote its message', async () => {
    await expectRefused(
      await send(client, clientOwnerDm, 'chat', ownerGroupMessage),
      NOT_ACCESSIBLE,
    );
  });

  it('R3e: an unknown kind or a missing source is not accessible', async () => {
    await expectRefused(
      await send(agency, agencyOwnerDm, 'brief', ownerGroupMessage),
      NOT_ACCESSIBLE,
    );
    await expectRefused(
      await send(agency, agencyOwnerDm, 'chat', crypto.randomUUID()),
      NOT_ACCESSIBLE,
    );
  });

  it('R4: quoting your own words is refused', async () => {
    await expectRefused(await send(agency, agencyOwnerDm, 'chat', agencyGroupMessage), TO_AUTHOR);
  });

  it('A1: a group message quoted to its author stores the chat snapshot', async () => {
    const outcome = await send(agency, agencyOwnerDm, 'chat', ownerGroupMessage, 'Agreed, on it.');
    expect(outcome.error).toBeNull();
    const row = must('chat_private_reply_send', outcome);
    expect(row.id).toBe(outcome.id);
    expect(row.channel_id).toBe(agencyOwnerDm);
    expect(row.sender_user_id).toBe(agency.id);
    expect(row.body).toBe('Agreed, on it.');
    const expected = {
      kind: 'chat',
      source_id: ownerGroupMessage,
      author_user_id: owner.id,
      excerpt: 'Can we tighten the hook?',
      where_label: groupName,
      link: { channel_id: groupChannel, message_id: ownerGroupMessage },
    };
    expect(row.private_reply).toMatchObject(expected);
    const stored = await storedSnapshot(outcome.id);
    expect(stored).toMatchObject(expected);
    expect(typeof stored?.source_created_at).toBe('string');
  });

  it('A2: a client quotes a review post comment; the excerpt is capped at 280', async () => {
    const outcome = await send(client, agencyClientDm, 'comment', reviewComment);
    expect(outcome.error).toBeNull();
    const stored = await storedSnapshot(outcome.id);
    expect(stored).toMatchObject({
      kind: 'comment',
      source_id: reviewComment,
      author_user_id: agency.id,
      excerpt: longBody.slice(0, 280),
      where_label: reviewPostTitle,
      link: { entity_type: 'post', entity_id: reviewPostId, comment_id: reviewComment },
    });
    expect(stored?.excerpt).toHaveLength(280);
  });

  it("A3: a client quotes an 'everyone' client plan comment", async () => {
    const outcome = await send(client, agencyClientDm, 'plan_comment', everyoneComment);
    expect(outcome.error).toBeNull();
    const stored = await storedSnapshot(outcome.id);
    expect(stored).toMatchObject({
      kind: 'plan_comment',
      source_id: everyoneComment,
      author_user_id: agency.id,
      where_label: conceptTitle,
      link: { plan_id: clientPlanId, item_id: clientConceptId, comment_id: everyoneComment },
    });
  });

  it('A4: the agency side may quote a creators-only plan comment to its author', async () => {
    // The owner reads 'team' comments; the agency member wrote it.
    const outcome = await send(owner, agencyOwnerDm, 'plan_comment', teamComment);
    expect(outcome.error).toBeNull();
    expect((await storedSnapshot(outcome.id))?.source_id).toBe(teamComment);
  });

  it('the recipient reads the quote on the DM row', async () => {
    const outcome = await send(agency, agencyOwnerDm, 'chat', ownerGroupMessage);
    expect(outcome.error).toBeNull();
    const res = await clientFor(owner.id)
      .from('chat_messages')
      .select('id, private_reply')
      .eq('id', outcome.id);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0]?.private_reply).toMatchObject({
      kind: 'chat',
      source_id: ownerGroupMessage,
    });
  });
});
