// Emoji reactions, the pure part (9 Nov 2026): one row per (target, person,
// emoji), summarised into the chips a row shows (one per emoji, in order of
// first reaction, stable), the optimistic toggle and the chips' spoken names.
// Shared by post / brief comments, plan comments, chat and catch up. No reads.

/** Where a reaction lives: a post or brief comment, a plan comment, a chat message. */
export type ReactionKind = 'comment' | 'plan-comment' | 'chat';

/** One person's reaction on one target. */
export interface ReactionRow {
  targetId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

/** One chip: an emoji, how many reacted with it, and whether the viewer did. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
}

/** No reactions: one array every row shares (never re-allocated). */
export const NO_REACTIONS: readonly ReactionSummary[] = [];

/** No rows: one array every target shares. */
export const NO_ROWS: readonly ReactionRow[] = [];

/** Rows in order of reaction time; ties keep their arrival order. Pure. */
export function byFirstReaction(rows: readonly ReactionRow[]): ReactionRow[] {
  return rows
    .map((row, at) => ({ row, at, ms: Date.parse(row.createdAt) }))
    .sort((a, b) => {
      const am = Number.isNaN(a.ms) ? Infinity : a.ms;
      const bm = Number.isNaN(b.ms) ? Infinity : b.ms;
      return am !== bm ? am - bm : a.at - b.at;
    })
    .map((x) => x.row);
}

/**
 * One target's chips: one per emoji, ordered by that emoji's first reaction
 * (stable), with the count and whether `me` is among them. Pure.
 */
export function summarize(
  rows: readonly ReactionRow[],
  me: string | null,
): readonly ReactionSummary[] {
  if (rows.length === 0) return NO_REACTIONS;
  const out: ReactionSummary[] = [];
  for (const row of byFirstReaction(rows)) {
    const mine = me !== null && row.userId === me;
    const hit = out.find((r) => r.emoji === row.emoji);
    if (hit === undefined) out.push({ emoji: row.emoji, count: 1, mine });
    else {
      hit.count += 1;
      hit.mine = hit.mine || mine;
    }
  }
  return out;
}

/** Rows grouped per target; every asked id gets an entry (empty when none). Pure. */
export function groupByTarget(
  rows: readonly ReactionRow[],
  ids: readonly string[],
): Map<string, ReactionRow[]> {
  const out = new Map<string, ReactionRow[]>();
  for (const id of ids) out.set(id, []);
  for (const row of rows) {
    const list = out.get(row.targetId);
    if (list !== undefined) list.push(row);
    else out.set(row.targetId, [row]);
  }
  return out;
}

/** Whether `me` already reacted with `emoji`: the tap removes it. Pure. */
export function toggleOp(
  rows: readonly ReactionRow[],
  me: string,
  emoji: string,
): 'add' | 'remove' {
  return rows.some((r) => r.userId === me && r.emoji === emoji) ? 'remove' : 'add';
}

/**
 * One target's rows after the viewer's add or remove (the optimistic paint and
 * its rollback). An add appends (its chip keeps its place when the emoji is
 * already there, else it goes last); a remove drops the viewer's row. Pure.
 */
export function applyOp(
  rows: readonly ReactionRow[],
  input: { targetId: string; me: string; emoji: string; op: 'add' | 'remove'; at: string },
): readonly ReactionRow[] {
  const has = rows.some((r) => r.userId === input.me && r.emoji === input.emoji);
  if (input.op === 'add') {
    if (has) return rows;
    return [
      ...rows,
      { targetId: input.targetId, userId: input.me, emoji: input.emoji, createdAt: input.at },
    ];
  }
  if (!has) return rows;
  return rows.filter((r) => !(r.userId === input.me && r.emoji === input.emoji));
}

/** A chip's spoken name: "👍 3, you reacted" / "👍 1". Pure. */
export function reactionChipLabel(r: ReactionSummary): string {
  return r.mine ? `${r.emoji} ${r.count}, you reacted` : `${r.emoji} ${r.count}`;
}

/** The smiley pill's and the action bar key's name. */
export const ADD_REACTION_LABEL = 'Add reaction';

/** The emoji sheet's title when it picks a reaction. */
export const ADD_REACTION_TITLE = 'Add reaction';
