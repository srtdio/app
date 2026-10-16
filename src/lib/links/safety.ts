// In-code link safety check, shared by the browser and the link-preview Worker.
//
// Pure string logic, no I/O and no network: a link is 'unsafe' when any rule
// below fires, and every rule carries one plain-English reason the warning
// sheet lists as-is. Free checks only (no Google Web Risk, no paid service).
//
// Registrable-domain logic uses a small built-in public-suffix subset
// (MULTI_LABEL_SUFFIXES) instead of the full Public Suffix List: the full list
// is ~200 KiB and would need a dependency or a fetch. Any host whose last two
// labels are not in the subset is treated as <label>.<tld>. Hosting platforms
// (github.io, pages.dev, ...) are deliberately NOT suffixes, so a brand name
// in a subdomain of one of them reads as "a famous name on a site that does
// not belong to it".

/** Every reason the check can give, in the order the sheet lists them. */
export const REASONS = {
  invalid: 'Not a valid web address',
  scheme: 'Not a web link',
  credentials: 'Hides a username or password in the link',
  ip: 'Uses a number address instead of a site name',
  local: 'Points to a private or local address',
  port: 'Uses an unusual port',
  http: 'Not a secure (https) link',
  punycode: 'Uses look-alike letters from another alphabet',
  lookalike: 'Looks like a famous site but is spelled differently',
  brand: 'Uses a famous name on a site that does not belong to it',
  download: 'Downloads a file that could harm your device',
} as const;

export type ReasonKey = keyof typeof REASONS;
export type Reason = (typeof REASONS)[ReasonKey];

export type LinkVerdict = { verdict: 'ok' | 'unsafe'; reasons: Reason[] };

/** Brands people get phished with, as their bare registrable label. */
export const BRANDS = [
  'google',
  'gmail',
  'microsoft',
  'outlook',
  'office',
  'apple',
  'icloud',
  'paypal',
  'whatsapp',
  'instagram',
  'facebook',
  'meta',
  'linkedin',
  'youtube',
  'canva',
  'dropbox',
  'amazon',
  'flipkart',
  'paytm',
  'phonepe',
  'hdfc',
  'icici',
  'sbi',
  'axis',
  'kotak',
] as const;

/**
 * Brands distinctive enough to flag when they appear anywhere inside a label
 * (g00gledocs-share). Short or common words (meta, office, apple, axis, sbi,
 * outlook, ...) only match as a whole hyphen-separated word, so metacritic.com
 * or applebees.com stay ok.
 */
const SUBSTRING_BRANDS: ReadonlySet<string> = new Set([
  'google',
  'gmail',
  'microsoft',
  'paypal',
  'whatsapp',
  'instagram',
  'facebook',
  'linkedin',
  'youtube',
  'dropbox',
  'flipkart',
  'phonepe',
  'paytm',
  'hdfc',
  'icici',
  'kotak',
]);

/**
 * Brand phrases phishing domains glue together. Matched against a host label
 * with its hyphens removed (apple-id -> appleid, hdfcbank-kyc -> hdfcbankkyc).
 */
const BRAND_COMPOUNDS = [
  'appleid',
  'icloudid',
  'office365',
  'microsoft365',
  'outlooklogin',
  'outlookverify',
  'outlookmail',
  'sbibank',
  'onlinesbi',
  'yonosbi',
  'sbionline',
  'axisbank',
] as const;

/**
 * Endings that are cheap or free and favoured for phishing. A brand's bare name
 * on one of these (paypal.top, sbi.help, paypal.tk) is not the brand. Brands do
 * use other new endings (amazon.jobs, google.dev), so this is a list, not a rule.
 */
const ABUSED_ENDINGS: ReadonlySet<string> = new Set([
  'top',
  'xyz',
  'help',
  'click',
  'link',
  'online',
  'live',
  'shop',
  'support',
  'info',
  'icu',
  'buzz',
  'rest',
  'monster',
  'cyou',
  'sbs',
  'cfd',
  'quest',
  'vip',
  'work',
  'loan',
  'win',
  'bid',
  'club',
  'site',
  'website',
  'space',
  'fun',
  'store',
  'tech',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'cc',
  'pw',
  'ws',
  'su',
]);

/**
 * Brands that are also everyday words. Only a swapped spelling of these
 * (app1e, rneta) is flagged; the plain word on another site
 * (best-office-chairs.in, apple-pie.blog) is normal and stays ok.
 */
const COMMON_WORD_BRANDS: ReadonlySet<string> = new Set([
  'office',
  'outlook',
  'apple',
  'meta',
  'axis',
]);

/**
 * Registrable domains the brands really own whose label is not the bare brand
 * name. These pass even though a brand appears inside them.
 */
const OFFICIAL_DOMAINS: ReadonlySet<string> = new Set([
  'googleapis.com',
  'googleusercontent.com',
  'googlevideo.com',
  'googletagmanager.com',
  'googleblog.com',
  'google-analytics.com',
  'youtube-nocookie.com',
  'youtu.be',
  'whatsapp.net',
  'whatsapp.com',
  'wa.me',
  'facebook.net',
  'fb.com',
  'fb.me',
  'fbcdn.net',
  'cdninstagram.com',
  'instagr.am',
  'lnkd.in',
  'licdn.com',
  'microsoftonline.com',
  'microsoft365.com',
  'office365.com',
  'paypalobjects.com',
  'paypal-community.com',
  'dropboxusercontent.com',
  'dropboxapi.com',
  'amazonaws.com',
  'flipkartcareers.com',
  'paytmbank.com',
  'paytmmoney.com',
  'hdfcbank.com',
  'hdfcsec.com',
  'icicibank.com',
  'icicidirect.com',
  'onlinesbi.sbi',
  'sbicard.com',
  'axisbank.com',
  'kotak.com',
  'kotaksecurities.com',
  'paytmmall.com',
  'googlemail.com',
  'googledrive.com',
  'youtubekids.com',
  'media-amazon.com',
  'ssl-images-amazon.com',
  'amazon-adsystem.com',
  'canva.site',
  'canva.link',
]);

/** Two-label public suffixes we know about. Everything else is a one-label TLD. */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // India's bank-only and finance-only zones (RBI): sbi.bank.in, hdfc.bank.in.
  'bank.in',
  'fin.in',
  'co.in',
  'org.in',
  'gov.in',
  'ac.in',
  'net.in',
  'edu.in',
  'res.in',
  'firm.in',
  'gen.in',
  'ind.in',
  'nic.in',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'co.nz',
  'org.nz',
  'com.sg',
  'com.my',
  'co.jp',
  'co.za',
  'com.br',
  'com.mx',
  'com.tr',
  'co.id',
  'com.ph',
  'com.pk',
  'com.bd',
  'com.np',
  'co.ae',
  'com.sa',
  'com.hk',
  'co.kr',
  'co.th',
  'com.tw',
  'co.il',
  'com.cn',
]);

/** Downloads that install or run code. Matched on the last path segment. */
const RISKY_EXTENSIONS = [
  'exe',
  'msi',
  'bat',
  'cmd',
  'scr',
  'apk',
  'ipa',
  'dmg',
  'pkg',
  'jar',
  'vbs',
  'ps1',
  'js',
  'hta',
  'lnk',
  'iso',
] as const;

/** Sites that show code files as pages; their .js / .ps1 paths are not downloads. */
const CODE_HOSTS: ReadonlySet<string> = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/** Link shorteners resolved server-side ("bit.ly → canva.com"). */
export const SHORTENERS: ReadonlySet<string> = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'rb.gy',
  'cutt.ly',
  'is.gd',
  'ow.ly',
  's.id',
  'shorturl.at',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.lan'] as const;

/** Lowercased hostname without a leading www. and without a trailing dot. */
export function hostLabel(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * The registrable domain (eTLD+1) of a hostname, from the built-in suffix
 * subset. An IP literal or a single-label host is returned unchanged.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (IPV4.test(host) || host.startsWith('[')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** True when the host is one of the known link shorteners. */
export function isShortener(hostname: string): boolean {
  return SHORTENERS.has(hostLabel(hostname));
}

/** Fold the common digit/letter swaps so g00gle, rnicrosoft and paypa1 meet their brand. */
export function foldLookalike(text: string): string {
  return text
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1i]/g, 'l')
    .replace(/5/g, 's');
}

const FOLDED_BRANDS: ReadonlyArray<{ brand: string; folded: string }> = BRANDS.map((brand) => ({
  brand,
  folded: foldLookalike(brand),
}));

/** The label of a registrable domain without its public suffix (google for docs.google.co.in). */
function siteLabel(registrable: string): string {
  return registrable.split('.')[0] ?? '';
}

/** 'lookalike', 'brand' or null for the brand rules on one host. */
function brandVerdict(host: string): 'lookalike' | 'brand' | null {
  const registrable = registrableDomain(host);
  if (OFFICIAL_DOMAINS.has(registrable)) return null;
  const label = siteLabel(registrable);
  if ((BRANDS as readonly string[]).includes(label)) return null;

  // Every word of every label left of the public suffix: the site label and any
  // subdomains (paypal.com.secure-login.top puts the brand in a subdomain).
  const suffixLabels = registrable.split('.').length - 1;
  const hostLabels = host.split('.');
  const words = hostLabels
    .slice(0, hostLabels.length - suffixLabels)
    .flatMap((part) => part.split('-'))
    .filter((word) => word !== '' && word !== 'www');

  let found: 'lookalike' | 'brand' | null = null;
  for (const word of words) {
    const folded = foldLookalike(word);
    const digitsFolded = foldDigits(word);
    for (const { brand, folded: foldedBrand } of FOLDED_BRANDS) {
      if (folded === foldedBrand) {
        // A swapped spelling (g00gle) is a lookalike; the real spelling on
        // someone else's domain is a borrowed brand.
        if (word !== brand) return 'lookalike';
        if (!COMMON_WORD_BRANDS.has(brand)) found = 'brand';
        continue;
      }
      if (!SUBSTRING_BRANDS.has(brand)) continue;
      if (word.includes(brand)) {
        found = 'brand';
      } else if (digitsFolded.includes(brand)) {
        // Inside a longer word only a digit swap counts (g00gledocs): letter
        // folds alone misread ordinary words (shoppingmall -> "gmail").
        return 'lookalike';
      }
    }
  }
  const joined = hostLabels
    .slice(0, hostLabels.length - suffixLabels)
    .join('')
    .replace(/-/g, '');
  if (found === null && BRAND_COMPOUNDS.some((phrase) => joined.includes(phrase))) found = 'brand';
  return found;
}

/** Only the digit swaps (0/o, 1/l, 5/s), for matching inside longer words. */
function foldDigits(text: string): string {
  return text.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's');
}

/** A brand's bare name on a phishing-favoured ending (paypal.top, sbi.help, paypal.tk). */
function brandOnOddEnding(host: string): boolean {
  const registrable = registrableDomain(host);
  if (OFFICIAL_DOMAINS.has(registrable)) return false;
  const label = siteLabel(registrable);
  if (!(BRANDS as readonly string[]).includes(label)) return false;
  return ABUSED_ENDINGS.has(registrable.slice(label.length + 1));
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A single-label host (http://intranet/) only resolves on a private network.
  return !host.includes('.');
}

function hasRiskyDownload(pathname: string): boolean {
  const last = (pathname.split('/').pop() ?? '').toLowerCase();
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  return RISKY_EXTENSIONS.some((ext) => decoded.endsWith(`.${ext}`));
}

/**
 * Check one link. Never throws, never fetches. 'ok' means no rule fired; it is
 * not a promise the site is safe, only that nothing in the address looks wrong.
 */
export function checkLink(raw: string): LinkVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { verdict: 'unsafe', reasons: [REASONS.invalid] };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { verdict: 'unsafe', reasons: [REASONS.scheme] };
  }

  const keys = new Set<ReasonKey>();
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (url.username !== '' || url.password !== '') keys.add('credentials');
  if (IPV4.test(host) || host.startsWith('[') || host.includes(':')) {
    keys.add('ip');
  } else if (isLocalHost(host)) {
    keys.add('local');
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') keys.add('port');
  if (url.protocol === 'http:') keys.add('http');
  // WHATWG URL parsing turns any non-ASCII host into xn-- punycode, so this one
  // rule also covers mixed-script hosts; the ASCII test guards a raw host.
  if (host.split('.').some((label) => label.startsWith('xn--')) || /[^ -~]/.test(host)) {
    keys.add('punycode');
  }
  if (!keys.has('ip') && !keys.has('local')) {
    const brand = brandVerdict(host);
    if (brand !== null) keys.add(brand);
    else if (brandOnOddEnding(host)) keys.add('brand');
  }
  // Code hosts show source files (index.js) as web pages, not downloads.
  if (!CODE_HOSTS.has(registrableDomain(host)) && hasRiskyDownload(url.pathname)) {
    keys.add('download');
  }

  const reasons = (Object.keys(REASONS) as ReasonKey[])
    .filter((key) => keys.has(key))
    .map((key) => REASONS[key]);
  return { verdict: reasons.length > 0 ? 'unsafe' : 'ok', reasons };
}

// ---------------------------------------------------------------------------
// Link identity and labels, shared by the preview Worker and the cards so the
// cache key and the compact card read the same on both sides.

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|igsh|igshid)$/i;

/**
 * The cache identity of a link: lowercased host (URL parsing does that), no
 * fragment, default port dropped, utm_* / fbclid / gclid / igsh removed. Null
 * when it does not parse as http(s).
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const keys = [...url.searchParams.keys()];
  // Only rewrite the query when there is something to strip: rewriting
  // re-encodes it (%20 becomes +), which some sites read differently.
  if (keys.some((key) => TRACKING_PARAMS.test(key))) {
    for (const key of keys) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    // Keep a bare "?" out when every param was tracking.
    if ([...url.searchParams.keys()].length === 0) url.search = '';
  }
  return url.toString();
}

/** What every card shows for a link, fetched or not. */
export interface LinkBase {
  /** Host of the shared link, lowercased, www. dropped. */
  domain: string;
  /** Path + query of the shared link ('' for the bare site root). */
  path: string;
  /** Letter for the site tile. Favicons are never fetched. */
  letter: string;
  /** Where a shortener landed (canva.com); null unless a shortener redirected. */
  finalDomain: string | null;
  /** The shortener host (bit.ly); null unless a shortener redirected. */
  viaShortener: string | null;
}

/** Domain, path (scheme and host dropped, like displayUrl) and tile letter. */
export function linkBase(url: URL): LinkBase {
  const domain = hostLabel(url.hostname);
  const letter = (domain.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  const path = `${url.pathname}${url.search}`;
  return { domain, path: path === '/' ? '' : path, letter, finalDomain: null, viaShortener: null };
}
