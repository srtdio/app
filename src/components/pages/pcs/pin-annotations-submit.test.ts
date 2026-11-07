import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { submitPin, type PinSubmitInput } from '@/components/pages/pcs/pin-annotations-submit';
import { buildPinData, checkpointMarks } from '@/components/pages/pcs/pin-annotations';
import type { GalleryItem, PostAnnotation, PostVersion } from '@srtdio/posts';

// A client's pin is a numbered checkpoint: ONE comment_batch_create point, then
// annotation_create on the new comment id, both on the tap's one trace as the
// procs' explicit p_trace_id. A fake client records the RPC sequence; no
// database is touched.

const WS = '0190a1b2-0000-7000-8000-000000000001';
const POST = '0190a1b2-0000-7000-8000-000000000002';
const VERSION = '0190a1b2-0000-7000-8000-000000000003';
const ATTACHMENT = '0190a1b2-0000-7000-8000-000000000004';
const COMMENT = '0190a1b2-0000-7000-8000-000000000005';
const TRACE = '0190a1b2-0000-7000-8000-000000000006';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

type Reply = { data: unknown; error: { message: string } | null };

function fakeClient(replies: Record<string, Reply>): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(replies[fn] ?? { data: null, error: { message: 'unknown' } });
    },
  } as unknown as Client;
  return { client, calls };
}

const INPUT: PinSubmitInput = {
  asCheckpoint: true,
  workspaceId: WS,
  postId: POST,
  postVersionId: VERSION,
  assetAttachmentId: ATTACHMENT,
  x: 0.25,
  y: 0.75,
  body: 'Brighter here',
  traceId: TRACE,
};

describe('client pin submit', () => {
  it('creates ONE checkpoint, then anchors the pin to its id, on one trace', async () => {
    const { client, calls } = fakeClient({
      comment_batch_create: { data: [{ id: COMMENT, seq: 3 }], error: null },
      annotation_create: { data: 'ann-1', error: null },
    });
    const result = await submitPin(client, INPUT);

    expect(result).toEqual({ status: 'ok', commentId: COMMENT, seq: 3 });
    expect(calls.map((c) => c.fn)).toEqual(['comment_batch_create', 'annotation_create']);
    expect(calls[0]!.args).toEqual({
      p_workspace_id: WS,
      p_post_id: POST,
      p_points: [{ body: 'Brighter here' }],
      p_trace_id: TRACE,
    });
    expect(calls[1]!.args).toMatchObject({
      p_post_id: POST,
      p_post_version_id: VERSION,
      p_kind: 'image_pin',
      p_asset_attachment_id: ATTACHMENT,
      p_image_x: 0.25,
      p_image_y: 0.75,
      p_comment_id: COMMENT,
      p_trace_id: TRACE,
      p_caption_start: null,
      p_caption_end: null,
    });
  });

  it('the new pin draws numbered with the checkpoint ledger_seq', async () => {
    const { client } = fakeClient({
      comment_batch_create: { data: [{ id: COMMENT, seq: 3 }], error: null },
      annotation_create: { data: 'ann-1', error: null },
    });
    const result = await submitPin(client, INPUT);
    if (result.status !== 'ok' || result.seq === null) throw new Error('expected a checkpoint');
    const marks = checkpointMarks([
      { id: result.commentId, ledger_seq: result.seq, resolved_at: null, accepted_at: null },
    ]);
    const annotation = {
      id: 'ann-1',
      kind: 'image_pin',
      post_id: POST,
      post_version_id: VERSION,
      comment_id: COMMENT,
      asset_attachment_id: ATTACHMENT,
      image_x: 0.25,
      image_y: 0.75,
      caption_start: null,
      caption_end: null,
      created_at: '2026-11-07T00:00:00Z',
    } as unknown as PostAnnotation;
    const data = buildPinData(
      [annotation],
      VERSION,
      [{ id: VERSION, version_number: 1 } as PostVersion],
      [{ assetAttachmentId: ATTACHMENT, filename: 'a.png' } as GalleryItem],
      marks,
    );
    expect(data.pinsByAttachment[ATTACHMENT]?.[0]).toMatchObject({ n: 3, state: 'open' });
    expect(data.pinChipsByCommentId[COMMENT]).toMatchObject({ n: 3, slide: 1 });
  });

  it('a refused checkpoint writes no annotation', async () => {
    const { client, calls } = fakeClient({
      comment_batch_create: { data: null, error: { message: 'forbidden_role' } },
    });
    const result = await submitPin(client, INPUT);
    expect(result).toEqual({ status: 'comment_failed', message: 'forbidden_role' });
    expect(calls.map((c) => c.fn)).toEqual(['comment_batch_create']);
  });

  it('an empty batch reply is a failure, never an annotation on nothing', async () => {
    const { client, calls } = fakeClient({ comment_batch_create: { data: [], error: null } });
    const result = await submitPin(client, INPUT);
    expect(result.status).toBe('comment_failed');
    expect(calls).toHaveLength(1);
  });

  it('a failed annotation keeps the checkpoint and reports it', async () => {
    const { client } = fakeClient({
      comment_batch_create: { data: [{ id: COMMENT, seq: 5 }], error: null },
      annotation_create: { data: null, error: { message: 'invalid_payload' } },
    });
    const result = await submitPin(client, INPUT);
    expect(result).toMatchObject({ status: 'annotation_failed', commentId: COMMENT, seq: 5 });
  });

  it('an agency pin is a plain comment_create (no checkpoint, no number)', async () => {
    const { client, calls } = fakeClient({
      comment_create: { data: COMMENT, error: null },
      annotation_create: { data: 'ann-1', error: null },
    });
    const result = await submitPin(client, { ...INPUT, asCheckpoint: false });
    expect(result).toEqual({ status: 'ok', commentId: COMMENT, seq: null });
    expect(calls.map((c) => c.fn)).toEqual(['comment_create', 'annotation_create']);
    expect(calls[0]!.args).toMatchObject({ p_trace_id: TRACE, p_entity_type: 'post' });
  });
});
