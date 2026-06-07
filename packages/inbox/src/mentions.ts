// Mention extraction. The composer persists @-mentions into comments.mentions
// as jsonb; the exact encoding has varied across clients, so this reader is
// deliberately liberal and normalises every supported shape down to a deduped
// list of user-id strings. It does NOT validate that the ids are real members;
// that is a separate workspace lookup (see computeRecipients).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Pull a user id out of a single mention element, whatever its shape. */
function idFromElement(el: unknown): string | null {
  if (isUuid(el)) return el;
  if (el && typeof el === 'object') {
    const obj = el as Record<string, unknown>;
    // Prefer an explicit user_id, then a bare id.
    if (isUuid(obj.user_id)) return obj.user_id;
    if (isUuid(obj.id)) return obj.id;
  }
  return null;
}

/**
 * Normalise a raw comments.mentions value into a deduped array of mentioned
 * user ids. Accepts: null/undefined, a UUID[], an array of `{ user_id }` /
 * `{ id }` objects, or an object with a `user_ids: string[]` field. Anything
 * unrecognised yields no ids rather than throwing - a malformed mentions blob
 * must never crash the fan-out.
 */
export function extractMentions(raw: unknown): string[] {
  let elements: unknown[];
  if (Array.isArray(raw)) {
    elements = raw;
  } else if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { user_ids?: unknown }).user_ids)
  ) {
    elements = (raw as { user_ids: unknown[] }).user_ids;
  } else {
    return [];
  }

  const seen = new Set<string>();
  for (const el of elements) {
    const id = idFromElement(el);
    if (id) seen.add(id);
  }
  return [...seen];
}
