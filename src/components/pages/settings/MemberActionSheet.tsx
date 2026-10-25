// The member's role sheet, opened from the row's ⋯ (ui/ActionMenu: Change
// role, Remove from workspace). Built on the existing Sheet primitive: the
// member's avatar / name / email / role, then the role picker + Save (managers
// only, never on the owner's or the viewer's own row). The panel owns
// open/close, the member_role_set call and the remove confirm dialog.

import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { RolePicker, getInviteRoleOptions, isInviteRole } from './MembersInviteForm';
import type { InviteRole, RoleChoice } from './MembersInviteForm';
import { roleLabel } from './members-data';
import type { MemberEntry } from './members-data';

/** The role picker shows for managers on anyone but the owner and themselves. */
export function canChangeMemberRole(member: MemberEntry, canManage: boolean): boolean {
  return canManage && !member.isOwner && !member.isSelf;
}

/** Resolves to null once the role is changed, else the line to show under the picker. */
export type MemberRoleChangeHandler = (
  member: MemberEntry,
  role: InviteRole,
) => Promise<string | null>;

interface MemberActionSheetProps {
  member: MemberEntry | null;
  open: boolean;
  canManage: boolean;
  onClose: () => void;
  onChangeRole: MemberRoleChangeHandler;
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
  onClose,
  onChangeRole,
}: MemberActionSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Member">
      {member !== null ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar
              name={member.displayName}
              {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
              role="profile"
            />
            <div className="min-w-0">
              <div className="truncate text-base font-medium text-fg">{member.displayName}</div>
              {member.email !== null ? (
                <div className="truncate text-sm text-fg-3">{member.email}</div>
              ) : null}
              <div className="mt-1 text-sm text-fg-2">{roleLabel(member.role)}</div>
            </div>
          </div>
          {canChangeMemberRole(member, canManage) ? (
            // Keyed by member so a reopened sheet starts from that member's role.
            <RoleChange key={member.id} member={member} onChangeRole={onChangeRole} />
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
