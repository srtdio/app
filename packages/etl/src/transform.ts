// Pure v1 -> v2 field mapping. No I/O, no database, no env: every function here
// is a total mapping from a v1 value to a v2-shaped value, which is why the whole
// transform layer is unit-tested without a connection. The loader (load.ts) calls
// these; the source layer (source.ts) only reads. Text is truncated to the v2
// CHECK limits here so an over-length v1 row can never abort a load mid-way.

export type PostStage = 'draft' | 'review' | 'approved' | 'parked' | 'rejected';
export type PostFormat = 'text' | 'single_image' | 'carousel' | 'video' | 'link';
export type BriefFormat = 'text' | 'single_image' | 'carousel' | 'video' | 'link';
export type BriefStatus = 'open' | 'closed';
export type PostOrigin = 'manual' | 'brief';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// v2 CHECK limits (schema.md). Strings are truncated to these before insert.
export const TITLE_MAX = 200;
export const OBJECTIVE_MAX = 5000;
export const COMMENT_BODY_MAX = 10000;
export const DISPLAY_NAME_MAX = 80;
export const WORKSPACE_NAME_MAX = 80;

// In dev-seed mode the preserved v1 person name is replaced with this constant.
export const NAME_REDACTION = 'Member';

// Legacy author-name attribution. Mirrors the edited_by redaction in
// buildSnapshot exactly: dev-seed replaces a real preserved name with 'Member' so
// no PII enters dev-seed; cutover passes the real name through; a null name (an
// unresolvable author) stays null and renders as "(ex-member)" in the UI.
export function redactAuthorName(name: string | null, scrub: boolean): string | null {
  return scrub ? (name === null ? null : NAME_REDACTION) : name;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

// Truncate by code unit to a hard CHECK limit. Values at the limit are kept.
export function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// --- PII scrub (dev-seed only) -------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A phone-like run: an optional +, a leading digit, then >= 6 digits/separators,
// then a trailing digit. Over-redaction is acceptable for disposable dev data.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

// Redact email-like and phone-like substrings. Emails first so the phone pass
// never re-touches the digit-free replacement token.
export function redactPii(text: string): string {
  return text.replace(EMAIL_RE, '[redacted-email]').replace(PHONE_RE, '[redacted-phone]');
}

function scrubMaybe(text: string, scrub: boolean): string {
  return scrub ? redactPii(text) : text;
}

// --- Brief mappings ------------------------------------------------------------

// content_type: CREATIVE/PHOTO -> single_image, VIDEO -> video, TEXT -> text,
// null or anything else -> null.
export function mapBriefFormatRequested(contentType: string | null): BriefFormat | null {
  switch ((contentType ?? '').trim().toUpperCase()) {
    case 'CREATIVE':
    case 'PHOTO':
      return 'single_image';
    case 'VIDEO':
      return 'video';
    case 'TEXT':
      return 'text';
    default:
      return null;
  }
}

// status: closed -> closed, pending/assigned (or anything else) -> open.
export function mapBriefStatus(status: string | null): BriefStatus {
  return (status ?? '').trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}

// The two close-tracking columns, kept self-consistent with the v2
// briefs_closed_consistency CHECK: a closed brief has BOTH closed_at and
// closed_by non-null; an open brief has BOTH null. Returning them together makes
// it impossible to set one without the other.
export interface BriefCloseFields {
  closed_at: Date | string | null;
  closed_by: string | null;
}

// Derive closed_at/closed_by for a brief row. v1 records no close timestamp, so
// for a migrated closed brief closed_at is a best-effort fallback: the request's
// target_date when present, else a stable non-null timestamp the loader already
// has for the row (fallbackClosedAt, e.g. load time). closed_by is the operator,
// matching how legacy created_by attribution is handled (the only valid migrated
// user at seed/cutover time). Open briefs get both columns explicitly null.
export function briefCloseFields(
  status: BriefStatus,
  targetDate: Date | string | null,
  operatorUserId: string,
  fallbackClosedAt: Date | string,
): BriefCloseFields {
  if (status !== 'closed') return { closed_at: null, closed_by: null };
  return { closed_at: targetDate ?? fallbackClosedAt, closed_by: operatorUserId };
}

// objective is NOT NULL (1..5000): use description, falling back to title when
// description is blank, and a safe placeholder when both are blank.
export function briefObjective(
  description: string | null,
  title: string | null,
  scrub: boolean,
): string {
  const base = !isBlank(description)
    ? (description as string)
    : !isBlank(title)
      ? (title as string)
      : 'Untitled brief';
  return truncate(scrubMaybe(base, scrub), OBJECTIVE_MAX);
}

// title is NOT NULL (1..200): blank v1 titles get a safe placeholder.
export function briefTitle(title: string | null): string {
  return truncate(isBlank(title) ? 'Untitled brief' : (title as string).trim(), TITLE_MAX);
}

// reference_links jsonb preserves the v1 drive_link and the images array.
export function buildReferenceLinks(
  driveLink: string | null,
  images: readonly string[] | null,
): Json {
  return { drive_link: driveLink ?? null, images: images ? [...images] : [] };
}

// --- Post mappings -------------------------------------------------------------

// format: Photo/Creative -> single_image, Carousel -> carousel, Text -> text,
// Video -> video, null or anything else -> text.
export function mapPostFormat(format: string | null): PostFormat {
  switch ((format ?? '').trim().toLowerCase()) {
    case 'photo':
    case 'creative':
      return 'single_image';
    case 'carousel':
      return 'carousel';
    case 'video':
      return 'video';
    case 'text':
      return 'text';
    default:
      return 'text';
  }
}

// stage: is_draft true wins -> draft. Otherwise published/scheduled ->
// approved, ready -> draft, awaiting_approval/awaiting_brand_input -> review,
// rejected -> rejected, parked -> parked, anything else -> draft.
export function mapPostStage(stage: string | null, isDraft: boolean): PostStage {
  if (isDraft) return 'draft';
  switch ((stage ?? '').trim().toLowerCase()) {
    case 'published':
    case 'scheduled':
      return 'approved';
    case 'ready':
      return 'draft';
    case 'awaiting_approval':
    case 'awaiting_brand_input':
      return 'review';
    case 'rejected':
      return 'rejected';
    case 'parked':
      return 'parked';
    default:
      return 'draft';
  }
}

// title is NOT NULL (1..200): blank v1 titles get a safe placeholder.
export function postTitle(title: string | null): string {
  return truncate(isBlank(title) ? 'Untitled post' : (title as string).trim(), TITLE_MAX);
}

// caption is nullable and uncapped in v2; only scrubbed in dev-seed.
export function postCaption(caption: string | null, scrub: boolean): string | null {
  if (caption === null || caption === undefined) return null;
  return scrubMaybe(caption, scrub);
}

// origin is 'brief' with the mapped v2 brief id when the v1 post linked to a
// migrated request, else 'manual' with no brief.
export function postOrigin(mappedBriefId: string | null): {
  origin: PostOrigin;
  briefId: string | null;
} {
  return mappedBriefId !== null
    ? { origin: 'brief', briefId: mappedBriefId }
    : { origin: 'manual', briefId: null };
}

// --- Snapshot builder ----------------------------------------------------------

// The fields v2 has no column for, preserved per post_version for provenance.
export interface SnapshotInput {
  content: string | null;
  caption: string | null;
  images: readonly string[] | null;
  canvaLink: string | null;
  driveLink: string | null;
  linkedinLink: string | null;
  contentPillar: string | null;
  location: string | null;
  editedBy: string | null;
}

// Build the post_versions.snapshot jsonb. In dev-seed the free text (content,
// caption) is PII-scrubbed and the edited_by person name is replaced with
// 'Member'; a null name stays null (nothing to redact). Image URLs and links are
// preserved verbatim (R2 copy is a later, cutover-only PR).
export function buildSnapshot(input: SnapshotInput, scrub: boolean): Json {
  return {
    content: input.content === null ? null : scrubMaybe(input.content, scrub),
    caption: input.caption === null ? null : scrubMaybe(input.caption, scrub),
    images: input.images ? [...input.images] : [],
    canva_link: input.canvaLink ?? null,
    drive_link: input.driveLink ?? null,
    linkedin_link: input.linkedinLink ?? null,
    content_pillar: input.contentPillar ?? null,
    location: input.location ?? null,
    edited_by: scrub ? (input.editedBy === null ? null : NAME_REDACTION) : (input.editedBy ?? null),
  };
}

// --- Comment mapping -----------------------------------------------------------

// body is 1..10000. Callers skip blank-message comments entirely; this only
// scrubs and truncates a non-blank body.
export function commentBody(message: string, scrub: boolean): string {
  return truncate(scrubMaybe(message, scrub), COMMENT_BODY_MAX);
}

// True when a v1 comment must be skipped (blank message).
export function isBlankComment(message: string | null | undefined): boolean {
  return isBlank(message);
}

// --- Asset media helpers -------------------------------------------------------
//
// Pure, I/O-free helpers for the asset migration step (assets.ts): URL shape
// checks, the comment-attachment shape parser, MIME sniffing, and the mime->kind
// map. Kept here with the rest of the transform layer so they are unit-tested
// without a database, a network, or the R2 client.

// asset_versions.kind enum (schema.md section 5). Files map to image/video/pdf;
// external links use 'link'.
export type AssetKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'link';

// True for a clean http(s) URL. Free-text / garbage rows are rejected so a link
// asset never carries a non-URL external_url (the schema CHECK requires
// ^https?://) and a file fetch is never attempted against junk.
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

// Strip scheme + host, keep the path. v1 stores the same logical object under two
// hosts (images.srtd.io and pub-<hash>.r2.dev) that point at one bucket, so the
// path is the pre-fetch dedup key; sha256 remains the authoritative post-fetch
// identity. Unparseable input falls back to itself so it still keys consistently.
export function normalizeMediaPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Last path segment of a URL, used as the asset filename. Defaults to 'file' for
// a hostless / trailing-slash / unparseable URL so filename is never empty.
export function filenameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname
      .split('/')
      .filter((s) => s.length > 0)
      .pop();
    return segment !== undefined && segment.length > 0 ? decodeURIComponent(segment) : 'file';
  } catch {
    return 'file';
  }
}

// A human label for a link asset's filename: the host, or 'drive-link' when the
// host is unreadable.
export function linkLabel(url: string): string {
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : 'drive-link';
  } catch {
    return 'drive-link';
  }
}

function collectHttpUrls(values: readonly unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && isHttpUrl(v));
}

// Parse a v1 media value into a list of http(s) URLs. Handles every shape v1
// produced for both posts/requests.images (a bare URL array) and
// post_comments.attachments (4 shapes):
//   (A) a JSON array of url strings,
//   (B) a JSON object { type, urls: null | string[] },
//   (C) a double-encoded string whose inner parse is (A),
//   (D) a double-encoded string whose inner parse is (B).
// A string value is JSON-parsed once before interpreting; arrays use their
// entries, objects use .urls (may be null -> empty). Non-URL/empty entries are
// dropped. Returns an empty array for anything it cannot interpret.
export function parseMediaUrls(value: unknown): string[] {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) return collectHttpUrls(v);
  if (v !== null && typeof v === 'object') {
    const urls = (v as { urls?: unknown }).urls;
    return Array.isArray(urls) ? collectHttpUrls(urls) : [];
  }
  return [];
}

export function extensionMime(filename: string): string {
  const dot = filename.lastIndexOf('.');
  switch (dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

// Detect the content type from magic bytes (jpeg/png/gif/webp/pdf/mp4/quicktime),
// falling back to the filename extension. Returns 'application/octet-stream' when
// nothing matches, so the caller's isAllowedMime gate rejects an unknown type.
export function sniffMime(bytes: Uint8Array, filename: string): string {
  const b = (i: number): number => bytes[i] ?? -1;
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 6 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) {
    return 'application/pdf';
  }
  if (bytes.length >= 12 && b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
    // ISO base-media 'ftyp' box: the major brand at bytes 8..11 separates
    // QuickTime ('qt  ') from the mp4 family (isom/mp42/...).
    const brand = String.fromCharCode(b(8), b(9), b(10), b(11));
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  return extensionMime(filename);
}

const MIME_KIND: Readonly<Record<string, AssetKind>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/svg+xml': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'application/pdf': 'pdf',
};

// Map an allowlisted MIME type to its asset kind. The caller gates on
// isAllowedMime first, so every reachable input is mapped; an unmapped type is a
// contract violation and throws rather than inventing a kind.
export function mimeToKind(mime: string): AssetKind {
  const kind = MIME_KIND[mime];
  if (kind === undefined) {
    throw new Error(`No asset kind mapping for MIME type '${mime}'.`);
  }
  return kind;
}
