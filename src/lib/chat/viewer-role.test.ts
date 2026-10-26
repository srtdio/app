import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  peekViewerSide,
  resetViewerSideCache,
  resolveViewerSide,
  actsOnBehalfOfClient,
  sideForRole,
} from '@/lib/chat/viewer-role';
import { fetchMemberRole } from '@/lib/assets';
import { readMemberRole } from '@/components/pages/pipeline/member-role';
import { readSharedMemberRole } from '@/lib/member-role';
import { resetSessionReads } from '@/lib/session-read';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';

// A workspace_members read that yields `role` (or an error) and counts calls.
function makeClient(result: { data: { role: string | null } | null; error: unknown }) {
  const from = vi.fn(() => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) b[method] = () => b;
    b.maybeSingle = () => Promise.resolve(result);
    return b;
  });
  return { client: { from } as unknown as Client, from };
}

beforeEach(() => {
  resetViewerSideCache();
  // The role read is session-shared (src/lib/member-role.ts): each test starts cold.
  resetSessionReads();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sideForRole', () => {
  it('maps client to client, owner/admin/agency to agency, null to unknown', () => {
    expect(sideForRole('client')).toBe('client');
    expect(sideForRole('owner')).toBe('agency');
    expect(sideForRole('admin')).toBe('agency');
    expect(sideForRole('agency')).toBe('agency');
    expect(sideForRole(null)).toBe('unknown');
  });
});

describe('resolveViewerSide', () => {
  it('reads the role once per workspace and user, sharing the in-flight read', async () => {
    const { client, from } = makeClient({ data: { role: 'client' }, error: null });
    const [a, b] = await Promise.all([
      resolveViewerSide(client, 'ws1', 'u1'),
      resolveViewerSide(client, 'ws1', 'u1'),
    ]);
    expect([a, b]).toEqual(['client', 'client']);
    expect(await resolveViewerSide(client, 'ws1', 'u1')).toBe('client');
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('workspace_members');
    expect(peekViewerSide('ws1', 'u1')).toBe('client');
  });

  it('caches per workspace', async () => {
    const { client, from } = makeClient({ data: { role: 'agency' }, error: null });
    await resolveViewerSide(client, 'ws1', 'u1');
    await resolveViewerSide(client, 'ws2', 'u1');
    expect(from).toHaveBeenCalledTimes(2);
    expect(peekViewerSide('ws2', 'u1')).toBe('agency');
  });

  it('does not cache a failed read (unknown), so the next mount retries', async () => {
    const { client, from } = makeClient({ data: null, error: { message: 'boom' } });
    expect(await resolveViewerSide(client, 'ws1', 'u1')).toBe('unknown');
    expect(peekViewerSide('ws1', 'u1')).toBeUndefined();
    await resolveViewerSide(client, 'ws1', 'u1');
    expect(from).toHaveBeenCalledTimes(2);
  });
});

describe('one shared role read (Pipeline, Post detail, Assets, Plan, chat)', () => {
  it('readMemberRole, fetchMemberRole and resolveViewerSide share one SELECT', async () => {
    const { client, from } = makeClient({ data: { role: 'agency' }, error: null });
    const [pipeline, assets, side] = await Promise.all([
      readMemberRole(client, 'ws1', 'u1'),
      fetchMemberRole(client, 'ws1', 'u1'),
      resolveViewerSide(client, 'ws1', 'u1'),
    ]);
    expect(pipeline).toEqual({ ok: true, role: 'agency' });
    expect(assets).toBe('agency');
    expect(side).toBe('agency');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('a role read elsewhere seeds the side: peek is ready with no request', async () => {
    const { client, from } = makeClient({ data: { role: 'client' }, error: null });
    expect(peekViewerSide('ws1', 'u1')).toBeUndefined();
    await readSharedMemberRole(client, 'ws1', 'u1');
    expect(peekViewerSide('ws1', 'u1')).toBe('client');
    expect(await resolveViewerSide(client, 'ws1', 'u1')).toBe('client');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('fetchMemberRole folds a failure into null; readMemberRole keeps it apart', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    expect(await fetchMemberRole(client, 'ws1', 'u1')).toBeNull();
    expect(await readMemberRole(client, 'ws1', 'u1')).toEqual({ ok: false });
  });

  it('a hung read times out at 5s and the next ask starts a new request', async () => {
    vi.useFakeTimers();
    const from = vi.fn(() => {
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq']) b[method] = () => b;
      b.maybeSingle = () => new Promise(() => {});
      return b;
    });
    const client = { from } as unknown as Client;
    let side: string | null = null;
    void resolveViewerSide(client, 'ws1', 'u1').then((s) => {
      side = s;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(side).toBe('unknown');
    void resolveViewerSide(client, 'ws1', 'u1');
    expect(from).toHaveBeenCalledTimes(2);
  });
});

describe('actsOnBehalfOfClient', () => {
  it('is true for the agency side only', () => {
    expect(actsOnBehalfOfClient('agency')).toBe(true);
    expect(actsOnBehalfOfClient('client')).toBe(false);
    expect(actsOnBehalfOfClient('unknown')).toBe(false);
  });
});
