import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCopy, errorReason, errorText, REASON_COPY } from './error-copy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('errorCopy', () => {
  it('offline: a fetch TypeError reads "You\'re offline." with Retry', () => {
    const copy = errorCopy('move the post', new TypeError('Failed to fetch'));
    expect(copy.text).toBe("Couldn't move the post. You're offline.");
    expect(copy.retryable).toBe(true);
  });

  it('offline: the browser saying offline wins over an unknown error', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(errorCopy('post the reply', { code: 'unknown', message: 'boom' })).toEqual({
      reason: 'offline',
      text: "Couldn't post the reply. You're offline.",
      retryable: true,
    });
  });

  it('offline: a transport message on a DomainError', () => {
    expect(errorReason({ code: 'unknown', message: 'TypeError: Load failed' })).toBe('offline');
  });

  it('forbidden_role and workspace_member_only read as no access, no Retry', () => {
    for (const code of ['forbidden_role', 'workspace_member_only']) {
      const copy = errorCopy('resolve the checkpoint', { code, message: code });
      expect(copy.text).toBe("Couldn't resolve the checkpoint. You don't have access to do this.");
      expect(copy.retryable).toBe(false);
    }
  });

  it('not_found reads "It was deleted."', () => {
    expect(errorText('save the caption', { code: 'unknown', message: 'post_not_found' })).toBe(
      "Couldn't save the caption. It was deleted.",
    );
    expect(errorCopy('save the caption', 'not_found').retryable).toBe(false);
  });

  it('a row_version conflict reads as someone else changed it', () => {
    expect(
      errorText('save the caption', { code: 'unknown', message: 'row_version_mismatch' }),
    ).toBe("Couldn't save the caption. Someone else changed it. Refresh to see the latest.");
    expect(errorReason({ code: 'unknown', message: 'stale' })).toBe('stale');
  });

  it('the approved lock reads "Approved posts are locked."', () => {
    const copy = errorCopy('approve the post', {
      code: 'unknown',
      message: 'post_approved_locked',
    });
    expect(copy.text).toBe("Couldn't approve the post. Approved posts are locked.");
    expect(copy.retryable).toBe(false);
  });

  it('caption_too_long and title_required have their own lines', () => {
    expect(errorText('save the caption', 'caption_too_long')).toBe(
      "Couldn't save the caption. Captions can be up to 4,000 characters.",
    );
    expect(
      errorText('create the brief', { code: 'invalid_payload', message: 'title_required' }),
    ).toBe("Couldn't create the brief. Add a title to save.");
  });

  it('anything else reads "Try again." with Retry, never the raw text', () => {
    const copy = errorCopy('create the brief', new Error('duplicate key value violates "x"'));
    expect(copy.text).toBe("Couldn't create the brief. Try again.");
    expect(copy.retryable).toBe(true);
    expect(errorCopy('move the post', undefined).reason).toBe('unknown');
  });

  it('keeps the approved reason lines verbatim', () => {
    expect(REASON_COPY).toEqual({
      offline: "You're offline.",
      forbidden: "You don't have access to do this.",
      not_found: 'It was deleted.',
      stale: 'Someone else changed it. Refresh to see the latest.',
      approved_locked: 'Approved posts are locked.',
      caption_too_long: 'Captions can be up to 4,000 characters.',
      title_required: 'Add a title to save.',
      unknown: 'Try again.',
    });
  });
});
