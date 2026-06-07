import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { Client } from '@srtdio/rpc';
import { performSignUp } from '@/components/auth/SignUpPage';
import type { SignUpAuthClient } from '@/components/auth/SignUpPage';
import { bootstrapWorkspaces } from '@/lib/workspace-context';
import type { WorkspaceRow } from '@/lib/workspace-context';

const TRACE = '01890000-0000-7000-8000-000000000000';
const newTrace = (): string => TRACE;

function sessionWith(metadata: Record<string, unknown>): Session {
  return { user: { user_metadata: metadata } } as unknown as Session;
}

function row(id: string, name: string): WorkspaceRow {
  return { id, name } as unknown as WorkspaceRow;
}

/**
 * Mock Supabase client driving both wrappers: listWorkspaces awaits
 * .from().select().order() and workspaceCreate awaits .rpc(). Each call to
 * .order() shifts the next queued list result (the last is reused).
 */
function mockClient(lists: Array<{ data?: WorkspaceRow[]; error?: { message: string } }>) {
  let i = 0;
  const order = vi.fn(async () => {
    const next = lists[Math.min(i, lists.length - 1)] ?? { data: [] };
    i += 1;
    return { data: next.data ?? [], error: next.error ?? null };
  });
  const select = vi.fn(() => ({ order }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(async () => ({ data: 'new-workspace-id', error: null }));
  return { client: { from, rpc } as unknown as Client, rpc, order };
}

describe('performSignUp', () => {
  it('shows the confirm-email state and fires NO workspaceCreate when session is null', async () => {
    const rpc = vi.fn();
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }));
    const client = { auth: { signUp }, rpc } as unknown as SignUpAuthClient;

    const result = await performSignUp(client, {
      email: 'dana@example.com',
      password: 'pw',
      displayName: 'Dana',
      workspaceName: 'Acme',
      timezone: 'UTC',
    });

    expect(result).toEqual({ status: 'confirm-email' });
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { data: { display_name: 'Dana', workspace_name: 'Acme', timezone: 'UTC' } },
      }),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports authenticated when signUp returns a session', async () => {
    const signUp = vi.fn(async () => ({ data: { session: {} as Session }, error: null }));
    const client = { auth: { signUp } } as unknown as SignUpAuthClient;

    const result = await performSignUp(client, {
      email: 'dana@example.com',
      password: 'pw',
      displayName: 'Dana',
      workspaceName: 'Acme',
      timezone: 'UTC',
    });

    expect(result).toEqual({ status: 'authenticated' });
  });
});

describe('bootstrapWorkspaces', () => {
  const session = sessionWith({ workspace_name: 'Acme', timezone: 'UTC' });

  it('creates exactly once when session present + workspaces empty + workspace_name present', async () => {
    const { client, rpc } = mockClient([{ data: [] }, { data: [row('w1', 'Acme')] }]);
    const guard = { current: false };

    const res = await bootstrapWorkspaces(client, session, guard, newTrace);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('workspace_create', {
      p_payload: { name: 'Acme', timezone: 'UTC' },
      p_trace_id: TRACE,
    });
    expect(res.error).toBeNull();
    expect(res.workspaces).toEqual([row('w1', 'Acme')]);
  });

  it('does not create twice when a repeated auth-state change re-enters with the same guard', async () => {
    const { client, rpc } = mockClient([{ data: [] }]); // list stays empty every time
    const guard = { current: false };

    await bootstrapWorkspaces(client, session, guard, newTrace);
    await bootstrapWorkspaces(client, session, guard, newTrace);

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when workspaces are non-empty', async () => {
    const { client, rpc } = mockClient([{ data: [row('w9', 'Existing')] }]);
    const guard = { current: false };

    const res = await bootstrapWorkspaces(client, session, guard, newTrace);

    expect(rpc).not.toHaveBeenCalled();
    expect(res.workspaces).toEqual([row('w9', 'Existing')]);
  });

  it('creates nothing when workspace_name is absent (invited / existing users)', async () => {
    const { client, rpc } = mockClient([{ data: [] }]);
    const guard = { current: false };

    const res = await bootstrapWorkspaces(client, sessionWith({}), guard, newTrace);

    expect(rpc).not.toHaveBeenCalled();
    expect(res.workspaces).toEqual([]);
    expect(res.error).toBeNull();
  });
});
