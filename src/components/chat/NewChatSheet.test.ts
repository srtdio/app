import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import {
  NEW_DM_FAILED,
  NEW_GROUP_FAILED,
  newChatFailureCopy,
} from '@/components/chat/NewChatSheet';

describe('R9: New chat failures never show raw error text', () => {
  const raw = {
    code: 'unknown' as const,
    message: 'duplicate key value violates unique constraint',
  };

  it('a failed DM start maps to its fixed copy; the raw text goes to the logger only', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(newChatFailureCopy('dm', raw)).toBe(NEW_DM_FAILED);
    expect(NEW_DM_FAILED).toBe("Couldn't start the chat. Try again.");
    expect(warn).toHaveBeenCalledWith('chat: dm start failed', {
      code: 'unknown',
      error: raw.message,
    });
    warn.mockRestore();
  });

  it('a failed group create maps to its fixed copy', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(newChatFailureCopy('group', raw)).toBe(NEW_GROUP_FAILED);
    expect(NEW_GROUP_FAILED).toBe("Couldn't create the group. Try again.");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
