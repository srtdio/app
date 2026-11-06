// @srtdio/inbox: the catch-up email (render, schedule contracts) and its
// one-click unsubscribe token, shared by the catch-up cron and the app.

export { renderCatchupEmail, buildCatchupUrls, buildCatchupSubject, dmPreview } from './catchup';
export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribePageUrl,
  buildOneClickUrl,
} from './unsubscribe-token';
export {
  CATCHUP_SLOTS,
  SECTION_ROW_CAP,
  DM_PREVIEW_MAX,
  UNSUBSCRIBE_TEST_VECTOR,
  UNSUBSCRIBE_FUNCTION_NAME,
  ONE_CLICK_BODY,
} from './catchup-contracts';
export type {
  Slot,
  LocalSlotDate,
  PreviousSlot,
  CatchupAudience,
  PostItem,
  CommentItem,
  PlanLineItem,
  StageItem,
  DmItem,
  Section,
  DigestCounts,
  RecipientDigest,
  RenderedEmail,
  DigestRenderer,
  UnsubscribeTokenApi,
  UnsubscribeStatus,
  UnsubscribeJsonRequest,
} from './catchup-contracts';

export type { Role } from './types';
export { AGENCY_ROLES } from './types';

export type { CatchupUrlBuilders } from './catchup';

export {
  BANK_EVENT_TYPES,
  BANK_TEAM_ONLY_EVENT_TYPES,
  bankEventInBank,
  bankEventLine,
  bankEventOpens,
  bankFieldsOf,
  isBankEvent,
  isTeamOnlyBankEvent,
} from './bank-events';
export type { BankEventFields, BankEventType, BankViewer } from './bank-events';
