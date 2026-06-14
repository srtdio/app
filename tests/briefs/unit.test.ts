// Pure unit coverage for the @srtdio/briefs wrappers. No database: the proc
// wrappers from @srtdio/rpc are mocked so we can assert exactly what createBrief
// / closeBrief send, and the read functions run against a hand-written, typed
// Postgrest stand-in so we can assert the query they build. These specs are NOT
// gated on BRIEFS_SUITE; they run under the plain `pnpm test` config too.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/briefs/src/index';
import {
  closeBrief,
  createBrief,
  getBrief,
  listBriefs,
  BRIEFS_PAGE_SIZE,
} from '../../packages/briefs/src/index';
import { briefClose, briefCreate, commentCreate } from '../../packages/rpc/src/index';

vi.mock('../../packages/rpc/src/index', () => ({
  briefCreate: vi.fn(),
  briefClose: vi.fn(),
  commentCreate: vi.fn(),
}));

const noClient = {} as unknown as Client;

// --- a minimal, typed Postgrest stand-in for the read path ------------------

interface MockResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

interface MockBuilder extends PromiseLike<MockResult> {
  select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): MockBuilder;
  eq(column: string, value: unknown): MockBuilder;
  in(column: string, values: unknown): MockBuilder;
  is(column: string, value: unknown): MockBuilder;
  gte(column: string, value: unknown): MockBuilder;
  lte(column: string, value: unknown): MockBuilder;
  like(column: string, value: unknown): MockBuilder;
  order(column: string, opts: { ascending: boolean }): MockBuilder;
  range(from: number, to: number): MockBuilder;
  maybeSingle(): Promise<MockResult>;
}

interface RecordedOp {
  table: string;
  opts?: { count?: 'exact'; head?: boolean };
  filters: Array<[string, string, unknown]>;
  order?: [string, { ascending: boolean }];
  range?: [number, number];
  single: boolean;
}

function mockClient(resultByTable: Record<string, MockResult>): {
  client: Client;
  ops: RecordedOp[];
} {
  const ops: RecordedOp[] = [];
  function from(table: string): MockBuilder {
    const op: RecordedOp = { table, filters: [], single: false };
    ops.push(op);
    const result = (): MockResult =>
      resultByTable[table] ?? { data: null, error: null, count: null };
    const builder: MockBuilder = {
      select(_columns, opts) {
        if (opts !== undefined) op.opts = opts;
        return builder;
      },
      eq(column, value) {
        op.filters.push(['eq', column, value]);
        return builder;
      },
      in(column, values) {
        op.filters.push(['in', column, values]);
        return builder;
      },
      is(column, value) {
        op.filters.push(['is', column, value]);
        return builder;
      },
      like(column, value) {
        op.filters.push(['like', column, value]);
        return builder;
      },
      gte(column, value) {
        op.filters.push(['gte', column, value]);
        return builder;
      },
      lte(column, value) {
        op.filters.push(['lte', column, value]);
        return builder;
      },
      order(column, opts) {
        op.order = [column, opts];
        return builder;
      },
      range(fromRow, toRow) {
        op.range = [fromRow, toRow];
        return builder;
      },
      maybeSingle() {
        op.single = true;
        return Promise.resolve(result());
      },
      then(onfulfilled, onrejected) {
        return Promise.resolve(result()).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }
  return { client: { from } as unknown as Client, ops };
}

beforeEach(() => {
  vi.mocked(briefCreate).mockReset();
  vi.mocked(briefClose).mockReset();
  vi.mocked(commentCreate).mockReset();
});

describe('createBrief', () => {
  it('shapes required fields into the payload and omits absent optionals', async () => {
    vi.mocked(briefCreate).mockResolvedValue({ ok: true, data: 'brief-1' });

    const result = await createBrief(
      noClient,
      { workspaceId: 'ws-1', title: 'T', objective: 'O' },
      'trace-1',
    );

    expect(result).toEqual({ ok: true, data: { id: 'brief-1', commentId: null } });
    expect(vi.mocked(briefCreate)).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(briefCreate).mock.calls[0]!;
    expect(args.p_workspace_id).toBe('ws-1');
    expect(args.p_trace_id).toBe('trace-1');
    expect(args.p_payload).toEqual({ title: 'T', objective: 'O', created_via: 'app' });
    // The optional brief columns must not be present when not supplied.
    expect(args.p_payload).not.toHaveProperty('format_requested');
    expect(args.p_payload).not.toHaveProperty('target_date');
    expect(vi.mocked(commentCreate)).not.toHaveBeenCalled();
  });

  it('forwards every supplied optional field and always sets created_via app', async () => {
    vi.mocked(briefCreate).mockResolvedValue({ ok: true, data: 'brief-2' });

    await createBrief(
      noClient,
      {
        workspaceId: 'ws-1',
        title: 'T',
        objective: 'O',
        formatRequested: 'carousel',
        brandRequirements: 'on-brand',
        targetDate: '2026-07-01',
        referenceLinks: [{ url: 'https://example.test' }],
      },
      'trace-1',
    );

    const [, args] = vi.mocked(briefCreate).mock.calls[0]!;
    expect(args.p_payload).toEqual({
      title: 'T',
      objective: 'O',
      created_via: 'app',
      format_requested: 'carousel',
      brand_requirements: 'on-brand',
      target_date: '2026-07-01',
      reference_links: [{ url: 'https://example.test' }],
    });
  });

  it('opens a brief-anchored root comment when initialCommentBody is given', async () => {
    vi.mocked(briefCreate).mockResolvedValue({ ok: true, data: 'brief-3' });
    vi.mocked(commentCreate).mockResolvedValue({ ok: true, data: 'comment-9' });

    const result = await createBrief(
      noClient,
      { workspaceId: 'ws-1', title: 'T', objective: 'O', initialCommentBody: 'kick-off' },
      'trace-1',
    );

    expect(result).toEqual({ ok: true, data: { id: 'brief-3', commentId: 'comment-9' } });
    const [, args] = vi.mocked(commentCreate).mock.calls[0]!;
    expect(args.p_workspace_id).toBe('ws-1');
    expect(args.p_entity_type).toBe('brief');
    expect(args.p_entity_id).toBe('brief-3');
    expect(args.p_parent_comment_id).toBeNull();
    expect(args.p_body).toBe('kick-off');
    expect(args.p_is_decision).toBe(false);
    expect(args.p_trace_id).toBe('trace-1');
  });

  it('does not post a comment for an empty initialCommentBody', async () => {
    vi.mocked(briefCreate).mockResolvedValue({ ok: true, data: 'brief-4' });

    const result = await createBrief(
      noClient,
      { workspaceId: 'ws-1', title: 'T', objective: 'O', initialCommentBody: '' },
      'trace-1',
    );

    expect(result).toEqual({ ok: true, data: { id: 'brief-4', commentId: null } });
    expect(vi.mocked(commentCreate)).not.toHaveBeenCalled();
  });

  it('passes a brief_create error straight through and skips the comment', async () => {
    vi.mocked(briefCreate).mockResolvedValue({
      ok: false,
      error: { code: 'forbidden_role', message: 'nope' },
    });

    const result = await createBrief(
      noClient,
      { workspaceId: 'ws-1', title: 'T', objective: 'O', initialCommentBody: 'hi' },
      'trace-1',
    );

    expect(result).toEqual({ ok: false, error: { code: 'forbidden_role', message: 'nope' } });
    expect(vi.mocked(commentCreate)).not.toHaveBeenCalled();
  });
});

describe('closeBrief', () => {
  it('forwards the brief id and trace id to brief_close', async () => {
    vi.mocked(briefClose).mockResolvedValue({ ok: true, data: undefined });

    const result = await closeBrief(noClient, { briefId: 'brief-1' }, 'trace-1');

    expect(result).toEqual({ ok: true, data: undefined });
    expect(vi.mocked(briefClose)).toHaveBeenCalledWith(noClient, {
      p_brief_id: 'brief-1',
      p_trace_id: 'trace-1',
    });
  });
});

describe('listBriefs', () => {
  it('applies every filter, sorts created_at desc, and paginates', async () => {
    const rows = [{ id: 'b1' }, { id: 'b2' }];
    const { client, ops } = mockClient({ briefs: { data: rows, error: null, count: null } });

    const result = await listBriefs(client, {
      status: 'open',
      createdBy: 'u1',
      targetDateFrom: '2026-01-01',
      targetDateTo: '2026-12-31',
      limit: 10,
      offset: 20,
    });

    // The list rows carry the additive derived thumbnail field; no asset_attachments
    // result is configured, so each brief's thumbnail resolves to null.
    expect(result).toEqual({
      ok: true,
      data: rows.map((brief) => ({ ...brief, thumbnailAssetVersionId: null })),
    });
    const op = ops[0]!;
    expect(op.table).toBe('briefs');
    expect(op.filters).toContainEqual(['is', 'deleted_at', null]);
    expect(op.filters).toContainEqual(['eq', 'status', 'open']);
    expect(op.filters).toContainEqual(['eq', 'created_by', 'u1']);
    expect(op.filters).toContainEqual(['gte', 'target_date', '2026-01-01']);
    expect(op.filters).toContainEqual(['lte', 'target_date', '2026-12-31']);
    expect(op.order).toEqual(['created_at', { ascending: false }]);
    expect(op.range).toEqual([20, 29]);
  });

  it('defaults to a page of 50 from offset 0 with only the soft-delete guard', async () => {
    const { client, ops } = mockClient({ briefs: { data: [], error: null, count: null } });

    await listBriefs(client);

    const op = ops[0]!;
    expect(op.filters).toEqual([['is', 'deleted_at', null]]);
    expect(op.range).toEqual([0, BRIEFS_PAGE_SIZE - 1]);
  });

  it('surfaces a transport error as an unknown DomainError', async () => {
    const { client } = mockClient({
      briefs: { data: null, error: { message: 'boom' }, count: null },
    });

    const result = await listBriefs(client);

    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'boom' } });
  });
});

describe('getBrief', () => {
  it('returns the brief with a derived count of live linked posts', async () => {
    const brief = { id: 'b1', title: 'T' };
    const { client, ops } = mockClient({
      briefs: { data: brief, error: null, count: null },
      posts: { data: null, error: null, count: 3 },
    });

    const result = await getBrief(client, 'b1');

    expect(result).toEqual({ ok: true, data: { brief, linked_posts_count: 3 } });
    const postsOp = ops.find((o) => o.table === 'posts')!;
    expect(postsOp.opts).toEqual({ count: 'exact', head: true });
    expect(postsOp.filters).toContainEqual(['eq', 'brief_id', 'b1']);
    expect(postsOp.filters).toContainEqual(['is', 'deleted_at', null]);
  });

  it('returns null (and never counts posts) when the brief is not visible', async () => {
    const { client, ops } = mockClient({ briefs: { data: null, error: null, count: null } });

    const result = await getBrief(client, 'missing');

    expect(result).toEqual({ ok: true, data: null });
    expect(ops.some((o) => o.table === 'posts')).toBe(false);
  });

  it('treats a null count as zero linked posts', async () => {
    const brief = { id: 'b1' };
    const { client } = mockClient({
      briefs: { data: brief, error: null, count: null },
      posts: { data: null, error: null, count: null },
    });

    const result = await getBrief(client, 'b1');

    expect(result).toEqual({ ok: true, data: { brief, linked_posts_count: 0 } });
  });
});
