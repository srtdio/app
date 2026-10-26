// Who reacted to one message: one select of its chat_reactions rows, then one
// batched profile read for the reactors not already known (never one read per
// person), all inside one 5s budget. The grouping (All tab, one tab per emoji,
// the viewer's own rows first as "You") is pure and unit-tested.

import type { Client, Result } from '@srtdio/rpc';
import { readMentionProfiles, withReadTimeout, type ChatProfile } from '@/lib/chat-reads';
import { loadMessageReactors, type ReactorRow } from '@/lib/chat/history';
import { FORMER_MEMBER } from '@/lib/chat/mentions';

/** One person's reaction, ready to render. */
export interface ReactorEntry {
  userId: string;
  emoji: string;
  /**
   * The display name; "You" for the viewer, "Former member" only for someone a
   * read confirmed is not a current member, empty while a name is not loaded.
   */
  name: string;
  avatarUrl: string | null;
  mine: boolean;
}

/** One chip: All, or one emoji, with its count. */
export interface ReactorTab {
  key: string;
  emoji: string | null;
  count: number;
}

/** The sheet's model: the chips and every row (All order). */
export interface WhoReacted {
  tabs: ReactorTab[];
  rows: ReactorEntry[];
}

/** The All chip's key. */
export const ALL_TAB = 'all';

/** The viewer's own row label. */
const YOU_LABEL = 'You';

/**
 * Group reaction rows: the All chip (every row), then one chip per emoji in
 * order of first reaction; rows keep reaction order with the viewer's own rows
 * first, labelled "You". Pure.
 */
export function groupReactors(
  rows: readonly ReactorRow[],
  viewerId: string | null,
  profileOf: (userId: string) => Pick<ChatProfile, 'displayName' | 'avatarUrl'> | undefined,
  isFormer: (userId: string) => boolean = () => false,
): WhoReacted {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.emoji, (counts.get(row.emoji) ?? 0) + 1);
  const tabs: ReactorTab[] = [
    { key: ALL_TAB, emoji: null, count: rows.length },
    ...[...counts].map(([emoji, count]) => ({ key: emoji, emoji, count })),
  ];
  const entries = rows.map((row): ReactorEntry => {
    const mine = viewerId !== null && row.userId === viewerId;
    const former = !mine && isFormer(row.userId);
    const profile = former ? undefined : profileOf(row.userId);
    const known = profile !== undefined && profile.displayName !== '';
    return {
      userId: row.userId,
      emoji: row.emoji,
      name: mine ? YOU_LABEL : known ? profile.displayName : former ? FORMER_MEMBER : '',
      avatarUrl: profile?.avatarUrl ?? null,
      mine,
    };
  });
  const own = entries.filter((e) => e.mine);
  const others = entries.filter((e) => !e.mine);
  return { tabs, rows: [...own, ...others] };
}

/** The rows a chip shows. Pure. */
export function rowsForTab(model: WhoReacted, key: string): ReactorEntry[] {
  return key === ALL_TAB ? model.rows : model.rows.filter((row) => row.emoji === key);
}

/**
 * The reactor rows plus profiles for the ids `known` cannot name: one select
 * and at most one batched profile read, within one 5s budget.
 */
export function loadWhoReacted(
  client: Client,
  params: {
    messageId: string;
    workspaceId: string | null;
    known: (userId: string) => ChatProfile | undefined;
  },
): Promise<
  Result<{ rows: ReactorRow[]; profiles: Map<string, ChatProfile>; former: Set<string> }>
> {
  return withReadTimeout(async (signal) => {
    const reactors = await loadMessageReactors(client, params.messageId, signal);
    if (!reactors.ok) return reactors;
    const profiles = new Map<string, ChatProfile>();
    // Reactors a successful read confirmed are not current members.
    const former = new Set<string>();
    const missing: string[] = [];
    for (const row of reactors.data) {
      const hit = params.known(row.userId);
      if (hit !== undefined) profiles.set(row.userId, hit);
      else if (!missing.includes(row.userId)) missing.push(row.userId);
    }
    if (missing.length > 0 && params.workspaceId !== null) {
      const read = await readMentionProfiles(client, {
        workspaceId: params.workspaceId,
        userIds: missing,
        signal,
      });
      // A failed name read still shows the reactions, unnamed (never "Former member").
      if (read.ok) {
        const returned = new Set(read.data.map((p) => p.userId));
        for (const p of read.data) {
          if (p.member === false) former.add(p.userId);
          else profiles.set(p.userId, p);
        }
        for (const id of missing) if (!returned.has(id)) former.add(id);
      }
    }
    return { ok: true, data: { rows: reactors.data, profiles, former } };
  });
}
