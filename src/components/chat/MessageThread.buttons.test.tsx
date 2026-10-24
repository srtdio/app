// Button system regression: the thread's failed-send Retry / Delete and the
// load-error Retry rows render the shared 44px, 8px-radius Button.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The chat modules' import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  FailedActions,
  olderLoadErrorRow,
  threadLoadErrorRow,
} from '@/components/chat/MessageThread';

const noop = (): void => {};
const buttons = (html: string): string[] => html.match(/<button[^>]*>/g) ?? [];

function expectOnSystem(t: string): void {
  expect(t).toContain('h-11');
  expect(t).toContain('rounded-lg');
  expect(t).toContain('text-sm font-medium');
  expect(t).not.toMatch(/\bh-9\b|\bh-12\b|rounded-md|font-semibold/);
}

describe('thread buttons', () => {
  it('failed send: Retry (link) and Delete (bad ink) are 44px Buttons', () => {
    const html = renderToStaticMarkup(<FailedActions onRetry={noop} onDelete={noop} />);
    const tags = buttons(html);
    expect(tags).toHaveLength(2);
    for (const t of tags) expectOnSystem(t);
    const retry = tags.find((t) => t.includes('data-failed-line-retry')) ?? '';
    const del = tags.find((t) => t.includes('data-failed-delete')) ?? '';
    expect(retry).toContain('text-accent');
    expect(del).toContain('text-bad');
  });

  it('load error rows: the secondary Retry', () => {
    for (const row of [threadLoadErrorRow(noop), olderLoadErrorRow(noop)]) {
      const [retry] = buttons(renderToStaticMarkup(row));
      expectOnSystem(retry ?? '');
      expect(retry).toContain('border-border');
    }
  });
});
