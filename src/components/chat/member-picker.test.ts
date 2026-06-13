import { describe, expect, it } from 'vitest';
import type { ChatProfile } from '@/lib/chat-reads';
import { excludeMembers, toMemberOptions } from '@/components/chat/member-picker';

function profile(userId: string, displayName: string): ChatProfile {
  return { userId, displayName, avatarUrl: null };
}

describe('toMemberOptions', () => {
  it('maps profiles to options sorted by display name', () => {
    const options = toMemberOptions([profile('u2', 'Zoe'), profile('u1', 'Ada')]);
    expect(options.map((o) => o.userId)).toEqual(['u1', 'u2']);
  });
});

describe('excludeMembers', () => {
  const options = [profile('me', 'Me'), profile('u1', 'Ada'), profile('u2', 'Zoe')].map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
  }));

  it('excludes the current user from the DM peer list', () => {
    const result = excludeMembers(options, ['me']);
    expect(result.map((o) => o.userId)).toEqual(['u1', 'u2']);
  });

  it('excludes existing members from the add-member list', () => {
    const result = excludeMembers(options, ['me', 'u1']);
    expect(result.map((o) => o.userId)).toEqual(['u2']);
  });

  it('returns every option when nothing is excluded', () => {
    expect(excludeMembers(options, [])).toHaveLength(3);
  });
});
