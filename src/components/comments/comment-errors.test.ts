import { describe, expect, it } from 'vitest';
import { friendlyCommentError } from '@/components/comments/comment-errors';

describe('friendlyCommentError', () => {
  it('maps forbidden_role and workspace_member_only to the access copy', () => {
    expect(friendlyCommentError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      "Couldn't post the comment. You don't have access to do this.",
    );
    expect(
      friendlyCommentError({ code: 'workspace_member_only', message: 'x' }, 'post the reply'),
    ).toBe("Couldn't post the reply. You don't have access to do this.");
  });

  it('maps a not_found raise to the deleted copy', () => {
    expect(
      friendlyCommentError({ code: 'unknown', message: 'not_found' }, 'resolve the checkpoint'),
    ).toBe("Couldn't resolve the checkpoint. It was deleted.");
  });

  it('never returns the raw message', () => {
    const raw = 'PGRST301: JWT expired at row 42';
    const copy = friendlyCommentError({ code: 'unknown', message: raw });
    expect(copy).toBe("Couldn't post the comment. Try again.");
    expect(copy).not.toContain('PGRST');
    expect(copy).not.toContain('Something went wrong');
  });
});
