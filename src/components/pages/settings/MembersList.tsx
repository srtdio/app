// Presentational members list: two groups by side (Approvers / Team), each
// with its pending invites inline. Pure and prop-driven so it renders statically in tests
// (a client-role viewer sees no kebab; the owner row shows the lock). All colour
// comes from theme tokens for light+dark parity; every control is >=44px.

import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconMore } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatJoined, roleLabel } from './members-data';
import type { DerivedMembers, MemberEntry } from './members-data';

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
    <span className="inline-flex items-center rounded-md border border-border bg-panel-2 px-2 py-0.5 text-xs font-medium text-fg-2">
      {roleLabel(role)}
    </span>
  );
}

function SelfChip() {
  return (
    <span className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
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
          <span className="truncate text-sm font-medium text-fg">{member.displayName}</span>
          {member.isSelf ? <SelfChip /> : null}
        </div>
        {member.email !== null ? (
          <div className="truncate text-xs text-fg-3">{member.email}</div>
        ) : null}
      </div>
      <RoleBadge role={member.role} />
      {joined !== null ? <span className="hidden text-xs text-fg-3 sm:block">{joined}</span> : null}
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

function PendingRowItem({
  member,
  canManage,
  cancelling,
  onCancelInvite,
}: {
  member: MemberEntry;
  canManage: boolean;
  cancelling: boolean;
  onCancelInvite: (member: MemberEntry) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar
        name={member.displayName}
        {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{member.displayName}</span>
          <span className="inline-flex items-center rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] font-medium text-fg-3">
            Invited
          </span>
        </div>
        {member.email !== null ? (
          <div className="truncate text-xs text-fg-3">{member.email}</div>
        ) : null}
      </div>
      <RoleBadge role={member.role} />
      {canManage ? (
        <Button
          size="lg"
          disabled={cancelling}
          onClick={() => onCancelInvite(member)}
          className={cn(cancelling && 'opacity-70')}
        >
          {cancelling ? 'Cancelling' : 'Cancel'}
        </Button>
      ) : null}
    </div>
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
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <span className="text-xs text-fg-3">{count}</span>
        </div>
        {subtitle !== undefined && subtitle !== '' ? (
          <p className="mt-0.5 truncate text-xs text-fg-3">{subtitle}</p>
        ) : null}
      </header>
      <div className="divide-y divide-border">
        {count === 0 ? <p className="px-4 py-3 text-sm text-fg-3">{emptyText}</p> : children}
      </div>
    </section>
  );
}

interface MembersListProps {
  derived: DerivedMembers;
  /** The client name (workspaces.name), shown under the Approvers heading. */
  clientName: string | null;
  canManage: boolean;
  cancellingId: string | null;
  onOpenActions: (member: MemberEntry) => void;
  onCancelInvite: (member: MemberEntry) => void;
}

/**
 * The roster grouped by side: "Approvers" (role client) under the client's
 * name, then "Team" (owner, admin, agency). Pending invites sit inline at the
 * end of their side's group with their Cancel action.
 */
export function MembersList({
  derived,
  clientName,
  canManage,
  cancellingId,
  onOpenActions,
  onCancelInvite,
}: MembersListProps) {
  const { agency, client, pending } = derived;
  const pendingApprovers = pending.filter((m) => m.role === 'client');
  const pendingTeam = pending.filter((m) => m.role !== 'client');

  const renderPending = (member: MemberEntry) => (
    <PendingRowItem
      key={member.id}
      member={member}
      canManage={canManage}
      cancelling={cancellingId === member.id}
      onCancelInvite={onCancelInvite}
    />
  );
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
        count={client.length + pendingApprovers.length}
        emptyText="No approvers yet"
      >
        {client.map(renderActive)}
        {pendingApprovers.map(renderPending)}
      </Group>

      <Group title="Team" count={agency.length + pendingTeam.length} emptyText="No team members">
        {agency.map(renderActive)}
        {pendingTeam.map(renderPending)}
      </Group>
    </div>
  );
}
