// SVG sanitization. SVG is XML that browsers execute, so an uploaded .svg is an
// XSS vector unless we neutralize active content before storing it. We strip:
//   - <script> elements (paired and self-closing),
//   - on* event-handler attributes,
//   - javascript: URIs in href/xlink:href/src,
//   - external href references (http(s):// and protocol-relative //host).
// This is a conservative string pass, not a full XML parse; it errs toward
// removing too much rather than letting active content through.

const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi;
const SCRIPT_SELF_CLOSING = /<script\b[^>]*\/>/gi;
const EVENT_HANDLER_DQ = /\son[a-z0-9_-]+\s*=\s*"[^"]*"/gi;
const EVENT_HANDLER_SQ = /\son[a-z0-9_-]+\s*=\s*'[^']*'/gi;
const EVENT_HANDLER_BARE = /\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi;
const JS_URI = /(?:xlink:href|href|src)\s*=\s*(['"])\s*javascript:[^'"]*\1/gi;
const EXTERNAL_HREF = /\s(?:xlink:)?href\s*=\s*(['"])\s*(?:https?:)?\/\/[^'"]*\1/gi;

export function sanitizeSvg(svg: string): string {
  return svg
    .replace(SCRIPT_BLOCK, '')
    .replace(SCRIPT_SELF_CLOSING, '')
    .replace(JS_URI, '')
    .replace(EXTERNAL_HREF, '')
    .replace(EVENT_HANDLER_DQ, '')
    .replace(EVENT_HANDLER_SQ, '')
    .replace(EVENT_HANDLER_BARE, '');
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Decode SVG bytes, sanitize the markup, and re-encode to UTF-8 bytes. */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  return encoder.encode(sanitizeSvg(decoder.decode(bytes)));
}
