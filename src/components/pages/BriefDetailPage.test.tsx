import { describe, expect, it } from 'vitest';
import { briefAuthorLabel } from '@/components/pages/BriefDetailPage';

// Unit-test the pure "Created by" resolver across every branch. The resolver is
// handed a memberName lookup that returns a current member's display name or null
// when the id is not a current member, mirroring the page's memberById map.
describe('briefAuthorLabel', () => {
  const members: Record<string, string> = { u1: 'Asha Rao' };
  const memberName = (id: string): string | null => members[id] ?? null;

  it('resolves created_by to the member name, taking precedence over a legacy name', () => {
    expect(briefAuthorLabel('u1', 'Old Name', memberName)).toBe('Asha Rao');
  });

  it('falls back to the legacy name when created_by does not resolve to a member', () => {
    expect(briefAuthorLabel('u404', 'Old Name', memberName)).toBe('Old Name');
  });

  it('returns the legacy name when created_by is null', () => {
    expect(briefAuthorLabel(null, 'Old Name', memberName)).toBe('Old Name');
  });

  it('returns (ex-member) when created_by is unresolved and there is no legacy name', () => {
    expect(briefAuthorLabel('u404', null, memberName)).toBe('(ex-member)');
  });

  it('returns (ex-member) when created_by is null and there is no legacy name', () => {
    expect(briefAuthorLabel(null, null, memberName)).toBe('(ex-member)');
  });

  it('treats an empty created_by string as no member and falls back', () => {
    expect(briefAuthorLabel('', 'Old Name', memberName)).toBe('Old Name');
  });
});
