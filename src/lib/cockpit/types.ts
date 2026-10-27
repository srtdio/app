// The ops-cockpit edge function's answers, as the Cockpit reads them. Mirrors
// supabase/functions/ops-cockpit/{rules,handler,sources}.ts (the edge function
// cannot import from src/, so the shapes are restated here).

export type CockpitLevel = 'green' | 'amber' | 'red';
/** The dot before its first status answer. */
export type DotLevel = CockpitLevel | 'grey';

export type CockpitTab = 'needs' | 'users' | 'errors' | 'logs' | 'email' | 'chat' | 'traffic';

/** Tab order and labels (the approved prototype's words). */
export const COCKPIT_TABS: readonly { id: CockpitTab; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'users', label: 'Users' },
  { id: 'errors', label: 'Errors' },
  { id: 'logs', label: 'Logs' },
  { id: 'email', label: 'Email' },
  { id: 'chat', label: 'Chat' },
  { id: 'traffic', label: 'Traffic' },
];

export interface CockpitAlert {
  id: string;
  level: Exclude<CockpitLevel, 'green'>;
  title: string;
  meta: string;
  tab?: CockpitTab;
  href?: string;
}

export type Source<T> = { state: 'ok'; data: T } | { state: 'error'; reason: string };

export type CockpitTile =
  | { state: 'ok'; value: number; level: CockpitLevel }
  | { state: 'error'; reason: string };

export type TileKey = 'errors' | 'backend' | 'email' | 'chat' | 'traffic' | 'users';

/** The six tiles (3x2) and the tab each one selects. */
export const COCKPIT_TILES: readonly { key: TileKey; label: string; tab: CockpitTab }[] = [
  { key: 'errors', label: 'Errors', tab: 'errors' },
  { key: 'backend', label: 'Backend', tab: 'logs' },
  { key: 'email', label: 'Email', tab: 'email' },
  { key: 'chat', label: 'Chat', tab: 'chat' },
  { key: 'traffic', label: 'Traffic', tab: 'traffic' },
  { key: 'users', label: 'Users', tab: 'users' },
];

export interface CockpitStatus {
  checked_at: string;
  level: CockpitLevel;
  alerts: CockpitAlert[];
}

export interface UsersData {
  signed_up: number;
  confirmed: number;
  signed_in_30d: number;
  active_today: number;
  active_7d: number;
  active_30d: number;
  daily: { day: string; active: number; self_signups: number }[];
  countries_30d: { country: string; people: number }[];
}

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  substatus: string | null;
  permalink: string;
}

export type LogSource = 'Function' | 'Database' | 'Auth' | 'API';

export interface LogRow {
  id: string;
  at: string;
  source: LogSource;
  level: 'error' | 'warn' | 'info';
  message: string;
}

export interface EmailData {
  delivered: number;
  bounced: number;
  delayed: number;
  spam: number;
  latest: { id: string; to: string; templateKey: string; status: string; at: string }[];
}

export interface ChatData {
  messages: number;
  voiceNotes: number;
  groups: number;
  syncFailed: number;
  problems: { id: string; eventType: string; error: string; attempts: number; at: string }[];
}

export interface TrafficData {
  requests: number;
  errors5xx: number;
  daily: { day: string; visitors: number }[] | null;
  web: {
    visits: number;
    views: number;
    home: number;
    signup: number;
    pages: { path: string; visits: number; views: number }[];
    countries: { country: string; visits: number }[];
  } | null;
  selfSignups7d: number | null;
}

export interface TabDataMap {
  needs: null;
  users: Source<UsersData>;
  errors: Source<{ issues: SentryIssue[] }>;
  logs: Source<{ rows: LogRow[] }>;
  email: Source<EmailData>;
  chat: Source<ChatData>;
  traffic: Source<TrafficData>;
}

export interface CockpitFull<T extends CockpitTab = CockpitTab> extends CockpitStatus {
  tiles: Record<TileKey, CockpitTile>;
  tab: T;
  data: TabDataMap[T];
}
