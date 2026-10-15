import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { Client } from '@srtdio/rpc';
import {
  bootstrapWorkspaces,
  isWorkspaceLimitError,
  ownedActiveCount,
  workspaceCreateBlocked,
  workspaceCreateErrorMessage,
  WORKSPACE_LIMIT_MESSAGE,
  type WorkspaceRow,
} from '@/lib/workspace-context';

const TRACE = '01890000-0000-7000-8000-000000000000';
const ME = 'user-1';

function row(id: string, owner: string, deletedAt: string | null = null): WorkspaceRow {
  return { id, name: id, owner_user_id: owner, deleted_at: deletedAt } as unknown as WorkspaceRow;
}

describe('workspace owner limit mapping', () => {
  it('maps the trigger exception to the free-plan message', () => {
    expect(isWorkspaceLimitError('workspace_limit_reached')).toBe(true);
    expect(workspaceCreateErrorMessage('workspace_limit_reached')).toBe(WORKSPACE_LIMIT_MESSAGE);
    expect(WORKSPACE_LIMIT_MESSAGE).toBe('On the free plan you can own one workspace.');
  });

  it('passes any other failure through unchanged', () => {
    expect(isWorkspaceLimitError('invalid_payload')).toBe(false);
    expect(workspaceCreateErrorMessage('invalid_payload')).toBe('invalid_payload');
  });
});

describe('workspaceCreateBlocked', () => {
  it('counts only active workspaces the caller owns', () => {
    const rows = [row('a', ME), row('b', 'other'), row('c', ME, '2026-10-01T00:00:00Z')];
    expect(ownedActiveCount(rows, ME)).toBe(1);
    expect(ownedActiveCount(rows, null)).toBe(0);
  });

  it('is open when the caller owns nothing (a member elsewhere may still create one)', () => {
    expect(
      workspaceCreateBlocked({ rows: [row('b', 'other')], userId: ME, isOperator: false }),
    ).toBe(false);
  });

  it('blocks an owner of one active workspace who is not exempt', () => {
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: false })).toBe(
      true,
    );
    // An unreadable exemption falls back to the ownership rule.
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: null })).toBe(
      true,
    );
  });

  it('never blocks an active platform operator', () => {
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: true })).toBe(
      false,
    );
  });

  it('treats owning more than one active workspace as exempt', () => {
    expect(
      workspaceCreateBlocked({ rows: [row('a', ME), row('b', ME)], userId: ME, isOperator: null }),
    ).toBe(false);
  });
});

describe('bootstrapWorkspaces on workspace_limit_reached', () => {
  it('stops quietly, never retries, and lands in the existing workspace', async () => {
    const lists = [{ data: [] as WorkspaceRow[] }, { data: [row('w1', ME)] }];
    let i = 0;
    const order = vi.fn(async () => {
      const next = lists[Math.min(i, lists.length - 1)]!;
      i += 1;
      return { data: next.data, error: null };
    });
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: 'workspace_limit_reached' },
    }));
    const client = { from: () => ({ select: () => ({ order }) }), rpc } as unknown as Client;
    const session = {
      user: { id: ME, user_metadata: { workspace_name: 'Acme' } },
    } as unknown as Session;
    const guard = { current: false };

    const res = await bootstrapWorkspaces(client, session, guard, () => TRACE);
    expect(res).toEqual({ workspaces: [row('w1', ME)], error: null });

    // A repeated auth-state change re-enters with the same guard: no second create.
    await bootstrapWorkspaces(client, session, guard, () => TRACE);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
