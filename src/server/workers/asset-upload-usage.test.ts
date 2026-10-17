import { describe, expect, it, vi } from 'vitest';

// The service-role client: one chainable query and one RPC whose results each
// test sets, plus the headers the client was built with.
const supa = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string } | null },
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  calls: [] as Array<[string, unknown]>,
  headers: null as Record<string, string> | null,
}));
vi.mock('@supabase/supabase-js', () => {
  const query: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is']) {
    query[name] = (a: unknown, b?: unknown) => {
      supa.calls.push([name, b === undefined ? a : [a, b]]);
      return query;
    };
  }
  query.maybeSingle = async () => supa.result;
  return {
    createClient: (
      _url: string,
      _key: string,
      options: { global: { headers: Record<string, string> } },
    ) => {
      supa.headers = options.global.headers;
      return {
        from: (table: string) => {
          supa.calls.push(['from', table]);
          return query;
        },
        rpc: async (fn: string, args: unknown) => {
          supa.calls.push(['rpc', [fn, args]]);
          return supa.rpcResult;
        },
      };
    },
  };
});
import {
  CAP_BYTES,
  checkWorkspaceCap,
  createSupabaseUsageStore,
  resolveWorkspaceUsage,
  usageBody,
  WARN_AT_BYTES,
  type UsageStore,
} from './asset-upload-usage';
import { WORKSPACE_FULL_BODY } from './asset-upload-purge-contracts';

const MB = 1024 * 1024;

function store(
  bytes: number | null,
  exempt: boolean,
): UsageStore & {
  bytesUsed: ReturnType<typeof vi.fn>;
} {
  return {
    workspace: vi.fn(async () => ({ ownerUserId: 'owner-1' })),
    isExemptOwner: vi.fn(async () => exempt),
    bytesUsed: vi.fn(async () => bytes),
  };
}

describe('usageBody thresholds', () => {
  it('warns at exactly 800 MB and above, never below', () => {
    expect(WARN_AT_BYTES).toBe(800 * MB);
    expect(usageBody(800 * MB - 1, false).warn).toBe(false);
    expect(usageBody(800 * MB, false)).toEqual({
      usedBytes: 800 * MB,
      warnAtBytes: 800 * MB,
      warn: true,
      exempt: false,
    });
    expect(usageBody(CAP_BYTES, false).warn).toBe(true);
  });

  it('never warns an exempt owner', () => {
    expect(usageBody(999 * MB, true)).toEqual({
      usedBytes: 999 * MB,
      warnAtBytes: 800 * MB,
      warn: false,
      exempt: true,
    });
  });
});

describe('resolveWorkspaceUsage', () => {
  it('warns a non-exempt workspace at 800 MB', async () => {
    const res = await resolveWorkspaceUsage({ workspaceId: 'ws-1', store: store(810 * MB, false) });
    expect(res).toEqual({ ok: true, value: usageBody(810 * MB, false) });
    expect(res.ok && res.value.warn).toBe(true);
  });

  it('marks an operator-owned workspace exempt and never warns', async () => {
    const res = await resolveWorkspaceUsage({ workspaceId: 'ws-1', store: store(900 * MB, true) });
    expect(res.ok && res.value).toEqual({
      usedBytes: 900 * MB,
      warnAtBytes: 800 * MB,
      warn: false,
      exempt: true,
    });
  });

  it('is a domain error, never a number, when the usage read fails', async () => {
    const res = await resolveWorkspaceUsage({ workspaceId: 'ws-1', store: store(null, false) });
    expect(res).toEqual({
      ok: false,
      error: { code: 'usage_unavailable', message: 'Storage usage is unavailable right now.' },
    });
  });

  it('is not_found for a missing or deleted workspace', async () => {
    const missing = { ...store(1, false), workspace: async () => null };
    const res = await resolveWorkspaceUsage({ workspaceId: 'ws-x', store: missing });
    expect(!res.ok && res.error.code).toBe('not_found');
    expect(missing.bytesUsed).not.toHaveBeenCalled();
  });
});

describe('checkWorkspaceCap', () => {
  const check = (used: number | null, addBytes: number, exempt = false) =>
    checkWorkspaceCap({ workspaceId: 'ws-1', addBytes, store: store(used, exempt) });

  it('lets an upload under the cap through', async () => {
    expect(await check(100 * MB, 10 * MB)).toEqual({ ok: true, value: null });
  });

  it('lets an upload that lands exactly on the cap through', async () => {
    expect(await check(CAP_BYTES - 10, 10)).toEqual({ ok: true, value: null });
  });

  it('refuses one byte over the cap with the exact workspace_full body', async () => {
    const res = await check(CAP_BYTES - 10, 11);
    expect(res).toEqual({ ok: false, error: WORKSPACE_FULL_BODY.error });
    expect(!res.ok && res.error.message).toBe('This workspace is full.');
  });

  it('never caps an exempt owner and skips the usage read', async () => {
    const exempt = store(CAP_BYTES, true);
    const res = await checkWorkspaceCap({ workspaceId: 'ws-1', addBytes: 50 * MB, store: exempt });
    expect(res.ok).toBe(true);
    expect(exempt.bytesUsed).not.toHaveBeenCalled();
  });

  it('fails closed when usage cannot be read', async () => {
    const res = await check(null, 1);
    expect(!res.ok && res.error.code).toBe('usage_unavailable');
  });

  it('is not_found for a missing workspace', async () => {
    const res = await checkWorkspaceCap({
      workspaceId: 'ws-x',
      addBytes: 1,
      store: { ...store(0, false), workspace: async () => null },
    });
    expect(!res.ok && res.error.code).toBe('not_found');
  });
});

describe('createSupabaseUsageStore', () => {
  const usage = createSupabaseUsageStore(
    { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'k' },
    'trace-1',
  );

  it('carries the trace on the X-Trace-Id client header', () => {
    expect(supa.headers).toEqual({ 'X-Trace-Id': 'trace-1' });
  });

  it('reads stored bytes through workspace_bytes_used', async () => {
    supa.calls = [];
    supa.rpcResult = { data: 123, error: null };
    expect(await usage.bytesUsed('ws-1')).toBe(123);
    expect(supa.calls).toEqual([['rpc', ['workspace_bytes_used', { p_workspace_id: 'ws-1' }]]]);
  });

  it('is null when the RPC fails or answers nonsense', async () => {
    supa.rpcResult = { data: null, error: { message: 'boom' } };
    expect(await usage.bytesUsed('ws-1')).toBeNull();
    supa.rpcResult = { data: -1, error: null };
    expect(await usage.bytesUsed('ws-1')).toBeNull();
  });

  it('reads the live workspace owner', async () => {
    supa.calls = [];
    supa.result = { data: { owner_user_id: 'owner-1' }, error: null };
    expect(await usage.workspace('ws-1')).toEqual({ ownerUserId: 'owner-1' });
    expect(supa.calls).toEqual([
      ['from', 'workspaces'],
      ['select', 'owner_user_id'],
      ['eq', ['id', 'ws-1']],
      ['is', ['deleted_at', null]],
    ]);
  });

  it('reads only the owner active platform_operators row', async () => {
    supa.calls = [];
    supa.result = { data: { user_id: 'owner-1' }, error: null };
    expect(await usage.isExemptOwner('owner-1')).toBe(true);
    expect(supa.calls).toEqual([
      ['from', 'platform_operators'],
      ['select', 'user_id'],
      ['eq', ['user_id', 'owner-1']],
      ['is', ['revoked_at', null]],
    ]);
  });

  it('is not exempt without a row, or when the read fails (never a workspace count)', async () => {
    supa.calls = [];
    supa.result = { data: null, error: null };
    expect(await usage.isExemptOwner('owner-1')).toBe(false);
    supa.result = { data: null, error: { message: 'denied' } };
    expect(await usage.isExemptOwner('owner-1')).toBe(false);
    expect(supa.calls.filter(([name]) => name === 'from')).toEqual([
      ['from', 'platform_operators'],
      ['from', 'platform_operators'],
    ]);
  });
});
