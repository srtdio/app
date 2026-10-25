// Fixture world for the PR B before/after screenshots (e2e/audit). On top of
// the shared chat world it seeds a post in every stage for Pipeline, briefs,
// library files and Recently deleted, and the chat PostSheet's subject: the
// newest DM message with Priya shares Monday carousel (in review), so the post
// card sits at the bottom of the thread and a tap opens the sheet. Roles: the
// creator view is the shared world (ME owner, agency side); the approver view
// makes ME a client and Priya agency side.

import type { HarnessNetwork } from './harness-routes';
import type { Row } from './postgrest';
import { BUCKET_ID, DM_CHANNEL, ME, PEER, POST_IDS, WORKSPACE_ID } from './chat-data';
import { seedRecentlyDeleted } from './assets-recently-deleted';

export type AuditRole = 'creator' | 'approver';

export interface AuditSeedOptions {
  role: AuditRole;
  /** No briefs at all (the zero state). */
  noBriefs?: boolean;
  /** No library files and nothing in Recently deleted (the zero state). */
  noAssets?: boolean;
}

/** The DM message that shares Monday carousel last (the PostSheet's card). */
export const AUDIT_CARD_MESSAGE_ID = '0190b000-0000-7000-8a00-000000000001';
/** The brief the brief screens open. */
export const AUDIT_BRIEF_ID = '0190da00-0000-7000-8a00-000000000001';
/** The extra posts, one per remaining stage. */
export const AUDIT_POST_IDS = {
  draft: '0190e000-0000-7000-8a00-000000000001',
  approved: '0190e000-0000-7000-8a00-000000000002',
  parked: '0190e000-0000-7000-8a00-000000000003',
  rejected: '0190e000-0000-7000-8a00-000000000004',
} as const;

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function postRow(id: string, number: number, title: string, stage: string, now: number): Row {
  return {
    id,
    number,
    workspace_id: WORKSPACE_ID,
    title,
    caption: 'Fixture caption',
    bucket_id: BUCKET_ID,
    owner_user_id: ME,
    platform: 'linkedin',
    format: 'image',
    stage,
    stage_entered_at: iso(now - 26 * HOUR),
    approved_by: stage === 'approved' ? PEER : null,
    approved_at: stage === 'approved' ? iso(now - 26 * HOUR) : null,
    target_date: iso(now + 4 * 24 * HOUR),
    origin: 'manual',
    brief_id: null,
    row_version: 1,
    created_by: ME,
    legacy_author_name: null,
    created_at: iso(now - 6 * 24 * HOUR),
    updated_at: iso(now - 26 * HOUR),
    deleted_at: null,
    post_versions: [],
    post_annotations: [],
  };
}

function briefRow(id: string, number: number, title: string, agoHours: number, now: number): Row {
  return {
    id,
    number,
    workspace_id: WORKSPACE_ID,
    title,
    objective: 'Launch the autumn range to existing customers with one clear offer.',
    format_requested: 'carousel',
    brand_requirements: 'Brand blue, no stock photos.',
    target_date: iso(now + 7 * 24 * HOUR),
    reference_links: null,
    status: 'open',
    closed_at: null,
    closed_by: null,
    created_by: PEER,
    legacy_author_name: null,
    created_via: 'app',
    row_version: 1,
    updated_at: iso(now - agoHours * HOUR),
    created_at: iso(now - agoHours * HOUR),
    deleted_at: null,
  };
}

/** Seed the audit world into the installed harness network. */
export function seedAudit(
  network: HarnessNetwork,
  opts: AuditSeedOptions,
  now: number = Date.now(),
): void {
  const t = network.world.tables;

  if (opts.role === 'approver') {
    for (const m of t.workspace_members ?? []) {
      if (m.user_id === ME) m.role = 'client';
      if (m.user_id === PEER) m.role = 'agency';
    }
  }

  (t.posts ??= []).push(
    postRow(AUDIT_POST_IDS.draft, 110, 'Holiday hours card', 'draft', now),
    postRow(AUDIT_POST_IDS.approved, 111, 'Customer quote tile', 'approved', now),
    postRow(AUDIT_POST_IDS.parked, 112, 'Behind the scenes reel', 'parked', now),
    postRow(AUDIT_POST_IDS.rejected, 113, 'Price list update', 'rejected', now),
  );

  if (opts.noBriefs !== true) {
    (t.briefs ??= []).push(
      briefRow(AUDIT_BRIEF_ID, 301, 'Autumn range launch', 2, now),
      briefRow('0190da00-0000-7000-8a00-000000000002', 302, 'Store opening week', 20, now),
      briefRow('0190da00-0000-7000-8a00-000000000003', 303, 'Founder story series', 50, now),
    );
  }

  if (opts.noAssets !== true) seedRecentlyDeleted(network, now);

  // The chat PostSheet's subject: the DM's newest message shares Monday
  // carousel (in review), so its card paints at the bottom of the thread.
  (t.chat_messages ??= []).push({
    id: AUDIT_CARD_MESSAGE_ID,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: opts.role === 'approver' ? PEER : ME,
    body: 'Ready for your look',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: [POST_IDS[0]],
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: iso(now - 60_000),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  });
}
