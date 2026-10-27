// The ops-cockpit edge function's answers for the harness operator: fixed
// numbers and fixed instants, so the Cockpit screens render the same on every
// run. Shapes mirror supabase/functions/ops-cockpit/handler.ts.

export type CockpitMockLevel = 'green' | 'amber' | 'red';

/** The last refresh every answer carries (shown as 09:41:07 in UTC). */
export const COCKPIT_CHECKED_AT = '2026-10-22T09:41:07Z';

const RED_ALERTS = [
  {
    id: 'fn:invite-send',
    level: 'red',
    title: 'invite-send is failing',
    meta: '4 failures in the last hour',
    tab: 'logs',
  },
  {
    id: 'email:bounce',
    level: 'amber',
    title: 'An email bounced',
    meta: '1 bounce in the last 24 h',
    tab: 'email',
  },
];

const AMBER_ALERTS = [RED_ALERTS[1]];

function alertsFor(level: CockpitMockLevel): unknown[] {
  if (level === 'red') return RED_ALERTS;
  if (level === 'amber') return AMBER_ALERTS;
  return [];
}

function days(count: number, end: string): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(last - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

const ACTIVE = [3, 4, 2, 5, 6, 4, 7, 8, 6, 5, 9, 7, 8, 7];
const SIGNUPS = [1, 0, 2, 1, 0, 1, 3, 1, 0, 2, 1, 1, 0, 2];
const VISITORS = [120, 98, 143, 160, 131, 117, 152];

const TABS: Record<string, unknown> = {
  needs: null,
  users: {
    state: 'ok',
    data: {
      signed_up: 214,
      confirmed: 188,
      signed_in_30d: 96,
      active_today: 7,
      active_7d: 41,
      active_30d: 88,
      daily: days(14, '2026-10-22').map((day, i) => ({
        day,
        active: ACTIVE[i] ?? 0,
        self_signups: SIGNUPS[i] ?? 0,
      })),
      countries_30d: [
        { country: 'IN', people: 52 },
        { country: 'GB', people: 17 },
        { country: 'US', people: 12 },
        { country: '??', people: 7 },
      ],
    },
  },
  errors: {
    state: 'ok',
    data: {
      issues: [
        {
          id: '101',
          title: "TypeError: Cannot read properties of undefined (reading 'stage')",
          culprit: 'PipelinePage',
          count: 12,
          firstSeen: '2026-10-22T09:10:00Z',
          lastSeen: '2026-10-22T09:38:00Z',
          substatus: 'new',
          permalink: 'https://sentry.io/organizations/srtdio/issues/101/',
        },
      ],
    },
  },
  logs: {
    state: 'ok',
    data: {
      rows: [
        {
          id: 'l1',
          at: '2026-10-22T09:40:55Z',
          source: 'Function',
          level: 'error',
          message: 'invite-send 0190a000-0000-7000-8000-00000000aaaa resend 429',
        },
        {
          id: 'l2',
          at: '2026-10-22T09:39:12Z',
          source: 'API',
          level: 'info',
          message: 'GET /rest/v1/posts 200',
        },
      ],
    },
  },
  email: {
    state: 'ok',
    data: {
      delivered: 42,
      bounced: 1,
      delayed: 0,
      spam: 0,
      latest: [
        {
          id: 'e1',
          to: 'p***@example.com',
          templateKey: 'member_invite',
          status: 'bounced',
          at: '2026-10-22T09:20:00Z',
        },
      ],
    },
  },
  chat: {
    state: 'ok',
    data: { messages: 318, voiceNotes: 22, groups: 14, syncFailed: 0, problems: [] },
  },
  traffic: {
    state: 'ok',
    data: {
      requests: 52_000,
      errors5xx: 12,
      daily: days(7, '2026-10-22').map((day, i) => ({ day, visitors: VISITORS[i] ?? 0 })),
      web: {
        visits: 1190,
        views: 2875,
        home: 640,
        signup: 96,
        pages: [
          { path: '/', visits: 640, views: 812 },
          { path: '/signup', visits: 96, views: 131 },
          { path: '/pricing', visits: 88, views: 102 },
        ],
        countries: [
          { country: 'IN', visits: 610 },
          { country: 'GB', visits: 220 },
          { country: 'US', visits: 160 },
        ],
      },
      selfSignups7d: 8,
    },
  },
};

const TILES = {
  errors: { state: 'ok', value: 3, level: 'amber' },
  backend: { state: 'ok', value: 4, level: 'red' },
  email: { state: 'ok', value: 42, level: 'amber' },
  chat: { state: 'ok', value: 318, level: 'green' },
  traffic: { state: 'ok', value: 921, level: 'green' },
  users: { state: 'ok', value: 7, level: 'green' },
};

export function cockpitStatus(level: CockpitMockLevel): unknown {
  return { checked_at: COCKPIT_CHECKED_AT, level, alerts: alertsFor(level) };
}

export function cockpitFull(level: CockpitMockLevel, tab: string): unknown {
  return {
    checked_at: COCKPIT_CHECKED_AT,
    level,
    alerts: alertsFor(level),
    tiles: TILES,
    tab,
    data: TABS[tab] ?? null,
  };
}
