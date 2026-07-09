import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MembersList } from './MembersList';
import type { DerivedMembers, MemberEntry } from './members-data';

function entry(overrides: Partial<MemberEntry>): MemberEntry {
  return {
    id: 'm-0',
    userId: 'u-0',
    role: 'agency',
    displayName: 'Ada Agency',
    avatarUrl: null,
    email: null,
    acceptedAt: '2026-01-01T00:00:00Z',
    isOwner: false,
    isSelf: false,
    ...overrides,
  };
}

const derived: DerivedMembers = {
  agency: [
    entry({ id: 'm-owner', displayName: 'Olive Owner', role: 'owner', isOwner: true }),
    entry({ id: 'm-agency', displayName: 'Ada Agency', role: 'agency' }),
  ],
  client: [entry({ id: 'm-client', displayName: 'Cara Client', role: 'client' })],
  pending: [],
};

const OWNER_LOCK_TITLE = 'Transfer ownership before the owner can be removed';

describe('MembersList', () => {
  it('shows the owner lock and no action kebabs for a read-only (client) viewer', () => {
    const out = renderToStaticMarkup(
      <MembersList
        derived={derived}
        canManage={false}
        cancellingId={null}
        onOpenActions={vi.fn()}
        onCancelInvite={vi.fn()}
      />,
    );
    expect(out).toContain(OWNER_LOCK_TITLE);
    expect(out).not.toContain('Actions for Ada Agency');
    expect(out).not.toContain('Actions for Cara Client');
  });

  it('shows action kebabs for non-owner rows when the viewer can manage', () => {
    const out = renderToStaticMarkup(
      <MembersList
        derived={derived}
        canManage={true}
        cancellingId={null}
        onOpenActions={vi.fn()}
        onCancelInvite={vi.fn()}
      />,
    );
    // Owner still shows the lock, never a kebab.
    expect(out).toContain(OWNER_LOCK_TITLE);
    expect(out).not.toContain('Actions for Olive Owner');
    // Every other row gets a kebab.
    expect(out).toContain('Actions for Ada Agency');
    expect(out).toContain('Actions for Cara Client');
  });

  it('renders the empty state when there are no pending invites', () => {
    const out = renderToStaticMarkup(
      <MembersList
        derived={derived}
        canManage={true}
        cancellingId={null}
        onOpenActions={vi.fn()}
        onCancelInvite={vi.fn()}
      />,
    );
    expect(out).toContain('No pending invites');
  });
});
