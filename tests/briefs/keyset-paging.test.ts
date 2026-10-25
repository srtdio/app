// Keyset paging and chip counts for the Briefs list (src/lib/brief-list.ts
// listBriefsPage, src/lib/brief-counts.ts countBriefsByFilter) against the local,
// ephemeral Supabase stack. The service role seeds fixtures in bulk (briefs are
// read-only once created, so rows are inserted complete, each with its own
// per-workspace number from workspace_counters); every read runs as an
// authenticated member under RLS.
//
// Covered: 250 briefs in one workspace with 20 sharing an identical created_at
// (straddling the page-1/page-2 boundary) page through to the end with no
// duplicates and no gaps; another workspace's briefs never appear, both for a
// member of workspace A only (RLS) and for a member of both (the workspace_id
// filter); deleted briefs are skipped; the chip counts are the true totals.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import type { Client } from '../../packages/rpc/src/index';
import { BRIEF_LIST_PAGE_SIZE, listBriefsPage, type BriefCursor } from '../../src/lib/brief-list';
import { countBriefsByFilter } from '../../src/lib/brief-counts';

const BRIEFS_SUITE = process.env.BRIEFS_SUITE === '1';

const TOTAL_A = 250;
const TIED = 20;
// The tied block covers ranks 90..109 (newest first), so it straddles the
// first page boundary at BRIEF_LIST_PAGE_SIZE (100).
const TIE_FIRST_RANK = 90;
const CLOSED_EVERY = 5;
const DELETED_A = 5;
const TOTAL_B = 30;

const BASE_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const MINUTE = 60_000;

/** created_at for the brief at `rank` (0 = newest): one minute apart except the tied block. */
function createdAtForRank(rank: number): string {
  const tied = rank >= TIE_FIRST_RANK && rank < TIE_FIRST_RANK + TIED;
  return new Date(BASE_MS - (tied ? TIE_FIRST_RANK : rank) * MINUTE).toISOString();
}

/**
 * Reserve `count` consecutive entity numbers from the workspace counter, the
 * way nextEntityNumber does for one, so the bulk insert respects the
 * (workspace_id, number) uniqueness.
 */
async function reserveNumbers(g: GenericClient, workspaceId: string, count: number) {
  const read = await g
    .from('workspace_counters')
    .select('next_entity_number')
    .eq('workspace_id', workspaceId);
  if (read.error) throw new Error(`workspace_counters read failed: ${read.error.message}`);
  const rows = read.data as { next_entity_number: number }[] | null;
  const first = rows?.[0]?.next_entity_number;
  if (typeof first !== 'number')
    throw new Error(`workspace_counters row missing for ${workspaceId}`);
  const upd = await g
    .from('workspace_counters')
    .update({ next_entity_number: first + count })
    .eq('workspace_id', workspaceId);
  if (upd.error) throw new Error(`workspace_counters update failed: ${upd.error.message}`);
  return first;
}

async function bulkInsertBriefs(g: GenericClient, rows: Record<string, unknown>[]) {
  const res = await g.from('briefs').insert(rows).select('id');
  if (res.error) throw new Error(`briefs bulk insert failed: ${res.error.message}`);
  const inserted = (res.data as { id: string }[] | null) ?? [];
  if (inserted.length !== rows.length) {
    throw new Error(`briefs bulk insert returned ${inserted.length} of ${rows.length}`);
  }
  return inserted.map((row) => row.id);
}

/** Read every page through listBriefsPage; returns the ids in read order and the page count. */
async function readAllPages(client: Client, workspaceId: string) {
  const ids: string[] = [];
  const workspaces = new Set<string>();
  let cursor: BriefCursor | undefined;
  let pages = 0;
  for (;;) {
    const result = await listBriefsPage(client, workspaceId, cursor);
    if (!result.ok) throw new Error(`listBriefsPage failed: ${result.error.message}`);
    pages += 1;
    expect(result.data.items.length).toBeLessThanOrEqual(BRIEF_LIST_PAGE_SIZE);
    for (const brief of result.data.items) {
      ids.push(brief.id);
      workspaces.add(brief.workspace_id);
    }
    if (result.data.next.done) break;
    cursor = result.data.next.cursor;
    if (pages > 10) throw new Error('paging did not terminate');
  }
  return { ids, pages, workspaces };
}

describe.runIf(BRIEFS_SUITE)('briefs list keyset paging and counts', () => {
  let admin: SupabaseClient<Database>;
  let ownerA: SeededUser;
  let ownerB: SeededUser;
  let memberA: SeededUser;
  let memberBoth: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  // Ground truth: the live ids of workspace A, newest first.
  let expectedA: string[] = [];
  let deletedA: string[] = [];
  let idsB: string[] = [];

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    const g = asGeneric(admin);

    ownerA = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, ownerA, `Paging A ${ownerA.email}`);
    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `Paging B ${ownerB.email}`);

    memberA = await seedUser(env, admin);
    await seedMember(g, wsA, memberA, 'client');
    memberBoth = await seedUser(env, admin);
    await seedMember(g, wsA, memberBoth, 'agency');
    await seedMember(g, wsB, memberBoth, 'agency');

    const firstA = await reserveNumbers(g, wsA.id, TOTAL_A + DELETED_A);
    const liveRows = Array.from({ length: TOTAL_A }, (_, rank) => {
      const closed = rank % CLOSED_EVERY === 0;
      return {
        workspace_id: wsA.id,
        number: firstA + rank,
        title: `Paging brief ${rank}`,
        objective: 'Objective',
        created_by: ownerA.id,
        created_at: createdAtForRank(rank),
        ...(closed
          ? { status: 'closed', closed_at: createdAtForRank(rank), closed_by: ownerA.id }
          : {}),
      };
    });
    const liveIds = await bulkInsertBriefs(g, liveRows);

    // Deleted rows sit inside the tied instant too: they must never be read.
    const deletedRows = Array.from({ length: DELETED_A }, (_, index) => ({
      workspace_id: wsA.id,
      number: firstA + TOTAL_A + index,
      title: `Deleted brief ${index}`,
      objective: 'Objective',
      created_by: ownerA.id,
      created_at: createdAtForRank(TIE_FIRST_RANK),
      deleted_at: createdAtForRank(0),
    }));
    deletedA = await bulkInsertBriefs(g, deletedRows);

    // Workspace B interleaves with A's timeline, including the tied instant.
    const firstB = await reserveNumbers(g, wsB.id, TOTAL_B);
    const rowsB = Array.from({ length: TOTAL_B }, (_, index) => ({
      workspace_id: wsB.id,
      number: firstB + index,
      title: `Other workspace brief ${index}`,
      objective: 'Objective',
      created_by: ownerB.id,
      created_at: createdAtForRank(index * 8),
    }));
    idsB = await bulkInsertBriefs(g, rowsB);

    // Ground truth order from the service role, in the list's own order.
    const truth = await admin
      .from('briefs')
      .select('id')
      .eq('workspace_id', wsA.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (truth.error) throw new Error(`ground truth read failed: ${truth.error.message}`);
    expectedA = (truth.data ?? []).map((row) => row.id);
    expect(new Set(expectedA)).toEqual(new Set(liveIds));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [ownerA, ownerB, memberA, memberBoth]);
  });

  it('seeds 20 briefs on one identical created_at', async () => {
    const tie = createdAtForRank(TIE_FIRST_RANK);
    const res = await admin
      .from('briefs')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsA.id)
      .is('deleted_at', null)
      .eq('created_at', tie);
    expect(res.error).toBeNull();
    expect(res.count).toBe(TIED);
  });

  it('a member of A only pages to the end: 250, no duplicates, no gaps, in order', async () => {
    const { ids, pages, workspaces } = await readAllPages(clientFor(memberA.id), wsA.id);
    expect(pages).toBe(Math.ceil(TOTAL_A / BRIEF_LIST_PAGE_SIZE));
    expect(ids).toHaveLength(TOTAL_A);
    expect(new Set(ids).size).toBe(TOTAL_A);
    // No gaps: exactly the live set, in (created_at desc, id desc) order.
    expect(ids).toEqual(expectedA);
    for (const id of deletedA) expect(ids).not.toContain(id);
    expect([...workspaces]).toEqual([wsA.id]);
    for (const id of idsB) expect(ids).not.toContain(id);
  });

  it('a member of A only reads nothing from B, even when asking for B', async () => {
    const { ids } = await readAllPages(clientFor(memberA.id), wsB.id);
    expect(ids).toEqual([]);
  });

  it('a member of both workspaces still reads only A when paging A', async () => {
    const { ids, workspaces } = await readAllPages(clientFor(memberBoth.id), wsA.id);
    expect(ids).toEqual(expectedA);
    expect([...workspaces]).toEqual([wsA.id]);
    for (const id of idsB) expect(ids).not.toContain(id);
  });

  it('chip counts are the true totals, not one page', async () => {
    const closed = Math.ceil(TOTAL_A / CLOSED_EVERY);
    const result = await countBriefsByFilter(clientFor(memberA.id), wsA.id, '');
    expect(result).toEqual({
      ok: true,
      data: { all: TOTAL_A, open: TOTAL_A - closed, closed },
    });
  });

  it('chip counts apply the title search on the server, literal % included', async () => {
    // "Paging brief 1" matches ranks 1, 10..19, 100..199: 111 briefs.
    const search = await countBriefsByFilter(clientFor(memberA.id), wsA.id, ' paging BRIEF 1 ');
    expect(search.ok && search.data.all).toBe(111);
    const literal = await countBriefsByFilter(clientFor(memberA.id), wsA.id, '%');
    expect(literal).toEqual({ ok: true, data: { all: 0, open: 0, closed: 0 } });
  });

  it('chip counts for B are 0 for a member of A only', async () => {
    const result = await countBriefsByFilter(clientFor(memberA.id), wsB.id, '');
    expect(result).toEqual({ ok: true, data: { all: 0, open: 0, closed: 0 } });
  });

  it('a member of both counts only A for A', async () => {
    const result = await countBriefsByFilter(clientFor(memberBoth.id), wsA.id, '');
    expect(result.ok && result.data.all).toBe(TOTAL_A);
  });
});
