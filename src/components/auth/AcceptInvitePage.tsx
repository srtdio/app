import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';

// Friendly, code-free copy: the screen never parses server error codes.
export const ACCEPT_ERROR_MESSAGE =
  "This invitation couldn't be accepted. It may be invalid or already used.";

// Minimal structural shape of the invite-accept invoke. Kept narrow so the pure
// helper can be unit-tested with a plain mock; supabase.functions.invoke is
// assignable to it. The screen lives outside TraceProvider, so the trace id is
// generated at the call site and passed in, never read from a context.
interface InvokeResult {
  error: unknown;
}
type InvokeInviteAccept = (
  name: 'invite-accept',
  options: { body: { invite_id: string }; headers: { 'x-trace-id': string } },
) => Promise<InvokeResult>;

/**
 * Pure accept step: POST { invite_id } to the deployed invite-accept function
 * with the trace id on x-trace-id, then branch on the returned error. No state,
 * no router, no supabase import, so it is testable in isolation.
 */
export async function acceptInvite(deps: {
  inviteId: string;
  traceId: string;
  invoke: InvokeInviteAccept;
  onSuccess: () => void;
  onError: () => void;
}): Promise<void> {
  const { error } = await deps.invoke('invite-accept', {
    body: { invite_id: deps.inviteId },
    headers: { 'x-trace-id': deps.traceId },
  });
  if (error !== null && error !== undefined) {
    deps.onError();
    return;
  }
  deps.onSuccess();
}

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteId = (searchParams.get('invite') ?? '').trim();
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  // No id in the link: explain and bounce to sign in. Never call the function.
  if (inviteId === '') {
    return (
      <AuthShell title="Invite link" subtitle="We couldn't read this invitation." footer={null}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-bad">This invite link is invalid.</p>
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  // Deliberate click only; never auto-accept on mount.
  async function handleAccept(): Promise<void> {
    setFailed(false);
    setSubmitting(true);
    await acceptInvite({
      inviteId,
      traceId: crypto.randomUUID(),
      invoke: (name, options) => supabase.functions.invoke(name, options),
      onSuccess: () => navigate('/pipeline', { replace: true }),
      onError: () => {
        setFailed(true);
        setSubmitting(false);
      },
    });
  }

  return (
    <AuthShell
      title="Join a workspace on Sorted"
      subtitle="You've been invited to collaborate. Accept to get started."
      footer={
        <Link
          to="/signin"
          className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
        >
          Use a different account
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {failed ? (
          <>
            <p className="text-sm text-bad">{ACCEPT_ERROR_MESSAGE}</p>
            {/* Secondary path so an already-joined user is never stuck. */}
            <Button
              variant="default"
              size="lg"
              className="w-full"
              onClick={() => navigate('/pipeline')}
            >
              Go to your workspace
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleAccept}
            disabled={submitting}
          >
            {submitting ? 'Accepting' : 'Accept invitation'}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}
