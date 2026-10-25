// Calls and copy for the Settings > Workspace tab. The three procs used here
// (workspace_update, workspace_client_domain_add/remove) have no @srtdio/rpc
// wrapper, so they are called directly with the args object passed through as
// the wrappers do (p_trace_id included); workspace_delete has its wrapper.
// Each proc raises its domain code as the error message;
// the helpers below turn those codes into user-facing copy.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { clearOpenCache } from '@/lib/chat/open-cache';
import { pruneDrafts } from '@/lib/chat/drafts';
import { writePersistedOutbox, type OutboxStorage } from '@/lib/chat/chat-store';
import { domainBrandWord } from './members-data';

/**
 * The editable workspace fields, as workspace_update's payload keys: the
 * timezone only. The brand name and platform are final after creation
 * (workspace_update refuses name with invalid_payload) and there is no
 * workspace logo at launch, so none of those is ever sent.
 */
export interface WorkspaceUpdatePayload {
  timezone: string;
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
    p_payload: { timezone: input.payload.timezone } satisfies Json,
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
      return "Couldn't save that. You don't have access to do this.";
    case 'not_found':
      return "Couldn't save that. It was deleted.";
    default:
      return "Couldn't save that. Try again.";
  }
}

/** Copy for a failed workspace_update. */
export function workspaceUpdateErrorMessage(code: string): string {
  switch (code) {
    case 'forbidden_role':
      return "Couldn't save. You don't have access to do this.";
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

/** What a non-owner sees in place of Delete workspace. */
export const DELETE_OWNER_ONLY_LINE = 'Only the owner can delete this workspace.';

export function deleteWorkspaceTitle(name: string): string {
  return `Delete ${name} for good?`;
}

export function deleteWorkspaceBody(name: string): string {
  return `Every post, file, chat, brief and approval in ${name} is deleted now. Nothing is saved, there is no Recently deleted for a workspace, and this can't be undone. Members lose access immediately.`;
}

export function deleteWorkspaceHint(name: string): string {
  return `Type ${name} to confirm`;
}

/** Delete permanently is enabled only on an exact match of the brand name. */
export function canConfirmWorkspaceDelete(typed: string, name: string): boolean {
  return typed === name;
}

export function workspaceDeletedToast(name: string): string {
  return `${name} deleted for good`;
}

/** Copy for a failed workspace_delete, shown inline in the sheet. */
export function workspaceDeleteErrorMessage(code: string): string {
  return code === 'owner_only'
    ? "Couldn't delete. You don't have access to do this."
    : "Couldn't delete. Try again.";
}

function localStorageOrNull(): OutboxStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Forget a deleted workspace on this device: the remembered chats and their
 * stashed reads, its chat drafts and its slot of the pending outbox. Its chat
 * connection closes on its own once it is no longer the active workspace.
 */
export function clearDeletedWorkspaceData(workspaceId: string, userId: string): void {
  clearOpenCache();
  pruneDrafts(workspaceId, new Set());
  writePersistedOutbox(localStorageOrNull(), { workspaceId, userId }, {});
}
