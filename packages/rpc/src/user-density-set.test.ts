import { describe, expect, it, vi } from 'vitest';
import { userDensitySet, type Client } from './index';

describe('userDensitySet', () => {
  it('one call to user_density_set with p_density and p_trace_id', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'u1', error: null }));
    const result = await userDensitySet({ rpc } as unknown as Client, {
      p_density: 'calm',
      p_trace_id: 't',
    });
    expect(result).toEqual({ ok: true, data: 'u1' });
    expect(rpc).toHaveBeenCalledWith('user_density_set', { p_density: 'calm', p_trace_id: 't' });
  });

  it('maps invalid_payload', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: 'invalid_payload' } }));
    const result = await userDensitySet({ rpc } as unknown as Client, {
      p_density: 'cozy',
      p_trace_id: 't',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });
});
