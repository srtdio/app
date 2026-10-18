// Test site only: a small "Start fresh" pill on every screen (sign-in and
// sign-up carry their own button). One tap signs out and opens sign-up, the
// first page, so a run can restart from any point. Renders nothing elsewhere.
//
// Inside the app it sits in the top bar (inline), in line with the other
// controls, so it never covers one. Screens without the top bar (the pre-app
// onboarding screens) get the floating pill instead.

import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { isTestSite } from '@/lib/test-site';

const OWN_BUTTON = ['/signin', '/signup', '/test/'];

// How many top-bar pills are mounted: while one is, the floating pill hides.
let inlineCount = 0;
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function setInline(delta: number): void {
  inlineCount += delta;
  listeners.forEach((listener) => listener());
}
const inlineMounted = (): boolean => inlineCount > 0;

export function TestSiteAnywhereStart({
  inline = false,
}: {
  inline?: boolean;
}): ReactElement | null {
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  const shown = isTestSite() && pathname !== '/' && !OWN_BUTTON.some((p) => pathname.startsWith(p));
  const hasInline = useSyncExternalStore(subscribe, inlineMounted, inlineMounted);
  useEffect(() => {
    if (!inline || !shown) return;
    setInline(1);
    return () => setInline(-1);
  }, [inline, shown]);
  if (!shown || (!inline && hasInline)) return null;

  async function start(): Promise<void> {
    setBusy(true);
    // Signs out and opens sign-up, where Start fresh makes the new account. A
    // full load, so no screen keeps the previous account's state.
    await supabase.auth.signOut({ scope: 'local' });
    window.location.assign('/signup');
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy}
      aria-label="Start fresh with a new test account"
      className={cn(
        'flex min-h-[44px] shrink-0 items-center',
        inline
          ? 'px-0.5'
          : 'fixed left-1/2 top-[calc(env(safe-area-inset-top)+2px)] z-[2147483000] -translate-x-1/2 px-2',
      )}
    >
      <span className="whitespace-nowrap rounded-full border border-dashed border-accent bg-panel px-3 py-1 text-[11px] font-medium text-accent">
        {busy ? 'Starting' : 'Start fresh'}
      </span>
    </button>
  );
}
