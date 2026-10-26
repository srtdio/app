// The Word viewer's last gate before the sandboxed iframe (main thread, loaded
// only with the Word viewer). The Worker already writes a fixed, escaped HTML
// vocabulary; DOMPurify then keeps only that vocabulary again, so anything the
// reader ever let through is still dropped: script, iframe, object, embed,
// form, link, base, meta (refresh), style, svg and math (so foreignObject),
// every on* handler, style attributes (no CSS url()), and every URL that is
// not a data: PNG/JPEG/GIF/WebP picture (javascript:, vbscript:, data:text,
// http/https, blob). Links are not in the vocabulary: an <a> keeps its text
// and loses the element, so it is plain text.
//
// The srcdoc carries its own CSP (no network at all, inline styles only) and
// the iframe is sandboxed with sandbox="" (no scripts, no same origin, no
// popups, forms or top navigation).

import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'strong',
  'em',
  'u',
  's',
  'sub',
  'sup',
  'br',
  'table',
  'tbody',
  'tr',
  'td',
  'img',
];

const ALLOWED_ATTR = ['class', 'colspan', 'rowspan', 'src', 'alt', 'width', 'height'];

/** The only URLs that survive: inline raster pictures. */
const SAFE_IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'link',
  'base',
  'meta',
  'style',
  'svg',
  'math',
  'foreignObject',
  'a',
  'area',
  'audio',
  'video',
  'source',
  'template',
  'noscript',
];

const FORBID_ATTR = [
  'style',
  'href',
  'xlink:href',
  'srcset',
  'action',
  'formaction',
  'background',
  'poster',
  'ping',
];

const CLASS_TOKEN = /^(?:al-[crj]|title|li|lv[0-8]|tab|page)$/;

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

/** A DOMPurify instance of our own, so its hooks never touch any other caller. */
function getPurifier(): Purifier {
  if (purifier !== null) return purifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName.toLowerCase();
    if (name.startsWith('on')) {
      data.keepAttr = false;
      return;
    }
    if (name === 'src' && !SAFE_IMAGE_URL.test(data.attrValue.trim())) {
      data.keepAttr = false;
      return;
    }
    if (name === 'class') {
      data.attrValue = data.attrValue
        .split(/\s+/)
        .filter((token) => CLASS_TOKEN.test(token))
        .join(' ');
      return;
    }
    if (
      (name === 'colspan' || name === 'rowspan' || name === 'width' || name === 'height') &&
      !/^[0-9]{1,5}$/.test(data.attrValue)
    ) {
      data.keepAttr = false;
    }
  });
  // An <img> left without a safe source is removed outright.
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'IMG' && !node.hasAttribute('src')) node.remove();
  });
  purifier = p;
  return p;
}

/** Sanitize the Worker's HTML for the iframe. Needs a DOM (main thread). */
export function sanitizeDocHtml(html: string): string {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: SAFE_IMAGE_URL,
    // Plain numbers (checked in the hook), not URLs: exempt from the URL pattern.
    ADD_URI_SAFE_ATTR: ['width', 'height', 'colspan', 'rowspan'],
    KEEP_CONTENT: true,
    WHOLE_DOCUMENT: false,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** The srcdoc's CSP: nothing may load from anywhere; pictures only from data:/blob:. */
export const DOC_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/** The iframe's sandbox: empty, so every capability is off. */
export const DOC_SANDBOX = '';

/** A CSS colour from a token value, or the fallback when it is anything else. Pure. */
export function safeColor(value: string, fallback: string): string {
  const v = value.trim();
  return /^(?:#[0-9a-f]{3,8}|rgba?\([0-9., %]+\))$/i.test(v) ? v : fallback;
}

interface SrcdocOptions {
  /** Sanitized HTML, one string per page. */
  pages: string[];
  /** Page surface colour (the PDF viewer's paper token). */
  paper: string;
  /** Margins as fractions of the page width: top, right, bottom, left. */
  margins: [number, number, number, number];
}

function pct(n: number): string {
  return `${Math.round(Math.min(Math.max(n, 0), 0.3) * 1000) / 10}%`;
}

/**
 * The whole iframe document: CSP meta first, then a fixed stylesheet, then the
 * pages. The text colours are fixed for white paper, in light and dark alike.
 */
export function buildSrcdoc(options: SrcdocOptions): string {
  const paper = safeColor(options.paper, '#ffffff');
  const [top, right, bottom, left] = options.margins;
  const css = [
    ':root{color-scheme:light}',
    // No pinch on the frame: it would zoom the whole app page, which the app keeps locked.
    'html{touch-action:pan-x pan-y}',
    'html,body{margin:0;background:transparent}',
    'body{padding:8px 8px 24px;-webkit-text-size-adjust:100%}',
    `.page{background:${paper};color:#1d1d24;margin:0 auto 8px;max-width:816px;border-radius:2px;`,
    `padding:${pct(top)} ${pct(right)} ${pct(bottom)} ${pct(left)};box-sizing:border-box;`,
    'font:15px/1.55 Georgia,"Times New Roman",serif;overflow-wrap:anywhere}',
    '.page:after{content:"";display:block;clear:both}',
    'h1,h2,h3,h4,h5,h6{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#2b3a67;line-height:1.3;margin:0.9em 0 0.35em}',
    'h1{font-size:1.45em}h2{font-size:1.25em}h3{font-size:1.1em}h4,h5,h6{font-size:1em}',
    'h1.title{font-size:1.7em;margin-top:0}',
    'p{margin:0 0 0.6em;min-height:1em}',
    '.al-c{text-align:center}.al-r{text-align:right}.al-j{text-align:justify}',
    '.li{padding-left:1.4em;text-indent:-1em}',
    ...Array.from({ length: 9 }, (_, i) => `.lv${i}{margin-left:${i * 1.2}em}`),
    '.tab{display:inline-block;width:2em}',
    'table{border-collapse:collapse;width:100%;margin:0.5em 0;font:0.85em/1.4 -apple-system,"Helvetica Neue",Arial,sans-serif}',
    'td{border:1px solid #c8c8d0;padding:3px 5px;vertical-align:top}',
    'td p{margin:0}',
    'img{max-width:100%;height:auto}',
  ].join('');
  const body = options.pages.map((p) => `<div class="page">${p}</div>`).join('');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${DOC_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${css}</style></head><body>${body}</body></html>`
  );
}
