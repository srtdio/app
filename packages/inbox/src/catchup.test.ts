import { describe, expect, it } from 'vitest';
import { buildCatchupSubject, buildCatchupUrls, dmPreview, renderCatchupEmail } from './catchup';
import {
  DM_PREVIEW_MAX,
  SECTION_ROW_CAP,
  type CommentItem,
  type DmItem,
  type PostItem,
  type RecipientDigest,
  type RenderedEmail,
  type Section,
  type StageItem,
} from './catchup-contracts';
import { AGENCY_ROLES, type Role } from './types';

// The catch-up renderer is pure: digest in, {subject, html, text} out. These
// tests pin the spec copy word for word, the per-section row cap and "+N more"
// links, the DM preview rules, role-specific sections, the footer, escaping and
// the dark-mode palette. Everything is built from the frozen contract shapes.

const BASE = 'https://app.test';
const WS = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';
const PRIYA = '00000000-0000-4000-8000-0000000000cc';
const STRANGER = '00000000-0000-4000-8000-0000000000dd';
const UNSUB = `${BASE}/unsubscribe?u=${USER}&t=tok_123`;

const AGENCY_ROLE: Role = AGENCY_ROLES[0] ?? 'owner';
const CLIENT_ROLE: Role = 'client' satisfies Role;

const urls = buildCatchupUrls(BASE, WS);

const CLIENT_HEADINGS = [
  'Waiting for your review',
  'Messages you missed',
  'New comments on your posts',
] as const;
const AGENCY_ONLY_HEADINGS = [
  'Client feedback to address',
  'Approved today',
  'Still waiting on the client',
] as const;
const CLIENT_ONLY_HEADINGS = ['Waiting for your review', 'New comments on your posts'] as const;

const FOOTER =
  "You get Sorted catch-ups at 10:30 am and 3:30 pm your time, Mon to Fri, only for things you haven't seen in Sorted. Nothing new, no email.";

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function label(prefix: string, i: number): string {
  return `${prefix} ${LETTERS.charAt(i)}`;
}

function postItems(n: number, prefix = 'Review post'): PostItem[] {
  return Array.from({ length: n }, (_, i) => ({
    postId: `post-${i}`,
    title: label(prefix, i),
    url: urls.post(`post-${i}`),
    stageEnteredAt: `2026-10-${String(10 + (i % 5)).padStart(2, '0')}T09:00:00.000Z`,
  }));
}

function commentItems(n: number, prefix = 'Commented post'): CommentItem[] {
  return Array.from({ length: n }, (_, i) => ({
    actorName: `Actor ${LETTERS.charAt(i)}`,
    targetTitle: label(prefix, i),
    entityType: 'post',
    entityId: `cpost-${i}`,
    url: urls.comment('post', `cpost-${i}`, `c-${i}`),
    createdAt: '2026-10-16T08:00:00.000Z',
    mention: i % 2 === 1,
  }));
}

function stageItems(n: number, prefix = 'Approved post'): StageItem[] {
  return Array.from({ length: n }, (_, i) => ({
    postId: `apost-${i}`,
    title: label(prefix, i),
    url: urls.post(`apost-${i}`),
    toStage: 'approved',
    createdAt: '2026-10-16T08:30:00.000Z',
  }));
}

function dmItems(n: number, prefix = 'Sender'): DmItem[] {
  return Array.from({ length: n }, (_, i) => ({
    channelId: `chan-${i}`,
    senderUserId: `sender-${i}`,
    senderName: label(prefix, i),
    unreadCount: 1 + i,
    latestBody: `Message body ${LETTERS.charAt(i)}`,
    url: urls.chat(`chan-${i}`),
  }));
}

function section<T>(items: T[], total = items.length): Section<T> {
  return { items, total };
}

function makeDigest(over: Partial<RecipientDigest> = {}): RecipientDigest {
  return {
    userId: USER,
    workspaceId: WS,
    workspaceName: 'Acme',
    role: CLIENT_ROLE,
    audience: 'client',
    slot: '15:30',
    local: { isoDate: '2026-10-16', weekday: 'Friday', day: 16, month: 'Oct' },
    previous: { slot: '10:30', weekday: 'Friday', sameDay: true },
    appBaseUrl: BASE,
    unsubscribeUrl: UNSUB,
    mentionNames: { [PRIYA]: 'Priya' },
    counts: { inReview: 0, unreadMessages: 0, comments: 0, approved: 0, parked: 0, newBriefs: 0 },
    review: section<PostItem>([]),
    comments: section<CommentItem>([]),
    approved: section<StageItem>([]),
    dms: section<DmItem>([]),
    ...over,
  };
}

function agencyDigest(over: Partial<RecipientDigest> = {}): RecipientDigest {
  return makeDigest({ role: AGENCY_ROLE, audience: 'agency', ...over });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&rsaquo;/g, '›')
    .replace(/&amp;/g, '&');
}

/** Visible text of the html body: tags and the <head>/<style> stripped, entities decoded. */
function visible(html: string): string {
  const noHead = html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return decodeEntities(noHead.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

interface Anchor {
  href: string;
  text: string;
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    out.push({
      href: decodeEntities(m[1] ?? ''),
      text: decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  return out;
}

function anchorsWithText(html: string, text: string): Anchor[] {
  return anchors(html).filter((a) => a.text === text);
}

/** "+N more in Sorted" links; a trailing decorative chevron is allowed. */
function moreLinks(html: string, n: number): Anchor[] {
  const re = new RegExp(`^\\+${n} more in Sorted(\\s*[›>])?$`);
  return anchors(html).filter((a) => re.test(a.text));
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function expectNoEmDash(email: RenderedEmail): void {
  expect(email.subject).not.toContain('—');
  expect(email.html).not.toContain('—');
  expect(email.html).not.toContain('&mdash;');
  expect(email.html).not.toContain('&#8212;');
  expect(email.text).not.toContain('—');
}

describe('buildCatchupUrls', () => {
  it('keeps the existing deep-link shapes', () => {
    expect(urls.post('p1')).toBe(`${BASE}/posts/p1?w=${WS}`);
    expect(urls.comment('post', 'p1', 'c1')).toBe(`${BASE}/posts/p1?w=${WS}&comment=c1`);
    expect(urls.comment('brief', 'b1', 'c1')).toBe(`${BASE}/briefs/b1?w=${WS}&comment=c1`);
    expect(urls.chat('ch1')).toBe(`${BASE}/chat?w=${WS}&channel=ch1`);
    expect(urls.activity()).toBe(`${BASE}/activity?w=${WS}`);
  });

  it('adds the list-page links used by "+N more in Sorted"', () => {
    expect(urls.pipeline()).toBe(`${BASE}/pipeline?w=${WS}`);
    expect(urls.chatHome()).toBe(`${BASE}/chat?w=${WS}`);
    expect(urls.briefs()).toBe(`${BASE}/briefs?w=${WS}`);
  });

  it('percent-encodes every id so no extra query param appears', () => {
    for (const id of ['p&x=1', 'a b']) {
      const enc = encodeURIComponent(id);
      const built = [
        urls.post(id),
        urls.brief(id),
        urls.comment('post', id, id),
        urls.comment('brief', id, id),
        urls.asset(id),
        urls.chat(id),
      ];
      for (const u of built) {
        expect(u).toContain(enc);
        expect(u).not.toContain(id);
        expect(u).not.toContain(' ');
        expect(new URL(u).searchParams.has('x')).toBe(false);
      }
      expect(urls.post(id)).toBe(`${BASE}/posts/${enc}?w=${WS}`);
      expect(urls.comment('post', id, id)).toBe(`${BASE}/posts/${enc}?w=${WS}&comment=${enc}`);
      expect(urls.chat(id)).toBe(`${BASE}/chat?w=${WS}&channel=${enc}`);
      expect(new URL(urls.chat(id)).searchParams.get('channel')).toBe(id);
    }
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildCatchupUrls(`${BASE}/`, WS).pipeline()).toBe(`${BASE}/pipeline?w=${WS}`);
  });
});

describe('buildCatchupSubject', () => {
  it('names the morning and afternoon catch-ups', () => {
    expect(buildCatchupSubject('Acme', '10:30')).toBe('[Acme] Morning catch-up');
    expect(buildCatchupSubject('Acme', '15:30')).toBe('[Acme] Afternoon catch-up');
  });

  it('is the rendered subject', () => {
    expect(renderCatchupEmail(makeDigest({ slot: '10:30' })).subject).toBe(
      '[Acme] Morning catch-up',
    );
    expect(renderCatchupEmail(makeDigest({ slot: '15:30' })).subject).toBe(
      '[Acme] Afternoon catch-up',
    );
  });
});

describe('header, eyebrow and since line', () => {
  it('renders the afternoon header copy', () => {
    const email = renderCatchupEmail(makeDigest({ review: section(postItems(1)) }));
    const v = visible(email.html);
    expect(v).toContain('Acme · Friday 16 Oct');
    expect(v).toContain('Afternoon catch-up · 3:30');
    expect(v).toContain('Everything since 10:30 am');
    expect(v).not.toContain('Everything since Friday');
  });

  it('reaches back to Friday afternoon on a Monday morning', () => {
    const email = renderCatchupEmail(
      makeDigest({
        slot: '10:30',
        local: { isoDate: '2026-10-19', weekday: 'Monday', day: 19, month: 'Oct' },
        previous: { slot: '15:30', weekday: 'Friday', sameDay: false },
        review: section(postItems(1)),
      }),
    );
    const v = visible(email.html);
    expect(v).toContain('Acme · Monday 19 Oct');
    expect(v).toContain('Morning catch-up · 10:30');
    expect(v).toContain('Everything since Friday 3:30 pm');
  });

  it('does not style the eyebrow uppercase', () => {
    const email = renderCatchupEmail(makeDigest({ slot: '10:30', review: section(postItems(1)) }));
    const html = email.html;
    const at = html.search(/Morning catch-up\s*(·|&middot;|&#183;|&#xb7;)\s*10:30/i);
    expect(at).toBeGreaterThan(-1);
    const open = html.slice(0, at).match(/<[a-z][^>]*>(?![\s\S]*<[a-z][^>]*>)/i)?.[0] ?? '';
    expect(open).not.toBe('');
    expect(open).not.toMatch(/text-transform:\s*uppercase/i);
    const classes = /\bclass="([^"]*)"/.exec(open)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((m) => m[1] ?? '')
      .join('\n');
    for (const c of classes) {
      const rules = [...css.matchAll(new RegExp(`\\.${c}\\b[^{]*\\{([^}]*)\\}`, 'g'))];
      rules.forEach((r) => expect(r[1] ?? '').not.toMatch(/text-transform:\s*uppercase/i));
    }
  });

  it('links "Open Sorted" to the activity page', () => {
    const email = renderCatchupEmail(makeDigest({ review: section(postItems(1)) }));
    const open = anchorsWithText(email.html, 'Open Sorted');
    expect(open.length).toBeGreaterThanOrEqual(1);
    for (const a of open) expect(a.href).toBe(urls.activity());
  });
});

describe('row cap and "+N more in Sorted"', () => {
  it('shows 5 of 7 rows and "+2 more in Sorted" linking to the pipeline', () => {
    const items = postItems(7);
    const email = renderCatchupEmail(makeDigest({ review: section(items, 7) }));
    const v = visible(email.html);
    items.slice(0, SECTION_ROW_CAP).forEach((p) => expect(v).toContain(p.title));
    items.slice(SECTION_ROW_CAP).forEach((p) => {
      expect(v).not.toContain(p.title);
      expect(email.text).not.toContain(p.title);
    });
    const more = moreLinks(email.html, 2);
    expect(more).toHaveLength(1);
    expect(more[0]?.href).toBe(urls.pipeline());
    expect(email.text).toContain('+2 more in Sorted');
  });

  it('counts "+N more" from the uncapped total', () => {
    const email = renderCatchupEmail(makeDigest({ review: section(postItems(5), 12) }));
    expect(moreLinks(email.html, 7)).toHaveLength(1);
    expect(email.text).toContain('+7 more in Sorted');
  });

  it('shows no "+N more" when a section has exactly 5', () => {
    const items = postItems(5);
    const email = renderCatchupEmail(makeDigest({ review: section(items, 5) }));
    const v = visible(email.html);
    items.forEach((p) => expect(v).toContain(p.title));
    expect(email.html).not.toMatch(/more in Sorted/);
    expect(email.text).not.toMatch(/more in Sorted/);
  });

  it('links comment overflow to activity and DM overflow to chat home', () => {
    const email = renderCatchupEmail(
      makeDigest({ comments: section(commentItems(7), 9), dms: section(dmItems(6), 8) }),
    );
    const commentsMore = moreLinks(email.html, 4);
    expect(commentsMore).toHaveLength(1);
    expect(commentsMore[0]?.href).toBe(urls.activity());
    const dmsMore = moreLinks(email.html, 3);
    expect(dmsMore).toHaveLength(1);
    expect(dmsMore[0]?.href).toBe(urls.chatHome());
  });

  it('links each rendered row to its deep link', () => {
    const items = postItems(2);
    const email = renderCatchupEmail(makeDigest({ review: section(items) }));
    const hrefs = anchors(email.html).map((a) => a.href);
    items.forEach((p) => expect(hrefs).toContain(p.url));
  });
});

describe('dmPreview', () => {
  it('leaves a short body unchanged', () => {
    expect(dmPreview('See you at 5', {})).toBe('See you at 5');
    const exact = 'x'.repeat(DM_PREVIEW_MAX);
    expect(dmPreview(exact, {})).toBe(exact);
  });

  it('truncates past 90 characters with "..."', () => {
    expect(dmPreview('y'.repeat(DM_PREVIEW_MAX + 1), {})).toBe(`${'y'.repeat(DM_PREVIEW_MAX)}...`);
    expect(dmPreview('z'.repeat(200), {})).toBe(`${'z'.repeat(DM_PREVIEW_MAX)}...`);
  });

  it('collapses newlines into one line', () => {
    const out = dmPreview('Hi\nthere\r\n\nfriend', {});
    expect(out).toBe('Hi there friend');
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('renders a known mention as @Name', () => {
    expect(dmPreview(`@[${PRIYA}] can you check?`, { [PRIYA]: 'Priya' })).toBe(
      '@Priya can you check?',
    );
  });

  it('never leaks a raw token for an unknown mention', () => {
    const out = dmPreview(`ping @[${STRANGER}] now`, { [PRIYA]: 'Priya' });
    expect(out).not.toContain('@[');
    expect(out).not.toContain(STRANGER);
    expect(out).toContain('ping');
    expect(out).toContain('now');
  });
});

describe('DM rows in the rendered email', () => {
  it('shows the sender and a one-line, mention-resolved preview', () => {
    const dm: DmItem = {
      channelId: 'chan-x',
      senderUserId: PRIYA,
      senderName: 'Priya',
      unreadCount: 2,
      latestBody: `Thanks @[${PRIYA}]\nand @[${STRANGER}] too`,
      url: urls.chat('chan-x'),
    };
    const email = renderCatchupEmail(makeDigest({ dms: section([dm]) }));
    const v = visible(email.html);
    expect(v).toContain('Priya');
    expect(v).toContain('Thanks @Priya and');
    expect(email.text).toContain('Thanks @Priya and');
    expect(email.html).not.toContain('@[');
    expect(email.text).not.toContain('@[');
    expect(anchors(email.html).map((a) => a.href)).toContain(dm.url);
  });

  it('truncates a long DM in the email too', () => {
    const body = 'w'.repeat(150);
    const dm: DmItem = { ...dmItems(1)[0]!, latestBody: body };
    const email = renderCatchupEmail(makeDigest({ dms: section([dm]) }));
    expect(email.text).toContain(`${'w'.repeat(DM_PREVIEW_MAX)}...`);
    expect(email.text).not.toContain('w'.repeat(DM_PREVIEW_MAX + 1));
  });
});

describe('role sections', () => {
  const full = {
    review: section(postItems(2)),
    comments: section(commentItems(2)),
    approved: section(stageItems(2)),
    dms: section(dmItems(2)),
  };

  it('a client digest has only the client headings', () => {
    const email = renderCatchupEmail(makeDigest(full));
    const v = visible(email.html);
    CLIENT_HEADINGS.forEach((h) => {
      expect(v).toContain(h);
      expect(email.text).toContain(h);
    });
    AGENCY_ONLY_HEADINGS.forEach((h) => {
      expect(v).not.toContain(h);
      expect(email.text).not.toContain(h);
    });
  });

  it('an agency digest has only the agency headings', () => {
    const email = renderCatchupEmail(agencyDigest(full));
    const v = visible(email.html);
    [...AGENCY_ONLY_HEADINGS, 'Messages you missed'].forEach((h) => {
      expect(v).toContain(h);
      expect(email.text).toContain(h);
    });
    CLIENT_ONLY_HEADINGS.forEach((h) => {
      expect(v).not.toContain(h);
      expect(email.text).not.toContain(h);
    });
    stageItems(2).forEach((s) => expect(v).toContain(s.title));
  });

  it('agency review overflow also links to the pipeline', () => {
    const email = renderCatchupEmail(agencyDigest({ review: section(postItems(6), 6) }));
    const more = moreLinks(email.html, 1);
    expect(more).toHaveLength(1);
    expect(more[0]?.href).toBe(urls.pipeline());
  });
});

describe('footer', () => {
  it('html ends with the exact footer copy and one Unsubscribe link', () => {
    const email = renderCatchupEmail(makeDigest({ review: section(postItems(1)) }));
    const v = visible(email.html);
    expect(v).toContain(FOOTER);
    const unsub = anchorsWithText(email.html, 'Unsubscribe');
    expect(unsub).toHaveLength(1);
    expect(unsub[0]?.href).toBe(UNSUB);
    expect(anchors(email.html).filter((a) => /unsubscribe/i.test(a.text))).toHaveLength(1);
    expect(v.indexOf(FOOTER)).toBeLessThan(v.lastIndexOf('Unsubscribe'));
  });

  it('text part has the footer and the unsubscribe url once', () => {
    const email = renderCatchupEmail(makeDigest({ review: section(postItems(1)) }));
    const t = email.text.replace(/\s+/g, ' ');
    expect(t).toContain(FOOTER);
    expect(countOf(email.text, 'Unsubscribe')).toBe(1);
    expect(countOf(email.text, UNSUB)).toBe(1);
    expect(t.indexOf(FOOTER)).toBeLessThan(t.indexOf('Unsubscribe'));
  });
});

describe('only digest-provided rows', () => {
  it('renders the review posts it is given and invents nothing', () => {
    const items = postItems(3);
    const email = renderCatchupEmail(makeDigest({ review: section(items) }));
    const v = visible(email.html);
    items.forEach((p) => {
      expect(v).toContain(p.title);
      expect(email.text).toContain(p.title);
    });
    expect(v).not.toContain('Secret draft');
    expect(email.text).not.toContain('Secret draft');
    expect(v).not.toContain(label('Review post', 3));
  });

  it('every row link is one the digest provided (or a list link)', () => {
    const d = makeDigest({
      review: section(postItems(2)),
      comments: section(commentItems(2)),
      dms: section(dmItems(2)),
    });
    const email = renderCatchupEmail(d);
    const allowed = new Set<string>([
      ...d.review.items.map((i) => i.url),
      ...d.comments.items.map((i) => i.url),
      ...d.dms.items.map((i) => i.url),
      urls.activity(),
      urls.pipeline(),
      urls.chatHome(),
      urls.briefs(),
      UNSUB,
    ]);
    anchors(email.html).forEach((a) => expect(allowed).toContain(a.href));
  });
});

describe('escaping', () => {
  it('escapes a hostile title in html', () => {
    const evil = '<script>alert(1)</script> & "quotes"';
    const [first] = postItems(1);
    const email = renderCatchupEmail(
      makeDigest({ workspaceName: 'Acme', review: section([{ ...first!, title: evil }]) }),
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(visible(email.html)).toContain(evil);
    expect(email.text).toContain(evil);
  });

  it('escapes a hostile DM body and sender name', () => {
    const dm: DmItem = {
      ...dmItems(1)[0]!,
      senderName: '<b>Mallory</b>',
      latestBody: '<img src=x onerror=alert(1)>',
    };
    const email = renderCatchupEmail(makeDigest({ dms: section([dm]) }));
    expect(email.html).not.toContain('<b>Mallory</b>');
    expect(email.html).not.toContain('<img src=x');
  });
});

describe('html design and parity', () => {
  const email = renderCatchupEmail(
    agencyDigest({
      review: section(postItems(2)),
      comments: section(commentItems(2)),
      approved: section(stageItems(2)),
      dms: section(dmItems(2)),
    }),
  );

  it('has a dark-mode block with the dark palette', () => {
    const m = /prefers-color-scheme:\s*dark/i.exec(email.html);
    expect(m).not.toBeNull();
    const dark = email.html.slice(m?.index ?? 0).toLowerCase();
    expect(dark).toContain('#0b0b0f');
    expect(dark).toContain('#16161d');
    expect(dark).toContain('#6f79e3');
  });

  it('uses the accent, a 600px max width and Inter', () => {
    expect(email.html.toLowerCase()).toContain('#5e6ad2');
    expect(email.html).toMatch(/max-width:\s*600px/i);
    expect(email.html).toMatch(/font-family:[^;"]*Inter/);
  });

  it('has a plain text part with sections and footer', () => {
    expect(email.text.length).toBeGreaterThan(0);
    expect(email.text).not.toMatch(/<[a-z][^>]*>/i);
    expect(email.text).toContain('Client feedback to address');
    expect(email.text).toContain(FOOTER.split(' ').slice(0, 6).join(' '));
  });

  it('has no em-dash in any part, for either role or slot', () => {
    expectNoEmDash(email);
    expectNoEmDash(
      renderCatchupEmail(
        makeDigest({
          slot: '10:30',
          previous: { slot: '15:30', weekday: 'Friday', sameDay: false },
          review: section(postItems(7), 7),
          comments: section(commentItems(2)),
          dms: section(dmItems(2)),
        }),
      ),
    );
  });
});
