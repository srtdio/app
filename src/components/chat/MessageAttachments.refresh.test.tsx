// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// MessageAttachments pulls MessageThread pieces that load the agora-chat browser SDK.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import type { VoiceUrlResult } from '@/components/chat/VoiceNote';
import { PresignError, type PresignCache } from '@/lib/asset-presign';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

/** A cache whose forced refresh throws `error`. */
function failingCache(error: unknown): PresignCache {
  return {
    linkMode: 'file-link',
    peek: () => null,
    resolve: () => new Promise(() => {}),
    refresh: async () => {
      throw error;
    },
  } as unknown as PresignCache;
}

/** Mount the hook and run one forced refresh through it. */
async function forcedRefresh(cache: PresignCache): Promise<VoiceUrlResult> {
  const probe: { refresh?: (force: boolean) => Promise<VoiceUrlResult> } = {};
  function Probe(): null {
    probe.refresh = useAttachmentUrl('v1', cache, true).refresh;
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  const out: { result?: VoiceUrlResult } = {};
  await act(async () => {
    out.result = await probe.refresh!(true);
  });
  return out.result!;
}

describe('useAttachmentUrl refresh', () => {
  it('a thrown PresignError resolves its name, code and message', async () => {
    const result = await forcedRefresh(
      failingCache(new PresignError('No active session.', 'unauthenticated')),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        name: 'PresignError',
        code: 'unauthenticated',
        message: 'No active session.',
        linkMode: 'file-link',
      },
    });
  });

  it('a raw TypeError resolves with code null and its own name', async () => {
    const result = await forcedRefresh(failingCache(new TypeError('Load failed')));
    expect(result).toEqual({
      ok: false,
      error: { name: 'TypeError', code: null, message: 'Load failed', linkMode: 'file-link' },
    });
  });

  it('keeps the message to 200 characters', async () => {
    const result = await forcedRefresh(failingCache(new Error('x'.repeat(500))));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toHaveLength(200);
  });

  it('a refresh that works resolves the url', async () => {
    const cache = {
      linkMode: 'presign',
      peek: () => null,
      resolve: () => new Promise(() => {}),
      refresh: async () => ({ url: 'https://signed/v1', expiresAt: Date.now() + 600_000 }),
    } as unknown as PresignCache;
    expect(await forcedRefresh(cache)).toEqual({ ok: true, data: 'https://signed/v1' });
  });
});
