import { useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { z } from 'zod';
import { run as suggestEmail } from '@zootools/email-spell-checker';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChevronDown, IconX } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import type { SelectOption } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import {
  clientDomainMismatchMessage,
  emailDomain,
  UNCONFIRMED_ACCOUNT_MESSAGE,
} from './members-data';
import { dispatchInductionRefresh, INDUCTION_KEYS } from '@/lib/induction';
import {
  isTestEmail,
  isTestSite,
  rememberTestInvitee,
  testAddress,
  testInviteePath,
} from '@/lib/test-site';

export type InviteRole = 'admin' | 'agency' | 'client';

// Friendly, code-free copy: the form maps the few invite-check codes it words
// itself; every other failure reads as this one plain line.
export const INVITE_ERROR_MESSAGE = "Couldn't send the invite. Try again.";
/** The invite row exists but the email did not go out; the inviter sends the link. */
export const INVITE_NOT_SENT_MESSAGE =
  "Invite created, but the email didn't send. Copy the link and send it yourself.";
export const INVITE_PICK_ROLE_MESSAGE = 'Pick a role for each person';
export const INVITE_INVALID_EMAIL_MESSAGE = 'Check this email';
export const INVITE_DUPLICATE_MESSAGE = 'That person is already on the list.';
const ROLE_PLACEHOLDER = 'Choose a role';

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

/** Split typed or pasted text on commas, spaces, semicolons and new lines. */
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

/**
 * The likely intended address for a mistyped domain (gmial.com -> gmail.com),
 * or null when the domain looks right or there is no domain yet.
 */
export function suggestEmailFix(email: string): string | null {
  const trimmed = email.trim();
  if (emailDomain(trimmed) === '') return null;
  const suggestion = suggestEmail({ email: trimmed });
  if (suggestion === undefined) return null;
  return suggestion.full.toLowerCase() === trimmed.toLowerCase() ? null : suggestion.full;
}

// Minimal structural shape of the invite-send invoke. Kept narrow so the pure
// helper unit-tests with a plain mock; supabase.functions.invoke is assignable.
interface InvokeResult {
  data?: unknown;
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

/** The invite-check codes the form words itself instead of the plain line. */
export type InviteErrorCode =
  | 'client_domain_mismatch'
  | 'disposable_email'
  | 'email_domain_unreachable'
  | 'unconfirmed_account';

const INVITE_ERROR_COPY: Record<Exclude<InviteErrorCode, 'client_domain_mismatch'>, string> = {
  disposable_email: "Temporary emails can't be invited. Use a permanent one.",
  email_domain_unreachable: "This email can't receive mail. Check the part after @.",
  unconfirmed_account: UNCONFIRMED_ACCOUNT_MESSAGE,
};

function inviteErrorCode(value: string | undefined): InviteErrorCode | null {
  return value === 'client_domain_mismatch' ||
    value === 'disposable_email' ||
    value === 'email_domain_unreachable' ||
    value === 'unconfirmed_account'
    ? value
    : null;
}

/** The line under a refused address; clientDomain is workspaces.client_domain ('' when none). */
export function inviteErrorMessage(code: InviteErrorCode | null, clientDomain: string): string {
  if (code === 'client_domain_mismatch') return clientDomainMismatchMessage(clientDomain);
  return code === null ? INVITE_ERROR_MESSAGE : INVITE_ERROR_COPY[code];
}

/** Best-effort read of the structured failure body's code; unknowns go to the logs only. */
async function readInviteError(error: unknown): Promise<InviteErrorCode | null> {
  if (!hasResponseContext(error)) return null;
  let body: unknown;
  try {
    body = await error.context.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const code = inviteErrorCode(readString(record, 'error'));
  // Every other code (provisioning_failed, membership_lookup_failed,
  // delivery_record_failed, unknowns) reads as the one plain line; the code and
  // trace id go to the logs only, never on screen.
  if (code === null) {
    logger.warn('invite_send_failed', {
      error: readString(record, 'error') ?? null,
      error_detail: readString(record, 'error_detail') ?? null,
      trace_id: readString(record, 'trace_id') ?? null,
    });
  }
  return code;
}

/** What a 200 from invite-send says about the email. */
export interface InviteOutcome {
  emailed: boolean;
  errorDetail: string | null;
  acceptUrl: string | null;
  /** The pending workspace_members id; an existing pending invite for the address is reused. */
  inviteId: string | null;
}

/** Read emailed / error_detail / accept_url / invite_id off the 200 body; a missing body reads as not emailed. */
export function readInviteOutcome(data: unknown): InviteOutcome {
  if (typeof data !== 'object' || data === null) {
    return { emailed: false, errorDetail: null, acceptUrl: null, inviteId: null };
  }
  const record = data as Record<string, unknown>;
  return {
    emailed: record.emailed === true,
    errorDetail: readString(record, 'error_detail') ?? null,
    acceptUrl: readString(record, 'accept_url') ?? null,
    inviteId: readString(record, 'invite_id') ?? null,
  };
}

/**
 * "sent" only when the email went out. A test-site address is never emailed on
 * purpose and keeps the test-site path; any other emailed:false
 * (resend_not_configured, a send or link failure) is "not sent".
 */
export function inviteStatus(outcome: InviteOutcome): 'sent' | 'test' | 'not-sent' {
  if (outcome.emailed) return 'sent';
  if (outcome.errorDetail === 'test_address_not_emailed') return 'test';
  return 'not-sent';
}

/** The not-sent notice: the plain line plus Copy link for the invite's accept_url. */
export function InviteNotSent(props: { email: string; acceptUrl: string | null }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft p-3">
      <p role="status" className="text-base text-fg">
        <span className="font-medium">{props.email}: </span>
        {INVITE_NOT_SENT_MESSAGE}
      </p>
      {props.acceptUrl !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="default"
            type="button"
            onClick={() => {
              const url = props.acceptUrl;
              if (url === null) return;
              void copyText(url).then((ok) => setCopied(ok ? 'copied' : 'failed'));
            }}
          >
            Copy link
          </Button>
          {copied === 'copied' ? <span className="text-base text-good">Link copied</span> : null}
          {copied === 'failed' ? <span className="text-base text-bad">{COPY_FAILED}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export type SendInviteResult =
  | { ok: true; outcome: InviteOutcome }
  | { ok: false; code: InviteErrorCode | null };

/**
 * Pure send step: POST { workspace_id, email, role } to the deployed invite-send
 * function with the trace id on x-trace-id, then read the outcome or error code.
 * No state, no router, no supabase import, so it is testable in isolation.
 */
export async function sendInvite(deps: {
  workspaceId: string;
  email: string;
  role: InviteRole;
  traceId: string;
  invoke: InvokeInviteSend;
}): Promise<SendInviteResult> {
  if (!isValidInviteEmail(deps.email)) return { ok: false, code: null };

  const email = deps.email.trim();
  try {
    const { data, error } = await deps.invoke('invite-send', {
      body: { workspace_id: deps.workspaceId, email, role: deps.role },
      headers: { 'x-trace-id': deps.traceId },
    });
    if (error !== null && error !== undefined) {
      return { ok: false, code: await readInviteError(error) };
    }
    return { ok: true, outcome: readInviteOutcome(data) };
  } catch {
    return { ok: false, code: null };
  }
}

/**
 * Replace a pending invite with a fresh one (Edit on a pending row). A new
 * address sends first, then cancels the old invite, so a refused send leaves
 * the old invite untouched. The same address (a role-only change) cancels
 * first: invite-send reuses a pending invite for an address, so it would keep
 * the old role. A send that comes back with the old invite's id is that reuse
 * too, and takes the cancel-then-send path. oldCancelled tells the caller the
 * old invite is gone although the new one failed.
 */
export async function replacePendingInvite(deps: {
  memberId: string;
  /** The old invite's address is known and equals the new one. */
  sameEmail: boolean;
  send: () => Promise<SendInviteResult>;
  remove: () => Promise<boolean>;
}): Promise<
  | { ok: true; inviteId: string | null }
  | { ok: false; code: InviteErrorCode | null; oldCancelled: boolean }
> {
  if (!deps.sameEmail) {
    const first = await deps.send();
    if (!first.ok) return { ok: false, code: first.code, oldCancelled: false };
    if (first.outcome.inviteId !== deps.memberId) {
      await deps.remove();
      return { ok: true, inviteId: first.outcome.inviteId };
    }
  }
  if (!(await deps.remove())) return { ok: false, code: null, oldCancelled: false };
  const second = await deps.send();
  return second.ok
    ? { ok: true, inviteId: second.outcome.inviteId }
    : { ok: false, code: second.code, oldCancelled: true };
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

/** The picker label for a role ("Creator, can manage members"), else the raw value. */
export function inviteRoleLabel(role: string): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

/**
 * True while the tour's approver-invite step is up. Read from the guide's
 * data-induction-step attribute at submit time, so the form needs no tour
 * context (and its importers no tour mocks).
 */
export function isGuidedApproverInvite(): boolean {
  if (typeof document === 'undefined') return false;
  const step = document.querySelector('[data-induction-step]')?.getAttribute('data-induction-step');
  return typeof step === 'string' && step.endsWith('approver_invite');
}

/** No role picked yet: the inviter must choose Creator or Approver. */
export type RoleChoice = InviteRole | '';

export function isInviteRole(value: string): value is InviteRole {
  return value === 'admin' || value === 'agency' || value === 'client';
}

/**
 * A compact role picker sized to its label: a visible label over a native
 * select, so the long admin label wraps inside the picker and the OS menu opens
 * on tap. Max ~45% of its row unless it fills the row.
 */
export function RolePicker({
  label,
  value,
  options,
  invalid = false,
  disabled = false,
  fill = false,
  onChange,
}: {
  /** Accessible name of the select. */
  label: string;
  value: RoleChoice;
  options: readonly SelectOption[];
  invalid?: boolean;
  disabled?: boolean;
  /** Take the rest of the row instead of sizing to the label. */
  fill?: boolean;
  onChange: (role: InviteRole) => void;
}) {
  const current = options.find((option) => option.value === value)?.label;
  return (
    <label
      className={cn(
        'relative flex min-h-[44px] items-center gap-1 rounded-lg border bg-panel px-2.5 py-1 text-base transition-colors duration-fast focus-within:border-accent-line focus-within:ring-2 focus-within:ring-accent-soft',
        invalid ? 'border-bad bg-bad-soft' : 'border-border',
        current === undefined ? 'text-fg-3' : 'text-fg',
        fill ? 'min-w-0 flex-1' : 'max-w-[45%] shrink-0',
        disabled && 'opacity-60',
      )}
    >
      <span aria-hidden="true" className="min-w-0 leading-tight">
        {current ?? ROLE_PLACEHOLDER}
      </span>
      <IconChevronDown size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
      <select
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (isInviteRole(event.target.value)) onChange(event.target.value);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-input opacity-0 disabled:cursor-default"
      >
        <option value="" disabled>
          {ROLE_PLACEHOLDER}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The 44px "Did you mean {domain}?" line; a tap applies the suggested address. */
export function EmailSuggestion({
  suggestion,
  onApply,
}: {
  suggestion: string;
  onApply: (email: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      className="self-start text-left hover:underline"
      onClick={() => onApply(suggestion)}
    >
      Did you mean {emailDomain(suggestion)}?
    </Button>
  );
}

/** One sent address, handed to the panel for its toast and the pending list. */
export interface SentInvite {
  email: string;
  role: InviteRole;
  inviteId: string | null;
  status: 'sent' | 'test' | 'not-sent';
}

interface InviteRow {
  key: number;
  email: string;
  role: RoleChoice;
  /** The server's refusal for this address, shown under it until it is edited. */
  error: string | null;
}

// Axis: translateY only (no X, no rotate); motion-safe on the row collapses it
// under prefers-reduced-motion.
const ROW_KEYFRAMES =
  '@keyframes sorted-invite-row-in{from{opacity:0;transform:translateY(0.5rem)}to{opacity:1;transform:translateY(0)}}';

/** Keys that turn the typed address into a row. */
const SEPARATOR_KEYS = new Set(['Enter', ',', ' ', ';']);

// Shared by the entry box and the row fields: the email keyboard, no
// autofill, no auto-capitalise, no spellcheck squiggles.
const EMAIL_FIELD_PROPS = {
  inputMode: 'email',
  autoComplete: 'off',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export function MembersInviteForm({
  clientOnly = false,
  invitedEmails = [],
  loadClientDomain,
  onInvited,
}: {
  clientOnly?: boolean;
  /** Addresses with a pending invite, for the duplicate line. */
  invitedEmails?: readonly string[];
  /** workspaces.client_domain read fresh ('' when none), for the company-email line. */
  loadClientDomain?: () => Promise<string>;
  onInvited?: (sent: readonly SentInvite[]) => void;
} = {}) {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const roleOptions = getInviteRoleOptions(clientOnly);
  const nextKey = useRef(0);
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [duplicate, setDuplicate] = useState(false);
  const [setAllRole, setSetAllRole] = useState<RoleChoice>('');
  const [roleMissing, setRoleMissing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notSent, setNotSent] = useState<Array<{ email: string; acceptUrl: string | null }>>([]);
  const [testSentTo, setTestSentTo] = useState<string | null>(null);

  // No active workspace: there is nothing to invite into. Say so and stop.
  if (workspaceId === null) {
    return <p className="text-base text-fg-3">No active workspace.</p>;
  }
  // Capture the narrowed id so the async submit closure keeps the string type.
  const activeWorkspaceId = workspaceId;
  const testSite = isTestSite();

  const draftTokens = parseInviteEmails(draft);
  const draftCount = draftTokens.emails.length + draftTokens.invalid.length;
  const sendCount = rows.length + draftCount;
  const draftSuggestion = draftCount === 1 ? suggestEmailFix(draft) : null;
  const showRoleMissing = roleMissing && !clientOnly && rows.some((row) => row.role === '');

  /** Turn text into rows (skipping addresses already listed or invited); returns the new list. */
  function addToList(text: string): InviteRow[] {
    const parsed = parseInviteEmails(text);
    const taken = new Set([
      ...rows.map((row) => row.email.trim().toLowerCase()),
      ...invitedEmails.map((email) => email.toLowerCase()),
    ]);
    let skipped = false;
    const added: InviteRow[] = [];
    for (const email of [...parsed.emails, ...parsed.invalid]) {
      const key = email.toLowerCase();
      if (taken.has(key)) {
        skipped = true;
        continue;
      }
      taken.add(key);
      added.push({ key: nextKey.current++, email, role: '', error: null });
    }
    const next = [...rows, ...added];
    setRows(next);
    setDraft('');
    setDuplicate(skipped);
    return next;
  }

  function updateRow(key: number, change: Partial<Omit<InviteRow, 'key'>>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (SEPARATOR_KEYS.has(event.key) && draft.trim() !== '') {
      event.preventDefault();
      addToList(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && rows.length > 0) {
      event.preventDefault();
      setRows(rows.slice(0, -1));
      setDuplicate(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const text = event.clipboardData.getData('text');
    // A single pasted address stays in the box; a list becomes rows at once.
    if (!/[,\s;]/.test(text.trim())) return;
    event.preventDefault();
    addToList(`${draft} ${text}`);
  }

  /** The row's role to send, or null while it still needs one. */
  function resolveRole(row: InviteRow, guided: boolean): InviteRole | null {
    if (clientOnly) return 'client';
    if (row.role !== '') return row.role;
    // The tour's approver-invite step asks for the approver, so the step itself
    // names the role; everywhere else the inviter picks one (no default).
    return guided ? 'client' : null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const list = draft.trim() === '' ? rows : addToList(draft);
    if (list.length === 0 || list.some((row) => !isValidInviteEmail(row.email))) return;

    const guided = isGuidedApproverInvite();
    const batch: Array<{ row: InviteRow; role: InviteRole }> = [];
    for (const row of list) {
      const role = resolveRole(row, guided);
      if (role === null) {
        setRoleMissing(true);
        return;
      }
      batch.push({ row, role });
    }

    setRoleMissing(false);
    setSubmitting(true);
    setNotSent([]);
    // Each address sends on its own; one refusal never holds back the rest.
    const results = await Promise.all(
      batch.map(async ({ row, role }) => ({
        row,
        role,
        result: await sendInvite({
          workspaceId: activeWorkspaceId,
          email: row.email,
          role,
          traceId: newTrace(),
          invoke: (name, options) => supabase.functions.invoke(name, options),
        }),
      })),
    );

    const needsDomain = results.some(
      ({ result }) => !result.ok && result.code === 'client_domain_mismatch',
    );
    const clientDomain =
      needsDomain && loadClientDomain !== undefined ? await loadClientDomain() : '';

    const sent: SentInvite[] = [];
    const failed: InviteRow[] = [];
    for (const { row, role, result } of results) {
      if (!result.ok) {
        failed.push({ ...row, error: inviteErrorMessage(result.code, clientDomain) });
        continue;
      }
      const email = row.email.trim();
      sent.push({
        email,
        role,
        inviteId: result.outcome.inviteId,
        status: inviteStatus(result.outcome),
      });
      if (isTestEmail(email)) rememberTestInvitee(email);
    }

    setRows(failed);
    setNotSent(
      results.flatMap(({ row, result }) =>
        result.ok && inviteStatus(result.outcome) === 'not-sent'
          ? [{ email: row.email.trim(), acceptUrl: result.outcome.acceptUrl }]
          : [],
      ),
    );
    setTestSentTo(
      sent
        .map(({ email }) => email)
        .filter((email) => isTestEmail(email))
        .at(-1) ?? null,
    );
    setSubmitting(false);
    if (sent.length > 0) {
      onInvited?.(sent);
      dispatchInductionRefresh();
    }
  }

  return (
    <section aria-labelledby="invite-people-title" className="flex max-w-[520px] flex-col gap-4">
      <style>{ROW_KEYFRAMES}</style>
      <div>
        <h3
          id="invite-people-title"
          className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2"
        >
          Invite people
        </h3>
        <p className="mt-0.5 text-base text-fg-2">
          Add one email or many. Press Enter, or paste a list.
        </p>
      </div>
      <form noValidate className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <div className="flex flex-col">
          <Input
            id="invite-email"
            type="email"
            aria-label="Email"
            aria-describedby={duplicate ? 'invite-email-duplicate' : undefined}
            {...EMAIL_FIELD_PROPS}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDuplicate(false);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="name@company.com"
            disabled={submitting}
          />
          {duplicate ? (
            <p id="invite-email-duplicate" role="alert" className="mt-1.5 text-sm text-bad">
              {INVITE_DUPLICATE_MESSAGE}
            </p>
          ) : null}
          {draftSuggestion !== null ? (
            <EmailSuggestion suggestion={draftSuggestion} onApply={setDraft} />
          ) : null}
          {testSite ? (
            <Button
              type="button"
              variant="link"
              className="self-start hover:underline"
              onClick={() => {
                const approver = clientOnly || isGuidedApproverInvite();
                setDraft(testAddress(approver ? 'approver' : 'creator'));
                setDuplicate(false);
              }}
            >
              Use a test address
            </Button>
          ) : null}
        </div>

        {rows.length >= 2 && !clientOnly ? (
          <div className="flex items-center justify-end gap-2">
            <span className="text-base text-fg-2">Set all as</span>
            <RolePicker
              label="Set all as"
              value={setAllRole}
              options={roleOptions}
              disabled={submitting}
              onChange={(role) => {
                setSetAllRole(role);
                setRows((current) => current.map((row) => ({ ...row, role })));
                setRoleMissing(false);
              }}
            />
          </div>
        ) : null}

        {rows.length > 0 ? (
          <ul aria-label="People to invite" className="flex flex-col gap-2">
            {rows.map((row) => {
              const invalid = !isValidInviteEmail(row.email);
              const suggestion = suggestEmailFix(row.email);
              return (
                <li
                  key={row.key}
                  className="flex flex-col rounded-lg border border-border bg-panel-2 py-1 pl-3 pr-1 motion-safe:[animation:sorted-invite-row-in_var(--dur-base)_var(--ease-enter)_both]"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Email"
                      aria-invalid={invalid || row.error !== null}
                      {...EMAIL_FIELD_PROPS}
                      value={row.email}
                      disabled={submitting}
                      onChange={(event) =>
                        updateRow(row.key, { email: event.target.value, error: null })
                      }
                      className="h-11 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-input text-fg outline-none transition-colors duration-fast hover:border-dashed hover:border-border-strong focus:border-solid focus:border-accent md:text-base"
                    />
                    <RolePicker
                      label={`Role for ${row.email}`}
                      value={clientOnly ? 'client' : row.role}
                      options={roleOptions}
                      invalid={showRoleMissing && row.role === ''}
                      disabled={submitting}
                      onChange={(role) => updateRow(row.key, { role, error: null })}
                    />
                    <IconButton
                      type="button"
                      label={`Remove ${row.email}`}
                      disabled={submitting}
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    >
                      <IconX />
                    </IconButton>
                  </div>
                  {invalid ? (
                    <p role="alert" className="pb-1 text-sm text-bad">
                      {INVITE_INVALID_EMAIL_MESSAGE}
                    </p>
                  ) : row.error !== null ? (
                    <p role="alert" className="pb-1 text-sm text-bad">
                      {row.error}
                    </p>
                  ) : null}
                  {suggestion !== null ? (
                    <EmailSuggestion
                      suggestion={suggestion}
                      onApply={(email) => updateRow(row.key, { email, error: null })}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        <div>
          <Button
            variant="primary"
            type="submit"
            data-induction={INDUCTION_KEYS.membersInvite}
            disabled={submitting || sendCount === 0}
          >
            {submitting ? 'Sending' : sendCount > 1 ? `Send ${sendCount} invites` : 'Send invite'}
          </Button>
        </div>
        {showRoleMissing ? (
          <p role="alert" className="text-base text-bad">
            {INVITE_PICK_ROLE_MESSAGE}
          </p>
        ) : null}
        {notSent.map((item) => (
          <InviteNotSent key={item.email} email={item.email} acceptUrl={item.acceptUrl} />
        ))}
        {testSite && testSentTo !== null ? (
          <p className="text-base text-fg-2">
            Test site: open it as the invitee from the sign-in page, or{' '}
            <a
              className="font-medium text-accent hover:underline"
              href={testInviteePath(testSentTo)}
            >
              switch to {testSentTo} now
            </a>
            .
          </p>
        ) : null}
      </form>
    </section>
  );
}
