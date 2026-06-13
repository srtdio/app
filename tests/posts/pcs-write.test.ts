// Boundary coverage for the PCS write wrappers (post_update, post_caption_update,
// gallery_set). Like the create/annotate specs, these drive a fake transport: a
// success case asserts the correctly shaped, snake_case args reach the proc, and
// at least one boundary case proves an invalid input is rejected before the proc
// is reached (the unreachable client never fires) or a proc-raised domain error
// is mapped to a Result error rather than thrown.
//
// post_update is key-presence: only the keys the caller supplied may appear in
// p_payload, and an explicit null on the nullable fields must survive (it clears
// the column) while an omitted field must be absent (it is left untouched).

import { describe, expect, it } from 'vitest';
import {
  gallerySet,
  postCaptionUpdate,
  postUpdate,
  type GallerySetInput,
  type PostCaptionUpdateInput,
  type PostUpdateInput,
} from '../../packages/posts/src/index';
import { rpcClient, unreachableRpcClient } from './helpers';

const ok = { data: 'post-1', error: null };
const POST_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const ASSET_A = '33333333-3333-3333-3333-333333333333';
const ASSET_B = '44444444-4444-4444-4444-444444444444';

describe('postUpdate', () => {
  it('sends only the keys the caller provided, in snake_case, with a trace id', async () => {
    const { client, calls } = rpcClient(ok);
    const result = await postUpdate(client, { postId: POST_ID, title: 'New title' }, 'trace-1');
    expect(result).toEqual({ ok: true, data: 'post-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('post_update');
    expect(calls[0]!.args.p_post_id).toBe(POST_ID);
    expect(calls[0]!.args.p_trace_id).toBe('trace-1');
    expect(calls[0]!.args.p_payload).toEqual({ title: 'New title' });
  });

  it('omits unset fields entirely so they are not overwritten', async () => {
    const { client, calls } = rpcClient(ok);
    await postUpdate(client, { postId: POST_ID, bucketId: ASSET_A }, 'trace-1');
    expect(calls[0]!.args.p_payload).toEqual({ bucket_id: ASSET_A });
  });

  it('passes a provided ownerUserId and targetDate through as values', async () => {
    const { client, calls } = rpcClient(ok);
    await postUpdate(
      client,
      { postId: POST_ID, ownerUserId: OWNER_ID, targetDate: '2026-07-01' },
      'trace-1',
    );
    expect(calls[0]!.args.p_payload).toEqual({
      owner_user_id: OWNER_ID,
      target_date: '2026-07-01',
    });
  });

  it('keeps an explicit null on ownerUserId and targetDate so the proc clears them', async () => {
    const { client, calls } = rpcClient(ok);
    await postUpdate(client, { postId: POST_ID, ownerUserId: null, targetDate: null }, 'trace-1');
    expect(calls[0]!.args.p_payload).toEqual({ owner_user_id: null, target_date: null });
  });

  it('sends an empty payload when only the postId is provided', async () => {
    const { client, calls } = rpcClient(ok);
    await postUpdate(client, { postId: POST_ID }, 'trace-1');
    expect(calls[0]!.args.p_payload).toEqual({});
  });

  it('rejects a non-uuid postId before the proc is reached', async () => {
    const result = await postUpdate(
      unreachableRpcClient(),
      { postId: 'not-a-uuid' } as unknown as PostUpdateInput,
      'trace-1',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('maps a proc forbidden_role message to the matching domain error', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await postUpdate(client, { postId: POST_ID, title: 'x' }, 'trace-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_role');
  });
});

describe('postCaptionUpdate', () => {
  it('sends the caption and a trace id to post_caption_update', async () => {
    const { client, calls } = rpcClient(ok);
    const result = await postCaptionUpdate(
      client,
      { postId: POST_ID, caption: 'Hello' },
      'trace-2',
    );
    expect(result).toEqual({ ok: true, data: 'post-1' });
    expect(calls[0]!.fn).toBe('post_caption_update');
    expect(calls[0]!.args).toEqual({
      p_post_id: POST_ID,
      p_caption: 'Hello',
      p_trace_id: 'trace-2',
    });
  });

  it('rejects a non-uuid postId before the proc is reached', async () => {
    const result = await postCaptionUpdate(
      unreachableRpcClient(),
      { postId: 'nope', caption: 'x' } as unknown as PostCaptionUpdateInput,
      'trace-2',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('maps a proc forbidden_role message to the matching domain error', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await postCaptionUpdate(client, { postId: POST_ID, caption: 'x' }, 'trace-2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_role');
  });
});

describe('gallerySet', () => {
  it('sends the ordered asset version ids and a trace id to gallery_set', async () => {
    const { client, calls } = rpcClient(ok);
    const result = await gallerySet(
      client,
      { postId: POST_ID, assetVersionIds: [ASSET_A, ASSET_B] },
      'trace-3',
    );
    expect(result).toEqual({ ok: true, data: 'post-1' });
    expect(calls[0]!.fn).toBe('gallery_set');
    expect(calls[0]!.args).toEqual({
      p_post_id: POST_ID,
      p_asset_version_ids: [ASSET_A, ASSET_B],
      p_trace_id: 'trace-3',
    });
  });

  it('allows an empty array to clear the gallery', async () => {
    const { client, calls } = rpcClient(ok);
    await gallerySet(client, { postId: POST_ID, assetVersionIds: [] }, 'trace-3');
    expect(calls[0]!.args.p_asset_version_ids).toEqual([]);
  });

  it('rejects a non-uuid asset version id before the proc is reached', async () => {
    const result = await gallerySet(
      unreachableRpcClient(),
      { postId: POST_ID, assetVersionIds: ['not-a-uuid'] } as unknown as GallerySetInput,
      'trace-3',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('maps a proc forbidden_role message to the matching domain error', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await gallerySet(client, { postId: POST_ID, assetVersionIds: [] }, 'trace-3');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_role');
  });
});
