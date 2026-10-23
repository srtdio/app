import { describe, expect, it } from 'vitest';
import { friendlyTransitionError } from '@/lib/post-transition-errors';

describe('friendlyTransitionError', () => {
  it('maps each known proc code to its inline copy', () => {
    expect(friendlyTransitionError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      "Couldn't move the post. You don't have access to do this.",
    );
    expect(
      friendlyTransitionError({
        code: 'invalid_stage_transition',
        message: 'invalid_stage_transition',
      }),
    ).toBe("Couldn't move the post. That move isn't allowed from its current stage.");
    expect(
      friendlyTransitionError(
        { code: 'workspace_member_only', message: 'workspace_member_only' },
        'approve the post',
      ),
    ).toBe("Couldn't approve the post. You don't have access to do this.");
  });

  it('falls back to the retry line for anything else', () => {
    expect(friendlyTransitionError({ code: 'unknown', message: 'boom' })).toBe(
      "Couldn't move the post. Try again.",
    );
  });
});
