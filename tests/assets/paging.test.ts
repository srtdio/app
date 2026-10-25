// Keyset paging of the Assets library against a real local Postgres + PostgREST
// (the RLS suite's ephemeral container; never the live database). Seeds 250
// library assets in workspace A, 20 of them sharing one uploaded_at that
// straddles the 100-row page boundary, pages through listAssetsPage as a member
// of A to the end and asserts the exact server order: no duplicate, no gap, 250
// in all. A second workspace's assets never appear, in the pages, the server
// totals or Select all's id read, for a caller who belongs to A only. Seeding is
// service-role, as in the rest of the suites.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  randomSha256,
  seedMember,
  seedUser,
  seedWorkspace,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  ASSETS_PAGE_SIZE,
  countAssetTabs,
  listAssetIds,
  listAssetsPage,
  type AssetCursor,
} from '../../src/lib/assets';

const ASSETS_SUITE = process.env.ASSETS_SUITE === '1';

const TOTAL = 250;
const TIED = 20;
/** Sorted positions [TIE_START, TIE_START + TIED) share one instant, across the page edge at 100. */
const TIE_START = 90;
/** How many of A's assets get an image version, for the Media tab total. */
const WITH_IMAGE = 10;
const B_TOTAL = 15;

const BASE_MS = Date.parse('2026-10-01T12:00:00.000Z');

function at(index: number): string {
  return new Date(BASE_MS - index * 1000).toISOString();
}

interface SeededRow {
  id: string;
  uploaded_at: string;
}

async function seedLibrary(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  uploadedBy: string,
  count: number,
  uploadedAt: (index: number) => string,
): Promise<SeededRow[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    workspace_id: workspaceId,
    filename: `file-${String(i).padStart(3, '0')}.png`,
    uploaded_by: uploadedBy,
    uploaded_at: uploadedAt(i),
    origin: 'library' as const,
  }));
  const res = await admin.from('assets').insert(rows).select('id, uploaded_at');
  if (res.error) throw new Error(`assets insert failed: ${res.error.message}`);
  const inserted = res.data as SeededRow[] | null;
  if (!inserted || inserted.length !== count)
    throw new Error('assets insert returned too few rows');
  return inserted;
}

/** The server order: uploaded_at desc, then id desc (uuid order is lowercase text order). */
function serverOrder(rows: readonly SeededRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const byTime = Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at);
      if (byTime !== 0) return byTime;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map((row) => row.id);
}

describe.runIf(ASSETS_SUITE)('listAssetsPage keyset paging (250 assets, tied upload times)', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let member: SeededUser;
  let otherOwner: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let seededA: SeededRow[] = [];
  let seededB: SeededRow[] = [];

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    const g = asGeneric(admin);
    owner = await seedUser(env, admin);
    member = await seedUser(env, admin);
    otherOwner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Paging A ${owner.email}`);
    wsB = await seedWorkspace(admin, otherOwner, `Paging B ${otherOwner.email}`);
    // The caller belongs to A only.
    await seedMember(g, wsA, member, 'agency');

    const tieAt = at(TIE_START);
    seededA = await seedLibrary(admin, wsA.id, owner.id, TOTAL, (i) =>
      i >= TIE_START && i < TIE_START + TIED ? tieAt : at(i),
    );
    // B's uploads interleave A's in time, so a leak would land mid-page.
    seededB = await seedLibrary(admin, wsB.id, otherOwner.id, B_TOTAL, (i) => at(i * 10 + 5));

    // A few of A's assets get a current image version, for the Media total.
    for (const row of seededA.slice(0, WITH_IMAGE)) {
      const version = await admin
        .from('asset_versions')
        .insert({
          asset_id: row.id,
          workspace_id: wsA.id,
          version_number: 1,
          kind: 'image',
          r2_key: `key/${crypto.randomUUID()}`,
          mime_type: 'image/png',
          sha256: randomSha256(),
          size_bytes: 1,
          uploaded_by: owner.id,
        })
        .select('id');
      if (version.error) throw new Error(`asset_versions insert failed: ${version.error.message}`);
      const versionId = (version.data as Array<{ id: string }> | null)?.[0]?.id;
      if (!versionId) throw new Error('asset_versions insert returned no row');
      const pin = await admin
        .from('assets')
        .update({ current_version_id: versionId })
        .eq('id', row.id);
      if (pin.error) throw new Error(`assets update failed: ${pin.error.message}`);
    }
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, member, otherOwner]);
  });

  it('seeds 20 rows on one instant, across the first page edge', () => {
    const tieAt = Date.parse(at(TIE_START));
    expect(seededA.filter((row) => Date.parse(row.uploaded_at) === tieAt)).toHaveLength(TIED);
    expect(TIE_START).toBeLessThan(ASSETS_PAGE_SIZE);
    expect(TIE_START + TIED).toBeGreaterThan(ASSETS_PAGE_SIZE);
  });

  it('pages to the end with no duplicate, no gap, 250 in the server order', async () => {
    const client = clientFor(member.id);
    const seen: string[] = [];
    let cursor: AssetCursor | undefined;
    let pages = 0;
    for (;;) {
      const page = await listAssetsPage(client, wsA.id, cursor);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      pages += 1;
      expect(page.data.items.length).toBeLessThanOrEqual(ASSETS_PAGE_SIZE);
      seen.push(...page.data.items.map((item) => item.id));
      if (page.data.next.done) break;
      cursor = page.data.next.cursor;
      // A runaway loop would mean the cursor never advances.
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(Math.ceil(TOTAL / ASSETS_PAGE_SIZE));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(TOTAL);
    expect(seen).toEqual(serverOrder(seededA));
  });

  it("never returns workspace B's assets to a member of A only", async () => {
    const client = clientFor(member.id);
    const bIds = new Set(seededB.map((row) => row.id));

    // Asking for B outright: RLS gives nothing back.
    const direct = await listAssetsPage(client, wsB.id);
    expect(direct.ok && direct.data.items).toEqual([]);

    // Paging A never picks up a B row, even with B's uploads interleaved.
    let cursor: AssetCursor | undefined;
    for (;;) {
      const page = await listAssetsPage(client, wsA.id, cursor);
      if (!page.ok) throw new Error(page.error.message);
      expect(page.data.items.some((item) => bIds.has(item.id))).toBe(false);
      if (page.data.next.done) break;
      cursor = page.data.next.cursor;
    }

    // Service-role ground truth: B's rows exist, so the zeros above are RLS.
    const truth = await asGeneric(admin)
      .from('assets')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsB.id);
    expect(truth.count).toBe(B_TOTAL);
  });

  it('server totals and Select all match the seeded rows, per workspace', async () => {
    const client = clientFor(member.id);

    const countsA = await countAssetTabs(client, wsA.id);
    expect(countsA.ok && countsA.data.all).toBe(TOTAL);
    expect(countsA.ok && countsA.data.media).toBe(WITH_IMAGE);
    expect(countsA.ok && countsA.data.pdf).toBe(0);

    const countsB = await countAssetTabs(client, wsB.id);
    expect(countsB.ok && countsB.data.all).toBe(0);

    const idsA = await listAssetIds(client, wsA.id, 'all');
    expect(idsA.ok && idsA.data).toEqual(serverOrder(seededA));
    const mediaA = await listAssetIds(client, wsA.id, 'media');
    expect(mediaA.ok && [...mediaA.data].sort()).toEqual(
      seededA
        .slice(0, WITH_IMAGE)
        .map((row) => row.id)
        .sort(),
    );

    const idsB = await listAssetIds(client, wsB.id, 'all');
    expect(idsB.ok && idsB.data).toEqual([]);
  });
});
