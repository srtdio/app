// MIME allowlist. Deliberately strict to start; widen only with a PR that also
// covers the new type in the sanitize/strip pipeline.

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  // Office documents. Macro-enabled types (docm, xlsm, pptm and their
  // application/vnd.ms-*.macroEnabled.12 MIME strings) are deliberately
  // excluded: their VBA payloads are an unacceptable execution vector.
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

/** Normalize a raw Content-Type ("image/jpeg; charset=binary") to its essence. */
export function normalizeMime(contentType: string): string {
  const semi = contentType.indexOf(';');
  const base = semi === -1 ? contentType : contentType.slice(0, semi);
  return base.trim().toLowerCase();
}

export function isAllowedMime(contentType: string): contentType is AllowedMimeType {
  return ALLOWED.has(normalizeMime(contentType));
}

export function isImageMime(contentType: string): boolean {
  return normalizeMime(contentType).startsWith('image/');
}

export function isSvgMime(contentType: string): boolean {
  return normalizeMime(contentType) === 'image/svg+xml';
}

/** JPEG is the only type whose EXIF we strip in this PR (see exif.ts). */
export function isJpegMime(contentType: string): boolean {
  const m = normalizeMime(contentType);
  return m === 'image/jpeg';
}
