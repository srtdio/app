import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';

export type InviteRole = 'admin' | 'agency' | 'client';

// Friendly, code-free copy: the form never parses server error codes; the
// edge function is the authoritative check on email / role / membership.
export const INVITE_ERROR_MESSAGE =
  "Couldn't send the invitation. Check the email and that you have permission to invite, then try again.";

// Minimal structural shape of the invite-send invoke. Kept narrow so the pure
// helper unit-tests with a plain mock; supabase.functions.invoke is assignable.
interface InvokeResult {
  error: unknown;
}
type InvokeInviteSend = (
  name: 'invite-send',
  options: {
    body: { workspace_id: string; email: string; role: InviteRole };
    headers: { 'x-trace-id': string };
  },
) => Promise<InvokeResult>;

// supabase-js surfaces a failed invoke as a FunctionsHttpError whose `context`
// is the raw Response. The edge function answers { error, error_detail, trace_id }
// on failure, so we read that body to show the real reason instead of a constant.
interface InvokeErrorWithContext {
  context: { json: () => Promise<unknown> };
}

function hasResponseContext(value: unknown): value is InvokeErrorWithContext {
  if (typeof value !== 'object' || value === null || !('context' in value)) return false;
  const context = (value as { context: unknown }).context;
  return (
    typeof context === 'object' &&
    context !== null &&
    'json' in context &&
    typeof (context as { json: unknown }).json === 'function'
  );
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Best-effort read of the structured failure body. Returns a user-facing message
 * built from error_detail (plus trace_id when present), or null when no JSON body
 * with a detail can be read so the caller can fall back to the generic copy.
 */
async function readInviteErrorDetail(error: unknown): Promise<string | null> {
  if (!hasResponseContext(error)) return null;
  let body: unknown;
  try {
    body = await error.context.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const detail = readString(record, 'error_detail');
  if (detail === undefined) return null;
  const traceId = readString(record, 'trace_id');
  return traceId !== undefined
    ? `Invite failed: ${detail} (trace ${traceId})`
    : `Invite failed: ${detail}`;
}

/**
 * Pure send step: POST { workspace_id, email, role } to the deployed invite-send
 * function with the trace id on x-trace-id, then branch on the returned error.
 * No state, no router, no supabase import, so it is testable in isolation.
 */
export async function sendInvite(deps: {
  workspaceId: string;
  email: string;
  role: InviteRole;
  traceId: string;
  invoke: InvokeInviteSend;
  onSuccess: () => void;
  onError: (detail: string | null) => void;
}): Promise<void> {
  const { error } = await deps.invoke('invite-send', {
    body: { workspace_id: deps.workspaceId, email: deps.email, role: deps.role },
    headers: { 'x-trace-id': deps.traceId },
  });
  if (error !== null && error !== undefined) {
    deps.onError(await readInviteErrorDetail(error));
    return;
  }
  deps.onSuccess();
}

const ROLE_OPTIONS: SelectOption[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'agency', label: 'Agency (team member)' },
  { value: 'client', label: 'Client (reviewer)' },
];

function isInviteRole(value: string): value is InviteRole {
  return value === 'admin' || value === 'agency' || value === 'client';
}

export function MembersInviteForm() {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('client');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // No active workspace: there is nothing to invite into. Say so and stop.
  if (workspaceId === null) {
    return <p className="text-sm text-fg-3">No active workspace.</p>;
  }
  // Capture the narrowed id so the async submit closure keeps the string type.
  const activeWorkspaceId = workspaceId;

  const trimmed = email.trim();
  // Light client guard; the function does the authoritative email check.
  const canSubmit = !submitting && trimmed.length > 0 && trimmed.includes('@');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const target = trimmed;
    setSubmitting(true);
    setSentTo(null);
    setErrorMessage(null);
    await sendInvite({
      workspaceId: activeWorkspaceId,
      email: target,
      role,
      traceId: newTrace(),
      invoke: (name, options) => supabase.functions.invoke(name, options),
      onSuccess: () => {
        // Clear the email so another can be sent; keep the selected role.
        setEmail('');
        setSentTo(target);
        setSubmitting(false);
      },
      onError: (detail) => {
        // Keep the email so the user can retry. Prefer the function's real
        // reason; fall back to the generic copy when no body could be read.
        setErrorMessage(detail ?? INVITE_ERROR_MESSAGE);
        setSubmitting(false);
      },
    });
  }

  return (
    <form className="max-w-[520px] flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field label="Email" htmlFor="invite-email" required>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          autoComplete="off"
        />
      </Field>
      <Field label="Role" htmlFor="invite-role">
        <Select
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(value) => {
            if (isInviteRole(value)) setRole(value);
          }}
        />
      </Field>
      <div>
        <Button variant="primary" size="lg" type="submit" disabled={!canSubmit}>
          {submitting ? 'Sending' : 'Send invite'}
        </Button>
      </div>
      {sentTo !== null ? <p className="text-sm text-good">Invitation sent to {sentTo}.</p> : null}
      {errorMessage !== null ? <p className="text-sm text-bad">{errorMessage}</p> : null}
    </form>
  );
}
