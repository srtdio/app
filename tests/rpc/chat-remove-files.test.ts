// chat_message_remove_files(p_channel_id, p_message_ids, p_asset_ids, p_trace_id)
// (20261025120000_chat_remove_files.sql), exercised as the AUTHENTICATED role.
// The sender takes their own files off their messages while the text stays:
// the attachment ids and their attachment_meta entries are pruned, the per-kind
// counts land in removed_files, and a message left with nothing becomes a
// tombstone. Another member's files, voice notes (audio/* in attachment_meta)
// and marked messages are refused 'only your own files can be removed'; a
// non-member is 'not a member of this chat'; more than 100 ids is refused.
//
// The service-role admin client only seeds members, channels, assets, messages
// and marks, and reads rows back. Every case seeds its own message.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  seedAsset,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededAsset,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

type RemoveArgs = Database['public']['Functions']['chat_message_remove_files']['Args'];

interface MessageRow {
  body: string | null;
  attachment_asset_ids: string[] | null;
  attachment_meta: Record<string, { mime?: string; name?: string }> | null;
  removed_files: Record<string, number>;
  deleted_at: string | null;
}

interface AssetRow {
  deleted_at: string | null;
  purge_requested_at: string | null;
}

function removeArgs(channelId: string, messageIds: string[], assetIds: string[]): RemoveArgs {
  return {
    p_channel_id: channelId,
    p_message_ids: messageIds,
    p_asset_ids: assetIds,
    p_trace_id: generateTraceId(),
  };
}

describe.runIf(RPC_SUITE)('chat_message_remove_files (authenticated role)', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let sender: SeededUser;
  let peer: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let dmChannelId: string;

  interface SeededFile extends SeededAsset {
    mime: string;
  }

  async function seedFile(owner: SeededUser, mime: string): Promise<SeededFile> {
    const asset = await seedAsset(g, ws.id, owner.id, 'chat');
    return { ...asset, mime };
  }

  // One message by `from` carrying these files (attachment ids are version ids,
  // as chat_message_send records them), with their mimes in attachment_meta.
  async function seedMessage(
    from: SeededUser,
    files: SeededFile[],
    body: string | null = 'caption',
  ): Promise<string> {
    const id = crypto.randomUUID();
    const meta: Record<string, { name: string; mime: string }> = {};
    for (const f of files) meta[f.versionId] = { name: `file-${f.versionId}`, mime: f.mime };
    await insertRow(g, 'chat_messages', {
      id,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      sender_user_id: from.id,
      body,
      attachment_asset_ids: files.map((f) => f.versionId),
      attachment_meta: meta,
      agora_event_id: null,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async function messageRow(id: string): Promise<MessageRow> {
    const res = await g
      .from('chat_messages')
      .select('body, attachment_asset_ids, attachment_meta, removed_files, deleted_at')
      .eq('id', id);
    if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
    const rows = (res.data as MessageRow[] | null) ?? [];
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new Error(`expected one row for ${id}`);
    return row;
  }

  // The assets row behind an attachment (version) id.
  async function assetRow(file: SeededAsset): Promise<AssetRow> {
    const res = await g
      .from('assets')
      .select('deleted_at, purge_requested_at')
      .eq('id', file.assetId);
    if (res.error) throw new Error(`assets read failed: ${res.error.message}`);
    const row = ((res.data as AssetRow[] | null) ?? [])[0];
    if (row === undefined) throw new Error(`no assets row for ${file.assetId}`);
    return row;
  }

  function remove(
    as: SeededUser,
    messageIds: string[],
    files: SeededAsset[],
  ): PromiseLike<{ error: { message: string } | null }> {
    return clientFor(as.id).rpc(
      'chat_message_remove_files',
      removeArgs(
        dmChannelId,
        messageIds,
        files.map((f) => f.versionId),
      ),
    );
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    sender = await seedUser(env, admin);
    peer = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, sender, `Remove files ${sender.email}`);
    await seedMember(g, ws, peer, 'agency');
    await seedMember(g, ws, outsider, 'agency');
    dmChannelId = await seedDmChannel(g, ws.id, sender, peer);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [sender, peer, outsider]);
  });

  it('removes own files, prunes ids and meta, counts kinds and keeps the text', async () => {
    const p1 = await seedFile(sender, 'image/png');
    const p2 = await seedFile(sender, 'image/jpeg');
    const v1 = await seedFile(sender, 'video/mp4');
    const f1 = await seedFile(sender, 'application/pdf');
    const kept = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [p1, v1, kept, p2, f1]);

    const res = await remove(sender, [id], [p1, p2, v1, f1]);
    expect(res.error).toBeNull();

    const row = await messageRow(id);
    expect(row.deleted_at).toBeNull();
    expect(row.body).toBe('caption');
    expect(row.attachment_asset_ids).toEqual([kept.versionId]);
    expect(Object.keys(row.attachment_meta ?? {})).toEqual([kept.versionId]);
    expect(row.removed_files).toEqual({ photo: 2, video: 1, file: 1 });
  });

  it('adds to the counts on a second removal from the same message', async () => {
    const a = await seedFile(sender, 'image/png');
    const b = await seedFile(sender, 'image/png');
    const c = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [a, b, c]);
    expect((await remove(sender, [id], [a])).error).toBeNull();
    expect((await remove(sender, [id], [b])).error).toBeNull();
    const row = await messageRow(id);
    expect(row.attachment_asset_ids).toEqual([c.versionId]);
    expect(row.removed_files).toEqual({ photo: 2 });
  });

  it("refuses another member's files and changes nothing", async () => {
    const theirs = await seedFile(peer, 'image/png');
    const id = await seedMessage(peer, [theirs]);
    const res = await remove(sender, [id], [theirs]);
    expect(res.error?.message).toBe('only your own files can be removed');
    const row = await messageRow(id);
    expect(row.attachment_asset_ids).toEqual([theirs.versionId]);
    expect(row.removed_files).toEqual({});
    expect((await assetRow(theirs)).deleted_at).toBeNull();
  });

  it('refuses a mix of own and foreign files as a whole', async () => {
    const own = await seedFile(sender, 'image/png');
    const theirs = await seedFile(peer, 'image/png');
    const ownId = await seedMessage(sender, [own]);
    const theirId = await seedMessage(peer, [theirs]);
    const res = await remove(sender, [ownId, theirId], [own, theirs]);
    expect(res.error?.message).toBe('only your own files can be removed');
    expect((await messageRow(ownId)).attachment_asset_ids).toEqual([own.versionId]);
  });

  it('refuses a voice note', async () => {
    const voice = await seedFile(sender, 'audio/webm');
    const id = await seedMessage(sender, [voice], null);
    const res = await remove(sender, [id], [voice]);
    expect(res.error?.message).toBe('only your own files can be removed');
    const row = await messageRow(id);
    expect(row.deleted_at).toBeNull();
    expect(row.attachment_asset_ids).toEqual([voice.versionId]);
  });

  it('refuses a marked message, even the caller own', async () => {
    const file = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [file]);
    await insertRow(g, 'chat_message_marks', {
      message_id: id,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      mark_type: 'commitment',
      marked_by: peer.id,
    });
    const res = await remove(sender, [id], [file]);
    expect(res.error?.message).toBe('only your own files can be removed');
    expect((await messageRow(id)).attachment_asset_ids).toEqual([file.versionId]);
  });

  it('turns a message left with no files and no text into a tombstone', async () => {
    const only = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [only], null);
    expect((await remove(sender, [id], [only])).error).toBeNull();
    const row = await messageRow(id);
    expect(row.deleted_at).not.toBeNull();
    expect(row.body).toBeNull();
    expect(row.attachment_asset_ids).toBeNull();
    expect(row.attachment_meta).toBeNull();
  });

  it('keeps a message whose last file goes when it has text', async () => {
    const only = await seedFile(sender, 'application/pdf');
    const id = await seedMessage(sender, [only], 'see attached');
    expect((await remove(sender, [id], [only])).error).toBeNull();
    const row = await messageRow(id);
    expect(row.deleted_at).toBeNull();
    expect(row.body).toBe('see attached');
    expect(row.attachment_asset_ids).toBeNull();
    expect(row.attachment_meta).toBeNull();
    expect(row.removed_files).toEqual({ file: 1 });
  });

  it('refuses more than 100 ids and an empty selection', async () => {
    const file = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [file]);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID());
    const tooMany = await clientFor(sender.id).rpc(
      'chat_message_remove_files',
      removeArgs(dmChannelId, [id], many),
    );
    expect(tooMany.error?.message).toBe('select between 1 and 100 files');
    const empty = await clientFor(sender.id).rpc(
      'chat_message_remove_files',
      removeArgs(dmChannelId, [id], []),
    );
    expect(empty.error?.message).toBe('select between 1 and 100 files');
    expect((await messageRow(id)).attachment_asset_ids).toEqual([file.versionId]);
  });

  it('refuses a non-member of the chat', async () => {
    const file = await seedFile(sender, 'image/png');
    const id = await seedMessage(sender, [file]);
    const res = await remove(outsider, [id], [file]);
    expect(res.error?.message).toBe('not a member of this chat');
    expect((await messageRow(id)).attachment_asset_ids).toEqual([file.versionId]);
  });
});
