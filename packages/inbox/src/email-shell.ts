// SOURCE OF TRUTH for the look of every email Sorted sends: head (color-scheme
// metas + dark block), card, header with the wordmark, footer. Edge functions
// are self-contained, so supabase/functions/{invite-send,brand-request-send,
// book-call-send,demo-request-send}/email-shell.ts are verbatim copies below
// this header (guard: email-shell.sync.test.ts). Change both together.

// One look: grey page, lit card (lighter top edge, 2px darker bottom line) drawn
// with borders, because mail clients drop shadows. Black and white only. Every
// colour an email uses comes from these two token sets; the light value is
// inline, the dark value lives in the prefers-color-scheme block below.

export const EMAIL_LIGHT = {
  bg: '#f4f5f6',
  panel: '#ffffff',
  /** Card edge: quiet, a whole card does not need a 3:1 line. */
  edge: '#d7dade',
  edgeTop: '#eceef1',
  /** The 2px bottom line that makes the card lit. */
  rim: '#c9ced5',
  /** 3:1 line for the code box and buttons. */
  line: '#868b94',
  rule: '#e4e5e8',
  codeFill: '#f2f3f5',
  fg: '#08090a',
  fg2: '#62666d',
  fg3: '#62666d',
  btnFill: '#08090a',
  btnTop: '#3b3d42',
  btnInk: '#ffffff',
} as const;

export const EMAIL_DARK = {
  bg: '#08090a',
  panel: '#1a1c21',
  edge: '#2a2b2f',
  edgeTop: '#36383d',
  rim: '#050506',
  line: '#6b7079',
  rule: '#26282e',
  codeFill: '#16171a',
  fg: '#f7f8f8',
  fg2: '#b4b8bf',
  fg3: '#9095a0',
  btnFill: '#ffffff',
  btnTop: '#ffffff',
  btnInk: '#08090a',
} as const;

export const EMAIL_SANS =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const EMAIL_MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const EMAIL_TABLE =
  'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

/** The app's Wordmark exported at 2x, ink and white. Absolute: mail clients fetch it. */
export const EMAIL_WORDMARK = {
  light: 'https://srtd.io/email/wordmark-light.png',
  dark: 'https://srtd.io/email/wordmark-dark.png',
  width: 64,
  height: 24,
  alt: 'Sorted',
} as const;

const L = EMAIL_LIGHT;
const D = EMAIL_DARK;

/** Lit card edges, light values inline (pair with class="panel"). */
export const EMAIL_CARD_EDGES = `border:1px solid ${L.edge};border-top-color:${L.edgeTop};border-bottom:2px solid ${L.rim}`;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function emailEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

// Class-based dark overrides plus [data-ogsc] mirrors for Outlook. Inline
// styles win on specificity, so each override is !important.
const DARK_RULES: readonly string[] = [
  `.bg { background:${D.bg} !important; }`,
  `.panel { background:${D.panel} !important; border-color:${D.edge} !important; border-top-color:${D.edgeTop} !important; border-bottom-color:${D.rim} !important; }`,
  `.rowlink { border-color:${D.rule} !important; }`,
  `.rule { background:${D.rule} !important; }`,
  `.fg { color:${D.fg} !important; }`,
  `.fg2 { color:${D.fg2} !important; }`,
  `.fg3 { color:${D.fg3} !important; }`,
  `.accent { color:${D.fg} !important; }`,
  `.btn { background:${D.btnFill} !important; color:${D.btnInk} !important; border-color:${D.btnFill} !important; border-top-color:${D.btnTop} !important; border-bottom-color:${D.line} !important; }`,
  `.code { background:${D.codeFill} !important; border-color:${D.line} !important; color:${D.fg} !important; }`,
  `.wm-l { display:none !important; }`,
  `.wm-d { display:block !important; max-height:none !important; overflow:visible !important; }`,
];

export const EMAIL_STYLE =
  `:root { color-scheme: light dark; supported-color-schemes: light dark; }` +
  `body { margin:0; padding:0; }` +
  `a { text-decoration:none; }` +
  `@media (prefers-color-scheme: dark) { ${DARK_RULES.join(' ')} }` +
  DARK_RULES.map((rule) => `[data-ogsc] ${rule}`).join(' ');

/** doctype, html, head (both color-scheme metas, title, the dark block). */
export function emailHead(title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${title}</title>` +
    `<style>${EMAIL_STYLE}</style></head>`
  );
}

/** The wordmark: ink image in light, white image in dark. */
export function emailWordmark(): string {
  const img = (src: string) =>
    `<img src="${src}" width="${EMAIL_WORDMARK.width}" height="${EMAIL_WORDMARK.height}" alt="${EMAIL_WORDMARK.alt}" style="display:block;border:0;outline:none;width:${EMAIL_WORDMARK.width}px;height:${EMAIL_WORDMARK.height}px;font-family:${EMAIL_SANS};font-size:18px;font-weight:700;color:${L.fg}">`;
  return (
    `<div class="wm-l">${img(EMAIL_WORDMARK.light)}</div>` +
    `<div class="wm-d" style="display:none;mso-hide:all;max-height:0;overflow:hidden">${img(EMAIL_WORDMARK.dark)}</div>`
  );
}

/** Header row: wordmark left, optional aside (already-escaped html) right. */
export function emailHeader(aside = ''): string {
  return (
    `<tr><td style="padding:0 4px 16px"><table ${EMAIL_TABLE}><tr>` +
    `<td style="vertical-align:middle">${emailWordmark()}</td>` +
    (aside === ''
      ? ''
      : `<td class="fg3" align="right" style="vertical-align:middle;font-family:${EMAIL_SANS};font-size:13px;line-height:24px;color:${L.fg3}">${aside}</td>`) +
    `</tr></table></td></tr>`
  );
}

/** A lit card holding `inner` (already-escaped html). */
export function emailCard(inner: string, padding = '28px 24px'): string {
  return (
    `<table ${EMAIL_TABLE} class="panel" style="background:${L.panel};${EMAIL_CARD_EDGES};border-radius:12px;border-collapse:separate">` +
    `<tr><td style="padding:${padding}">${inner}</td></tr></table>`
  );
}

/** Primary button: ink fill and white text in light, white fill and ink text in dark. */
export function emailButton(href: string, label: string): string {
  return (
    `<a href="${emailEscape(href)}" class="btn" style="display:inline-block;min-height:20px;padding:13px 24px 12px;line-height:20px;border-radius:8px;` +
    `background:${L.btnFill};color:${L.btnInk};border:1px solid ${L.btnFill};border-top-color:${L.btnTop};border-bottom:2px solid ${L.line};` +
    `font-family:${EMAIL_SANS};font-size:15px;font-weight:600;text-decoration:none">${emailEscape(label)}</a>`
  );
}

/** Secondary link: underlined, never a button. */
export function emailLink(href: string, label: string, cls: 'fg' | 'fg2' | 'fg3' = 'fg3'): string {
  return `<a href="${emailEscape(href)}" class="${cls}" style="color:${L[cls]};text-decoration:underline">${emailEscape(label)}</a>`;
}

/** The sign-in code: 3:1 fill and line in both schemes, mono 28px, .2em tracking. */
export function emailCodeBox(code: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="code" align="center" style="padding:14px 18px 14px 24px;background:${L.codeFill};border:1px solid ${L.line};border-radius:8px;` +
    `font-family:${EMAIL_MONO};font-size:28px;font-weight:600;line-height:32px;letter-spacing:.2em;font-variant-numeric:tabular-nums;color:${L.fg}">${code}</td>` +
    `</tr></table>`
  );
}

/** A 1px hairline inside a card. */
export function emailRule(): string {
  return `<div class="rule" style="height:1px;background:${L.rule};font-size:0;line-height:1px">&nbsp;</div>`;
}

/** Footer row under the card: small fg3 copy (already-escaped html). */
export function emailFooter(inner: string): string {
  return `<tr><td class="fg3" style="padding:24px 4px 0;font-family:${EMAIL_SANS};font-size:12px;line-height:18px;color:${L.fg3}">${inner}</td></tr>`;
}

/**
 * The whole email: head, page, 600px column, header with the wordmark, the
 * content rows (each a <tr>), the footer. Strings in `title` and `preheader`
 * are escaped here; `aside`, `content` and `footer` are html.
 */
export function emailDocument(opts: {
  title: string;
  preheader?: string;
  aside?: string;
  content: string;
  footer: string;
}): string {
  const preheader =
    opts.preheader === undefined
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${emailEscape(opts.preheader)}</div>`;
  return (
    emailHead(emailEscape(opts.title)) +
    `<body class="bg" style="margin:0;padding:0;background:${L.bg};-webkit-text-size-adjust:100%">` +
    preheader +
    `<table ${EMAIL_TABLE} class="bg" style="background:${L.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">` +
    emailHeader(opts.aside) +
    opts.content +
    emailFooter(opts.footer) +
    `</table></td></tr></table></body></html>`
  );
}
