// DB-backed coverage for the approved-post lock (migration
// 20261023120000_post_approved_lock.sql). On a post with stage='approved',
// post_caption_update, gallery_set, post_version_create and post_update (title
// or owner) raise 'post_approved_locked'; target_date and bucket still update,
// and a draft still edits. Gated like ready-notify.test.ts: runs when the
// comments/rls stack is up or POSTS_DB_SUITE=1.

import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  randomSuffix,
  rlsEnvFile,
  seedAsset,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type SeededAsset,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import { setup as bringUpStack, teardown as tearDownStack } from '../rls/setup';

const stackAlreadyUp = existsSync(rlsEnvFile);
const SELF_MANAGED = process.env.POSTS_DB_SUITE === '1' && !stackAlreadyUp;
const DB_AVAILABLE = stackAlreadyUp || process.env.POSTS_DB_SUITE === '1';

type Db = SupabaseClient<Database>;

const LOCKED = 'post_approved_locked';

interface PostRow {
  title: string;
  caption: string | null;
  owner_user_id: string | null;
  target_date: string | null;
  bucket_id: string | null;
}

describe.runIf(DB_AVAILABLE)('approved-post lock (authenticated role)', () => {
  let admin: Db;
  let owner: SeededUser;
  let other: SeededUser;
  let ws: SeededWorkspace;
  let ctx: Ctx;
  let ownerClient: Db;
  let asset: SeededAsset;
  let otherBucketId: string;

  async function insertPost(stage: string): Promise<string> {
    const g = asGeneric(admin);
    const row = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: 'Locked post',
      caption: 'Original caption',
      bucket_id: ctx.bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: owner.id,
      stage,
    });
    return String(row.id);
  }

  async function readPost(postId: string): Promise<PostRow> {
    const res = await admin
      .from('posts')
      .select('title, caption, owner_user_id, target_date, bucket_id')
      .eq('id', postId)
      .single();
    if (res.error) throw new Error(`posts read failed: ${res.error.message}`);
    return res.data as PostRow;
  }

  function captionUpdate(postId: string, caption: string) {
    const args = {
      p_post_id: postId,
      p_caption: caption,
      p_trace_id: generateTraceId(),
    };
    return ownerClient.rpc('post_caption_update', args);
  }

  function postUpdate(postId: string, payload: Record<string, unknown>) {
    const args = {
      p_post_id: postId,
      p_payload: payload as Database['public']['Functions']['post_update']['Args']['p_payload'],
      p_trace_id: generateTraceId(),
    };
    return ownerClient.rpc('post_update', args);
  }

  function gallerySet(postId: string, versionIds: string[]) {
    const args = {
      p_post_id: postId,
      p_asset_version_ids: versionIds,
      p_trace_id: generateTraceId(),
    };
    return ownerClient.rpc('gallery_set', args);
  }

  function versionCreate(postId: string) {
    const args = {
      p_post_id: postId,
      p_snapshot: { caption: `snap ${randomSuffix()}` },
      p_trace_id: generateTraceId(),
    };
    return ownerClient.rpc('post_version_create', args);
  }

  beforeAll(async () => {
    if (SELF_MANAGED) await bringUpStack();
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    owner = await seedUser(env, admin);
    other = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Lock ${owner.email}`);
    ctx = await seedScaffold(admin, ws);
    ownerClient = clientFor(owner.id);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: ws.id,
      user_id: other.id,
      role: 'agency',
      active: true,
      accepted_at: new Date().toISOString(),
    });
    asset = await seedAsset(asGeneric(admin), ws.id, owner.id);
    const bucket = await insertRow(asGeneric(admin), 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#445566',
    });
    otherBucketId = String(bucket.id);
  }, 300_000);

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, other]);
    if (SELF_MANAGED) await tearDownStack();
  }, 120_000);

  it('rejects a caption edit on an approved post', async () => {
    const postId = await insertPost('approved');
    const { error } = await captionUpdate(postId, 'New caption');
    expect(error?.message).toBe(LOCKED);
    expect((await readPost(postId)).caption).toBe('Original caption');
  }, 30_000);

  it('rejects a title edit on an approved post', async () => {
    const postId = await insertPost('approved');
    const { error } = await postUpdate(postId, { title: 'New title' });
    expect(error?.message).toBe(LOCKED);
    expect((await readPost(postId)).title).toBe('Locked post');
  }, 30_000);

  it('rejects an owner change on an approved post', async () => {
    const postId = await insertPost('approved');
    const { error } = await postUpdate(postId, { owner_user_id: other.id });
    expect(error?.message).toBe(LOCKED);
    expect((await readPost(postId)).owner_user_id).toBe(owner.id);
  }, 30_000);

  it('rejects a picture change on an approved post (gallery_set and post_version_create)', async () => {
    const postId = await insertPost('approved');
    const gallery = await gallerySet(postId, [asset.versionId]);
    expect(gallery.error?.message).toBe(LOCKED);
    const version = await versionCreate(postId);
    expect(version.error?.message).toBe(LOCKED);
  }, 30_000);

  it('still updates target_date and bucket on an approved post', async () => {
    const postId = await insertPost('approved');
    const { error } = await postUpdate(postId, {
      target_date: '2026-11-02T00:00:00.000Z',
      bucket_id: otherBucketId,
    });
    expect(error).toBeNull();
    const row = await readPost(postId);
    expect(row.bucket_id).toBe(otherBucketId);
    expect(row.target_date?.slice(0, 10)).toBe('2026-11-02');
  }, 30_000);

  it('a draft still edits caption, title, owner and pictures', async () => {
    const postId = await insertPost('draft');
    expect((await captionUpdate(postId, 'Draft caption')).error).toBeNull();
    expect(
      (await postUpdate(postId, { title: 'Draft title', owner_user_id: other.id })).error,
    ).toBeNull();
    expect((await gallerySet(postId, [asset.versionId])).error).toBeNull();
    const row = await readPost(postId);
    expect(row.caption).toBe('Draft caption');
    expect(row.title).toBe('Draft title');
    expect(row.owner_user_id).toBe(other.id);
  }, 30_000);
});
