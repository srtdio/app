import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { EmailOtpType } from '@supabase/supabase-js';
import { ExpiredLinkView } from '@/components/auth/AuthCallbackPage';
import { AuthShell } from '@/components/auth/AuthShell';
import { withNext } from '@/components/auth/SignInPage';
import { Button, buttonClass } from '@/components/ui/Button';
import { dispatchSorted, SIGNOUT_EVENT } from '@/lib/events';
import { RECOVERY_COPY } from '@/lib/induction-copy';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

// Friendly, code-free copy: the screen never parses server error codes.
export const ACCEPT_ERROR_MESSAGE =
  "Couldn't accept this invitation. It may be invalid or already used.";

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

/**
 * The verifyOtp type for the invite email's token hash. invite-send mints it
 * with generateLink({ type: 'magiclink' }); supabase-js 2.105 still lists
 * 'magiclink' in EmailOtpType, but Auth treats it as the deprecated alias of
 * 'email', which is what a magic-link token hash verifies as today.
 */
export const INVITE_OTP_TYPE: EmailOtpType = 'email';

/** True when the URL hash carries an Auth error (a consumed or expired verify link). */
export function hasAuthErrorHash(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.has('error_code') || params.has('error');
}

/** Router state that tells RequireGuest not to bounce an account switch back here. */
export const SWITCH_ACCOUNT_STATE = { switchAccount: true } as const;

/** The sign-in path that returns to this invitation afterwards. */
export function inviteSignInPath(inviteId: string): string {
  return withNext('/signin', `/invite/accept/${encodeURIComponent(inviteId)}`);
}

/**
 * Wrong account: sign the current user out, then go to sign in with the
 * invitation as the destination. A failed sign-out is logged and the user is
 * still sent to sign in, so they are never stuck on this screen. The page
 * signs out with the shell's sorted:signout event (signOutViaEvent).
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

/** Sign out the existing way: the SessionProvider listens for sorted:signout. */
export async function signOutViaEvent(): Promise<{ error: unknown }> {
  dispatchSorted(SIGNOUT_EVENT);
  return { error: null };
}

/**
 * The Join tap. A signed-in user goes straight to accept (a wrong account gets
 * the 403 view); a signed-out user verifies the email's token hash first, and a
 * failed verify (consumed or expired) is the expired view. Nothing here runs
 * until the tap, so a mail scanner opening the link signs nobody in.
 */
export async function joinWithTokenHash(deps: {
  tokenHash: string;
  hasSession: () => Promise<boolean>;
  verifyOtp: (params: { token_hash: string; type: EmailOtpType }) => Promise<{ error: unknown }>;
  accept: () => Promise<void>;
  onExpired: () => void;
}): Promise<void> {
  if (!(await deps.hasSession())) {
    let failed = false;
    try {
      const { error } = await deps.verifyOtp({ token_hash: deps.tokenHash, type: INVITE_OTP_TYPE });
      failed = error !== null && error !== undefined;
    } catch {
      failed = true;
    }
    if (failed) {
      deps.onExpired();
      return;
    }
  }
  await deps.accept();
}

/** "Join {workspace}" for the button; a link without the name reads "Join workspace". */
export function joinLabel(workspace: string): string {
  return workspace === '' ? 'Join workspace' : `Join ${workspace}`;
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
        <p className="text-base text-bad">{RECOVERY_COPY.wrongAccount}</p>
        <Button variant="primary" className="w-full" onClick={props.actions.switchAccount}>
          {RECOVERY_COPY.differentEmail}
        </Button>
      </>
    );
  }
  return (
    <>
      <p className="text-base text-bad">{ACCEPT_ERROR_MESSAGE}</p>
      {/* Retry reuses the same accept path the mount effect runs. */}
      <Button
        variant="primary"
        className="w-full"
        onClick={props.actions.retry}
        disabled={props.submitting}
      >
        Try again
      </Button>
      {/* Secondary path so an already-joined user is never stuck. */}
      <Button variant="default" className="w-full" onClick={props.actions.goToWorkspace}>
        Go to your workspace
      </Button>
    </>
  );
}

export function AcceptInvitePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // Path id is the canonical form (/invite/accept/:inviteId); the ?invite=
  // query is kept only for backward compatibility with older links.
  const { inviteId: paramId } = useParams();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('invite');
  const inviteId = (paramId ?? queryId ?? '').trim();
  // The invite email's token hash, plus the names it carries for the Join card
  // (the page cannot read the workspace before the invitee is signed in).
  const tokenHash = (searchParams.get('th') ?? '').trim();
  const workspaceName = (searchParams.get('ws') ?? '').trim();
  const inviterName = (searchParams.get('by') ?? '').trim();
  const tapToJoin = tokenHash !== '';
  const hashExpired = hasAuthErrorHash(location.hash);
  // Auto-accept starts immediately on mount for a plain link, so the in-flight
  // state is the initial render for a valid id. A token-hash link waits for Join.
  const [submitting, setSubmitting] = useState(!tapToJoin && !hashExpired);
  const [failure, setFailure] = useState<AcceptFailure | 'none'>('none');
  const [expired, setExpired] = useState(hashExpired);
  // One-shot guard: React strict mode double-invokes effects in dev, so the ref
  // keeps the accept from firing twice for a single mount.
  const startedRef = useRef(false);

  // Deliberate run, reused by the mount auto-accept, Join, and the retry button.
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

  async function handleJoin(): Promise<void> {
    setFailure('none');
    setSubmitting(true);
    await joinWithTokenHash({
      tokenHash,
      hasSession: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session !== null;
      },
      verifyOtp: (params) => supabase.auth.verifyOtp(params),
      accept: handleAccept,
      onExpired: () => {
        logger.warn('invite_verify_failed', { invite_id: inviteId });
        setExpired(true);
        setSubmitting(false);
      },
    });
  }

  const differentAccount = (): void =>
    void switchAccount({
      inviteId,
      signOut: signOutViaEvent,
      navigate: (path) => navigate(path, { replace: true, state: SWITCH_ACCOUNT_STATE }),
    });

  // Auto-accept once the page mounts with a usable id and no token hash.
  useEffect(() => {
    if (inviteId === '' || tapToJoin || hashExpired || startedRef.current) return;
    startedRef.current = true;
    void handleAccept();
    // handleAccept is intentionally not a dependency; the ref guard makes this
    // run exactly once per valid id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteId]);

  // No id in the link: explain and bounce to sign in. Never call the function.
  if (inviteId === '') {
    return (
      <AuthShell title="Invite link" subtitle="Couldn't read this invitation." footer={null}>
        <div className="flex flex-col gap-4">
          <p className="text-base text-bad">This invite link is invalid.</p>
          <Link to="/signin" className={buttonClass('primary', 'default', 'w-full')}>
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  // Consumed or expired link (#error_code=otp_expired, or a failed verify).
  if (expired) {
    return (
      <ExpiredLinkView
        next={`/invite/accept/${encodeURIComponent(inviteId)}`}
        inviter={inviterName}
        footer={null}
      />
    );
  }

  const footer =
    // The wrong-account body already offers the switch; no second link.
    failure === 'wrong-account' ? null : (
      <Button type="button" onClick={differentAccount} variant="link" className="hover:underline">
        Use a different account
      </Button>
    );

  const failureView =
    failure !== 'none' ? (
      <AcceptFailureView
        failure={failure}
        submitting={submitting}
        actions={{
          retry: () => void (tapToJoin ? handleJoin() : handleAccept()),
          goToWorkspace: () => navigate(INVITE_DESTINATION),
          switchAccount: differentAccount,
        }}
      />
    ) : null;

  if (tapToJoin) {
    const subtitle =
      inviterName !== '' && workspaceName !== ''
        ? `${inviterName} invited you to ${workspaceName} on Sorted.`
        : "You've been invited to collaborate on Sorted.";
    return (
      <AuthShell title={joinLabel(workspaceName)} subtitle={subtitle} footer={footer}>
        <div className="flex flex-col gap-4">
          {failureView ?? (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void handleJoin()}
              disabled={submitting}
            >
              {submitting ? 'Joining' : joinLabel(workspaceName)}
            </Button>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Join a workspace on Sorted"
      subtitle="You've been invited to collaborate. Hang tight while we add you."
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {failureView ?? <p className="text-base text-fg-2">Joining your workspace…</p>}
      </div>
    </AuthShell>
  );
}
