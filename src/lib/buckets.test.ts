import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { bucketCreateErrorMessage, createBucket, shapeBuckets } from '@/lib/buckets';

// The query already filters + orders, but shapeBuckets re-applies both so the
// archived filter and position sort are guaranteed regardless of how the rows
// arrive. Exercised directly on the pure helper, no database needed.

interface Raw {
  id: string;
  name: string;
  color_hex: string;
  position: number;
  archived: boolean;
}

function row(over: Partial<Raw>): Raw {
  return { id: 'b', name: 'Bucket', color_hex: '#5e6ad2', position: 0, archived: false, ...over };
}

describe('shapeBuckets', () => {
  it('orders by position ascending and flattens to options', () => {
    const out = shapeBuckets([
      row({ id: 'b2', name: 'Second', position: 2, color_hex: '#111111' }),
      row({ id: 'b0', name: 'First', position: 0, color_hex: '#222222' }),
      row({ id: 'b1', name: 'Middle', position: 1, color_hex: '#333333' }),
    ]);
    expect(out.map((b) => b.id)).toEqual(['b0', 'b1', 'b2']);
    expect(out[0]).toEqual({ id: 'b0', name: 'First', colorHex: '#222222', position: 0 });
  });

  it('drops archived buckets defensively', () => {
    const out = shapeBuckets([
      row({ id: 'live', archived: false }),
      row({ id: 'gone', archived: true }),
    ]);
    expect(out.map((b) => b.id)).toEqual(['live']);
  });

  it('returns an empty array when there are no rows', () => {
    expect(shapeBuckets([])).toEqual([]);
  });
});

describe('createBucket', () => {
  function fakeClient(rpc: { data: unknown; error: { message: string } | null }): {
    client: Client;
    rpcSpy: ReturnType<typeof vi.fn>;
  } {
    const rpcSpy = vi.fn(async () => rpc);
    const single = async () => ({
      data: { id: 'b9', name: 'Launch', color_hex: '#123456', position: 4, archived: false },
      error: null,
    });
    const chain = { select: () => chain, eq: () => chain, single };
    const client = { rpc: rpcSpy, from: () => chain } as unknown as Client;
    return { client, rpcSpy };
  }

  it('calls workspace_bucket_create with an explicit p_trace_id and returns the new option', async () => {
    const { client, rpcSpy } = fakeClient({ data: 'b9', error: null });
    const res = await createBucket(client, 'ws-1', '  Launch ', 'trace-7');
    expect(rpcSpy).toHaveBeenCalledWith('workspace_bucket_create', {
      p_workspace_id: 'ws-1',
      p_name: 'Launch',
      p_trace_id: 'trace-7',
    });
    expect(res).toEqual({
      ok: true,
      data: { id: 'b9', name: 'Launch', colorHex: '#123456', position: 4 },
    });
  });

  it('maps errors to friendly copy and never shows raw text', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'name_taken' } });
    const res = await createBucket(client, 'ws-1', 'Launch', 't');
    expect(res.ok ? null : res.error.message).toBe("That name's already taken.");
    expect(bucketCreateErrorMessage('invalid_name')).toBe('Use 1 to 40 characters.');
    expect(bucketCreateErrorMessage('permission denied for function')).toBe(
      "Couldn't create the bucket. Try again.",
    );
  });
});
