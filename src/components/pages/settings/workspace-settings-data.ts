// Calls and copy for the Settings > Workspace tab. The three procs used here
// (workspace_update, workspace_client_domain_add/remove) have no @srtdio/rpc
// wrapper, so they are called directly with the args object passed through as
// the wrappers do (p_trace_id included). Each proc raises its domain code as the
// error message; the helpers below turn those codes into user-facing copy.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { domainBrandWord } from './members-data';

/** The editable workspace fields, as workspace_update's payload keys. */
export interface WorkspaceUpdatePayload {
  name?: string;
  /** An https URL, or '' to clear the logo. */
  logo_url?: string;
  timezone?: string;
}

function domainError(message: string): DomainError {
  return { code: 'unknown', message };
}

/** workspace_update as the caller (owner/admin; the proc re-checks). */
export async function updateWorkspace(
  client: Client,
  input: { workspaceId: string; payload: WorkspaceUpdatePayload; traceId: string },
): Promise<Result<null>> {
  const args = {
    p_workspace_id: input.workspaceId,
    p_payload: input.payload as Json,
    p_trace_id: input.traceId,
  };
  const { error } = await client.rpc('workspace_update', args);
  if (error) return { ok: false, error: domainError(error.message) };
  return { ok: true, data: null };
}

/** workspace_client_domain_add as the caller (owner only; the proc re-checks). */
export async function addClientDomain(
  client: Client,
  input: { workspaceId: string; domain: string; traceId: string },
): Promise<Result<null>> {
  const args = {
    p_workspace_id: input.workspaceId,
    p_domain: input.domain,
    p_trace_id: input.traceId,
  };
  const { error } = await client.rpc('workspace_client_domain_add', args);
  if (error) return { ok: false, error: domainError(error.message) };
  return { ok: true, data: null };
}

/** workspace_client_domain_remove as the caller (owner only; the proc re-checks). */
export async function removeClientDomain(
  client: Client,
  input: { workspaceId: string; domain: string; traceId: string },
): Promise<Result<null>> {
  const args = {
    p_workspace_id: input.workspaceId,
    p_domain: input.domain,
    p_trace_id: input.traceId,
  };
  const { error } = await client.rpc('workspace_client_domain_remove', args);
  if (error) return { ok: false, error: domainError(error.message) };
  return { ok: true, data: null };
}

/** The active approved approver addresses (removed rows are history only). */
export async function listClientDomains(
  client: Client,
  workspaceId: string,
): Promise<Result<string[]>> {
  const res = await client
    .from('workspace_client_domains')
    .select('domain')
    .eq('workspace_id', workspaceId)
    .is('removed_at', null)
    .order('created_at', { ascending: true });
  if (res.error) return { ok: false, error: domainError(res.error.message) };
  return { ok: true, data: res.data.map((row) => row.domain) };
}

export const NAME_MAX = 80;

/** A trimmed client name workspace_update accepts (1 to 80 characters). */
export function isValidClientName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= NAME_MAX;
}

/** Normalise a typed domain: trimmed, lower case, without a leading "@" or scheme. */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
}

/** The shape workspace_client_domain_add accepts. */
export function isValidDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value);
}

/** The intro line above the approved addresses list. */
export function approverAddressIntro(clientDomain: string | null): string {
  const word = clientDomain !== null && clientDomain !== '' ? domainBrandWord(clientDomain) : '';
  const subject = word !== '' ? word : 'their brand name';
  return `Approvers need an address with ${subject} in it. Add another company address here, for example a group company.`;
}

/** Copy for a failed approved-address change. */
export function clientDomainErrorMessage(code: string): string {
  switch (code) {
    case 'free_mail_client':
      return 'Free email addresses cannot be approved.';
    case 'invalid_payload':
      return 'Enter a company domain, like groupcompany.com.';
    case 'forbidden_role':
      return 'Only the workspace owner can change approved addresses.';
    case 'not_found':
      return 'That address was already removed.';
    default:
      return "Couldn't save that. Try again.";
  }
}

/** Copy for a failed workspace_update. */
export function workspaceUpdateErrorMessage(code: string): string {
  switch (code) {
    case 'forbidden_role':
      return 'Only an owner or admin can change workspace settings.';
    case 'invalid_payload':
      return 'That value is not allowed. Check it and try again.';
    default:
      return "Couldn't save. Try again.";
  }
}

/** Every IANA zone the browser knows, always including the current one. */
export function timezoneOptions(current: string): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return zones.includes(current) || current === '' ? [...zones] : [current, ...zones];
}
