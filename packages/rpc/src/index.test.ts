import { describe, expect, it, vi } from 'vitest';
import {
  assetDelete,
  assetDeleteMany,
  postSoftDelete,
  userProfileUpdate,
  type Client,
} from './index';

// A minimal client whose rpc() returns the configured PostgREST shape and
// records how it was called. assetDelete must forward the proc name and the
// args object (carrying p_trace_id) unchanged, and adapt { data, error } into a
// Result, mirroring the other @srtdio/rpc wrappers.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  const client = { rpc } as unknown as Client;
  return { client, rpc };
}

describe('assetDelete', () => {
  const args = {
    p_asset_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await assetDelete(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('asset_delete', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps the workspace_member_only exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('assetDeleteMany', () => {
  const args = {
    p_asset_ids: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
    p_trace_id: '33333333-3333-3333-3333-333333333333',
  };

  it('returns ok and forwards the proc name + args unchanged on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await assetDeleteMany(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('asset_delete_many', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await assetDeleteMany(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await assetDeleteMany(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('postSoftDelete', () => {
  const args = {
    p_post_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await postSoftDelete(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('post_soft_delete', args);
  });

  it('maps the forbidden_role exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await postSoftDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await postSoftDelete(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('userProfileUpdate', () => {
  const args = {
    p_display_name: 'Asha Rao',
    // designation is optional in the proc (coalesce); the generated arg type is
    // non-nullable, so cast null the same way the proc suite does.
    p_designation: null as unknown as string,
    p_avatar_url: 'https://x/a.png',
    p_email_opt_in: true,
    p_trace_id: '33333333-3333-3333-3333-333333333333',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({
      data: '44444444-4444-4444-4444-444444444444',
      error: null,
    });
    const result = await userProfileUpdate(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('user_profile_update', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await userProfileUpdate(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });
});
