// Pure helpers for the chat member picker (new DM peer, group creation members,
// add-member). Kept React-free so the exclusion rules are unit-tested directly:
// the DM-peer list excludes the current user, and the add-member list excludes
// the group's existing members. Display info comes from the existing chat reads
// (workspace membership + batched profile resolution); nothing is fabricated.

import type { ChatProfile } from '@/lib/chat-reads';

/** One selectable person in a picker. */
export interface MemberOption {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Shape resolved profiles into picker options, sorted by display name. */
export function toMemberOptions(profiles: ChatProfile[]): MemberOption[] {
  return profiles
    .map((p) => ({ userId: p.userId, displayName: p.displayName, avatarUrl: p.avatarUrl }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Drop any option whose user id is in the exclusion set (current user / members). */
export function excludeMembers(
  options: MemberOption[],
  excludeIds: readonly string[],
): MemberOption[] {
  const excluded = new Set(excludeIds);
  return options.filter((option) => !excluded.has(option.userId));
}
