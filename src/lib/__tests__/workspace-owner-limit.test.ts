import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { Client } from '@srtdio/rpc';
import {
  bootstrapWorkspaces,
  isWorkspaceLimitError,
  ownedActiveCount,
  readIsPlatformOperator,
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

  it('blocks an owner of an active workspace who is not a platform operator', () => {
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: false })).toBe(
      true,
    );
    // Unknown (read pending) is not exempt either.
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: null })).toBe(
      true,
    );
  });

  it('never blocks an active platform operator', () => {
    expect(workspaceCreateBlocked({ rows: [row('a', ME)], userId: ME, isOperator: true })).toBe(
      false,
    );
  });

  it('does not treat owning two workspaces as exempt without a platform_operators row', () => {
    expect(
      workspaceCreateBlocked({ rows: [row('a', ME), row('b', ME)], userId: ME, isOperator: false }),
    ).toBe(true);
  });
});

describe('readIsPlatformOperator', () => {
  function clientReturning(result: { data: unknown; error: { message: string } | null }) {
    const calls: Array<[string, unknown]> = [];
    const query = {
      select: (cols: string) => (calls.push(['select', cols]), query),
      eq: (col: string, val: unknown) => (calls.push([`eq ${col}`, val]), query),
      is: (col: string, val: unknown) => (calls.push([`is ${col}`, val]), query),
      maybeSingle: async () => result,
    };
    const from = vi.fn(() => query);
    return { client: { from } as unknown as Client, from, calls };
  }

  it('reads the caller own active row', async () => {
    const { client, from, calls } = clientReturning({ data: { user_id: ME }, error: null });
    expect(await readIsPlatformOperator(client, ME)).toBe(true);
    expect(from).toHaveBeenCalledWith('platform_operators');
    expect(calls).toEqual([
      ['select', 'user_id'],
      ['eq user_id', ME],
      ['is revoked_at', null],
    ]);
  });

  it('is false with no row', async () => {
    const { client } = clientReturning({ data: null, error: null });
    expect(await readIsPlatformOperator(client, ME)).toBe(false);
  });

  it('is false (not exempt) when the read fails', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'denied' } });
    expect(await readIsPlatformOperator(client, ME)).toBe(false);
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
