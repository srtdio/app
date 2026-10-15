// Pure derivation + display helpers for the Members panel. No React, no network,
// so grouping, pending derivation, role gating and error copy unit-test in
// isolation. The two live reads (listMembers + readProfiles) happen in the hook;
// everything here operates on their already-fetched results.

import type { Database } from '@srtdio/schemas';
import type { DomainErrorCode } from '@srtdio/rpc';
import type { ChatProfile } from '@/lib/chat-reads';

export type WorkspaceMemberRow = Database['public']['Tables']['workspace_members']['Row'];

// One role -> label map, defined once and reused by every badge. Unknown roles
// fall back to the raw value so a new server role never renders blank.
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agency: 'Agency',
  // The role value stays `client`; people read it as the approver.
  client: 'Approver',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

// The "Team" group holds the internal roles; "Approvers" is client-only.
const AGENCY_ROLES = new Set(['owner', 'admin', 'agency']);

/** Active member: on the roster and not removed. */
export function isActiveMember(row: WorkspaceMemberRow): boolean {
  return row.active === true && row.removed_at === null;
}

/** Pending invite: sent, not yet accepted, not withdrawn. */
export function isPendingInvite(row: WorkspaceMemberRow): boolean {
  return row.active === false && row.accepted_at === null && row.removed_at === null;
}

/** A member row enriched with the profile slice the panel renders. */
export interface MemberEntry {
  /** workspace_members.id, passed verbatim as p_member_id to member_remove. */
  id: string;
  userId: string;
  role: string;
  displayName: string;
  avatarUrl: string | null;
  /** Only known for the caller (from the session); null otherwise. */
  email: string | null;
  acceptedAt: string | null;
  isOwner: boolean;
  isSelf: boolean;
}

export interface DerivedMembers {
  agency: MemberEntry[];
  client: MemberEntry[];
  pending: MemberEntry[];
}

/**
 * Split the membership rows into the two active-member groups and the pending
 * list, dropping any removed row, and enrich each with its profile. Rows are
 * consumed as fetched (already ordered by invited_at from listMembers).
 */
export function deriveMembers(params: {
  rows: WorkspaceMemberRow[];
  profiles: Map<string, ChatProfile>;
  currentUserId: string | null;
  selfEmail?: string | null;
}): DerivedMembers {
  const { rows, profiles, currentUserId, selfEmail } = params;

  const toEntry = (row: WorkspaceMemberRow): MemberEntry => {
    const profile = profiles.get(row.user_id);
    const isSelf = currentUserId !== null && row.user_id === currentUserId;
    return {
      id: row.id,
      userId: row.user_id,
      role: row.role,
      displayName: profile?.displayName ?? 'Unknown member',
      avatarUrl: profile?.avatarUrl ?? null,
      email: isSelf ? (selfEmail ?? null) : null,
      acceptedAt: row.accepted_at,
      isOwner: row.role === 'owner',
      isSelf,
    };
  };

  const active = rows.filter(isActiveMember).map(toEntry);
  return {
    agency: active.filter((m) => AGENCY_ROLES.has(m.role)),
    client: active.filter((m) => m.role === 'client'),
    pending: rows.filter(isPendingInvite).map(toEntry),
  };
}

/**
 * Whether the caller may manage members. The server remains authoritative.
 */
export function canManageMembers(
  rows: WorkspaceMemberRow[],
  currentUserId: string | null,
): boolean {
  const role = activeMemberRole(rows, currentUserId);
  return role === 'owner' || role === 'admin';
}

/** The caller's active workspace role, or null when they are not a member. */
export function activeMemberRole(
  rows: WorkspaceMemberRow[],
  currentUserId: string | null,
): string | null {
  if (currentUserId === null) return null;
  const own = rows.find((r) => r.user_id === currentUserId && isActiveMember(r));
  return own?.role ?? null;
}

/** Clients can invite clients, but cannot manage or remove workspace members. */
export function canInviteMembers(
  rows: WorkspaceMemberRow[],
  currentUserId: string | null,
): boolean {
  const role = activeMemberRole(rows, currentUserId);
  return role === 'owner' || role === 'admin' || role === 'client';
}

// Friendly, code-free failure copy in the style of INVITE_ERROR_MESSAGE. Domain
// codes map to a specific line; anything else falls back to the generic retry.
export function memberRemoveErrorMessage(code: DomainErrorCode): string {
  switch (code) {
    case 'forbidden_role':
      return 'You do not have permission to remove members. Ask an owner or admin.';
    case 'workspace_member_only':
      return 'That person is no longer a member of this workspace.';
    default:
      return "Couldn't complete that. Refresh the list and try again.";
  }
}

/** Format accepted_at for the "joined" column; null when never accepted. */
export function formatJoined(acceptedAt: string | null): string | null {
  if (acceptedAt === null) return null;
  const date = new Date(acceptedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The client's brand word in a domain, mirroring public.domain_brand_word. */
export function domainBrandWord(domain: string): string {
  const labels = domain.trim().toLowerCase().split('.').filter(Boolean);
  const n = labels.length;
  if (n < 2) return labels[0] ?? '';
  const second = labels[n - 2] ?? '';
  if (n >= 3 && (labels[n - 1] ?? '').length === 2 && SECOND_LEVEL.has(second)) {
    return labels[n - 3] ?? '';
  }
  return second;
}

const SECOND_LEVEL = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'ac',
  'edu',
  'ltd',
  'plc',
  'gen',
  'firm',
  'ind',
  'biz',
]);

/** The domain part of an email address, lower-cased ('' when there is none). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0
    ? ''
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/**
 * The client's domain label for copy: workspaces.client_domain when set, else
 * the brand word of the first approver's known email, else ''.
 */
export function clientDomainLabel(
  clientDomain: string | null,
  approvers: readonly MemberEntry[],
): string {
  if (clientDomain !== null && clientDomain !== '') return clientDomain;
  const email = approvers
    .map((m) => m.email)
    .find((e): e is string => e !== null && emailDomain(e) !== '');
  return email !== undefined ? domainBrandWord(emailDomain(email)) : '';
}

/** Inline copy when an approver invite uses a free mail address. */
export const FREE_MAIL_APPROVER_MESSAGE =
  'Your approver needs a work address, like name@theirbrand.com.';

/** Toast copy when an approver invite is outside the workspace's client domain. */
export function clientDomainMismatchMessage(domainLabel: string): string {
  return domainLabel === ''
    ? 'One client per workspace. Everyone here needs the same company address.'
    : `One client per workspace. Everyone here needs a ${domainLabel} address.`;
}
