// The PCS role predicates. There are exactly four roles (owner, admin, agency,
// client) and only `client` behaves differently in F7's editing surfaces, so the
// whole UI gates on these two predicates rather than enumerating roles inline. An
// unknown or null role satisfies neither, so the viewer is fully read-only.

/** The post's client: the only role that approves / requests changes. */
export function isClient(role: string | null): boolean {
  return role === 'client';
}

/** Owner, admin or agency: everyone who edits metadata, captions and the gallery. */
export function isAgencySide(role: string | null): boolean {
  return role !== null && role !== 'client';
}

/** Owner or admin: the only roles that may delete a post. */
export function isOwnerOrAdmin(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}
