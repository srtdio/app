// The Cockpit's seven tab bodies. Words are the approved prototype's.

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconActivity, IconCheckCircle } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { NoResults } from '@/components/ui/NoResults';
import { PressableRow } from '@/components/ui/PressableRow';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { DayBars, ShareBars } from '@/components/cockpit/Bars';
import { openExternal, Section, SourceNote, Stats, StatusDot } from '@/components/cockpit/parts';
import { clockText, countText, countryName, shareText, traceIdIn } from '@/lib/cockpit/format';
import type {
  ChatData,
  CockpitAlert,
  CockpitTab,
  EmailData,
  LogRow,
  SentryIssue,
  Source,
  TrafficData,
  UsersData,
} from '@/lib/cockpit/types';
import { formatRelative } from '@/lib/time';

export const AGORA_CONSOLE_URL = 'https://console.agora.io';

/** A tab whose source has not answered yet this session paints this until it does. */
function Pending() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <span className="h-16 rounded-xl bg-panel-3 animate-pulse" />
      <span className="h-16 rounded-xl bg-panel-3 animate-pulse" />
    </div>
  );
}

/** Pending, a failed source's line, or the body. */
function WithSource<T>({
  source,
  children,
}: {
  source: Source<T> | undefined;
  children: (data: T) => ReactNode;
}) {
  if (source === undefined) return <Pending />;
  if (source.state === 'error') return <SourceNote reason={source.reason} />;
  return <>{children(source.data)}</>;
}

// --- Needs you ----------------------------------------------------------------

export function NeedsYouTab({
  alerts,
  checkedAt,
  onOpenTab,
}: {
  alerts: CockpitAlert[] | null;
  checkedAt: string | null;
  onOpenTab: (tab: CockpitTab) => void;
}) {
  if (alerts === null) return <Pending />;
  if (alerts.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-3">
        <span className="text-good">
          <IconCheckCircle size={ICON_SIZE.control} />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-base font-medium text-fg">All clear</span>
          <span className="text-sm text-fg-3">
            Checked <span className="font-mono tabular-nums">{clockText(checkedAt)}</span>
          </span>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {alerts.map((alert) => (
        <li key={alert.id}>
          <PressableRow
            data-cockpit-alert={alert.level}
            onClick={() => {
              if (alert.href !== undefined) openExternal(alert.href);
              else if (alert.tab !== undefined) onOpenTab(alert.tab);
            }}
            className="flex items-start gap-3 px-3 py-2.5"
          >
            <span className="mt-1.5">
              <StatusDot level={alert.level} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-base font-medium text-fg">{alert.title}</span>
              <span className="text-sm text-fg-3">{alert.meta}</span>
            </span>
          </PressableRow>
        </li>
      ))}
    </ul>
  );
}

// --- Users ------------------------------------------------------------------

export function UsersTab({ source }: { source: Source<UsersData> | undefined }) {
  return (
    <WithSource source={source}>
      {(d) => (
        <div className="flex flex-col gap-6">
          <Stats
            items={[
              { label: 'Signed up', value: d.signed_up },
              { label: 'Email confirmed', value: d.confirmed },
              { label: 'Signed in (30 days)', value: d.signed_in_30d },
              { label: 'Active today', value: d.active_today },
            ]}
          />
          <Section label="Daily users">
            <DayBars
              label="Daily users, last 14 days"
              days={d.daily.map((x) => ({ day: x.day, value: Number(x.active) }))}
            />
          </Section>
          <Section label="People by country">
            {d.countries_30d.length === 0 ? (
              <p className="text-base text-fg-2">Countries show up here.</p>
            ) : (
              <ShareBars
                rows={d.countries_30d.map((c) => ({
                  key: c.country,
                  name: countryName(c.country),
                  value: Number(c.people),
                }))}
              />
            )}
          </Section>
          <Section label="New sign-ups">
            <DayBars
              label="New self sign-ups, last 14 days"
              days={d.daily.map((x) => ({ day: x.day, value: Number(x.self_signups) }))}
            />
          </Section>
        </div>
      )}
    </WithSource>
  );
}

// --- Errors -----------------------------------------------------------------

const SENTRY_TONE: Record<string, TagTone> = {
  New: 'bad',
  'Back again': 'warn',
  Ongoing: 'neutral',
};

function sentryStatus(substatus: string | null): 'New' | 'Ongoing' | 'Back again' {
  if (substatus === 'new') return 'New';
  if (substatus === 'regressed') return 'Back again';
  return 'Ongoing';
}

export function ErrorsTab({ source }: { source: Source<{ issues: SentryIssue[] }> | undefined }) {
  return (
    <WithSource source={source}>
      {(d) =>
        d.issues.length === 0 ? (
          <EmptyState
            compact
            icon={<IconCheckCircle size={ICON_SIZE.control} />}
            title="Errors show up here."
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {d.issues.map((issue) => {
              const status = sentryStatus(issue.substatus);
              return (
                <li key={issue.id}>
                  <PressableRow
                    onClick={() => openExternal(issue.permalink)}
                    className="flex flex-col gap-1 px-3 py-2.5"
                  >
                    <span className="flex w-full items-start gap-2">
                      <span className="min-w-0 flex-1 line-clamp-2 text-base font-medium text-fg [overflow-wrap:anywhere]">
                        {issue.title}
                      </span>
                      <Tag label={status} tone={SENTRY_TONE[status] ?? 'neutral'} />
                    </span>
                    <span className="truncate text-sm text-fg-3">
                      {issue.culprit} · {countText(issue.count)} times ·{' '}
                      {formatRelative(issue.lastSeen)}
                    </span>
                  </PressableRow>
                </li>
              );
            })}
          </ul>
        )
      }
    </WithSource>
  );
}

// --- Logs -------------------------------------------------------------------

const LOG_DOT = { error: 'red', warn: 'amber', info: 'grey' } as const;

/** Rows matching the search: a pasted trace ID narrows to that trace, any other text to its lines. */
export function filterLogs(rows: LogRow[], query: string): LogRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return rows;
  const trace = traceIdIn(q);
  const needle = trace ?? q;
  return rows.filter(
    (r) =>
      r.message.toLowerCase().includes(needle) ||
      (trace === null && r.source.toLowerCase().includes(needle)),
  );
}

export function LogsTab({ source }: { source: Source<{ rows: LogRow[] }> | undefined }) {
  const [query, setQuery] = useState('');
  const rows = source?.state === 'ok' ? source.data.rows : null;
  const shown = useMemo(() => (rows === null ? [] : filterLogs(rows, query)), [rows, query]);
  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Search logs"
        placeholder="Search or paste a trace ID"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <WithSource source={source}>
        {(d) =>
          d.rows.length === 0 ? (
            <EmptyState
              compact
              icon={<IconActivity size={ICON_SIZE.control} />}
              title="Log lines show up here."
            />
          ) : shown.length === 0 ? (
            <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
          ) : (
            <ul className="flex flex-col">
              {shown.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start gap-2 border-b border-border py-2 last:border-b-0"
                >
                  <span className="shrink-0 font-mono text-sm tabular-nums text-fg-3">
                    {clockText(row.at)}
                  </span>
                  <Tag label={row.source} />
                  <span className="mt-1">
                    <StatusDot level={LOG_DOT[row.level]} small />
                  </span>
                  <span className="min-w-0 flex-1 text-base text-fg [overflow-wrap:anywhere]">
                    {row.message}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </WithSource>
    </div>
  );
}

// --- Email ------------------------------------------------------------------

const EMAIL_KIND: Record<string, string> = {
  member_invite: 'Invite',
  'catch-up': 'Catch-up',
  brand_request: 'Brand request',
  book_call: 'Book a call',
  demo_request: 'Demo request',
};

const EMAIL_STATUS: Record<string, { label: string; tone: TagTone }> = {
  delivered: { label: 'Delivered', tone: 'good' },
  bounced: { label: 'Bounced', tone: 'bad' },
  complained: { label: 'Spam report', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  queued: { label: 'Queued', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'neutral' },
};

export function EmailTab({ source }: { source: Source<EmailData> | undefined }) {
  return (
    <WithSource source={source}>
      {(d) => (
        <div className="flex flex-col gap-6">
          <Stats
            items={[
              { label: 'Delivered', value: d.delivered },
              { label: 'Bounced', value: d.bounced },
              { label: 'Delayed', value: d.delayed },
              { label: 'Spam reports', value: d.spam },
            ]}
          />
          <Section label="Latest">
            {d.latest.length === 0 ? (
              <EmptyState
                compact
                icon={<IconCheckCircle size={ICON_SIZE.control} />}
                title="Emails show up here."
              />
            ) : (
              <ul className="flex flex-col">
                {d.latest.map((e) => {
                  const status: { label: string; tone: TagTone } = EMAIL_STATUS[e.status] ?? {
                    label: e.status,
                    tone: 'neutral',
                  };
                  return (
                    <li
                      key={e.id}
                      className="flex items-center gap-2 border-b border-border py-2 last:border-b-0"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-base text-fg">{e.to}</span>
                        <span className="text-sm text-fg-3">
                          {EMAIL_KIND[e.templateKey] ?? e.templateKey}
                        </span>
                      </span>
                      <Tag label={status.label} tone={status.tone} />
                      <span className="font-mono text-sm tabular-nums text-fg-3">
                        {clockText(e.at)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>
      )}
    </WithSource>
  );
}

// --- Chat -------------------------------------------------------------------

export function ChatTab({ source }: { source: Source<ChatData> | undefined }) {
  return (
    <div className="flex flex-col gap-6">
      <WithSource source={source}>
        {(d) => (
          <div className="flex flex-col gap-6">
            <Stats
              items={[
                { label: 'Messages', value: d.messages },
                { label: 'Voice notes', value: d.voiceNotes },
                { label: 'Groups', value: d.groups },
                { label: 'Sync failed', value: d.syncFailed },
              ]}
            />
            <Section label="Last sync problems">
              {d.problems.length === 0 ? (
                <p className="text-base text-fg-2">Sync problems show up here.</p>
              ) : (
                <ul className="flex flex-col">
                  {d.problems.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                    >
                      <span className="flex items-center gap-2">
                        <Tag label={p.eventType.replace(/_/g, ' ')} />
                        <span className="ml-auto font-mono text-sm tabular-nums text-fg-3">
                          {clockText(p.at)}
                        </span>
                      </span>
                      <span className="text-base text-fg [overflow-wrap:anywhere]">{p.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </WithSource>
      <div className="flex flex-col items-start gap-1">
        <p className="text-base text-fg-2">
          Agora&apos;s own usage charts open in the Agora console.
        </p>
        <Button variant="link" onClick={() => openExternal(AGORA_CONSOLE_URL)}>
          Open Agora console
        </Button>
      </div>
    </div>
  );
}

// --- Traffic ------------------------------------------------------------------

export function TrafficTab({ source }: { source: Source<TrafficData> | undefined }) {
  return (
    <WithSource source={source}>
      {(d) => {
        const visitors = (d.daily ?? []).reduce((a, b) => a + b.visitors, 0);
        const web = d.web;
        return (
          <div className="flex flex-col gap-6">
            <Stats
              columns={3}
              items={[
                { label: 'Visitors', value: visitors },
                { label: 'Visits', value: web?.visits ?? null },
                { label: 'Page views', value: web?.views ?? null },
              ]}
            />
            {web === null ? null : (
              <Section label="Home to sign-up">
                <dl className="flex flex-col">
                  {[
                    { label: 'Home page /', value: web.home },
                    { label: 'Sign-up page /signup', value: web.signup },
                    { label: 'Signed up themselves', value: d.selfSignups7d },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className="flex items-baseline gap-2 border-b border-border py-2 last:border-b-0"
                    >
                      <dt className="min-w-0 flex-1 text-base text-fg">{row.label}</dt>
                      <dd className="font-mono text-base tabular-nums text-fg">
                        {row.value === null ? '-' : countText(row.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-base text-fg-2">
                  {shareText(web.signup, web.home)} of home visits reach sign-up;{' '}
                  {shareText(d.selfSignups7d ?? 0, web.signup)} of sign-up visits finish.
                </p>
              </Section>
            )}
            {web === null ? null : (
              <Section label="Visitors by country">
                {web.countries.length === 0 ? (
                  <p className="text-base text-fg-2">Countries show up here.</p>
                ) : (
                  <ShareBars
                    rows={web.countries.map((c) => ({
                      key: c.country,
                      name: countryName(c.country),
                      value: c.visits,
                    }))}
                  />
                )}
              </Section>
            )}
            <Section label="Visitors per day">
              <DayBars
                label="Visitors per day, last 7 days"
                days={(d.daily ?? []).map((x) => ({ day: x.day, value: x.visitors }))}
              />
            </Section>
            {web === null ? null : (
              <Section label="Pages">
                <table className="w-full table-fixed text-left">
                  <thead>
                    <tr className="text-sm text-fg-2">
                      <th className="py-1 font-medium">Page</th>
                      {/* Web Analytics has no unique visitors per page: Visits stands in. */}
                      <th className="w-20 py-1 text-right font-medium">Visits</th>
                      <th className="w-20 py-1 text-right font-medium">Views</th>
                    </tr>
                  </thead>
                  <tbody>
                    {web.pages.map((p) => (
                      <tr key={p.path} className="border-t border-border">
                        <td className="truncate py-2 font-mono text-sm text-fg">{p.path}</td>
                        <td className="py-2 text-right font-mono text-base tabular-nums text-fg">
                          {countText(p.visits)}
                        </td>
                        <td className="py-2 text-right font-mono text-base tabular-nums text-fg">
                          {countText(p.views)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        );
      }}
    </WithSource>
  );
}
