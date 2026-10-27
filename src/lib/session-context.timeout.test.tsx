// @vitest-environment jsdom
// The boot session read with a ceiling: a hung or failed getSession while this
// device holds a stored session shows "Couldn't load. Try again." and never
// routes to /signin; with no stored session, /signin as before.
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

import { SESSION_WAIT_MS, SessionProvider } from '@/lib/session-context';
import { LOAD_FAILED_TEXT, RequireAuth } from '@/components/auth/RouteGuards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORED_KEY = 'sb-test-auth-token';
const aSession = {
  user: { id: 'u1' },
  access_token: 'a',
  refresh_token: 'r',
} as unknown as Session;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function tapTryAgain(): Promise<void> {
  const button = Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent === 'Try again',
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const text = (): string => host?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
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

describe('session gate with a stored session', () => {
  beforeEach(() => {
    localStorage.setItem(STORED_KEY, JSON.stringify({ user: { id: 'u1' } }));
  });

  it('a hung getSession shows Try again at SESSION_WAIT_MS, never /signin', async () => {
    auth.getSession = () => new Promise(() => undefined);
    await mount();
    expect(text()).toContain('Loading');

    await advance(SESSION_WAIT_MS - 1);
    expect(text()).toContain('Loading');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);

    await advance(1);
    expect(text()).toContain(LOAD_FAILED_TEXT);
    expect(text()).not.toContain('SIGNIN');
  });

  it('a timed-out refresh and its null INITIAL_SESSION fail, never sign out', async () => {
    auth.getSession = async () => ({
      data: { session: null },
      error: { name: 'AuthRetryableFetchError', message: 'TimeoutError' },
    });
    await mount();
    await act(async () => auth.listener?.('INITIAL_SESSION', null));
    await advance(0);

    expect(text()).toContain(LOAD_FAILED_TEXT);
    expect(text()).not.toContain('SIGNIN');
  });

  it('Try again re-runs getSession; its answer opens the app', async () => {
    auth.getSession = () => new Promise(() => undefined);
    await mount();
    await advance(SESSION_WAIT_MS);
    expect(text()).toContain(LOAD_FAILED_TEXT);

    auth.getSession = async () => ({ data: { session: aSession }, error: null });
    await tapTryAgain();

    expect(auth.calls).toBe(2);
    expect(text()).toContain('APP');
  });

  it('a late answer from the read Try again replaced is dropped', async () => {
    const first = deferred<{ data: { session: Session | null }; error: unknown }>();
    auth.getSession = () => first.promise;
    await mount();
    await advance(SESSION_WAIT_MS);

    auth.getSession = async () => ({ data: { session: aSession }, error: null });
    await tapTryAgain();
    expect(text()).toContain('APP');

    // The first read finally fails: the newer answer stays.
    await act(async () => first.resolve({ data: { session: null }, error: new Error('late') }));
    await advance(0);
    expect(text()).toContain('APP');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
  });

  it('a real SIGNED_OUT still goes to /signin', async () => {
    auth.getSession = () => new Promise(() => undefined);
    await mount();
    await advance(SESSION_WAIT_MS);
    expect(text()).toContain(LOAD_FAILED_TEXT);

    localStorage.removeItem(STORED_KEY);
    await act(async () => auth.listener?.('SIGNED_OUT', null));
    expect(text()).toContain('SIGNIN');
  });
});

describe('session gate with no stored session', () => {
  it('goes to /signin as today', async () => {
    auth.getSession = async () => ({ data: { session: null }, error: null });
    await mount();
    await advance(0);
    expect(text()).toContain('SIGNIN');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
  });
});
