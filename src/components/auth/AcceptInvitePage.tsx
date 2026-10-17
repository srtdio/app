import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AuthShell } from '@/components/auth/AuthShell';
import { withNext } from '@/components/auth/SignInPage';
import { Button } from '@/components/ui/Button';
import { RECOVERY_COPY } from '@/lib/induction-copy';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

// Friendly, code-free copy: the screen never parses server error codes.
export const ACCEPT_ERROR_MESSAGE =
  "This invitation couldn't be accepted. It may be invalid or already used.";

/**
 * Where an accepted invite lands. Creators and approvers both go to /pipeline,
 * which always opens on the Review stage (PipelinePage INITIAL_STAGE), so an
 * approver lands on review with no extra filter. An invite carries no post id
 * (it is a workspace_members row), so there is no /posts/{id} landing.
 */
export const INVITE_DESTINATION = '/pipeline';

/** Why an accept failed: the wrong signed-in person (403), an unknown invite (404), or anything else. */
export type AcceptFailure = 'wrong-account' | 'not-found' | 'generic';

/**
 * The HTTP status behind a supabase.functions.invoke error. A non-2xx answer is
 * a FunctionsHttpError whose context is the fetch Response; anything else
 * (network, relay) has no status and reads as 0.
 */
export function invokeErrorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('context' in error)) return 0;
  const context = (error as { context: unknown }).context;
  if (typeof context !== 'object' || context === null || !('status' in context)) return 0;
  const status = (context as { status: unknown }).status;
  return typeof status === 'number' ? status : 0;
}

/** Classify an invoke error by status; the screen never parses server error codes. */
export function classifyAcceptError(error: unknown): AcceptFailure {
  const status = invokeErrorStatus(error);
  if (status === 403) return 'wrong-account';
  if (status === 404) return 'not-found';
  return 'generic';
}

/** The sign-in path that returns to this invitation afterwards. */
export function inviteSignInPath(inviteId: string): string {
  return withNext('/signin', `/invite/accept/${encodeURIComponent(inviteId)}`);
}

/**
 * Wrong account: sign the current user out, then go to sign in with the
 * invitation as the destination. A failed sign-out is logged and the user is
 * still sent to sign in, so they are never stuck on this screen.
 */
export async function switchAccount(deps: {
  inviteId: string;
  signOut: () => Promise<{ error: unknown }>;
  navigate: (path: string) => void;
}): Promise<void> {
  try {
    const { error } = await deps.signOut();
    if (error !== null && error !== undefined) {
      logger.warn('invite_switch_account_signout_failed', { invite_id: deps.inviteId });
    }
  } catch {
    logger.warn('invite_switch_account_signout_failed', { invite_id: deps.inviteId });
  }
  deps.navigate(inviteSignInPath(deps.inviteId));
}

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
  onError: (failure: AcceptFailure) => void;
}): Promise<void> {
  const { error } = await deps.invoke('invite-accept', {
    body: { invite_id: deps.inviteId },
    headers: { 'x-trace-id': deps.traceId },
  });
  if (error !== null && error !== undefined) {
    deps.onError(classifyAcceptError(error));
    return;
  }
  deps.onSuccess();
}

/**
 * The failed-accept body. Wrong account explains the invite is for another
 * email and offers to sign in with it; not-found and generic keep the plain
 * message with retry and a way into the workspace.
 */
export function AcceptFailureView(props: {
  failure: AcceptFailure;
  submitting: boolean;
  actions: { retry: () => void; goToWorkspace: () => void; switchAccount: () => void };
}): ReactElement {
  if (props.failure === 'wrong-account') {
    return (
      <>
        <p className="text-sm text-bad">{RECOVERY_COPY.wrongAccount}</p>
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={props.actions.switchAccount}
        >
          {RECOVERY_COPY.differentEmail}
        </Button>
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-bad">{ACCEPT_ERROR_MESSAGE}</p>
      {/* Retry reuses the same accept path the mount effect runs. */}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={props.actions.retry}
        disabled={props.submitting}
      >
        Try again
      </Button>
      {/* Secondary path so an already-joined user is never stuck. */}
      <Button variant="default" size="lg" className="w-full" onClick={props.actions.goToWorkspace}>
        Go to your workspace
      </Button>
    </>
  );
}

export function AcceptInvitePage() {
  const navigate = useNavigate();
  // Path id is the canonical form (/invite/accept/:inviteId); the ?invite=
  // query is kept only for backward compatibility with older links.
  const { inviteId: paramId } = useParams();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('invite');
  const inviteId = (paramId ?? queryId ?? '').trim();
  // Auto-accept starts immediately on mount, so the in-flight state is the
  // initial render for a valid id (no extra click).
  const [submitting, setSubmitting] = useState(true);
  const [failure, setFailure] = useState<AcceptFailure | 'none'>('none');
  // One-shot guard: React strict mode double-invokes effects in dev, so the ref
  // keeps the accept from firing twice for a single mount.
  const startedRef = useRef(false);

  // Deliberate run, reused by both the mount auto-accept and the retry button.
  async function handleAccept(): Promise<void> {
    setFailure('none');
    setSubmitting(true);
    await acceptInvite({
      inviteId,
      traceId: crypto.randomUUID(),
      invoke: (name, options) => supabase.functions.invoke(name, options),
      onSuccess: () => navigate(INVITE_DESTINATION, { replace: true }),
      onError: (kind) => {
        setFailure(kind);
        setSubmitting(false);
      },
    });
  }

  // Auto-accept once the page mounts with a usable id.
  useEffect(() => {
    if (inviteId === '' || startedRef.current) return;
    startedRef.current = true;
    void handleAccept();
    // handleAccept is intentionally not a dependency; the ref guard makes this
    // run exactly once per valid id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteId]);

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

  return (
    <AuthShell
      title="Join a workspace on Sorted"
      subtitle="You've been invited to collaborate. Hang tight while we add you."
      footer={
        // The wrong-account body already offers the switch; no second link.
        failure === 'wrong-account' ? null : (
          <Link
            to="/signin"
            className="inline-flex min-h-[44px] items-center justify-center text-accent hover:underline"
          >
            Use a different account
          </Link>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {failure !== 'none' ? (
          <AcceptFailureView
            failure={failure}
            submitting={submitting}
            actions={{
              retry: () => void handleAccept(),
              goToWorkspace: () => navigate(INVITE_DESTINATION),
              switchAccount: () =>
                void switchAccount({
                  inviteId,
                  signOut: () => supabase.auth.signOut(),
                  navigate: (path) => navigate(path, { replace: true }),
                }),
            }}
          />
        ) : (
          <p className="text-sm text-fg-2">Joining your workspace…</p>
        )}
      </div>
    </AuthShell>
  );
}
