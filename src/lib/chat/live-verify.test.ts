import { describe, expect, it, vi } from 'vitest';
import { createLiveVerifier } from '@/lib/chat/live-verify';
import type { ChatMessageRow } from '@/lib/chat/thread';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const row = { id: 'm1', channel_id: 'c1', body: 'hi' } as ChatMessageRow;

describe('createLiveVerifier', () => {
  it('renders from the row when the id has one', async () => {
    const lookup = vi.fn().mockResolvedValue({ found: true, row });
    const verifier = createLiveVerifier({ lookup, warn: vi.fn() });
    await expect(verifier.verify('m1')).resolves.toEqual({ found: true, row });
  });

  it('discards an id with no row and warns ONCE even when thread and store both ask', async () => {
    const lookup = vi.fn().mockResolvedValue({ found: false });
    const warn = vi.fn();
    const verifier = createLiveVerifier({ lookup, warn });
    const [fromThread, fromStore] = await Promise.all([
      verifier.verify('forged'),
      verifier.verify('forged'),
    ]);
    expect(fromThread).toEqual({ found: false });
    expect(fromStore).toEqual({ found: false });
    await verifier.verify('forged');
    expect(lookup).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no record row'), {
      message_id: 'forged',
    });
  });

  it('discards on a lookup error without caching it, so a later arrival can verify', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({ error: 'network' })
      .mockResolvedValueOnce({ found: true, row });
    const warn = vi.fn();
    const verifier = createLiveVerifier({ lookup, warn });
    await expect(verifier.verify('m1')).resolves.toEqual({ found: false });
    await expect(verifier.verify('m1')).resolves.toEqual({ found: true, row });
    expect(warn).toHaveBeenCalledOnce();
  });
});
