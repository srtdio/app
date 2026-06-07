// Zod boundary coverage for the write wrappers. Invalid input must be rejected
// before the proc is reached (so the unreachable client never fires); valid
// input must reach the proc with the correctly shaped, snake_case args and the
// right fields nulled for each annotation kind.

import { describe, expect, it } from 'vitest';
import {
  annotationCreate,
  postCreate,
  type AnnotationCreateInput,
  type PostCreatePayload,
} from '../../packages/posts/src/index';
import { rpcClient, unreachableRpcClient } from './helpers';

const ok = { data: 'id-1', error: null };

describe('postCreate payload validation', () => {
  it('rejects a payload missing the title', async () => {
    const result = await postCreate(unreachableRpcClient(), {
      workspaceId: 'ws-1',
      payload: { platform: 'linkedin' } as unknown as PostCreatePayload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('rejects a payload missing the platform', async () => {
    const result = await postCreate(unreachableRpcClient(), {
      workspaceId: 'ws-1',
      payload: { title: 'T' } as unknown as PostCreatePayload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('rejects an out-of-range title', async () => {
    const result = await postCreate(unreachableRpcClient(), {
      workspaceId: 'ws-1',
      payload: { title: '', platform: 'x' } as unknown as PostCreatePayload,
    });
    expect(result.ok).toBe(false);
  });

  it('sends a snake_case payload and a trace id to post_create when valid', async () => {
    const { client, calls } = rpcClient(ok);
    const result = await postCreate(client, {
      workspaceId: 'ws-1',
      payload: { title: 'T', platform: 'linkedin', caption: 'c', format: 'carousel' },
      traceId: 'trace-1',
    });
    expect(result).toEqual({ ok: true, data: 'id-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('post_create');
    expect(calls[0]!.args.p_workspace_id).toBe('ws-1');
    expect(calls[0]!.args.p_trace_id).toBe('trace-1');
    expect(calls[0]!.args.p_payload).toEqual({
      title: 'T',
      platform: 'linkedin',
      caption: 'c',
      format: 'carousel',
    });
  });

  it('mints a uuid_v7 trace id when none is supplied', async () => {
    const { client, calls } = rpcClient(ok);
    await postCreate(client, {
      workspaceId: 'ws-1',
      payload: { title: 'T', platform: 'linkedin' },
    });
    expect(typeof calls[0]!.args.p_trace_id).toBe('string');
    expect((calls[0]!.args.p_trace_id as string).length).toBeGreaterThan(0);
  });
});

describe('annotationCreate discriminated union', () => {
  const captionSpan: AnnotationCreateInput = {
    kind: 'caption_span',
    postId: '11111111-1111-1111-1111-111111111111',
    postVersionId: '22222222-2222-2222-2222-222222222222',
    commentId: '33333333-3333-3333-3333-333333333333',
    captionStart: 0,
    captionEnd: 5,
  };
  const imagePin: AnnotationCreateInput = {
    kind: 'image_pin',
    postId: '11111111-1111-1111-1111-111111111111',
    postVersionId: '22222222-2222-2222-2222-222222222222',
    commentId: '33333333-3333-3333-3333-333333333333',
    assetAttachmentId: '44444444-4444-4444-4444-444444444444',
    imageX: 0.5,
    imageY: 0.25,
  };

  it('sends caption span fields and nulls the image fields', async () => {
    const { client, calls } = rpcClient(ok);
    const result = await annotationCreate(client, captionSpan);
    expect(result).toEqual({ ok: true, data: 'id-1' });
    const args = calls[0]!.args;
    expect(args.p_kind).toBe('caption_span');
    expect(args.p_caption_start).toBe(0);
    expect(args.p_caption_end).toBe(5);
    expect(args.p_asset_attachment_id).toBeNull();
    expect(args.p_image_x).toBeNull();
    expect(args.p_image_y).toBeNull();
    expect(args.p_comment_id).toBe(captionSpan.commentId);
  });

  it('sends image pin fields and nulls the caption fields', async () => {
    const { client, calls } = rpcClient(ok);
    await annotationCreate(client, imagePin);
    const args = calls[0]!.args;
    expect(args.p_kind).toBe('image_pin');
    expect(args.p_asset_attachment_id).toBe(imagePin.assetAttachmentId);
    expect(args.p_image_x).toBe(0.5);
    expect(args.p_image_y).toBe(0.25);
    expect(args.p_caption_start).toBeNull();
    expect(args.p_caption_end).toBeNull();
  });

  it('rejects a caption span missing captionEnd', async () => {
    const bad = { ...captionSpan, captionEnd: undefined } as unknown as AnnotationCreateInput;
    const result = await annotationCreate(unreachableRpcClient(), bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('rejects an image pin with imageX above 1', async () => {
    const bad = { ...imagePin, imageX: 1.5 };
    const result = await annotationCreate(unreachableRpcClient(), bad);
    expect(result.ok).toBe(false);
  });

  it('rejects an image pin with imageY below 0', async () => {
    const bad = { ...imagePin, imageY: -0.1 };
    const result = await annotationCreate(unreachableRpcClient(), bad);
    expect(result.ok).toBe(false);
  });

  it('rejects an annotation with no commentId', async () => {
    const bad = { ...captionSpan, commentId: undefined } as unknown as AnnotationCreateInput;
    const result = await annotationCreate(unreachableRpcClient(), bad);
    expect(result.ok).toBe(false);
  });
});
