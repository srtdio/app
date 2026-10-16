// FROZEN CONTRACTS (Lead-owned) for the catch-up email, server side.
//
// Types and signatures only. Builders implement against these; testers test
// against them; nobody but the Lead edits this file. The render, token and
// unsubscribe-API contracts live in packages/inbox/src/catchup-contracts.ts
// (re-exported below) so the package and the SPA can share them.
//
// Phase 0 answer, edge functions and packages/: NO. The deployed edge
// functions are self-contained (no @srtdio/* imports: the Deno edge bundler
// rejects the packages' extensionless relative imports). The unsubscribe edge
// function keeps its own token verify; both runtimes assert the shared
// UNSUBSCRIBE_TEST_VECTOR.
//
// Module map (one owner per file):
//   catchup-schedule.ts  (G1)  decideSlot
//   catchup-send.ts      (G2)  reads, tenant scoping, digest assembly, `export default { scheduled }`
//   catchup-deliver.ts   (G3)  trial gate, idempotency key, headers, Resend send, ledger + stamp
//   @srtdio/inbox catchup.ts           (G4)  renderCatchupEmail: DigestRenderer
//   @srtdio/inbox unsubscribe-token.ts (G5)  UnsubscribeTokenApi

import type { logger } from '@/server/logger';
import type { LocalSlotDate, PreviousSlot, RenderedEmail, Slot } from '@srtdio/inbox';

/** The shared backend logger's shape (src/server/logger.ts exports no type). */
export type Logger = typeof logger;

export type {
  CatchupAudience,
  CommentItem,
  DigestCounts,
  DigestRenderer,
  DmItem,
  LocalSlotDate,
  PostItem,
  PreviousSlot,
  RecipientDigest,
  RenderedEmail,
  Section,
  Slot,
  StageItem,
  UnsubscribeJsonRequest,
  UnsubscribeStatus,
  UnsubscribeTokenApi,
} from '@srtdio/inbox';

// --- env (all Worker secrets; never committed) ------------------------------

export interface CatchupEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  APP_BASE_URL: string;
  CATCHUP_FROM_ADDRESS: string;
  UNSUBSCRIBE_SIGNING_SECRET: string;
  /** "trial" or "live". Anything else (or missing) crashes the tick early. */
  CATCHUP_MODE: string;
  /** Comma-separated user ids. Required non-empty in trial mode. */
  CATCHUP_TRIAL_USER_IDS?: string;
}

// --- schedule (G1: catchup-schedule.ts) -------------------------------------

/** Half-open instant range [start, end). */
export interface Window {
  /** Previous slot's instant (UTC ISO). Mon 10:30 -> Fri 15:30. */
  start: string;
  /** This slot's instant (UTC ISO). */
  end: string;
}

export type SlotSkipReason = 'no_timezone' | 'invalid_timezone' | 'weekend' | 'not_slot_time';

export type SlotDecision =
  | {
      send: true;
      slot: Slot;
      /** Recipient-local date of this slot. */
      local: LocalSlotDate;
      previous: PreviousSlot;
      window: Window;
    }
  | { send: false; reason: SlotSkipReason };

/**
 * Pure. `timezone` = users.timezone ?? workspaces.timezone (null when both are
 * null: returns no_timezone; the caller logs and skips, never guesses).
 * Sends when the local time is in [slot, slot + 30 min) on a local Mon-Fri.
 */
export type DecideSlot = (timezone: string | null, now: Date) => SlotDecision;

// --- delivery (G3: catchup-deliver.ts) --------------------------------------

export type CatchupGate = { mode: 'live' } | { mode: 'trial'; userIds: ReadonlySet<string> };

/**
 * Throws (send nothing) when CATCHUP_MODE is missing/invalid, or when mode is
 * trial and CATCHUP_TRIAL_USER_IDS has no ids. Also throws when any other
 * required env value in CatchupEnv is missing or blank.
 */
export type ResolveCatchupGate = (env: CatchupEnv) => CatchupGate;

/** "catchup:{user_id}:{workspace_id}:{local date YYYY-MM-DD}:{slot}" */
export type BuildIdempotencyKey = (
  userId: string,
  workspaceId: string,
  localIsoDate: string,
  slot: Slot,
) => string;

/** Returns exactly { 'List-Unsubscribe': '<{oneClickUrl}>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }. */
export type BuildUnsubscribeHeaders = (oneClickUrl: string) => Record<string, string>;

export interface OutboundEmail {
  to: string;
  from: string;
  rendered: RenderedEmail;
  idempotencyKey: string;
  headers: Record<string, string>;
}

/** One delivery_attempts row. */
export interface DeliveryAttemptRow {
  workspace_id: string;
  user_id: string;
  channel: 'email';
  template_key: 'catch-up';
  provider: 'resend';
  provider_message_id: string | null;
  status: 'sent' | 'failed';
  sent_at: string | null;
  error: string | null;
}

/** DB writes the deliverer needs; G3 also provides the Supabase-backed impl. */
export interface DeliveryStore {
  recordAttempt(row: DeliveryAttemptRow): Promise<void>;
  /** UPDATE inbox_entries SET email_sent_at = atIso WHERE id IN (entryIds) AND user_id = userId. */
  stampSent(userId: string, entryIds: readonly string[], atIso: string): Promise<void>;
}

export type DeliveryResult = { ok: true; providerMessageId: string } | { ok: false; error: string };

export interface DeliverRequest {
  userId: string;
  workspaceId: string;
  email: OutboundEmail;
  /** inbox_entries ids included in this email (stamped only on success). */
  entryIds: readonly string[];
}

export interface Deliverer {
  /**
   * POST to Resend with Idempotency-Key + X-Trace-Id, then: success -> stamp
   * entries + record 'sent'; failure -> record 'failed', no stamp, log.
   * Never throws for a provider failure (returns ok:false).
   */
  deliver(req: DeliverRequest): Promise<DeliveryResult>;
}

export interface DelivererDeps {
  env: CatchupEnv;
  store: DeliveryStore;
  /** uuid_v7 for this tick; sent as X-Trace-Id on every outbound call. */
  traceId: string;
  log: Logger;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected clock for sent_at / stamp; defaults to () => new Date(). */
  now?: () => Date;
}

export type CreateDeliverer = (deps: DelivererDeps) => Deliverer;

// G3 module exports (catchup-deliver.ts), by name:
//   resolveCatchupGate: ResolveCatchupGate
//   buildIdempotencyKey: BuildIdempotencyKey
//   buildUnsubscribeHeaders: BuildUnsubscribeHeaders
//   createDeliverer: CreateDeliverer
//   createSupabaseDeliveryStore: (client: CatchupDbClient) => DeliveryStore
//   CATCHUP_TEMPLATE_KEY = 'catch-up'

// --- orchestration (G2: catchup-send.ts) ------------------------------------

/**
 * The ONLY Supabase client surface the catch-up job may use, so the G2 test
 * fake can implement it in memory. Reads: from(t).select(cols) chained with
 * eq / neq / in / is(col, null) / not(col, 'is', null) / gte / gt / lt / lte /
 * order / range, awaited as { data, error }. Writes (G3 store only):
 * from(t).insert(row) and from(t).update(patch).eq(..).in(..). No .or(), no
 * .rpc(), no .single(), no filters on json columns. A real SupabaseClient
 * (service role, no Database generic) satisfies it structurally.
 */
export type CatchupDbClient = Pick<import('@supabase/supabase-js').SupabaseClient, 'from'>;

export interface RunCatchupDeps {
  client: CatchupDbClient;
  env: CatchupEnv;
  /** Already resolved by resolveCatchupGate (which crashes early on bad env). */
  gate: CatchupGate;
  deliverer: Deliverer;
  /** auth.users email for one recipient; null when none. Real impl: auth.admin.getUserById. */
  getEmail(userId: string): Promise<string | null>;
  now: Date;
  log: Logger;
}

export interface CatchupTickResult {
  sent: number;
  failed: number;
  skipped: number;
}

// G2 module exports (catchup-send.ts), by name:
//   CATCHUP_EVENT_TYPES (readonly tuple; must stay a subset of INBOX_EVENT_TYPES;
//     src/lib/inbox/event-types.test.ts imports it from here)
//   runCatchup: (deps: RunCatchupDeps) => Promise<CatchupTickResult>
//   handleScheduled: (env: CatchupEnv, now?: Date) => Promise<CatchupTickResult>
//   default { scheduled(controller, env): Promise<void> }
