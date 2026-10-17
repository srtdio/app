// Test site only: a "Start fresh" button above sign-in and sign-up. One tap makes a
// brand-new throwaway account (no email) and opens the app at the start of
// onboarding. Renders nothing anywhere else.

import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Link } from 'react-router-dom';
import { isTestSite, readTestInvitees, startTestSession, testInviteePath } from '@/lib/test-site';

export function TestSiteStart(): ReactElement | null {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitees] = useState(readTestInvitees);
  if (!isTestSite()) return null;

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await startTestSession(null);
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md border border-dashed border-accent p-3">
      <p className="text-xs text-fg-2">
        Test site: a new throwaway account, no email. It is deleted after 24 hours.
      </p>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy ? 'Starting' : 'Start fresh'}
      </Button>
      {error !== null ? <p className="text-sm text-bad">{error}</p> : null}
      {invitees.length > 0 ? (
        <div className="flex flex-col gap-1 pt-1">
          <p className="text-xs text-fg-2">Or open an invite you sent from this browser:</p>
          {invitees.map((invitee) => (
            <Link
              key={invitee.email}
              to={testInviteePath(invitee.email)}
              className="inline-flex min-h-[44px] items-center text-sm font-medium text-accent hover:underline"
            >
              Open as {invitee.email}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
