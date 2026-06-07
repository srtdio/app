// Mention parsing for comment bodies. A mention is the literal token
// `@[<user_id>]`, where <user_id> is a canonical lowercase UUID. The body is the
// single source of truth for who was mentioned; createComment re-derives the set
// server-side and validates every id against active workspace membership before
// the comment is written. Parsing is pure and framework-free so it can be unit
// tested in isolation.

const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * Extract the distinct user ids mentioned in `body`. Ids are normalised to
 * lowercase and de-duplicated; order follows first appearance. A body with no
 * well-formed tokens yields an empty array.
 */
export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const raw = match[1];
    if (!raw) continue;
    const id = raw.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}
