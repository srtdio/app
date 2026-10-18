import { describe, expect, it } from 'vitest';
import {
  friendlyCommentError,
  GENERIC_COPY,
  NOT_FOUND_COPY,
  PERMISSION_COPY,
} from '@/components/comments/comment-errors';

describe('friendlyCommentError', () => {
  it('maps forbidden_role and workspace_member_only to the permission copy', () => {
    expect(friendlyCommentError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      PERMISSION_COPY,
    );
    expect(friendlyCommentError({ code: 'workspace_member_only', message: 'x' })).toBe(
      PERMISSION_COPY,
    );
    expect(PERMISSION_COPY).toBe("You don't have permission to do that.");
  });

  it('maps a not_found raise to the gone copy', () => {
    expect(friendlyCommentError({ code: 'unknown', message: 'not_found' })).toBe(NOT_FOUND_COPY);
    expect(NOT_FOUND_COPY).toBe('This comment no longer exists.');
  });

  it('never returns the raw message', () => {
    const raw = 'PGRST301: JWT expired at row 42';
    const copy = friendlyCommentError({ code: 'unknown', message: raw });
    expect(copy).toBe(GENERIC_COPY);
    expect(copy).not.toContain('PGRST');
    expect(GENERIC_COPY).toBe('Something went wrong. Try again.');
  });
});
