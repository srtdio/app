import { describe, expect, it, vi } from 'vitest';
import {
  bankIdeaCreate,
  bankIdeaSet,
  planItemBucketsSet,
  planItemFromBank,
  planItemToBank,
  workspaceBucketDelete,
  workspaceBucketRename,
  type Client,
} from './index';

const T = '22222222-2222-2222-2222-222222222222';
const ITEM = '11111111-1111-1111-1111-111111111111';
const WS = '33333333-3333-3333-3333-333333333333';
const BUCKET = '44444444-4444-4444-4444-444444444444';
const PLAN = '55555555-5555-5555-5555-555555555555';

function okRpc(data: unknown = null) {
  return vi.fn(() => Promise.resolve({ data, error: null }));
}

describe('plan bank wrappers', () => {
  it('each wrapper calls its own proc once with the args as given', async () => {
    const cases: [string, (c: Client) => Promise<unknown>, object][] = [
      [
        'bank_idea_create',
        (c) =>
          bankIdeaCreate(c, {
            p_workspace_id: WS,
            p_title: 'Idea',
            p_description: '',
            p_attachment_version_ids: [],
            p_bucket_ids: [BUCKET],
            p_trace_id: T,
          }),
        {
          p_workspace_id: WS,
          p_title: 'Idea',
          p_description: '',
          p_attachment_version_ids: [],
          p_bucket_ids: [BUCKET],
          p_trace_id: T,
        },
      ],
      [
        'bank_idea_set',
        (c) =>
          bankIdeaSet(c, {
            p_item_id: ITEM,
            p_show_to_client: true,
            p_archived: false,
            p_starred: false,
            p_trace_id: T,
          }),
        {
          p_item_id: ITEM,
          p_show_to_client: true,
          p_archived: false,
          p_starred: false,
          p_trace_id: T,
        },
      ],
      [
        'plan_item_buckets_set',
        (c) => planItemBucketsSet(c, { p_item_id: ITEM, p_bucket_ids: [BUCKET], p_trace_id: T }),
        { p_item_id: ITEM, p_bucket_ids: [BUCKET], p_trace_id: T },
      ],
      [
        'plan_item_to_bank',
        (c) => planItemToBank(c, { p_item_id: ITEM, p_trace_id: T }),
        { p_item_id: ITEM, p_trace_id: T },
      ],
      [
        'plan_item_from_bank',
        (c) =>
          planItemFromBank(c, {
            p_item_id: ITEM,
            p_plan_id: PLAN,
            p_target_date: '2026-11-10',
            p_trace_id: T,
          }),
        { p_item_id: ITEM, p_plan_id: PLAN, p_target_date: '2026-11-10', p_trace_id: T },
      ],
      [
        'workspace_bucket_rename',
        (c) => workspaceBucketRename(c, { p_bucket_id: BUCKET, p_name: 'Reels', p_trace_id: T }),
        { p_bucket_id: BUCKET, p_name: 'Reels', p_trace_id: T },
      ],
      [
        'workspace_bucket_delete',
        (c) => workspaceBucketDelete(c, { p_bucket_id: BUCKET, p_trace_id: T }),
        { p_bucket_id: BUCKET, p_trace_id: T },
      ],
    ];
    for (const [name, call, args] of cases) {
      const rpc = okRpc();
      const result = (await call({ rpc } as unknown as Client)) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(name, args);
    }
  });

  it('bank_idea_create returns the new id', async () => {
    const rpc = okRpc(ITEM);
    const result = await bankIdeaCreate({ rpc } as unknown as Client, {
      p_workspace_id: WS,
      p_title: 'Idea',
      p_description: '',
      p_attachment_version_ids: [],
      p_bucket_ids: [],
      p_trace_id: T,
    });
    expect(result).toEqual({ ok: true, data: ITEM });
  });

  it('maps forbidden_role and leaves proc-only codes as unknown', async () => {
    const forbidden = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'forbidden_role' } }),
    );
    expect(
      await planItemToBank({ rpc: forbidden } as unknown as Client, {
        p_item_id: ITEM,
        p_trace_id: T,
      }),
    ).toEqual({ ok: false, error: { code: 'forbidden_role', message: 'forbidden_role' } });
    const taken = vi.fn(() => Promise.resolve({ data: null, error: { message: 'name_taken' } }));
    expect(
      await workspaceBucketRename({ rpc: taken } as unknown as Client, {
        p_bucket_id: BUCKET,
        p_name: 'Reels',
        p_trace_id: T,
      }),
    ).toEqual({ ok: false, error: { code: 'unknown', message: 'name_taken' } });
  });
});
