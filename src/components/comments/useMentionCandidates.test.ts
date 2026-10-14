import { describe, expect, it } from 'vitest';
import { currentMembers } from './useMentionCandidates';

describe('currentMembers', () => {
  it('keeps active, not-removed rows, one per person', () => {
    const rows = [
      { user_id: 'a', active: true, removed_at: null, role: 'owner' },
      { user_id: 'b', active: false, removed_at: '2026-09-01T00:00:00Z', role: 'agency' },
      { user_id: 'c', active: false, removed_at: null, role: 'client' },
      { user_id: 'd', active: true, removed_at: null, role: 'client' },
      { user_id: 'd', active: true, removed_at: null, role: 'client' },
    ];
    expect(currentMembers(rows).map((r) => r.user_id)).toEqual(['a', 'd']);
  });
});
