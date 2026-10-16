// Chat @mentions: the composer's mention map, the wire format and the render
// helpers. A mention travels in the body as the literal `@[<uuid>]` token, the
// same format comments use (@srtdio/comments parseMentions reads it back), and
// chat_message_send / chat_message_edit take the uuids as p_mentions.
//
// The composer shows "@Name" in the textarea and keeps a pick list (id + name).
// On send the text is serialized: every picked "@Name" still intact in the text
// becomes its token; a damaged one stays plain text and its mention drops. The
// body is then the single source of truth: p_mentions is parseMentions(body), so
// a persisted outbox entry (which keeps the body) resends its mentions.
//
// Rendering never shows a raw token: every token resolves to "@Name", or
// "@Unknown member" when the id is not a known profile. Names come from the
// batched profile reads that already hydrate the thread and the chat list; this
// module also keeps a small in-memory name registry (like the drafts map) so a
// draft's tokens resolve in the chat list's "Draft:" line.
//
// Pure except for the registry, so everything is unit-tested without React.

import { parseMentions } from '@srtdio/comments';
import type { Result } from '@srtdio/rpc';

/** A picked mention: the member's user id and the display name typed in. */
export interface MentionPick {
  userId: string;
  name: string;
}

/**
 * Whether a send or edit failed because the server refused its mentions: a
 * mentioned person is not in the chat, or "all" outside a group.
 */
export function isMentionRefusal(message: string): boolean {
  return /mentioned people must be in this chat|everyone mention works only in groups/i.test(
    message,
  );
}

/** Whether the server refused the everyone mention because the chat is not a group. */
export function isEveryoneRefusal(message: string): boolean {
  return /everyone mention works only in groups/i.test(message);
}

/**
 * The mention list for the one retry after the server refused one: with a
 * fresh member list, every id no longer in it drops ("all" stays); when that
 * re-read failed, the retry carries no mentions at all. Pure.
 */
export function mentionsAfterRefusal(
  mentions: readonly string[],
  fresh: Result<readonly string[]>,
): string[] {
  if (!fresh.ok) return [];
  const members = new Set(fresh.data);
  return mentions.filter((id) => id === ALL_MENTION || members.has(id));
}

/** Resolve a user id to a display name; undefined when unknown. */
export type NameOf = (userId: string) => string | undefined;

/** One run of a body: plain text, or a mention token's user id. */
export type BodySegment = { kind: 'text'; text: string } | { kind: 'mention'; userId: string };

/** The label an unresolvable mention renders as (after the "@"). */
export const UNKNOWN_MEMBER = 'Unknown member';

/**
 * The everyone mention: the body token `@[all]`, and the string p_mentions
 * carries for it. Groups only; it renders "@all" and never opens a DM.
 */
export const ALL_MENTION = 'all';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A fresh global token matcher (a shared /g regex would carry lastIndex). */
function tokenPattern(): RegExp {
  return new RegExp(`@\\[(${UUID}|${ALL_MENTION})\\]`, 'gi');
}

/** The distinct mentioned user ids of a body, in first-seen order (lowercase). */
export function mentionIds(body: string): string[] {
  return parseMentions(body);
}

/** Whether a body carries the everyone token `@[all]`. */
export function mentionsAll(body: string): boolean {
  return [...body.matchAll(tokenPattern())].some((m) => m[1]?.toLowerCase() === ALL_MENTION);
}

/**
 * The p_mentions list for a body: its user ids, plus the string "all" while
 * the `@[all]` token is present and the chat is not a DM (a stray `@[all]` in
 * a DM never goes out), and nothing in notes. Send and edit both derive it here.
 */
export function mentionTargets(body: string, channelType?: 'dm' | 'group' | 'notes'): string[] {
  // Notes are private: a note never mentions anyone (no inbox rows).
  if (channelType === 'notes') return [];
  const ids = mentionIds(body);
  return mentionsAll(body) && channelType !== 'dm' ? [...ids, ALL_MENTION] : ids;
}

/** Split a body into text runs and mention tokens. Adjacent text stays one run. */
export function splitMentions(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(tokenPattern())) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ kind: 'text', text: body.slice(last, at) });
    segments.push({ kind: 'mention', userId: (match[1] ?? '').toLowerCase() });
    last = at + match[0].length;
  }
  if (last < body.length) segments.push({ kind: 'text', text: body.slice(last) });
  return segments;
}

/** "@Name" for a mention, or "@Unknown member" when the id does not resolve. */
export function mentionLabel(userId: string, nameOf: NameOf): string {
  if (userId.toLowerCase() === ALL_MENTION) return `@${ALL_MENTION}`;
  const name = nameOf(userId.toLowerCase());
  return `@${name !== undefined && name !== '' ? name : UNKNOWN_MEMBER}`;
}

/** The body as plain text: every token becomes "@Name". Other text is verbatim. */
export function resolveMentionText(body: string, nameOf: NameOf): string {
  return body.replace(tokenPattern(), (_match, id: string) => mentionLabel(id, nameOf));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The typed "@Name" of one pick, as a matcher: it counts only at the start of
 * the text or after whitespace, and only when the name is not followed by
 * another letter or digit (so "@Al" never matches inside "@Alex").
 */
function pickPattern(name: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu');
}

/**
 * The textarea text as the body the server stores: each pick whose "@Name" is
 * still intact becomes `@[uuid]`. Longer names go first so a name that is a
 * prefix of another never splits it. A damaged "@Name" is left as typed.
 * Picks sharing one label (several "@Unknown member" kept after a failed read)
 * take their occurrences in order; extra occurrences reuse the last pick.
 */
export function serializeMentions(text: string, picks: readonly MentionPick[]): string {
  const byName = new Map<string, string[]>();
  for (const pick of picks) {
    if (pick.name === '') continue;
    byName.set(pick.name, [...(byName.get(pick.name) ?? []), pick.userId]);
  }
  const ordered = [...byName.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of ordered) {
    const ids = byName.get(name) ?? [];
    let seen = 0;
    out = out.replace(pickPattern(name), (_match, lead: string) => {
      const id = ids[Math.min(seen, ids.length - 1)];
      seen += 1;
      return `${lead}@[${id ?? ''}]`;
    });
  }
  return out;
}

/**
 * A stored body back as textarea text plus its picks (the edit box and a
 * restored draft): every token becomes "@Name" and a pick. A token whose id does
 * not resolve reads "@Unknown member"; it drops on save only when `gone` says a
 * successful read confirmed the person left (the default treats every
 * unresolved id so). Otherwise (a failed read) it stays a pick under that label,
 * one per occurrence, so it still serializes back and still sends.
 */
export function deserializeMentions(
  body: string,
  nameOf: NameOf,
  gone: (userId: string) => boolean = () => true,
): { text: string; picks: MentionPick[] } {
  let picks: MentionPick[] = [];
  const text = body.replace(tokenPattern(), (_match, raw: string) => {
    const userId = raw.toLowerCase();
    if (userId === ALL_MENTION) {
      picks = addPick(picks, { userId, name: ALL_MENTION });
      return `@${ALL_MENTION}`;
    }
    const name = nameOf(userId);
    if (name === undefined || name === '') {
      if (!gone(userId)) picks = [...picks, { userId, name: UNKNOWN_MEMBER }];
      return `@${UNKNOWN_MEMBER}`;
    }
    picks = addPick(picks, { userId, name });
    return `@${name}`;
  });
  return { text, picks };
}

/** Add a pick; the same person picked twice stays one entry (the newest name). */
export function addPick(picks: readonly MentionPick[], pick: MentionPick): MentionPick[] {
  return [...picks.filter((p) => p.userId !== pick.userId), pick];
}

/**
 * The open mention run before the caret: an "@" at the start of the text or
 * right after whitespace, followed by no whitespace up to the caret. Returns the
 * "@" index and the typed query (possibly empty), or null when none is open.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replace the open "@query" run with "@Name " and put the caret after it. */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const open = mentionQuery(text, caret);
  if (open === null) return { text, caret };
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, '');
  return {
    text: `${text.slice(0, open.start)}${inserted}${after}`,
    caret: open.start + inserted.length,
  };
}

/** A person the picker can offer. */
export interface MentionMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Their @username; absent or null when not read. */
  username?: string | null;
  /** Raw workspace role; labelled at render. Null when unknown. */
  role: string | null;
}

/**
 * What a mention of this person reads as after the "@": their username, or
 * their display name for a profile that has none (14 Oct 2026: mentions show
 * @username). The token in the body still carries the user id, so a rename
 * never breaks an old mention.
 */
export function mentionHandle(person: { displayName: string; username?: string | null }): string {
  return person.username !== undefined && person.username !== null && person.username !== ''
    ? person.username
    : person.displayName;
}

/** Usernames are lowercase letters, digits, dots and underscores (users_username_format). */
const TYPED_USERNAME = /(^|\s)@([a-z0-9._]{3,20})(?![\p{L}\p{N}_.])/giu;

/**
 * Turn every "@username" typed without the picker into a real mention token,
 * when it names one of `members` (case-insensitive; a trailing full stop is
 * punctuation, not part of the name). Anything else stays plain text. Pure.
 */
export function linkTypedUsernames(
  text: string,
  members: ReadonlyArray<{ userId: string; username?: string | null }>,
): string {
  const byName = new Map<string, string>();
  for (const m of members) {
    if (m.username !== undefined && m.username !== null && m.username !== '') {
      byName.set(m.username.toLowerCase(), m.userId);
    }
  }
  if (byName.size === 0) return text;
  return text.replace(TYPED_USERNAME, (match, lead: string, raw: string) => {
    let name = raw.toLowerCase();
    let tail = '';
    while (name.endsWith('.') && !byName.has(name)) {
      name = name.slice(0, -1);
      tail = `.${tail}`;
    }
    const id = byName.get(name);
    return id === undefined ? match : `${lead}@[${id}]${tail}`;
  });
}

/**
 * The picker rows for a query: every member but me whose username or display
 * name contains the query (case-insensitive); usernames starting with it first,
 * then names starting with it, then the rest, each by name.
 */
export function filterMentionMembers(
  members: readonly MentionMember[],
  query: string,
  selfId: string | null,
): MentionMember[] {
  const q = query.trim().toLowerCase();
  const user = (m: MentionMember): string => (m.username ?? '').toLowerCase();
  const name = (m: MentionMember): string => m.displayName.toLowerCase();
  const rank = (m: MentionMember): number =>
    user(m).startsWith(q) ? 0 : name(m).startsWith(q) ? 1 : 2;
  return members
    .filter((m) => m.userId !== selfId && (user(m).includes(q) || name(m).includes(q)))
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

/** The picker's everyone row (groups only): "@all" over "Everyone in this group". */
export const ALL_MENTION_ROW: MentionMember = {
  userId: ALL_MENTION,
  displayName: ALL_MENTION,
  avatarUrl: null,
  role: null,
};

/** The line under the picker's "@all" row. */
export const ALL_MENTION_LINE = 'Everyone in this group';

/**
 * The picker rows for a query: in a group, "@all" first while the query is
 * empty or starts "all" or "everyone"; then filterMentionMembers. Never in a DM.
 */
export function mentionPickerRows(
  members: readonly MentionMember[],
  query: string,
  selfId: string | null,
  isGroup: boolean,
): MentionMember[] {
  const rows = filterMentionMembers(members, query, selfId);
  const q = query.trim().toLowerCase();
  const offerAll = isGroup && (ALL_MENTION.startsWith(q) || 'everyone'.startsWith(q));
  return offerAll ? [ALL_MENTION_ROW, ...rows] : rows;
}

/**
 * The invisible mark a text surface's line carries before a resolved `@[all]`
 * token, so only a real token draws bold: text typed as "@all" has none (any
 * mark already in a body is stripped first). splitAllMentions removes it.
 */
export const ALL_MARK = '\u2063';

/**
 * A body as a text surface's line (list preview, draft line, Activity): like
 * resolveMentionText, but each `@[all]` token reads ALL_MARK + "@all" so
 * splitAllMentions can tell it from typed text. Pure over nameOf.
 */
export function resolveMentionPreview(body: string, nameOf: NameOf): string {
  return body
    .replaceAll(ALL_MARK, '')
    .replace(tokenPattern(), (_match, id: string) =>
      id.toLowerCase() === ALL_MENTION ? `${ALL_MARK}@${ALL_MENTION}` : mentionLabel(id, nameOf),
    );
}

/**
 * A text surface's line (from resolveMentionPreview) split around each real
 * everyone mention, so it can draw bold; typed "@all" stays plain. The marks
 * never reach the runs. Pure.
 */
export function splitAllMentions(text: string): Array<{ text: string; all: boolean }> {
  const runs: Array<{ text: string; all: boolean }> = [];
  const token = `${ALL_MARK}@${ALL_MENTION}`;
  let last = 0;
  let at = text.indexOf(token);
  while (at !== -1) {
    if (at > last) runs.push({ text: text.slice(last, at).replaceAll(ALL_MARK, ''), all: false });
    runs.push({ text: `@${ALL_MENTION}`, all: true });
    last = at + token.length;
    at = text.indexOf(token, last);
  }
  if (last < text.length)
    runs.push({ text: text.slice(last).replaceAll(ALL_MARK, ''), all: false });
  return runs;
}

/**
 * Cut a body to at most `limit` characters without splitting a token: a cut
 * inside one keeps the whole token. An ellipsis marks any cut.
 */
export function truncateBody(body: string, limit: number): string {
  if (body.length <= limit) return body;
  let end = limit;
  for (const match of body.matchAll(tokenPattern())) {
    const at = match.index ?? 0;
    if (at >= limit) break;
    if (at + match[0].length > limit) end = at + match[0].length;
  }
  return end >= body.length ? body : `${body.slice(0, end)}…`;
}

/** The caret in serialized (token) coordinates, for a draft that stores the body. */
export function serializedCaret(
  text: string,
  caret: number,
  picks: readonly MentionPick[],
): number {
  return serializeMentions(text.slice(0, caret), picks).length;
}

/** A stored draft's caret back in textarea coordinates (a cut token rounds down). */
export function displayCaret(body: string, caret: number, nameOf: NameOf): number {
  let head = body.slice(0, caret);
  const open = head.lastIndexOf('@[');
  if (open !== -1 && !head.slice(open).includes(']')) head = head.slice(0, open);
  return deserializeMentions(head, nameOf).text.length;
}

// --- name registry -----------------------------------------------------------
//
// One registry per workspace: a name, a former flag or an unconfirmed flag
// learned in one workspace is never read in another. Every read and write
// names its workspace; a null workspace reads nothing and writes nothing.

interface MentionRegistry {
  names: Map<string, string>;
  // Ids a successful read found without an active workspace membership: their
  // mentions read "@Unknown member" (inert) even though their profile resolves.
  former: Set<string>;
  // Ids whose profile read but whose membership read failed: nothing is known
  // yet, so their mentions keep the failed-read behaviour (inert, retried).
  unconfirmed: Set<string>;
}

const registries = new Map<string, MentionRegistry>();

function registryFor(workspaceId: string): MentionRegistry {
  let registry = registries.get(workspaceId);
  if (registry === undefined) {
    registry = { names: new Map(), former: new Set(), unconfirmed: new Set() };
    registries.set(workspaceId, registry);
  }
  return registry;
}

/** Remember current members' mention handles in one workspace (a member read, or a pick). */
export function rememberMentionNames(
  workspaceId: string | null,
  entries: Iterable<{ userId: string; displayName: string; username?: string | null }>,
): void {
  if (workspaceId === null) return;
  const registry = registryFor(workspaceId);
  for (const entry of entries) {
    const handle = mentionHandle(entry);
    if (handle !== '' && entry.userId !== ALL_MENTION) {
      const id = entry.userId.toLowerCase();
      registry.names.set(id, handle);
      registry.former.delete(id);
      registry.unconfirmed.delete(id);
    }
  }
}

/**
 * Remember a mention profile read in one workspace: a current member's name
 * is kept; a confirmed non-member is marked former, so their mentions read
 * "@Unknown member". Membership unknown (null: its read failed) marks nobody
 * former and drops nothing already known.
 */
export function rememberMentionProfiles(
  workspaceId: string | null,
  entries: Iterable<{
    userId: string;
    displayName: string;
    username?: string | null;
    member: boolean | null;
  }>,
): void {
  if (workspaceId === null) return;
  const registry = registryFor(workspaceId);
  for (const entry of entries) {
    const id = entry.userId.toLowerCase();
    if (entry.member === true) {
      rememberMentionNames(workspaceId, [entry]);
    } else if (entry.member === false) {
      registry.names.delete(id);
      registry.unconfirmed.delete(id);
      registry.former.add(id);
    } else if (!registry.names.has(id) && !registry.former.has(id)) {
      registry.unconfirmed.add(id);
    }
  }
}

/** Whether a successful read found this id without an active membership in this workspace. */
export function isFormerMember(workspaceId: string | null, userId: string): boolean {
  return (
    workspaceId !== null && (registries.get(workspaceId)?.former.has(userId.toLowerCase()) ?? false)
  );
}

/** Whether this id's membership in this workspace is still unknown (its membership read failed). */
export function isUnconfirmedMember(workspaceId: string | null, userId: string): boolean {
  return (
    workspaceId !== null &&
    (registries.get(workspaceId)?.unconfirmed.has(userId.toLowerCase()) ?? false)
  );
}

/** A remembered current member's display name in this workspace, or undefined. */
export function knownMentionName(workspaceId: string | null, userId: string): string | undefined {
  if (workspaceId === null || isFormerMember(workspaceId, userId)) return undefined;
  return registries.get(workspaceId)?.names.get(userId.toLowerCase());
}

/** The registry's name lookup for one workspace. */
export function mentionNamesIn(workspaceId: string | null): NameOf {
  return (userId) => knownMentionName(workspaceId, userId);
}

// --- search surfaces -----------------------------------------------------------
//
// The palette resolves names with one batched read (users and workspace_members,
// each one .in() call) for the ids it does not know yet, then renders through
// the registry above. A person without a current membership reads "Former
// member"; a current member reads their @username.

/** What a person who is not a current member of the workspace reads as. */
export const FORMER_MEMBER = 'Former member';

/** The ids that still need a read in this workspace: no remembered name and not known former. */
export function unresolvedMentionIds(workspaceId: string | null, ids: Iterable<string>): string[] {
  if (workspaceId === null) return [];
  const out = new Set<string>();
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (id === '' || id === ALL_MENTION) continue;
    if (knownMentionName(workspaceId, id) !== undefined || isFormerMember(workspaceId, id))
      continue;
    out.add(id);
  }
  return [...out];
}

/**
 * Remember one successful batched read: the profiles as rememberMentionProfiles
 * does, and every asked id the read did not return (no visible profile) as former.
 */
export function rememberMentionRead(
  workspaceId: string | null,
  asked: readonly string[],
  profiles: ReadonlyArray<{
    userId: string;
    displayName: string;
    username?: string | null;
    member: boolean | null;
  }>,
): void {
  if (workspaceId === null) return;
  const returned = new Set(profiles.map((p) => p.userId.toLowerCase()));
  rememberMentionProfiles(workspaceId, [
    ...profiles,
    ...asked
      .filter((id) => !returned.has(id.toLowerCase()))
      .map((userId) => ({ userId, displayName: '', member: false })),
  ]);
}

/**
 * A body as a search line: like resolveMentionText, but a former member's token
 * reads "Former member". Never a raw token. Pure over the registry.
 */
export function resolveSearchMentionText(body: string, workspaceId: string | null): string {
  const nameOf = mentionNamesIn(workspaceId);
  return body.replace(tokenPattern(), (_match, id: string) =>
    isFormerMember(workspaceId, id) ? FORMER_MEMBER : mentionLabel(id, nameOf),
  );
}

/**
 * The name an acting person (author, sender) shows in search: "Former member"
 * when `isMember` is false or the registry knows them as former, else their
 * remembered name; undefined when nothing is known yet.
 */
export function searchActorName(
  workspaceId: string | null,
  userId: string,
  isMember: boolean | null = null,
): string | undefined {
  if (isMember === false || isFormerMember(workspaceId, userId)) return FORMER_MEMBER;
  return knownMentionName(workspaceId, userId);
}

/** Test-only: forget every remembered name in every workspace. */
export function resetMentionNames(): void {
  registries.clear();
}
