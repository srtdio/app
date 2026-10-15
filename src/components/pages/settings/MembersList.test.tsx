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
        clientName="Acme"
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
        clientName="Acme"
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

  it('groups approvers (under the client name) before the team, pending inline', () => {
    const out = renderToStaticMarkup(
      <MembersList
        derived={{
          ...derived,
          pending: [
            entry({ id: 'p-client', displayName: 'Pia Pending', role: 'client', acceptedAt: null }),
            entry({ id: 'p-agency', displayName: 'Tom Pending', role: 'agency', acceptedAt: null }),
          ],
        }}
        clientName="Acme"
        canManage={true}
        cancellingId={null}
        onOpenActions={vi.fn()}
        onCancelInvite={vi.fn()}
      />,
    );
    const approvers = out.indexOf('>Approvers<');
    const team = out.indexOf('>Team<');
    expect(approvers).toBeGreaterThan(-1);
    expect(team).toBeGreaterThan(approvers);
    // The client name is the Approvers subheading.
    expect(out.indexOf('>Acme<')).toBeGreaterThan(approvers);
    expect(out.indexOf('>Acme<')).toBeLessThan(team);
    // Each side holds its own active rows then its pending invites.
    const at = (text: string) => out.indexOf(text);
    expect(at('Cara Client')).toBeGreaterThan(approvers);
    expect(at('Pia Pending')).toBeGreaterThan(at('Cara Client'));
    expect(at('Pia Pending')).toBeLessThan(team);
    expect(at('Olive Owner')).toBeGreaterThan(team);
    expect(at('Tom Pending')).toBeGreaterThan(at('Ada Agency'));
    // Pending invites keep their Cancel action; the role reads Approver.
    expect(out.match(/>Cancel</g)).toHaveLength(2);
    expect(out).toContain('>Approver<');
    expect(out).not.toContain('>Client<');
    expect(out).not.toContain('Pending invites');
  });

  it('shows the empty line for a side with nobody yet', () => {
    const out = renderToStaticMarkup(
      <MembersList
        derived={{ ...derived, client: [] }}
        clientName="Acme"
        canManage={true}
        cancellingId={null}
        onOpenActions={vi.fn()}
        onCancelInvite={vi.fn()}
      />,
    );
    expect(out).toContain('No approvers yet');
  });
});
