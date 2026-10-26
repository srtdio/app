// MIME allowlist. Deliberately strict to start; widen only with a PR that also
// covers the new type in the sanitize/strip pipeline and in file-safety.ts.

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  // Recorded voice-note audio. mp4 (AAC in ISO-BMFF), webm (Opus/Vorbis in
  // Matroska), and mpeg (MP3) are the formats browsers emit from MediaRecorder.
  'audio/mp4',
  'audio/webm',
  'audio/mpeg',
  'application/pdf',
  // Office Open XML only. Macro-enabled types (docm, xlsm, pptm and their
  // application/vnd.ms-*.macroEnabled.12 MIME strings) are excluded, and the
  // archive is opened and checked for macros in file-safety.ts. Legacy OLE
  // Office (doc, xls, ppt) and SVG are blocked: neither can be inspected safely.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

/**
 * Types that are refused outright with the "not allowed" copy rather than the
 * generic unsupported one: SVG (script-capable markup) and legacy OLE Office.
 */
export const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/svg+xml',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

/**
 * The filename extensions each allowed type may carry. A name whose final
 * extension is a known one outside this list is a mismatch (see file-safety.ts).
 */
export const EXTENSIONS_BY_MIME: Readonly<Record<AllowedMimeType, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov', 'qt'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/webm': ['webm', 'weba'],
  'audio/mpeg': ['mp3', 'mpga'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
};

/** Normalize a raw Content-Type ("image/jpeg; charset=binary") to its essence. */
export function normalizeMime(contentType: string): string {
  const semi = contentType.indexOf(';');
  const base = semi === -1 ? contentType : contentType.slice(0, semi);
  return base.trim().toLowerCase();
}

export function isAllowedMime(contentType: string): contentType is AllowedMimeType {
  return ALLOWED.has(normalizeMime(contentType));
}

export function isBlockedMime(contentType: string): boolean {
  return BLOCKED_MIME_TYPES.has(normalizeMime(contentType));
}

export function isImageMime(contentType: string): boolean {
  return normalizeMime(contentType).startsWith('image/');
}

/** JPEG is the only type whose EXIF we strip in this PR (see exif.ts). */
export function isJpegMime(contentType: string): boolean {
  const m = normalizeMime(contentType);
  return m === 'image/jpeg';
}
