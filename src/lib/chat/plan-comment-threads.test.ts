import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  ITEM_COMMENT_COLUMNS,
  planCommentOfRead,
  planCommentSendArgs,
  planMainComments,
  planRepliesByRoot,
  planRepliesInfo,
  planThreadReadAt,
  readCommentCounts,
  readItemComments,
  sendPlanComment,
  setPlanCommentThreadRead,
  type PlanCommentRead,
} from '@/lib/chat/plans';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const ME = 'u-me';
const ASHA = 'u-asha';
const LEO = 'u-leo';
const SAM = 'u-sam';

/** A PostgREST-ish builder: every call returns itself; awaiting it gives `rows`. */
function fakeSelect(rows: unknown[]): {
  client: Client;
  selects: string[];
  tables: string[];
} {
  const selects: string[] = [];
  const tables: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['in', 'is', 'eq', 'order', 'limit', 'range', 'contains', 'gte', 'lte']) {
    builder[m] = () => builder;
  }
  builder.select = (cols: string) => {
    selects.push(cols);
    return builder;
  };
  builder.then = (done: (v: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(done);
  const client = {
    from: (table: string) => {
      tables.push(table);
      return builder;
    },
  } as unknown as Client;
  return { client, selects, tables };
}

function fakeRpc(answer: { data: unknown; error: { message: string; details?: string } | null }): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn<(...args: unknown[]) => Promise<typeof answer>>(async () => answer);
  return { client: { rpc } as unknown as Client, rpc };
}

const at = (min: number): string => new Date(Date.UTC(2026, 10, 12, 9, min)).toISOString();

describe('the comment read (one select, the read point embedded)', () => {
  it('asks the thread columns and the own read point in the same select', async () => {
    const rows: PlanCommentRead[] = [
      {
        id: 'r1',
        item_id: 'i1',
        author_user_id: ASHA,
        body: 'Reply',
        visibility: 'everyone',
        created_at: at(5),
        parent_comment_id: 'm1',
        attachment_asset_ids: null,
        plan_item_comment_thread_reads: [],
      },
      {
        id: 'm1',
        item_id: 'i1',
        author_user_id: ME,
        body: 'Main',
        visibility: 'everyone',
        created_at: at(1),
        parent_comment_id: null,
        attachment_asset_ids: ['v1'],
        plan_item_comment_thread_reads: [{ last_read_at: at(3) }],
      },
    ];
    const { client, selects, tables } = fakeSelect(rows);
    const result = await readItemComments(client, 'i1');
    expect(tables).toEqual(['plan_item_comments']);
    expect(selects).toEqual([ITEM_COMMENT_COLUMNS]);
    expect(ITEM_COMMENT_COLUMNS).toContain('parent_comment_id');
    expect(ITEM_COMMENT_COLUMNS).toContain('attachment_asset_ids');
    expect(ITEM_COMMENT_COLUMNS).toContain('plan_item_comment_thread_reads(last_read_at)');
    // 13 Nov 2026: Add to Tasks rides in the same read (the tag and its link).
    expect(ITEM_COMMENT_COLUMNS).toContain('task_state');
    expect(ITEM_COMMENT_COLUMNS).toContain(
      'plan_item_comment_tasks(task_id, channel_id, assignee_user_id, group_name)',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((c) => c.id)).toEqual(['m1', 'r1']);
    expect(result.data[0]).toMatchObject({
      parent_comment_id: null,
      attachment_asset_ids: ['v1'],
      thread_read_at: at(3),
    });
    expect(result.data[1]?.thread_read_at).toBeNull();
    expect(result.data[0]).not.toHaveProperty('plan_item_comment_thread_reads');
  });

  it('the read point embed: an object, a one-row array, empty or junk', () => {
    expect(planThreadReadAt({ last_read_at: at(2) })).toBe(at(2));
    expect(planThreadReadAt([{ last_read_at: at(2) }])).toBe(at(2));
    expect(planThreadReadAt([])).toBeNull();
    expect(planThreadReadAt(null)).toBeNull();
    expect(planThreadReadAt([{ last_read_at: 3 }])).toBeNull();
  });

  it('a row with no thread columns (an older fixture) reads as a main comment', () => {
    const row = planCommentOfRead({
      id: 'x',
      item_id: 'i1',
      author_user_id: null,
      body: 'b',
      visibility: 'team',
      created_at: at(0),
    });
    expect(row).toMatchObject({
      parent_comment_id: null,
      attachment_asset_ids: null,
      thread_read_at: null,
      task_state: null,
      task_link: null,
    });
  });

  it('comment counts shown elsewhere still count every comment, replies included', async () => {
    const { client } = fakeSelect([{ item_id: 'i1' }, { item_id: 'i1' }, { item_id: 'i2' }]);
    const counts = await readCommentCounts(client, ['i1', 'i2']);
    expect(counts.ok && counts.data).toEqual({ i1: 2, i2: 1 });
  });
});

describe('plan_item_comment_send', () => {
  it('a main comment sends a null parent; the trace id is explicit; no user id is sent', async () => {
    const { client, rpc } = fakeRpc({ data: 'new-id', error: null });
    const result = await sendPlanComment(client, {
      itemId: 'i1',
      parentId: null,
      body: 'Hello',
      visibility: 'everyone',
      attachmentVersionIds: ['v1', 'v2'],
      traceId: 't-1',
    });
    expect(result).toEqual({ ok: true, data: 'new-id' });
    expect(rpc).toHaveBeenCalledWith('plan_item_comment_send', {
      p_item_id: 'i1',
      p_parent_comment_id: null,
      p_body: 'Hello',
      p_visibility: 'everyone',
      p_attachment_version_ids: ['v1', 'v2'],
      p_trace_id: 't-1',
    });
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(args).some((k) => /user|author|actor/.test(k))).toBe(false);
  });

  it('a reply carries its main comment; a files-only send has an empty body', () => {
    expect(
      planCommentSendArgs({
        itemId: 'i1',
        parentId: 'm1',
        body: '',
        visibility: 'team',
        attachmentVersionIds: ['v1'],
        traceId: 't',
      }),
    ).toMatchObject({ p_parent_comment_id: 'm1', p_body: '', p_attachment_version_ids: ['v1'] });
  });

  it('expected refusals come back as Result values with their codes and details', async () => {
    const mention = await sendPlanComment(
      fakeRpc({ data: null, error: { message: 'invalid_mention', details: `${LEO},${SAM}` } })
        .client,
      {
        itemId: 'i1',
        parentId: null,
        body: 'x',
        visibility: 'everyone',
        attachmentVersionIds: [],
        traceId: 't',
      },
    );
    expect(mention).toEqual({
      ok: false,
      error: { code: 'invalid_mention', message: 'invalid_mention', details: `${LEO},${SAM}` },
    });
    for (const message of ['forbidden_role', 'workspace_member_only', 'invalid_payload']) {
      const r = await sendPlanComment(fakeRpc({ data: null, error: { message } }).client, {
        itemId: 'i1',
        parentId: 'm1',
        body: 'x',
        visibility: 'everyone',
        attachmentVersionIds: [],
        traceId: 't',
      });
      expect(r.ok === false && r.error.code).toBe(message);
    }
    const file = await sendPlanComment(
      fakeRpc({ data: null, error: { message: 'attachment not available' } }).client,
      {
        itemId: 'i1',
        parentId: null,
        body: '',
        visibility: 'everyone',
        attachmentVersionIds: ['v9'],
        traceId: 't',
      },
    );
    expect(file).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'attachment not available' },
    });
  });

  it('never throws: a thrown client is a Result', async () => {
    const client = {
      rpc: () => {
        throw new Error('offline');
      },
    } as unknown as Client;
    const r = await sendPlanComment(client, {
      itemId: 'i1',
      parentId: null,
      body: 'x',
      visibility: 'everyone',
      attachmentVersionIds: [],
      traceId: 't',
    });
    expect(r.ok).toBe(false);
  });
});

describe('plan_item_comment_thread_read_set', () => {
  it('fire and forget: one call with the root and an explicit trace id, nothing returned', async () => {
    const { client, rpc } = fakeRpc({ data: null, error: null });
    expect(setPlanCommentThreadRead(client, 'm1', 't-9')).toBeUndefined();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledWith('plan_item_comment_thread_read_set', {
      p_root_id: 'm1',
      p_trace_id: 't-9',
    });
  });

  it('a refusal or a throw never escapes', async () => {
    const refused = fakeRpc({ data: null, error: { message: 'comment not found' } });
    expect(() => setPlanCommentThreadRead(refused.client, 'm1', 't')).not.toThrow();
    const thrower = {
      rpc: () => Promise.reject(new Error('offline')),
    } as unknown as Client;
    expect(() => setPlanCommentThreadRead(thrower, 'm1', 't')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('thread helpers', () => {
  const rows = [
    { id: 'r2', created_at: at(9), parent_comment_id: 'm1' },
    { id: 'm2', created_at: at(4), parent_comment_id: null },
    { id: 'r1', created_at: at(6), parent_comment_id: 'm1' },
    { id: 'm1', created_at: at(2) },
    { id: 'r3', created_at: at(7), parent_comment_id: 'm2' },
  ];

  it('main comments only, in date order', () => {
    expect(planMainComments(rows).map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('replies by main comment, each oldest first', () => {
    const by = planRepliesByRoot(rows);
    expect(by.get('m1')?.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(by.get('m2')?.map((r) => r.id)).toEqual(['r3']);
    expect(by.has('m3')).toBe(false);
  });

  it('replies row: count, up to 3 photos with the latest replier last, the last reply time', () => {
    const replies = [
      { author_user_id: ASHA, created_at: at(1) },
      { author_user_id: SAM, created_at: at(2) },
      { author_user_id: LEO, created_at: at(3) },
      { author_user_id: ASHA, created_at: at(4) },
      { author_user_id: ME, created_at: at(5) },
    ];
    const info = planRepliesInfo(replies, null, ME);
    expect(info.count).toBe(5);
    expect(info.repliers).toEqual([LEO, ASHA, ME]);
    expect(info.lastAt).toBe(at(5));
  });

  it('unread: the last reply is not mine and is newer than my read point', () => {
    const others = [
      { author_user_id: ME, created_at: at(1) },
      { author_user_id: ASHA, created_at: at(4) },
    ];
    expect(planRepliesInfo(others, null, ME).unread).toBe(true);
    expect(planRepliesInfo(others, at(3), ME).unread).toBe(true);
    expect(planRepliesInfo(others, at(4), ME).unread).toBe(false);
    expect(planRepliesInfo(others, at(5), ME).unread).toBe(false);
    // My own last reply never reads as unread.
    const mine = [...others, { author_user_id: ME, created_at: at(6) }];
    expect(planRepliesInfo(mine, null, ME).unread).toBe(false);
    expect(planRepliesInfo([], null, ME)).toEqual({
      count: 0,
      repliers: [],
      lastAt: null,
      unread: false,
    });
  });

  it('a reply with no author counts but shows no photo', () => {
    const info = planRepliesInfo([{ author_user_id: null, created_at: at(1) }], null, ME);
    expect(info).toMatchObject({ count: 1, repliers: [], unread: true });
  });

  it('a big thread stays fast (hundreds of rows)', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `r${i}`,
      created_at: at(i % 59),
      parent_comment_id: i % 3 === 0 ? null : `r${i - (i % 3)}`,
    }));
    const t0 = performance.now();
    expect(planMainComments(many)).toHaveLength(200);
    expect(planRepliesByRoot(many).size).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
