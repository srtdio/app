// Idempotency key for a single fan-out write. The worker stores this key in the
// inbox_writer_dedupe KV namespace (7-day TTL) before writing; a key that is
// already present means this exact (source row, event_type, recipient) entry
// has been produced, so a replay must not create a second inbox_entry.
//
// hash(source_table || source_id || event_type || recipient_user_id) per spec.
// SHA-256 via Web Crypto, which is available both in Cloudflare Workers and in
// Node 22 (globalThis.crypto.subtle).

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
}

export async function dedupeKey(
  sourceTable: string,
  sourceId: string,
  eventType: string,
  recipientUserId: string,
): Promise<string> {
  const input = [sourceTable, sourceId, eventType, recipientUserId].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}
