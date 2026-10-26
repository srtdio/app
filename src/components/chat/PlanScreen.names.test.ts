import { describe, expect, it, vi } from 'vitest';

// The Plan screen's approver names come from the workspace members this
// session already read: no request when every approver is there, and only the
// ids it lacks are read.

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { namesFromMembers } from '@/components/chat/PlanScreen';
import type { ChatProfile } from '@/lib/chat-reads';

const profiles = new Map<string, ChatProfile>([
  ['u1', { userId: 'u1', displayName: 'Riya Menon', avatarUrl: null }],
  ['u2', { userId: 'u2', displayName: 'Arjun Rao', avatarUrl: null }],
]);

describe('namesFromMembers', () => {
  it('names every approver the members read holds, with nothing left to read', () => {
    expect(namesFromMembers(['u1', 'u2', 'u1'], profiles)).toEqual({
      known: [
        { userId: 'u1', displayName: 'Riya Menon' },
        { userId: 'u2', displayName: 'Arjun Rao' },
      ],
      missing: [],
    });
  });

  it('leaves only the ids it lacks to read', () => {
    expect(namesFromMembers(['u1', 'gone'], profiles)).toEqual({
      known: [{ userId: 'u1', displayName: 'Riya Menon' }],
      missing: ['gone'],
    });
  });

  it('with no members read in this window, every id is read', () => {
    expect(namesFromMembers(['u1'], null)).toEqual({ known: [], missing: ['u1'] });
  });
});
