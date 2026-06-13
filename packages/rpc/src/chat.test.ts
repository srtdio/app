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

// A minimal client whose rpc() returns the configured PostgREST shape and
// records how it was called. Every chat wrapper must forward the proc name and
// the args object (carrying p_trace_id) unchanged, and adapt { data, error }
// into a Result, mirroring the other @srtdio/rpc wrappers.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  const client = { rpc } as unknown as Client;
  return { client, rpc };
}

const TRACE = '22222222-2222-2222-2222-222222222222';
const WS = '11111111-1111-1111-1111-111111111111';
const GROUP = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';

describe('chat write wrappers', () => {
  const cases = [
    {
      name: 'groupCreate',
      proc: 'group_create',
      data: GROUP,
      call: (c: Client) =>
        groupCreate(c, {
          p_workspace_id: WS,
          p_name: 'Launch',
          p_member_user_ids: [USER],
          p_trace_id: TRACE,
        }),
      args: {
        p_workspace_id: WS,
        p_name: 'Launch',
        p_member_user_ids: [USER],
        p_trace_id: TRACE,
      },
    },
    {
      name: 'groupRename',
      proc: 'group_rename',
      data: undefined,
      call: (c: Client) =>
        groupRename(c, { p_group_id: GROUP, p_name: 'Renamed', p_trace_id: TRACE }),
      args: { p_group_id: GROUP, p_name: 'Renamed', p_trace_id: TRACE },
    },
    {
      name: 'groupMemberAdd',
      proc: 'group_member_add',
      data: undefined,
      call: (c: Client) =>
        groupMemberAdd(c, { p_group_id: GROUP, p_user_id: USER, p_trace_id: TRACE }),
      args: { p_group_id: GROUP, p_user_id: USER, p_trace_id: TRACE },
    },
    {
      name: 'groupMemberRemove',
      proc: 'group_member_remove',
      data: undefined,
      call: (c: Client) =>
        groupMemberRemove(c, { p_group_id: GROUP, p_user_id: USER, p_trace_id: TRACE }),
      args: { p_group_id: GROUP, p_user_id: USER, p_trace_id: TRACE },
    },
    {
      name: 'groupLeave',
      proc: 'group_leave',
      data: undefined,
      call: (c: Client) => groupLeave(c, { p_group_id: GROUP, p_trace_id: TRACE }),
      args: { p_group_id: GROUP, p_trace_id: TRACE },
    },
    {
      name: 'dmChannelEnsure',
      proc: 'dm_channel_ensure',
      data: 'dm:ws:a:b',
      call: (c: Client) =>
        dmChannelEnsure(c, { p_workspace_id: WS, p_other_user_id: USER, p_trace_id: TRACE }),
      args: { p_workspace_id: WS, p_other_user_id: USER, p_trace_id: TRACE },
    },
  ] as const;

  for (const tc of cases) {
    it(`${tc.name} forwards the proc name + args (incl p_trace_id) on success`, async () => {
      const { client, rpc } = makeClient({ data: tc.data, error: null });
      const result = await tc.call(client);
      expect(result).toEqual({ ok: true, data: tc.data });
      expect(rpc).toHaveBeenCalledWith(tc.proc, tc.args);
    });

    it(`${tc.name} returns ok:false (no throw) on a domain error`, async () => {
      const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
      const result = await tc.call(client);
      expect(result).toEqual({
        ok: false,
        error: { code: 'workspace_member_only', message: 'workspace_member_only' },
      });
    });

    it(`${tc.name} maps an unexpected transport error to code "unknown"`, async () => {
      const { client } = makeClient({ data: null, error: { message: 'network down' } });
      const result = await tc.call(client);
      expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
    });
  }
});
