// Boundary coverage for the author-only comment write wrappers (editComment,
// deleteComment). These are pure unit specs over a fake transport (no database,
// no COMMENTS_SUITE gate), mirroring the @srtdio/rpc wrapper specs: a success
// case asserts the correctly shaped, snake_case args reach the proc, and a
// boundary case proves an invalid input is rejected before the proc is reached
// (the fake rpc never fires) or a proc-raised domain error is mapped to a Result
// error rather than thrown. Comments are a PRD section 25 critical surface.

import { describe, expect, it, vi } from 'vitest';
import {
  deleteComment,
  editComment,
  type Client,
  type DeleteCommentInput,
  type EditCommentInput,
} from '../../packages/comments/src/index';

// A minimal client whose rpc() returns the configured PostgREST shape and
// records how it was called, mirroring the @srtdio/rpc test helper.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  const client = { rpc } as unknown as Client;
  return { client, rpc };
}

// A client whose rpc() fails the test if it is ever reached.
function unreachableClient(): Client {
  return {
    rpc(): never {
      throw new Error('rpc should not have been called');
    },
  } as unknown as Client;
}

const COMMENT_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';

describe('editComment', () => {
  it('forwards the comment id, body, and trace id to comment_edit on success', async () => {
    const { client, rpc } = makeClient({ data: 'comment-1', error: null });
    const result = await editComment(
      client,
      { commentId: COMMENT_ID, body: 'fixed typo' },
      TRACE_ID,
    );
    expect(result).toEqual({ ok: true, data: 'comment-1' });
    expect(rpc).toHaveBeenCalledWith('comment_edit', {
      p_comment_id: COMMENT_ID,
      p_body: 'fixed typo',
      p_trace_id: TRACE_ID,
    });
  });

  it('rejects an empty body before the proc is reached', async () => {
    const result = await editComment(
      unreachableClient(),
      { commentId: COMMENT_ID, body: '' },
      TRACE_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('rejects a non-uuid comment id before the proc is reached', async () => {
    const result = await editComment(
      unreachableClient(),
      { commentId: 'not-a-uuid', body: 'x' } as unknown as EditCommentInput,
      TRACE_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('maps the author-only forbidden_role exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await editComment(client, { commentId: COMMENT_ID, body: 'x' }, TRACE_ID);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });
});

describe('deleteComment', () => {
  it('forwards the comment id and trace id to comment_soft_delete on success', async () => {
    const { client, rpc } = makeClient({ data: 'comment-1', error: null });
    const result = await deleteComment(client, { commentId: COMMENT_ID }, TRACE_ID);
    expect(result).toEqual({ ok: true, data: 'comment-1' });
    expect(rpc).toHaveBeenCalledWith('comment_soft_delete', {
      p_comment_id: COMMENT_ID,
      p_trace_id: TRACE_ID,
    });
  });

  it('rejects a non-uuid comment id before the proc is reached', async () => {
    const result = await deleteComment(
      unreachableClient(),
      { commentId: 'not-a-uuid' } as unknown as DeleteCommentInput,
      TRACE_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_payload');
  });

  it('maps the author-only forbidden_role exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await deleteComment(client, { commentId: COMMENT_ID }, TRACE_ID);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });
});
