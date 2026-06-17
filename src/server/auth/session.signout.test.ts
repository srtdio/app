import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signOut } from './session';

// Regression: user-initiated logout must revoke only the current device. A
// 'global' scope here would silently sign the user out of every device.
describe('signOut', () => {
  it('calls GoTrue logout with { scope: "local" }', async () => {
    const setSession = vi.fn().mockResolvedValue({ error: null });
    const signOutSpy = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { setSession, signOut: signOutSpy },
    } as unknown as SupabaseClient;

    const res = await signOut(client, { accessToken: 'a', refreshToken: 'r' }, 'trace-signout');

    expect(res.ok).toBe(true);
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(signOutSpy).toHaveBeenCalledWith({ scope: 'local' });
  });
});
