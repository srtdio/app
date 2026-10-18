import { useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { FREE_MAIL_APPROVER_MESSAGE } from './members-data';
import { dispatchInductionRefresh, INDUCTION_KEYS } from '@/lib/induction';
import {
  isTestEmail,
  isTestSite,
  rememberTestInvitee,
  testAddress,
  testInviteePath,
} from '@/lib/test-site';

export type InviteRole = 'admin' | 'agency' | 'client';

// Friendly, code-free copy: the form never parses server error codes; the
// edge function is the authoritative check on email / role / membership.
export const INVITE_ERROR_MESSAGE =
  "Couldn't send the invitation. Check the email and that you have permission to invite, then try again.";
export const INVITE_INVALID_EMAIL_MESSAGE = 'Enter a valid email address.';
const INVITE_DUPLICATE_EMAIL_MESSAGE = 'That email is already on the invite list.';

const emailFormat = z.string().email();

function hasValidEmailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const labels = domain.split('.');
  const topLevelDomain = labels.at(-1) ?? '';
  const isValidLabel = (label: string) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);

  return (
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every(isValidLabel) &&
    (/^[a-z]{2,}$/.test(topLevelDomain) || /^xn--[a-z0-9-]{2,}$/.test(topLevelDomain))
  );
}

export function isValidInviteEmail(email: string): boolean {
  const trimmed = email.trim();
  return emailFormat.safeParse(trimmed).success && hasValidEmailDomain(trimmed);
}

export function parseInviteEmails(value: string): {
  emails: string[];
  invalid: string[];
} {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const token of value.split(/[,\s;]+/).filter(Boolean)) {
    if (!isValidInviteEmail(token)) {
      invalid.push(token);
      continue;
    }
    const email = token.trim().toLowerCase();
    if (!seen.has(email)) {
      emails.push(email);
      seen.add(email);
    }
  }

  return { emails, invalid };
}

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

/** The invite-check codes the form words itself instead of echoing the detail. */
export type InviteErrorCode = 'free_mail_client' | 'client_domain_mismatch';

function inviteErrorCode(value: string | undefined): InviteErrorCode | null {
  return value === 'free_mail_client' || value === 'client_domain_mismatch' ? value : null;
}

/**
 * Best-effort read of the structured failure body. Returns the mapped code (see
 * InviteErrorCode) and a user-facing message: the approver copy for a free mail
 * address, otherwise one built from error_detail (plus trace_id when present).
 * message is null when no JSON body with a detail can be read so the caller can
 * fall back to the generic copy.
 */
async function readInviteError(
  error: unknown,
): Promise<{ code: InviteErrorCode | null; message: string | null }> {
  const none = { code: null, message: null };
  if (!hasResponseContext(error)) return none;
  let body: unknown;
  try {
    body = await error.context.json();
  } catch {
    return none;
  }
  if (typeof body !== 'object' || body === null) return none;
  const record = body as Record<string, unknown>;
  const code = inviteErrorCode(readString(record, 'error'));
  if (code === 'free_mail_client') return { code, message: FREE_MAIL_APPROVER_MESSAGE };
  const detail = readString(record, 'error_detail');
  if (detail === undefined) return { code, message: null };
  const traceId = readString(record, 'trace_id');
  return {
    code,
    message:
      traceId !== undefined
        ? `Invite failed: ${detail} (trace ${traceId})`
        : `Invite failed: ${detail}`,
  };
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
  onError: (detail: string | null, code: InviteErrorCode | null) => void;
}): Promise<{ ok: true } | { ok: false; message: string; code: InviteErrorCode | null }> {
  if (!isValidInviteEmail(deps.email)) {
    deps.onError(INVITE_INVALID_EMAIL_MESSAGE, null);
    return { ok: false, message: INVITE_INVALID_EMAIL_MESSAGE, code: null };
  }

  const email = deps.email.trim();
  try {
    const { error } = await deps.invoke('invite-send', {
      body: { workspace_id: deps.workspaceId, email, role: deps.role },
      headers: { 'x-trace-id': deps.traceId },
    });
    if (error !== null && error !== undefined) {
      const failure = await readInviteError(error);
      deps.onError(failure.message, failure.code);
      return { ok: false, message: failure.message ?? INVITE_ERROR_MESSAGE, code: failure.code };
    }
  } catch {
    deps.onError(null, null);
    return { ok: false, message: INVITE_ERROR_MESSAGE, code: null };
  }
  deps.onSuccess();
  return { ok: true };
}

// The role value stays `client`; people read it as the approver.
const APPROVER_ROLE_OPTION: SelectOption = { value: 'client', label: 'Approver' };
const ROLE_OPTIONS: SelectOption[] = [
  { value: 'admin', label: 'Creator, can manage members' },
  { value: 'agency', label: 'Creator' },
  APPROVER_ROLE_OPTION,
];

/**
 * The role choices for an inviter. A client may invite approvers only, so a
 * client inviter never sees a role member_invite would refuse (forbidden_role).
 */
export function getInviteRoleOptions(clientOnly: boolean): readonly SelectOption[] {
  return clientOnly ? [APPROVER_ROLE_OPTION] : ROLE_OPTIONS;
}

function isInviteRole(value: string): value is InviteRole {
  return value === 'admin' || value === 'agency' || value === 'client';
}

export function MembersInviteForm({
  clientOnly = false,
  onInvited,
  onClientDomainMismatch,
}: {
  clientOnly?: boolean;
  onInvited?: () => void;
  /** client_domain_mismatch is a toast, not an inline line; the panel shows it. */
  onClientDomainMismatch?: () => void;
} = {}) {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const roleOptions = getInviteRoleOptions(clientOnly);
  const [singleEmail, setSingleEmail] = useState('');
  const [singleRole, setSingleRole] = useState<InviteRole>('client');
  const [singleSubmitting, setSingleSubmitting] = useState(false);
  const [singleSentTo, setSingleSentTo] = useState<string | null>(null);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [singleEmailTouched, setSingleEmailTouched] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [invitees, setInvitees] = useState<Array<{ email: string; role: InviteRole }>>([]);
  const [groupSubmitting, setGroupSubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});
  const [sentCount, setSentCount] = useState<number | null>(null);

  // No active workspace: there is nothing to invite into. Say so and stop.
  if (workspaceId === null) {
    return <p className="text-sm text-fg-3">No active workspace.</p>;
  }
  // Capture the narrowed id so the async submit closure keeps the string type.
  const activeWorkspaceId = workspaceId;
  const testSite = isTestSite();

  const trimmedSingleEmail = singleEmail.trim();
  const singleEmailValid = isValidInviteEmail(trimmedSingleEmail);
  const singleEmailError = singleEmailTouched && trimmedSingleEmail.length > 0 && !singleEmailValid;

  async function handleSingleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSingleEmailTouched(true);
    if (singleSubmitting || !singleEmailValid) return;

    const target = trimmedSingleEmail;
    setSingleSubmitting(true);
    setSingleSentTo(null);
    setSingleError(null);
    await sendInvite({
      workspaceId: activeWorkspaceId,
      email: target,
      role: clientOnly ? 'client' : singleRole,
      traceId: newTrace(),
      invoke: (name, options) => supabase.functions.invoke(name, options),
      onSuccess: () => {
        setSingleEmail('');
        setSingleSentTo(target);
        if (isTestEmail(target)) rememberTestInvitee(target);
        setSingleSubmitting(false);
        onInvited?.();
        dispatchInductionRefresh();
      },
      onError: (detail, code) => {
        if (code === 'client_domain_mismatch') {
          onClientDomainMismatch?.();
        } else {
          setSingleError(detail ?? INVITE_ERROR_MESSAGE);
        }
        setSingleSubmitting(false);
      },
    });
  }

  function addEmails(): void {
    const parsed = parseInviteEmails(emailInput);
    const existing = new Set(invitees.map(({ email }) => email.toLowerCase()));
    const added: string[] = [];
    const duplicates: string[] = [];

    for (const email of parsed.emails) {
      if (existing.has(email)) {
        duplicates.push(email);
      } else {
        existing.add(email);
        added.push(email);
      }
    }

    if (added.length > 0) {
      setInvitees((current) => [
        ...current,
        ...added.map((email) => ({ email, role: 'client' as const })),
      ]);
      setSentCount(null);
    }

    setEmailInput(parsed.invalid.join(', '));
    const messages = [
      parsed.invalid.length > 0
        ? `${INVITE_INVALID_EMAIL_MESSAGE} Check: ${parsed.invalid.join(', ')}.`
        : null,
      duplicates.length > 0 ? `${INVITE_DUPLICATE_EMAIL_MESSAGE} ${duplicates.join(', ')}.` : null,
    ].filter((message): message is string => message !== null);
    setEntryError(
      messages.length > 0
        ? messages.join(' ')
        : added.length === 0
          ? 'Enter at least one valid email address.'
          : null,
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (groupSubmitting || invitees.length === 0) return;

    const batch = invitees;
    setGroupSubmitting(true);
    setSentCount(null);
    setInviteErrors({});

    const results = await Promise.all(
      batch.map(async (invitee) => {
        const result = await sendInvite({
          workspaceId: activeWorkspaceId,
          email: invitee.email,
          role: clientOnly ? 'client' : invitee.role,
          traceId: newTrace(),
          invoke: (name, options) => supabase.functions.invoke(name, options),
          onSuccess: () => {},
          onError: () => {},
        });
        return { invitee, result };
      }),
    );

    const failed = results.filter(({ result }) => !result.ok);
    const errors: Record<string, string> = {};
    let mismatch = false;
    for (const { invitee, result } of failed) {
      if (result.ok) continue;
      if (result.code === 'client_domain_mismatch') mismatch = true;
      else errors[invitee.email] = result.message;
    }
    if (mismatch) onClientDomainMismatch?.();
    setInviteErrors(errors);
    setInvitees(failed.map(({ invitee }) => invitee));
    setSentCount(results.length - failed.length);
    setGroupSubmitting(false);
    if (failed.length < results.length) {
      onInvited?.();
      dispatchInductionRefresh();
    }
  }

  return (
    <div className="flex max-w-[520px] flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">Invite member</h3>
        <form className="flex flex-col gap-4" onSubmit={handleSingleSubmit}>
          <Field label="Email" htmlFor="invite-email" required>
            <Input
              id="invite-email"
              type="email"
              value={singleEmail}
              aria-invalid={singleEmailError}
              aria-describedby={singleEmailError ? 'invite-email-error' : undefined}
              onChange={(event) => {
                setSingleEmail(event.target.value);
                setSingleError(null);
              }}
              onBlur={() => setSingleEmailTouched(true)}
              placeholder="name@example.com"
              autoComplete="off"
              disabled={singleSubmitting}
            />
            {testSite ? (
              <button
                type="button"
                className="mt-1.5 inline-flex min-h-[44px] items-center text-sm font-medium text-accent hover:underline"
                onClick={() => {
                  const role = clientOnly ? 'client' : singleRole;
                  setSingleEmail(testAddress(role === 'client' ? 'approver' : 'creator'));
                  setSingleError(null);
                }}
              >
                Use a test address
              </button>
            ) : null}
            {singleEmailError ? (
              <p id="invite-email-error" role="alert" className="mt-1.5 text-xs text-bad">
                {INVITE_INVALID_EMAIL_MESSAGE}
              </p>
            ) : null}
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <Select
              label="Role"
              value={clientOnly ? 'client' : singleRole}
              options={roleOptions}
              disabled={singleSubmitting}
              onChange={(value) => {
                if (!clientOnly && isInviteRole(value)) setSingleRole(value);
              }}
            />
          </Field>
          <div>
            <Button
              variant="primary"
              size="lg"
              type="submit"
              data-induction={INDUCTION_KEYS.membersInvite}
              disabled={singleSubmitting || !singleEmailValid}
            >
              {singleSubmitting ? 'Sending' : 'Send invite'}
            </Button>
          </div>
          {singleSentTo !== null ? (
            <p className="text-sm text-good">Invitation sent to {singleSentTo}.</p>
          ) : null}
          {testSite && singleSentTo !== null && isTestEmail(singleSentTo) ? (
            <p className="text-sm text-fg-2">
              Test site: open it as the invitee from the sign-in page, or{' '}
              <a
                className="font-medium text-accent hover:underline"
                href={testInviteePath(singleSentTo)}
              >
                switch to {singleSentTo} now
              </a>
              .
            </p>
          ) : null}
          {singleError !== null ? (
            <p role="alert" className="text-sm text-bad">
              {singleError}
            </p>
          ) : null}
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">Invite group members</h3>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Field
            label="Add people"
            htmlFor="invite-emails"
            hint="Enter one or more email addresses, separated by commas, spaces, or new lines."
          >
            <Textarea
              id="invite-emails"
              value={emailInput}
              aria-invalid={entryError !== null}
              aria-describedby={entryError !== null ? 'invite-entry-error' : undefined}
              onChange={(event) => {
                setEmailInput(event.target.value);
                setEntryError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  addEmails();
                }
              }}
              placeholder="name@example.com, another@example.com"
              autoComplete="off"
              disabled={groupSubmitting}
            />
            {entryError !== null ? (
              <p id="invite-entry-error" role="alert" className="mt-1.5 text-xs text-bad">
                {entryError}
              </p>
            ) : null}
          </Field>
          <div>
            <Button
              variant="default"
              size="lg"
              type="button"
              onClick={addEmails}
              disabled={groupSubmitting}
            >
              Add email
            </Button>
          </div>

          {invitees.length > 0 ? (
            <ul aria-label="People to invite" className="flex flex-col gap-2">
              {invitees.map((invitee) => (
                <li
                  key={invitee.email}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel-2 p-2"
                >
                  <span className="min-w-0 flex-1 break-all px-2 text-sm">{invitee.email}</span>
                  <div className="w-48 max-w-full">
                    <Select
                      label={`Role for ${invitee.email}`}
                      value={clientOnly ? 'client' : invitee.role}
                      options={roleOptions}
                      disabled={groupSubmitting}
                      onChange={(value) => {
                        if (!clientOnly && isInviteRole(value)) {
                          setInvitees((current) =>
                            current.map((item) =>
                              item.email === invitee.email ? { ...item, role: value } : item,
                            ),
                          );
                        }
                      }}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="md"
                    type="button"
                    className="h-11 min-w-[44px]"
                    aria-label={`Remove ${invitee.email}`}
                    disabled={groupSubmitting}
                    onClick={() => {
                      setInvitees((current) =>
                        current.filter((item) => item.email !== invitee.email),
                      );
                      setInviteErrors((current) => {
                        const next = { ...current };
                        delete next[invitee.email];
                        return next;
                      });
                      setSentCount(null);
                    }}
                  >
                    Remove
                  </Button>
                  {inviteErrors[invitee.email] !== undefined ? (
                    <p role="alert" className="basis-full px-2 text-xs text-bad">
                      {inviteErrors[invitee.email]}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div>
            <Button
              variant="primary"
              size="lg"
              type="submit"
              disabled={groupSubmitting || invitees.length === 0}
            >
              {groupSubmitting
                ? 'Sending invitations'
                : `Send ${invitees.length} invitation${invitees.length === 1 ? '' : 's'}`}
            </Button>
          </div>
          {sentCount !== null && sentCount > 0 ? (
            <p className="text-sm text-good">
              Sent {sentCount} invitation{sentCount === 1 ? '' : 's'}.
              {invitees.length > 0 ? ` ${invitees.length} failed; review and retry.` : ''}
            </p>
          ) : null}
        </form>
      </section>
    </div>
  );
}
