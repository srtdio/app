// The member's role sheet, opened from the row's ⋯ (ui/ActionMenu: Change
// role, Remove from workspace). Built on the existing Sheet primitive: the
// member as one ui/Row (photo and name open the PersonCard; email; role tag), then the role picker + Save (managers
// only, never on the owner's or the viewer's own row). Under it, for managers
// on anyone but themselves, the Catch-up emails row: the same native tick box
// as the person's own Settings row; it saves on tick and paints at once. The
// panel owns open/close, the member_role_set and member_email_opt_in_set calls
// and the remove confirm dialog.

import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { Sheet } from '@/components/ui/Sheet';
import { Row } from '@/components/ui/Row';
import { Tag } from '@/components/ui/Tag';
import { RolePicker, getInviteRoleOptions, isInviteRole } from './MembersInviteForm';
import type { InviteRole, RoleChoice } from './MembersInviteForm';
import { emailPatchAfterManagerSet, memberEmailState, roleLabel } from './members-data';
import type { MemberEmailOptInOutcome, MemberEntry } from './members-data';
import { errorText } from '@/lib/error-copy';

/** The role picker shows for managers on anyone but the owner and themselves. */
export function canChangeMemberRole(member: MemberEntry, canManage: boolean): boolean {
  return canManage && !member.isOwner && !member.isSelf;
}

/** Resolves to null once the role is changed, else the line to show under the picker. */
export type MemberRoleChangeHandler = (
  member: MemberEntry,
  role: InviteRole,
) => Promise<string | null>;

/** The Catch-up emails row shows for managers on anyone but themselves, once its state is read. */
export function canSetMemberEmail(member: MemberEntry, canManage: boolean): boolean {
  return canManage && !member.isSelf && memberEmailState(member) !== null;
}

/** Saves the member's catch-up emails; the panel patches the shared list first. */
export type MemberEmailOptInHandler = (
  member: MemberEntry,
  emailOptIn: boolean,
) => Promise<MemberEmailOptInOutcome>;

/** A person the sheet can name (the manager who turned emails off). */
export interface SheetPerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

interface MemberActionSheetProps {
  member: MemberEntry | null;
  open: boolean;
  canManage: boolean;
  /** The signed-in viewer: a switch-off records them as the one who turned it off. */
  viewerId: string | null;
  onClose: () => void;
  onChangeRole: MemberRoleChangeHandler;
  onSetEmailOptIn: MemberEmailOptInHandler;
  /** The person for a user id from the members already held; null while unknown. */
  personFor: (userId: string) => SheetPerson | null;
}

const EMAIL_SAVE_FAILED = errorText('save', null);

type EmailFields = Pick<MemberEntry, 'emailOptIn' | 'emailOptOutBy'>;

function EmailOptInRow({
  member,
  viewerId,
  onSetEmailOptIn,
  personFor,
}: {
  member: MemberEntry;
  viewerId: string | null;
  onSetEmailOptIn: MemberEmailOptInHandler;
  personFor: (userId: string) => SheetPerson | null;
}) {
  // The tick paints at once; a failure puts the held value back.
  const [local, setLocal] = useState<EmailFields | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const fields: EmailFields = local ?? {
    ...(member.emailOptIn !== undefined ? { emailOptIn: member.emailOptIn } : {}),
    ...(member.emailOptOutBy !== undefined ? { emailOptOutBy: member.emailOptOutBy } : {}),
  };
  const state = memberEmailState(fields);
  if (state === null) return null;

  async function tick(next: boolean): Promise<void> {
    if (saving) return;
    const before = local;
    setLocal(emailPatchAfterManagerSet(next, viewerId));
    setFailed(false);
    setSaving(true);
    const outcome = await onSetEmailOptIn(member, next);
    setSaving(false);
    if (outcome === 'failed') {
      setLocal(before);
      setFailed(true);
    } else if (outcome === 'turned_off_by_member') {
      setLocal({ emailOptIn: false, emailOptOutBy: null });
    }
  }

  if (state === 'off-by-member') {
    return (
      <div data-member-email="off-by-member" className="flex min-h-11 flex-col py-1">
        <span className="text-base text-fg">Catch-up emails</span>
        <span className="text-sm text-fg-2">
          They turned catch-up emails off. Only they can turn them back on.
        </span>
      </div>
    );
  }

  const offBy =
    state === 'off-by-manager' && typeof fields.emailOptOutBy === 'string'
      ? personFor(fields.emailOptOutBy)
      : null;

  return (
    <div data-member-email={state} className="flex flex-col gap-2">
      <div className="flex flex-col">
        <label
          htmlFor="member-email-opt-in"
          className="flex min-h-11 cursor-pointer items-start gap-3 py-1"
        >
          <span className="flex h-6 shrink-0 items-center">
            <Checkbox
              id="member-email-opt-in"
              checked={state === 'on'}
              aria-describedby="member-email-opt-in-help"
              onChange={(event) => void tick(event.target.checked)}
            />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-base text-fg">Catch-up emails</span>
            <span id="member-email-opt-in-help" className="text-sm text-fg-2">
              Turns off for this person in every workspace.
            </span>
          </span>
        </label>
        {offBy !== null ? (
          // Outside the label: a tap on the name opens the person, never the tick.
          <span data-member-email-off-by="" className="pl-7 text-sm text-fg-2">
            Turned off by{' '}
            <PersonTrigger userId={offBy.userId} name={offBy.name} avatarUrl={offBy.avatarUrl}>
              {offBy.name}
            </PersonTrigger>
          </span>
        ) : null}
      </div>
      {failed ? <ErrorNote>{EMAIL_SAVE_FAILED}</ErrorNote> : null}
    </div>
  );
}

function RoleChange({
  member,
  onChangeRole,
}: {
  member: MemberEntry;
  onChangeRole: MemberRoleChangeHandler;
}) {
  const [role, setRole] = useState<RoleChoice>(isInviteRole(member.role) ? member.role : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (saving || role === '' || role === member.role) return;
    setSaving(true);
    setError(null);
    const failure = await onChangeRole(member, role);
    setSaving(false);
    setError(failure);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-base text-fg-2">Role</span>
        <RolePicker
          label="Role"
          value={role}
          options={getInviteRoleOptions(false)}
          disabled={saving}
          fill
          onChange={(next) => {
            setRole(next);
            setError(null);
          }}
        />
        <Button
          variant="primary"
          disabled={saving || role === '' || role === member.role}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function MemberActionSheet({
  member,
  open,
  canManage,
  viewerId,
  onClose,
  onChangeRole,
  onSetEmailOptIn,
  personFor,
}: MemberActionSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Member">
      {member !== null ? (
        <div className="flex flex-col gap-4">
          {/* The person as the Members row shows them (one person row, not a second
              card): photo and name open the one PersonCard. */}
          <Row
            flush
            leading={
              <PersonTrigger
                userId={member.userId}
                name={member.displayName}
                avatarUrl={member.avatarUrl}
                display="block"
              >
                <Avatar
                  name={member.displayName}
                  {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                  role="header"
                />
              </PersonTrigger>
            }
            title={
              <PersonTrigger
                userId={member.userId}
                name={member.displayName}
                avatarUrl={member.avatarUrl}
              >
                {member.displayName}
              </PersonTrigger>
            }
            {...(member.email !== null ? { secondary: member.email } : {})}
            badge={<Tag label={roleLabel(member.role)} tone="neutral" />}
          />
          {canChangeMemberRole(member, canManage) ? (
            // Keyed by member so a reopened sheet starts from that member's role.
            <RoleChange key={member.id} member={member} onChangeRole={onChangeRole} />
          ) : null}
          {canSetMemberEmail(member, canManage) ? (
            // Keyed by member: a reopened sheet starts from that member's state.
            <EmailOptInRow
              key={`email-${member.id}`}
              member={member}
              viewerId={viewerId}
              onSetEmailOptIn={onSetEmailOptIn}
              personFor={personFor}
            />
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
