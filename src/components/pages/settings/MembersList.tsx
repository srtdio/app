// Presentational members list: two groups by side (Approvers / Creators), then
// the pending invites with their Edit / Cancel actions and delivery pill.
// Prop-driven so it renders statically in tests (a client-role viewer sees no
// kebab; the owner row shows the lock). All colour comes from theme tokens for
// light+dark parity; every control is >=44px.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconMore } from '@/components/ui/icons';
import type { SelectOption } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import {
  INVITE_INVALID_EMAIL_MESSAGE,
  RolePicker,
  inviteRoleLabel,
  isInviteRole,
  isValidInviteEmail,
} from './MembersInviteForm';
import type { InviteRole, RoleChoice } from './MembersInviteForm';
import { formatJoined, isUndelivered, roleLabel } from './members-data';
import type { DerivedMembers, InviteDeliveryStatus, MemberEntry } from './members-data';

const OWNER_LOCK_TITLE = 'Transfer ownership before the owner can be removed';

// Local lock glyph: the shared icon set has no lock, so the owner's no-actions
// affordance draws one inline (translateY/opacity-only surfaces elsewhere; a
// static glyph never animates on X or rotate).
function LockGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={5} y={11} width={14} height={9} rx={2} />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-panel-2 px-2 py-0.5 text-sm font-medium text-fg-2">
      {roleLabel(role)}
    </span>
  );
}

function SelfChip() {
  return (
    <span className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
      You
    </span>
  );
}

interface RowProps {
  member: MemberEntry;
  canManage: boolean;
  onOpenActions: (member: MemberEntry) => void;
}

function MemberRowItem({ member, canManage, onOpenActions }: RowProps) {
  const joined = formatJoined(member.acceptedAt);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar
        name={member.displayName}
        {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-base font-medium text-fg">{member.displayName}</span>
          {member.isSelf ? <SelfChip /> : null}
        </div>
        {member.email !== null ? (
          <div className="truncate text-sm text-fg-3">{member.email}</div>
        ) : null}
      </div>
      <RoleBadge role={member.role} />
      {joined !== null ? <span className="hidden text-sm text-fg-3 sm:block">{joined}</span> : null}
      {member.isOwner ? (
        <span
          className="inline-flex h-11 w-11 items-center justify-center text-fg-3"
          title={OWNER_LOCK_TITLE}
          aria-label={OWNER_LOCK_TITLE}
        >
          <LockGlyph />
        </span>
      ) : canManage ? (
        <IconButton
          label={`Actions for ${member.displayName}`}
          onClick={() => onOpenActions(member)}
        >
          <IconMore />
        </IconButton>
      ) : null}
    </div>
  );
}

/** What the pending list knows about one invite beyond its membership row. */
interface PendingInfo {
  /** The invitee's address when this session sent it, else their account name. */
  email: string;
  /** Exact address known (sent from this panel), so an unchanged Save is a no-op. */
  emailKnown: boolean;
  undelivered: boolean;
}

function PendingRowItem({
  member,
  info,
  canManage,
  cancelling,
  roleOptions,
  onCancelInvite,
  onEditInvite,
}: {
  member: MemberEntry;
  info: PendingInfo;
  canManage: boolean;
  cancelling: boolean;
  roleOptions: readonly SelectOption[];
  onCancelInvite: (member: MemberEntry) => void;
  onEditInvite: PendingEditHandler;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Avatar name={info.email} size="lg" />
      {editing ? (
        <PendingEditFields
          member={member}
          info={info}
          roleOptions={roleOptions}
          onEditInvite={onEditInvite}
          onClose={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="min-w-0 flex-1 self-center">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate text-base font-medium text-fg">{info.email}</span>
              <span className="inline-flex items-center rounded-md bg-panel-2 px-1.5 py-0.5 text-xs font-medium text-fg-3">
                Invited
              </span>
              {info.undelivered ? (
                <span className="inline-flex items-center rounded-md bg-bad-soft px-1.5 py-0.5 text-xs font-medium text-bad">
                  Not delivered
                </span>
              ) : null}
            </div>
            <div className="truncate text-sm text-fg-3">{inviteRoleLabel(member.role)}</div>
          </div>
          {canManage ? (
            <div className="flex shrink-0 items-center gap-1 self-center">
              <Button variant="ghost" disabled={cancelling} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                disabled={cancelling}
                onClick={() => onCancelInvite(member)}
                className={cn(cancelling && 'opacity-70')}
              >
                {cancelling ? 'Cancelling' : 'Cancel'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Edit replaces the pending invite: resolves to null once the fresh invite is
 * out, else the line to show under the email (the old invite is untouched
 * unless the line says it was cancelled).
 */
export type PendingEditHandler = (
  member: MemberEntry,
  change: { email: string; role: InviteRole; sameEmail: boolean },
) => Promise<string | null>;

function PendingEditFields({
  member,
  info,
  roleOptions,
  onEditInvite,
  onClose,
}: {
  member: MemberEntry;
  info: PendingInfo;
  roleOptions: readonly SelectOption[];
  onEditInvite: PendingEditHandler;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(info.email);
  const [role, setRole] = useState<RoleChoice>(isInviteRole(member.role) ? member.role : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cursor in the field with the local part selected, ready to retype.
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    const at = input.value.indexOf('@');
    input.setSelectionRange(0, at < 0 ? input.value.length : at);
  }, []);

  const trimmed = email.trim();
  const invalid = !isValidInviteEmail(trimmed);
  const sameEmail = info.emailKnown && trimmed.toLowerCase() === info.email.toLowerCase();

  async function save(): Promise<void> {
    if (saving) return;
    if (sameEmail && role === member.role) {
      onClose();
      return;
    }
    if (invalid || role === '') return;
    setSaving(true);
    setError(null);
    const failure = await onEditInvite(member, { email: trimmed, role, sameEmail });
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  }

  return (
    <form
      noValidate
      className="flex min-w-0 flex-1 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Email"
          aria-invalid={invalid || error !== null}
          value={email}
          disabled={saving}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-3 text-input text-fg outline-none placeholder:text-fg-3 focus:border-accent-line focus:ring-2 focus:ring-accent-soft md:text-base"
        />
        <RolePicker
          label={`Role for ${trimmed}`}
          value={role}
          options={roleOptions}
          invalid={role === ''}
          disabled={saving}
          onChange={(next) => {
            setRole(next);
            setError(null);
          }}
        />
      </div>
      {invalid ? (
        <p role="alert" className="text-sm text-bad">
          {INVITE_INVALID_EMAIL_MESSAGE}
        </p>
      ) : error !== null ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      <p className="text-sm text-fg-3">Saving sends a fresh invite. The old link stops working.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit" disabled={saving}>
          Save
        </Button>
        <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>
          Keep as is
        </Button>
      </div>
    </form>
  );
}

function Group({
  title,
  subtitle,
  count,
  emptyText,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-xl border border-border bg-panel"
    >
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">{title}</h3>
          <span className="text-sm text-fg-3">{count}</span>
        </div>
        {subtitle !== undefined && subtitle !== '' ? (
          <p className="mt-0.5 truncate text-sm text-fg-3">{subtitle}</p>
        ) : null}
      </header>
      <div className="divide-y divide-border">
        {count === 0 ? <p className="px-4 py-3 text-base text-fg-2">{emptyText}</p> : children}
      </div>
    </section>
  );
}

interface MembersListProps {
  derived: DerivedMembers;
  /** The brand name (workspaces.name), shown under the Approvers heading. */
  clientName: string | null;
  canManage: boolean;
  cancellingId: string | null;
  /** Pending member_id -> latest invite email status (invite_delivery_list). */
  delivery: ReadonlyMap<string, InviteDeliveryStatus>;
  /** Pending member_id -> the address this session invited. */
  pendingEmails: ReadonlyMap<string, string>;
  roleOptions: readonly SelectOption[];
  onOpenActions: (member: MemberEntry) => void;
  onCancelInvite: (member: MemberEntry) => void;
  onEditInvite: PendingEditHandler;
}

/**
 * The roster grouped by side: "Approvers" (role client) under the brand
 * name, then "Creators" (owner, admin, agency), then everyone invited who has
 * not joined yet.
 */
export function MembersList({
  derived,
  clientName,
  canManage,
  cancellingId,
  delivery,
  pendingEmails,
  roleOptions,
  onOpenActions,
  onCancelInvite,
  onEditInvite,
}: MembersListProps) {
  const { agency, client, pending } = derived;

  const renderActive = (member: MemberEntry) => (
    <MemberRowItem
      key={member.id}
      member={member}
      canManage={canManage}
      onOpenActions={onOpenActions}
    />
  );

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <Group
        title="Approvers"
        {...(clientName !== null ? { subtitle: clientName } : {})}
        count={client.length}
        emptyText="No approvers yet"
      >
        {client.map(renderActive)}
      </Group>

      <Group title="Creators" count={agency.length} emptyText="No creators yet">
        {agency.map(renderActive)}
      </Group>

      <Group title="Invited" count={pending.length} emptyText="Nobody waiting to join yet">
        {pending.map((member) => {
          const known = pendingEmails.get(member.id);
          return (
            <PendingRowItem
              key={member.id}
              member={member}
              info={{
                email: known ?? member.displayName,
                emailKnown: known !== undefined,
                undelivered: isUndelivered(delivery.get(member.id)),
              }}
              canManage={canManage}
              cancelling={cancellingId === member.id}
              roleOptions={roleOptions}
              onCancelInvite={onCancelInvite}
              onEditInvite={onEditInvite}
            />
          );
        })}
      </Group>
    </div>
  );
}
