// The induction's network calls. brand_agency_request goes through the
// brand-request-send edge function, which also sends the email. The induction
// procs have no @srtdio/rpc wrapper, so they are called directly with the args object
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
import { registerStaticAssets, staticThumbs, warmImages } from '@/lib/static-assets';
import { generateTraceId as newTraceId } from '@/lib/trace';

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
  try {
    return await readDefaultGroupRows(client, workspaceId);
  } catch {
    return undefined;
  }
}

async function readDefaultGroupRows(
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

export interface ReviewPost {
  id: string;
  title: string;
  /** The display name of the person who made the post; '' when unknown. */
  creatorName: string;
}

/** A user's display name ('' when unreadable). */
async function readDisplayName(client: Client, userId: string | null): Promise<string> {
  if (userId === null) return '';
  try {
    const { data, error } = await client
      .from('users')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle();
    return error || data === null ? '' : data.display_name;
  } catch {
    return '';
  }
}

/** The oldest post waiting in review, for the approver's review steps, with its title and creator. */
export async function readOldestReviewPost(
  client: Client,
  workspaceId: string,
  samplePostIds: readonly string[] = [],
): Promise<ReviewPost | undefined> {
  try {
    // The sample week's posts never stand in for the real one the approver reviews.
    let query = client
      .from('posts')
      .select('id, title, created_by')
      .eq('workspace_id', workspaceId)
      .eq('stage', 'review')
      .is('deleted_at', null);
    if (samplePostIds.length > 0) query = query.not('id', 'in', `(${samplePostIds.join(',')})`);
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || data === null) return undefined;
    const creatorName = await readDisplayName(client, data.created_by);
    return { id: data.id, title: data.title, creatorName };
  } catch {
    return undefined;
  }
}

/** One post's title ('' when unreadable): the creator's own first post for the copy. */
export async function readPostTitle(client: Client, postId: string): Promise<string> {
  try {
    const { data, error } = await client
      .from('posts')
      .select('title')
      .eq('id', postId)
      .maybeSingle();
    return error || data === null ? '' : data.title;
  } catch {
    return '';
  }
}

/** Whether the workspace holds any brief that is not deleted. */
export async function readHasBrief(client: Client, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from('briefs')
      .select('id')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .limit(1);
    return !error && (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a plan card sits in the default group's chat (a chat_messages row
 * carrying shared_plan_ids): the plan step boxes that card's Open plan.
 */
export async function readHasPlanCard(client: Client, channelId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from('chat_messages')
      .select('id')
      .eq('channel_id', channelId)
      .is('deleted_at', null)
      .not('shared_plan_ids', 'is', null)
      .limit(1);
    return !error && (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** True when one attachment_meta entry is a voice note: an audio mime or a recorded length. */
function metaHasVoice(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false;
  return Object.values(meta as Record<string, unknown>).some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    const mime = typeof record.mime === 'string' ? record.mime : '';
    return mime.startsWith('audio/') || typeof record.duration_ms === 'number';
  });
}

/** How many recent group messages the voice note check looks through. */
const VOICE_SCAN_LIMIT = 100;

/** Whether the default group's chat mirror holds a voice note (attachment_meta, as chat search reads it). */
export async function readHasVoiceNote(client: Client, channelId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from('chat_messages')
      .select('attachment_meta')
      .eq('channel_id', channelId)
      .is('deleted_at', null)
      .not('attachment_meta', 'is', null)
      .order('created_at', { ascending: false })
      .limit(VOICE_SCAN_LIMIT);
    if (error) return false;
    return (data ?? []).some((row) => metaHasVoice(row.attachment_meta));
  } catch {
    return false;
  }
}

/**
 * The onboarding sample week (Kestrel & Rowe) in this workspace, from its
 * markers (owner-readable): whether it is there, and the post the Review
 * chapter comments on. Absent markers read as no sample.
 */
export interface SampleWeek {
  seeded: boolean;
  reviewPostId: string | null;
  /** Every sample post, so a real post is never mistaken for one (and the reverse). */
  postIds: readonly string[];
}

export const NO_SAMPLE: SampleWeek = { seeded: false, reviewPostId: null, postIds: [] };

export async function readSampleWeek(client: Client, workspaceId: string): Promise<SampleWeek> {
  try {
    const { data, error } = await client
      .from('induction_sample_rows')
      .select('kind,row_id,tag')
      .eq('workspace_id', workspaceId)
      .in('kind', ['post', 'member'])
      .limit(200);
    if (error || data === null || data.length === 0) return NO_SAMPLE;
    const review = data.find((row) => row.tag === 'review_post');
    return {
      seeded: true,
      reviewPostId: review !== undefined ? String(review.row_id) : null,
      postIds: data.filter((row) => row.kind === 'post').map((row) => String(row.row_id)),
    };
  } catch {
    return NO_SAMPLE;
  }
}

/** induction_sample_seed: fills a new owner's workspace with the sample week (a no-op once seeded or cleared). */
export async function seedSampleWeek(
  client: Client,
  input: { workspaceId: string; traceId: string },
): Promise<boolean> {
  try {
    const args = { p_workspace_id: input.workspaceId, p_trace_id: input.traceId };
    const { error } = await client.rpc('induction_sample_seed', args);
    if (error) {
      logger.warn('sample week seed failed', { error: error.message, trace_id: input.traceId });
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.warn('sample week seed threw', { error: String(err), trace_id: input.traceId });
    return false;
  }
}

/** induction_sample_clear: removes every sample row and person; the person's own work stays. */
export async function clearSampleWeek(
  client: Client,
  input: { workspaceId: string; traceId: string },
): Promise<boolean> {
  try {
    const args = { p_workspace_id: input.workspaceId, p_trace_id: input.traceId };
    const { error } = await client.rpc('induction_sample_clear', args);
    if (error) {
      logger.warn('sample week clear failed', { error: error.message, trace_id: input.traceId });
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.warn('sample week clear threw', { error: String(err), trace_id: input.traceId });
    return false;
  }
}

/** What the guide reads about the workspace while it runs; every field fails soft. */
export interface GuideFactsRead {
  /** The sample week in this workspace (any route's tour seeds it). */
  sample: SampleWeek;
  group: DefaultGroup | undefined;
  /** Approver route only. */
  reviewPost: ReviewPost | undefined;
  hasBrief: boolean;
  hasPlan: boolean;
  hasVoiceNote: boolean;
  /** The creator's or invited member's own first post title; '' when none. */
  ownPostTitle: string;
}

/**
 * The default group never changes during a tour: once found it is kept, so a
 * later read skips two dependent round trips (groups, then its channel).
 */
const knownGroups = new Map<string, DefaultGroup>();

/** Forget the kept default groups (tests). */
export function forgetKnownGroups(): void {
  knownGroups.clear();
}

async function readGroupOnce(
  client: Client,
  workspaceId: string,
): Promise<DefaultGroup | undefined> {
  const known = knownGroups.get(workspaceId);
  if (known !== undefined) return known;
  const group = await readDefaultGroup(client, workspaceId);
  if (group !== undefined) knownGroups.set(workspaceId, group);
  return group;
}

/**
 * Reads every guide fact for one workspace (read-only, RLS-scoped). Every read
 * that does not need another's answer goes out at once: one round trip when the
 * default group is known.
 */
export async function readGuideFacts(
  client: Client,
  input: { workspaceId: string; approver: boolean; postId: string | null },
): Promise<GuideFactsRead> {
  const { workspaceId, approver, postId } = input;
  const samplePromise = readSampleWeek(client, workspaceId);
  const groupFacts = readGroupOnce(client, workspaceId).then(async (group) => {
    if (group === undefined) return { group, hasPlan: false, hasVoiceNote: false };
    const [hasPlan, hasVoiceNote] = await Promise.all([
      readHasPlanCard(client, group.channelId),
      readHasVoiceNote(client, group.channelId),
    ]);
    return { group, hasPlan, hasVoiceNote };
  });
  const [sample, { group, hasPlan, hasVoiceNote }, reviewPost, hasBrief, ownPostTitle] =
    await Promise.all([
      samplePromise,
      groupFacts,
      approver
        ? samplePromise.then((week) => readOldestReviewPost(client, workspaceId, week.postIds))
        : Promise.resolve(undefined),
      readHasBrief(client, workspaceId),
      postId !== null ? readPostTitle(client, postId) : Promise.resolve(''),
    ]);
  return { group, reviewPost, hasBrief, hasPlan, hasVoiceNote, ownPostTitle, sample };
}

/**
 * The sample week's files ship with the app: remember their versions as static
 * (no presign round trip) and fetch their small copies now, so the pipeline's
 * photos paint the moment it renders. Fails soft: they then presign as usual.
 */
export async function loadSampleAssets(client: Client, workspaceId: string): Promise<void> {
  try {
    // Through the proc: asset_versions RLS shows library files only, and the
    // week's chat photos and voice note need their keys too.
    const args = { p_workspace_id: workspaceId, p_trace_id: newTraceId() };
    const { data, error } = await client.rpc('induction_sample_files', args);
    if (error || data === null) return;
    registerStaticAssets(data);
    warmImages(staticThumbs());
  } catch {
    // Presign as usual.
  }
}
