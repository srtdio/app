// ops-cockpit pure rules: alert levels, masking, labels. No I/O, no Deno, no
// @srtdio/* imports (the Deno edge bundler rejects their extensionless
// relative imports); unit-tested under Node.

export type Level = 'green' | 'amber' | 'red';
export type Tab = 'needs' | 'users' | 'errors' | 'logs' | 'email' | 'chat' | 'traffic';
export const TABS: readonly Tab[] = [
  'needs',
  'users',
  'errors',
  'logs',
  'email',
  'chat',
  'traffic',
];

export function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

/** One open alert on the Needs you tab; `tab` opens a Cockpit tab, `href` a vendor page. */
export interface Alert {
  id: string;
  level: Exclude<Level, 'green'>;
  title: string;
  meta: string;
  tab?: Tab;
  href?: string;
}

/** A source that answered, or the one line its tile shows instead. */
export type Source<T> = { state: 'ok'; data: T } | { state: 'error'; reason: string };

/** What the alert rules read; a source that failed is null. */
export interface RuleInput {
  /** Sentry issues first seen in the last hour (null: Sentry unreachable). */
  sentryNewLastHour: number | null;
  /** Edge function failures in the last hour, by function name. */
  functionFailures: Record<string, number> | null;
  /** Email bounces in the last 24 h. */
  bounces24h: number | null;
  /** srtd.io requests in the last hour and how many answered 5xx. */
  traffic: { requests: number; errors5xx: number } | null;
  /** Sources that failed: shown as amber "Can't reach" alerts. */
  failed: { name: string; reason: string; tab: Tab }[];
}

/** 3 or more failures of one edge function in an hour: red. */
export const FUNCTION_FAILURES_RED = 3;
/** srtd.io 5xx share of requests in the last hour: red above 1%, amber above 0.5%. */
export const ERROR_RATE_RED = 0.01;
export const ERROR_RATE_AMBER = 0.005;

/** The 5xx share of requests (0 with no requests). */
export function errorRate(traffic: { requests: number; errors5xx: number }): number {
  return traffic.requests > 0 ? traffic.errors5xx / traffic.requests : 0;
}

export function pct(rate: number): string {
  return `${(Math.round(rate * 1000) / 10).toString()}%`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toString()} ${n === 1 ? one : many}`;
}

/** The open alerts, worst first. */
export function buildAlerts(input: RuleInput): Alert[] {
  const alerts: Alert[] = [];
  for (const [name, count] of Object.entries(input.functionFailures ?? {})) {
    if (count >= FUNCTION_FAILURES_RED) {
      alerts.push({
        id: `fn:${name}`,
        level: 'red',
        title: `${name} is failing`,
        meta: `${plural(count, 'failure', 'failures')} in the last hour`,
        tab: 'logs',
      });
    }
  }
  if (input.traffic !== null) {
    const rate = errorRate(input.traffic);
    if (rate > ERROR_RATE_RED) {
      alerts.push({
        id: 'cf:5xx',
        level: 'red',
        title: 'Server errors on srtd.io',
        meta: `${pct(rate)} of requests failed in the last hour`,
        tab: 'traffic',
      });
    } else if (rate > ERROR_RATE_AMBER) {
      alerts.push({
        id: 'cf:errors',
        level: 'amber',
        title: 'Request errors on srtd.io',
        meta: `${pct(rate)} of requests failed in the last hour`,
        tab: 'traffic',
      });
    }
  }
  if (input.sentryNewLastHour !== null && input.sentryNewLastHour > 0) {
    alerts.push({
      id: 'sentry:new',
      level: 'amber',
      title: input.sentryNewLastHour === 1 ? 'New error in Sentry' : 'New errors in Sentry',
      meta: `${plural(input.sentryNewLastHour, 'new issue', 'new issues')} in the last hour`,
      tab: 'errors',
    });
  }
  if (input.bounces24h !== null && input.bounces24h > 0) {
    alerts.push({
      id: 'email:bounce',
      level: 'amber',
      title: input.bounces24h === 1 ? 'An email bounced' : 'Emails bounced',
      meta: `${plural(input.bounces24h, 'bounce', 'bounces')} in the last 24 h`,
      tab: 'email',
    });
  }
  for (const f of input.failed) {
    alerts.push({
      id: `source:${f.name}:${f.tab}`,
      level: 'amber',
      title: f.reason,
      meta: f.name,
      tab: f.tab,
    });
  }
  return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
}

/** The dot: the worst open alert, green with none. */
export function worstLevel(alerts: readonly { level: Level }[]): Level {
  if (alerts.some((a) => a.level === 'red')) return 'red';
  if (alerts.some((a) => a.level === 'amber')) return 'amber';
  return 'green';
}

/** "a***@example.com": first letter, ***, then the domain. Never the full address. */
export function maskEmail(email: string | null | undefined): string {
  if (typeof email !== 'string') return 'Unknown';
  const at = email.lastIndexOf('@');
  if (at < 1) return 'Unknown';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

const TEMPLATE_NAMES: Record<string, string> = {
  member_invite: 'Invite',
  'catch-up': 'Catch-up',
  brand_request: 'Brand request',
  book_call: 'Book a call',
  demo_request: 'Demo request',
};

/** delivery_attempts.template_key as a readable name. */
export function templateName(key: string): string {
  const known = TEMPLATE_NAMES[key];
  if (known !== undefined) return known;
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words === '' ? 'Email' : words.charAt(0).toUpperCase() + words.slice(1);
}

const EMAIL_STATUS: Record<string, string> = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Spam report',
  failed: 'Failed',
};

export function emailStatus(status: string): string {
  return EMAIL_STATUS[status] ?? status;
}

/** Sentry substatus as the tab shows it. */
export function sentryStatus(
  substatus: string | null | undefined,
): 'New' | 'Ongoing' | 'Back again' {
  if (substatus === 'new') return 'New';
  if (substatus === 'regressed') return 'Back again';
  return 'Ongoing';
}

/** The one line a failed source's tile shows. */
export function sourceReason(name: string, kind: 'auth' | 'unreachable'): string {
  return kind === 'auth' ? `Token expired: ${name}` : `Can't reach ${name}`;
}
