// Members panel container: wires the live reads to the presentational list,
// gates every action affordance to owner/admin, and drives the remove-member,
// cancel-invite, edit-invite and role-change flows through the existing Sheet +
// ConfirmDialog. The invite form stays at the top and refetches the list on a
// successful send.

import { useMemo, useState } from 'react';
import { memberRemove } from '@srtdio/rpc';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/toast';
import { FORMER_MEMBER } from '@/lib/people-names';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import {
  MembersInviteForm,
  getInviteRoleOptions,
  inviteErrorMessage,
  inviteRoleLabel,
  replacePendingInvite,
  sendInvite,
} from './MembersInviteForm';
import type { SentInvite } from './MembersInviteForm';
import { MembersList } from './MembersList';
import type { PendingEditHandler } from './MembersList';
import { MemberActionSheet } from './MemberActionSheet';
import type { MemberRoleChangeHandler } from './MemberActionSheet';
import {
  activeMemberRole,
  canInviteMembers,
  canManageMembers,
  clientDomainLabel,
  clientDomainMismatchMessage,
  deriveMembers,
  memberRemoveErrorMessage,
} from './members-data';
import type { MemberEntry } from './members-data';
import { useMembersData } from './useMembersData';

export function MembersPanel() {
  const { workspaceId, workspaceName, workspaceDisplayName } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const toast = useToast();
  const { loading, error, rows, profiles, delivery, refetch } = useMembersData(workspaceId);

  const currentUserId = session?.user.id ?? null;
  const selfEmail = session?.user.email ?? null;

  const derived = useMemo(
    () => deriveMembers({ rows, profiles, currentUserId, selfEmail }),
    [rows, profiles, currentUserId, selfEmail],
  );
  const canManage = useMemo(() => canManageMembers(rows, currentUserId), [rows, currentUserId]);
  const callerRole = useMemo(() => activeMemberRole(rows, currentUserId), [rows, currentUserId]);
  const canInvite = useMemo(() => canInviteMembers(rows, currentUserId), [rows, currentUserId]);

  const [actionsFor, setActionsFor] = useState<MemberEntry | null>(null);
  const [confirmFor, setConfirmFor] = useState<MemberEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Pending invite id -> address, for invites sent from this panel: the
  // membership rows carry no email, so the list shows these when known.
  const [sentEmails, setSentEmails] = useState<ReadonlyMap<string, string>>(new Map());

  const pendingEmails = useMemo(
    () =>
      new Map(
        derived.pending.flatMap((member) => {
          const email = sentEmails.get(member.id);
          return email !== undefined ? [[member.id, email] as const] : [];
        }),
      ),
    [derived.pending, sentEmails],
  );

  const workspaceLabel = workspaceDisplayName ?? 'this workspace';

  function rememberEmail(inviteId: string | null, email: string): void {
    if (inviteId === null) return;
    setSentEmails((current) => new Map(current).set(inviteId, email));
  }

  // Read the client domain fresh: the first approver invite sets it
  // server-side, so the cached workspace row can be stale.
  async function readClientDomain(): Promise<string> {
    if (workspaceId === null) return '';
    const res = await supabase
      .from('workspaces')
      .select('client_domain')
      .eq('id', workspaceId)
      .maybeSingle();
    const domain: unknown = res.error ? null : res.data?.client_domain;
    return clientDomainLabel(typeof domain === 'string' ? domain : null);
  }

  async function removeMember(member: MemberEntry): Promise<boolean> {
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    if (!result.ok) logger.warn('member remove failed', { code: result.error.code });
    return result.ok;
  }

  function handleInvited(sent: readonly SentInvite[]): void {
    for (const invite of sent) rememberEmail(invite.inviteId, invite.email);
    refetch();
    const emailed = sent.filter((invite) => invite.status !== 'not-sent');
    const first = emailed[0];
    if (first === undefined) return;
    toast.show({
      title:
        emailed.length === 1 ? `Invite sent to ${first.email}` : `${emailed.length} invites sent`,
    });
  }

  async function performRemove(member: MemberEntry): Promise<void> {
    setRemoving(true);
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    setRemoving(false);
    if (result.ok) {
      setConfirmFor(null);
      setActionsFor(null);
      refetch();
      toast.show({ title: `${member.displayName} removed` });
      return;
    }
    // Expected failures arrive on the Result branch; show friendly copy, keep
    // the dialog open so the user can dismiss. No automatic retry.
    toast.show({ title: memberRemoveErrorMessage(result.error.code) });
  }

  async function performCancel(member: MemberEntry): Promise<void> {
    setCancellingId(member.id);
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    setCancellingId(null);
    if (result.ok) {
      refetch();
      toast.show({
        title: `Invite to ${pendingEmails.get(member.id) ?? member.displayName} cancelled`,
      });
      return;
    }
    toast.show({ title: memberRemoveErrorMessage(result.error.code) });
  }

  const performEditInvite: PendingEditHandler = async (member, { email, role, sameEmail }) => {
    if (workspaceId === null) return inviteErrorMessage(null, '');
    const activeWorkspaceId = workspaceId;
    const result = await replacePendingInvite({
      memberId: member.id,
      sameEmail,
      send: () =>
        sendInvite({
          workspaceId: activeWorkspaceId,
          email,
          role,
          traceId: newTrace(),
          invoke: (name, options) => supabase.functions.invoke(name, options),
        }),
      remove: () => removeMember(member),
    });
    if (result.ok) {
      rememberEmail(result.inviteId, email);
      refetch();
      toast.show({ title: `New invite sent to ${email} as ${inviteRoleLabel(role)}` });
      return null;
    }
    const clientDomain = result.code === 'client_domain_mismatch' ? await readClientDomain() : '';
    const message = inviteErrorMessage(result.code, clientDomain);
    if (!result.oldCancelled) return message;
    // The old invite is gone although the new one failed: its row leaves the
    // list on refetch, so the toast carries both lines.
    refetch();
    toast.show({
      title: `Invite to ${pendingEmails.get(member.id) ?? member.displayName} cancelled`,
      description: message,
    });
    return message;
  };

  const performRoleChange: MemberRoleChangeHandler = async (member, role) => {
    // Args as a variable: p_trace_id is the proc's real trace parameter.
    const args = { p_member_id: member.id, p_role: role, p_trace_id: newTrace() };
    const { error: roleError } = await supabase.rpc('member_role_set', args);
    if (roleError === null) {
      setActionsFor(null);
      refetch();
      toast.show({ title: `Role changed to ${inviteRoleLabel(role)}` });
      return null;
    }
    if (roleError.message === 'client_domain_mismatch') {
      return clientDomainMismatchMessage(await readClientDomain());
    }
    logger.warn('member role change failed', { error: roleError.message });
    return memberRemoveErrorMessage('unknown');
  };

  return (
    <div className="flex flex-col gap-6">
      {canInvite ? (
        <MembersInviteForm
          clientOnly={callerRole === 'client'}
          invitedEmails={Array.from(pendingEmails.values())}
          loadClientDomain={readClientDomain}
          onInvited={handleInvited}
        />
      ) : null}

      {loading ? (
        <p className="text-legacy-sm text-fg-3">Loading members</p>
      ) : error !== null ? (
        <p className="text-legacy-sm text-bad">
          Couldn&apos;t load members. Refresh and try again.
        </p>
      ) : (
        <MembersList
          derived={derived}
          clientName={workspaceName}
          canManage={canManage}
          cancellingId={cancellingId}
          delivery={delivery}
          pendingEmails={pendingEmails}
          roleOptions={getInviteRoleOptions(false)}
          onOpenActions={(member) => setActionsFor(member)}
          onCancelInvite={performCancel}
          onEditInvite={performEditInvite}
        />
      )}

      <MemberActionSheet
        member={actionsFor}
        open={actionsFor !== null}
        canManage={canManage}
        onClose={() => setActionsFor(null)}
        onRemove={(member) => {
          setActionsFor(null);
          setConfirmFor(member);
        }}
        onChangeRole={performRoleChange}
      />

      {confirmFor !== null ? (
        <ConfirmDialog
          title={`Remove ${confirmFor.displayName}?`}
          message={[
            `They lose access to ${workspaceLabel} the moment you confirm.`,
            'Signed out everywhere. Chat access ends immediately.',
            `Their posts, comments and uploads stay, shown as “${FORMER_MEMBER}”.`,
            'You can invite them back any time.',
          ].join(' • ')}
          confirmLabel="Remove member"
          busyLabel="Removing"
          destructive
          busy={removing}
          onConfirm={() => void performRemove(confirmFor)}
          onCancel={() => setConfirmFor(null)}
        />
      ) : null}
    </div>
  );
}
