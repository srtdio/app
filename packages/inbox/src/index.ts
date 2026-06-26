// @srtdio/inbox: the notification fan-out toolkit used by the inbox-writer
// Worker. Pure derivation (computeRecipients, extractMentions, buildEnvelope)
// is separated from the single service-role write path (writeInboxEntry) and
// from I/O helpers (the Supabase reader, acting-member auth, the KV dedupe key)
// so the derivation logic is unit-testable without a database.

// --- public surface named by the PR ----------------------------------------
export { writeInboxEntry } from './write';
export { computeRecipients } from './recipients';
export { extractMentions } from './mentions';

// --- supporting pieces consumed by the Worker and the test suite ------------
export { buildEnvelope } from './envelope';
export { dedupeKey } from './idempotency';
export { createSupabaseReader, resolveActingMember } from './reader';
export { createActingClient, mintServiceRoleToken } from './acting';
export { isActionable, stageChanged, resolvedFlipped, briefClosed, stageTier } from './transitions';

// --- catch-up email core (pure render + helpers; no I/O) --------------------
export {
  summarizeCatchup,
  renderCatchupEmail,
  buildCatchupUrls,
  isInSendWindow,
  shouldShowCounts,
  countCells,
} from './catchup';

export type { RecipientReader } from './recipients';
export type { RpcClient, InboxEntryInput } from './write';
export type { ActingClientOptions } from './acting';
export type {
  ChangeEvent,
  Envelope,
  Fanout,
  Recipient,
  Role,
  Json,
  InboxEventType,
  InboxEntityType,
  InboxScope,
  InboxTier,
  CommentRow,
  PostRow,
  BriefRow,
  AssetRow,
  AssetVersionRow,
  WorkspaceMemberRow,
} from './types';
export { AGENCY_ROLES, ADMIN_ROLES } from './types';

export type {
  CatchupRow,
  ChatRow,
  CatchupData,
  StageKind,
  CatchupUrlBuilders,
  CatchupCountCell,
  CatchupEmail,
} from './catchup';
