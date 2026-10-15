// The induction's network calls. The induction procs and brand_agency_request
// have no @srtdio/rpc wrapper, so they are called directly with the args object
// passed through as the wrappers do (p_trace_id included), like
// src/components/pages/settings/workspace-settings-data.ts. Every read fails
// soft: the guide is never the reason a screen breaks.

import type { Client, Result } from '@srtdio/rpc';
import {
  FAIL_OPEN_STATE,
  parseInductionState,
  STEP_ID_PATTERN,
  type InductionState,
} from '@/lib/induction';
import { logger } from '@/lib/logger';

/** induction_state for the caller; p_workspace_id is null before a workspace exists. */
export async function readInductionState(
  client: Client,
  input: { workspaceId: string | null; traceId: string },
): Promise<InductionState> {
  // The generated Args type says string; the proc takes null before a workspace exists.
  const args = { p_workspace_id: input.workspaceId, p_trace_id: input.traceId } as {
    p_workspace_id: string;
    p_trace_id: string;
  };
  try {
    const { data, error } = await client.rpc('induction_state', args);
    if (error) {
      logger.warn('induction_state read failed', { error: error.message, trace_id: input.traceId });
      return FAIL_OPEN_STATE;
    }
    return parseInductionState(data);
  } catch (err: unknown) {
    logger.warn('induction_state read threw', { error: String(err), trace_id: input.traceId });
    return FAIL_OPEN_STATE;
  }
}

/** induction_step_set: the caller's current teach step. */
export async function storeInductionStep(
  client: Client,
  input: { step: string; traceId: string },
): Promise<Result<null>> {
  if (!STEP_ID_PATTERN.test(input.step)) {
    return { ok: false, error: { code: 'invalid_payload', message: 'invalid_payload' } };
  }
  const args = { p_step: input.step, p_trace_id: input.traceId };
  const { error } = await client.rpc('induction_step_set', args);
  if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
  return { ok: true, data: null };
}

/** induction_finish: stamps induction_done_at for the caller. */
export async function finishInduction(client: Client, traceId: string): Promise<Result<null>> {
  const args = { p_trace_id: traceId };
  const { error } = await client.rpc('induction_finish', args);
  if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
  return { ok: true, data: null };
}

/** The brand-request-send failure code, read from the function's JSON reply. */
async function readFunctionErrorCode(error: unknown): Promise<string> {
  if (typeof error !== 'object' || error === null || !('context' in error)) return 'unknown';
  const context = (error as { context: unknown }).context;
  if (!(context instanceof Response)) return 'unknown';
  try {
    const body: unknown = await context.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const code = (body as { error: unknown }).error;
      if (typeof code === 'string') return code;
    }
  } catch {
    // Not JSON: fall through to unknown.
  }
  return 'unknown';
}

/**
 * brand-request-send: records who makes the approver's posts (brand_agency_request,
 * as the caller) and emails them a sign-up link. Returns the request id.
 */
export async function requestBrandTeam(
  client: Client,
  input: { email: string; brandName: string; traceId: string },
): Promise<Result<string>> {
  try {
    const { data, error } = await client.functions.invoke<{ request_id?: string }>(
      'brand-request-send',
      {
        body: { email: input.email.trim(), brand_name: input.brandName.trim() },
        headers: { 'x-trace-id': input.traceId },
      },
    );
    if (error) {
      const code = await readFunctionErrorCode(error);
      return { ok: false, error: { code: 'unknown', message: code } };
    }
    if (typeof data?.request_id !== 'string') {
      return { ok: false, error: { code: 'unknown', message: 'unknown' } };
    }
    return { ok: true, data: data.request_id };
  } catch (err: unknown) {
    return { ok: false, error: { code: 'unknown', message: String(err) } };
  }
}

/** The caller's latest brand team request, for the waiting screen's Resend. */
export async function readLatestBrandRequest(
  client: Client,
  userId: string,
): Promise<{ email: string; brandName: string } | undefined> {
  const { data, error } = await client
    .from('brand_agency_requests')
    .select('agency_email, brand_name')
    .eq('requested_by', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || data === null) return undefined;
  return { email: data.agency_email, brandName: data.brand_name ?? '' };
}

export interface DefaultGroup {
  name: string;
  channelId: string;
}

/** The workspace's default group and its chat channel (both RLS-scoped). */
export async function readDefaultGroup(
  client: Client,
  workspaceId: string,
): Promise<DefaultGroup | undefined> {
  const group = await client
    .from('groups')
    .select('id, name')
    .eq('workspace_id', workspaceId)
    .eq('is_default', true)
    .is('deleted_at', null)
    .maybeSingle();
  if (group.error || group.data === null) return undefined;
  const channel = await client
    .from('chat_channels')
    .select('channel_id')
    .eq('workspace_id', workspaceId)
    .eq('channel_type', 'group')
    .eq('entity_id', group.data.id)
    .maybeSingle();
  if (channel.error || channel.data === null) return undefined;
  return { name: group.data.name, channelId: channel.data.channel_id };
}

/** The oldest post waiting in review, for the approver's post steps. */
export async function readOldestReviewPost(
  client: Client,
  workspaceId: string,
): Promise<string | undefined> {
  const { data, error } = await client
    .from('posts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('stage', 'review')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || data === null) return undefined;
  return data.id;
}
