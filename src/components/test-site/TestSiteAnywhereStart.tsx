// Test site only: a small "Start fresh" pill on every screen (sign-in and
// sign-up carry their own button). One tap signs out, makes a brand-new test
// account and reloads at the start of onboarding, so a run can restart from
// any point. Renders nothing anywhere else.

import { useState, type ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { isTestSite, startTestSession } from '@/lib/test-site';

const OWN_BUTTON = ['/signin', '/signup', '/test/'];

export function TestSiteAnywhereStart(): ReactElement | null {
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  if (!isTestSite() || pathname === '/' || OWN_BUTTON.some((p) => pathname.startsWith(p))) {
    return null;
  }

  async function start(): Promise<void> {
    setBusy(true);
    try {
      await startTestSession(null);
      // A full load, so no screen keeps the previous account's state.
      window.location.assign('/chat');
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy}
      aria-label="Start fresh with a new test account"
      className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+2px)] z-[2147483000] flex min-h-[44px] -translate-x-1/2 items-center px-2"
    >
      <span className="rounded-full border border-dashed border-accent bg-panel/90 px-3 py-1 text-[11px] font-medium text-accent shadow-sm">
        {busy ? 'Starting' : 'Start fresh'}
      </span>
    </button>
  );
}
