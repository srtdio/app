// SHA-256 over the *sanitized* bytes (after EXIF strip / SVG sanitize). This is
// the content identity used for dedup, so it must be computed on exactly the
// bytes that get stored. Uses Web Crypto, available in Workers and Node 22.

export async function computeSha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
