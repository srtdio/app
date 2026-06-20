import { describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { performSignout, resolveSession } from './session-context';

// A stand-in for the GoTrue session; only identity matters to these assertions.
const aSession = {
  user: { id: 'u1' },
  access_token: 'a',
  refresh_token: 'r',
} as unknown as Session;

// Mirror the onAuthStateChange callback the provider registers: each event is
// reduced against the current session, exactly as setSession's functional
// update does inside SessionProvider.
function makeHandler(initial: Session | null) {
  let current = initial;
  return {
    invoke(event: AuthChangeEvent, next: Session | null): void {
      current = resolveSession(event, next, current);
    },
    get session(): Session | null {
      return current;
    },
  };
}

describe('onAuthStateChange session reducer', () => {
  it('does NOT clear a live session on a transient null (TOKEN_REFRESHED hiccup)', () => {
    const h = makeHandler(aSession);
    h.invoke('TOKEN_REFRESHED', null);
    expect(h.session).toBe(aSession);
  });

  it('clears the session on an explicit SIGNED_OUT', () => {
    const h = makeHandler(aSession);
    h.invoke('SIGNED_OUT', null);
    expect(h.session).toBeNull();
  });

  it('treats a null INITIAL_SESSION at boot as genuinely logged out', () => {
    const h = makeHandler(null);
    h.invoke('INITIAL_SESSION', null);
    expect(h.session).toBeNull();
  });

  it('adopts a truthy next session', () => {
    const h = makeHandler(null);
    h.invoke('SIGNED_IN', aSession);
    expect(h.session).toBe(aSession);
  });
});

describe('performSignout', () => {
  it('signs out this device only (local scope)', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { signOut } } as unknown as SupabaseClient;
    await performSignout(client);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('resolves without throwing when signOut returns an error', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: { message: 'boom' } });
    const client = { auth: { signOut } } as unknown as SupabaseClient;
    await expect(performSignout(client)).resolves.toBeUndefined();
  });
});
