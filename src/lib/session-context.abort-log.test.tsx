// @vitest-environment jsdom
// A getSession aborted because the tab is closing ("browsing context is going
// away") is harmless and never logged (Sentry FRONTEND-C); any other failure
// still logs an error. The fail / sign-in flow is unchanged.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
type GetSession = () => Promise<{ data: { session: Session | null }; error: unknown }>;

const { auth } = vi.hoisted(() => ({
  auth: {
    listener: null as AuthListener | null,
    getSession: null as GetSession | null,
    calls: 0,
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => {
        auth.calls += 1;
        return (auth.getSession as GetSession)();
      },
      onAuthStateChange: (cb: AuthListener) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      signOut: async () => ({ error: null }),
    },
  },
}));
vi.mock('@/lib/chat/bounded-window', () => ({ noteAuthToken: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { isClosingTabAbort, SessionProvider } from '@/lib/session-context';
import { RequireAuth } from '@/components/auth/RouteGuards';
import { logger } from '@/lib/logger';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORED_KEY = 'sb-test-auth-token';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <SessionProvider>
          <Routes>
            <Route path="/signin" element={<p>SIGNIN</p>} />
            <Route element={<RequireAuth />}>
              <Route path="/pipeline" element={<p>APP</p>} />
            </Route>
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function closingTabAbort(): Error {
  const error = new Error('Promise was rejected because the browsing context is going away');
  error.name = 'AbortError';
  return error;
}

const sessionErrors = (): number =>
  vi.mocked(logger.error).mock.calls.filter(([msg]) => msg === 'getSession failed').length;
const text = (): string => host?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(logger.error).mockClear();
  auth.listener = null;
  auth.calls = 0;
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  vi.useRealTimers();
});

describe('isClosingTabAbort', () => {
  it('only the closing-tab AbortError', () => {
    expect(isClosingTabAbort(closingTabAbort())).toBe(true);
    expect(isClosingTabAbort(new DOMException('The operation was aborted.', 'AbortError'))).toBe(
      false,
    );
    expect(isClosingTabAbort(new Error('browsing context is going away'))).toBe(false);
    expect(isClosingTabAbort(null)).toBe(false);
    expect(isClosingTabAbort('AbortError')).toBe(false);
  });
});

describe('getSession failure logging', () => {
  it('a closing-tab abort logs nothing; no stored session still goes to /signin', async () => {
    auth.getSession = () => Promise.reject(closingTabAbort());
    await mount();
    expect(sessionErrors()).toBe(0);
    expect(text()).toContain('SIGNIN');
  });

  it('a closing-tab abort returned as error logs nothing', async () => {
    localStorage.setItem(STORED_KEY, JSON.stringify({ user: { id: 'u1' } }));
    auth.getSession = async () => ({ data: { session: null }, error: closingTabAbort() });
    await mount();
    expect(sessionErrors()).toBe(0);
    expect(auth.calls).toBe(1);
  });

  it('any other failure still logs an error', async () => {
    auth.getSession = () => Promise.reject(new Error('TypeError: Failed to fetch'));
    await mount();
    expect(sessionErrors()).toBe(1);
  });
});
