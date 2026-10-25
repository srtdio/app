// X7 fix 7 (FT41): a failed older-page load shows "Couldn't load earlier
// messages." with a 44px Retry in place of Load older, and scrolling never
// re-fires it until Retry.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The chat modules' import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: () => false,
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { olderLoadErrorRow, threadListItems } from '@/components/chat/MessageThread';
import {
  OLDER_LOAD_FAILED,
  channelOlderKey,
  olderPageFailed,
  resetOlderPageStatus,
  setOlderPageFailed,
  threadOlderKey,
} from '@/lib/chat/older-page-status';

afterEach(() => resetOlderPageStatus());

const html = (items: ReturnType<typeof threadListItems>): string =>
  renderToStaticMarkup(<ul>{items}</ul>);

describe('X7 FT41: failed older page', () => {
  it('the status is kept per list and cleared by a new attempt', () => {
    expect(olderPageFailed(channelOlderKey('c1'))).toBe(false);
    setOlderPageFailed(channelOlderKey('c1'), true);
    expect(olderPageFailed(channelOlderKey('c1'))).toBe(true);
    expect(olderPageFailed(channelOlderKey('c2'))).toBe(false);
    expect(olderPageFailed(threadOlderKey('c1'))).toBe(false);
    setOlderPageFailed(channelOlderKey('c1'), false);
    expect(olderPageFailed(channelOlderKey('c1'))).toBe(false);
    expect(olderPageFailed(null)).toBe(false);
  });

  it('the inline row: the line and a 44px Retry', () => {
    const onRetry = vi.fn();
    const row = olderLoadErrorRow(onRetry);
    const out = renderToStaticMarkup(<ul>{row}</ul>);
    expect(OLDER_LOAD_FAILED).toBe("Couldn't load earlier messages.");
    expect(out).toContain('load earlier messages.');
    expect(out).toContain('Retry');
    expect(out).toContain('min-w-[44px]');
    expect(out).toContain('role="alert"');
  });

  it('a failed page replaces Load older; loading shows a skeleton, never the failure', () => {
    const retry = vi.fn();
    const failed = html(
      threadListItems([], false, () => <li />, vi.fn(), 'touch', false, undefined, retry),
    );
    expect(failed).toContain('data-older-load-error');
    expect(failed).not.toContain('data-load-older');
    const loading = html(
      threadListItems([], true, () => <li />, vi.fn(), 'touch', false, undefined, undefined),
    );
    expect(loading).not.toContain('data-older-load-error');
    expect(loading).toContain('Loading earlier messages');
    expect(loading).toContain('animate-pulse');
    const normal = html(threadListItems([], false, () => <li />, vi.fn()));
    expect(normal).toContain('data-load-older');
  });
});
