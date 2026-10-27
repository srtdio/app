import { describe, expect, it } from 'vitest';
import {
  authorProfiles,
  backfillProfiles,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';

const local = new Map<string, CommentProfile>([
  ['a', { displayName: 'Old A', avatarUrl: null, username: null }],
  ['gone', { displayName: 'Former member', avatarUrl: null, username: null }],
]);

describe('authorProfiles', () => {
  it('puts current members first, then the local map', () => {
    const out = authorProfiles(
      [{ id: 'a', name: 'Asha', username: 'asha', avatarUrl: 'https://a.png' }],
      local,
    );
    expect(out.get('a')).toEqual({ displayName: 'Asha', avatarUrl: 'https://a.png', username: 'asha' });
    expect(resolveName(out, 'gone')).toBe('Former member');
  });

  it('a member with no loaded profile falls through to the map', () => {
    const out = authorProfiles([{ id: 'a', name: '', username: null, avatarUrl: null }], local);
    expect(resolveName(out, 'a')).toBe('Old A');
  });
});

describe('backfillProfiles', () => {
  it('fills only ids the map lacks and the lookup knows', () => {
    const lookup = (id: string): CommentProfile | undefined =>
      id === 'b' ? { displayName: 'Bo', avatarUrl: null, username: null } : undefined;
    const out = backfillProfiles(['a', 'b', 'c'], local, lookup);
    expect([...out.keys()]).toEqual(['b']);
  });
});
