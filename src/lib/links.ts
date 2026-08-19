// The single authoritative parser for external URLs the app renders.
//
// briefs.reference_links is jsonb with no schema and no server-side validation,
// so the same column holds four different shapes in the wild (a bare string, a
// string[], an array of { url } objects, and the v1 ETL object carrying
// drive_link). Two separate defensive parsers used to live in the UI (one in
// BriefDetailPage, one in BriefCard) and they disagreed about which shapes were
// usable. Both are deleted in favour of this module: one normaliser, one scheme
// gate, one domain derivation, shared by every surface that renders a link.
//
// Only http: and https: are ever accepted, so javascript:, data:, file: and
// friends can never reach an href.

/** A URL that passed the scheme gate, with the label used to display it. */
export type ExternalLink = {
  /** The parsed, normalised absolute URL. Safe to put in an href. */
  href: string;
  /** hostname with a leading `www.` stripped, lowercased. The only label shown. */
  domain: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one candidate into an ExternalLink, or null when it is unusable.
 * Rejects a non-string, a blank string, anything URL parsing throws on, and any
 * scheme other than http: / https:. Never throws.
 */
export function parseExternalLink(raw: unknown): ExternalLink | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  return {
    href: url.toString(),
    domain: url.hostname.toLowerCase().replace(/^www\./, ''),
  };
}

/** Flatten one legacy jsonb value into the raw candidates it may carry. */
function candidatesOf(value: unknown): unknown[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) ? item.url : item));
  }
  // The v1 ETL shape: { drive_link, images }. Only drive_link is a link; images
  // are storage keys, never URLs, so every other key is ignored by design.
  if (isRecord(value)) return [value.drive_link];
  return [];
}

/**
 * Normalise any legacy reference_links value (or a plain array of URL strings)
 * into usable links: unparseable and non-http(s) entries are dropped, and
 * duplicates are collapsed by href with the first occurrence winning so the
 * caller's order is preserved. Always returns an array, never null.
 */
export function toExternalLinks(value: unknown): ExternalLink[] {
  const out: ExternalLink[] = [];
  const seen = new Set<string>();
  for (const candidate of candidatesOf(value)) {
    const link = parseExternalLink(candidate);
    if (link === null || seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  return out;
}
