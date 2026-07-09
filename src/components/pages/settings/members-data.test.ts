import { describe, expect, it } from 'vitest';
import type { ChatProfile } from '@/lib/chat-reads';
import {
  canManageMembers,
  deriveMembers,
  formatJoined,
  isActiveMember,
  isPendingInvite,
  memberRemoveErrorMessage,
  roleLabel,
  type WorkspaceMemberRow,
} from './members-data';

// Row factory: only the fields the panel reads matter; the rest carry inert
// defaults so each test states just what it exercises.
function row(overrides: Partial<WorkspaceMemberRow>): WorkspaceMemberRow {
  return {
    accepted_at: '2026-01-01T00:00:00Z',
    active: true,
    id: 'm-0',
    invited_at: '2026-01-01T00:00:00Z',
    invited_by: null,
    rejoined_at: null,
    removed_at: null,
    role: 'agency',
    user_id: 'u-0',
    workspace_id: 'ws-1',
    ...overrides,
  };
}

const profiles = new Map<string, ChatProfile>([
  ['u-owner', { userId: 'u-owner', displayName: 'Olive Owner', avatarUrl: null }],
  ['u-admin', { userId: 'u-admin', displayName: 'Adam Admin', avatarUrl: 'https://x/a.png' }],
  ['u-agency', { userId: 'u-agency', displayName: 'Ada Agency', avatarUrl: null }],
  ['u-client', { userId: 'u-client', displayName: 'Cara Client', avatarUrl: null }],
]);

describe('isActiveMember / isPendingInvite', () => {
  it('treats active + not-removed as active', () => {
    expect(isActiveMember(row({ active: true, removed_at: null }))).toBe(true);
    expect(isActiveMember(row({ active: false }))).toBe(false);
    expect(isActiveMember(row({ removed_at: '2026-02-01T00:00:00Z' }))).toBe(false);
  });

  it('treats inactive + never-accepted + not-removed as pending', () => {
    expect(isPendingInvite(row({ active: false, accepted_at: null, removed_at: null }))).toBe(true);
    expect(isPendingInvite(row({ active: true, accepted_at: null }))).toBe(false);
    expect(
      isPendingInvite(
        row({ active: false, accepted_at: null, removed_at: '2026-02-01T00:00:00Z' }),
      ),
    ).toBe(false);
  });
});

describe('deriveMembers', () => {
  const rows = [
    row({ id: 'm-owner', user_id: 'u-owner', role: 'owner' }),
    row({ id: 'm-admin', user_id: 'u-admin', role: 'admin' }),
    row({ id: 'm-agency', user_id: 'u-agency', role: 'agency' }),
    row({ id: 'm-client', user_id: 'u-client', role: 'client' }),
    row({
      id: 'm-pending',
      user_id: 'u-pending',
      role: 'client',
      active: false,
      accepted_at: null,
    }),
    row({ id: 'm-removed', user_id: 'u-gone', role: 'agency', removed_at: '2026-03-01T00:00:00Z' }),
  ];

  it('groups agency roles, client role, and pending invites, dropping removed rows', () => {
    const derived = deriveMembers({
      rows,
      profiles,
      currentUserId: 'u-admin',
      selfEmail: 'a@x.io',
    });
    expect(derived.agency.map((m) => m.id)).toEqual(['m-owner', 'm-admin', 'm-agency']);
    expect(derived.client.map((m) => m.id)).toEqual(['m-client']);
    expect(derived.pending.map((m) => m.id)).toEqual(['m-pending']);
    // No removed row leaks into any group.
    const allIds = [...derived.agency, ...derived.client, ...derived.pending].map((m) => m.id);
    expect(allIds).not.toContain('m-removed');
  });

  it('marks the owner, flags self, and only attaches the caller its own email', () => {
    const derived = deriveMembers({
      rows,
      profiles,
      currentUserId: 'u-admin',
      selfEmail: 'a@x.io',
    });
    const owner = derived.agency.find((m) => m.id === 'm-owner');
    const self = derived.agency.find((m) => m.id === 'm-admin');
    const other = derived.agency.find((m) => m.id === 'm-agency');
    expect(owner?.isOwner).toBe(true);
    expect(self?.isSelf).toBe(true);
    expect(self?.email).toBe('a@x.io');
    expect(other?.email).toBeNull();
    expect(other?.displayName).toBe('Ada Agency');
  });

  it('falls back to a placeholder name when no profile is present', () => {
    const derived = deriveMembers({
      rows: [row({ id: 'm-x', user_id: 'u-missing', role: 'agency' })],
      profiles,
      currentUserId: null,
    });
    expect(derived.agency[0]?.displayName).toBe('Unknown member');
  });
});

describe('canManageMembers', () => {
  const rows = [
    row({ user_id: 'u-owner', role: 'owner' }),
    row({ user_id: 'u-admin', role: 'admin' }),
    row({ user_id: 'u-client', role: 'client' }),
  ];

  it('is true for owner and admin callers', () => {
    expect(canManageMembers(rows, 'u-owner')).toBe(true);
    expect(canManageMembers(rows, 'u-admin')).toBe(true);
  });

  it('is false for client callers, unknown callers, and no session', () => {
    expect(canManageMembers(rows, 'u-client')).toBe(false);
    expect(canManageMembers(rows, 'u-nobody')).toBe(false);
    expect(canManageMembers(rows, null)).toBe(false);
  });

  it('ignores a removed row for the caller', () => {
    const removed = [
      row({ user_id: 'u-owner', role: 'owner', removed_at: '2026-03-01T00:00:00Z' }),
    ];
    expect(canManageMembers(removed, 'u-owner')).toBe(false);
  });
});

describe('roleLabel / memberRemoveErrorMessage / formatJoined', () => {
  it('maps known roles and passes unknown ones through', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('client')).toBe('Client');
    expect(roleLabel('mystery')).toBe('mystery');
  });

  it('maps domain codes to friendly copy and falls back for the rest', () => {
    expect(memberRemoveErrorMessage('forbidden_role')).toContain('permission');
    expect(memberRemoveErrorMessage('workspace_member_only')).toContain('no longer');
    expect(memberRemoveErrorMessage('unknown')).toContain('try again');
  });

  it('formats an accepted date and returns null for missing/invalid input', () => {
    expect(formatJoined('2026-01-15T00:00:00Z')).not.toBeNull();
    expect(formatJoined(null)).toBeNull();
    expect(formatJoined('not-a-date')).toBeNull();
  });
});
