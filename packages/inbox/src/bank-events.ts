// The idea bank's Activity and catch-up email copy, shared by the app's
// Activity rows (src/lib/inbox/alerts.ts) and the catch-up cron Worker
// (src/server/cron/catchup-send.ts), so both say the same words. Pure: the
// server sets who gets each row (20261106110000_plan_bank_notify); this module
// only words it for the viewer's side. Dates arrive formatted by the caller
// (src/lib/time.ts), so nothing here reads a clock or a zone.

/** The five idea bank event types (inbox_entries.event_type), all tier active. */
export const BANK_EVENT_TYPES = [
  'bank_idea_added',
  'bank_idea_moved',
  'bank_idea_planned',
  'bank_idea_shown',
  'bank_idea_hidden',
] as const;

export type BankEventType = (typeof BANK_EVENT_TYPES)[number];

const BANK_EVENTS = new Set<string>(BANK_EVENT_TYPES);

/** Whether an event type is an idea bank event. Pure. */
export function isBankEvent(eventType: string): eventType is BankEventType {
  return BANK_EVENTS.has(eventType);
}

/**
 * The bank events only the agency team ever gets (the server never writes them
 * for a client). The catch-up email drops them for a client address as a
 * second guard.
 */
export const BANK_TEAM_ONLY_EVENT_TYPES: readonly BankEventType[] = [
  'bank_idea_added',
  'bank_idea_planned',
  'bank_idea_hidden',
];

const TEAM_ONLY = new Set<string>(BANK_TEAM_ONLY_EVENT_TYPES);

/** Whether a bank event is team-only. Pure. */
export function isTeamOnlyBankEvent(eventType: string): boolean {
  return TEAM_ONLY.has(eventType);
}

/** Who reads the row: the agency team, or a client (approver). */
export type BankViewer = 'team' | 'client';

/** A bank row's payload, mapped. Every field may be missing on a malformed row. */
export interface BankEventFields {
  /** payload.title: the idea's title at send time. */
  title: string | null;
  /** bank_idea_planned: the plan it joined (payload.plan_title). */
  planTitle: string | null;
  /** bank_idea_moved: the plan it left (payload.from_plan_title). */
  fromPlanTitle: string | null;
  /** bank_idea_planned: the day it was planned on (payload.target_date, YYYY-MM-DD). */
  targetDate: string | null;
}

function str(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A bank row's fields from its payload. Pure. */
export function bankFieldsOf(payload: unknown): BankEventFields {
  return {
    title: str(payload, 'title'),
    planTitle: str(payload, 'plan_title'),
    fromPlanTitle: str(payload, 'from_plan_title'),
    targetDate: str(payload, 'target_date'),
  };
}

/** The name a line uses when the actor did not resolve. */
const SOMEONE = 'Someone';

/** “Title” in curly quotes, or "an idea" when the title is missing. */
function quoted(title: string | null): string {
  return title !== null ? `“${title}”` : 'an idea';
}

/**
 * A bank row's line:
 *   bank_idea_added   "{Name} added “{title}” to the bank"
 *   bank_idea_moved   team "{Name} moved “{title}” from {plan} to the bank";
 *                     client "“{title}” was moved to the agency's idea bank"
 *   bank_idea_planned "{Name} planned “{title}” in {plan}, {day}"
 *   bank_idea_shown   client "{Name} shared an idea with you: “{title}”";
 *                     team "{Name} showed “{title}” to the client"
 *   bank_idea_hidden  "{Name} hid “{title}” from the client"
 * `day` formats target_date (the caller's src/lib/time.ts formatter); a
 * missing name, title, plan or day degrades, never blank. Pure.
 */
export function bankEventLine(
  eventType: BankEventType,
  f: BankEventFields,
  who: string | null,
  viewer: BankViewer,
  day: (civil: string) => string,
): string {
  const name = who ?? SOMEONE;
  const idea = quoted(f.title);
  switch (eventType) {
    case 'bank_idea_added':
      return `${name} added ${idea} to the bank`;
    case 'bank_idea_moved':
      return viewer === 'client'
        ? `${f.title !== null ? idea : 'An idea'} was moved to the agency's idea bank`
        : `${name} moved ${idea} from ${f.fromPlanTitle ?? 'a plan'} to the bank`;
    case 'bank_idea_planned': {
      const when = f.targetDate !== null ? day(f.targetDate) : '';
      const plan = `${name} planned ${idea} in ${f.planTitle ?? 'a plan'}`;
      return when !== '' ? `${plan}, ${when}` : plan;
    }
    case 'bank_idea_shown':
      return viewer === 'client'
        ? `${name} shared an idea with you: ${idea}`
        : `${name} showed ${idea} to the client`;
    case 'bank_idea_hidden':
      return `${name} hid ${idea} from the client`;
  }
}

/**
 * Whether a bank row has a tap target for the viewer: every row but a moved
 * idea read by a client (the idea is back in the agency's bank, which a client
 * cannot open). Pure.
 */
export function bankEventOpens(eventType: BankEventType, viewer: BankViewer): boolean {
  return !(eventType === 'bank_idea_moved' && viewer === 'client');
}

/**
 * Whether a bank row lands on the bank idea (/plan/bank?item=) rather than a
 * plan: every bank event but bank_idea_planned, whose idea now sits in a plan.
 * Pure.
 */
export function bankEventInBank(eventType: BankEventType): boolean {
  return eventType !== 'bank_idea_planned';
}
