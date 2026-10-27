import { describe, expect, it } from 'vitest';
import {
  buildAlerts,
  maskEmail,
  sentryStatus,
  sourceReason,
  templateName,
  worstLevel,
  type RuleInput,
} from './rules.ts';
import { logLevel, projectRef } from './sources.ts';

const QUIET: RuleInput = {
  sentryNewLastHour: 0,
  functionFailures: {},
  bounces24h: 0,
  traffic: { requests: 10_000, errors5xx: 0 },
  failed: [],
};

const levelOf = (patch: Partial<RuleInput>): string =>
  worstLevel(buildAlerts({ ...QUIET, ...patch }));

describe('alert rules -> dot colour', () => {
  it('green with nothing open', () => {
    expect(levelOf({})).toBe('green');
    expect(buildAlerts(QUIET)).toEqual([]);
  });

  it('red: one edge function with 3+ failures in the hour', () => {
    expect(levelOf({ functionFailures: { 'invite-send': 3 } })).toBe('red');
    expect(levelOf({ functionFailures: { 'invite-send': 2, 'book-call-send': 2 } })).toBe('green');
  });

  it('red: srtd.io 5xx over 1% in the hour; amber over 0.5%', () => {
    expect(levelOf({ traffic: { requests: 1000, errors5xx: 11 } })).toBe('red');
    expect(levelOf({ traffic: { requests: 1000, errors5xx: 10 } })).toBe('amber');
    expect(levelOf({ traffic: { requests: 1000, errors5xx: 6 } })).toBe('amber');
    expect(levelOf({ traffic: { requests: 1000, errors5xx: 5 } })).toBe('green');
    expect(levelOf({ traffic: { requests: 0, errors5xx: 0 } })).toBe('green');
  });

  it('amber: a new Sentry issue in the hour', () => {
    expect(levelOf({ sentryNewLastHour: 1 })).toBe('amber');
  });

  it('amber: any email bounce in 24 h', () => {
    expect(levelOf({ bounces24h: 1 })).toBe('amber');
  });

  it('amber: a source that cannot be reached', () => {
    expect(
      levelOf({ failed: [{ name: 'Sentry', reason: "Can't reach Sentry", tab: 'errors' }] }),
    ).toBe('amber');
  });

  it('the worst alert wins and red sorts first', () => {
    const alerts = buildAlerts({
      ...QUIET,
      bounces24h: 2,
      functionFailures: { 'resend-webhook': 5 },
    });
    expect(worstLevel(alerts)).toBe('red');
    expect(alerts[0]?.level).toBe('red');
    expect(alerts[0]?.tab).toBe('logs');
    expect(alerts[1]).toMatchObject({ level: 'amber', tab: 'email' });
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskEmail('priya@example.com')).toBe('p***@example.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });
  it('never shows a malformed or missing address', () => {
    expect(maskEmail(null)).toBe('Unknown');
    expect(maskEmail('@nouser.com')).toBe('Unknown');
    expect(maskEmail('plain')).toBe('Unknown');
  });
});

describe('labels', () => {
  it('maps template keys to readable names', () => {
    expect(templateName('member_invite')).toBe('Invite');
    expect(templateName('catch-up')).toBe('Catch-up');
    expect(templateName('weekly_digest')).toBe('Weekly digest');
  });
  it('maps Sentry substatus', () => {
    expect(sentryStatus('new')).toBe('New');
    expect(sentryStatus('regressed')).toBe('Back again');
    expect(sentryStatus('ongoing')).toBe('Ongoing');
    expect(sentryStatus(null)).toBe('Ongoing');
  });
  it('names a failed source', () => {
    expect(sourceReason('Sentry', 'unreachable')).toBe("Can't reach Sentry");
    expect(sourceReason('Cloudflare', 'auth')).toBe('Token expired: Cloudflare');
  });
  it('normalises log levels and the project ref', () => {
    expect(logLevel('API', '502')).toBe('error');
    expect(logLevel('API', '404')).toBe('warn');
    expect(logLevel('Database', 'ERROR')).toBe('error');
    expect(logLevel('Auth', 'warning')).toBe('warn');
    expect(logLevel('Function', 'log')).toBe('info');
    expect(projectRef('https://movnexawfhsyuluspxoc.supabase.co')).toBe('movnexawfhsyuluspxoc');
  });
});
