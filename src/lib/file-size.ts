// The upload size ceiling and the one byte formatter, kept in a leaf module so
// pure copy (src/lib/error-copy.ts) can name the limit without pulling the
// upload client or the assets reads into its bundle. Re-exported from
// src/lib/asset-upload.ts and src/lib/assets.ts for their existing callers.

// Hard ceiling mirrored from the worker pipeline (MAX_FILE_SIZE_BYTES, 100 MB).
// The worker rejects strictly greater than this, so the client matches exactly:
// a file equal to the limit is allowed, one byte over is not.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Humanize a byte count, or an em-dash-free placeholder when unknown. */
export function humanizeSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
}
