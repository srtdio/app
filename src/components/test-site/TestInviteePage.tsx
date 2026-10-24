// Test site only: /test/invitee/:email signs in as a pending test invitee (no
// email) and hands over to the normal invite accept screen.

import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { isTestEmail, isTestSite, startTestSession } from '@/lib/test-site';

export function TestInviteePage(): ReactElement {
  const navigate = useNavigate();
  const { email = '' } = useParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTestSite() || !isTestEmail(email)) {
      setError('This link only works on the test site, for a test address.');
      return;
    }
    let cancelled = false;
    void startTestSession(email)
      .then((inviteId) => {
        if (cancelled) return;
        navigate(inviteId !== null ? `/invite/accept/${inviteId}` : '/chat', { replace: true });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [email, navigate]);

  return (
    <AuthShell title="Opening the invite" subtitle={`Signing in as ${email}.`} footer={null}>
      {error !== null ? <p className="text-legacy-sm text-bad">{error}</p> : null}
    </AuthShell>
  );
}
