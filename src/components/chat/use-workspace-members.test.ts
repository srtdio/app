import { describe, expect, it } from 'vitest';
import {
  MEMBERS_LOAD_FAILED,
  activeMemberIds,
  loadWorkspaceMembers,
} from '@/components/chat/use-workspace-members';

describe('activeMemberIds', () => {
  it('keeps only active members', () => {
    expect(
      activeMemberIds([
        { user_id: 'u1', active: true },
        { user_id: 'removed', active: false },
        { user_id: 'u2', active: true },
      ]),
    ).toEqual(['u1', 'u2']);
  });

  it('de-duplicates by user_id (an owner with an inactive and an active row lists once)', () => {
    expect(
      activeMemberIds([
        { user_id: 'owner', active: false },
        { user_id: 'owner', active: true },
        { user_id: 'u1', active: true },
        { user_id: 'u1', active: true },
      ]),
    ).toEqual(['owner', 'u1']);
  });
});

describe('R9: a members load failure never shows raw error text', () => {
  const rawError = { code: 'unknown' as const, message: 'permission denied for table users' };

  it('the membership read failing maps to the fixed copy', async () => {
    const state = await loadWorkspaceMembers({
      members: () => Promise.resolve({ ok: false, error: rawError }),
      profiles: () => Promise.resolve({ ok: true, data: [] }),
    });
    expect(state).toEqual({ options: [], loading: false, error: MEMBERS_LOAD_FAILED });
    expect(MEMBERS_LOAD_FAILED).toBe("Couldn't load members. Try again.");
  });

  it('the profile read failing maps to the fixed copy', async () => {
    const state = await loadWorkspaceMembers({
      members: () => Promise.resolve({ ok: true, data: [{ user_id: 'u1', active: true }] }),
      profiles: () => Promise.resolve({ ok: false, error: rawError }),
    });
    expect(state.error).toBe(MEMBERS_LOAD_FAILED);
    expect(JSON.stringify(state)).not.toContain('permission denied');
  });
});
