// X7 fix 4 (FB5) on the bubble: Delete for every failed own message (files
// included); a permanent refusal shows its reason and Delete only, no Retry;
// a transient failure keeps Retry + Delete. Delete frees the stored files and
// previews (ChatStoreProvider's settle).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

import { FailedActions, canDiscardFailed, canRetryFailed } from '@/components/chat/MessageThread';

const noop = (): void => {};
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('X7 FB5: failed own sends', () => {
  it('a failed send with a file can be deleted (canDiscardFailed no longer needs zero files)', () => {
    const failed = { mine: true, state: 'failed' as const };
    expect(canDiscardFailed(failed)).toBe(true);
    expect(canDiscardFailed({ ...failed, filesMissing: true })).toBe(false);
    expect(canDiscardFailed({ ...failed, mine: false })).toBe(false);
    expect(canDiscardFailed({ mine: true, state: 'sent' as const })).toBe(false);
  });

  it('a permanent refusal shows no Retry: the reason and Delete only', () => {
    expect(canRetryFailed({ refusal: 'Files up to 100MB only' })).toBe(false);
    const html = renderToStaticMarkup(
      <FailedActions onRetry={noop} onDelete={noop} refusal="Files up to 100MB only" />,
    );
    expect(html).toContain('Not sent');
    expect(html).toContain('data-failed-reason');
    expect(html).toContain('Files up to 100MB only');
    expect(html).not.toContain('data-failed-line-retry');
    expect(html).toContain('data-failed-delete');
  });

  it('a transient failure keeps Retry and Delete', () => {
    expect(canRetryFailed({})).toBe(true);
    const html = renderToStaticMarkup(<FailedActions onRetry={noop} onDelete={noop} />);
    expect(html).toContain('data-failed-line-retry');
    expect(html).toContain('data-failed-delete');
    expect(html).not.toContain('data-failed-reason');
  });

  it('the red alert beside a refused bubble is gone (it would retry)', () => {
    const thread = source('../MessageThread.tsx');
    expect(thread).toContain(
      'failed && mine && message.filesMissing !== true && canRetryFailed(message)',
    );
  });

  it('Delete on a failed send releases its stored files and previews', () => {
    const provider = source('../ChatStoreProvider.tsx');
    const settle = provider.slice(provider.indexOf('settle: (channelId, id) => {'));
    expect(settle).toContain("entry?.state === 'failed'");
    expect(settle).toContain('releaseCancelled(filesRef.current, entry');
  });
});
