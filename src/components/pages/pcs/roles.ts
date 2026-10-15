// The PCS role predicates. There are exactly four roles (owner, admin, agency,
// client). The client approves or rejects; the agency side (owner, admin,
// agency) edits, and may also approve or reject on the client's behalf. The
// whole UI gates on these predicates rather than enumerating roles inline. An
// unknown or null role satisfies none, so the viewer is fully read-only.

/** The post's client: approves or rejects, never edits, parks or deletes posts. */
export function isClient(role: string | null): boolean {
  return role === 'client';
}

/** Owner, admin or agency: everyone who edits metadata, captions and the gallery. */
export function isAgencySide(role: string | null): boolean {
  return role !== null && role !== 'client';
}

/** Owner or admin: the workspace managers (group admin and similar gates). */
export function isOwnerOrAdmin(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}

/** Owner, admin or agency may delete a post (post.delete); the client never can. */
export function canDeletePost(role: string | null): boolean {
  return isAgencySide(role);
}

/** The on-behalf phrase when the workspace's brand name is unavailable. */
export const ON_BEHALF_OF_CLIENT = 'on behalf of the approvers';

/** "on behalf of Zomato" for the workspace's brand; "on behalf of the approvers" without one. */
export function onBehalfOf(brand: string | null | undefined): string {
  const name = brand?.trim() ?? '';
  return name !== '' ? `on behalf of ${name}` : ON_BEHALF_OF_CLIENT;
}

/**
 * " on behalf of <Brand>" when `role` is agency-side, else ''. A missing role
 * (an old row with no actor_role, or a failed role read) reads as the name only.
 */
export function onBehalfSuffix(
  role: string | null | undefined,
  brand: string | null | undefined,
): string {
  if (role === undefined || role === null || role === '') return '';
  return isAgencySide(role) ? ` ${onBehalfOf(brand)}` : '';
}
