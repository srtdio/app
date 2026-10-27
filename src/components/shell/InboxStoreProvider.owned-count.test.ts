// The Activity badge shows a count only for the workspace and user it was read
// for: after a switch it shows nothing (0 renders no badge) until the new
// workspace's count lands, never the old workspace's number.
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { ownedUnread } from '@/components/shell/InboxStoreProvider';

describe('ownedUnread', () => {
  it('shows the count for the tenant it was read for', () => {
    expect(ownedUnread({ workspaceId: 'gbl', userId: 'u1', count: 4 }, 'gbl', 'u1')).toBe(4);
  });

  it('shows nothing after a switch until the new count lands, then the new count', () => {
    const old = { workspaceId: 'gbl', userId: 'u1', count: 4 };
    expect(ownedUnread(old, 'cv', 'u1')).toBe(0);
    expect(ownedUnread({ workspaceId: 'cv', userId: 'u1', count: 9 }, 'cv', 'u1')).toBe(9);
  });

  it('shows nothing for another user, no tenant or no read yet', () => {
    const owned = { workspaceId: 'gbl', userId: 'u1', count: 4 };
    expect(ownedUnread(owned, 'gbl', 'u2')).toBe(0);
    expect(ownedUnread(owned, null, null)).toBe(0);
    expect(ownedUnread(null, 'gbl', 'u1')).toBe(0);
  });
});
