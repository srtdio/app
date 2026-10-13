// asset_renditions has no client read path
// (20261013160000_asset_renditions_grants_indexes.sql, recording live state).
// Thumbnails are written by the asset-upload Worker and read by asset-read,
// both through the service role. An authenticated workspace member (owner or
// client) must read nothing from the table, and cannot write to it either;
// the service role reads and inserts. Service-role counts are the ground truth
// that the seeded row exists, so a 0 is a real deny.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  randomSha256,
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

describe.runIf(RLS_SUITE)('asset_renditions: service role only, no client SELECT', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let member: SeededUser;
  let ws: SeededWorkspace;
  let asset: SeededAsset;
  let renditionId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    member = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Renditions ${owner.email}`);
    await seedMember(g, ws, member, 'client');
    asset = await seedAsset(g, ws.id, owner.id, 'library');
    const row = await insertRow(g, 'asset_renditions', {
      asset_version_id: asset.versionId,
      workspace_id: ws.id,
      role: 'thumbnail',
      r2_key: `pdf/${asset.assetId}/v1-thumb-${crypto.randomUUID()}.jpg`,
      mime_type: 'image/jpeg',
      sha256: randomSha256(),
      size_bytes: 1024,
      width: 580,
      height: 750,
    });
    renditionId = String(row.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, member]);
  });

  it('the service role inserts and reads a rendition (ground truth)', async () => {
    expect(await countWhere(g, 'asset_renditions', [['id', renditionId]])).toBe(1);
  });

  it('a second thumbnail for the same version conflicts (one per version and role)', async () => {
    const res = await g.from('asset_renditions').insert({
      asset_version_id: asset.versionId,
      workspace_id: ws.id,
      role: 'thumbnail',
      r2_key: `pdf/${asset.assetId}/v1-thumb-${crypto.randomUUID()}.jpg`,
      mime_type: 'image/jpeg',
      sha256: randomSha256(),
      size_bytes: 1024,
    });
    expect(res.error).not.toBeNull();
    expect(await countWhere(g, 'asset_renditions', [['asset_version_id', asset.versionId]])).toBe(
      1,
    );
  });

  it('an authenticated member cannot SELECT it (owner and client alike)', async () => {
    for (const user of [owner, member]) {
      const client = asGeneric(clientFor(user.id));
      expect(await visibleRowCount(client, 'asset_renditions', [['id', renditionId]])).toBe(0);
      const listing = await client.from('asset_renditions').select('id').eq('workspace_id', ws.id);
      // Denied outright at the grant level, or at least nothing comes back.
      const rows = Array.isArray(listing.data) ? listing.data : [];
      expect(listing.error !== null || rows.length === 0).toBe(true);
    }
  });

  it('an authenticated member cannot INSERT a rendition', async () => {
    const client = asGeneric(clientFor(owner.id));
    const res = await client.from('asset_renditions').insert({
      asset_version_id: asset.versionId,
      workspace_id: ws.id,
      role: 'preview',
      r2_key: `pdf/${asset.assetId}/v1-preview-${crypto.randomUUID()}.jpg`,
      mime_type: 'image/jpeg',
      sha256: randomSha256(),
      size_bytes: 1024,
    });
    expect(res.error).not.toBeNull();
    expect(await countWhere(g, 'asset_renditions', [['role', 'preview']])).toBe(0);
  });
});
