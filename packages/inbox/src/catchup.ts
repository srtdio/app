// @srtdio/inbox catch-up email CORE. Pure, deterministic, no I/O: no fetch, no
// Supabase, no Deno/Worker APIs, no Date.now. The cron Worker (reads rows, sends,
// stamps) and the frontend deep-link layer are SEPARATE later PRs. Everything
// here is unit-testable in isolation: names, titles and urls arrive already
// resolved; `now` is passed in where time matters. No AI: the summary is a
// hand-written deterministic template.

// --- types ------------------------------------------------------------------

export type StageKind = 'approved' | 'rejected' | 'review' | 'parked';

export interface CatchupRow {
  who: string;
  verb: string;
  target: string;
  time: string;
  url: string;
  stage?: StageKind;
}

export interface ChatRow {
  who: string;
  count: number;
  url: string;
}

export interface CatchupData {
  workspaceId: string;
  workspaceName: string;
  recipientUserId: string;
  sinceLabel: string;
  stages: CatchupRow[];
  comments: CatchupRow[];
  briefs: CatchupRow[];
  assets: CatchupRow[];
  chats: ChatRow[];
}

export interface CatchupUrlBuilders {
  post: (id: string) => string;
  brief: (id: string) => string;
  comment: (entityType: 'post' | 'brief', entityId: string, commentId: string) => string;
  asset: (id: string) => string;
  chat: (channelId: string) => string;
  activity: () => string;
}

export interface CatchupCountCell {
  label: 'Stage' | 'Comments' | 'Brief' | 'Chat' | 'Asset';
  count: number;
}

export interface CatchupEmail {
  subject: string;
  html: string;
  text: string;
  messageId: (slotIso: string) => string;
}

// --- (B) deep-link URL emitters --------------------------------------------
// The base is always passed in, never hardcoded. The Worker builds each
// row.url with these helpers so frontend and Worker share one URL shape.

export function buildCatchupUrls(baseUrl: string, workspaceId: string): CatchupUrlBuilders {
  const base = baseUrl.replace(/\/+$/, '');
  const ws = encodeURIComponent(workspaceId);
  return {
    post: (id) => `${base}/posts/${id}?w=${ws}`,
    brief: (id) => `${base}/briefs/${id}?w=${ws}`,
    comment: (entityType, entityId, commentId) =>
      `${base}/${entityType === 'post' ? 'posts' : 'briefs'}/${entityId}?w=${ws}&comment=${commentId}`,
    asset: (id) => `${base}/assets?w=${ws}&asset=${id}`,
    chat: (channelId) => `${base}/chat?w=${ws}&channel=${channelId}`,
    activity: () => `${base}/activity?w=${ws}`,
  };
}

// --- small pure helpers -----------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

// Numbers are spelled to nine; ten and above stay numeric.
function spell(n: number): string {
  return ONES[n] ?? String(n);
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1] ?? ''}`;
}

function activityRows(data: CatchupData): CatchupRow[] {
  return [...data.stages, ...data.comments, ...data.briefs, ...data.assets];
}

function chatTotal(data: CatchupData): number {
  return data.chats.reduce((sum, c) => sum + c.count, 0);
}

// --- (C) deterministic summary ---------------------------------------------

export function summarizeCatchup(data: CatchupData): string {
  const activityCount =
    data.stages.length + data.comments.length + data.briefs.length + data.assets.length;
  const chats = chatTotal(data);

  let lead: string | null = null;

  if (activityCount === 1) {
    // Name the single update specifically.
    const b = data.briefs[0];
    const r = activityRows(data)[0];
    if (b) {
      lead = `${b.who} opened a brief: ${b.target}.`;
    } else if (r) {
      lead = `${r.who} ${r.verb} ${r.target}.`;
    }
  } else if (activityCount > 1) {
    // Attribute the gist to the dominant actor (most items; ties -> first seen).
    const all = activityRows(data);
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.who, (counts.get(r.who) ?? 0) + 1);
    let actor = '';
    let max = -1;
    for (const r of all) {
      const c = counts.get(r.who) ?? 0;
      if (c > max) {
        max = c;
        actor = r.who;
      }
    }

    const approved = data.stages.filter((s) => s.who === actor && s.stage === 'approved').length;
    const rejected = data.stages.filter((s) => s.who === actor && s.stage === 'rejected').length;
    const briefsN = data.briefs.filter((b) => b.who === actor).length;
    const commentsN = data.comments.filter((c) => c.who === actor).length;

    const clauses: string[] = [];
    if (approved > 0 && rejected > 0) {
      clauses.push('approved one post and rejected another');
    } else if (approved > 0) {
      clauses.push(`approved ${spell(approved)} post${approved > 1 ? 's' : ''}`);
    } else if (rejected > 0) {
      clauses.push(`rejected ${spell(rejected)} post${rejected > 1 ? 's' : ''}`);
    }
    if (briefsN > 0)
      clauses.push(briefsN === 1 ? 'opened a brief' : `opened ${spell(briefsN)} briefs`);
    if (commentsN > 0) clauses.push(`left ${spell(commentsN)} comment${commentsN > 1 ? 's' : ''}`);

    if (clauses.length > 0) lead = `${actor} ${joinClauses(clauses)}.`;
  }

  const out: string[] = [];
  if (lead) out.push(lead);
  else if (activityCount > 0) out.push(`${cap(spell(activityCount))} updates while you were away.`);

  if (chats > 0) out.push(`You have ${spell(chats)} unread chat message${chats === 1 ? '' : 's'}.`);

  if (out.length === 0) out.push(`${cap(spell(activityCount))} updates while you were away.`);

  return out.join(' ');
}

// --- (D) adaptive counts ----------------------------------------------------

export function shouldShowCounts(data: CatchupData): boolean {
  const sections = [data.stages, data.comments, data.briefs, data.assets];
  let distinct = sections.filter((s) => s.length > 0).length;
  if (data.chats.length > 0) distinct += 1;
  return distinct >= 3;
}

// Up to four cells, in the order Stage, Comments, Brief, Chat, Asset.
export function countCells(data: CatchupData): CatchupCountCell[] {
  const all: CatchupCountCell[] = [
    { label: 'Stage', count: data.stages.length },
    { label: 'Comments', count: data.comments.length },
    { label: 'Brief', count: data.briefs.length },
    { label: 'Chat', count: chatTotal(data) },
    { label: 'Asset', count: data.assets.length },
  ];
  return all.filter((c) => c.count > 0).slice(0, 4);
}

// --- (E) send window --------------------------------------------------------
// Local weekday + hour computed in `timezone` via Intl (no external lib).
// True iff a weekday (Mon-Fri) and the local hour h satisfies 10 <= h < 18.

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

export function isInSendWindow(timezone: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? 'NaN', 10);

  if (!WEEKDAYS.has(weekday)) return false;
  return hour >= 10 && hour < 18;
}

// --- (F) render -------------------------------------------------------------

const SANS = "'Inter',-apple-system,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,monospace";

const LIGHT = {
  bg: '#f7f8f9',
  panel: '#ffffff',
  panel2: '#f2f3f5',
  panel3: '#ecedf0',
  border: '#e6e8eb',
  fg: '#1b1c20',
  fg2: '#62666d',
  fg3: '#8b9096',
  accent: '#5e6ad2',
  accentSoft: '#ecedfb',
} as const;

const STAGE_LIGHT: Record<StageKind, string> = {
  approved: '#15803d',
  rejected: '#b91c1c',
  review: '#b45309',
  parked: '#52606d',
};

const SCHEDULE_NOTE =
  'Catch-ups go out every 30 minutes, 10am to 6pm in your timezone, on weekdays only. We email only when something new happened while you were away.';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '?';
  const last = parts[parts.length - 1] ?? first;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function avatarCell(name: string): string {
  return (
    `<td width="40" style="width:40px;padding-right:10px;vertical-align:middle">` +
    `<div class="avatar" style="width:32px;height:32px;line-height:32px;text-align:center;background:${LIGHT.accentSoft};border-radius:16px;font-family:${MONO};font-size:12px;font-weight:500;color:${LIGHT.accent}">${esc(initials(name))}</div>` +
    `</td>`
  );
}

function stageWord(stage: StageKind): string {
  return ` <span class="stage-${stage}" style="font-family:${MONO};text-transform:uppercase;font-size:11px;letter-spacing:0.04em;color:${STAGE_LIGHT[stage]}">${stage}</span>`;
}

function rowHtml(r: CatchupRow): string {
  const body = `${esc(r.who)} ${esc(r.verb)} ${esc(r.target)}${r.stage ? stageWord(r.stage) : ''}`;
  return (
    `<tr><td style="padding:0">` +
    `<a href="${r.url}" class="rowlink" style="display:block;text-decoration:none;color:inherit;padding:10px 16px;border-top:1px solid ${LIGHT.border}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    avatarCell(r.who) +
    `<td class="fg" style="font-family:${SANS};font-size:14px;color:${LIGHT.fg};vertical-align:middle">${body}</td>` +
    `<td class="fg3" align="right" style="font-family:${MONO};font-size:12px;color:${LIGHT.fg3};white-space:nowrap;vertical-align:middle">${esc(r.time)}&nbsp;&rsaquo;</td>` +
    `</tr></table></a></td></tr>`
  );
}

function chatRowHtml(c: ChatRow): string {
  const body = `${esc(c.who)} sent ${spell(c.count)} new message${c.count === 1 ? '' : 's'}`;
  return (
    `<tr><td style="padding:0">` +
    `<a href="${c.url}" class="rowlink" style="display:block;text-decoration:none;color:inherit;padding:10px 16px;border-top:1px solid ${LIGHT.border}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    avatarCell(c.who) +
    `<td class="fg" style="font-family:${SANS};font-size:14px;color:${LIGHT.fg};vertical-align:middle">${body}</td>` +
    `<td class="fg3" align="right" style="font-family:${MONO};font-size:12px;color:${LIGHT.fg3};white-space:nowrap;vertical-align:middle">&rsaquo;</td>` +
    `</tr></table></a></td></tr>`
  );
}

function sectionHtml(label: string, rows: CatchupRow[]): string {
  if (rows.length === 0) return '';
  return (
    `<tr><td style="padding-top:18px">` +
    `<div class="fg3" style="font-family:${MONO};text-transform:uppercase;font-size:11px;letter-spacing:0.07em;color:${LIGHT.fg3};padding:0 16px 4px">${esc(label)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="panel" style="background:${LIGHT.panel};border:1px solid ${LIGHT.border};border-radius:10px">${rows.map(rowHtml).join('')}</table>` +
    `</td></tr>`
  );
}

function chatSectionHtml(rows: ChatRow[]): string {
  if (rows.length === 0) return '';
  return (
    `<tr><td style="padding-top:18px">` +
    `<div class="fg3" style="font-family:${MONO};text-transform:uppercase;font-size:11px;letter-spacing:0.07em;color:${LIGHT.fg3};padding:0 16px 4px">Chat</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="panel" style="background:${LIGHT.panel};border:1px solid ${LIGHT.border};border-radius:10px">${rows.map(chatRowHtml).join('')}</table>` +
    `</td></tr>`
  );
}

function countsHtml(cells: CatchupCountCell[]): string {
  const tds = cells
    .map(
      (c) =>
        `<td align="center" class="panel2" style="background:${LIGHT.panel2};border:1px solid ${LIGHT.border};border-radius:8px;padding:12px 6px">` +
        `<div class="fg" style="font-family:${SANS};font-size:20px;font-weight:600;color:${LIGHT.fg}">${c.count}</div>` +
        `<div class="fg3" style="font-family:${MONO};text-transform:uppercase;font-size:10px;letter-spacing:0.06em;color:${LIGHT.fg3};padding-top:2px">${c.label}</div>` +
        `</td>`,
    )
    .join('<td width="8" style="width:8px"></td>');
  return `<tr><td style="padding-top:18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tds}</tr></table></td></tr>`;
}

// Class-based dark overrides (prefers-color-scheme) plus [data-ogsc] for
// Outlook. Inline styles win on specificity, so each override carries
// !important. Mirrors the bulletproof dark-mode technique.
const DARK_STYLE = `
    @media (prefers-color-scheme: dark) {
      .bg { background:#0c0d10 !important; }
      .panel { background:#141519 !important; border-color:#23262c !important; }
      .panel2 { background:#1a1c21 !important; border-color:#23262c !important; }
      .rowlink { border-color:#23262c !important; }
      .fg { color:#f4f5f6 !important; }
      .fg2 { color:#9aa0a8 !important; }
      .fg3 { color:#6b7178 !important; }
      .accent { color:#6f79e3 !important; }
      .avatar { background:#222538 !important; color:#6f79e3 !important; }
      .stage-approved { color:#46b47a !important; }
      .stage-rejected { color:#e0685a !important; }
      .stage-review { color:#e0954a !important; }
      .stage-parked { color:#8a949e !important; }
    }
    [data-ogsc] .bg { background:#0c0d10 !important; }
    [data-ogsc] .panel { background:#141519 !important; border-color:#23262c !important; }
    [data-ogsc] .panel2 { background:#1a1c21 !important; border-color:#23262c !important; }
    [data-ogsc] .rowlink { border-color:#23262c !important; }
    [data-ogsc] .fg { color:#f4f5f6 !important; }
    [data-ogsc] .fg2 { color:#9aa0a8 !important; }
    [data-ogsc] .fg3 { color:#6b7178 !important; }
    [data-ogsc] .accent { color:#6f79e3 !important; }
    [data-ogsc] .avatar { background:#222538 !important; color:#6f79e3 !important; }
    [data-ogsc] .stage-approved { color:#46b47a !important; }
    [data-ogsc] .stage-rejected { color:#e0685a !important; }
    [data-ogsc] .stage-review { color:#e0954a !important; }
    [data-ogsc] .stage-parked { color:#8a949e !important; }`;

export function renderCatchupEmail(data: CatchupData): CatchupEmail {
  const subject = `[${data.workspaceName}] Your catch-up`;
  const summary = summarizeCatchup(data);

  const sections =
    sectionHtml('Stage changes', data.stages) +
    sectionHtml('Comments & mentions', data.comments) +
    sectionHtml('Brief', data.briefs) +
    sectionHtml('Asset', data.assets) +
    chatSectionHtml(data.chats);

  const counts = shouldShowCounts(data) ? countsHtml(countCells(data)) : '';

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">` +
    `<style>${DARK_STYLE}</style></head>` +
    `<body class="bg" style="margin:0;padding:0;background:${LIGHT.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${LIGHT.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;letter-spacing:-0.006em">` +
    // header
    `<tr><td style="padding:0 16px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="accent" style="font-family:${MONO};text-transform:uppercase;font-size:13px;letter-spacing:0.12em;font-weight:500;color:${LIGHT.accent}">Sorted</td>` +
    `<td class="fg3" align="right" style="font-family:${MONO};font-size:12px;color:${LIGHT.fg3}">${esc(data.sinceLabel)}</td>` +
    `</tr></table></td></tr>` +
    // masthead
    `<tr><td class="panel" style="background:${LIGHT.panel};border:1px solid ${LIGHT.border};border-radius:12px;padding:18px 16px">` +
    `<div class="fg3" style="font-family:${MONO};text-transform:uppercase;font-size:11px;letter-spacing:0.07em;color:${LIGHT.fg3};padding-bottom:8px">${esc(data.workspaceName)} &middot; since ${esc(data.sinceLabel)}</div>` +
    `<div class="fg" style="font-family:${SANS};font-size:18px;font-weight:500;line-height:1.4;color:${LIGHT.fg}">${esc(summary)}</div>` +
    `</td></tr>` +
    counts +
    sections +
    // schedule note
    `<tr><td class="fg3" style="font-family:${MONO};font-size:11px;line-height:1.6;color:${LIGHT.fg3};padding:20px 16px 0">${SCHEDULE_NOTE}</td></tr>` +
    // footer
    `<tr><td style="padding:20px 16px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="accent" style="font-family:${MONO};text-transform:uppercase;font-size:12px;letter-spacing:0.12em;color:${LIGHT.accent}">Sorted</td>` +
    `<td class="fg3" align="right" style="font-family:${SANS};font-size:12px;color:${LIGHT.fg3}">Notification settings &middot; Unsubscribe</td>` +
    `</tr></table></td></tr>` +
    `</table></td></tr></table></body></html>`;

  const textLines: string[] = [summary, ''];
  for (const r of activityRows(data)) textLines.push(`${r.who} ${r.verb} ${r.target} - ${r.url}`);
  for (const c of data.chats)
    textLines.push(
      `${c.who} sent ${spell(c.count)} new message${c.count === 1 ? '' : 's'} - ${c.url}`,
    );
  textLines.push('', SCHEDULE_NOTE);
  const text = textLines.join('\n');

  const messageId = (slotIso: string): string =>
    `<catchup-${data.recipientUserId}-${slotIso}@srtd.io>`;

  return { subject, html, text, messageId };
}
