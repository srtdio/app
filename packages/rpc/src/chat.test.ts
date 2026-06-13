import { describe, expect, it, vi } from 'vitest';
import {
  dmChannelEnsure,
  groupCreate,
  groupLeave,
  groupMemberAdd,
  groupMemberRemove,
  groupRename,
  type Client,
} from './index';

// Each chat wrapper must forward its proc name and the args object (carrying the
// generated p_trace_id) unchanged, and adapt PostgREST's { data, error } into a
// Result, returning ok:false (never throwing) on a proc/domain error. The client
// is mocked; no network.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  const client = { rpc } as unknown as Client;
  return { client, rpc };
}

const WORKSPACE = '00000000-0000-0000-0000-000000000001';
const TRACE = '00000000-0000-0000-0000-0000000000ff';
const GROUP = '00000000-0000-0000-0000-000000000002';
const USER = '00000000-0000-0000-0000-000000000003';

describe('groupCreate', () => {
  const args = {
    p_member_user_ids: [USER],
    p_name: 'Launch',
    p_trace_id: TRACE,
    p_workspace_id: WORKSPACE,
  };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: GROUP, error: null });
    const result = await groupCreate(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('group_create', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await groupCreate(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });
});

describe('groupRename', () => {
  const args = { p_group_id: GROUP, p_name: 'Renamed', p_trace_id: TRACE };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await groupRename(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('group_rename', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await groupRename(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });
});

describe('groupMemberAdd', () => {
  const args = { p_group_id: GROUP, p_trace_id: TRACE, p_user_id: USER };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await groupMemberAdd(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('group_member_add', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await groupMemberAdd(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });
});

describe('groupMemberRemove', () => {
  const args = { p_group_id: GROUP, p_trace_id: TRACE, p_user_id: USER };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await groupMemberRemove(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('group_member_remove', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await groupMemberRemove(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });
});

describe('groupLeave', () => {
  const args = { p_group_id: GROUP, p_trace_id: TRACE };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await groupLeave(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('group_leave', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await groupLeave(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });
});

describe('dmChannelEnsure', () => {
  const args = { p_other_user_id: USER, p_trace_id: TRACE, p_workspace_id: WORKSPACE };

  it('forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: GROUP, error: null });
    const result = await dmChannelEnsure(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('dm_channel_ensure', args);
  });

  it('returns ok:false on a proc error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await dmChannelEnsure(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });
});
