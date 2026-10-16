// @srtdio/inbox catch-up email renderer. Pure and deterministic: no I/O, no
// fetch, no Supabase, no clock. Everything arrives resolved in the
// RecipientDigest (names, titles, urls, recipient-local dates); this module only
// turns it into a subject, an email-safe HTML part and a plain-text part. No
// AI: the headline is a hand-written template over the digest counts.

import {
  DM_PREVIEW_MAX,
  SECTION_ROW_CAP,
  type CommentItem,
  type DigestRenderer,
  type DmItem,
  type PostItem,
  type RecipientDigest,
  type Section,
  type Slot,
  type StageItem,
} from './catchup-contracts';

// --- deep-link URL emitters ---------------------------------------------------
// The base is always passed in, never hardcoded. G2 builds each row.url with
// these helpers so the frontend and the Worker share one URL shape.

export interface CatchupUrlBuilders {
  post: (id: string) => string;
  brief: (id: string) => string;
  comment: (entityType: 'post' | 'brief', entityId: string, commentId: string) => string;
  asset: (id: string) => string;
  chat: (channelId: string) => string;
  activity: () => string;
  pipeline: () => string;
  chatHome: () => string;
  briefs: () => string;
}

export function buildCatchupUrls(baseUrl: string, workspaceId: string): CatchupUrlBuilders {
  const base = baseUrl.replace(/\/+$/, '');
  const ws = encodeURIComponent(workspaceId);
  const enc = encodeURIComponent;
  return {
    post: (id) => `${base}/posts/${enc(id)}?w=${ws}`,
    brief: (id) => `${base}/briefs/${enc(id)}?w=${ws}`,
    comment: (entityType, entityId, commentId) =>
      `${base}/${entityType === 'post' ? 'posts' : 'briefs'}/${enc(entityId)}?w=${ws}&comment=${enc(commentId)}`,
    asset: (id) => `${base}/assets?w=${ws}&asset=${enc(id)}`,
    chat: (channelId) => `${base}/chat?w=${ws}&channel=${enc(channelId)}`,
    activity: () => `${base}/activity?w=${ws}`,
    pipeline: () => `${base}/pipeline?w=${ws}`,
    chatHome: () => `${base}/chat?w=${ws}`,
    briefs: () => `${base}/briefs?w=${ws}`,
  };
}

// --- subject ------------------------------------------------------------------

export function buildCatchupSubject(workspaceName: string, slot: Slot): string {
  return `[${workspaceName}] ${slot === '10:30' ? 'Morning' : 'Afternoon'} catch-up`;
}

// --- DM preview -----------------------------------------------------------------

const MENTION_TOKEN = /@\[([^\]]*)\]/g;

/**
 * One-line plain-text preview of a raw chat body: @[uuid] tokens become "@Name"
 * ("@someone" when unknown), whitespace collapses, and anything longer than
 * DM_PREVIEW_MAX characters is cut and suffixed with "...". A null body is an
 * attachment-only message.
 */
export function dmPreview(body: string | null, mentionNames: Record<string, string>): string {
  if (body === null) return 'Sent an attachment';
  const resolved = body.replace(MENTION_TOKEN, (_m, id: string) => {
    const name = Object.prototype.hasOwnProperty.call(mentionNames, id)
      ? mentionNames[id]
      : undefined;
    return `@${name !== undefined && name.trim() !== '' ? name.trim() : 'someone'}`;
  });
  const flat = resolved.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'Sent an attachment';
  const chars = Array.from(flat);
  if (chars.length <= DM_PREVIEW_MAX) return flat;
  return `${chars.slice(0, DM_PREVIEW_MAX).join('')}...`;
}

// --- small pure helpers -----------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

// Numbers are spelled to nine; ten and above stay numeric.
function spell(n: number): string {
  return ONES[n] ?? String(n);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1] ?? ''}`;
}

function sentence(clauses: string[]): string {
  return `${cap(joinClauses(clauses))}.`;
}

function slotTime(slot: Slot): string {
  return slot === '10:30' ? '10:30 am' : '3:30 pm';
}

function eyebrow(slot: Slot): string {
  return slot === '10:30' ? 'Morning catch-up · 10:30' : 'Afternoon catch-up · 3:30';
}

function sinceLine(d: RecipientDigest): string {
  const time = slotTime(d.previous.slot);
  return d.previous.sameDay
    ? `Everything since ${time}`
    : `Everything since ${d.previous.weekday} ${time}`;
}

function dateLine(d: RecipientDigest): string {
  return `${d.workspaceName} · ${d.local.weekday} ${d.local.day} ${d.local.month}`;
}

const DAY_MS = 86_400_000;

/**
 * Whole days a post has waited, from the UTC date of stageEnteredAt to the
 * recipient's local slot date. There is no clock here, so the slot date is the
 * reference. Null when either date is unreadable.
 */
function ageLabel(stageEnteredAt: string, localIsoDate: string): string | null {
  const from = Date.parse(`${stageEnteredAt.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${localIsoDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / DAY_MS);
  return days <= 0 ? 'today' : `${days}d`;
}

function isDraft(item: object): boolean {
  return 'stage' in item && item.stage === 'draft';
}

// --- headline -------------------------------------------------------------------

function headline(d: RecipientDigest): string {
  const c = d.counts;
  const clauses: string[] = [];
  if (d.audience === 'client') {
    if (c.inReview > 0)
      clauses.push(
        `${spell(c.inReview)} ${plural(c.inReview, 'post', 'posts')} waiting for your review`,
      );
    if (c.unreadMessages > 0)
      clauses.push(
        `${spell(c.unreadMessages)} unread ${plural(c.unreadMessages, 'message', 'messages')}`,
      );
    if (c.comments > 0)
      clauses.push(`${spell(c.comments)} new ${plural(c.comments, 'comment', 'comments')}`);
    if (clauses.length === 0) {
      if (c.approved > 0)
        clauses.push(`${spell(c.approved)} ${plural(c.approved, 'post', 'posts')} approved`);
      if (c.parked > 0)
        clauses.push(`${spell(c.parked)} ${plural(c.parked, 'post', 'posts')} parked`);
    }
  } else {
    if (c.comments > 0)
      clauses.push(
        `${spell(c.comments)} new ${plural(c.comments, 'comment', 'comments')} to address`,
      );
    if (c.approved > 0)
      clauses.push(`${spell(c.approved)} ${plural(c.approved, 'post', 'posts')} approved`);
    if (c.inReview > 0)
      clauses.push(
        `${spell(c.inReview)} ${plural(c.inReview, 'post', 'posts')} still waiting on the client`,
      );
    if (c.unreadMessages > 0)
      clauses.push(
        `${spell(c.unreadMessages)} unread ${plural(c.unreadMessages, 'message', 'messages')}`,
      );
    if (clauses.length === 0 && c.newBriefs > 0)
      clauses.push(`${spell(c.newBriefs)} new ${plural(c.newBriefs, 'brief', 'briefs')}`);
  }
  return clauses.length === 0 ? 'Nothing new since your last catch-up.' : sentence(clauses);
}

interface StatTile {
  label: string;
  count: number;
}

function statTiles(d: RecipientDigest): StatTile[] {
  const c = d.counts;
  return d.audience === 'client'
    ? [
        { label: 'In review', count: c.inReview },
        { label: 'Unread messages', count: c.unreadMessages },
        { label: 'New comments', count: c.comments },
      ]
    : [
        { label: 'Feedback', count: c.comments },
        { label: 'Approved', count: c.approved },
        { label: 'Waiting on client', count: c.inReview },
      ];
}

// --- section model (shared by HTML and text) -----------------------------------------

interface RenderRow {
  /** Plain-text label; also the HTML label (escaped). */
  text: string;
  /** Optional strong lead rendered before text in HTML (escaped). */
  lead?: string;
  /** Optional second line (DM preview). */
  sub?: string;
  /** Optional right-hand meta (age, count). */
  meta?: string;
  url: string;
}

interface RenderSection {
  title: string;
  rows: RenderRow[];
  more: number;
  moreUrl: string;
}

interface SummaryLine {
  text: string;
  url: string;
}

function capSection<T extends object>(
  section: Section<T>,
  keep: (item: T) => boolean,
): { shown: T[]; more: number } {
  const kept = section.items.filter(keep);
  const removed = section.items.length - kept.length;
  const shown = kept.slice(0, SECTION_ROW_CAP);
  const total = Math.max(section.total - removed, kept.length);
  return { shown, more: Math.max(0, total - shown.length) };
}

function always(): boolean {
  return true;
}

function postRow(p: PostItem, d: RecipientDigest, withAge: boolean): RenderRow {
  const age = withAge ? ageLabel(p.stageEnteredAt, d.local.isoDate) : null;
  return age === null ? { text: p.title, url: p.url } : { text: p.title, meta: age, url: p.url };
}

function commentRow(c: CommentItem): RenderRow {
  const verb = c.mention ? 'mentioned you on' : 'commented on';
  return { lead: c.actorName, text: `${verb} ${c.targetTitle}`, url: c.url };
}

function approvedRow(s: StageItem): RenderRow {
  return { text: s.title, url: s.url };
}

function dmRow(m: DmItem, names: Record<string, string>): RenderRow {
  return {
    lead: m.senderName,
    text: `· ${m.unreadCount} new ${plural(m.unreadCount, 'message', 'messages')}`,
    sub: dmPreview(m.latestBody, names),
    url: m.url,
  };
}

function oldestFirst(items: PostItem[]): PostItem[] {
  return items
    .map((p, i) => ({ p, i, t: Date.parse(p.stageEnteredAt) }))
    .sort((a, b) => {
      const at = Number.isNaN(a.t) ? Infinity : a.t;
      const bt = Number.isNaN(b.t) ? Infinity : b.t;
      return at === bt ? a.i - b.i : at - bt;
    })
    .map((x) => x.p);
}

function buildSections(d: RecipientDigest): { sections: RenderSection[]; summary: SummaryLine[] } {
  const urls = buildCatchupUrls(d.appBaseUrl, d.workspaceId);
  const sections: RenderSection[] = [];
  const summary: SummaryLine[] = [];

  const review = (title: string, withAge: boolean): RenderSection => {
    const items = withAge ? oldestFirst(d.review.items) : d.review.items;
    const { shown, more } = capSection({ items, total: d.review.total }, (p) => !isDraft(p));
    return {
      title,
      rows: shown.map((p) => postRow(p, d, withAge)),
      more,
      moreUrl: urls.pipeline(),
    };
  };
  const comments = (title: string): RenderSection => {
    const { shown, more } = capSection(d.comments, always);
    return { title, rows: shown.map(commentRow), more, moreUrl: urls.activity() };
  };
  const approved = (): RenderSection => {
    const { shown, more } = capSection(d.approved, always);
    return {
      title: 'Approved today',
      rows: shown.map(approvedRow),
      more,
      moreUrl: urls.pipeline(),
    };
  };
  const dms = (): RenderSection => {
    const { shown, more } = capSection(d.dms, always);
    return {
      title: 'Messages you missed',
      rows: shown.map((m) => dmRow(m, d.mentionNames)),
      more,
      moreUrl: urls.chatHome(),
    };
  };

  const c = d.counts;
  if (d.audience === 'client') {
    sections.push(review('Waiting for your review', false));
    sections.push(dms());
    sections.push(comments('New comments on your posts'));
    const parts: string[] = [];
    if (c.approved > 0)
      parts.push(`${spell(c.approved)} ${plural(c.approved, 'post', 'posts')} approved`);
    if (c.parked > 0)
      parts.push(
        c.approved > 0
          ? `${spell(c.parked)} parked`
          : `${spell(c.parked)} ${plural(c.parked, 'post', 'posts')} parked`,
      );
    if (parts.length > 0) summary.push({ text: sentence(parts), url: urls.pipeline() });
  } else {
    sections.push(comments('Client feedback to address'));
    sections.push(approved());
    sections.push(review('Still waiting on the client', true));
    sections.push(dms());
    if (c.newBriefs > 0)
      summary.push({
        text: `${cap(spell(c.newBriefs))} new ${plural(c.newBriefs, 'brief', 'briefs')} from the client.`,
        url: urls.briefs(),
      });
  }

  return {
    sections: sections.filter((s) => s.rows.length > 0 || s.more > 0),
    summary,
  };
}

// --- HTML -----------------------------------------------------------------------

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

const LIGHT = {
  bg: '#f7f8f9',
  panel: '#ffffff',
  panel2: '#f2f3f5',
  border: '#e6e8eb',
  fg: '#1b1c20',
  fg2: '#4f535a',
  fg3: '#6b7078',
  accent: '#5e6ad2',
  onAccent: '#ffffff',
} as const;

const FOOTER_NOTE =
  "You get Sorted catch-ups at 10:30 am and 3:30 pm your time, Mon to Fri, only for things you haven't seen in Sorted. Nothing new, no email.";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Class-based dark overrides (prefers-color-scheme) plus [data-ogsc] mirrors for
// Outlook. Inline styles win on specificity, so each override is !important.
const DARK_RULES = [
  '.bg { background:#0b0b0f !important; }',
  '.panel { background:#16161d !important; border-color:#272733 !important; }',
  '.panel2 { background:#1d1d26 !important; border-color:#272733 !important; }',
  '.rowlink { border-color:#272733 !important; }',
  '.fg { color:#f4f5f6 !important; }',
  '.fg2 { color:#b4b8bf !important; }',
  '.fg3 { color:#9095a0 !important; }',
  '.accent { color:#6f79e3 !important; }',
  '.btn { background:#6f79e3 !important; color:#ffffff !important; }',
];

const STYLE =
  `:root { color-scheme: light dark; supported-color-schemes: light dark; }` +
  `a { text-decoration:none; }` +
  `@media (prefers-color-scheme: dark) { ${DARK_RULES.join(' ')} }` +
  DARK_RULES.map((r) => `[data-ogsc] ${r}`).join(' ');

const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

// The first row in a panel has no top rule; later rows and the more link do.
function rule(first: boolean): string {
  return first ? 'border-top:0' : `border-top:1px solid ${LIGHT.border}`;
}

function rowHtml(r: RenderRow, first: boolean): string {
  const lead =
    r.lead === undefined
      ? ''
      : `<strong class="fg" style="font-weight:600;color:${LIGHT.fg}">${esc(r.lead)}</strong> `;
  const sub =
    r.sub === undefined
      ? ''
      : `<div class="fg2" style="font-family:${SANS};font-size:13px;line-height:18px;color:${LIGHT.fg2};padding-top:2px">${esc(r.sub)}</div>`;
  const meta = r.meta === undefined ? '' : `${esc(r.meta)}&nbsp;`;
  return (
    `<tr><td style="padding:0">` +
    `<a href="${esc(r.url)}" class="rowlink" style="display:block;min-height:20px;padding:12px 16px;line-height:20px;text-decoration:none;color:${LIGHT.fg};${rule(first)}">` +
    `<table ${TABLE}><tr>` +
    `<td class="fg" style="font-family:${SANS};font-size:14px;line-height:20px;color:${LIGHT.fg};vertical-align:middle">${lead}${esc(r.text)}${sub}</td>` +
    `<td class="fg3" align="right" style="font-family:${SANS};font-size:12px;line-height:20px;color:${LIGHT.fg3};white-space:nowrap;vertical-align:middle;padding-left:12px">${meta}&rsaquo;</td>` +
    `</tr></table></a></td></tr>`
  );
}

function moreHtml(more: number, url: string, first: boolean): string {
  return (
    `<tr><td style="padding:0">` +
    `<a href="${esc(url)}" class="rowlink accent" style="display:block;min-height:20px;padding:12px 16px;line-height:20px;font-family:${SANS};font-size:13px;font-weight:500;text-decoration:none;color:${LIGHT.accent};${rule(first)}">+${more} more in Sorted &rsaquo;</a>` +
    `</td></tr>`
  );
}

function sectionHtml(s: RenderSection): string {
  const rows =
    s.rows.map((r, i) => rowHtml(r, i === 0)).join('') +
    (s.more > 0 ? moreHtml(s.more, s.moreUrl, s.rows.length === 0) : '');
  return (
    `<tr><td style="padding-top:24px">` +
    `<div class="fg2" style="font-family:${SANS};font-size:13px;font-weight:600;line-height:18px;color:${LIGHT.fg2};padding:0 4px 8px">${esc(s.title)}</div>` +
    `<table ${TABLE} class="panel" style="background:${LIGHT.panel};border:1px solid ${LIGHT.border};border-radius:10px;border-collapse:separate;overflow:hidden">${rows}</table>` +
    `</td></tr>`
  );
}

function summaryHtml(line: SummaryLine): string {
  return (
    `<tr><td style="padding-top:16px">` +
    `<a href="${esc(line.url)}" class="fg2" style="display:block;min-height:20px;padding:12px 4px;line-height:20px;font-family:${SANS};font-size:14px;text-decoration:none;color:${LIGHT.fg2}">${esc(line.text)} <span class="accent" style="color:${LIGHT.accent}">&rsaquo;</span></a>` +
    `</td></tr>`
  );
}

function tilesHtml(tiles: StatTile[]): string {
  const tds = tiles
    .map(
      (t) =>
        `<td width="33%" align="center" valign="top" class="panel2" style="width:33%;background:${LIGHT.panel2};border:1px solid ${LIGHT.border};border-radius:8px;padding:14px 6px">` +
        `<div class="fg" style="font-family:${SANS};font-size:24px;font-weight:600;line-height:28px;color:${LIGHT.fg}">${t.count}</div>` +
        `<div class="fg3" style="font-family:${SANS};font-size:12px;line-height:16px;color:${LIGHT.fg3};padding-top:4px">${esc(t.label)}</div>` +
        `</td>`,
    )
    .join('<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>');
  return `<tr><td style="padding-top:20px"><table ${TABLE}><tr>${tds}</tr></table></td></tr>`;
}

function renderHtml(
  d: RecipientDigest,
  head: string,
  tiles: StatTile[],
  sections: RenderSection[],
  summary: SummaryLine[],
  activityUrl: string,
): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${esc(buildCatchupSubject(d.workspaceName, d.slot))}</title>` +
    `<style>${STYLE}</style></head>` +
    `<body class="bg" style="margin:0;padding:0;background:${LIGHT.bg}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(head)}</div>` +
    `<table ${TABLE} class="bg" style="background:${LIGHT.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">` +
    // header: wordmark + workspace/date
    `<tr><td style="padding:0 4px 16px"><table ${TABLE}><tr>` +
    `<td class="accent" style="font-family:${SANS};font-size:18px;font-weight:700;letter-spacing:-0.02em;line-height:24px;color:${LIGHT.accent}">Sorted</td>` +
    `<td class="fg3" align="right" style="font-family:${SANS};font-size:13px;line-height:24px;color:${LIGHT.fg3}">${esc(dateLine(d))}</td>` +
    `</tr></table></td></tr>` +
    // masthead
    `<tr><td class="panel" style="background:${LIGHT.panel};border:1px solid ${LIGHT.border};border-radius:12px;padding:24px 20px">` +
    `<div class="accent" style="font-family:${SANS};font-size:13px;font-weight:600;line-height:16px;color:${LIGHT.accent};padding-bottom:10px">${esc(eyebrow(d.slot))}</div>` +
    `<div class="fg" style="font-family:${SANS};font-size:22px;font-weight:600;line-height:30px;letter-spacing:-0.01em;color:${LIGHT.fg}">${esc(head)}</div>` +
    `<div class="fg3" style="font-family:${SANS};font-size:13px;line-height:18px;color:${LIGHT.fg3};padding-top:8px">${esc(sinceLine(d))}</div>` +
    `</td></tr>` +
    tilesHtml(tiles) +
    // button
    `<tr><td style="padding-top:20px"><a href="${esc(activityUrl)}" class="btn" style="display:inline-block;min-height:20px;padding:12px 24px;line-height:20px;border-radius:8px;background:${LIGHT.accent};color:${LIGHT.onAccent};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none">Open Sorted</a></td></tr>` +
    sections.map(sectionHtml).join('') +
    summary.map(summaryHtml).join('') +
    // footer
    `<tr><td style="padding:32px 4px 0;border-top:0">` +
    `<div class="fg3" style="font-family:${SANS};font-size:12px;line-height:18px;color:${LIGHT.fg3}">${esc(FOOTER_NOTE)}</div>` +
    `<a href="${esc(d.unsubscribeUrl)}" class="fg3" style="display:inline-block;min-height:20px;padding:12px 0;line-height:20px;font-family:${SANS};font-size:12px;color:${LIGHT.fg3};text-decoration:underline">Unsubscribe</a>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

// --- plain text -----------------------------------------------------------------

function rowText(r: RenderRow): string {
  const parts = [r.lead === undefined ? r.text : `${r.lead} ${r.text}`];
  if (r.meta !== undefined) parts.push(r.meta);
  if (r.sub !== undefined) parts.push(r.sub);
  return `- ${parts.join(' · ')}: ${r.url}`;
}

function renderText(
  d: RecipientDigest,
  head: string,
  tiles: StatTile[],
  sections: RenderSection[],
  summary: SummaryLine[],
  activityUrl: string,
): string {
  const lines: string[] = [
    `Sorted · ${dateLine(d)}`,
    eyebrow(d.slot),
    '',
    head,
    sinceLine(d),
    '',
    tiles.map((t) => `${t.label}: ${t.count}`).join(' · '),
    '',
    `Open Sorted: ${activityUrl}`,
  ];
  for (const s of sections) {
    lines.push('', s.title);
    for (const r of s.rows) lines.push(rowText(r));
    if (s.more > 0) lines.push(`+${s.more} more in Sorted: ${s.moreUrl}`);
  }
  for (const l of summary) lines.push('', `${l.text.replace(/\.$/, '')}: ${l.url}`);
  lines.push('', FOOTER_NOTE, `Unsubscribe: ${d.unsubscribeUrl}`);
  return lines.join('\n');
}

// --- entry point ----------------------------------------------------------------

export const renderCatchupEmail: DigestRenderer = (digest) => {
  const head = headline(digest);
  const tiles = statTiles(digest);
  const { sections, summary } = buildSections(digest);
  const activityUrl = buildCatchupUrls(digest.appBaseUrl, digest.workspaceId).activity();
  return {
    subject: buildCatchupSubject(digest.workspaceName, digest.slot),
    html: renderHtml(digest, head, tiles, sections, summary, activityUrl),
    text: renderText(digest, head, tiles, sections, summary, activityUrl),
  };
};
