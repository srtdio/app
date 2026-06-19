// Regression coverage for the ETL author-attribution doctrine: users are never
// migrated, so loadBriefs / loadPosts / loadPostVersions must leave the FK author
// columns NULL and preserve ex-member provenance only in legacy_author_name
// (redacted to 'Member' in dev-seed, never a real name). No database, no network:
// each loader is driven over a tiny fixture with an in-test PoolClient that
// captures the INSERT params and a SourceDb stub that returns one batch. Mirrors
// the offline stub style of assets.test.ts.

import { describe, expect, it } from 'vitest';

import type { EtlConfig } from '../../packages/etl/src/config';
import { loadBriefs, loadPosts, loadPostVersions, type Row } from '../../packages/etl/src/load';
import type { V1Post, V1PostVersion, V1Request } from '../../packages/etl/src/source';
import { NAME_REDACTION } from '../../packages/etl/src/transform';

// The loaders take the concrete pg PoolClient / SourceDb classes; the stubs match
// only the methods exercised here and are cast through unknown, exactly as the
// asset suite does for its storage/fetch stubs.
type LoaderClient = Parameters<typeof loadBriefs>[0];
type LoaderSource = Parameters<typeof loadBriefs>[1];

interface CapturedInsert {
  table: string;
  columns: string[];
  rows: Row[];
}

// A PoolClient stand-in that intercepts INSERT statements and reconstructs the row
// objects from the column list + flattened bind params, so per-column assertions
// (created_by IS null, etc.) can be made without a database.
function captureClient() {
  const inserts: CapturedInsert[] = [];
  const client = {
    query: (sql: string, params: unknown[] = []): Promise<{ rows: never[]; rowCount: number }> => {
      const match = /^INSERT INTO (\S+) \(([^)]+)\)/.exec(sql.trim());
      if (match) {
        const table = match[1] as string;
        const columns = (match[2] as string).split(',').map((c) => c.trim());
        const width = columns.length;
        const rows: Row[] = [];
        for (let i = 0; i < params.length; i += width) {
          const row: Row = {};
          columns.forEach((col, j) => {
            row[col] = params[i + j];
          });
          rows.push(row);
        }
        inserts.push({ table, columns, rows });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { client: client as unknown as LoaderClient, inserts };
}

// A SourceDb stand-in: one batch at offset 0, then empty so each loader's paging
// loop terminates after a single pass.
function sourceStub(fixture: {
  requests?: V1Request[];
  posts?: V1Post[];
  versions?: V1PostVersion[];
}) {
  const source = {
    fetchRequestsBatch: (offset: number): Promise<V1Request[]> =>
      Promise.resolve(offset === 0 ? (fixture.requests ?? []) : []),
    fetchPostsBatch: (offset: number): Promise<V1Post[]> =>
      Promise.resolve(offset === 0 ? (fixture.posts ?? []) : []),
    fetchVersionsForPosts: (): Promise<V1PostVersion[]> => Promise.resolve(fixture.versions ?? []),
  };
  return source as unknown as LoaderSource;
}

const WORKSPACE_ID = '0190a000-0000-7000-8000-0000000000ws';

const CONFIG: EtlConfig = {
  sourceUrl: 'postgresql://u@source.example/db',
  targetUrl: 'postgresql://u@target.example/db',
  expectedTargetRef: 'movnexawfhsyuluspxoc',
  operatorUserId: '0190a000-0000-7000-8000-0000000000op',
  operatorEmail: 'op@example.com',
  operatorDisplayName: 'Operator',
  workspaceName: 'Client',
  workspaceTimezone: 'Asia/Kolkata',
  cli: { mode: 'dev-seed', dryRun: false, confirmCutover: false, validate: false },
};

const POST1 = '0190a000-0000-7000-8000-00000000ps01';
const POST2 = '0190a000-0000-7000-8000-00000000ps02';

// A v1 row carrying a real person name, and one with no resolvable author. After
// dev-seed redaction the first must become 'Member' and the second stay null;
// neither may ever surface the real name.
const REAL_NAME = 'Alice Realname';

function rowsFor(inserts: CapturedInsert[], table: string): Row[] {
  return inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
}

// Asserts the four-column doctrine on one set of migrated rows: the FK author
// column is NULL, and legacy_author_name is pinned to 'Member'/null (never a real
// name) on those same rows. Pinning both together is the point: a future change
// that re-stamps an author, or leaks a real name, fails here.
function expectAuthorColumnsNulled(rows: Row[], authorColumns: readonly string[]): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    for (const col of authorColumns) {
      expect(row[col]).toBeNull();
    }
    expect([NAME_REDACTION, null]).toContain(row.legacy_author_name);
    expect(row.legacy_author_name).not.toBe(REAL_NAME);
  }
}

describe('loadBriefs author attribution (dev-seed)', () => {
  it('nulls briefs.created_by and preserves only Member/null in legacy_author_name', async () => {
    const { client, inserts } = captureClient();
    const source = sourceStub({
      requests: [
        {
          id: 'req-1',
          title: 'Launch',
          description: 'A request',
          content_type: 'TEXT',
          status: 'open',
          target_date: null,
          drive_link: null,
          images: null,
          legacy_author_name: REAL_NAME,
        },
        {
          id: 'req-2',
          title: 'Untitled',
          description: null,
          content_type: null,
          status: 'closed',
          target_date: null,
          drive_link: null,
          images: null,
          legacy_author_name: null,
        },
      ],
    });

    const { count } = await loadBriefs(client, source, CONFIG, WORKSPACE_ID);

    const briefs = rowsFor(inserts, 'public.briefs');
    expect(count).toBe(2);
    expect(briefs).toHaveLength(2);
    expectAuthorColumnsNulled(briefs, ['created_by']);
    // The real-name row redacts to Member; the unresolvable-author row stays null.
    expect(briefs.map((b) => b.legacy_author_name).sort()).toEqual([NAME_REDACTION, null]);
  });
});

describe('loadPosts author attribution (dev-seed)', () => {
  it('nulls posts.owner_user_id and posts.created_by, preserving Member/null only', async () => {
    const { client, inserts } = captureClient();
    const source = sourceStub({
      posts: [
        {
          id: POST1,
          post_id: 'p1',
          title: 'Post one',
          caption: 'caption one',
          format: 'text',
          is_draft: false,
          stage: 'published',
          brief_id: null,
          target_date: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          legacy_author_name: REAL_NAME,
        },
        {
          id: POST2,
          post_id: 'p2',
          title: null,
          caption: null,
          format: null,
          is_draft: true,
          stage: null,
          brief_id: null,
          target_date: null,
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-04T00:00:00Z',
          legacy_author_name: null,
        },
      ],
    });

    const count = await loadPosts(client, source, CONFIG, WORKSPACE_ID, new Map());

    const posts = rowsFor(inserts, 'public.posts');
    expect(count).toBe(2);
    expect(posts).toHaveLength(2);
    expectAuthorColumnsNulled(posts, ['owner_user_id', 'created_by']);
    expect(posts.map((p) => p.legacy_author_name).sort()).toEqual([NAME_REDACTION, null]);
  });
});

describe('loadPostVersions author attribution (dev-seed)', () => {
  it('nulls post_versions.created_by for both real v1 versions and synthetic ones', async () => {
    const { client, inserts } = captureClient();
    const source = sourceStub({
      // POST1 has a real v1 version (named author -> Member); POST2 has none, so it
      // gets a synthetic version 1 whose legacy_author_name is null.
      posts: [
        {
          id: POST1,
          post_id: 'p1',
          title: 'Post one',
          caption: 'caption one',
          format: 'text',
          is_draft: false,
          stage: 'published',
          brief_id: null,
          target_date: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          legacy_author_name: REAL_NAME,
        },
        {
          id: POST2,
          post_id: 'p2',
          title: 'Post two',
          caption: 'caption two',
          format: 'text',
          is_draft: false,
          stage: 'published',
          brief_id: null,
          target_date: null,
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-04T00:00:00Z',
          legacy_author_name: null,
        },
      ],
      versions: [
        {
          post_id: POST1,
          caption: 'edited caption',
          edited_by: 'someone',
          edited_at: '2024-01-05T00:00:00Z',
          legacy_author_name: REAL_NAME,
        },
      ],
    });

    const count = await loadPostVersions(client, source, CONFIG, WORKSPACE_ID);

    const versions = rowsFor(inserts, 'public.post_versions');
    expect(count).toBe(2);
    expect(versions).toHaveLength(2);
    expectAuthorColumnsNulled(versions, ['created_by']);
    expect(versions.map((v) => v.legacy_author_name).sort()).toEqual([NAME_REDACTION, null]);
  });
});
