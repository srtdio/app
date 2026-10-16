// FROZEN CONTRACTS (Lead-owned) for the catch-up email, package side.
//
// Types and signatures only: no runtime logic beyond the constants below. The
// server-side contracts (schedule, delivery, env) live in
// src/server/cron/catchup-contracts.ts, which re-exports this file. Builders
// implement against these shapes; testers write tests against them. Nobody
// but the Lead edits this file.
//
// Edge functions and packages/: the deployed edge functions (invite-send,
// invite-accept, brand-request-send) are self-contained with NO @srtdio/*
// imports, because the Deno edge bundler rejects the packages' extensionless
// relative imports. So supabase/functions/catchup-unsubscribe keeps its own
// copy of the token verify and the API shapes below, and both suites assert
// one shared fixed test vector (UNSUBSCRIBE_TEST_VECTOR) instead of sharing
// code.

import type { Role } from './types';

// --- slots ------------------------------------------------------------------

/** Local wall-clock slot. 10:30 is the morning catch-up, 15:30 the afternoon. */
export type Slot = '10:30' | '15:30';
export const CATCHUP_SLOTS: readonly Slot[] = ['10:30', '15:30'];

/** Recipient-local calendar facts for one slot, computed by the schedule. */
export interface LocalSlotDate {
  /** YYYY-MM-DD in the recipient's zone. Part of the idempotency key. */
  isoDate: string;
  /** Full English weekday, e.g. "Monday". */
  weekday: string;
  /** Day of month, 1-31. */
  day: number;
  /** Short English month, e.g. "Oct". */
  month: string;
}

/** The slot a window starts from (the previous slot). */
export interface PreviousSlot {
  slot: Slot;
  /** Full English weekday of the previous slot's local date, e.g. "Friday". */
  weekday: string;
  /** True when the previous slot is earlier the same local day (15:30 window). */
  sameDay: boolean;
}

// --- digest (G2 builds, G4 renders) ----------------------------------------

/**
 * Audience derived from the recipient's workspace_members.role. 'agency' covers
 * every role in AGENCY_ROLES (./types); 'client' is every other role. Never
 * compare against role string literals: use AGENCY_ROLES.
 */
export type CatchupAudience = 'client' | 'agency';

export interface PostItem {
  postId: string;
  title: string;
  /** Deep link built with buildCatchupUrls(...).post. */
  url: string;
  /** posts.stage_entered_at (ISO), for "oldest first, with age". */
  stageEnteredAt: string;
}

export interface CommentItem {
  /** Display name of the comment author ("Someone" when unknown). */
  actorName: string;
  /** Title of the post or brief the comment is on. */
  targetTitle: string;
  entityType: 'post' | 'brief';
  entityId: string;
  /** Deep link built with buildCatchupUrls(...).comment (or .post/.brief without a comment id). */
  url: string;
  /** inbox_entries.created_at (ISO). */
  createdAt: string;
  /** True for a mention event, false for a plain comment. */
  mention: boolean;
}

export interface StageItem {
  postId: string;
  title: string;
  url: string;
  toStage: 'approved' | 'parked' | 'rejected';
  createdAt: string;
}

export interface DmItem {
  channelId: string;
  senderUserId: string;
  senderName: string;
  /** Unread messages from this sender after the recipient's read cursor. */
  unreadCount: number;
  /**
   * Latest unread message body, RAW (may hold @[uuid] mention tokens). The
   * renderer turns it into a one-line plain-text preview; null when the
   * latest message has no text (attachment only).
   */
  latestBody: string | null;
  /** Deep link built with buildCatchupUrls(...).chat(channelId). */
  url: string;
}

/** A capped list: items are pre-sorted; total is the uncapped count. */
export interface Section<T> {
  items: T[];
  total: number;
}

export interface DigestCounts {
  /** Client: posts in review. Agency: posts in review waiting on the client. */
  inReview: number;
  /** Total unread DM messages across DmItems. */
  unreadMessages: number;
  /** Comment + mention entries in the window. */
  comments: number;
  /** stage_change to approved in the window. */
  approved: number;
  /** stage_change to parked in the window. */
  parked: number;
  /** brief_created entries in the window. */
  newBriefs: number;
}

/** One email: one user, one workspace, one slot. */
export interface RecipientDigest {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  /** The recipient's workspace_members.role in this workspace. */
  role: Role;
  audience: CatchupAudience;
  slot: Slot;
  local: LocalSlotDate;
  previous: PreviousSlot;
  /** APP_BASE_URL, for buildCatchupUrls in the renderer. Never hardcoded. */
  appBaseUrl: string;
  /** {APP_BASE_URL}/unsubscribe?u=..&t=.. (footer link). */
  unsubscribeUrl: string;
  /** user id -> display name, for @[uuid] tokens in DM previews. */
  mentionNames: Record<string, string>;
  counts: DigestCounts;
  /** stage review posts, client: newest first; agency: oldest first. Never a draft. */
  review: Section<PostItem>;
  /** Comment and mention entries in the window, newest first. */
  comments: Section<CommentItem>;
  /** stage_change to approved in the window, newest first. */
  approved: Section<StageItem>;
  dms: Section<DmItem>;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Implemented by renderCatchupEmail in ./catchup.ts. Pure: no I/O, no clock. */
export type DigestRenderer = (digest: RecipientDigest) => RenderedEmail;

/** Max rows per section before "+N more in Sorted". */
export const SECTION_ROW_CAP = 5;
/** Max DM preview characters before "...". */
export const DM_PREVIEW_MAX = 90;

// --- unsubscribe token (G5) -------------------------------------------------

/**
 * Token = base64url (no padding) of HMAC-SHA256(key = secret, message =
 * user_id), via Web Crypto. Verify is constant-time. No expiry.
 */
export interface UnsubscribeTokenApi {
  signUnsubscribeToken(userId: string, secret: string): Promise<string>;
  verifyUnsubscribeToken(userId: string, token: string, secret: string): Promise<boolean>;
  /** {appBaseUrl}/unsubscribe?u={userId}&t={token} (trailing slash on base tolerated). */
  buildUnsubscribePageUrl(appBaseUrl: string, userId: string, token: string): string;
  /** {supabaseUrl}/functions/v1/catchup-unsubscribe?u={userId}&t={token}. */
  buildOneClickUrl(supabaseUrl: string, userId: string, token: string): string;
}

/**
 * Shared fixed vector asserted by BOTH the package suite and the edge function
 * suite. token = signUnsubscribeToken(userId, secret). Test-only values.
 */
export const UNSUBSCRIBE_TEST_VECTOR = {
  userId: '00000000-0000-4000-8000-000000000001',
  secret: 'test-signing-secret',
  token: '1cG5xz_Fx7sb5-I-ZIlG4AnHelpNwVy1BIFj-JwhriU',
} as const;

// --- unsubscribe HTTP API (edge function catchup-unsubscribe) ---------------

/** Path under {SUPABASE_URL}/functions/v1/. */
export const UNSUBSCRIBE_FUNCTION_NAME = 'catchup-unsubscribe';

/**
 * GET ?u={user_id}&t={token}
 *   200 UnsubscribeStatus. Never writes.
 *   404 empty body: bad, missing or tampered token, or unknown user.
 */
export interface UnsubscribeStatus {
  subscribed: boolean;
}

/**
 * POST ?u=..&t=.. with Content-Type application/x-www-form-urlencoded and body
 * exactly "List-Unsubscribe=One-Click" (RFC 8058): sets email_opt_in=false,
 * 200 empty body. Bad token: 404 empty body.
 */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

/**
 * POST Content-Type application/json, body UnsubscribeJsonRequest:
 *   200 UnsubscribeStatus after setting email_opt_in (unsubscribe -> false,
 *   resubscribe -> true). Bad token: 404 empty. Malformed body: 400 empty.
 */
export interface UnsubscribeJsonRequest {
  u: string;
  t: string;
  action: 'unsubscribe' | 'resubscribe';
}
