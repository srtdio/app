import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The first render of the page (static markup runs no effects, so this is the
// frame before the list read starts) must be the skeleton, never the zero
// state: the read has not answered yet, so "show up here" would be a lie that
// the list then replaces.

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace' }));
vi.mock('@/components/ui/toast', () => ({ useOptionalToast: () => null }));
vi.mock('@/components/shell/PageHead', () => ({ PageHead: () => null }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaces: [{ id: 'w1', owner_user_id: 'u1' }] }),
}));

import {
  RecentlyDeletedPage,
  RECENTLY_DELETED_EMPTY,
} from '@/components/pages/RecentlyDeletedPage';

describe('Recently deleted first paint', () => {
  it('starts as the skeleton, not the zero state', () => {
    const out = renderToStaticMarkup(<RecentlyDeletedPage />);
    expect(out).not.toContain(RECENTLY_DELETED_EMPTY);
    expect(out).toContain('animate-pulse');
  });
});
