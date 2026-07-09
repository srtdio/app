// Members panel container: wires the two live reads to the presentational list,
// gates every action affordance to owner/admin, and drives the remove-member
// and cancel-invite flows through the existing Sheet + ConfirmDialog. The invite
// form stays at the top and refetches the list on a successful send.

import { useMemo, useState } from 'react';
import { memberRemove } from '@srtdio/rpc';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/toast';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { MembersInviteForm } from './MembersInviteForm';
import { MembersList } from './MembersList';
import { MemberActionSheet } from './MemberActionSheet';
import { canManageMembers, deriveMembers, memberRemoveErrorMessage } from './members-data';
import type { MemberEntry } from './members-data';
import { useMembersData } from './useMembersData';

export function MembersPanel() {
  const { workspaceId, workspaceName } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const toast = useToast();
  const { loading, error, rows, profiles, refetch } = useMembersData(workspaceId);

  const currentUserId = session?.user.id ?? null;
  const selfEmail = session?.user.email ?? null;

  const derived = useMemo(
    () => deriveMembers({ rows, profiles, currentUserId, selfEmail }),
    [rows, profiles, currentUserId, selfEmail],
  );
  const canManage = useMemo(() => canManageMembers(rows, currentUserId), [rows, currentUserId]);

  const [actionsFor, setActionsFor] = useState<MemberEntry | null>(null);
  const [confirmFor, setConfirmFor] = useState<MemberEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const workspaceLabel = workspaceName ?? 'this workspace';

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
      toast.show({ title: 'Invite cancelled' });
      return;
    }
    toast.show({ title: memberRemoveErrorMessage(result.error.code) });
  }

  return (
    <div className="flex flex-col gap-6">
      <MembersInviteForm onInvited={refetch} />

      {loading ? (
        <p className="text-sm text-fg-3">Loading members</p>
      ) : error !== null ? (
        <p className="text-sm text-bad">Couldn&apos;t load members. Refresh and try again.</p>
      ) : (
        <MembersList
          derived={derived}
          canManage={canManage}
          cancellingId={cancellingId}
          onOpenActions={(member) => setActionsFor(member)}
          onCancelInvite={performCancel}
        />
      )}

      <MemberActionSheet
        member={actionsFor}
        open={actionsFor !== null}
        onClose={() => setActionsFor(null)}
        onRemove={(member) => {
          setActionsFor(null);
          setConfirmFor(member);
        }}
      />

      {confirmFor !== null ? (
        <ConfirmDialog
          title={`Remove ${confirmFor.displayName}?`}
          message={[
            `They lose access to ${workspaceLabel} the moment you confirm.`,
            'Signed out everywhere. Chat access ends immediately.',
            'Their posts, comments and uploads stay, shown as “(ex-member)”.',
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
