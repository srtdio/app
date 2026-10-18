// Shared role types for the catch-up email.

/** A workspace member role. */
export type Role = 'owner' | 'admin' | 'agency' | 'client';

/** The agency-side roles (everyone but the client). */
export const AGENCY_ROLES: readonly Role[] = ['owner', 'admin', 'agency'];
