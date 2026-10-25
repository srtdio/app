// @vitest-environment jsdom
// The server clock's only feed: SessionProvider's one onAuthStateChange
// subscriber hands every auth event and its access token to noteAuthToken
// (src/lib/chat/bounded-window.ts), which decides what counts as fresh.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

const { auth, noteAuthToken } = vi.hoisted(() => ({
  auth: { listener: null as AuthListener | null },
  noteAuthToken: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: (cb: AuthListener) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      signOut: async () => ({ error: null }),
    },
  },
}));
vi.mock('@/lib/chat/bounded-window', () => ({ noteAuthToken }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { SessionProvider } from '@/lib/session-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  auth.listener = null;
  noteAuthToken.mockClear();
});

function session(token: string): Session {
  return { user: { id: 'u1' }, access_token: token, refresh_token: 'r' } as unknown as Session;
}

describe('SessionProvider feeds the server clock', () => {
  it('calls noteAuthToken(event, access_token) for every auth event, in order', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <SessionProvider>
          <span />
        </SessionProvider>,
      );
    });
    const listener = auth.listener;
    expect(listener).not.toBeNull();
    if (listener === null) return;
    act(() => {
      listener('SIGNED_IN', session('tok-stored'));
      listener('INITIAL_SESSION', session('tok-stored'));
      listener('TOKEN_REFRESHED', session('tok-fresh'));
      listener('SIGNED_OUT', null);
    });
    expect(noteAuthToken.mock.calls).toEqual([
      ['SIGNED_IN', 'tok-stored'],
      ['INITIAL_SESSION', 'tok-stored'],
      ['TOKEN_REFRESHED', 'tok-fresh'],
      ['SIGNED_OUT', undefined],
    ]);
  });
});
