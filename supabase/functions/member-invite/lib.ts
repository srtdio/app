// Pure, side-effect-free logic for the member-invite edge function.
//
// This module is the ONLY thing lib.test.ts imports: it must stay free of Deno
// globals and network access so it runs unchanged under Vitest (Node) and Deno.
// Everything that touches the network (Supabase clients, Resend, auth admin)
// lives in index.ts.
//
// `zod` is a bare specifier: Deno resolves it through deno.json's import map
// (npm:zod), Node/Vitest resolves it from the workspace node_modules.
import { z } from 'zod';

// Roles an inviter may assign. `owner` is intentionally excluded; the proc
// rejects it as forbidden_role.
export const INVITE_ROLES = ['admin', 'agency', 'client'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

// POST body contract. `.strict()` rejects any unknown key (-> 400). The email is
// lower-cased so the auth.users lookup and dedup are case-insensitive.
export const inviteInputSchema = z
  .object({
    workspace_id: z.uuid(),
    email: z.email().transform((value) => value.toLowerCase()),
    role: z.enum(INVITE_ROLES),
  })
  .strict();

export type InviteInput = z.infer<typeof inviteInputSchema>;

export function parseInviteInput(raw: unknown) {
  return inviteInputSchema.safeParse(raw);
}

// Stable error codes returned in the response body as { error: code }.
export type InviteErrorCode =
  | 'workspace_member_only'
  | 'forbidden_role'
  | 'invalid_payload'
  | 'internal_error';

export interface MappedInviteError {
  code: InviteErrorCode;
  status: number;
}

// member_invite raises stable string codes; map them to HTTP status. Anything
// unrecognised is an internal error (500).
export function mapInviteRpcError(rawMessage: string): MappedInviteError {
  const message = rawMessage.toLowerCase();
  if (message.includes('workspace_member_only')) {
    return { code: 'workspace_member_only', status: 403 };
  }
  if (message.includes('forbidden_role')) {
    return { code: 'forbidden_role', status: 403 };
  }
  if (message.includes('invalid_payload')) {
    return { code: 'invalid_payload', status: 400 };
  }
  return { code: 'internal_error', status: 500 };
}

// Deep link the invitee follows to accept. APP_URL is supplied by the caller and
// is never hardcoded here. A trailing slash on the base is normalised away.
export function buildAcceptUrl(appUrl: string, inviteId: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}/invite/accept?invite=${encodeURIComponent(inviteId)}`;
}

// RFC 9562 UUIDv7: 48-bit big-endian Unix-ms timestamp, version 7, variant 10.
// `randomBytes` is injectable so tests are deterministic; the default pulls 10
// bytes from Web Crypto (available in both Deno and Node, not a Deno global).
export function uuidv7(timestampMs: number = Date.now(), randomBytes?: Uint8Array): string {
  const random = randomBytes ?? crypto.getRandomValues(new Uint8Array(10));
  if (random.length < 10) {
    throw new Error('uuidv7 requires at least 10 random bytes');
  }
  const bytes = new Uint8Array(16);
  const ts = Math.max(0, Math.floor(timestampMs));
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  for (let i = 0; i < 10; i += 1) {
    const value = random[i];
    bytes[6 + i] = value === undefined ? 0 : value;
  }
  const versionByte = bytes[6] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x70;
  const variantByte = bytes[8] ?? 0;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
