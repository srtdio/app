// Pure derivation + display helpers for the Members panel. No React, no network,
// so grouping, pending derivation, role gating and error copy unit-test in
// isolation. The two live reads (listMembers + readProfiles) happen in the hook;
// everything here operates on their already-fetched results.

import type { Database } from '@srtdio/schemas';
import type { DomainErrorCode } from '@srtdio/rpc';
import type { ChatProfile } from '@/lib/chat-reads';
import { formatDate } from '@/lib/time';

export type WorkspaceMemberRow = Database['public']['Tables']['workspace_members']['Row'];

// One role -> label map, defined once and reused by every badge. Unknown roles
// fall back to the raw value so a new server role never renders blank.
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  // Owner, admin and agency are the Creator side ("we make the posts").
  agency: 'Creator',
  // The role value stays `client`; people read it as the Approver side.
  client: 'Approver',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

// The "Creators" group holds the internal roles; "Approvers" is client-only.
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
      // Every row here is a current (or invited) member: a name not loaded yet
      // renders nothing extra, never a placeholder or "Former member".
      displayName: profile?.displayName ?? '',
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
      return "Couldn't remove the member. You don't have access to do this.";
    case 'workspace_member_only':
      return "Couldn't remove the member. Someone else changed it. Refresh to see the latest.";
    default:
      return "Couldn't remove the member. Try again.";
  }
}

/** Format accepted_at for the "joined" column with the app day format ("23 Oct",
 *  the year only outside now's year; the viewer's clock); null when never accepted. */
export function formatJoined(acceptedAt: string | null, now: Date = new Date()): string | null {
  if (acceptedAt === null) return null;
  const day = formatDate(acceptedAt, now);
  return day === '' ? null : day;
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

/** The client's domain label for copy: workspaces.client_domain, else ''. */
export function clientDomainLabel(clientDomain: string | null): string {
  return clientDomain ?? '';
}

/** Inline copy when the invitee has an account whose email was never confirmed. */
export const UNCONFIRMED_ACCOUNT_MESSAGE =
  'This email has an account that was never confirmed. Ask them to open the confirmation email from Sorted, then send the invite again.';

/** Inline copy when an approver address is outside the workspace's client domain. */
export function clientDomainMismatchMessage(domainLabel: string): string {
  return domainLabel === ''
    ? "Couldn't send the invite. Try again."
    : `Use a ${domainLabel} email, or a personal one like Gmail.`;
}

/** invite_delivery_list statuses; only 'bounced' changes what the list shows. */
export type InviteDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed';

const DELIVERY_STATUSES: readonly string[] = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
];

function isDeliveryRow(
  value: unknown,
): value is { member_id: string; status: InviteDeliveryStatus } {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.member_id === 'string' &&
    typeof row.status === 'string' &&
    DELIVERY_STATUSES.includes(row.status)
  );
}

/** member_id -> latest delivery status, from one invite_delivery_list read (rows as returned). */
export function deliveryByMember(data: unknown): Map<string, InviteDeliveryStatus> {
  const rows = Array.isArray(data) ? data.filter(isDeliveryRow) : [];
  return new Map(rows.map((row) => [row.member_id, row.status]));
}

/** The pending row's "Not delivered" pill shows only for a bounced invite email. */
export function isUndelivered(status: InviteDeliveryStatus | undefined): boolean {
  return status === 'bounced';
}
